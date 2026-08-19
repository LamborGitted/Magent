#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { confirmEnvironmentRemoval, confirmInstalledSkillRemoval } from "./core/confirmation.js";
import { EnvironmentStore } from "./core/environment-store.js";
import { inspectHarnesses, runHarness } from "./core/harnesses.js";
import { getMagentPaths } from "./core/paths.js";
import { SkillStore } from "./core/skill-store.js";
import { SkillsShRegistry } from "./core/skills-registry.js";

declare const __MAGENT_VERSION__: string;

const program = new Command();
const store = new EnvironmentStore();
const skillsRegistry = new SkillsShRegistry();
const skillStore = new SkillStore(store, getMagentPaths(), skillsRegistry);

program
  .name("magent")
  .description("Manage isolated environments for AI agent harnesses")
  .version(__MAGENT_VERSION__)
  .showHelpAfterError();

const environment = program
  .command("env")
  .description("Manage environments");

environment
  .command("create")
  .description("Create an isolated environment")
  .argument("<name>", "environment name")
  .action(async (name: string) => {
    const manifest = await store.create(name);
    console.log(`Created environment "${manifest.name}".`);
    console.log(store.environmentPath(manifest.name));
  });

environment
  .command("list")
  .alias("ls")
  .description("List environments")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const manifests = await store.list();
    if (options.json) {
      console.log(JSON.stringify(manifests, null, 2));
      return;
    }
    if (manifests.length === 0) {
      console.log("No environments found.");
      return;
    }
    console.log("NAME\tCREATED");
    for (const manifest of manifests) {
      console.log(`${manifest.name}\t${manifest.createdAt}`);
    }
  });

environment
  .command("info")
  .description("Show environment details")
  .argument("<name>", "environment name")
  .option("--json", "print JSON")
  .action(async (name: string, options: { json?: boolean }) => {
    const manifest = await store.read(name);
    const details = { ...manifest, path: store.environmentPath(name) };
    if (options.json) {
      console.log(JSON.stringify(details, null, 2));
      return;
    }
    console.log(`Name:    ${manifest.name}`);
    console.log(`ID:      ${manifest.id}`);
    console.log(`Created: ${manifest.createdAt}`);
    console.log(`Path:    ${details.path}`);
  });

environment
  .command("remove")
  .alias("rm")
  .description("Remove an environment")
  .argument("<name>", "environment name")
  .option("-y, --yes", "confirm destructive removal")
  .action(async (name: string, options: { yes?: boolean }) => {
    if (!options.yes) {
      await store.read(name);
      if (!await confirmEnvironmentRemoval(name)) {
        console.log("Removal cancelled.");
        return;
      }
    }
    await store.remove(name);
    console.log(`Removed environment "${name}".`);
  });

program
  .command("listskills [environment]")
  .description("List shared Skills or Skills linked to an environment")
  .option("--json", "print JSON")
  .action(listSkillsAction);

program
  .command("addskills <environment> <skills...>")
  .description("Link shared Skills or install skills.sh packages into an environment")
  .option("--shared", "force all inputs to be shared Skill IDs")
  .option("--registry", "force all inputs to be skills.sh packages")
  .option("-g, --global", "install registry packages globally, then link them")
  .action(addSkillsAction);

program
  .command("rmskills <environment> <skills...>")
  .alias("removeskills")
  .description("Remove managed Skills from an environment")
  .option("-y, --yes", "confirm deletion of installed Skill files")
  .action(removeSkillsAction);

const skillsCommand = program.command("skills").description("Manage shared Skills bindings");

skillsCommand
  .command("list [environment]")
  .alias("ls")
  .description("List shared Skills or Skills linked to an environment")
  .option("--json", "print JSON")
  .action(listSkillsAction);

skillsCommand
  .command("add <environment> <skills...>")
  .description("Link shared Skills or install skills.sh packages into an environment")
  .option("--shared", "force all inputs to be shared Skill IDs")
  .option("--registry", "force all inputs to be skills.sh packages")
  .option("-g, --global", "install registry packages globally, then link them")
  .action(addSkillsAction);

skillsCommand
  .command("search [query...]")
  .alias("find")
  .description("Search skills.sh")
  .option("--owner <owner>", "search only repositories from a GitHub owner")
  .option("--json", "print JSON")
  .action(searchSkillsAction);

skillsCommand
  .command("remove <environment> <skills...>")
  .alias("rm")
  .description("Remove managed Skills from an environment")
  .option("-y, --yes", "confirm deletion of installed Skill files")
  .action(removeSkillsAction);

program
  .command("doctor [harness]")
  .description("Detect supported Harness executables and versions")
  .option("--json", "print JSON")
  .action(async (harnessId: string | undefined, options: { json?: boolean }) => {
    const results = await inspectHarnesses(harnessId);
    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log("HARNESS\tSTATE\tVERSION\tPATH");
      for (const result of results) {
        console.log(
          `${result.id}\t${result.state}\t${result.version ?? "-"}\t${result.path ?? "-"}`,
        );
        if (result.error) console.log(`  ${result.error}`);
      }
    }
    if (results.some((result) => result.state !== "available")) process.exitCode = 1;
  });

program
  .command("run")
  .description("Run a harness inside an environment")
  .argument("<environment>", "environment name")
  .argument("<harness>", "pi, dsh, codex, claude, or gemini")
  .argument("[args...]", "arguments passed to the harness")
  .allowUnknownOption()
  .action(async (environmentName: string, harness: string, args: string[]) => {
    process.exitCode = await runHarness(store, environmentName, harness, args);
  });

program
  .command("home")
  .description("Print the Magent data directory")
  .action(() => {
    console.log(getMagentPaths().home);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function listSkillsAction(
  environmentName: string | undefined,
  options: { json?: boolean },
): Promise<void> {
  if (environmentName) {
    const skills = await skillStore.listEnvironment(environmentName);
    if (options.json) {
      console.log(JSON.stringify(skills, null, 2));
    } else if (skills.length === 0) {
      console.log(`No Skills found in ${store.skillsPath(environmentName)}.`);
    } else {
      console.log("SKILL\tSTATUS\tTARGET");
      for (const skill of skills) {
        console.log(`${skill.id}\t${skill.status}\t${skill.target}`);
      }
    }
    return;
  }

  const skills = await skillStore.listShared();
  if (options.json) {
    console.log(JSON.stringify(skills, null, 2));
  } else if (skills.length === 0) {
    console.log(`No Skills found in ${skillStore.sharedSkillsPath()}.`);
  } else {
    console.log("SKILL\tDESCRIPTION");
    for (const skill of skills) console.log(`${skill.id}\t${skill.description ?? ""}`);
  }
}

interface AddSkillsCliOptions {
  shared?: boolean;
  registry?: boolean;
  global?: boolean;
}

async function addSkillsAction(
  environmentName: string,
  skillIds: string[],
  options: AddSkillsCliOptions,
): Promise<void> {
  if (options.shared && options.registry) throw new Error("--shared and --registry cannot be combined.");
  if (options.global && options.shared) throw new Error("--global only applies to registry packages.");
  const added = await skillStore.add(environmentName, skillIds, {
    source: options.shared ? "shared" : options.registry ? "registry" : "auto",
    ...(options.global ? { global: true } : {}),
  });
  for (const skill of added) {
    console.log(`${skill.status === "installed" ? "Installed" : "Linked"} ${skill.id} -> ${skill.target}`);
  }
}

async function searchSkillsAction(
  queryParts: string[],
  options: { owner?: string; json?: boolean },
): Promise<void> {
  let query = queryParts.join(" ").trim();
  if (!query && process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      query = (await prompt.question("Search skills: ")).trim();
    } finally {
      prompt.close();
    }
  }
  if (!query) throw new Error("A search query is required in non-interactive mode.");
  const results = await skillsRegistry.search(query, options.owner);
  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log(`No Skills found for "${query}".`);
    return;
  }
  console.log("PACKAGE\tINSTALLS\tURL");
  for (const skill of results) console.log(`${skill.package}\t${skill.installs}\t${skill.url}`);
  console.log("\nInstall with: magent skills add <environment> <package>");
}

async function removeSkillsAction(
  environmentName: string,
  skillIds: string[],
  options: { yes?: boolean },
): Promise<void> {
  const installed = (await skillStore.listEnvironment(environmentName))
    .filter((skill) => skillIds.includes(skill.id) && skill.status === "installed")
    .map((skill) => skill.id);
  if (installed.length > 0 && !options.yes) {
    if (!await confirmInstalledSkillRemoval(environmentName, installed)) {
      console.log("Removal cancelled.");
      return;
    }
  }
  const removed = await skillStore.remove(environmentName, skillIds);
  for (const skill of removed) {
    console.log(`${skill.linkRemoved ? "Unlinked" : "Removed"} ${skill.id}`);
  }
}
