import { createInterface } from "node:readline/promises";

export interface PromptInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
}

export interface PromptOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
}

export async function confirmEnvironmentRemoval(
  environmentName: string,
  input: PromptInput = process.stdin,
  output: PromptOutput = process.stdout,
): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Refusing to remove an environment non-interactively without --yes.");
  }

  output.write(`Remove environment "${environmentName}"?\n`);
  output.write("This permanently deletes its configuration, credentials, and sessions.\n");

  const prompt = createInterface({ input, output, terminal: false });
  try {
    const answer = await prompt.question("Continue? (y/N) ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}
