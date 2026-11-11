// The files of one gate shard (apps/mvp/ci/gate.sh): every test file vitest.config.ts includes, packed into <n> shards
// by their last measured times (gate-durations.json), longest first onto the least loaded shard, so the shards end
// together; vitest's own `--shard` splits by file name and left one shard 3× another. Every shard computes the same
// packing from the same checkout. A file with no time weighs the median. Prints shard <i>'s files, absolute, one a line.
// usage: node apps/mvp/ci/gate-shards.mjs <i> <n>   (from the checkout's root)
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const [i, n] = process.argv.slice(2).map(Number)
if (!(n >= 1 && i >= 1 && i <= n)) {
  console.error("usage: gate-shards.mjs <i> <n>")
  process.exit(2)
}
// vitest.config.ts's `include`, over the files git tracks.
const INCLUDE = /^(PACKAGE\.test\.ts|(tests|src|plugins|worker|db|infra|evals|e2e|dev|ops)\/.*\.test\.(ts|vibe))$/
const files = execFileSync("git", ["ls-files", "-z", "--", "apps/mvp"], { encoding: "utf8" })
  .split("\0").map((path) => path.slice("apps/mvp/".length)).filter((path) => INCLUDE.test(path)).sort()
const durations = JSON.parse(readFileSync(new URL("./gate-durations.json", import.meta.url), "utf8"))
const known = Object.values(durations).sort((a, b) => a - b)
const median = known.length === 0 ? 1 : known[Math.floor(known.length / 2)]
// The sandbox suites share one unit: each run that selects one packs infra/sandbox/cli and builds the image
// (worker/test/sandboxImage.globalSetup.ts), so shards that share a checkout must not each do it at once.
const unitOf = (file) => (/\.docker\.test\.(ts|vibe)$/.test(file) ? "docker" : file)
const units = new Map()
for (const file of files) {
  const unit = units.get(unitOf(file)) ?? { name: unitOf(file), files: [], ms: 0 }
  unit.files.push(file)
  unit.ms += durations[file] ?? median
  units.set(unit.name, unit)
}
const weighed = [...units.values()].sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name))
const load = Array.from({ length: n }, () => 0)
const shards = Array.from({ length: n }, () => [])
for (const { files: unitFiles, ms } of weighed) {
  const least = load.indexOf(Math.min(...load))
  load[least] += ms
  shards[least].push(...unitFiles)
}
for (const file of shards[i - 1]) console.log(resolve("apps/mvp", file))
