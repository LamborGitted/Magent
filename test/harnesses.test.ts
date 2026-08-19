import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getHarness,
  listHarnesses,
  type HarnessContext,
} from "../src/core/harnesses.js";

let root: string;
let context: HarnessContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "magent-harness-test-"));
  context = {
    environmentName: "vision",
    environmentRoot: join(root, "envs", "vision"),
    skillsRoot: join(root, "envs", "vision", "skills"),
  };
  await mkdir(context.skillsRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Harness Adapters", () => {
  it("supports the intended Harness set without OpenCode", () => {
    expect(listHarnesses().map(({ id }) => id)).toEqual([
      "pi",
      "dsh",
      "codex",
      "claude",
      "gemini",
    ]);
    expect(() => getHarness("opencode")).toThrow("Unsupported harness");
  });

  it("makes Pi disable automatic Skill discovery", async () => {
    const adapter = getHarness("pi");
    await adapter.prepare(context);

    expect(adapter.arguments?.(context, ["--model", "test"])).toEqual([
      "--no-skills",
      "--skill",
      context.skillsRoot,
      "--model",
      "test",
    ]);
    expect(adapter.environment(context)).toEqual({
      PI_CODING_AGENT_DIR: join(context.environmentRoot, "harnesses", "pi", "agent"),
    });
  });

  it("prepares Claude Code with an isolated config and shared Skills", async () => {
    const adapter = getHarness("claude");
    await adapter.prepare(context);
    const config = join(context.environmentRoot, "harnesses", "claude", "config");
    const skillsLink = join(config, "skills");

    expect(adapter.environment(context)).toEqual({ CLAUDE_CONFIG_DIR: config });
    expect((await lstat(skillsLink)).isSymbolicLink()).toBe(true);
    expect(resolve(join(skillsLink, ".."), await readlink(skillsLink)))
      .toBe(context.skillsRoot);
  });

  it("prepares Gemini CLI with an isolated virtual home and shared Agent Skills", async () => {
    const adapter = getHarness("gemini");
    await adapter.prepare(context);
    const home = join(context.environmentRoot, "harnesses", "gemini", "home");
    const skillsLink = join(home, ".agents", "skills");

    expect(adapter.environment(context)).toEqual({ GEMINI_CLI_HOME: home });
    expect((await lstat(join(home, ".gemini"))).isDirectory()).toBe(true);
    expect((await lstat(skillsLink)).isSymbolicLink()).toBe(true);
    expect(resolve(join(skillsLink, ".."), await readlink(skillsLink)))
      .toBe(context.skillsRoot);
  });

  it("detects an executable and reads its version", async () => {
    const bin = join(root, "bin");
    await mkdir(bin);
    const executable = join(bin, "claude");
    await writeFile(executable, "#!/bin/sh\necho 'claude 2.1.0'\n", { mode: 0o755 });

    await expect(getHarness("claude").detect({ PATH: bin })).resolves.toEqual({
      id: "claude",
      displayName: "Claude Code",
      executable: "claude",
      state: "available",
      path: executable,
      version: "claude 2.1.0",
    });
  });

  it("reports an unavailable executable", async () => {
    await expect(getHarness("gemini").detect({ PATH: join(root, "empty") }))
      .resolves.toEqual({
        id: "gemini",
        displayName: "Gemini CLI",
        executable: "gemini",
        state: "unavailable",
      });
  });
});
