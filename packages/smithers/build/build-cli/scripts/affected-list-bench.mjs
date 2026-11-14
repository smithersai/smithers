/**
 * Measures `affected --list` explanation cost over the graphs in
 * `test/helpers/AffectedListGraph.ts`: `shared` (every root reaches the
 * changed files through one shared dependency) and `package` (every root lives
 * in the changed package, so each is a direct source of every file). Reports serialized JSON bytes, wall time of
 * `select` plus `JSON.stringify`, heap growth across both (no collection in
 * between, so an upper bound on what the result and its string retain),
 * and the process's peak resident set.
 *
 * Each grid point runs in its own process, so a point that runs out of memory
 * or passes V8's string limit is recorded as that result and the rest still
 * run. A point that takes longer than the timeout is recorded as a timeout.
 *
 * Run from the package directory:
 *   node scripts/affected-list-bench.mjs [scenario,roots,files ...] [--timeout-ms N]
 */
import * as ChildProcess from "node:child_process"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"

const self = fileURLToPath(import.meta.url)
const loaders = ["--import", "vibelang/register", "--import", "tsx"]
const sizes = [[1000, 50], [1000, 200], [4000, 60], [4000, 120], [4000, 435], [4000, 700]]
const defaultGrid = ["shared", "package"].flatMap((scenario) => sizes.map((size) => [scenario, ...size]))

const point = async (scenario, roots, files) => {
  const { samePackageGraph, sharedDependencyGraph } = await import(
    Path.join(Path.dirname(self), "../test/helpers/AffectedListGraph.ts")
  )
  const Affected = await import(Path.join(Path.dirname(self), "../src/Affected.ts"))
  const graph = (scenario === "package" ? samePackageGraph : sharedDependencyGraph)(roots, files)
  globalThis.gc?.()
  const before = process.memoryUsage().heapUsed
  const start = performance.now()
  let result
  try {
    const explained = Affected.select(graph.index, ["//..."], graph.paths, { explain: true })
    const json = JSON.stringify(explained)
    const ms = performance.now() - start
    const growth = process.memoryUsage().heapUsed - before
    result = { status: "ok", bytes: json.length, ms, heapGrowthMb: growth / 2 ** 20, targets: explained.targets.length }
  } catch (cause) {
    result = { status: `error: ${cause instanceof Error ? cause.message : String(cause)}`, ms: performance.now() - start }
  }
  result.peakRssMb = process.resourceUsage().maxRSS / 1024
  process.stdout.write(JSON.stringify(result) + "\n")
}

const main = () => {
  const args = process.argv.slice(2)
  const timeoutIndex = args.indexOf("--timeout-ms")
  const timeoutMs = timeoutIndex === -1 ? 180_000 : Number(args.splice(timeoutIndex, 2)[1])
  const grid = args.length > 0 ? args.map((triple) => triple.split(",").map((part, at) => at === 0 ? part : Number(part))) : defaultGrid
  const rows = []
  for (const [scenario, roots, files] of grid) {
    const child = ChildProcess.spawnSync(
      process.execPath,
      ["--expose-gc", ...loaders, self, "--point", scenario, String(roots), String(files)],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1 << 20 }
    )
    const line = child.stdout.trim().split("\n").at(-1) ?? ""
    let row
    if (child.error?.code === "ETIMEDOUT") row = { status: `timeout after ${timeoutMs} ms` }
    else if (line.startsWith("{")) row = JSON.parse(line)
    else {
      const reason = /heap out of memory|Invalid string length|RangeError[^\n]*/.exec(child.stderr)?.[0]
      row = { status: `exit ${child.status ?? child.signal}: ${reason ?? child.stderr.trim().split("\n").at(-1)}` }
    }
    rows.push({ scenario, roots, files, ...row })
    process.stderr.write(`${scenario} ${roots} x ${files}: ${row.status}\n`)
  }
  const cell = (value, digits = 0) => value === undefined ? "-" : value.toFixed(digits)
  process.stdout.write("| scenario | roots | files | JSON bytes | wall ms | heap growth MB | peak RSS MB | result |\n")
  process.stdout.write("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n")
  for (const row of rows) {
    process.stdout.write(
      `| ${row.scenario} | ${row.roots} | ${row.files} | ${row.bytes === undefined ? "-" : row.bytes.toLocaleString("en-US")} | ${
        cell(row.ms)
      } | ${cell(row.heapGrowthMb, 1)} | ${cell(row.peakRssMb)} | ${row.status} |\n`
    )
  }
}

if (process.argv[2] === "--point") await point(process.argv[3], Number(process.argv[4]), Number(process.argv[5]))
else main()
