import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Clock, Effect, Layer } from "effect"
import * as AttemptStore from "../../src/AttemptStore.ts"
import * as Migrations from "../../src/Migrations.ts"
import type { OwnerId } from "../../src/Ownership.ts"
import * as RunStore from "../../src/RunStore.ts"

const role = process.argv[2]
const filename = process.argv[3]
const runId = process.argv[4]

if ((role !== "a" && role !== "b") || filename === undefined || runId === undefined) {
  throw new Error("usage: run-store-file-fence-child.ts <a|b> <filename> <run-id>")
}

const ownerA: OwnerId = { hostId: "file-fence-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "file-fence-b", pid: 202, nonce: "owner-b" }
const owner = role === "a" ? ownerA : ownerB
const sharedAttempt = { runId, stepKeyDigest: "shared", attempt: 0 } as const

const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
const migrated = Layer.provideMerge(Migrations.layer, database)
const services = Layer.mergeAll(RunStore.layer, AttemptStore.layer).pipe(Layer.provide(migrated))

const emit = (value: unknown): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  })

const commands: Array<string> = []
const waiters: Array<(command: string) => void> = []
let input = ""

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  input += chunk
  while (true) {
    const newline = input.indexOf("\n")
    if (newline < 0) return
    const command = input.slice(0, newline)
    input = input.slice(newline + 1)
    const waiter = waiters.shift()
    if (waiter === undefined) commands.push(command)
    else waiter(command)
  }
})

const awaitCommand = (expected: string): Effect.Effect<void> =>
  Effect.promise(() =>
    new Promise<string>((resolve) => {
      const command = commands.shift()
      if (command === undefined) waiters.push(resolve)
      else resolve(command)
    }).then((command) => {
      if (command !== expected) throw new Error(`expected command ${expected}, received ${command}`)
    })
  )

const snapshotOf = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

let now = 0
const program = Effect.gen(function*() {
  const live = yield* Clock.Clock
  // Keep lease timestamps deterministic while real SQLite contention retries
  // use live sleep. A frozen TestClock deadlocks the losing process.
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration)
  }
  return yield* Effect.scoped(
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const attempts = yield* AttemptStore.AttemptStore

      if (role === "a") {
        yield* runs.create(runId, "{}")
        const admission = yield* runs.claimAndOwn(
          runId,
          { status: "pending", owner: null, heartbeatAtMs: null },
          ownerA,
          0
        )
        const put = yield* attempts.put({
          ...sharedAttempt,
          state: "running",
          startedAtMs: 0,
          meta: { admittedBy: "a" }
        }, ownerA)
        yield* emit({ phase: "ready", role, admission, put })
      } else {
        const stale = yield* runs.get(runId)
        yield* emit({ phase: "ready", role, snapshot: snapshotOf(stale) })
      }

      yield* awaitCommand("go")
      yield* Effect.sync(() => {
        now = 30_001
      })
      if (role === "a") {
        const heartbeat = yield* runs.heartbeat(runId, ownerA, 30_001)
        yield* emit({ phase: "race", role, heartbeat })
      } else {
        const stale = yield* runs.get(runId)
        const snapshot = snapshotOf(stale)
        const steal = yield* runs.steal(runId, snapshot, ownerB, 30_001, {
          expectedOwner: ownerA,
          checkedAtMs: 30_001,
          kind: "cross-host-unreachable-stale"
        })
        const activate = steal._tag === "Claimed"
          ? yield* runs.activate(runId, ownerB, steal.claimedAtMs, snapshot)
          : undefined
        yield* emit({ phase: "race", role, steal, activate })
      }

      yield* awaitCommand("verify")
      yield* Effect.sync(() => {
        now = 30_002
      })
      const heartbeat = yield* runs.heartbeat(runId, owner, 30_002)
      const transition = yield* runs.transitionOwned(runId, owner, "running", JSON.stringify({ writer: role }))
      const put = yield* attempts.put({
        runId,
        stepKeyDigest: `only-${role}`,
        attempt: 0,
        state: "running",
        startedAtMs: 30_002,
        meta: { writer: role }
      }, owner)
      const finish = yield* attempts.finish({
        ...sharedAttempt,
        state: "completed",
        finishedAtMs: 30_003,
        outcome: { writer: role }
      }, owner)
      const row = yield* runs.get(runId)
      yield* emit({ phase: "verified", role, heartbeat, transition, put, finish, row })
    }).pipe(Effect.provide(services), Effect.provideService(Clock.Clock, clock))
  )
})

// A process entrypoint: running the Effect here is the intended boundary.
Effect.runPromise(program).then(
  () => process.stdin.pause(),
  (cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`)
    process.exitCode = 1
    process.stdin.pause()
  }
)
