import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEnvironmentLock } from "../src/core/environment-lock.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("EnvironmentLock", () => {
  it("migrates the legacy Skill lock into env-lock.json", async () => {
    root = await mkdtemp(join(tmpdir(), "magent-lock-test-"));
    const environmentId = "802c6759-9d8a-4c35-8641-dd7e7c683bf0";
    await writeFile(join(root, ".skill-lock.json"), JSON.stringify({
      schemaVersion: 1,
      skills: {
        demo: {
          source: "/tmp/demo",
          integrity: `sha256-${"a".repeat(64)}`,
          linkedAt: "2026-08-19T02:45:00.123Z",
        },
      },
    }));

    const lock = await readEnvironmentLock(root, environmentId);

    expect(lock).toEqual({
      schemaVersion: 1,
      environmentId,
      skills: expect.objectContaining({ demo: expect.any(Object) }),
      plugins: {},
      mcpServers: {},
    });
    expect(JSON.parse(await readFile(join(root, "env-lock.json"), "utf8")))
      .toEqual(lock);
    await expect(readFile(join(root, ".skill-lock.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
