/** Test-wide no-new-mocks ratchet, including pre-existing suites outside this fix. */
import * as Fs from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { legacyModuleReplacements, legacyPlatformReplacements } from "../TestPolicy.ts"

it("forbids module and platform replacements outside the shrinking legacy inventory", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const entries = await Fs.readdir(join(root, "test"), { recursive: true, withFileTypes: true })
  const observed: Record<string, number> = {}
  const observedPlatforms: Record<string, number> = {}
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(ts|vibe)$/.test(entry.name)) continue
    const path = entry.parentPath + "/" + entry.name
    const file = relative(root, path).split(sep).join("/")
    if (file.split("/").some((part) => part.startsWith("."))) continue
    const text = await Fs.readFile(path, "utf8")
    const platforms = [...text.matchAll(/Object\.defineProperty\(\s*process\s*,\s*["']platform["']/g)].length
    if (platforms > 0) observedPlatforms[file] = platforms
    expect(platforms, file).toBeLessThanOrEqual(legacyPlatformReplacements[file] ?? 0)
    const replacements = [...text.matchAll(/\b(?:vi|jest)\.(?:mock|doMock|spyOn|stubGlobal)\s*\(/g)].length
    if (replacements > 0) observed[file] = replacements
    expect(replacements, file).toBeLessThanOrEqual(legacyModuleReplacements[file] ?? 0)
  }
  // A removed replacement requires deleting or reducing its allowance in the same change.
  expect(observed).toEqual(legacyModuleReplacements)
  expect(observedPlatforms).toEqual(legacyPlatformReplacements)
})
