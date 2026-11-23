/**
 * Deep properties of the flow package's identity, retry and authority rules.
 *
 * Each case states a law and checks it against generated input: a reference
 * model, an algebraic identity, or an injectivity claim. Adversarial text is
 * built from a fixed fragment pool (NUL, control characters, combining marks,
 * astral code points, separators and path traversal), so every run is
 * reproducible from `EFFECT_FUZZ_SEED`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Capability, CapabilitySet } from "@smthrs/capability"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import {
  Arbitrary,
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Random,
  Redacted,
  Schema
} from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Action, Flow, Graph, Interpreter, RetryPolicy, StepIdentity } from "../src/index.ts"
import { layerWired, makeMemoryState } from "./MemoryFlowRuntime.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number; readonly execution?: Fuzz.Execution }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (value) => predicate(value).pipe(Effect.provide(silentLogger)), options)
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** Text no naive encoder survives: NUL, controls, bidi, combining marks, astral pairs, separators, traversal. */
const Fragment = Schema.Literals([
  "a",
  "b",
  "Z",
  "0",
  "1",
  "/",
  ":",
  "#",
  ",",
  "../",
  "\\",
  "\"",
  "[",
  "{",
  " ",
  "\n",
  "\t",
  "\0",
  "\u0001",
  "\u001f",
  "\u007f",
  "é",
  "é",
  "\u{1f600}",
  "‮",
  "﻿"
])
const Fragments = Schema.Array(Fragment).check(Schema.isMaxLength(6))
const text = (parts: ReadonlyArray<string>): string => parts.join("")
const SmallInt = Schema.Int.check(Schema.isBetween({ minimum: -40, maximum: 40 }))

/** An index into `pool`: a schema literal cannot hold `NaN` or `Infinity`, an index can name either. */
const indexOf = (pool: ReadonlyArray<unknown>) =>
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: pool.length - 1 }))

/** Yields the scheduler until `done` holds, for at most `turns` turns. */
const settle = (done: () => boolean, turns = 400) =>
  Effect.gen(function*() {
    for (let turn = 0; turn < turns && !done(); turn++) yield* Effect.yieldNow
  })

describe("Flow.make", () => {
  const deadlines = [-5, 0, 1, 2500, 9007199254740991, 9007199254740994, Infinity]

  it("keeps its tag and metadata verbatim and refuses blank tags and out-of-range limits", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        tag: Fragments,
        otherTag: Fragments,
        description: Schema.optional(Fragments),
        capabilities: Schema.optional(
          Schema.Array(Schema.Literals(["fs:read:src/**", "*", "fs:read", "net:get:**", ""])).check(
            Schema.isMaxLength(3)
          )
        ),
        modelInvocable: Schema.optional(Schema.Boolean),
        maxRounds: Schema.optional(Schema.Literals([-1, 0, 1, 1.5, 7, 9007199254740991, 9007199254740992])),
        deadline: Schema.optional(indexOf(deadlines)),
        n: SmallInt,
        label: Fragments
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const tag = text(v.tag)
          const deadlineMs = v.deadline === undefined ? undefined : deadlines[v.deadline]!
          const description = v.description === undefined ? undefined : text(v.description)
          const build = (name: string) =>
            Flow.make(name, {
              payload: { n: Schema.NumberFromString, label: Schema.String },
              success: Schema.Number,
              description,
              capabilities: v.capabilities,
              modelInvocable: v.modelInvocable,
              maxRounds: v.maxRounds,
              deadline: deadlineMs,
              body: ({ n }) => Node.succeed(n)
            })

          const roundsValid = v.maxRounds === undefined || (Number.isSafeInteger(v.maxRounds) && v.maxRounds >= 1)
          const deadlineValid = deadlineMs === undefined ||
            (Number.isFinite(deadlineMs) && deadlineMs > 0 && deadlineMs <= Number.MAX_SAFE_INTEGER)
          if (tag.trim().length === 0) {
            expect(() => build(tag)).toThrow(TypeError)
            return true
          }
          if (!roundsValid || !deadlineValid) {
            expect(() => build(tag)).toThrow(RangeError)
            return true
          }

          const flow = build(tag)
          expect(flow._tag).toBe(tag)
          expect(Flow.isFlow(flow)).toBe(true)
          expect(Flow.isFlow({ ...flow })).toBe(false)
          expect(Flow.isFlow({ _tag: tag, payloadSchema: flow.payloadSchema })).toBe(false)
          expect(flow.description).toBe(description)
          expect(flow.maxRounds).toBe(v.maxRounds)
          expect(flow.deadline === undefined ? undefined : Duration.toMillis(flow.deadline)).toBe(deadlineMs)
          expect(Flow.capabilityCeilings(flow.annotations)).toEqual(
            v.capabilities === undefined ? [] : [v.capabilities]
          )
          expect(Context.get(flow.annotations, Flow.ModelInvocable)).toBe(v.modelInvocable ?? true)

          // Annotating returns a new flow and leaves the declaration it came from untouched.
          const annotated = flow.annotate(Flow.ModelInvocable, false)
          expect(annotated._tag).toBe(tag)
          expect(Flow.isFlow(annotated)).toBe(true)
          expect(Context.get(annotated.annotations, Flow.ModelInvocable)).toBe(false)
          expect(Context.get(flow.annotations, Flow.ModelInvocable)).toBe(v.modelInvocable ?? true)

          // The payload schema is the declared struct: its codec round-trips.
          const payload = { n: v.n, label: text(v.label) }
          const encoded = yield* Schema.encodeEffect(flow.payloadSchema)(payload)
          expect(encoded).toEqual({ n: String(v.n), label: payload.label })
          expect(yield* Schema.decodeEffect(flow.payloadSchema)(encoded)).toEqual(payload)
          expect(Graph.diagnostics(Graph.build(flow, payload))).toEqual([])

          // A derived execution id is a function of exactly (tag, payload).
          const id = yield* Flow.derived.mint(flow, payload)
          expect(yield* Flow.derived.mint(build(tag), { label: payload.label, n: v.n })).toBe(id)
          expect(yield* Flow.derived.mint(flow, { ...payload, label: `${payload.label}\0` })).not.toBe(id)
          const otherTag = text(v.otherTag)
          if (otherTag.trim().length > 0) {
            expect((yield* Flow.derived.mint(build(otherTag), payload)) === id).toBe(otherTag === tag)
          }
          return true
        }).pipe(Effect.provide(NodeCrypto.layer)),
      { seed, executions: pureExecutions }
    )
  })
})

describe("Flow.payloadPreimage", () => {
  const Deep = Schema.Struct({
    label: Schema.String,
    tags: Schema.ReadonlySet(Schema.String),
    owners: Schema.ReadonlyMap(Schema.String, Schema.Number),
    nested: Schema.Array(
      Schema.Struct({
        ids: Schema.ReadonlySet(Schema.Number),
        by: Schema.ReadonlyMap(Schema.String, Schema.ReadonlySet(Schema.String))
      })
    )
  })
  const DeepFlow = Flow.make("deep/preimage/collections", {
    payload: Deep,
    body: () => Node.succeed(undefined)
  })

  it("gives equal collections one identity whatever their insertion and key order", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        label: Fragments,
        tags: Schema.Array(Fragments).check(Schema.isMaxLength(5)),
        owners: Schema.Array(Schema.Struct({ key: Fragments, value: SmallInt })).check(Schema.isMaxLength(5)),
        nested: Schema.Array(
          Schema.Struct({
            ids: Schema.Array(SmallInt).check(Schema.isMaxLength(4)),
            by: Schema.Array(Schema.Struct({ key: Fragments, members: Schema.Array(Fragments) })).check(
              Schema.isMaxLength(3)
            )
          })
        ).check(Schema.isMaxLength(3)),
        rotate: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          // A map keeps the last value written under a key, so the model does too before it is permuted.
          const owners = [...new Map(v.owners.map(({ key, value }) => [text(key), value]))]
          const nested = v.nested.map(({ by, ids }) => ({
            ids,
            by: [...new Map(by.map(({ key, members }) => [text(key), members.map(text)]))]
          }))
          const permute = <T>(items: ReadonlyArray<T>): Array<T> => {
            const cut = items.length === 0 ? 0 : v.rotate % items.length
            return [...items.slice(cut), ...items.slice(0, cut)].reverse()
          }
          const written = {
            label: text(v.label),
            tags: new Set(v.tags.map(text)),
            owners: new Map(owners),
            nested: nested.map(({ by, ids }) => ({
              ids: new Set(ids),
              by: new Map(by.map(([key, members]) => [key, new Set(members)]))
            }))
          }
          const permuted = {
            nested: nested.map(({ by, ids }) => ({
              by: new Map(permute(by).map(([key, members]) => [key, new Set(permute(members))])),
              ids: new Set(permute(ids))
            })),
            owners: new Map(permute(owners)),
            tags: new Set(permute(v.tags.map(text))),
            label: written.label
          }

          const left = yield* Flow.payloadPreimage(Deep, written)
          const right = yield* Flow.payloadPreimage(Deep, permuted)
          expect(JSON.stringify(left)).toBe(JSON.stringify(right))
          expect(yield* Flow.payloadPreimage(Deep, written)).toEqual(left)

          // The preimage is the tagged snapshot, and the snapshot decodes to the value it was taken of.
          const snapshot = yield* Flow.payloadSnapshot(Deep, written)
          expect(left).toEqual(["snapshot", snapshot])
          const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(Deep))(snapshot)
          expect(decoded.label).toBe(written.label)
          expect(decoded.tags).toEqual(written.tags)
          expect(decoded.owners).toEqual(written.owners)
          expect(decoded.nested).toEqual(written.nested)
          expect(yield* Flow.payloadSnapshot(Deep, decoded)).toEqual(snapshot)

          // No element is merged or dropped: canonically equivalent text stays distinct.
          const shape = snapshot as unknown as {
            readonly tags: ReadonlyArray<string>
            readonly owners: ReadonlyArray<unknown>
          }
          expect(shape.tags.length).toBe(written.tags.size)
          expect(shape.owners.length).toBe(written.owners.size)

          // Identity follows the collection's contents and nothing else.
          const id = yield* Flow.derived.mint(DeepFlow, written)
          expect(yield* Flow.derived.mint(DeepFlow, permuted)).toBe(id)
          expect(yield* Interpreter.childExecutionId("parent", "node", DeepFlow._tag, right)).toBe(
            yield* Interpreter.childExecutionId("parent", "node", DeepFlow._tag, left)
          )
          const fresh = `${[...written.tags].join("")}\0+`
          const grown = { ...written, tags: new Set([...written.tags, fresh]) }
          expect(yield* Flow.derived.mint(DeepFlow, grown)).not.toBe(id)
          expect(JSON.stringify(yield* Flow.payloadPreimage(Deep, grown))).not.toBe(JSON.stringify(left))
          return true
        }).pipe(Effect.provide(NodeCrypto.layer)),
      { seed: seed + 1, executions: pureExecutions }
    )
  })

  it("keeps a collection-free payload as written, and hashes it by content", async () => {
    const Plain = Schema.Struct({
      label: Schema.String,
      count: Schema.Number,
      items: Schema.Array(Schema.Struct({ name: Schema.String, on: Schema.Boolean }))
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        label: Fragments,
        other: Fragments,
        count: SmallInt,
        items: Schema.Array(Schema.Struct({ name: Fragments, on: Schema.Boolean })).check(Schema.isMaxLength(4))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const items = v.items.map(({ name, on }) => ({ name: text(name), on }))
          const value = { label: text(v.label), count: v.count, items }
          const reordered = { items: items.map(({ name, on }) => ({ on, name })), count: v.count, label: value.label }
          // Returned by reference: no copy, no re-encoding, so released ids cannot move.
          expect(yield* Flow.payloadPreimage(Plain, value)).toBe(value)
          expect(yield* Flow.payloadPreimage(Plain, reordered)).toBe(reordered)

          const child = (payload: unknown) => Interpreter.childExecutionId("parent", "node", "callee", payload)
          const id = yield* child(value)
          expect(id).toMatch(/^[0-9a-f]{64}$/)
          expect(yield* child(reordered)).toBe(id)
          const other = { ...value, label: text(v.other) }
          expect((yield* child(other)) === id).toBe(other.label === value.label)
          expect(yield* child({ ...value, items: [...items, { name: "", on: false }] })).not.toBe(id)
          return true
        }).pipe(Effect.provide(NodeCrypto.layer)),
      { seed: seed + 2, executions: pureExecutions }
    )
  })

  it("derives hash-only identities from redacted payloads and records no secret", async () => {
    const Secret = Schema.Struct({
      token: Schema.Redacted(Schema.String),
      list: Schema.Array(Schema.Redacted(Schema.String)),
      tags: Schema.ReadonlySet(Schema.String),
      note: Schema.String
    })
    const Use = Action.make("deep/redacted/use", { payload: { size: Schema.Number }, success: Schema.Number })
    const Child = Flow.make("deep/redacted/child", {
      payload: { token: Schema.Redacted(Schema.String) },
      success: Schema.Number,
      body: ({ token }) => Use.call({ size: Redacted.value(token).length })
    })
    const parentOf = (throughChild: boolean) =>
      Flow.make("deep/redacted/parent", {
        payload: Secret,
        success: Schema.Number,
        body: ({ tags, token }) =>
          throughChild
            ? Node.all({ own: Use.call({ size: tags.size }), child: Child.child({ token }) }).pipe(
              Node.map(({ child, own }) => own + child)
            )
            : Use.call({ size: tags.size + Redacted.value(token).length })
      })
    const arb = Arbitrary.schema(
      Schema.Struct({
        secret: Fragments,
        otherSecret: Fragments,
        list: Schema.Array(Fragments).check(Schema.isMaxLength(3)),
        tags: Schema.Array(Schema.Literals(["x", "y", "z"])).check(Schema.isMaxLength(3)),
        note: Schema.Literals(["", "note", "n\0te"]),
        throughChild: Schema.Boolean,
        runId: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          // A marker no digest, tag or node id can spell by accident.
          const secret = `SECRET<${text(v.secret)}>`
          const listed = v.list.map((parts) => `LISTED<${text(parts)}>`)
          const payloadOf = (token: string, tags: ReadonlyArray<string>) => ({
            token: Redacted.make(token),
            list: listed.map((item) => Redacted.make(item)),
            tags: new Set(tags),
            note: v.note
          })
          const payload = payloadOf(secret, v.tags)
          const Parent = parentOf(v.throughChild)

          // A redacted payload never hashes as written, with or without a collection beside it.
          const preimage = yield* Flow.payloadPreimage(Secret, payload)
          expect(Array.isArray(preimage) && preimage[0]).toBe("snapshot")
          const bare = Schema.Struct({ token: Schema.Redacted(Schema.String) })
          const barePreimage = yield* Flow.payloadPreimage(bare, { token: Redacted.make(secret) })
          expect(Array.isArray(barePreimage) && barePreimage[0]).toBe("snapshot")

          // Equal secrets share an identity; distinct secrets never do; set order is irrelevant.
          const again = yield* Flow.payloadPreimage(Secret, payloadOf(secret, [...v.tags].reverse()))
          expect(JSON.stringify(again)).toBe(JSON.stringify(preimage))
          const otherSecret = `SECRET<${text(v.otherSecret)}>`
          const other = yield* Flow.payloadPreimage(Secret, payloadOf(otherSecret, v.tags))
          expect(JSON.stringify(other) === JSON.stringify(preimage)).toBe(otherSecret === secret)

          // What leaves the preimage is a fixed-width digest that spells none of it.
          const childId = yield* Interpreter.childExecutionId("parent", "node", Child._tag, preimage)
          const otherChildId = yield* Interpreter.childExecutionId("parent", "node", Child._tag, other)
          const derivedId = yield* Flow.derived.mint(Parent, payload)
          expect(childId).toMatch(/^[0-9a-f]{64}$/)
          expect(childId === otherChildId).toBe(otherSecret === secret)

          // A real run: the parent's plan hashes the payload, the child's id derives from it.
          const state = makeMemoryState()
          const executionId = `redacted-${v.runId}`
          const exit = yield* Parent.execute(payload, { executionId }).pipe(
            Effect.exit,
            Effect.provide(
              layerWired(
                Layer.mergeAll(
                  Use.toLayer(({ size }) => Effect.succeed(size)),
                  Interpreter.layer(Child),
                  Interpreter.layer(Parent)
                ),
                state
              )
            )
          )
          // A run that settles computed on the secret itself, never on a redaction of it. An authored
          // child payload is mirrored to JSON by the plan, so a secret handed to `.child()` is refused
          // instead: that refusal, like every record, must not spell the secret either.
          if (Exit.isSuccess(exit)) expect(exit.value).toBe(payload.tags.size + secret.length)
          else expect(v.throughChild).toBe(true)
          expect(state.nodeRecords.length).toBeGreaterThan(0)

          const serialized = JSON.stringify({
            ids: [childId, otherChildId, derivedId],
            exit: Exit.isFailure(exit) ? [String(exit.cause), Cause.pretty(exit.cause), exit.cause] : [],
            records: state.nodeRecords,
            actions: [...state.actions],
            deferred: [...state.deferredResults]
          })
          expect(serialized).not.toContain("SECRET<")
          expect(serialized).not.toContain("LISTED<")
          for (const escaped of [secret, ...listed].map((item) => JSON.stringify(item).slice(1, -1))) {
            expect(serialized).not.toContain(escaped)
          }
          return true
        }).pipe(Effect.provide(NodeCrypto.layer)),
      { seed: seed + 3, executions: ioExecutions }
    )
  })
})

describe("RetryPolicy", () => {
  const Policy = Schema.Struct({
    initialMs: Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 5000 })),
    factor: Schema.Finite.check(Schema.isBetween({ minimum: 0.25, maximum: 4 })),
    headroomMs: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
    maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
    jitterRatio: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    expirationMs: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 100_000 }))
  })
  const Unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
  const Attempt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 40 }))
  const outsideUnit = [-0.001, 1.001, -1, 2, Number.NaN, Infinity]
  const badAttempts = [0, -1, 1.5, Number.NaN, Infinity, 9007199254740992]
  const badElapsed = [-1, Number.NaN, Infinity]
  const badHints: ReadonlyArray<unknown> = [-1, Number.NaN, Infinity, "5", null]
  const some = (option: Option.Option<number>): number => {
    if (Option.isNone(option)) throw new Error("expected a delay")
    return option.value
  }

  it("backs off monotonically under its cap and jitters only inside the declared band", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        policy: Policy,
        attempt: Attempt,
        low: Unit,
        high: Unit,
        outside: indexOf(outsideUnit),
        badAttempt: indexOf(badAttempts),
        seedText: Schema.Literals(["s1", "s2", "s3", "s4"])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const { factor, initialMs, jitterRatio } = v.policy
          const outside = outsideUnit[v.outside]!
          const badAttempt = badAttempts[v.badAttempt]!
          const maxMs = initialMs + v.policy.headroomMs
          const plain = RetryPolicy.make({ initialMs, factor, maxMs })
          const base = (attempt: number) => some(RetryPolicy.nextDelay(plain, attempt))

          // The closed form, positive and capped.
          const now = base(v.attempt)
          const next = base(v.attempt + 1)
          expect(now).toBe(Math.min(initialMs * Math.pow(factor, v.attempt - 1), maxMs))
          expect(now).toBeGreaterThan(0)
          expect(now).toBeLessThanOrEqual(maxMs)
          expect(base(1)).toBe(initialMs)
          // Monotone in the attempt, in the direction the factor points.
          if (factor >= 1) {
            expect(next).toBeGreaterThanOrEqual(now)
            expect(now).toBeGreaterThanOrEqual(initialMs)
          }
          if (factor <= 1) {
            expect(next).toBeLessThanOrEqual(now)
            expect(now).toBeLessThanOrEqual(initialMs)
          }
          // An unjittered policy never reads the sample, valid or not.
          expect(RetryPolicy.nextDelay(plain, v.attempt, { random: outside })).toEqual(Option.some(now))
          expect(RetryPolicy.nextDelay(plain, badAttempt)).toEqual(Option.none())
          expect(RetryPolicy.decide(plain, { attempt: badAttempt, error: "x" })).toEqual(
            RetryPolicy.giveUp("exhausted")
          )

          // Jitter spreads only the final `jitterRatio` of the delay, and never past the delay.
          const jittery = RetryPolicy.make({ initialMs, factor, maxMs, jitterRatio })
          const [low, high] = v.low <= v.high ? [v.low, v.high] : [v.high, v.low]
          const atLow = some(RetryPolicy.nextDelay(jittery, v.attempt, { random: low }))
          const atHigh = some(RetryPolicy.nextDelay(jittery, v.attempt, { random: high }))
          expect(atLow).toBeLessThanOrEqual(atHigh)
          for (const delay of [atLow, atHigh]) {
            expect(delay).toBeGreaterThanOrEqual(now * (1 - jitterRatio))
            expect(delay).toBeLessThanOrEqual(now)
            expect(delay).toBeGreaterThanOrEqual(0)
          }
          expect(some(RetryPolicy.nextDelay(jittery, v.attempt, { random: 0 }))).toBe(
            jitterRatio > 0 ? now * (1 - jitterRatio) : now
          )
          const unsampled = some(RetryPolicy.nextDelay(jittery, v.attempt))
          expect(unsampled).toBeLessThanOrEqual(now)
          expect(unsampled).toBeGreaterThanOrEqual(now * (1 - 1e-12))
          // The two jitter terms can round above the delay at a full sample; the cap must still hold.
          for (const ratio of [0.000002, 1e-7, 0.1, 0.3, 0.7, 0.9]) {
            const full = RetryPolicy.nextDelay(
              RetryPolicy.make({ initialMs, factor, maxMs, jitterRatio: ratio }),
              v.attempt,
              {
                random: 1
              }
            )
            expect(some(full)).toBeLessThanOrEqual(now)
          }
          expect(RetryPolicy.nextDelay(jittery, v.attempt, { random: outside })).toEqual(
            jitterRatio > 0 ? Option.none() : Option.some(now)
          )

          // The Effect form samples `Random` once and agrees with the pure form on that sample.
          const sample = yield* Random.next.pipe(Random.withSeed(v.seedText))
          const sampled = yield* RetryPolicy.nextDelayEffect(jittery, v.attempt).pipe(Random.withSeed(v.seedText))
          expect(sampled).toEqual(RetryPolicy.nextDelay(jittery, v.attempt, { random: sample }))
          expect(yield* RetryPolicy.nextDelayEffect(jittery, v.attempt).pipe(Random.withSeed(v.seedText))).toEqual(
            sampled
          )
          const decided = yield* RetryPolicy.decideEffect(jittery, { attempt: v.attempt, error: "x" }).pipe(
            Random.withSeed(v.seedText)
          )
          expect(decided).toEqual(RetryPolicy.retryAfter(some(sampled)))
          return true
        }),
      { seed: seed + 4, executions: pureExecutions }
    )
  })

  it("bounds attempts and expiration, and lets a failure's own delay only lengthen the backoff", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        policy: Policy,
        attempt: Attempt,
        random: Unit,
        elapsedMs: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 120_000 })),
        laterMs: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 20_000 })),
        badElapsed: indexOf(badElapsed),
        hintMs: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 200_000 })),
        badHint: indexOf(badHints)
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          const { expirationMs, factor, initialMs, jitterRatio, maxAttempts } = v.policy
          const maxMs = initialMs + v.policy.headroomMs
          const error = { _tag: "test/Transient" }
          const base = some(RetryPolicy.nextDelay(RetryPolicy.make({ initialMs, factor, maxMs }), v.attempt))

          // `maxAttempts` counts attempts: exactly `maxAttempts - 1` retries, whatever the jitter.
          const counted = RetryPolicy.make({ initialMs, factor, maxMs, maxAttempts, jitterRatio })
          let retries = 0
          for (let attempt = 1; attempt <= 14; attempt++) {
            const delay = RetryPolicy.nextDelay(counted, attempt, { random: v.random })
            expect(Option.isSome(delay)).toBe(attempt < maxAttempts)
            if (Option.isSome(delay)) retries++
          }
          expect(retries).toBe(maxAttempts - 1)
          expect(RetryPolicy.decide(counted, { attempt: maxAttempts, error, random: v.random })).toEqual(
            RetryPolicy.giveUp("exhausted")
          )

          // Expiration: a delay never outlives the window, and time only ever shrinks it.
          const expiring = RetryPolicy.make({ initialMs, factor, maxMs, expirationMs, jitterRatio })
          const at = (elapsedMs: number) => RetryPolicy.nextDelay(expiring, v.attempt, { random: v.random, elapsedMs })
          const earlier = at(v.elapsedMs)
          const later = at(v.elapsedMs + v.laterMs)
          if (Option.isSome(earlier)) {
            expect(earlier.value).toBeGreaterThanOrEqual(0)
            expect(earlier.value).toBeLessThanOrEqual(base)
            expect(earlier.value).toBeLessThanOrEqual(expirationMs - v.elapsedMs)
          }
          if (v.elapsedMs > expirationMs) expect(earlier).toEqual(Option.none())
          if (v.elapsedMs + base <= expirationMs) expect(Option.isSome(earlier)).toBe(true)
          if (Option.isSome(later)) expect(some(earlier)).toBeGreaterThanOrEqual(later.value)
          expect(at(badElapsed[v.badElapsed]!)).toEqual(Option.none())

          // The decision names why it stopped: `expired` only when time, not the policy, ended it.
          const decision = RetryPolicy.decide(expiring, {
            attempt: v.attempt,
            error,
            random: v.random,
            elapsedMs: v.elapsedMs
          })
          expect(decision).toEqual(
            Option.isSome(earlier) ? RetryPolicy.retryAfter(earlier.value) : RetryPolicy.giveUp("expired")
          )
          expect(
            RetryPolicy.decide(expiring, {
              attempt: v.attempt,
              error,
              random: v.random,
              elapsedMs: badElapsed[v.badElapsed]!
            })
          ).toEqual(RetryPolicy.giveUp("exhausted"))

          // A failure's own delay is a floor under the backoff, clamped by the cap and the window.
          const hinted = RetryPolicy.decide(expiring, {
            attempt: v.attempt,
            error: { ...error, retryAfterMillis: v.hintMs },
            random: v.random,
            elapsedMs: v.elapsedMs
          })
          expect(hinted._tag).toBe(decision._tag)
          if (hinted._tag === "RetryAfter" && decision._tag === "RetryAfter") {
            expect(hinted.delayMs).toBeGreaterThanOrEqual(decision.delayMs)
            expect(hinted.delayMs).toBeLessThanOrEqual(maxMs)
            expect(hinted.delayMs).toBeLessThanOrEqual(expirationMs - v.elapsedMs)
            expect(hinted.delayMs).toBe(
              Math.min(Math.max(v.hintMs, decision.delayMs), maxMs, expirationMs - v.elapsedMs)
            )
            if (v.hintMs <= decision.delayMs) expect(hinted.delayMs).toBe(decision.delayMs)
          }
          expect(
            RetryPolicy.decide(expiring, {
              attempt: v.attempt,
              error: { ...error, retryAfterMillis: badHints[v.badHint] },
              random: v.random,
              elapsedMs: v.elapsedMs
            })
          ).toEqual(decision)
          return true
        }),
      { seed: seed + 5, executions: pureExecutions }
    )
  })

  it("validates construction, decoding and use by one rule, and classifies failures before counting", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        policy: Policy,
        attempt: Attempt,
        corruption: Schema.Literals([
          "none",
          "initialMs:0",
          "initialMs:-1",
          "initialMs:NaN",
          "factor:0",
          "factor:Infinity",
          "maxMs:below",
          "maxMs:Infinity",
          "maxAttempts:0",
          "maxAttempts:1.5",
          "expirationMs:0",
          "jitterRatio:-0.1",
          "jitterRatio:1.1",
          "retryable:blankTag",
          "retryable:blankCode"
        ]),
        tag: Schema.Literals(["test/Busy", "test/Fatal", "test/Other", "@smthrs/engine-store/CacheCorruptionDetected"]),
        code: Schema.optional(Schema.Literals(["rate_limited", "bad_request"])),
        nonRetryable: Schema.Array(Schema.Literals(["test/Busy", "test/Fatal"])).check(Schema.isMaxLength(2)),
        retryable: Schema.optional(
          Schema.Array(
            Schema.Struct({
              tag: Schema.Literals(["test/Busy", "test/Fatal"]),
              code: Schema.optional(Schema.Literals(["rate_limited"]))
            })
          ).check(Schema.isMaxLength(2))
        )
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          const { expirationMs, factor, initialMs, jitterRatio, maxAttempts } = v.policy
          const retryable = v.retryable?.map((entry) =>
            entry.code === undefined ? { tag: entry.tag } : { tag: entry.tag, code: entry.code }
          )
          const valid = {
            initialMs,
            factor,
            maxMs: initialMs + v.policy.headroomMs,
            maxAttempts,
            expirationMs,
            // JSON writes negative zero as zero; adding zero keeps the generated ratio's sign out of the round trip.
            jitterRatio: jitterRatio + 0,
            nonRetryable: v.nonRetryable,
            ...(retryable === undefined ? {} : { retryable })
          }
          const corrupt: Record<typeof v.corruption, object> = {
            none: {},
            "initialMs:0": { initialMs: 0 },
            "initialMs:-1": { initialMs: -1 },
            "initialMs:NaN": { initialMs: Number.NaN },
            "factor:0": { factor: 0 },
            "factor:Infinity": { factor: Infinity },
            "maxMs:below": { maxMs: initialMs / 2 },
            "maxMs:Infinity": { maxMs: Infinity },
            "maxAttempts:0": { maxAttempts: 0 },
            "maxAttempts:1.5": { maxAttempts: 1.5 },
            "expirationMs:0": { expirationMs: 0 },
            "jitterRatio:-0.1": { jitterRatio: -0.1 },
            "jitterRatio:1.1": { jitterRatio: 1.1 },
            "retryable:blankTag": { retryable: [{ tag: "" }] },
            "retryable:blankCode": { retryable: [{ tag: "test/Busy", code: "" }] }
          }
          const options = { ...valid, ...corrupt[v.corruption] }
          const error = v.code === undefined ? { _tag: v.tag } : { _tag: v.tag, code: v.code }

          if (v.corruption !== "none") {
            // One rule, three doors: the constructor, the decoder, and a row that skipped both.
            expect(() => RetryPolicy.make(options)).toThrow(RangeError)
            expect(Exit.isFailure(Schema.decodeUnknownExit(RetryPolicy.RetryPolicy)(options))).toBe(true)
            const persisted = options as RetryPolicy.RetryPolicy
            for (const attempt of [1, v.attempt]) {
              expect(RetryPolicy.nextDelay(persisted, attempt, { random: 0.5 })).toEqual(Option.none())
            }
            expect(RetryPolicy.decide(persisted, { attempt: 1, error: { _tag: "test/Other" }, random: 0.5 })._tag)
              .toBe("GiveUp")
            return true
          }

          const policy = RetryPolicy.make(options)
          expect(policy).toEqual(options)
          expect(RetryPolicy.make(policy)).toEqual(policy)
          expect(Object.isFrozen(policy)).toBe(true)
          expect(Object.isFrozen(policy.nonRetryable)).toBe(true)
          // The policy is plain data: it survives a journal round trip unchanged.
          const stored: unknown = JSON.parse(JSON.stringify(Schema.encodeSync(RetryPolicy.RetryPolicy)(policy)))
          expect(Schema.decodeUnknownSync(RetryPolicy.RetryPolicy)(stored)).toEqual(policy)

          // Classification: integrity verdicts and `nonRetryable` win; `retryable` is an allowlist.
          const listed = (retryable ?? []).some((entry) =>
            entry.tag === error._tag && (entry.code === undefined || entry.code === v.code)
          )
          const terminal = RetryPolicy.defaultNonRetryable.includes(v.tag) ||
            v.nonRetryable.some((tag) => tag === v.tag) ||
            (retryable !== undefined && !listed)
          expect(RetryPolicy.isNonRetryable(policy, error)).toBe(terminal)
          const decision = RetryPolicy.decide(policy, { attempt: v.attempt, error, random: 0.5 })
          if (terminal) {
            // A terminal failure never retries, however many attempts remain.
            expect(decision).toEqual(RetryPolicy.giveUp("nonRetryable"))
          } else {
            expect(decision._tag).toBe(v.attempt < maxAttempts ? "RetryAfter" : "GiveUp")
          }
          return true
        }),
      { seed: seed + 6, executions: pureExecutions }
    )
  })

  it("drives Effect.retry on exactly the delays its decisions name", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        initialMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
        factor: Schema.Literals([1, 2, 3]),
        headroomMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 400 })),
        maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        expirationMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1500 }))),
        succeedAt: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 })))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const policy = RetryPolicy.make({
            initialMs: v.initialMs,
            factor: v.factor,
            maxMs: v.initialMs + v.headroomMs,
            maxAttempts: v.maxAttempts,
            expirationMs: v.expirationMs
          })
          const error = { _tag: "test/Dropped" }

          // The model: replay the pure decision over the attempt count and the time since the first failure.
          const expected = [0]
          let outcome: "done" | "failed" = "failed"
          for (let attempt = 1; attempt <= 8; attempt++) {
            if (attempt === v.succeedAt) {
              outcome = "done"
              break
            }
            const decision = RetryPolicy.decide(policy, { attempt, error, elapsedMs: expected[attempt - 1]! })
            if (decision._tag === "GiveUp") break
            expected.push(expected[attempt - 1]! + decision.delayMs)
          }

          const times: Array<number> = []
          const attempted = Effect.gen(function*() {
            times.push(yield* Clock.currentTimeMillis)
            return times.length === v.succeedAt ? "done" as const : yield* Effect.fail(error)
          })
          const fiber = yield* Effect.retry(attempted, RetryPolicy.schedule(policy)).pipe(Effect.exit, Effect.forkChild)
          yield* TestClock.adjust(20_000)
          const exit = yield* Fiber.join(fiber)
          expect(times).toEqual(expected)
          expect(exit).toEqual(outcome === "done" ? Exit.succeed("done") : Exit.fail(error))
          expect(times.length).toBeLessThanOrEqual(v.maxAttempts)
          return true
        }).pipe(Effect.provide(TestClock.layer())),
      { seed: seed + 7, executions: ioExecutions }
    )
  })
})

describe("step identity", () => {
  /** Names built to splice across the scope's own separators and length prefixes. */
  const Splice = Schema.Array(
    Schema.Literals(["a", "b", "/", ":", "s", "c", "g", "1", "2", "7", "action", "internal", "\0", "é", "é"])
  ).check(Schema.isMaxLength(5))
  const Identity = Schema.Struct({
    kind: Schema.Literals(["action", "internal"]),
    name: Splice,
    idempotency: Schema.Union([
      Schema.Struct({ form: Schema.Literal("none") }),
      Schema.Struct({ form: Schema.Literal("string"), value: Splice }),
      Schema.Struct({ form: Schema.Literal("object"), value: Splice, n: Schema.Literals([0, 1]) })
    ]),
    site: Schema.optional(Splice)
  })
  type Identity = typeof Identity.Type

  const identityOf = (input: Identity, flip: boolean): StepIdentity.AllocationIdentity => ({
    kind: input.kind,
    name: text(input.name),
    idempotency: input.idempotency.form === "none"
      ? undefined
      : input.idempotency.form === "string"
      ? text(input.idempotency.value)
      // Key order is not identity: both spellings are one object.
      : flip
      ? { n: input.idempotency.n, body: text(input.idempotency.value) }
      : { body: text(input.idempotency.value), n: input.idempotency.n },
    site: input.site === undefined ? undefined : text(input.site)
  })
  const canonical = (input: Identity): string =>
    JSON.stringify([
      input.kind,
      text(input.name),
      input.idempotency.form,
      input.idempotency.form === "none" ? null : text(input.idempotency.value),
      input.idempotency.form === "object" ? input.idempotency.n : null,
      input.site === undefined ? null : text(input.site)
    ])

  it("derives an injective, order-insensitive allocation scope", async () => {
    await runFuzz(
      Arbitrary.schema(Schema.Struct({ left: Identity, right: Identity })),
      (v) =>
        Effect.gen(function*() {
          const left = yield* StepIdentity.allocationScope(identityOf(v.left, false))
          const right = yield* StepIdentity.allocationScope(identityOf(v.right, false))
          expect(left === right).toBe(canonical(v.left) === canonical(v.right))
          expect(yield* StepIdentity.allocationScope(identityOf(v.left, true))).toBe(left)

          // The splice attack: a name that spells another identity's whole scope. Its length prefix
          // differs, so it aliases that identity only when there was nothing after the name to spell.
          const identity = identityOf(v.left, false)
          const header = `${identity.kind}/${identity.name.length}:`
          expect(left.startsWith(header)).toBe(true)
          const spelled = left.slice(header.length)
          const forged = yield* StepIdentity.allocationScope({ kind: identity.kind, name: spelled })
          expect(forged === left).toBe(spelled === identity.name)
          expect(forged).toBe(`${identity.kind}/${spelled.length}:${spelled}`)

          // The engine folds the scope into the invocation key, so distinct scopes are distinct steps.
          const keyOf = (parentScope: string) =>
            StepIdentity.invocationKey({ runId: "run", parentScope, ordinal: 1, tier: "unsealed" })
          expect((yield* keyOf(left)) === (yield* keyOf(right))).toBe(left === right)
          return true
        }).pipe(Effect.provide(NodeCrypto.layer)),
      { seed: seed + 8, executions: pureExecutions }
    )
  })

  const badOrdinals = [-1, 0.5, Number.NaN, Infinity]

  it("derives invocation and child ids that replay equal and never alias across a field boundary", async () => {
    const Coordinates = Schema.Struct({
      runId: Splice,
      parentScope: Schema.optional(Splice),
      ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
      tier: Schema.Literals(["compensable", "irreversible", "unsealed"])
    })
    const Child = Schema.Struct({
      parent: Splice,
      node: Splice,
      callee: Splice,
      label: Splice,
      n: Schema.Literals([0, 1])
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        left: Coordinates,
        right: Coordinates,
        childLeft: Child,
        childRight: Child,
        badOrdinal: indexOf(badOrdinals)
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const inputOf = (coordinates: typeof Coordinates.Type) => ({
            runId: `r${text(coordinates.runId)}`,
            // An empty scope is not a scope; the model keeps it absent.
            parentScope: coordinates.parentScope === undefined || coordinates.parentScope.length === 0
              ? undefined
              : text(coordinates.parentScope),
            ordinal: coordinates.ordinal,
            tier: coordinates.tier
          })
          const left = inputOf(v.left)
          const right = inputOf(v.right)
          const leftKey = yield* StepIdentity.invocationKey(left)
          const rightKey = yield* StepIdentity.invocationKey(right)
          expect(leftKey === rightKey).toBe(JSON.stringify(left) === JSON.stringify(right))
          // Replay: the same coordinates derive the same key, and an absent scope is an omitted one.
          expect(yield* StepIdentity.invocationKey({ ...left })).toBe(leftKey)
          const { parentScope: _omitted, ...unscoped } = left
          expect(yield* StepIdentity.invocationKey({ ...unscoped, parentScope: undefined })).toBe(
            yield* StepIdentity.invocationKey(unscoped)
          )
          // Coordinates the engine could never have generated are refused, typed.
          for (
            const refused of [
              { ...left, runId: "" },
              { ...left, parentScope: "" },
              { ...left, ordinal: badOrdinals[v.badOrdinal]! }
            ]
          ) {
            const exit = yield* Effect.exit(StepIdentity.invocationKey(refused))
            expect(Exit.isFailure(exit) && Schema.isSchemaError(Cause.squash(exit.cause))).toBe(true)
          }

          const childOf = (child: typeof Child.Type, flip: boolean) =>
            Interpreter.childExecutionId(
              text(child.parent),
              text(child.node),
              text(child.callee),
              flip ? { n: child.n, label: text(child.label) } : { label: text(child.label), n: child.n }
            )
          const childKey = (child: typeof Child.Type) =>
            JSON.stringify([text(child.parent), text(child.node), text(child.callee), text(child.label), child.n])
          const childLeft = yield* childOf(v.childLeft, false)
          expect(childLeft).toMatch(/^[0-9a-f]{64}$/)
          expect(yield* childOf(v.childLeft, true)).toBe(childLeft)
          expect((yield* childOf(v.childRight, false)) === childLeft).toBe(
            childKey(v.childLeft) === childKey(v.childRight)
          )
          return true
        }).pipe(Effect.provide(NodeCrypto.layer)),
      { seed: seed + 9, executions: pureExecutions }
    )
  })

  it("replays a restarted run from its durable record under any interleaving", async () => {
    const Step = Action.make("deep/replay/step", {
      payload: { key: Schema.String, n: Schema.Number },
      success: Schema.Number
    })
    const Inner = Flow.make("deep/replay/inner", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      body: ({ n }) => Step.call({ key: "inner", n })
    })
    const Item = Schema.Struct({ key: Schema.Literals(["a", "b", "c"]), n: SmallInt, nested: Schema.Boolean })
    const Root = Flow.make("deep/replay/root", {
      payload: { items: Schema.Array(Item) },
      success: Schema.Array(Schema.Number),
      body: ({ items }) =>
        Node.all(
          Object.fromEntries(
            items.map((item, index) => [
              `s${index}`,
              item.nested ? Inner.call({ n: item.n }) : Step.call({ key: item.key, n: item.n })
            ])
          )
        ).pipe(Node.map((results) => items.map((_, index) => results[`s${index}`]!)))
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        items: Schema.Array(Item).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
        runId: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const state = makeMemoryState()
          const calls: Array<string> = []
          // One process: its own runtime and registrations over the shared durable record.
          const process = () =>
            Root.execute({ items: v.items }, { executionId: `replay-${v.runId}` }).pipe(
              Effect.provide(
                layerWired(
                  Layer.mergeAll(
                    Step.toLayer(({ key, n }) =>
                      Effect.sync(() => {
                        calls.push(`${key}:${n}`)
                        return n * 2
                      })
                    ),
                    Interpreter.layer(Inner),
                    Interpreter.layer(Root)
                  ),
                  state
                )
              )
            )
          // A step's settlement: who produced it, where, and whether its dispatch ran or replayed.
          const settledOf = () =>
            state.nodeRecords.flatMap(({ record, runId }) =>
              record._tag === "NodeSettled" && record.action === Step.name
                ? [JSON.stringify([runId, record.sourceId, record.nodeId, record.outcome])]
                : []
            ).sort()
          const plansOf = () =>
            state.nodeRecords.flatMap(({ record, runId }) =>
              record._tag === "PlanRecorded" ? [JSON.stringify([runId, record.sourceId, record.digest ?? null])] : []
            ).sort()

          const first = yield* process()
          expect(first).toEqual(v.items.map((item) => item.n * 2))
          expect(calls.length).toBe(v.items.length)
          const firstCalls = [...calls].sort()
          const firstSettled = settledOf()
          expect(firstSettled.length).toBe(v.items.length)
          const firstPlans = plansOf()
          state.nodeRecords.length = 0

          // The restart re-derives every identity, so nothing runs twice and the record is the same record.
          const second = yield* process()
          expect(second).toEqual(first)
          expect([...calls].sort()).toEqual(firstCalls)
          expect(plansOf()).toEqual(firstPlans)
          expect(settledOf()).toEqual(firstSettled.map((settled) => settled.replace("\"built\"", "\"clean\"")))
          expect(firstSettled.every((settled) => settled.includes("\"built\""))).toBe(true)
          return true
        }).pipe(Effect.provide(NodeCrypto.layer)),
      { seed: seed + 10, executions: ioExecutions, execution: FuzzSimulation.execution() }
    )
  })
})

describe("cancellation", () => {
  it("reaches every started step of a nested run exactly once and settles the run as interrupted", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
        width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        waitForStart: Schema.Boolean,
        runId: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const started: Array<number> = []
          const cancelled: Array<number> = []
          const finished: Array<number> = []
          const Leaf = Action.make("deep/cancel/leaf", { payload: { index: Schema.Number }, success: Schema.Number })
          const Fan = Flow.make("deep/cancel/0" as string, {
            payload: { width: Schema.Number },
            success: Schema.Number,
            body: ({ width }) =>
              Node.all(
                Object.fromEntries(Array.from({ length: width }, (_, index) => [`l${index}`, Leaf.call({ index })]))
              ).pipe(Node.map((results) => Object.keys(results).length))
          })
          const levels = [Fan]
          for (let level = 1; level <= v.depth; level++) {
            const below = levels[level - 1]!
            levels.push(Flow.make(`deep/cancel/${level}` as string, {
              payload: { width: Schema.Number },
              success: Schema.Number,
              body: ({ width }) => below.call({ width })
            }))
          }
          const Root = levels[v.depth]!
          const layer = layerWired(
            Layer.mergeAll(
              Leaf.toLayer(({ index }) =>
                Effect.sync(() => started.push(index)).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) cancelled.push(index)
                      else finished.push(index)
                    })
                  )
                )
              ),
              ...levels.map((flow) => Interpreter.layer(flow))
            )
          )

          const executionId = `cancel-${v.runId}`
          yield* Effect.gen(function*() {
            yield* Root.execute({ width: v.width }, { executionId, discard: true })
            if (v.waitForStart) {
              yield* settle(() => started.length === v.width)
              expect([...started].sort()).toEqual(Array.from({ length: v.width }, (_, index) => index))
            }
            yield* Root.interrupt(executionId)
            // Cancelling twice is one cancellation.
            yield* Root.interrupt(executionId)
            let polled = yield* Root.poll(executionId)
            for (let turn = 0; turn < 400 && (Option.isNone(polled) || polled.value._tag !== "Complete"); turn++) {
              yield* Effect.yieldNow
              polled = yield* Root.poll(executionId)
            }
            yield* settle(() => cancelled.length === started.length)

            expect(Option.isSome(polled) && polled.value._tag).toBe("Complete")
            if (Option.isSome(polled) && polled.value._tag === "Complete") {
              const exit = polled.value.exit
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
            }
            // Every step that started was cancelled once; none finished, and none started after the cancel.
            expect([...cancelled].sort()).toEqual([...started].sort())
            expect(finished).toEqual([])
            const startedAtCancel = started.length
            yield* settle(() => false, 40)
            expect(started.length).toBe(startedAtCancel)
          }).pipe(Effect.provide(layer))
          return true
        }).pipe(Effect.provide(NodeCrypto.layer)),
      { seed: seed + 11, executions: ioExecutions }
    )
  })
})

describe("capability requirements", () => {
  const Pattern = Schema.Literals([
    "*",
    "*:src/main.ts",
    "fs:*:src/**",
    "fs:read:**",
    "fs:read:src/**",
    "fs:read:src/main.ts",
    "fs:read:test/*",
    "fs:write:src/main.ts",
    "net:get:**",
    // Invalid: no resource, an unknown action, the empty string. Each grants nothing.
    "fs:read",
    "bogus:op:src/**",
    ""
  ])
  const Group = Schema.Array(Pattern).check(Schema.isMaxLength(3))
  const Groups = Schema.Array(Group).check(Schema.isMaxLength(3))
  const probes = (["fs:read", "fs:write", "net:get", "proc:spawn"] as const).flatMap((action) =>
    ["src/main.ts", "src/a/b.ts", "test/main.ts", "test/a/b.ts", "README.md"].map((resource) =>
      new Capability.Capability({ action, resource })
    )
  )
  /** The reference model: every group must hold a valid pattern that matches. */
  const modelAllows = (groups: ReadonlyArray<ReadonlyArray<string>>, capability: Capability.Capability): boolean =>
    groups.every((group) =>
      group.some((pattern) =>
        Option.match(Capability.parsePattern(pattern), {
          onNone: () => false,
          onSome: (parsed) => Capability.matches(parsed, capability)
        })
      )
    )
  const allows = (groups: ReadonlyArray<ReadonlyArray<string>>, capability: Capability.Capability): boolean =>
    CapabilitySet.allows(CapabilitySet.fromGroups(Flow.parseCapabilityCeilings(groups)), capability)

  it("intersects ceilings as an exact conjunction that never escalates", async () => {
    await runFuzz(
      Arbitrary.schema(Schema.Struct({ left: Groups, right: Groups, third: Groups })),
      (v) =>
        Effect.gen(function*() {
          const both = Flow.intersectCeilings(v.left, v.right)
          const flipped = Flow.intersectCeilings(v.right, v.left)
          const nestedLeft = Flow.intersectCeilings(both, v.third)
          const nestedRight = Flow.intersectCeilings(v.left, Flow.intersectCeilings(v.right, v.third))
          const under = yield* CapabilitySet.current.pipe(
            Flow.attenuateCapabilities(v.right),
            Flow.attenuateCapabilities(v.left)
          )
          const reAttenuated = yield* CapabilitySet.current.pipe(
            Flow.attenuateCapabilities(v.left),
            Flow.attenuateCapabilities(v.left)
          )

          for (const probe of probes) {
            const left = modelAllows(v.left, probe)
            const right = modelAllows(v.right, probe)
            expect(allows(v.left, probe)).toBe(left)
            // Exact conjunction: nothing either side denies is allowed, nothing both allow is lost.
            expect(allows(both, probe)).toBe(left && right)
            expect(allows(flipped, probe)).toBe(left && right)
            expect(allows(nestedLeft, probe)).toBe(left && right && modelAllows(v.third, probe))
            expect(allows(nestedRight, probe)).toBe(allows(nestedLeft, probe))
            // The ambient set under nested declarations is that same conjunction.
            expect(CapabilitySet.allows(under, probe)).toBe(left && right)
            expect(CapabilitySet.allows(reAttenuated, probe)).toBe(left)
            // A proven containment is sound at every probe.
            if (Flow.ceilingWithin(v.left, v.right) && left) expect(right).toBe(true)
          }

          // Lattice laws on the transported form.
          expect(Flow.intersectCeilings(both, both)).toEqual(both)
          expect(Flow.intersectCeilings(both, [])).toEqual(both)
          expect(Flow.ceilingWithin(both, v.left)).toBe(true)
          expect(Flow.ceilingWithin(both, v.right)).toBe(true)
          expect(Flow.ceilingWithin(nestedLeft, both)).toBe(true)
          expect(Flow.ceilingWithin(both, both)).toBe(true)
          // Parsing keeps every group, so an all-invalid group still denies rather than vanishing.
          expect(Flow.parseCapabilityCeilings(v.left).length).toBe(v.left.length)
          return true
        }),
      { seed: seed + 12, executions: pureExecutions }
    )
  })

  it("diagnoses a requirement outside the caller's ceiling and runs the step under every ceiling", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        required: Schema.Array(Pattern).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
        outer: Schema.optional(Group),
        inner: Schema.optional(Group),
        runId: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          let ambient: CapabilitySet.CapabilitySet | undefined
          const Touch = Action.make("deep/ceiling/touch", {
            payload: {},
            success: Schema.Number,
            capabilities: v.required
          })
          const Inner = Flow.make("deep/ceiling/inner", {
            payload: {},
            success: Schema.Number,
            ...(v.inner === undefined ? {} : { capabilities: v.inner }),
            body: () => Touch.call({})
          })
          const Outer = Flow.make("deep/ceiling/outer", {
            payload: {},
            success: Schema.Number,
            ...(v.outer === undefined ? {} : { capabilities: v.outer }),
            body: () => Inner.call({})
          })
          const declared = [...(v.outer === undefined ? [] : [v.outer]), ...(v.inner === undefined ? [] : [v.inner])]
          const graph = Graph.build(Outer, {})

          // The planner names exactly the requirements some caller ceiling does not provably grant.
          const outside = Graph.diagnostics(graph)
            .filter((error) => error.code === "capability_outside_grant")
            .flatMap((error) => error.path ?? [])
          for (const required of v.required) {
            const parsed = Capability.parsePattern(required)
            if (!outside.includes(required)) {
              // Granted: sound at every probe. What the requirement matches, every ceiling allows.
              expect(declared.length === 0 || Option.isSome(parsed)).toBe(true)
              for (const probe of probes) {
                if (Option.isSome(parsed) && Capability.matches(parsed.value, probe)) {
                  expect(modelAllows(declared, probe)).toBe(true)
                }
              }
            } else {
              expect(declared.length).toBeGreaterThan(0)
            }
            // A ceiling that names the requirement verbatim grants it.
            if (Option.isSome(parsed) && declared.every((group) => group.some((pattern) => pattern === required))) {
              expect(outside).not.toContain(required)
            }
          }

          // The step's node carries every ancestor ceiling, outermost first, then its own requirement.
          const action = Graph.nodes(graph).find((node) => node.kind === "ActionCall")
          expect(action?.capabilityCeilings).toEqual([...declared, v.required])

          // Execution: the handler's ambient authority is the conjunction, never more.
          const result = yield* Outer.execute({}, { executionId: `ceiling-${v.runId}` }).pipe(
            Effect.provide(
              layerWired(
                Layer.mergeAll(
                  Touch.toLayer(() =>
                    Effect.map(CapabilitySet.current, (set) => {
                      ambient = set
                      return 1
                    })
                  ),
                  Interpreter.layer(Inner),
                  Interpreter.layer(Outer)
                )
              )
            )
          )
          expect(result).toBe(1)
          expect(ambient).toBeDefined()
          for (const probe of probes) {
            expect(CapabilitySet.allows(ambient!, probe)).toBe(modelAllows([...declared, v.required], probe))
          }
          return true
        }).pipe(Effect.provide(NodeCrypto.layer)),
      { seed: seed + 13, executions: ioExecutions }
    )
  })
})
