/**
 * Private native imports must expose declarations to ordinary TypeScript
 * callers, including projects that do not enable a native source condition.
 * @since 0.1.0
 */
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import * as fc from "fast-check"
import { expect, test } from "vitest"

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript")
const manifestUrl = new URL("../package.json", import.meta.url)
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { imports: Record<string, unknown> }
const aliases = Object.entries(manifest.imports).flatMap(([key, value]) => {
  if (value === null || typeof value !== "object" ||
    !("types" in value) || typeof value.types !== "string" ||
    !("vibelang-source" in value) || typeof value["vibelang-source"] !== "string") return []
  return value["vibelang-source"].startsWith("./worker/")
    ? [{ key, types: value.types, source: value["vibelang-source"] }]
    : []
})

test("Worker import aliases use their source project declarations", () => {
  expect(aliases.length).toBeGreaterThan(0)
  const config = ts.readConfigFile(fileURLToPath(new URL("worker/tsconfig.json", manifestUrl)), ts.sys.readFile)
  expect(config.error).toBeUndefined()
  expect(config.config.vibe?.sidecarDir).toBeUndefined()
  for (const alias of aliases) expect(alias.types).toBe(alias.source.replace(/\.vibe$/, ".d.vibe.ts"))
  const missing = aliases.filter(alias => !existsSync(new URL(alias.types, manifestUrl)))
  expect(missing.map(alias => alias.key)).toEqual([])
})

test("Worker aliases resolve declarations across caller contexts and conditions", () => {
  fc.assert(fc.property(
    fc.constantFrom(...aliases),
    fc.constantFrom("src", "worker", "infra", "evals", "bench"),
    fc.constantFrom("ts", "tsx", "mts", "cts"),
    fc.constantFrom([], ["browser"], ["node"], ["development"], ["production"]),
    (alias, directory, extension, conditions) => {
      const importer = fileURLToPath(new URL(directory + "/native-import-probe." + extension, manifestUrl))
      const resolved = ts.resolveModuleName(alias.key, importer, {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowArbitraryExtensions: true,
        customConditions: conditions,
      }, ts.sys).resolvedModule
      expect(resolved?.resolvedFileName).toBe(fileURLToPath(new URL(alias.source.replace(/\.vibe$/, ".d.vibe.ts"), manifestUrl)))
    },
  ), { seed: 478103439, numRuns: 400 })
})

