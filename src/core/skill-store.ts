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
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { EnvironmentStore } from "./environment-store.js";
import { getMagentPaths, type MagentPaths } from "./paths.js";
import {
  calculateSkillIntegrity,
  readEnvironmentLock,
  writeEnvironmentLock,
} from "./environment-lock.js";
import { SkillsShRegistry, type SkillsRegistry } from "./skills-registry.js";

export interface SharedSkill {
  id: string;
  path: string;
  description?: string;
}

export interface EnvironmentSkill {
  id: string;
  path: string;
  target: string;
  status: "linked" | "installed" | "unlocked" | "missing";
  integrity?: string;
  package?: string;
}

export interface AddSkillOptions {
  source?: "auto" | "shared" | "registry";
  global?: boolean;
}

export interface RemovedSkill {
  id: string;
  path: string;
  linkRemoved: boolean;
}

interface DiscoveredEnvironmentSkill {
  id: string;
  path: string;
  target: string;
}

export class SkillStore {
  public constructor(
    private readonly environments: EnvironmentStore,
    private readonly paths: MagentPaths = getMagentPaths(),
    private readonly registry: SkillsRegistry = new SkillsShRegistry(),
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
    const manifest = await this.environments.read(environmentName);
    const environmentRoot = this.environments.environmentPath(environmentName);
    const skillsRoot = await this.environments.ensureSkillsDirectory(environmentName);
    const discovered: DiscoveredEnvironmentSkill[] = [];
    await discoverEnvironmentSkills(skillsRoot, skillsRoot, discovered);
    const lock = await readEnvironmentLock(environmentRoot, manifest.id);
    const skills = new Map<string, EnvironmentSkill>();

    for (const skill of discovered) {
      const locked = lock.skills[skill.id];
      skills.set(skill.id, {
        id: skill.id,
        path: skill.path,
        target: skill.target,
        status: locked ? (locked.kind === "installed" ? "installed" : "linked") : "unlocked",
        ...(locked ? { integrity: locked.integrity } : {}),
        ...(locked?.package ? { package: locked.package } : {}),
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
          ...(entry.package ? { package: entry.package } : {}),
        });
      }
    }

    return [...skills.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  public async add(
    environmentName: string,
    skillIds: string[],
    options: AddSkillOptions = {},
  ): Promise<EnvironmentSkill[]> {
    const manifest = await this.environments.read(environmentName);
    const environmentRoot = this.environments.environmentPath(environmentName);
    const environmentSkills = await this.environments.ensureSkillsDirectory(environmentName);
    const lock = await readEnvironmentLock(environmentRoot, manifest.id);
    const added: EnvironmentSkill[] = [];

    for (const skillId of skillIds) {
      const source = options.source ?? "auto";
      const fromRegistry = source === "registry" || (source === "auto" && isRegistryPackage(skillId));
      if (!fromRegistry) {
        added.push(await this.linkSharedSkill(skillId, environmentSkills, lock));
        continue;
      }

      const installRoot = options.global ? this.paths.sharedSkills : environmentSkills;
      await mkdir(installRoot, { recursive: true });
      const installedIds = await this.registry.install(skillId, installRoot);
      for (const installedId of installedIds) {
        validateSkillId(installedId);
        const installedPath = resolveInside(installRoot, installedId);
        if (options.global) {
          added.push(await this.linkSharedSkill(installedId, environmentSkills, lock, skillId));
        } else {
          const integrity = await calculateSkillIntegrity(installedPath);
          const linkedAt = lock.skills[installedId]?.linkedAt ?? new Date().toISOString();
          lock.skills[installedId] = {
            source: skillId,
            package: skillId,
            kind: "installed",
            integrity,
            linkedAt,
          };
          added.push({
            id: installedId,
            path: installedPath,
            target: skillId,
            status: "installed",
            integrity,
            package: skillId,
          });
        }
      }
    }

    await writeEnvironmentLock(environmentRoot, lock);
    return added;
  }

  private async linkSharedSkill(
    skillId: string,
    environmentSkills: string,
    lock: Awaited<ReturnType<typeof readEnvironmentLock>>,
    packageSpec?: string,
  ): Promise<EnvironmentSkill> {
    validateSkillId(skillId);
    const available = new Map((await this.listShared()).map((skill) => [skill.id, skill]));
    const skill = available.get(skillId);
    if (!skill) {
      throw new Error(`Shared Skill "${skillId}" was not found under "${this.paths.sharedSkills}".`);
    }
    const destination = resolveInside(environmentSkills, skillId);
    await mkdir(dirname(destination), { recursive: true });
    try {
      const stats = await lstat(destination);
      if (!stats.isSymbolicLink()) throw new Error(`Cannot link Skill "${skillId}": destination already exists.`);
      if (await realpath(destination) !== await realpath(skill.path)) {
        throw new Error(`Cannot link Skill "${skillId}": destination points elsewhere.`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") await symlink(skill.path, destination, "dir");
      else throw error;
    }
    const integrity = await calculateSkillIntegrity(skill.path);
    const linkedAt = lock.skills[skillId]?.linkedAt ?? new Date().toISOString();
    lock.skills[skillId] = {
      source: await realpath(skill.path),
      kind: "linked",
      ...(packageSpec ? { package: packageSpec } : {}),
      integrity,
      linkedAt,
    };
    return {
      id: skillId,
      path: destination,
      target: skill.path,
      status: "linked",
      integrity,
      ...(packageSpec ? { package: packageSpec } : {}),
    };
  }

  public async remove(environmentName: string, skillIds: string[]): Promise<RemovedSkill[]> {
    const manifest = await this.environments.read(environmentName);
    const environmentRoot = this.environments.environmentPath(environmentName);
    const environmentSkills = await this.environments.ensureSkillsDirectory(environmentName);
    const lock = await readEnvironmentLock(environmentRoot, manifest.id);
    const removed: RemovedSkill[] = [];

    for (const skillId of skillIds) {
      validateSkillId(skillId);
      const destination = resolveInside(environmentSkills, skillId);
      let linkRemoved = false;

      try {
        const stats = await lstat(destination);
        if (stats.isSymbolicLink()) {
          await unlink(destination);
          linkRemoved = true;
        } else if (stats.isDirectory() && lock.skills[skillId]?.kind === "installed") {
          await rm(destination, { recursive: true });
        } else {
          throw new Error(`Cannot remove Skill "${skillId}": destination is not managed by Magent.`);
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        if (!lock.skills[skillId]) {
          throw new Error(`Skill "${skillId}" is not linked to environment "${environmentName}".`);
        }
      }

      delete lock.skills[skillId];
      removed.push({ id: skillId, path: destination, linkRemoved });
    }

    await writeEnvironmentLock(environmentRoot, lock);
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

async function discoverEnvironmentSkills(
  root: string,
  directory: string,
  output: DiscoveredEnvironmentSkill[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  if (directory !== root && entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    output.push({
      id: toSkillId(relative(root, directory)),
      path: directory,
      target: directory,
    });
    return;
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
      await discoverEnvironmentSkills(root, path, output);
    }
  }));
}

function readDescription(source: string): string | undefined {
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/);
  const description = frontmatter?.[1]?.match(/^description:\s*["']?(.*?)["']?\s*$/m)?.[1];
  return description || undefined;
}

function isRegistryPackage(value: string): boolean {
  return /^[^/@\\\s]+\/[^/@\\\s]+@[^/@\\\s]+$/.test(value);
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
