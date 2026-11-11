/**
 * Preserve logical source coverage when a module changes its file extension.
 * @since 0.1.0
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const sourceFiles = (root, directory = "src") => readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
  const path = directory + "/" + entry.name
  return entry.isDirectory() ? sourceFiles(root, path) :
    entry.isFile() && /\.(?:tsx?|vibe)$/.test(entry.name) ? [path] : []
}).sort()

const companionOwner = path => path.endsWith(".d.vibe.ts") ? path.replace(/\.d\.vibe\.ts$/, ".vibe") :
  /\.vibe\.(?:platform|throwing)\.d\.ts$/.test(path) ? path.replace(/\.(?:platform|throwing)\.d\.ts$/, "") :
  path.endsWith(".platform.ts") ? path.replace(/\.platform\.ts$/, ".vibe") : undefined

/** Physical files, their stable logical identifiers and owned declaration companions. */
export const sourceInventory = (root, manifest) => {
  const files = sourceFiles(root)
  const actual = new Set(files)
  const original = new Set(manifest)
  const companions = []
  const platform = []
  const logical = []
  for (const path of files) {
    const owner = companionOwner(path)
    if (!original.has(path) && owner !== undefined && actual.has(owner)) {
      if (path.endsWith(".platform.ts")) platform.push(path)
      else companions.push(path)
    }
    else logical.push(path.endsWith(".vibe") ? path.slice(0, -".vibe".length) + ".ts" : path)
  }
  return {
    typescript: files.filter(path => /\.tsx?$/.test(path)),
    native: files.filter(path => path.endsWith(".vibe")),
    logical: logical.sort(),
    companions,
    platform
  }
}

/** Refuse missing, extra or duplicate logical sources before updating the physical roster. */
export const checkSourceCoverage = (root, manifest) => {
  if (!Array.isArray(manifest) || manifest.some(path => typeof path !== "string") ||
    JSON.stringify(manifest) !== JSON.stringify([...new Set(manifest)].sort())) {
    throw new Error("The logical source manifest must contain sorted, unique source identifiers")
  }
  const inventory = sourceInventory(root, manifest)
  const expected = new Set(manifest)
  const actual = new Set(inventory.logical)
  const missing = manifest.filter(path => !actual.has(path))
  const extra = inventory.logical.filter(path => !expected.has(path))
  const duplicate = inventory.logical.filter((path, index) => index > 0 && path === inventory.logical[index - 1])
  if (missing.length || extra.length || duplicate.length) {
    throw new Error("Source coverage changed: " + JSON.stringify({ missing, extra, duplicate }))
  }
  return inventory
}

/** Rewrite only the physical TypeScript roster after the complete logical inventory passes. */
export const writeTypeScriptRoster = (root, manifest) => {
  const inventory = checkSourceCoverage(root, manifest)
  const roster = join(root, "coverage-roster.json")
  if (existsSync(roster)) {
    const prior = JSON.parse(readFileSync(roster, "utf8"))
    if (!Array.isArray(prior) || prior.some(path => typeof path !== "string")) throw new Error("Invalid physical source roster")
    const current = new Set(inventory.typescript)
    const native = new Set(inventory.native)
    const original = new Set(manifest)
    const removed = prior.filter(path => {
      if (current.has(path)) return false
      if (original.has(path) && native.has(path.replace(/\.tsx?$/, ".vibe"))) return false
      const owner = companionOwner(path)
      return path.endsWith(".platform.ts") || original.has(path) || owner === undefined || !native.has(owner)
    })
    if (removed.length) throw new Error("Missing physical source while regenerating coverage: " + JSON.stringify(removed))
  }
  writeFileSync(roster, JSON.stringify(inventory.typescript, null, 2) + "\n")
  return inventory
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv[2] === "--write"
  const root = resolve(process.argv[write ? 3 : 2] ?? ".")
  const manifest = JSON.parse(readFileSync(join(root, "coverage-source-manifest.json"), "utf8"))
  const inventory = write ? writeTypeScriptRoster(root, manifest) : checkSourceCoverage(root, manifest)
  const roster = JSON.parse(readFileSync(join(root, "coverage-roster.json"), "utf8"))
  if (JSON.stringify(roster) !== JSON.stringify(inventory.typescript)) throw new Error("The physical TypeScript roster is stale")
  console.log(JSON.stringify({ logical: inventory.logical.length, native: inventory.native.length,
    typescript: inventory.typescript.length, companions: inventory.companions.length, platform: inventory.platform.length, written: write }))
}
