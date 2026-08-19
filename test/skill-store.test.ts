import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvironmentStore } from "../src/core/environment-store.js";
import { getHarness } from "../src/core/harnesses.js";
import { getMagentPaths } from "../src/core/paths.js";
import { SkillStore } from "../src/core/skill-store.js";

let root: string;
let environments: EnvironmentStore;
let skills: SkillStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "magent-skills-test-"));
  const paths = getMagentPaths({
    HOME: root,
    MAGENT_HOME: join(root, "magent"),
    MAGENT_SHARED_SKILLS: join(root, ".agents", "skills"),
  });
  environments = new EnvironmentStore(paths);
  skills = new SkillStore(environments, paths);
  await environments.create("vision");
  await mkdir(join(paths.sharedSkills, "find-skills"), { recursive: true });
  await writeFile(
    join(paths.sharedSkills, "find-skills", "SKILL.md"),
    "---\nname: find-skills\ndescription: Find reusable skills.\n---\n",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("SkillStore", () => {
  it("discovers shared Agent Skills", async () => {
    expect(await skills.listShared()).toEqual([
      expect.objectContaining({ id: "find-skills", description: "Find reusable skills." }),
    ]);
  });

  it("links a shared Skill into an environment", async () => {
    const [link] = await skills.add("vision", ["find-skills"]);

    expect(link?.id).toBe("find-skills");
    expect((await lstat(link!.path)).isSymbolicLink()).toBe(true);
    expect(resolve(join(link!.path, ".."), await readlink(link!.path))).toBe(link!.target);
    expect(await skills.listEnvironment("vision")).toEqual([
      expect.objectContaining({
        id: "find-skills",
        target: link!.target,
        status: "linked",
        integrity: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
      }),
    ]);
    const lock = JSON.parse(await readFile(
      join(environments.environmentPath("vision"), "env-lock.json"),
      "utf8",
    ));
    expect(lock.skills["find-skills"]).toEqual(expect.objectContaining({
      source: link!.target,
      integrity: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
    }));
    await expect(skills.add("vision", ["find-skills"])).resolves.toHaveLength(1);
  });

  it("unlinks a Skill without deleting its shared source", async () => {
    const [link] = await skills.add("vision", ["find-skills"]);
    const [removed] = await skills.remove("vision", ["find-skills"]);

    expect(removed).toEqual({ id: "find-skills", path: link!.path, linkRemoved: true });
    await expect(lstat(link!.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(link!.target, "SKILL.md"), "utf8")).toContain("find-skills");
    expect(JSON.parse(await readFile(
      join(environments.environmentPath("vision"), "env-lock.json"),
      "utf8",
    ))).toEqual({
      schemaVersion: 1,
      environmentId: expect.any(String),
      skills: {},
      plugins: {},
      mcpServers: {},
    });
  });

  it("makes Pi and Codex consume the same environment Skills layer", async () => {
    const environmentRoot = environments.environmentPath("vision");
    const context = {
      environmentName: "vision",
      environmentRoot,
      skillsRoot: environments.skillsPath("vision"),
    };
    await Promise.all([
      getHarness("pi").prepare(context),
      getHarness("codex").prepare(context),
    ]);
    const piLink = join(environmentRoot, "harnesses", "pi", "agent", "skills");
    const codexLink = join(environmentRoot, "harnesses", "codex", "home", "skills");

    expect((await lstat(piLink)).isSymbolicLink()).toBe(true);
    expect((await lstat(codexLink)).isSymbolicLink()).toBe(true);
    expect(resolve(join(piLink, ".."), await readlink(piLink)))
      .toBe(environments.skillsPath("vision"));
    expect(resolve(join(codexLink, ".."), await readlink(codexLink)))
      .toBe(environments.skillsPath("vision"));
  });
});
