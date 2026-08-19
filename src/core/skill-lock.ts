import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, readlink, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";

export const skillLockFileName = ".skill-lock.json";

const skillLockEntrySchema = z.object({
  source: z.string().min(1),
  integrity: z.string().regex(/^sha256-[a-f0-9]{64}$/),
  linkedAt: z.iso.datetime(),
});

const skillLockSchema = z.object({
  schemaVersion: z.literal(1),
  skills: z.record(z.string(), skillLockEntrySchema),
});

export type SkillLock = z.infer<typeof skillLockSchema>;
export type SkillLockEntry = z.infer<typeof skillLockEntrySchema>;

export function createEmptySkillLock(): SkillLock {
  return { schemaVersion: 1, skills: {} };
}

export async function readSkillLock(environmentRoot: string): Promise<SkillLock> {
  try {
    const source = await readFile(join(environmentRoot, skillLockFileName), "utf8");
    return skillLockSchema.parse(JSON.parse(source));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return createEmptySkillLock();
    throw error;
  }
}

export async function writeSkillLock(environmentRoot: string, lock: SkillLock): Promise<void> {
  const sortedLock: SkillLock = {
    schemaVersion: 1,
    skills: Object.fromEntries(
      Object.entries(lock.skills).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  const destination = join(environmentRoot, skillLockFileName);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sortedLock, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

export async function calculateSkillIntegrity(skillRoot: string): Promise<string> {
  const hash = createHash("sha256");
  await hashDirectory(skillRoot, skillRoot, hash);
  return `sha256-${hash.digest("hex")}`;
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
