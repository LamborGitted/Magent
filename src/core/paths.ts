import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface MagentPaths {
  home: string;
  environments: string;
}

export function getMagentPaths(env: NodeJS.ProcessEnv = process.env): MagentPaths {
  const home = env.MAGENT_HOME
    ? resolve(env.MAGENT_HOME)
    : join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "magent");

  return {
    home,
    environments: join(home, "envs"),
  };
}
