/**
 * Differential fuzz: random traces through the Lean reference binary and this
 * package's kernel; any line that differs is a failure.
 *
 *   node scripts/differential.ts [traces=2000] [length=120] [firstSeed=1]
 *
 * Build the reference first: `cd lean && lake build reference`.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { replay } from "../src/Kernel.ts"
import { trace } from "../test/support/Generate.ts"

const reference = process.env["MERGE_QUEUE_REFERENCE"]
  ?? fileURLToPath(new URL("../lean/.lake/build/bin/reference", import.meta.url))

if (!existsSync(reference)) {
  process.stderr.write(`no reference binary at ${reference}; run \`lake build reference\` in lean/\n`)
  process.exit(2)
}

const [traces = 2000, length = 120, firstSeed = 1] = process.argv.slice(2).map(Number)

let lines = 0
const chunk = 200
for (let offset = 0; offset < traces; offset += chunk) {
  const seeds = Array.from({ length: Math.min(chunk, traces - offset) }, (_, index) => firstSeed + offset + index)
  const inputs = seeds.map((seed) => trace(seed, length))
  const all = inputs.flat()
  const ran = spawnSync(reference, { input: all.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 30 })
  if (ran.status !== 0) {
    process.stderr.write(`reference exited with ${ran.status}: ${ran.stderr}\n`)
    process.exit(1)
  }
  const expected = ran.stdout.split("\n").slice(0, -1)
  const actual = replay(all)
  if (expected.length !== actual.length) {
    process.stderr.write(`line counts differ: reference ${expected.length}, kernel ${actual.length}\n`)
    process.exit(1)
  }
  let at = 0
  for (const [index, input] of inputs.entries()) {
    for (const [row, text] of input.entries()) {
      if (expected[at] !== actual[at]) {
        process.stderr.write(
          [
            `DIFFERENCE seed=${seeds[index]} line=${row}: ${text}`,
            `  reference: ${expected[at]}`,
            `  kernel:    ${actual[at]}`,
            `  replay with: node scripts/differential.ts 1 ${length} ${seeds[index]}`,
            ""
          ].join("\n")
        )
        process.exit(1)
      }
      at++
    }
  }
  lines += all.length
}
process.stdout.write(`differential: ${traces} traces, ${lines} lines, reference and kernel agree on every line\n`)
