import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, realpath, symlink } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { EnvironmentStore } from "./environment-store.js";

export interface HarnessContext {
  environmentName: string;
  environmentRoot: string;
  skillsRoot: string;
}

export interface HarnessInfo {
  id: string;
  displayName: string;
  executable: string;
  state: "available" | "unavailable" | "broken";
  path?: string;
  version?: string;
  error?: string;
}

export interface HarnessAdapter {
  id: string;
  displayName: string;
  executable: string;
  skillsSupport: "arguments" | "directory" | "unsupported";
  prepare(context: HarnessContext): Promise<void>;
  environment(context: HarnessContext): NodeJS.ProcessEnv;
  arguments?(context: HarnessContext, userArguments: string[]): string[];
  detect(env?: NodeJS.ProcessEnv): Promise<HarnessInfo>;
}

function adapter(
  definition: Omit<HarnessAdapter, "detect">,
): HarnessAdapter {
  return {
    ...definition,
    detect: async (env = process.env) => detectHarness(definition, env),
  };
}

const adapters: Record<string, HarnessAdapter> = {
  pi: adapter({
    id: "pi",
    displayName: "Pi",
    executable: "pi",
    skillsSupport: "arguments",
    prepare: async (context) => {
      const agentRoot = join(context.environmentRoot, "harnesses", "pi", "agent");
      await mkdir(agentRoot, { recursive: true });
      await ensureSkillsLink(join(agentRoot, "skills"), context.skillsRoot);
    },
    environment: (context) => ({
      PI_CODING_AGENT_DIR: join(context.environmentRoot, "harnesses", "pi", "agent"),
    }),
    arguments: (context, userArguments) => [
      "--no-skills",
      "--skill",
      context.skillsRoot,
      ...userArguments,
    ],
  }),
  dsh: adapter({
    id: "dsh",
    displayName: "DSH",
    executable: "dsh",
    skillsSupport: "unsupported",
    prepare: async (context) => {
      await mkdir(join(context.environmentRoot, "harnesses", "dsh", "home"), {
        recursive: true,
      });
    },
    environment: (context) => ({
      DSH_HOME: join(context.environmentRoot, "harnesses", "dsh", "home"),
    }),
  }),
  codex: adapter({
    id: "codex",
    displayName: "Codex",
    executable: "codex",
    skillsSupport: "directory",
    prepare: async (context) => {
      const home = join(context.environmentRoot, "harnesses", "codex", "home");
      await mkdir(home, { recursive: true });
      await ensureSkillsLink(join(home, "skills"), context.skillsRoot);
    },
    environment: (context) => ({
      CODEX_HOME: join(context.environmentRoot, "harnesses", "codex", "home"),
    }),
  }),
  claude: adapter({
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    skillsSupport: "directory",
    prepare: async (context) => {
      const config = join(context.environmentRoot, "harnesses", "claude", "config");
      await mkdir(config, { recursive: true });
      await ensureSkillsLink(join(config, "skills"), context.skillsRoot);
    },
    environment: (context) => ({
      CLAUDE_CONFIG_DIR: join(context.environmentRoot, "harnesses", "claude", "config"),
    }),
  }),
  gemini: adapter({
    id: "gemini",
    displayName: "Gemini CLI",
    executable: "gemini",
    skillsSupport: "directory",
    prepare: async (context) => {
      const home = join(context.environmentRoot, "harnesses", "gemini", "home");
      await Promise.all([
        mkdir(join(home, ".gemini"), { recursive: true }),
        mkdir(join(home, ".agents"), { recursive: true }),
      ]);
      await ensureSkillsLink(join(home, ".agents", "skills"), context.skillsRoot);
    },
    environment: (context) => ({
      GEMINI_CLI_HOME: join(context.environmentRoot, "harnesses", "gemini", "home"),
    }),
  }),
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

export async function inspectHarnesses(
  harnessId?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HarnessInfo[]> {
  const selected = harnessId ? [getHarness(harnessId)] : listHarnesses();
  return Promise.all(selected.map((item) => item.detect(env)));
}

export async function runHarness(
  store: EnvironmentStore,
  environmentName: string,
  harnessId: string,
  args: string[],
): Promise<number> {
  await store.read(environmentName);
  const adapter = getHarness(harnessId);
  const context: HarnessContext = {
    environmentName,
    environmentRoot: store.environmentPath(environmentName),
    skillsRoot: await store.ensureSkillsDirectory(environmentName),
  };
  await adapter.prepare(context);
  const harnessArguments = adapter.arguments?.(context, args) ?? args;

  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(adapter.executable, harnessArguments, {
      cwd: process.cwd(),
      env: { ...process.env, ...adapter.environment(context) },
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
        resolvePromise(128 + signalNumber(signal));
      } else {
        resolvePromise(code ?? 1);
      }
    });
  });
}

async function ensureSkillsLink(linkPath: string, skillsRoot: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });
  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      throw new Error(`Cannot create shared Skills link because "${linkPath}" already exists.`);
    }
    if (await realpath(linkPath) !== await realpath(skillsRoot)) {
      throw new Error(`Skills link "${linkPath}" points to a different directory.`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const target = relative(dirname(linkPath), skillsRoot) || ".";
      await symlink(target, linkPath, "dir");
      return;
    }
    throw error;
  }
}

async function detectHarness(
  definition: Pick<HarnessAdapter, "id" | "displayName" | "executable">,
  env: NodeJS.ProcessEnv,
): Promise<HarnessInfo> {
  const executablePath = await findExecutable(definition.executable, env);
  if (!executablePath) {
    return {
      id: definition.id,
      displayName: definition.displayName,
      executable: definition.executable,
      state: "unavailable",
    };
  }

  try {
    const version = await readVersion(executablePath, env);
    return {
      id: definition.id,
      displayName: definition.displayName,
      executable: definition.executable,
      state: "available",
      path: executablePath,
      ...(version ? { version } : {}),
    };
  } catch (error) {
    return {
      id: definition.id,
      displayName: definition.displayName,
      executable: definition.executable,
      state: "broken",
      path: executablePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function findExecutable(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const candidates = isAbsolute(executable) || executable.includes("/")
    ? [resolve(executable)]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, executable));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

async function readVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise<string | undefined>((resolvePromise, reject) => {
    const child = spawn(executable, ["--version"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer): void => {
      if (output.length < 8192) output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Version check timed out."));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Version command exited with code ${code ?? "unknown"}.`));
      } else {
        resolvePromise(output.trim().split(/\r?\n/, 1)[0] || undefined);
      }
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
