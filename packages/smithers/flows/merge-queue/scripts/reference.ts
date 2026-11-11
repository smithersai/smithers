/**
 * Regenerates the fixtures the unit suite compares this package's kernel with,
 * from the Lean reference binary:
 *
 * - `test/fixtures/<name>.expected` for every `test/fixtures/<name>.trace`;
 * - `test/fixtures/reference.json`: for each seed, the SHA-256 of what the
 *   reference prints for that seed's random trace.
 *
 *   node scripts/reference.ts
 *
 * Build the reference first: `cd lean && lake build reference`. Run this after
 * any change to the reference, to the trace format or to `test/support/Generate.ts`.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { trace } from "../test/support/Generate.ts"

const reference = process.env["MERGE_QUEUE_REFERENCE"]
  ?? fileURLToPath(new URL("../lean/.lake/build/bin/reference", import.meta.url))
const fixtures = fileURLToPath(new URL("../test/fixtures/", import.meta.url))

if (!existsSync(reference)) {
  process.stderr.write(`no reference binary at ${reference}; run \`lake build reference\` in lean/\n`)
  process.exit(2)
}

const ask = (lines: ReadonlyArray<string>): string => {
  const ran = spawnSync(reference, { input: lines.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 30 })
  if (ran.status !== 0) throw new Error(`reference exited with ${ran.status}: ${ran.stderr}`)
  return ran.stdout
}

for (const file of readdirSync(fixtures).filter((name) => name.endsWith(".trace"))) {
  const lines = readFileSync(fixtures + file, "utf8").split("\n").slice(0, -1)
  writeFileSync(fixtures + file.replace(/\.trace$/, ".expected"), ask(lines))
}

const traces = 400
const length = 120
const digests = Array.from(
  { length: traces },
  (_, index) => createHash("sha256").update(ask(trace(index + 1, length))).digest("hex")
)
writeFileSync(fixtures + "reference.json", JSON.stringify({ firstSeed: 1, length, digests }, null, 1) + "\n")
process.stdout.write(`reference: wrote ${traces} digests and the scenario fixtures\n`)
