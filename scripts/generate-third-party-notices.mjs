/** Regenerates the Rust inventory shipped with @smthrs/jj; npm dependencies are outside its scope. */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { repoRoot as root } from "./workspace-packages.mjs"

const output = join(root, "packages/smithers/flows/jj/THIRD_PARTY_NOTICES.md")
const groups = new Map([
  ["Apache-2.0", "Apache-2.0"],
  ["MIT OR Apache-2.0", "MIT OR Apache-2.0"],
  ["Apache-2.0 OR MIT", "MIT OR Apache-2.0"],
  ["Unlicense OR MIT", "Unlicense OR MIT"],
  ["MIT", "MIT"],
  ["BSD-3-Clause", "BSD-3-Clause"],
  ["Zlib", "Zlib"],
  ["CC0-1.0 OR MIT-0 OR Apache-2.0", "Combined"],
  ["BSD-2-Clause OR Apache-2.0 OR MIT", "Combined"],
  ["Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT", "Combined"],
  ["(MIT OR Apache-2.0) AND Unicode-3.0", "Combined"]
])

const cell = (value) => value.replaceAll("|", "&#124;").replaceAll(/\s+/g, " ").trim()

const generate = () => {
  if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("usage: generate-third-party-notices.mjs [--check]")
  // Cargo filters platform edges; traversing only normal/build edges then excludes
  // dev-only crates while retaining proc macros and transitive build dependencies.
  const metadata = JSON.parse(execFileSync("cargo", [
    "metadata", "--format-version", "1", "--locked", "--filter-platform", "wasm32-wasip1"
  ], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }))
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]))
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const entry = metadata.packages.find((pkg) => pkg.name === "flows-jj" && metadata.workspace_members.includes(pkg.id))
  if (entry === undefined) throw new Error("Cargo workspace has no flows-jj package")
  const visited = new Set()
  const pending = [entry.id]
  while (pending.length > 0) {
    const id = pending.pop()
    if (visited.has(id)) continue
    visited.add(id)
    const node = nodes.get(id)
    if (node === undefined) throw new Error(`Missing resolved Cargo node: ${id}`)
    for (const dep of node.deps) {
      if (dep.dep_kinds.some((kind) => kind.kind === null || kind.kind === "build")) pending.push(dep.pkg)
    }
  }
  visited.delete(entry.id)
  const inventory = new Map([...new Set(groups.values())].map((group) => [group, []]))
  for (const id of visited) {
    const pkg = packages.get(id)
    const license = pkg.license?.replaceAll(/\s*\/\s*/g, " OR ")
    const group = groups.get(license)
    if (group === undefined) throw new Error(`Review license attribution for ${pkg.name}: ${pkg.license ?? "missing license"}`)
    inventory.get(group).push([
      `\`${pkg.name}\``, pkg.version, pkg.authors.length > 0 ? pkg.authors.join("; ") : "(see repository)",
      pkg.repository ? `<${pkg.repository}>` : "(not specified)"
    ].map(cell))
  }
  const template = readFileSync(join(root, "scripts/third-party-notices.template.md"), "utf8")
  const rendered = template.replaceAll(/\{\{crates:([^}]+)\}\}/g, (_, group) => {
    const rows = inventory.get(group)
    if (rows === undefined) throw new Error(`Unknown template group: ${group}`)
    inventory.delete(group)
    rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    rows.unshift(["Crate", "Version", "Copyright", "Repository"])
    const widths = rows[0].map((_, index) => Math.max(3, ...rows.map((row) => row[index].length)))
    rows.splice(1, 0, widths.map((width) => "-".repeat(width)))
    return rows.map((row) => `| ${row.map((value, index) => value.padEnd(widths[index])).join(" | ")} |`).join("\n")
  })
  if (inventory.size > 0) throw new Error(`Template omits license groups: ${[...inventory.keys()].join(", ")}`)
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== rendered) throw new Error("THIRD_PARTY_NOTICES.md is out of date; run node scripts/generate-third-party-notices.mjs")
    console.log(`Third-party notices are current (${visited.size} crates).`)
  } else {
    writeFileSync(output, rendered)
    console.log(`Generated third-party notices (${visited.size} crates).`)
  }
}

try {
  generate()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
