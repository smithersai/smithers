/**
 * State-machine fuzzing of the browser host's lifecycle, each machine checked
 * against a reference model after every transition:
 *
 * - The leader's preparation of the app's database (`BrowserRuntime.run` with
 *   `prepare`), over OPFS in memory, real Web Locks and a real tab: a
 *   transient `PrepareFailed` is tried again by the next leader (#4981), a
 *   permanent one fences every leader of its epoch, a preparation prepares
 *   once per epoch across crashes, and a failure never carries its message.
 * - Leadership handoff over the real Web Lock: one holder at a time, FIFO
 *   election, a steal that fires exactly the stolen holder's `lost`, and a
 *   stolen holder whose release never frees the thief's lock.
 * - The storage boundary: `PendingSnapshot` over a faulty `Storage` shared by
 *   concurrent tabs and owners, and `StoragePersistence` over a storage
 *   manager that refuses in every way one can.
 */
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Schema, Scope, Tracer } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { setImmediate as nextTurn } from "node:timers/promises"
import { inspect } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BrowserRuntime, PendingSnapshot, type SharedSqlite, StoragePersistence, WebLock } from "../src/index.ts"
import * as Engines from "./fixtures/Engines.ts"
import { flows, registration } from "./fixtures/Flows.ts"
import * as MemoryOpfs from "./fixtures/MemoryOpfs.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** Fails the property with a message naming the broken invariant. */
const check = (holds: boolean, invariant: string): void => {
  if (!holds) throw new Error(invariant)
}

const fencedTag = "@smthrs/platform-browser/PrepareFailed"

/**
 * Every log line and span a device's workers produce, and a wait for the
 * `n`th line of a message: the rendezvous with a leadership that began or
 * ended, taken from the leader's own records instead of from a timer.
 */
const recorder = () => {
  const lines: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
  const spans: Array<Tracer.NativeSpan> = []
  const waiting = new Set<() => void>()
  const logger = Logger.make((options) => {
    const { annotations, message } = Logger.formatStructured.log(options)
    lines.push({ message, annotations })
    for (const wake of [...waiting]) wake()
  })
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  const count = (message: string, where: Record<string, unknown> = {}) =>
    lines.filter((line) =>
      line.message === message && Object.entries(where).every(([name, value]) => line.annotations[name] === value)
    ).length
  const until = (message: string, n: number): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      const wake = () => {
        if (count(message) < n) return
        waiting.delete(wake)
        resume(Effect.void)
      }
      waiting.add(wake)
      wake()
      return Effect.sync(() => waiting.delete(wake))
    })
  return {
    layer: Layer.merge(Layer.succeed(Tracer.Tracer, tracer), Logger.layer([logger])),
    count,
    until,
    /** Everything recorded, as one string, so a case can search it for content. */
    dump: () =>
      JSON.stringify({ lines, spans: spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })) })
  }
}

const behaviors = ["ok", "ok", "ok", "crash", "crash", "transient", "permanent"] as const
const Step = Schema.Struct({
  /** What this leadership's preparation does when the journal lets it run. */
  behavior: Schema.Literals(behaviors),
  /** The build that loads next, unless the same worker leads again. */
  epoch: Schema.Literals([1, 1, 2, 3]),
  /**
   * How this leadership ends: its tab closes, its tab closes while the next
   * build's worker already waits for the lock, or another context steals the
   * lock and the same worker leads again once it is given back.
   */
  handoff: Schema.Literals(["close", "close", "standby", "steal"])
})

/** Whether `statement` failed because the leader fenced the database, saying nothing of `secret`. */
const fenced = (statement: Effect.Effect<unknown, SqlError>, secret: string) =>
  Effect.map(Effect.exit(statement), (exit) => {
    if (Exit.isSuccess(exit)) return false
    check(!inspect(exit, { depth: 12 }).includes(secret), "a fenced statement carries the failure's message")
    const error = Exit.isFailure(exit) && Exit.hasFails(exit) ? Effect.runSync(Effect.flip(exit)) : undefined
    return error?.reason._tag === "ConnectionError" &&
      (error.reason.cause as { readonly name?: unknown } | undefined)?.name === fencedTag
  })

/**
 * One device: a sequence of leaderships over one OPFS, each checked against
 * the model of the journal (`settled`) and of the prepared table (`rows`).
 */
const device = (steps: ReadonlyArray<typeof Step.Type>) =>
  Effect.gen(function*() {
    const name = Engines.name()
    const secret = `quota-detail-${crypto.randomUUID()}`
    const telemetry = recorder()
    const script = { behavior: "ok" as typeof behaviors[number], midway: yield* Deferred.make<void>() }
    /** Sets what the next leadership's preparation does, before that leadership can begin. */
    const arm = (step: typeof Step.Type) =>
      Effect.map(Deferred.make<void>(), (midway) => {
        script.behavior = step.behavior
        script.midway = midway
      })
    const seen = { ran: 0, running: 0, concurrent: 0, interrupted: 0 }
    const preparation = (epoch: number): BrowserRuntime.Prepare<{ readonly rows: number }> => ({
      epoch,
      success: Schema.Struct({ rows: Schema.Number }),
      run: (database) =>
        Effect.gen(function*() {
          seen.ran++
          seen.concurrent = Math.max(seen.concurrent, ++seen.running)
          const behavior = script.behavior
          if (behavior === "transient") {
            return yield* Effect.fail({ _tag: "QuotaExceededError", message: secret })
          }
          if (behavior === "permanent") {
            return yield* Effect.fail(new BrowserRuntime.PrepareFailed({ error: "CorruptStore", permanent: true }))
          }
          yield* database.execute("CREATE TABLE IF NOT EXISTS prepared (epoch INTEGER)")
          yield* database.execute("BEGIN IMMEDIATE")
          yield* database.execute("INSERT INTO prepared VALUES (?)", [epoch])
          if (behavior === "crash") {
            // The leader dies here, inside its transaction.
            yield* Deferred.succeed(script.midway, undefined)
            return yield* Effect.never
          }
          yield* database.execute("COMMIT")
          return { rows: 1 }
        }).pipe(
          Effect.onInterrupt(() => Effect.sync(() => seen.interrupted++)),
          Effect.ensuring(Effect.sync(() => seen.running--))
        )
    })
    const load = (epoch: number) =>
      BrowserRuntime.run({
        name,
        sqlite: MemorySqlite.build,
        flows,
        registerFlows: registration(Effect.succeed),
        prepare: preparation(epoch),
        telemetry: telemetry.layer
      })
    const workers: Array<Fiber.Fiber<never, unknown>> = []
    yield* Effect.addFinalizer(() => Fiber.interruptAll(workers))
    const tab = yield* Engines.sharedTab(name)

    // The model: what the journal holds for each epoch, and the epochs whose preparation committed.
    const settled = new Map<number, "prepared" | "permanent">()
    const unfinished = new Set<number>()
    const rows: Array<number> = []
    let crashes = 0
    let epoch = steps[0]!.epoch
    yield* arm(steps[0]!)
    let leading = load(epoch)
    workers.push(leading)

    for (const [index, step] of steps.entries()) {
      const before = { ...seen }
      const outcomes = {
        prepared: telemetry.count("browser.runtime.prepare", { outcome: "prepared" }),
        failed: telemetry.count("browser.runtime.prepare", { outcome: "failed" })
      }
      // Exactly one leadership began for this step, and none besides.
      yield* telemetry.until("browser.runtime.leader", index + 1)
      check(telemetry.count("browser.runtime.leader") === index + 1, "a leadership began unasked")
      const known = settled.get(epoch)
      const expected = known ?? (
        step.behavior === "ok" ? "prepared" : step.behavior === "crash" ? "crashed" : step.behavior
      )

      if (expected === "crashed") {
        yield* Deferred.await(script.midway)
        check(seen.ran === before.ran + 1, `a crashed preparation ran ${seen.ran - before.ran} times`)
        unfinished.add(epoch)
        crashes++
      } else if (expected === "prepared") {
        const answered = yield* Effect.exit(tab.execute("SELECT epoch FROM prepared ORDER BY epoch"))
        if (known === undefined) {
          rows.push(epoch)
          rows.sort((left, right) => left - right)
        }
        check(
          Exit.isSuccess(answered) &&
            JSON.stringify(answered.value.map((row) => (row as { readonly epoch: number }).epoch)) ===
              JSON.stringify(rows),
          `epoch ${epoch} is not prepared exactly once: ${inspect(answered)} against ${JSON.stringify(rows)}`
        )
        // Once per epoch: a later leader answers from the journal.
        check(seen.ran === before.ran + (known === undefined ? 1 : 0), "a prepared epoch was prepared again")
        check(
          telemetry.count("browser.runtime.prepare", { outcome: "prepared" }) === outcomes.prepared + 1,
          "a served leadership did not record its preparation"
        )
        settled.set(epoch, "prepared")
        unfinished.delete(epoch)
      } else {
        // Neither a read nor a write runs on a database this build could not prepare.
        for (const sql of ["SELECT 1 AS one", "CREATE TABLE IF NOT EXISTS leaked (x)"]) {
          check(yield* fenced(tab.execute(sql), secret), `a ${expected} failure did not fence \`${sql}\``)
        }
        const attempts = seen.ran - before.ran
        if (known === "permanent") {
          check(attempts === 0, "a permanently failed epoch was prepared again")
        } else {
          // The step's retry policy tries three times; an attempt a crashed leader began counts among them.
          check(
            unfinished.has(epoch) ? attempts >= 1 && attempts <= 3 : attempts === 3,
            `a failing preparation ran ${attempts} times`
          )
        }
        check(
          telemetry.count("browser.runtime.prepare", { outcome: "failed" }) === outcomes.failed + 1,
          "a fenced leadership did not record its failure"
        )
        if (expected === "permanent") settled.set(epoch, "permanent")
        unfinished.delete(epoch)
      }
      check(seen.concurrent <= 1, "two preparations ran at once")

      // The handoff to the next leadership.
      const next = steps[index + 1]
      // This leadership's preparation has settled or hangs in its transaction: it reads the script no more.
      if (next !== undefined) yield* arm(next)
      if (step.handoff === "steal") {
        const lost = telemetry.count("browser.runtime.lost", { reason: "stolen" })
        const thief = yield* Scope.make()
        yield* Effect.flatMap(WebLock.WebLock, (locks) => locks.hold(name, { steal: true })).pipe(
          Effect.provide(WebLock.layer),
          Scope.provide(thief)
        )
        yield* telemetry.until("browser.runtime.lost", lost + 1)
        // The same worker, so the same build, leads again once the lock is given back.
        if (next === undefined) yield* Fiber.interrupt(leading)
        yield* Scope.close(thief, Exit.void)
      } else {
        const waiting = next !== undefined && step.handoff === "standby" ? load(next.epoch) : undefined
        if (waiting !== undefined) workers.push(waiting)
        // A worker that waits for the lock leads nothing while another holds it.
        check(telemetry.count("browser.runtime.leader") === index + 1, "a waiting worker led beside the leader")
        yield* Fiber.interrupt(leading)
        if (next !== undefined) {
          epoch = next.epoch
          leading = waiting ?? load(epoch)
          if (waiting === undefined) workers.push(leading)
        }
      }
      if (next !== undefined) yield* telemetry.until("browser.runtime.leader", index + 2)
      // A leadership that ended took its pending preparation with it.
      check(seen.interrupted === crashes, `${crashes} leaders died preparing, ${seen.interrupted} were interrupted`)
      check(seen.running === 0, "a preparation outlived its leadership")
    }
    // The failure's message never reached a log line or a span: only its tag did.
    check(!telemetry.dump().includes(secret), "the preparation's failure message was recorded")
    return true
  }).pipe(Effect.scoped)

/** The engine's lock as the browser reports it: who holds it and how many wait. */
const lockState = (name: string) =>
  Effect.map(Effect.promise(() => navigator.locks.query()), (snapshot) => ({
    held: (snapshot.held ?? []).filter((lock) => lock.name === name).length,
    pending: (snapshot.pending ?? []).filter((lock) => lock.name === name).length
  }))

describe("@smthrs/platform-browser host lifecycle fuzz invariants", () => {
  let remove: () => void = () => undefined
  beforeAll(() => {
    remove = MemoryOpfs.install()
  })
  afterAll(() => remove())

  it(
    "the leader's preparation follows the journal's model across failing, crashing, stolen and replaced leaderships",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({ steps: Schema.Array(Step).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4))) })
      )
      // A failing preparation waits out its retry policy in real time, so the executions are
      // spread over devices that run side by side, each with its own lock, channel and OPFS.
      const devices = 6
      const reports = await Effect.runPromise(
        Effect.forEach(
          Array.from({ length: devices }, (_, shard) => shard),
          (shard) =>
            Fuzz.run(arb, (input) => device(input.steps), {
              seed: seed + shard,
              executions: Math.ceil(ioExecutions / devices)
            }),
          { concurrency: "unbounded" }
        )
      )
      for (const report of reports) assertPassed(report)
    },
    180_000
  )

  it("leadership hands off through the Web Lock one holder at a time, in order, and a steal ends exactly the stolen holder", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(
          Schema.Struct({
            context: Schema.Literals([0, 1, 2, 3]),
            kind: Schema.Literals(["hold", "hold", "tryHold", "steal", "release", "release", "withdraw"])
          })
        ).pipe(Schema.check(Schema.isMaxLength(14)))
      })
    )
    type Context =
      | { readonly _tag: "idle" }
      | { readonly _tag: "waiting"; readonly fiber: Fiber.Fiber<void>; readonly scope: Scope.Closeable }
      | { readonly _tag: "holding" | "stolen"; readonly scope: Scope.Closeable }
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const locks = yield* WebLock.WebLock
            const name = `fuzz-lock-${crypto.randomUUID()}`
            const contexts: Array<Context> = [0, 1, 2, 3].map(() => ({ _tag: "idle" }))
            // What the contexts observed: whose request was granted, in order, and whose lock was lost.
            const granted: Array<number> = []
            const lost = new Set<number>()
            // The model: the holder and the queue behind it.
            let holder: number | undefined = undefined
            const queue: Array<number> = []
            const grants: Array<number> = []
            const stolen = new Set<number>()
            const grant = (context: number) => {
              holder = context
              grants.push(context)
            }
            const observe = (context: number, held: WebLock.Held) =>
              Effect.gen(function*() {
                granted.push(context)
                yield* Effect.forkDetach(Effect.andThen(held.lost, Effect.sync(() => lost.add(context))))
              })
            // Node's lock manager lists a withdrawn request as pending until its turn comes; Chromium drops it at once.
            let withdrawn = 0
            /** Waits until the browser and the contexts agree with the model, or says how they differ. */
            const settle = (after: string) =>
              Effect.gen(function*() {
                for (let turn = 0; turn < 400; turn++) {
                  // A grant arrives on a later turn of the event loop.
                  yield* Effect.promise(() => nextTurn())
                  const state = yield* lockState(name)
                  const seen = JSON.stringify({ held: state.held, granted, lost: [...lost].sort() })
                  const expected = JSON.stringify({
                    held: holder === undefined ? 0 : 1,
                    granted: grants,
                    lost: [...stolen].sort()
                  })
                  const queued = state.pending >= queue.length && state.pending <= queue.length + withdrawn
                  if (seen === expected && queued) return
                  if (turn === 399) {
                    check(
                      false,
                      `after ${after}: the lock is ${seen} with ${state.pending} waiting, the model ` +
                        `${expected} with ${queue.length}`
                    )
                  }
                }
              })
            yield* Effect.addFinalizer(() =>
              Effect.forEach(contexts, (context) =>
                context._tag === "idle"
                  ? Effect.void
                  : Effect.andThen(
                    context._tag === "waiting" ? Fiber.interrupt(context.fiber) : Effect.void,
                    Scope.close(context.scope, Exit.void)
                  ), { discard: true })
            )
            for (const [index, op] of input.ops.entries()) {
              const context = contexts[op.context]!
              if (op.kind === "hold" && context._tag === "idle") {
                const scope = yield* Scope.make()
                const fiber = yield* Effect.forkDetach(
                  Effect.flatMap(Scope.provide(locks.hold(name), scope), (held) =>
                    Effect.andThen(
                      observe(op.context, held),
                      Effect.sync(() => {
                        contexts[op.context] = { _tag: "holding", scope }
                      })
                    ))
                )
                contexts[op.context] = { _tag: "waiting", fiber, scope }
                if (holder === undefined) grant(op.context)
                else queue.push(op.context)
              } else if (op.kind === "tryHold" && context._tag === "idle") {
                const scope = yield* Scope.make()
                const held = yield* Scope.provide(locks.tryHold(name), scope)
                // Available means free: nothing held and nothing queued.
                check(Option.isSome(held) === (holder === undefined), "tryHold misjudged the lock")
                if (Option.isSome(held)) {
                  yield* observe(op.context, held.value)
                  contexts[op.context] = { _tag: "holding", scope }
                  grant(op.context)
                } else yield* Scope.close(scope, Exit.void)
              } else if (op.kind === "steal" && context._tag === "idle") {
                const scope = yield* Scope.make()
                const held = yield* Scope.provide(locks.hold(name, { steal: true }), scope)
                yield* observe(op.context, held)
                // The stolen holder keeps its scope, and learns of the loss; the queue keeps its order.
                if (holder !== undefined) {
                  stolen.add(holder)
                  const victim = contexts[holder]!
                  if (victim._tag !== "idle") contexts[holder] = { _tag: "stolen", scope: victim.scope }
                }
                contexts[op.context] = { _tag: "holding", scope }
                grant(op.context)
              } else if (op.kind === "release" && (context._tag === "holding" || context._tag === "stolen")) {
                yield* Scope.close(context.scope, Exit.void)
                contexts[op.context] = { _tag: "idle" }
                // A stolen holder has nothing left to give back: the thief's lock stays held.
                if (context._tag === "holding" && holder === op.context) {
                  holder = undefined
                  const next = queue.shift()
                  if (next !== undefined) grant(next)
                }
              } else if (op.kind === "withdraw" && context._tag === "waiting" && holder !== op.context) {
                yield* Fiber.interrupt(context.fiber)
                yield* Scope.close(context.scope, Exit.void)
                contexts[op.context] = { _tag: "idle" }
                queue.splice(queue.indexOf(op.context), 1)
                withdrawn++
              } else continue
              yield* settle(`${index}: ${op.kind} by ${op.context}`)
              // A granted wait is a holder; a context is never granted twice without asking twice.
              for (const [id, state] of contexts.entries()) {
                if (state._tag === "waiting" && holder === id) contexts[id] = { _tag: "holding", scope: state.scope }
              }
            }
            return true
          }).pipe(Effect.scoped, Effect.provide(WebLock.layer)),
        { seed: seed + 10, executions: ioExecutions }
      )
    )
    assertPassed(report)
  })

  it("PendingSnapshot never loses, leaks or resurrects a staged edit across tabs, owners and a failing Storage", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        tabs: Schema.Array(
          Schema.Array(
            Schema.Struct({
              kind: Schema.Literals(
                ["stage", "stage", "read", "acknowledge", "acknowledge-stale", "clear", "sign-in", "break", "corrupt"]
              ),
              value: Schema.Literals(
                ["text", "", "v1:forged:{}", "\ud800", "😀", "{\"owner\":\"bob\",\"value\":1}", "__proto__"]
              ),
              owner: Schema.Literals(["alice", "bob", "signed-out"]),
              fault: Schema.Literals(["none", "none", "get", "set", "remove"]),
              raw: Schema.Literals(
                [
                  "{",
                  "v1:",
                  "v1:x:",
                  "null",
                  "v1:u:{\"owner\":\"alice\"}",
                  "{\"owner\":\"bob\",\"value\":1}",
                  "v1:u:{\"owner\":\"alice\",\"value\":{\"n\":1}}",
                  "v1"
                ]
              )
            })
          ).pipe(Schema.check(Schema.isMaxLength(8)))
        ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(3)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            // One origin's storage, as its tabs share it, with the fault the last `break` left.
            const held = new Map<string, string>()
            let fault: "none" | "get" | "set" | "remove" = "none"
            const refuse = (kind: typeof fault, name: string) => {
              if (fault === kind) throw new DOMException("refused", name)
            }
            const storage: PendingSnapshot.Storage = {
              getItem: (key) => {
                refuse("get", "SecurityError")
                return held.get(key) ?? null
              },
              setItem: (key, value) => {
                refuse("set", "QuotaExceededError")
                held.set(key, value)
              },
              removeItem: (key) => {
                refuse("remove", "InvalidStateError")
                held.delete(key)
              }
            }
            let owner: string | undefined = "alice"
            // What every tab staged: each token, its owner and its value as JSON carries it.
            const staged = new Map<string, { readonly owner: string; readonly json: string }>()
            const tab = (ops: typeof input.tabs[number]) =>
              Effect.gen(function*() {
                const snapshot = PendingSnapshot.make(storage, "pending", () => owner)
                let mine: string | undefined = undefined
                let stale: string | undefined = undefined
                for (const op of ops) {
                  // Another tab runs between any two of this tab's operations.
                  yield* Effect.yieldNow
                  const before = held.get("pending")
                  if (op.kind === "sign-in") owner = op.owner === "signed-out" ? undefined : op.owner
                  else if (op.kind === "break") fault = op.fault
                  else if (op.kind === "corrupt") held.set("pending", op.raw)
                  else if (op.kind === "stage") {
                    const token = snapshot.stage({ text: op.value })
                    if (owner === undefined || fault === "set") {
                      check(token === undefined, "a refused staging answered a token")
                      check(held.get("pending") === before, "a refused staging changed the storage")
                    } else {
                      check(token !== undefined && token.startsWith("v1:"), "a staging answered no token")
                      check(!staged.has(token!), "two stagings share a token")
                      check(held.get("pending") === token, "a staging is not what the storage holds")
                      staged.set(token!, { owner, json: JSON.stringify({ text: op.value }) })
                      stale = mine
                      mine = token
                    }
                  } else if (op.kind === "read") {
                    const read = snapshot.read()
                    const record = before === undefined ? undefined : staged.get(before)
                    if (fault === "get" || before === undefined || owner === undefined) {
                      check(read === undefined, "a read answered what it could not see")
                    } else if (record !== undefined) {
                      // A staged edit is its owner's alone, and reads back as it was staged.
                      check(
                        record.owner === owner
                          ? read?.token === before && JSON.stringify(read.value) === record.json
                          : read === undefined,
                        `a staged edit of ${record.owner} read as ${inspect(read)} for ${owner}`
                      )
                    } else if (read !== undefined) {
                      // Foreign content reads only when it names this owner.
                      check(read.token === before && before.includes(`"owner":"${owner}"`), "foreign content was read")
                    }
                    check(held.get("pending") === before, "a read changed the storage")
                  } else if (op.kind === "acknowledge" || op.kind === "acknowledge-stale") {
                    const token = op.kind === "acknowledge" ? mine : stale
                    if (token === undefined) continue
                    snapshot.acknowledge(token)
                    // Only the edit it names goes: a newer staging, another tab's included, stays.
                    const goes = before === token && fault !== "get" && fault !== "remove"
                    check(
                      held.get("pending") === (goes ? undefined : before),
                      "an acknowledgement removed another edit"
                    )
                  } else {
                    snapshot.clear()
                    check(held.get("pending") === (fault === "remove" ? before : undefined), "a clear misjudged")
                  }
                }
              })
            yield* Effect.forEach(input.tabs, tab, { concurrency: "unbounded", discard: true })
            return true
          }),
        { seed: seed + 20, executions: pureExecutions, execution: FuzzSimulation.execution() }
      )
    )
    assertPassed(report)
  })

  // Shrunk counterexample this suite found: `{ refusal: "undefined" }`. `persist()` rejecting with
  // `undefined` or `null` died with a `TypeError` reading the rejection's `name`, so the tab's engine
  // client, which asks for persistent storage as it starts, died with it.
  for (const rejection of [undefined, null, "refused", { name: 7 }]) {
    it(`StoragePersistence answers false when persist() rejects with ${inspect(rejection)}`, async () => {
      const telemetry = recorder()
      const exit = await Effect.runPromiseExit(
        StoragePersistence.make({ persist: () => Promise.reject(rejection) }).persist.pipe(
          Effect.provide(telemetry.layer)
        )
      )
      expect(exit).toEqual(Exit.succeed(false))
      expect(telemetry.count("browser.storage.persist", { outcome: "refused", "error.type": "unknown" })).toBe(1)
    })
  }

  it("StoragePersistence answers false, never a failure, however the storage manager refuses, and PrepareFailed keeps its permanence through the journal's codec", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        refusal: Schema.Literals(
          [
            "granted",
            "denied",
            "absent",
            "no-manager",
            "dom-exception",
            "error",
            "string",
            "null",
            "undefined",
            "nameless",
            "odd-name",
            "throws"
          ]
        ),
        error: Schema.Array(Schema.Literals(["Quota", "Exceeded", "/", " ", "\n", "\0", "😀", "\ud800", "__proto__"]))
          .pipe(Schema.check(Schema.isMaxLength(5))),
        permanent: Schema.Literals(["permanent", "transient", "unmarked"])
      })
    )
    const encode = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(BrowserRuntime.PrepareFailed)))
    const decode = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(BrowserRuntime.PrepareFailed)))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const rejections: Record<string, unknown> = {
              "dom-exception": new DOMException("refused", "SecurityError"),
              error: new Error("refused"),
              string: "refused",
              null: null,
              undefined,
              nameless: {},
              "odd-name": { name: { toString: () => "secret" } }
            }
            const manager: StoragePersistence.StorageManagerLike | undefined = input.refusal === "no-manager"
              ? undefined
              : input.refusal === "absent"
              ? {}
              : input.refusal === "granted" || input.refusal === "denied"
              ? { persist: () => Promise.resolve(input.refusal === "granted") }
              : input.refusal === "throws"
              ? {
                persist: () => {
                  throw new TypeError("Illegal invocation")
                }
              }
              : { persist: () => Promise.reject(rejections[input.refusal]) }
            const exit = yield* Effect.exit(StoragePersistence.make(manager).persist)
            check(
              Exit.isSuccess(exit) && exit.value === (input.refusal === "granted"),
              `persist with ${input.refusal} answered ${inspect(exit)}`
            )

            const failure = new BrowserRuntime.PrepareFailed({
              error: input.error.join(""),
              ...input.permanent === "unmarked" ? {} : { permanent: input.permanent === "permanent" }
            })
            const back = decode(encode(failure))
            check(back instanceof BrowserRuntime.PrepareFailed, "the failure lost its class")
            check(back.error === failure.error, "the failure's tag changed")
            // The fence a later leader keeps is decided by exactly this field.
            check(back.permanent === failure.permanent, "the failure's permanence changed in the journal")
            check(
              (back.permanent === true) === (input.permanent === "permanent"),
              "a transient failure became permanent"
            )
            return true
          }),
        { seed: seed + 30, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })
})
