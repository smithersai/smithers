import { describe, test } from "vitest"
import {
  type Config,
  empty,
  eta,
  parseLine,
  plan,
  pruned,
  renderState,
  type Sample,
  schedule,
  settle,
  type State,
  step
} from "../src/index.ts"

const config: Config = {
  required: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  maxAttempts: 2,
  maxBatch: 8,
  maxRuns: 4,
  window: 20,
  defaultDuration: 200
}

const smallConfig: Config = {
  required: [1, 2, 3],
  maxAttempts: 2,
  maxBatch: 8,
  maxRuns: 4,
  window: 20,
  defaultDuration: 200
}

// Build an active 64-change state with 4 running batches.
let activeState: State = empty
for (let id = 1; id <= 64; id++) {
  activeState = step(smallConfig, activeState, { _tag: "enqueue", id, priority: id % 3 })
}
activeState = settle(smallConfig, 64, activeState)
// Record partial check results on the first two runs.
for (const run of activeState.runs.slice(0, 2)) {
  activeState = step(smallConfig, activeState, {
    _tag: "result",
    run: run.id,
    check: 1,
    verdict: "pass",
    duration: 180
  })
}

// Build a state with 40 landed changes for pruning / rendering benchmarks.
const runFullCycle = (changeCount: number): State => {
  let state: State = empty
  for (let id = 1; id <= changeCount; id++) {
    state = step(smallConfig, state, { _tag: "enqueue", id, priority: 0 })
  }
  state = settle(smallConfig, 128, state)
  while (state.runs.length > 0) {
    const firstRun = state.runs[0]!
    for (const check of smallConfig.required) {
      state = step(smallConfig, state, {
        _tag: "result",
        run: firstRun.id,
        check,
        verdict: "pass",
        duration: 120 + check * 10
      })
    }
    state = settle(smallConfig, 64, state)
    if (state.pushing !== null) {
      state = step(smallConfig, state, { _tag: "land", run: state.pushing })
      state = settle(smallConfig, 64, state)
    } else {
      break
    }
  }
  return state
}

const landedState = runFullCycle(32)

const historySamples: ReadonlyArray<Sample> = Array.from({ length: 240 }, (_, i) => ({
  check: (i % 12) + 1,
  duration: 100 + ((i * 37) % 450)
}))

const partialResults = [
  { check: 1, verdict: "pass" as const },
  { check: 2, verdict: "pass" as const },
  { check: 3, verdict: "pass" as const }
]

const sampleTraceLines = [
  "enqueue 42 1",
  "start 8",
  "result 5 3 pass 240",
  "push 5",
  "land 5"
]

const planFn = plan
const prunedFn = pruned
const scheduleFn = schedule
const etaFn = eta
const renderStateFn = renderState
const parseLineFn = parseLine
const opts = { time: 120, warmupTime: 30 }

describe("@smthrs/merge-queue", () => {
  test("step + settle full 32-change merge cycle", async ({ bench }) => {
    await bench("full 32-change cycle", () => {
      runFullCycle(32)
    }).run(opts)
  })

  test("plan decision on 64-change active state", async ({ bench }) => {
    await bench("plan (64 changes, 4 runs)", () => {
      planFn(smallConfig, activeState)
    }).run(opts)
  })

  test("Predict.schedule and Predict.eta (12 checks, 240 samples)", async ({ bench }) => {
    await bench("schedule (12 checks, 240 samples)", () => {
      scheduleFn(config, historySamples)
    }).run(opts)

    await bench("eta (12 checks, 240 samples)", () => {
      etaFn(config, historySamples, partialResults)
    }).run(opts)
  })

  test("Compact.pruned and Trace.renderState", async ({ bench }) => {
    await bench("Compact.pruned (32 landed)", () => {
      prunedFn(landedState)
    }).run(opts)

    await bench("Trace.renderState (64 changes)", () => {
      renderStateFn(smallConfig, activeState)
    }).run(opts)
  })

  test("Trace.parseLine 5 commands", async ({ bench }) => {
    await bench("Trace.parseLine x5", () => {
      for (const line of sampleTraceLines) parseLineFn(line)
    }).run(opts)
  })
})
