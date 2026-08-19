import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { EnvironmentStore } from "./environment-store.js";
import { getMagentPaths, type MagentPaths } from "./paths.js";
import {
  calculateSkillIntegrity,
  readSkillLock,
  writeSkillLock,
} from "./skill-lock.js";

export interface SharedSkill {
  id: string;
  path: string;
  description?: string;
}

export interface EnvironmentSkill {
  id: string;
  path: string;
  target: string;
  status: "linked" | "unlocked" | "missing";
  integrity?: string;
}

export interface RemovedSkill {
  id: string;
  path: string;
  linkRemoved: boolean;
}

interface DiscoveredEnvironmentLink {
  id: string;
  path: string;
  target: string;
}

export class SkillStore {
  public constructor(
    private readonly environments: EnvironmentStore,
    private readonly paths: MagentPaths = getMagentPaths(),
  ) {}

  public sharedSkillsPath(): string {
    return this.paths.sharedSkills;
  }

  public async listShared(): Promise<SharedSkill[]> {
    const skills: SharedSkill[] = [];
    await discoverSharedSkills(this.paths.sharedSkills, this.paths.sharedSkills, skills, new Set());
    return skills.sort((left, right) => left.id.localeCompare(right.id));
  }

  public async listEnvironment(environmentName: string): Promise<EnvironmentSkill[]> {
    const environmentRoot = this.environments.environmentPath(environmentName);
    const skillsRoot = await this.environments.ensureSkillsDirectory(environmentName);
    const links: DiscoveredEnvironmentLink[] = [];
    await discoverEnvironmentLinks(skillsRoot, skillsRoot, links);
    const lock = await readSkillLock(environmentRoot);
    const skills = new Map<string, EnvironmentSkill>();

    for (const link of links) {
      const locked = lock.skills[link.id];
      skills.set(link.id, {
        ...link,
        status: locked ? "linked" : "unlocked",
        ...(locked ? { integrity: locked.integrity } : {}),
      });
    }

    for (const [id, entry] of Object.entries(lock.skills)) {
      if (!skills.has(id)) {
        skills.set(id, {
          id,
          path: resolveInside(skillsRoot, id),
          target: entry.source,
          status: "missing",
          integrity: entry.integrity,
        });
      }
    }

    return [...skills.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  public async add(environmentName: string, skillIds: string[]): Promise<EnvironmentSkill[]> {
    const environmentRoot = this.environments.environmentPath(environmentName);
    const environmentSkills = await this.environments.ensureSkillsDirectory(environmentName);
    const available = new Map((await this.listShared()).map((skill) => [skill.id, skill]));
    const lock = await readSkillLock(environmentRoot);
    const added: EnvironmentSkill[] = [];

    for (const skillId of skillIds) {
      validateSkillId(skillId);
      const skill = available.get(skillId);
      if (!skill) {
        throw new Error(
          `Shared Skill "${skillId}" was not found under "${this.paths.sharedSkills}".`,
        );
      }

      const destination = resolveInside(environmentSkills, skillId);
      await mkdir(dirname(destination), { recursive: true });

      try {
        const stats = await lstat(destination);
        if (!stats.isSymbolicLink()) {
          throw new Error(`Cannot link Skill "${skillId}": destination already exists.`);
        }
        if (await realpath(destination) !== await realpath(skill.path)) {
          throw new Error(`Cannot link Skill "${skillId}": destination points elsewhere.`);
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          await symlink(skill.path, destination, "dir");
        } else {
          throw error;
        }
      }

      const integrity = await calculateSkillIntegrity(skill.path);
      const linkedAt = lock.skills[skillId]?.linkedAt ?? new Date().toISOString();
      lock.skills[skillId] = {
        source: await realpath(skill.path),
        integrity,
        linkedAt,
      };
      added.push({
        id: skillId,
        path: destination,
        target: skill.path,
        status: "linked",
        integrity,
      });
    }

    await writeSkillLock(environmentRoot, lock);
    return added;
  }

  public async remove(environmentName: string, skillIds: string[]): Promise<RemovedSkill[]> {
    const environmentRoot = this.environments.environmentPath(environmentName);
    const environmentSkills = await this.environments.ensureSkillsDirectory(environmentName);
    const lock = await readSkillLock(environmentRoot);
    const removed: RemovedSkill[] = [];

    for (const skillId of skillIds) {
      validateSkillId(skillId);
      const destination = resolveInside(environmentSkills, skillId);
      let linkRemoved = false;

      try {
        const stats = await lstat(destination);
        if (!stats.isSymbolicLink()) {
          throw new Error(`Cannot remove Skill "${skillId}": destination is not a symbolic link.`);
        }
        await unlink(destination);
        linkRemoved = true;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        if (!lock.skills[skillId]) {
          throw new Error(`Skill "${skillId}" is not linked to environment "${environmentName}".`);
        }
      }

      delete lock.skills[skillId];
      removed.push({ id: skillId, path: destination, linkRemoved });
    }

    await writeSkillLock(environmentRoot, lock);
    return removed;
  }
}

async function discoverSharedSkills(
  root: string,
  directory: string,
  output: SharedSkill[],
  visited: Set<string>,
): Promise<void> {
  let entries;
  try {
    const canonicalPath = await realpath(directory);
    if (visited.has(canonicalPath)) return;
    visited.add(canonicalPath);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    const id = toSkillId(relative(root, directory));
    if (id) {
      const source = await readFile(join(directory, "SKILL.md"), "utf8");
      const description = readDescription(source);
      output.push({ id, path: directory, ...(description ? { description } : {}) });
    }
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await discoverSharedSkills(root, path, output, visited);
    } else if (entry.isSymbolicLink()) {
      try {
        if ((await stat(path)).isDirectory()) {
          await discoverSharedSkills(root, path, output, visited);
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
  }));
}

async function discoverEnvironmentLinks(
  root: string,
  directory: string,
  output: DiscoveredEnvironmentLink[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const rawTarget = await readlink(path);
      output.push({
        id: toSkillId(relative(root, path)),
        path,
        target: resolve(dirname(path), rawTarget),
      });
    } else if (entry.isDirectory()) {
      await discoverEnvironmentLinks(root, path, output);
    }
  }));
}

function readDescription(source: string): string | undefined {
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/);
  const description = frontmatter?.[1]?.match(/^description:\s*["']?(.*?)["']?\s*$/m)?.[1];
  return description || undefined;
}

function validateSkillId(id: string): void {
  if (!id || id.startsWith("/") || id.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid Skill ID "${id}".`);
  }
}

function resolveInside(root: string, id: string): string {
  const destination = resolve(root, id);
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
    throw new Error(`Skill ID "${id}" escapes the environment Skills directory.`);
  }
  return destination;
}

function toSkillId(path: string): string {
  return path.split(sep).join("/");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
