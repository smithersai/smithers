// The counter is test instrumentation; sealed actions use the existing boundary
// test adapter because no checkout files are read or produced by this fixture.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action, Flow } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Ownership } from "@smthrs/run-store"
import { Cause, Clock, Effect, Layer, Schema } from "effect"
import { Consensus } from "@smthrs/journal/Consensus"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import { appendFile } from "node:fs/promises"
import { once } from "node:events"
import * as EngineStore from "../../src/EngineStore.ts"
import * as StepBoundary from "../../src/StepBoundary.ts"
import * as StepSandbox from "../../src/StepSandbox.ts"
import * as TestStores from "../../src/test/TestStores.ts"

// Preserve the permit failure before the dispatcher turns a lost fence into
// self-interruption, so a failed process leaves its renewal cause in stderr.
const consensus = Layer.effect(Consensus, Effect.map(SqlConsensus.make, (strategy) => ({
  ...strategy,
  withPermit: (...args) => strategy.withPermit(...args).pipe(
    Effect.onError((cause) => Effect.sync(() => process.stderr.write(`permit-failed:${Cause.pretty(cause)}\n`)))
  )
})))

const [filename, counter, runId, mode] = process.argv.slice(2)
process.stdin.resume()
const release = once(process.stdin, "data")
const liveClock = await Effect.runPromise(Clock.clockWith(Effect.succeed))
const clock = mode === "crash" ? {
  sleep: (duration) => liveClock.sleep(duration),
  currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe() - 60_000_000_000n,
  currentTimeNanos: liveClock.currentTimeNanos.pipe(Effect.map((now) => now - 60_000_000_000n)),
  monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: liveClock.monotonicTimeNanos,
  currentTimeMillisUnsafe: () => liveClock.currentTimeMillisUnsafe() - 60_000,
  currentTimeMillis: liveClock.currentTimeMillis.pipe(Effect.map((now) => now - 60_000))
} : liveClock
const flow = Flow.make("CachePermit/Process", { payload: {}, success: Schema.String, body: () => Effect.die("opaque") })
const action = Action.make({
  name: "cache-permit-action", success: Schema.String, tier: "sealed", idempotencyKey: "cache-permit-v1",
  metadata: { readSet: [], writeSet: [], boundaryMode: "hard" },
  execute: Effect.gen(function*() {
    yield* Effect.promise(() => appendFile(counter, `${runId}\n`))
    process.stdout.write("body-started\n")
    yield* Effect.promise(() => release)
    return "result"
  })
})
const jj = Layer.succeed(Jj.Jj, Jj.make({
  snapshot: () => Effect.die("unexpected snapshot"), restore: () => Effect.void,
  diff: () => Effect.succeed(""), workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void, status: () => Effect.succeed("")
}))
try {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: "cache-permit-process" }, journalSource: "cache-permit-process",
      isAlive: Ownership.sameHostPidProbe
    })
    yield* engine.register(flow, () => action)
    process.stdout.write("ready\n")
    return yield* engine.execute(flow, { executionId: runId, payload: {}, discard: false })
  })).pipe(
    Effect.provide(Layer.mergeAll(TestStores.layerAt(filename, { consensus }).pipe(Layer.provide(NodeCrypto.layer)), StepBoundary.layerTest(), StepSandbox.layerTest(), jj,
      NodeCrypto.layer, Action.layerCacheEnvironment({ layers: [], capabilities: {} }))),
    Effect.provideService(Clock.Clock, clock)
  ))
  process.stdout.write(`result:${result}\n`)
} finally {
  process.stdin.pause()
}
