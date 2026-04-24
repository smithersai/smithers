import { defineConfig } from "tsup";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

function collectEntries(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(entries, collectEntries(fullPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }
    const relativePath = relative("src", fullPath).replace(/\\/g, "/");
    entries[relativePath.replace(/\.js$/, "")] = fullPath;
  }
  return entries;
}

export default defineConfig({
  entry: collectEntries("src"),
  dts: { only: true, resolve: false },
  outDir: "dist",
  clean: true,
  format: ["esm"],
  silent: true,
});
