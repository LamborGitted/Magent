import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultRegistryUrl = "https://skills.sh";

export interface RegistrySkill {
  name: string;
  package: string;
  slug: string;
  installs: number;
  url: string;
}

export interface SkillsRegistry {
  search(query: string, owner?: string): Promise<RegistrySkill[]>;
  install(packageSpec: string, destinationRoot: string): Promise<string[]>;
}

export class SkillsShRegistry implements SkillsRegistry {
  public constructor(
    private readonly baseUrl = process.env.SKILLS_API_URL || defaultRegistryUrl,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async search(query: string, owner?: string): Promise<RegistrySkill[]> {
    const params = new URLSearchParams({ q: query, limit: "20" });
    if (owner) params.set("owner", owner);
    const response = await this.fetcher(`${this.baseUrl}/api/search?${params}`);
    if (!response.ok) {
      throw new Error(`skills.sh search failed with HTTP ${response.status}.`);
    }
    const body = await response.json() as {
      skills?: Array<{ id?: unknown; name?: unknown; installs?: unknown; source?: unknown }>;
    };
    if (!Array.isArray(body.skills)) throw new Error("skills.sh returned an invalid response.");

    return body.skills.flatMap((skill) => {
      if (typeof skill.id !== "string" || typeof skill.name !== "string") return [];
      const source = typeof skill.source === "string" ? skill.source : "";
      const packageName = source ? `${source}@${skill.name}` : skill.id;
      return [{
        name: skill.name,
        package: packageName,
        slug: skill.id,
        installs: typeof skill.installs === "number" ? skill.installs : 0,
        url: `${this.baseUrl}/${skill.id}`,
      }];
    });
  }

  public async install(packageSpec: string, destinationRoot: string): Promise<string[]> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "magent-skills-install-"));
    try {
      await runSkillsCli(temporaryRoot, packageSpec);
      const installedRoot = join(temporaryRoot, ".agents", "skills");
      const entries = await readdir(installedRoot, { withFileTypes: true }).catch((error: unknown) => {
        throw new Error(
          `Skills CLI did not produce an installation for "${packageSpec}": ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      const installed = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      if (installed.length === 0) throw new Error(`No Skills were installed from "${packageSpec}".`);

      for (const skillName of installed) {
        await cp(join(installedRoot, skillName), join(destinationRoot, skillName), {
          recursive: true,
          errorOnExist: true,
          force: false,
          dereference: true,
        });
      }
      return installed.sort((left, right) => left.localeCompare(right));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function runSkillsCli(cwd: string, packageSpec: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "npx",
      ["--yes", "skills", "add", packageSpec, "--agent", "universal", "--copy", "--yes"],
      { cwd, stdio: "inherit" },
    );
    child.once("error", (error) => reject(new Error(`Could not start Skills CLI: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Skills CLI failed${signal ? ` with ${signal}` : ` with exit code ${code ?? 1}`}.`));
    });
  });
}
