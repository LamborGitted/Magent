import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  confirmEnvironmentRemoval,
  type PromptInput,
  type PromptOutput,
} from "../src/core/confirmation.js";

describe("environment removal confirmation", () => {
  it("accepts y in an interactive terminal", async () => {
    const input = new PassThrough() as PassThrough & PromptInput;
    const output = new PassThrough() as PassThrough & PromptOutput;
    input.isTTY = true;
    output.isTTY = true;

    const confirmation = confirmEnvironmentRemoval("mini", input, output);
    setImmediate(() => input.write("y\n"));

    await expect(confirmation).resolves.toBe(true);
    expect(output.read().toString()).toContain('Remove environment "mini"?');
  });

  it("defaults to cancellation", async () => {
    const input = new PassThrough() as PassThrough & PromptInput;
    const output = new PassThrough() as PassThrough & PromptOutput;
    input.isTTY = true;
    output.isTTY = true;

    const confirmation = confirmEnvironmentRemoval("mini", input, output);
    setImmediate(() => input.write("\n"));

    await expect(confirmation).resolves.toBe(false);
  });

  it("requires --yes outside an interactive terminal", async () => {
    const input = new PassThrough() as PassThrough & PromptInput;
    const output = new PassThrough() as PassThrough & PromptOutput;

    await expect(confirmEnvironmentRemoval("mini", input, output))
      .rejects.toThrow("non-interactively without --yes");
  });
});
