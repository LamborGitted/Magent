import { spawn } from "node:child_process";
import { join } from "node:path";
import type { EnvironmentStore } from "./environment-store.js";

export interface HarnessAdapter {
  id: string;
  executable: string;
  environment(root: string): NodeJS.ProcessEnv;
}

const adapters: Record<string, HarnessAdapter> = {
  pi: {
    id: "pi",
    executable: "pi",
    environment: (root) => ({
      PI_CODING_AGENT_DIR: join(root, "harnesses", "pi", "agent"),
    }),
  },
  dsh: {
    id: "dsh",
    executable: "dsh",
    environment: (root) => ({
      DSH_HOME: join(root, "harnesses", "dsh", "home"),
    }),
  },
  codex: {
    id: "codex",
    executable: "codex",
    environment: (root) => ({
      CODEX_HOME: join(root, "harnesses", "codex", "home"),
    }),
  },
};

export function listHarnesses(): HarnessAdapter[] {
  return Object.values(adapters);
}

export function getHarness(id: string): HarnessAdapter {
  const adapter = adapters[id];
  if (!adapter) {
    throw new Error(
      `Unsupported harness "${id}". Available harnesses: ${Object.keys(adapters).join(", ")}.`,
    );
  }
  return adapter;
}

export async function runHarness(
  store: EnvironmentStore,
  environmentName: string,
  harnessId: string,
  args: string[],
): Promise<number> {
  await store.read(environmentName);
  const adapter = getHarness(harnessId);
  const root = store.environmentPath(environmentName);

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(adapter.executable, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...adapter.environment(root) },
      stdio: "inherit",
    });

    child.once("error", (error) => {
      const message = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `Harness executable "${adapter.executable}" was not found in PATH.`
        : `Could not start ${adapter.id}: ${error.message}`;
      reject(new Error(message));
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(128 + signalNumber(signal));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1;
}
