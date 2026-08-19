import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, readlink, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";

export const environmentLockFileName = "env-lock.json";
const legacySkillLockFileName = ".skill-lock.json";

const skillLockEntrySchema = z.object({
  source: z.string().min(1),
  integrity: z.string().regex(/^sha256-[a-f0-9]{64}$/),
  linkedAt: z.iso.datetime(),
  kind: z.enum(["linked", "installed"]).optional(),
  package: z.string().min(1).optional(),
});

const emptyResourceSetSchema = z.object({}).strict();

const environmentLockSchema = z.object({
  schemaVersion: z.literal(1),
  environmentId: z.string().uuid(),
  skills: z.record(z.string(), skillLockEntrySchema),
  plugins: emptyResourceSetSchema,
  mcpServers: emptyResourceSetSchema,
});

const legacySkillLockSchema = z.object({
  schemaVersion: z.literal(1),
  skills: z.record(z.string(), skillLockEntrySchema),
});

export type EnvironmentLock = z.infer<typeof environmentLockSchema>;
export type SkillLockEntry = z.infer<typeof skillLockEntrySchema>;

export function createEmptyEnvironmentLock(environmentId: string): EnvironmentLock {
  return {
    schemaVersion: 1,
    environmentId,
    skills: {},
    plugins: {},
    mcpServers: {},
  };
}

export async function readEnvironmentLock(
  environmentRoot: string,
  environmentId: string,
): Promise<EnvironmentLock> {
  try {
    const source = await readFile(join(environmentRoot, environmentLockFileName), "utf8");
    const lock = environmentLockSchema.parse(JSON.parse(source));
    if (lock.environmentId !== environmentId) {
      throw new Error(
        `Environment lock belongs to "${lock.environmentId}", expected "${environmentId}".`,
      );
    }
    return lock;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  return migrateLegacySkillLock(environmentRoot, environmentId);
}

export async function writeEnvironmentLock(
  environmentRoot: string,
  lock: EnvironmentLock,
): Promise<void> {
  const sortedLock: EnvironmentLock = {
    schemaVersion: 1,
    environmentId: lock.environmentId,
    skills: Object.fromEntries(
      Object.entries(lock.skills).sort(([left], [right]) => left.localeCompare(right)),
    ),
    plugins: lock.plugins,
    mcpServers: lock.mcpServers,
  };
  const destination = join(environmentRoot, environmentLockFileName);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sortedLock, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

export async function calculateSkillIntegrity(skillRoot: string): Promise<string> {
  const hash = createHash("sha256");
  await hashDirectory(skillRoot, skillRoot, hash);
  return `sha256-${hash.digest("hex")}`;
}

async function migrateLegacySkillLock(
  environmentRoot: string,
  environmentId: string,
): Promise<EnvironmentLock> {
  const legacyPath = join(environmentRoot, legacySkillLockFileName);
  try {
    const source = await readFile(legacyPath, "utf8");
    const legacy = legacySkillLockSchema.parse(JSON.parse(source));
    const lock: EnvironmentLock = {
      ...createEmptyEnvironmentLock(environmentId),
      skills: legacy.skills,
    };
    await writeEnvironmentLock(environmentRoot, lock);
    await unlink(legacyPath);
    return lock;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return createEmptyEnvironmentLock(environmentId);
    }
    throw error;
  }
}

async function hashDirectory(
  root: string,
  directory: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path).split(sep).join("/");
    if (entry.isDirectory()) {
      hash.update(`directory:${relativePath}\0`);
      await hashDirectory(root, path, hash);
    } else if (entry.isFile()) {
      hash.update(`file:${relativePath}\0`);
      hash.update(await readFile(path));
      hash.update("\0");
    } else if (entry.isSymbolicLink()) {
      hash.update(`symlink:${relativePath}\0${await readlink(path)}\0`);
    } else if ((await stat(path)).isFile()) {
      hash.update(`file:${relativePath}\0`);
      hash.update(await readFile(path));
      hash.update("\0");
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
