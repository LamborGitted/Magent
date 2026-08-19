import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  createManifest,
  environmentManifestSchema,
  type EnvironmentManifest,
  validateEnvironmentName,
} from "./manifest.js";
import { getMagentPaths, type MagentPaths } from "./paths.js";
import {
  createEmptyEnvironmentLock,
  writeEnvironmentLock,
} from "./environment-lock.js";

const manifestFileName = "env.toml";

export class EnvironmentStore {
  public constructor(private readonly paths: MagentPaths = getMagentPaths()) {}

  public environmentPath(name: string): string {
    validateEnvironmentName(name);
    return join(this.paths.environments, name);
  }

  public skillsPath(name: string): string {
    return join(this.environmentPath(name), "skills");
  }

  public async ensureSkillsDirectory(name: string): Promise<string> {
    await this.read(name);
    const skillsPath = this.skillsPath(name);
    await mkdir(skillsPath, { recursive: true });
    return skillsPath;
  }

  public async create(name: string): Promise<EnvironmentManifest> {
    const root = this.environmentPath(name);
    await mkdir(this.paths.environments, { recursive: true });

    try {
      await mkdir(root);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`Environment "${name}" already exists.`);
      }
      throw error;
    }

    try {
      const manifest = createManifest(name);
      await Promise.all([
        mkdir(join(root, "harnesses"), { recursive: true }),
        mkdir(join(root, "skills"), { recursive: true }),
        mkdir(join(root, "packages"), { recursive: true }),
        mkdir(join(root, "state"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, manifestFileName), stringify(manifest), "utf8"),
        writeEnvironmentLock(root, createEmptyEnvironmentLock(manifest.id)),
      ]);
      return manifest;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  public async list(): Promise<EnvironmentManifest[]> {
    try {
      const entries = await readdir(this.paths.environments, { withFileTypes: true });
      const manifests = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => this.read(entry.name).catch(() => undefined)),
      );
      return manifests
        .filter((manifest): manifest is EnvironmentManifest => manifest !== undefined)
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  public async read(name: string): Promise<EnvironmentManifest> {
    const path = join(this.environmentPath(name), manifestFileName);
    try {
      const source = await readFile(path, "utf8");
      return environmentManifestSchema.parse(parse(source));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(`Environment "${name}" does not exist.`);
      }
      throw error;
    }
  }

  public async exists(name: string): Promise<boolean> {
    try {
      await access(join(this.environmentPath(name), manifestFileName), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  public async remove(name: string): Promise<void> {
    await this.read(name);
    await rm(this.environmentPath(name), { recursive: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
