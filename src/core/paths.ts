import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface MagentPaths {
  home: string;
  environments: string;
  sharedSkills: string;
}

export function getMagentPaths(env: NodeJS.ProcessEnv = process.env): MagentPaths {
  const homeDirectory = env.HOME ?? homedir();
  const home = env.MAGENT_HOME
    ? resolve(env.MAGENT_HOME)
    : join(env.XDG_DATA_HOME ?? join(homeDirectory, ".local", "share"), "magent");
  const sharedSkills = env.MAGENT_SHARED_SKILLS
    ? resolve(env.MAGENT_SHARED_SKILLS)
    : join(homeDirectory, ".agents", "skills");

  return {
    home,
    environments: join(home, "envs"),
    sharedSkills,
  };
}
