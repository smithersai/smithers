#!/usr/bin/env node
// How many CI jobs smithers-ci reproduces in each repository, read from its inventory: nothing is run.
//
//   node packages/ci/scripts/inventory-counts.mjs [--program <path to bin/smithers-ci.mjs>] <repository>...
//
// A change to src/inventory or src/generate is landed with this table from the program before the change and from
// the program after it, in its commit message: a job that falls out is explained there, or the change does not land.
// Each repository is a checkout at the commit to read; nothing is fetched. The jobs kept and left are those the
// program's own contract (`ci`, `notReplayed`) decides, so each program is read by its own rules.
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const at = args.indexOf("--program")
const program = resolve(at === -1 ? fileURLToPath(new URL("../bin/smithers-ci.mjs", import.meta.url)) : args[at + 1])
const repositories = args.filter((_, index) => at === -1 || (index !== at && index !== at + 1))
if (repositories.length === 0) {
  console.error("usage: node packages/ci/scripts/inventory-counts.mjs [--program <smithers-ci.mjs>] <repository>...")
  process.exit(2)
}
const contractBase = join(dirname(program), "..", "src", "contract", "Inventory")
const vibe = existsSync(`${contractBase}.vibe`)
if (vibe) await import("vibelang/register")
const contract = pathToFileURL(`${contractBase}.${vibe ? "vibe" : "ts"}`).href
const { ci, notReplayed } = await import(contract)

let failed = 0
for (const repository of repositories) {
  const name = basename(resolve(repository))
  const read = spawnSync(process.execPath, [program, "inventory", "--json"], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024
  })
  if (read.status !== 0) {
    console.log(`${name}: inventory failed: ${read.stderr.trim().split("\n").at(-1)}`)
    failed += 1
    continue
  }
  const inventory = JSON.parse(read.stdout)
  const kept = ci(inventory).jobs.length
  const left = notReplayed(inventory)
  console.log(`${name}: ${kept} of ${kept + left.length} CI jobs reproduced`)
  for (const entry of left) {
    console.log(`  left out ${entry.job}: ${[...new Set(entry.reasons.map((reason) => reason.feature))].join(", ")}`)
  }
}
process.exitCode = failed === 0 ? 0 : 1
