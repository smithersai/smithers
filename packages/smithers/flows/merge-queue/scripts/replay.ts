/**
 * Replays a recorded intake through the queue's rules with a virtual clock.
 *
 *   node scripts/replay.ts <intake.jsonl> [maxRuns=24] [maxBatch=8] [ciSeconds=2160]
 *
 * Each line of the intake file is one change another queue received:
 *
 *   {"at": <seconds>, "bad": <boolean>, "gone"?: <seconds>, "done"?: <seconds>}
 *
 * `at` is when it was handed in, `bad` whether it failed there, `gone` when it
 * was withdrawn, and `done` when that queue landed or returned it. The replay
 * hands each change to this queue at `at`, withdraws it at `gone`, and makes
 * every CI run that contains a `bad` change fail. Fix agents are off: a
 * failing change goes back to its author at its first failed run, as the
 * recorded queue did.
 *
 * It reports, for this queue and for the recorded one, how long a change
 * waited for its verdict, and for this queue the largest backlog and the CI
 * runs it spent.
 *
 * Limits: every CI run takes `ciSeconds` whatever it holds, with machines for
 * `maxRuns` runs at once. `bad` is the recorded queue's verdict, so a change
 * it returned because of another change in its batch counts as failing here
 * too, and a change it landed on a smaller gate counts as passing.
 */

import { readFileSync } from "node:fs"
import type { Config, Event, State } from "../src/Kernel.ts"
import { empty, fixBriefs, isTerminal, plan, pushingRun, step, tree, wantsCi } from "../src/Kernel.ts"

interface Row {
  readonly at: number
  readonly bad: boolean
  readonly gone?: number
  readonly done?: number
}

const [file = "", ...numbers] = process.argv.slice(2)
const [maxRuns = 24, maxBatch = 8, ciSeconds = 2160] = numbers.map(Number)
const rows = readFileSync(file, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Row)
  .sort((left, right) => left.at - right.at)
const config: Config = { required: [1], maxAttempts: 2, maxBatch, maxRuns, window: 20, defaultDuration: ciSeconds }

let state: State = empty
let now = rows[0]?.at ?? 0
let arrived = 0
let backlogPeak = 0
let backlogSeconds = 0
const finishes = new Map<number, number>()
const withdrawals = rows.flatMap((row, index) => row.gone === undefined ? [] : [{ id: index + 1, at: row.gone }])
  .sort((left, right) => left.at - right.at)
let withdrawn = 0
const verdictAt = new Map<number, number>()
const apply = (event: Event): void => {
  state = step(config, state, event)
}
const settle = (): void => {
  for (let event = plan(config, state); event !== undefined; event = plan(config, state)) apply(event)
}
const backlog = (): number => state.changes.filter((change) => !isTerminal(change.status)).length

while (true) {
  while (arrived < rows.length && rows[arrived]!.at <= now) {
    arrived++
    apply({ _tag: "enqueue", id: arrived, priority: 0 })
  }
  while (withdrawn < withdrawals.length && withdrawals[withdrawn]!.at <= now) {
    apply({ _tag: "withdraw", id: withdrawals[withdrawn]!.id })
    withdrawn++
  }
  settle()
  const pushed = pushingRun(state)
  if (pushed !== undefined) {
    apply({ _tag: "land", run: pushed.id })
    continue
  }
  const brief = fixBriefs(state)[0]
  if (brief !== undefined) {
    apply({ _tag: "gaveUp", id: brief.id, attempt: brief.attempt, detail: "fix agents are off in the replay" })
    continue
  }
  for (const change of state.changes) {
    if (isTerminal(change.status) && !verdictAt.has(change.id)) verdictAt.set(change.id, now)
  }
  for (const run of state.runs) {
    if (wantsCi(config, state, run) && !finishes.has(run.id)) finishes.set(run.id, now + ciSeconds)
  }
  backlogPeak = Math.max(backlogPeak, backlog())
  const live = new Set(state.runs.map((run) => run.id))
  const due = [
    ...[...finishes].filter(([id]) => live.has(id)).map(([, at]) => at),
    ...(arrived < rows.length ? [rows[arrived]!.at] : []),
    ...(withdrawn < withdrawals.length ? [withdrawals[withdrawn]!.at] : [])
  ]
  if (due.length === 0) break
  const next = Math.max(now, Math.min(...due))
  backlogSeconds += backlog() * (next - now)
  now = next
  for (const [id, at] of [...finishes]) {
    if (at > now) continue
    finishes.delete(id)
    const run = state.runs.find((entry) => entry.id === id)
    if (run === undefined) continue
    const bad = tree(run).some((entry) => rows[entry.id - 1]?.bad === true)
    apply({ _tag: "result", run: id, check: 1, verdict: bad ? "fail" : "pass", duration: ciSeconds })
  }
}

const quantile = (values: ReadonlyArray<number>, at: number): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(at * sorted.length))]!
}
const minutes = (seconds: number): string => (seconds / 60).toFixed(0)
const summary = (name: string, waits: ReadonlyArray<number>): string =>
  [name, waits.length, minutes(quantile(waits, 0.5)), minutes(quantile(waits, 0.9)), minutes(quantile(waits, 1))]
    .join(" | ")

const judged = rows.flatMap((row, index) => row.gone === undefined ? [{ row, id: index + 1 }] : [])
const here = judged.flatMap(({ id, row }) => verdictAt.has(id) ? [verdictAt.get(id)! - row.at] : [])
const there = judged.flatMap(({ row }) => row.done === undefined ? [] : [row.done - row.at])
const landed = state.changes.filter((change) => change.status._tag === "merged").length
const returned = state.changes.filter((change) => change.status._tag === "unmergeable").length
const span = (rows.at(-1)?.at ?? 0) - (rows[0]?.at ?? 0)

process.stdout.write(
  [
    `changes=${rows.length} withdrawn=${withdrawals.length} bad=${rows.filter((row) => row.bad).length} `
    + `maxRuns=${maxRuns} maxBatch=${maxBatch} ciSeconds=${ciSeconds} intakeHours=${(span / 3600).toFixed(1)}`,
    "",
    "queue | changes with a verdict | median wait (min) | 90% wait (min) | longest wait (min)",
    "--- | --- | --- | --- | ---",
    summary("this queue", here),
    summary("recorded queue", there),
    "",
    `this queue: landed ${landed}, returned ${returned}, peak backlog ${backlogPeak}, `
    + `mean backlog ${(backlogSeconds / Math.max(1, now - (rows[0]?.at ?? 0))).toFixed(1)}, CI runs ${state.nextRun}, `
    + `CI runs per landed change ${(state.nextRun / Math.max(1, landed)).toFixed(2)}, `
    + `drained ${minutes(now - (rows.at(-1)?.at ?? 0))} min after the last arrival`,
    ""
  ].join("\n")
)
