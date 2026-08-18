import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvironmentStore } from "../src/core/environment-store.js";
import { getMagentPaths } from "../src/core/paths.js";

let home: string;
let store: EnvironmentStore;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "magent-test-"));
  store = new EnvironmentStore(getMagentPaths({ MAGENT_HOME: home }));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("EnvironmentStore", () => {
  it("creates an isolated environment layout", async () => {
    const manifest = await store.create("vision");

    expect(manifest.name).toBe("vision");
    expect(await store.exists("vision")).toBe(true);
    expect(await readFile(join(home, "envs", "vision", "env.toml"), "utf8"))
      .toContain('name = "vision"');
    expect(await store.read("vision")).toEqual(manifest);
  });

  it("lists environments in name order", async () => {
    await store.create("work");
    await store.create("personal");

    expect((await store.list()).map(({ name }) => name)).toEqual(["personal", "work"]);
  });

  it("rejects invalid and duplicate names", async () => {
    await expect(store.create("../escape")).rejects.toThrow("Invalid environment name");
    await store.create("valid");
    await expect(store.create("valid")).rejects.toThrow("already exists");
  });

  it("removes an existing environment", async () => {
    await store.create("temporary");
    await store.remove("temporary");

    expect(await store.exists("temporary")).toBe(false);
  });
});
