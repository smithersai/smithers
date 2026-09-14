/**
 * A generated command model for the durable signal inbox. The oracle owns only
 * first-write admission, exclusive token reservation and absorbing terminal
 * states; it knows no SQL, cursor representation or runtime implementation.
 *
 * Replay with SMITHERS_FUZZ_SEED / SMITHERS_FUZZ_CASES / SMITHERS_FUZZ_STEPS.
 */
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { PersistenceError, RunNotFound } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime, type Service, type SignalCommand } from "../src/ControlRuntime.ts"
import type { SignalPayload } from "../src/ControlSchema.ts"
import { durable, fileBundle } from "./DurableStack.ts"

const integer = (name: string, fallback: number, minimum: number): number => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > 0xffff_ffff) {
    throw new Error(`${name} must be an integer between ${minimum} and 4294967295`)
  }
  return value
}
const baseSeed = integer("SMITHERS_FUZZ_SEED", 0x51_67_6e_61, 0)
const caseCount = integer("SMITHERS_FUZZ_CASES", 3, 1)
const steps = integer("SMITHERS_FUZZ_STEPS", 120, 1)
const artifactDirectory = process.env["SMITHERS_FUZZ_ARTIFACT_DIR"]

const random = (seed: number) => {
  let state = seed >>> 0
  return (limit: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return Math.floor((state / 0x1_0000_0000) * limit)
  }
}
const copy = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A
const commandId = (index: number) => index % 3 === 0 ? `command 😀/${index}` : `command/${index}`
const tokenId = (index: number) => `wait:"é"/${index}`
type Terminal = "delivered" | "rejected" | "terminal"
type Mutation =
  | { readonly kind: "admit"; readonly id: string; readonly run: number; readonly signal: SignalPayload }
  | { readonly kind: "bind"; readonly id: string; readonly token: string }
  | { readonly kind: "settle"; readonly id: string; readonly state: Terminal }
type Operation =
  | Mutation
  | { readonly kind: "race"; readonly left: Mutation; readonly right: Mutation }
  | { readonly kind: "lookup"; readonly id: string }
  | { readonly kind: "poll"; readonly runtime: 0 | 1 }
  | { readonly kind: "reopen" }
type Outcome = { readonly ok: true; readonly value: string | null } | {
  readonly ok: false
  readonly error: "missing-run" | "missing-command"
}
type Model = ReadonlyMap<string, SignalCommand>
const ok = (value: string | null = null): Outcome => ({ ok: true, value })

/** A specification transition; terminal rows and claimed tokens never expire. */
const transition = (
  before: Model,
  command: Mutation,
  runs: ReadonlyArray<string>
): { model: Model; outcome: Outcome } => {
  const model = new Map(before)
  const row = before.get(command.id)
  if (command.kind === "admit") {
    const runId = runs[command.run]
    if (runId === undefined) return { model, outcome: { ok: false, error: "missing-run" } }
    if (row === undefined) {
      model.set(
        command.id,
        copy({ commandId: command.id, runId, signal: command.signal, token: null, state: "pending" })
      )
    }
    return { model, outcome: ok() }
  }
  if (command.kind === "settle") {
    if (row?.state === "pending") model.set(command.id, { ...row, state: command.state })
    return { model, outcome: ok() }
  }
  if (row === undefined) return { model, outcome: { ok: false, error: "missing-command" } }
  if (row.token !== null || row.state !== "pending") return { model, outcome: ok(row.token) }
  const reserved = new Set(Array.from(before.values(), (value) => value.token).filter((value) => value !== null))
  if (reserved.has(command.token)) return { model, outcome: ok(null) }
  model.set(command.id, { ...row, token: command.token })
  return { model, outcome: ok(command.token) }
}

const generate = (seed: number, count: number): ReadonlyArray<Operation> => {
  const next = random(seed)
  const signal = (): SignalPayload => ({
    name: `ready-${next(3)}`,
    payload: { number: next(1000), text: "é😀\\\"\n", nested: [null, true, next(7)] }
  })
  const admit = (id: string, run = next(2)): Mutation => ({ kind: "admit", id, run, signal: signal() })
  const mutation = (): Mutation => {
    const id = commandId(next(24))
    switch (next(3)) {
      case 0:
        return admit(id, next(12) === 0 ? 2 : next(2))
      case 1:
        return { kind: "bind", id, token: tokenId(next(8)) }
      default:
        return { kind: "settle", id, state: (["delivered", "rejected", "terminal"] as const)[next(3)]! }
    }
  }
  // A mandatory small boundary corpus makes every seed exercise the important
  // transitions. The suffix then mixes valid, invalid and concurrent histories.
  const history: Array<Operation> = [
    { kind: "bind", id: "absent", token: tokenId(0) },
    { kind: "settle", id: "absent", state: "delivered" },
    admit(commandId(0), 0),
    admit(commandId(0), 1),
    admit(commandId(1), 1),
    {
      kind: "race",
      left: { kind: "bind", id: commandId(0), token: tokenId(0) },
      right: { kind: "bind", id: commandId(1), token: tokenId(0) }
    },
    { kind: "bind", id: commandId(0), token: tokenId(1) },
    { kind: "settle", id: commandId(0), state: "delivered" },
    { kind: "settle", id: commandId(0), state: "rejected" },
    { kind: "settle", id: commandId(1), state: "terminal" },
    { kind: "bind", id: commandId(1), token: tokenId(2) },
    admit(commandId(2), 0),
    { kind: "settle", id: commandId(2), state: "rejected" },
    { kind: "bind", id: commandId(2), token: tokenId(3) },
    admit(commandId(4), 1),
    { kind: "bind", id: commandId(4), token: tokenId(0) },
    admit(commandId(5), 0),
    {
      kind: "race",
      left: { kind: "bind", id: commandId(5), token: tokenId(5) },
      right: { kind: "bind", id: commandId(5), token: tokenId(6) }
    },
    { kind: "reopen" }
  ]
  for (let index = 0; index < count; index++) {
    if (index > 0 && index % 37 === 0) history.push({ kind: "reopen" })
    switch (next(8)) {
      case 0:
        history.push({ kind: "poll", runtime: next(2) as 0 | 1 })
        break
      case 1:
        history.push({ kind: "lookup", id: commandId(next(24)) })
        break
      case 2:
        history.push({ kind: "race", left: mutation(), right: mutation() })
        break
      default:
        history.push(mutation())
    }
  }
  return history
}

const execute = (runtime: Service, operation: Mutation, runs: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const action = operation.kind === "admit" ?
      runtime.admitSignal(operation.id, runs[operation.run] ?? "absent-run", operation.signal)
      : operation.kind === "bind" ?
      runtime.bindSignal(operation.id, operation.token)
      : runtime.settleSignal(operation.id, operation.state)
    const exit = yield* Effect.exit(action)
    if (Exit.isSuccess(exit)) return ok(typeof exit.value === "string" ? exit.value : null)
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    if (error instanceof RunNotFound) return { ok: false, error: "missing-run" } as const
    if (error instanceof PersistenceError && operation.kind === "bind") {
      return { ok: false, error: "missing-command" } as const
    }
    return yield* Effect.failCause(exit.cause)
  })

const same = isDeepStrictEqual
const snapshot = (runtime: Service, ids: ReadonlyArray<string>) =>
  Effect.forEach(ids, (id) => runtime.signalCommand(id), { concurrency: 1 })

const checkSnapshot = (runtime: Service, model: Model, extra: ReadonlyArray<string> = []) =>
  Effect.gen(function*() {
    const ids = [...new Set([...model.keys(), ...extra])].sort()
    const actual = yield* snapshot(runtime, ids)
    expect(actual).toEqual(ids.map((id) => model.get(id)))
    const bound = actual.flatMap((row) => row?.token == null ? [] : [row.token])
    expect(new Set(bound).size).toBe(bound.length)
  })

/** Assert bounded eventual coverage, independently of either cursor algorithm. */
const checkPending = (runtime: Service, model: Model) =>
  Effect.gen(function*() {
    const pending = Array.from(model.values()).filter((row) => row.state === "pending")
    const seen = new Set<string>()
    for (let page = 0; page < Math.ceil(pending.length / 100) + 1; page++) {
      const rows = yield* runtime.pendingSignals
      expect(rows.length).toBeLessThanOrEqual(100)
      expect(new Set(rows.map((row) => row.commandId)).size).toBe(rows.length)
      for (const row of rows) {
        expect(row.state).toBe("pending")
        expect(row).toEqual(model.get(row.commandId))
        seen.add(row.commandId)
      }
    }
    expect([...seen].sort()).toEqual(pending.map((row) => row.commandId).sort())
  })

const withPair = <A, E>(filename: string, body: (runtimes: readonly [Service, Service]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    // Distinct layer instances construct distinct database connections, durable
    // writers, runtime owners and pagination state over the same on-disk rows.
    const first = yield* Layer.build(durable({ database: fileBundle(filename) }))
    const second = yield* Layer.build(durable({ database: fileBundle(filename) }))
    return yield* body([Context.get(first, ControlRuntime), Context.get(second, ControlRuntime)])
  })))

const launch = (runtime: Service, ordinal: number) =>
  Effect.gen(function*() {
    const { card } = yield* runtime.plan({ flowId: "system/test", input: { ordinal } })
    const approval = yield* runtime.lookupApproval(card.approval.target)
    yield* runtime.resolveApproval(approval, "approved", yield* runtime.stampPrincipal())
    const result = yield* runtime.launch(card.planId, card.digest, card.envelope)
    if (result._tag !== "Started") return yield* Effect.die("expected launch")
    return result.run.runId
  })

const apply = (
  runtimes: readonly [Service, Service],
  before: Model,
  operation: Exclude<Operation, { kind: "reopen" }>,
  runs: ReadonlyArray<string>,
  index: number
) =>
  Effect.gen(function*() {
    const runtime = runtimes[index % 2]!
    if (operation.kind === "lookup") {
      expect(yield* runtime.signalCommand(operation.id)).toEqual(before.get(operation.id))
      return before
    }
    if (operation.kind === "poll") {
      yield* checkPending(runtimes[operation.runtime], before)
      return before
    }
    if (operation.kind !== "race") {
      const expected = transition(before, operation, runs)
      expect(yield* execute(runtime, operation, runs)).toEqual(expected.outcome)
      yield* checkSnapshot(runtimes[(index + 1) % 2]!, expected.model, [operation.id])
      return expected.model
    }
    // A two-command race must match one of the two legal serial histories. The
    // oracle does not choose a winner or copy the implementation's final state.
    const actual = yield* Effect.all([
      execute(runtimes[0], operation.left, runs),
      execute(runtimes[1], operation.right, runs)
    ], { concurrency: 2 })
    const candidates = [[operation.left, operation.right], [operation.right, operation.left]].map((order, reversed) => {
      const first = transition(before, order[0]!, runs)
      const second = transition(first.model, order[1]!, runs)
      return {
        model: second.model,
        outcomes: reversed === 0 ? [first.outcome, second.outcome] : [second.outcome, first.outcome]
      }
    })
    const ids = [...new Set([...before.keys(), operation.left.id, operation.right.id])].sort()
    const rows = yield* snapshot(runtime, ids)
    const legal = candidates.find((candidate) =>
      same(candidate.outcomes, actual) && same(ids.map((id) => candidate.model.get(id)), rows)
    )
    expect(legal, `race must have a legal serialization: ${JSON.stringify(operation)}`).toBeDefined()
    if (legal === undefined) return yield* Effect.die("non-linearizable signal race")
    yield* checkSnapshot(runtimes[(index + 1) % 2]!, legal.model, ids)
    return legal.model
  })

const artifact = (seed: number, value: unknown) => {
  if (artifactDirectory === undefined) return
  mkdirSync(artifactDirectory, { recursive: true })
  writeFileSync(join(artifactDirectory, `signal-inbox-${seed}.json`), `${JSON.stringify(value, null, 2)}\n`)
}

describe("generated durable signal inbox histories", () => {
  it("admits only the winning Control.signal payload across independent control stacks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "signal-control-race-"))
    const filename = join(directory, "control.sqlite")
    const delivered: Array<ControlExecutor.Signal> = []
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const conflictSeen = yield* Deferred.make<void>()
        const allowDelivery = yield* Deferred.make<void>()
        const runtimes: Array<Service> = []
        const executor = (index: number): ControlExecutor.Service => ({
          ...ControlExecutor.makeNoop(),
          deliverSignal: (command) =>
            Effect.gen(function*() {
              // The executor must observe the committed admission, even while
              // the competing API request has not returned its Conflict receipt.
              expect(command.commandId).toBeDefined()
              const stored = yield* runtimes[index]!.signalCommand(command.commandId!)
              expect(stored).toMatchObject({ signal: command.signal, state: "pending" })
              delivered.push(copy(command))
              yield* Deferred.await(allowDelivery)
              return "delivered" as const
            })
        })
        const first = yield* Layer.build(durable({ database: fileBundle(filename), executor: executor(0) }))
        const second = yield* Layer.build(durable({ database: fileBundle(filename), executor: executor(1) }))
        runtimes.push(Context.get(first, ControlRuntime), Context.get(second, ControlRuntime))
        const controls = [Context.get(first, Control), Context.get(second, Control)]
        const runId = yield* launch(runtimes[0]!, 0)
        const signals = [{ name: "ready", payload: { choice: "first" } }, {
          name: "ready",
          payload: { choice: "second" }
        }]
        const fibers = yield* Effect.forEach(controls, (control, index) =>
          control.signal({
            runId,
            signal: signals[index]!,
            idempotencyKey: "competing-signal"
          }).pipe(
            Effect.tap((receipt) =>
              receipt._tag === "Conflict" ? Deferred.succeed(conflictSeen, undefined) : Effect.void
            ),
            Effect.forkChild
          ))
        yield* Deferred.await(conflictSeen)
        expect(delivered).toHaveLength(1)
        yield* Deferred.succeed(allowDelivery, undefined)
        const receipts = yield* Effect.forEach(fibers, Fiber.join)
        expect(receipts.map((receipt) => receipt._tag).sort()).toEqual(["Accepted", "Conflict"])
        const winner = receipts.findIndex((receipt) => receipt._tag === "Accepted")
        expect(delivered[0]!.signal).toEqual(signals[winner])
        expect(yield* controls[1]!.signal({ runId, signal: signals[winner]!, idempotencyKey: "competing-signal" }))
          .toMatchObject({ _tag: "AlreadyApplied" })
        expect(delivered).toHaveLength(1)
        expect(yield* runtimes[0]!.pendingSignals).toEqual([])
        return { commandId: delivered[0]!.commandId!, signal: signals[winner]! }
      })))
      await withPair(filename, (runtimes) =>
        Effect.gen(function*() {
          expect(yield* runtimes[1].signalCommand(result.commandId)).toMatchObject({
            state: "delivered",
            signal: result.signal
          })
          expect(yield* runtimes[0].pendingSignals).toEqual([])
        }))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
    const seed = (baseSeed + Math.imul(caseIndex, 0x9e3779b9)) >>> 0
    it(`matches the independent command model across two runtimes and reopen (seed ${seed})`, async () => {
      const directory = mkdtempSync(join(tmpdir(), `signal-model-${seed}-`))
      const filename = join(directory, "control.sqlite")
      const history = generate(seed, steps)
      let model: Model = new Map()
      let nextOperation = 0
      let reopenCount = 0
      try {
        const runs = await withPair(filename, ([first]) => Effect.all([launch(first, 0), launch(first, 1)]))
        while (nextOperation < history.length) {
          await withPair(filename, (runtimes) =>
            Effect.gen(function*() {
              yield* checkSnapshot(runtimes[0], model)
              yield* checkSnapshot(runtimes[1], model)
              while (nextOperation < history.length) {
                const index = nextOperation++
                const operation = history[index]!
                if (operation.kind === "reopen") {
                  reopenCount++
                  break
                }
                model = yield* apply(runtimes, model, operation, runs, index)
              }
              yield* checkPending(runtimes[0], model)
              yield* checkPending(runtimes[1], model)
            }))
        }
        await withPair(filename, (runtimes) =>
          Effect.gen(function*() {
            yield* checkSnapshot(runtimes[0], model)
            yield* checkPending(runtimes[1], model)
          }))
        expect(reopenCount).toBeGreaterThan(0)
        artifact(seed, { status: "passed", seed, steps, history, reopenCount, finalState: [...model.values()] })
      } catch (cause) {
        artifact(seed, { status: "failed", seed, steps, nextOperation, history, cause: String(cause) })
        throw new Error(
          `Signal inbox model failed. Replay: SMITHERS_FUZZ_SEED=${seed} SMITHERS_FUZZ_CASES=1 SMITHERS_FUZZ_STEPS=${steps}. Operation ${
            nextOperation - 1
          }; history=${JSON.stringify(history.slice(0, nextOperation))}`,
          { cause }
        )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }

  // This aggregate durability journey makes 4,093 write calls and opens eight
  // independent pairs of connections. Under coverage and shared-runner load,
  // the prior minute expired after 2,205 writes in the fifth cohort. Keep every
  // history and page oracle with a finite three-minute budget for this case;
  // the rest of the suite retains its normal timeout.
  it("bounds pages and preserves pending fairness through long terminal history and repeated reopen", async ({
    onTestFailed
  }) => {
    const directory = mkdtempSync(join(tmpdir(), "signal-inbox-history-"))
    const filename = join(directory, "control.sqlite")
    let model: Model = new Map()
    let phase = "launch"
    let completedWrites = 0
    onTestFailed(() => {
      console.error("Signal inbox history progress", { phase, completedWrites, modelRows: model.size })
    })
    try {
      const runs = await withPair(filename, ([first]) => Effect.all([launch(first, 0), launch(first, 1)]))
      // Five cohorts cover the 99/100/101 page edge and leave 512 pending rows
      // mixed among 1,023 terminal rows. Every cohort closes both connections.
      for (let batch = 0; batch < 5; batch++) {
        phase = `cohort ${batch + 1}/5`
        await withPair(filename, (runtimes) =>
          Effect.gen(function*() {
            for (let index = batch * 307; index < Math.min((batch + 1) * 307, 1535); index++) {
              const operation: Mutation = {
                kind: "admit",
                id: `history-${index}`,
                run: index % 2,
                signal: { name: "ready", payload: index }
              }
              yield* runtimes[index % 2]!.admitSignal(operation.id, runs[operation.run]!, operation.signal)
              completedWrites++
              model = transition(model, operation, runs).model
              if (index % 3 !== 0) {
                const settle: Mutation = {
                  kind: "settle",
                  id: operation.id,
                  state: index % 2 === 0 ? "rejected" : "delivered"
                }
                yield* runtimes[(index + 1) % 2]!.settleSignal(settle.id, settle.state)
                completedWrites++
                model = transition(model, settle, runs).model
              }
            }
            yield* checkPending(runtimes[0], model)
            yield* checkPending(runtimes[1], model)
          }))
      }
      await withPair(filename, (runtimes) =>
        Effect.gen(function*() {
          phase = "snapshot before final settlement"
          yield* checkSnapshot(runtimes[0], model)
          yield* checkPending(runtimes[1], model)
          phase = "final settlement"
          for (const row of model.values()) {
            yield* runtimes[0].settleSignal(row.commandId, "terminal")
            completedWrites++
            model = transition(model, { kind: "settle", id: row.commandId, state: "terminal" }, runs).model
          }
          phase = "final snapshot"
          yield* checkPending(runtimes[0], model)
          yield* checkSnapshot(runtimes[1], model)
        }))
      phase = "final reopen"
      await withPair(filename, (runtimes) => checkPending(runtimes[0], model))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
