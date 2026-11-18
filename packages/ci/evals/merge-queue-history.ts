// Derives fast-mode rows from the VibeLang merge queue's real history on nyc-01.
//
//   node evals/merge-queue-history.ts <logs directory> <repository> <rows.jsonl>
//
// Each train `mq-<tag>` left a run record (`-graph.json`, or `-affected-graph.json` with `-affected-rest-graph.json`),
// the commits it ran between (`-affected-cost.json`: base and tip), and sometimes a rerun of its failures
// (`-affected-rerun-graph.json`). One train is one change: its files are the diff from base to tip, its time is the
// tip's. A target that failed and passed its rerun has attempts that disagree, so it is flaky. The queue kept no
// dependency graph per train, so no plan is given and a target is at distance 0 only inside a changed file's project.
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RunRecord, TargetResult } from "../src/contract/RunRecord.ts"
import * as Features from "../src/select/Features.ts"

const [logs, repository, out] = process.argv.slice(2)
if (logs === undefined || repository === undefined || out === undefined) {
  process.stderr.write("usage: merge-queue-history.ts <logs directory> <repository> <rows.jsonl>\n")
  process.exit(2)
}

const git = (...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 1 << 30
  })
const lines = (text: string): ReadonlyArray<string> => text.split("\n").filter((line) => line !== "")
const json = (file: string): any => JSON.parse(readFileSync(join(logs, file), "utf8"))
const results = (file: string): ReadonlyArray<TargetResult> => existsSync(join(logs, file)) ? json(file).results : []

const tags = readdirSync(logs)
  .filter((name) => /^mq-\d{8}-\d+-affected-graph\.json$/.test(name))
  .map((name) => name.replace(/-affected-graph\.json$/, ""))

interface Train {
  readonly tag: string
  readonly base: string
  readonly tip: string
  readonly at: number
}

const trains: Array<Train> = []
for (const tag of tags) {
  const { base, tip } = json(`${tag}-affected-cost.json`)
  try {
    trains.push({
      tag,
      base,
      tip: git("rev-parse", `${tip}^{commit}`).trim(),
      at: Number(git("show", "--no-patch", "--format=%ct", tip)) * 1000
    })
  } catch {
    process.stderr.write(`${tag}: skipped, the repository no longer holds ${tip}\n`)
  }
}
trains.sort((a, b) => a.at - b.at)

// Every commit of the window, read once from the newest base: the queue's bases are all on the one landing branch.
const oldest = trains[0]!.at - Features.horizonDays * Features.day
const history: ReadonlyArray<Features.Commit> = git(
  "log",
  `--since=${Math.floor(oldest / 1000)}`,
  "--format=%x01%ct",
  "--name-only",
  trains.at(-1)!.base
)
  .split("\u0001").slice(1).map((block) => {
    const [seconds, ...files] = lines(block)
    return { at: Number(seconds) * 1000, files }
  })

writeFileSync(out, "")
const past: Array<Features.Observation> = []
const seen = new Set<string>()
let failures = 0
let flaky = 0
for (const train of trains) {
  if (seen.has(train.tip)) continue
  seen.add(train.tip)
  const first = new Map<string, TargetResult>()
  for (
    const file of [
      `${train.tag}-graph.json`,
      `${train.tag}-affected-graph.json`,
      `${train.tag}-affected-rest-graph.json`
    ]
  ) {
    for (const result of results(file)) if (!first.has(result.label)) first.set(result.label, result)
  }
  const rerun = new Map(results(`${train.tag}-affected-rerun-graph.json`).map((result) => [result.label, result]))
  const merged: ReadonlyArray<TargetResult> = [...first.values()].map((result) => {
    const again = rerun.get(result.label)
    const attempt = (each: TargetResult) => ({ passed: each.status === "ran", durationMs: each.durationMs })
    return {
      label: result.label,
      status: result.status,
      key: result.key,
      durationMs: result.durationMs,
      ...(result.status === "failed" && again !== undefined ? { attempts: [attempt(result), attempt(again)] } : {})
    }
  })
  const record: RunRecord = {
    ok: merged.every((result) => result.status !== "failed"),
    counts: { hit: 0, ran: 0, failed: 0, skipped: 0 },
    results: merged,
    commit: train.tip,
    mode: "normal"
  }
  const rows = Features.build(record, {
    commit: train.tip,
    at: train.at,
    files: lines(git("diff", "--name-only", train.base, train.tip)),
    history,
    tree: lines(git("ls-tree", "-r", "--name-only", train.tip)),
    past,
    plan: undefined
  })
  const observations = rows.map((row) => ({ at: train.at, row }))
  for (const observation of observations) past.push(observation)
  for (let start = 0; start < observations.length; start += 500) {
    appendFileSync(
      out,
      observations.slice(start, start + 500).map((observation) => `${JSON.stringify(observation)}\n`).join("")
    )
  }
  failures += rows.filter((row) => row.failed).length
  flaky += rows.filter((row) => row.flaky).length
  process.stderr.write(
    `${train.tag} ${new Date(train.at).toISOString()} rows ${rows.length} failed ${
      rows.filter((row) => row.failed).length
    }\n`
  )
}
process.stdout.write(
  `${past.length} rows, ${seen.size} changes, ${failures} failures, ${flaky} flaky, from ${
    new Date(trains[0]!.at).toISOString()
  } to ${new Date(trains.at(-1)!.at).toISOString()}\n`
)
