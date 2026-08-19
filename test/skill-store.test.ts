import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvironmentStore } from "../src/core/environment-store.js";
import { getHarness } from "../src/core/harnesses.js";
import { getMagentPaths } from "../src/core/paths.js";
import { SkillStore } from "../src/core/skill-store.js";
import type { SkillsRegistry } from "../src/core/skills-registry.js";

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

  it("installs a skills.sh package directly into an environment", async () => {
    const registry: SkillsRegistry = {
      search: async () => [],
      install: async (packageSpec, destinationRoot) => {
        expect(packageSpec).toBe("owner/repo@remote-skill");
        await mkdir(join(destinationRoot, "remote-skill"), { recursive: true });
        await writeFile(join(destinationRoot, "remote-skill", "SKILL.md"), "# Remote\n");
        return ["remote-skill"];
      },
    };
    const remoteSkills = new SkillStore(environments, getMagentPaths({
      HOME: root,
      MAGENT_HOME: join(root, "magent"),
      MAGENT_SHARED_SKILLS: join(root, ".agents", "skills"),
    }), registry);

    const [installed] = await remoteSkills.add("vision", ["owner/repo@remote-skill"]);
    expect(installed).toEqual(expect.objectContaining({
      id: "remote-skill",
      status: "installed",
      package: "owner/repo@remote-skill",
    }));
    expect((await lstat(installed!.path)).isDirectory()).toBe(true);
    expect(await remoteSkills.listEnvironment("vision")).toEqual([
      expect.objectContaining({ id: "remote-skill", status: "installed" }),
    ]);

    const [removed] = await remoteSkills.remove("vision", ["remote-skill"]);
    expect(removed?.linkRemoved).toBe(false);
    await expect(lstat(installed!.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs a registry Skill globally and links it into the environment", async () => {
    const paths = getMagentPaths({
      HOME: root,
      MAGENT_HOME: join(root, "magent"),
      MAGENT_SHARED_SKILLS: join(root, ".agents", "skills"),
    });
    const registry: SkillsRegistry = {
      search: async () => [],
      install: async (_packageSpec, destinationRoot) => {
        await mkdir(join(destinationRoot, "global-skill"), { recursive: true });
        await writeFile(join(destinationRoot, "global-skill", "SKILL.md"), "# Global\n");
        return ["global-skill"];
      },
    };
    const remoteSkills = new SkillStore(environments, paths, registry);

    const [linked] = await remoteSkills.add(
      "vision",
      ["owner/repo@global-skill"],
      { global: true },
    );
    expect(linked).toEqual(expect.objectContaining({
      id: "global-skill",
      status: "linked",
      package: "owner/repo@global-skill",
    }));
    expect((await lstat(linked!.path)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(paths.sharedSkills, "global-skill", "SKILL.md"), "utf8"))
      .toContain("Global");
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
