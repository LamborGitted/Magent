#!/usr/bin/env node
import { Command } from "commander";
import { EnvironmentStore } from "./core/environment-store.js";
import { runHarness } from "./core/harnesses.js";
import { getMagentPaths } from "./core/paths.js";

const program = new Command();
const store = new EnvironmentStore();

program
  .name("magent")
  .description("Manage isolated environments for AI agent harnesses")
  .version("0.1.0")
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
      throw new Error(`Refusing to remove "${name}" without --yes.`);
    }
    await store.remove(name);
    console.log(`Removed environment "${name}".`);
  });

program
  .command("run")
  .description("Run a harness inside an environment")
  .argument("<environment>", "environment name")
  .argument("<harness>", "pi, dsh, or codex")
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
