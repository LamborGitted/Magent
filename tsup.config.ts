import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const packageMetadata = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  define: {
    __MAGENT_VERSION__: JSON.stringify(packageMetadata.version),
  },
});
