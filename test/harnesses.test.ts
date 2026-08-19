import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getHarness } from "../src/core/harnesses.js";

describe("Pi Harness Adapter", () => {
  it("disables automatic Skill discovery and loads the environment Skills layer", () => {
    const root = "/tmp/magent/envs/vision";
    const adapter = getHarness("pi");

    expect(adapter.arguments?.(root, ["--model", "test"])).toEqual([
      "--no-skills",
      "--skill",
      join(root, "skills"),
      "--model",
      "test",
    ]);
  });
});
