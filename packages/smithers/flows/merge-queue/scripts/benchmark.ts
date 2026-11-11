/**
 * Throughput benchmark for the kernel and for the queue's use of CI.
 *
 *   node scripts/benchmark.ts [changes=1000] [failRate=0.05] [seed=1]
 *
 * It simulates a queue with a virtual clock. Every CI run takes `ciSeconds`
 * of virtual time whatever its size, and a fix takes `fixSeconds`. Changes
 * arrive `arrivalsPerRun` per CI duration. The simulation is deterministic for
 * a seed. It reports:
 *
 * - kernel speed: events applied per second of real time (what the queue
 *   itself costs);
 * - landing rate: changes landed per CI duration (what the policy gets out of
 *   CI), against the arrival rate, for several `maxRuns` and `maxBatch`;
 * - CI runs spent per landed change.
 *
 * Method and limits: CI is modelled as a fixed duration with unlimited
 * machines up to `maxRuns`; real suites vary and share machines. A failing
 * change fails every run that contains it, and a fix succeeds with
 * probability `fixRate`. The numbers compare configurations; they do not
 * predict wall-clock time on a real repository.
 */

import type { Config, Event, State } from "../src/Kernel.ts"
import { empty, fixBriefs, isTerminal, plan, pushingRun, step, tree, wantsCi } from "../src/Kernel.ts"
import { random } from "../test/support/Generate.ts"

const [changes = 1000, failRate = 0.05, seed = 1] = process.argv.slice(2).map(Number)
const ciSeconds = 600
const fixSeconds = 900
const fixRate = 0.8

interface Outcome {
  readonly landed: number
  readonly unmergeable: number
  readonly virtualSeconds: number
  readonly runs: number
  readonly events: number
  readonly realMs: number
  readonly backlogPeak: number
}

const simulate = (config: Config, arrivalsPerRun: number): Outcome => {
  const next = random(seed)
  const broken = new Map<number, boolean>()
  let state: State = empty
  let events = 0
  let now = 0
  let arrived = 0
  let backlogPeak = 0
  const finishes = new Map<number, number>()
  const fixes = new Map<string, number>()
  const started = performance.now()
  const apply = (event: Event): void => {
    state = step(config, state, event)
    events++
  }
  const settle = (): void => {
    for (let event = plan(config, state); event !== undefined; event = plan(config, state)) apply(event)
  }
  const arrivalGap = ciSeconds / arrivalsPerRun
  while (true) {
    while (arrived < changes && arrived * arrivalGap <= now) {
      arrived++
      broken.set(arrived, next() < failRate)
      apply({ _tag: "enqueue", id: arrived, priority: 0 })
    }
    settle()
    const pushed = pushingRun(state)
    if (pushed !== undefined) {
      apply({ _tag: "land", run: pushed.id })
      continue
    }
    for (const run of state.runs) {
      if (wantsCi(config, state, run) && !finishes.has(run.id)) finishes.set(run.id, now + ciSeconds)
    }
    for (const brief of fixBriefs(state)) {
      const key = `${brief.id}#${brief.attempt}`
      if (!fixes.has(key)) fixes.set(key, now + fixSeconds)
    }
    backlogPeak = Math.max(backlogPeak, state.changes.filter((change) => !isTerminal(change.status)).length)
    const live = new Set(state.runs.map((run) => run.id))
    const due = [
      ...[...finishes].filter(([id]) => live.has(id)).map(([, at]) => at),
      ...[...fixes.values()],
      ...(arrived < changes ? [arrived * arrivalGap] : [])
    ]
    if (due.length === 0) break
    now = Math.max(now, Math.min(...due))
    for (const [id, at] of [...finishes]) {
      if (at > now) continue
      finishes.delete(id)
      const run = state.runs.find((entry) => entry.id === id)
      if (run === undefined) continue
      const bad = tree(run).some((entry) => broken.get(entry.id) === true)
      for (const check of config.required) {
        apply({ _tag: "result", run: id, check, verdict: bad ? "fail" : "pass", duration: ciSeconds })
      }
    }
    for (const [key, at] of [...fixes]) {
      if (at > now) continue
      fixes.delete(key)
      const [id, attempt] = key.split("#").map(Number) as [number, number]
      if (next() < fixRate) broken.set(id, false)
      apply({ _tag: "fixed", id, attempt })
    }
  }
  return {
    landed: state.changes.filter((change) => change.status._tag === "merged").length,
    unmergeable: state.changes.filter((change) => change.status._tag === "unmergeable").length,
    virtualSeconds: now,
    runs: state.nextRun,
    events,
    realMs: performance.now() - started,
    backlogPeak
  }
}

const rows: Array<string> = []
for (
  const [maxRuns, maxBatch, arrivalsPerRun] of [
    [1, 1, 1],
    [8, 8, 4],
    [16, 8, 8],
    [32, 8, 16],
    [64, 16, 32],
    [64, 1, 32]
  ] as const
) {
  const config: Config = { required: [1], maxAttempts: 2, maxBatch, maxRuns, window: 20, defaultDuration: ciSeconds }
  const outcome = simulate(config, arrivalsPerRun)
  const perRun = outcome.landed / (outcome.virtualSeconds / ciSeconds)
  rows.push(
    [
      maxRuns,
      maxBatch,
      arrivalsPerRun,
      perRun.toFixed(2),
      perRun >= arrivalsPerRun * 0.95 ? "yes" : "no",
      outcome.backlogPeak,
      (outcome.runs / Math.max(1, outcome.landed)).toFixed(2),
      outcome.landed,
      outcome.unmergeable,
      Math.round(outcome.events / (outcome.realMs / 1000))
    ].join(" | ")
  )
}
process.stdout.write(
  [
    `changes=${changes} failRate=${failRate} fixRate=${fixRate} seed=${seed} ciSeconds=${ciSeconds} fixSeconds=${fixSeconds}`,
    "",
    "maxRuns | maxBatch | arrivals per CI duration | landed per CI duration | keeps up | peak backlog | CI runs per landed change | landed | unmergeable | kernel events/s",
    "--- | --- | --- | --- | --- | --- | --- | --- | --- | ---",
    ...rows,
    ""
  ].join("\n")
)
