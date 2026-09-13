/** Declaration drift is a review gate, not a semantic compatibility verdict. */
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { libraryPackages, repoRoot } from "./workspace-packages.mjs"

const declarations = (directory, prefix = "") => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const name = `${prefix}${entry.name}`
  return entry.isDirectory()
    ? declarations(join(directory, entry.name), `${name}/`)
    : entry.name.endsWith(".d.ts") ? [name] : []
})

/** Include private declarations too: public signatures can reference them. */
export const apiSurface = (root = repoRoot) => Object.fromEntries(
  libraryPackages(root).filter(({ manifest }) => !manifest.private).map(({ name, dir, manifest }) => {
    const directory = join(root, dir, "dist/esm")
    const names = declarations(directory).sort()
    if (names.length === 0) throw new Error(`${name}: no declarations; build the package before checking its API`)
    return [name, {
      exports: manifest.publishConfig.exports,
      declarations: Object.fromEntries(names.map((file) => {
        const contents = readFileSync(join(directory, file), "utf8").replace(/\r\n/g, "\n")
          .replace(/^\/\/# sourceMappingURL=.*$/gm, "").trim()
        return [file, createHash("sha256").update(contents).digest("hex")]
      }))
    }]
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
)

export const assertApiBaseline = (expected, actual) => {
  const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter((name) =>
    JSON.stringify(expected[name]) !== JSON.stringify(actual[name]))
  if (changed.length > 0) throw new Error(
    `Declaration/API drift requires compatibility review:\n${changed.map((name) => `  ${name}`).join("\n")}\n` +
    "Review declaration diffs, consumer type tests and release notes before explicitly updating the baseline."
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const path = join(repoRoot, "scripts/fixtures/public-api-baseline.json")
  const surface = apiSurface()
  if (process.argv.length === 3 && process.argv[2] === "--update") {
    writeFileSync(path, `${JSON.stringify({ format: 1, packages: surface }, null, 2)}\n`)
    console.log(`Recorded declarations for ${Object.keys(surface).length} public packages`)
  } else if (process.argv.length === 2) {
    const baseline = JSON.parse(readFileSync(path, "utf8"))
    if (baseline.format !== 1) throw new Error("unsupported API baseline format")
    assertApiBaseline(baseline.packages, surface)
    console.log(`Declaration baseline matches ${Object.keys(surface).length} public packages`)
  } else throw new Error("usage: node scripts/check-api-baseline.mjs [--update]")
}
