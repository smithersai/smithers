import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as Request from "@smthrs/model/ModelRequest"
import { Arbitrary, Cause, Effect, Exit, Fiber, Latch, Option, Schema, Stream } from "effect"
import { HttpClientRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import * as CachedModel from "../src/CachedModel.ts"
import * as Divergence from "../src/Divergence.ts"
import type { FlowSpec, JournalEntryLike } from "../src/EngineSubject.ts"
import * as Faults from "../src/Faults.ts"
import * as Fixture from "../src/Fixture.ts"
import * as FixtureStore from "../src/FixtureStore.ts"
import * as HttpRecording from "../src/HttpRecording.ts"
import { expectJournal } from "../src/JournalAssertions.ts"
import type { ModelEventLike, RecordedRequestLike } from "../src/ModelLike.ts"
import * as Plan from "../src/Plan.ts"
import { expectPlan } from "../src/PlanAssertions.ts"
import * as RecordedModel from "../src/RecordedModel.ts"
import * as RecordingModel from "../src/RecordingModel.ts"
import * as RestartableEngine from "../src/RestartableEngine.ts"
import * as ScriptedModel from "../src/ScriptedModel.ts"
import * as TestHost from "../src/TestHost.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const property = <A, E>(
  input: Arbitrary.Arbitrary<A>,
  executions: number,
  check: (value: A) => Effect.Effect<void, E>,
  options: Pick<Fuzz.Options, "execution"> = {}
) =>
  Effect.runPromise(Fuzz.run(input, (value) => check(value).pipe(Effect.as(true)), { seed, executions, ...options }))
    .then((report) => {
      expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
    })

const integer = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const text = Arbitrary.array(
  Arbitrary.schema(
    Schema.Literals(["a", "Z", "7", "雪", "💡", "e\u0301", "\ud800", "\0", "\r\n", "\"", "\\", " -> ", "../"])
  ),
  { maxLength: 8 }
).pipe(Arbitrary.map((pieces) => pieces.join("")))
const sample = Arbitrary.all({ prompt: text, id: text, output: text, name: text, budget: integer(1, 128) })
type Sample = typeof sample extends Arbitrary.Arbitrary<infer A> ? A : never

const request = (s: Sample, variant: number, nonce: number, reverse = false) => {
  const entries = [["z", s.output], ["__proto__", s.id], ["a", s.prompt]] as const
  return Request.ModelRequest.make({
    modelId: `model-${variant % 2}`,
    system: [{ type: "text", text: s.prompt }, { type: "text", text: String(nonce) }],
    messages: [
      Request.Message.user(`${Math.floor(variant / 2)}:${s.prompt}`),
      Request.Message.assistant(
        Request.ToolCallPart.make({ id: s.id, name: s.name, arguments: JSON.stringify(s.output) }),
        {
          stopReason: "tool-calls"
        }
      ),
      Request.Message.tool(
        Request.ToolResultPart.make({ toolCallId: s.id, content: s.output, addedToolNames: [s.name] })
      )
    ],
    tools: [{
      name: s.name,
      description: s.prompt,
      parameters: { properties: Object.fromEntries(reverse ? [...entries].reverse() : entries) }
    }],
    params: Request.GenerationParams.make({ maxTokens: s.budget }),
    cacheKey: String(nonce),
    cacheBoundary: nonce % 4
  })
}

const defect = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) throw new Error("expected a defect, got success")
    const found = Cause.findDefect(exit.cause)
    if (found._tag !== "Success") throw new Error(Cause.pretty(exit.cause))
    return found.success
  })

describe("testing harness properties", () => {
  it("ignores provider cache hints and record insertion order while distinguishing every edited request field", () =>
    property(sample, pureExecutions, (s) =>
      Effect.sync(() => {
        const req = request(s, 0, 0)
        const digest = Fixture.canonicalRequestDigest(req)
        const projected = Fixture.recordedRequest(req)
        expect(projected).not.toHaveProperty("cacheKey")
        expect(projected).not.toHaveProperty("cacheBoundary")
        expect(Fixture.recordedRequest(projected)).toStrictEqual(projected)
        expect(Fixture.canonicalRequestDigest({ ...request(s, 0, 0, true), cacheKey: s.id + "!", cacheBoundary: 3 }))
          .toBe(digest)
        const tool = req.tools[0]!
        const changes: Array<RecordedRequestLike> = [
          { ...projected, modelId: req.modelId + "!" },
          { ...projected, system: [...req.system, { type: "text", text: "" }] },
          { ...projected, messages: [...req.messages].reverse() },
          {
            ...projected,
            messages: [
              req.messages[0]!,
              Request.Message.assistant(
                Request.ToolCallPart.make({
                  id: s.id,
                  name: s.name,
                  arguments: JSON.stringify(s.output + "!")
                }),
                { stopReason: "tool-calls" }
              ),
              req.messages[2]!
            ]
          },
          {
            ...projected,
            tools: [{
              ...tool,
              parameters: {
                properties: Object.fromEntries([["z", s.output], ["__proto__", s.id + "!"], ["a", s.prompt]])
              }
            }]
          },
          { ...projected, params: { ...req.params, maxTokens: s.budget + 1 } },
          { ...projected, toolChoice: "none" },
          { ...projected, serverTools: [{ type: "web_search" }] }
        ]
        expect(new Set([digest, ...changes.map(Fixture.canonicalRequestDigest)]).size).toBe(changes.length + 1)
      })))

  it("keys normalized conversations by meaning and records exactly the first live answer for each key", () =>
    property(
      Arbitrary.all({ s: sample, commands: Arbitrary.array(integer(0, 5), { maxLength: 9 }) }),
      ioExecutions,
      ({ s, commands }) =>
        Effect.gen(function*() {
          const store = yield* FixtureStore.makeMemory()
          expect(Option.isNone(yield* store.load())).toBe(true)
          const normalize = (r: RecordedRequestLike) => ({ ...r, system: r.system.slice(0, 1) })
          const live = ScriptedModel.make({
            script: (r) => ({ name: "echo", text: JSON.stringify([r.modelId, r.system[1]!.text, s.output]) })
          })
          const observedLive = yield* FixtureStore.makeMemory()
          const cached = CachedModel.make({
            fixture: store,
            normalize,
            live: RecordingModel.make(live, observedLive.append)
          })
          const firstAnswers = new Map<number, ReadonlyArray<ModelEventLike>>()
          for (const [nonce, variant] of [0, 1, 2, 0, ...commands].entries()) {
            const req = request(s, variant, nonce, nonce % 2 === 1)
            const projected = normalize(Fixture.recordedRequest(req))
            const equivalent = normalize(Fixture.recordedRequest(request(s, variant, nonce + 1, nonce % 2 === 0)))
            expect(Fixture.canonicalRequestDigest(projected)).toBe(Fixture.canonicalRequestDigest(equivalent))
            const events = yield* Stream.runCollect(cached.stream(req))
            const prior = firstAnswers.get(variant)
            if (prior === undefined) {
              expect(events).toContainEqual({
                type: "text-delta",
                id: "scripted",
                text: JSON.stringify([req.modelId, String(nonce), s.output])
              })
              firstAnswers.set(variant, events)
            } else {
              expect(events).toStrictEqual(prior)
            }
            const fixture = Option.getOrThrow(yield* store.load())
            expect(fixture.calls).toHaveLength(firstAnswers.size)
            expect(Option.getOrThrow(yield* observedLive.load()).calls).toHaveLength(firstAnswers.size)
            expect(Fixture.index(fixture).get(Fixture.canonicalRequestDigest(projected))?.events).toStrictEqual(events)
          }
          const offline = CachedModel.make({ fixture: store, normalize })
          expect(yield* defect(Stream.runDrain(offline.stream(request(s, 6, 1))))).toMatchObject({
            _tag: "UnscriptedModelError",
            messageCount: 3,
            toolNames: [s.name]
          })
          expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(firstAnswers.size)
        })
    ))

  it("records streamed tool arguments, preserves fixture snapshots, and rejects replay mismatches without consuming a call", () =>
    property(sample, ioExecutions, (s) =>
      Effect.gen(function*() {
        const req = request(s, 0, 0)
        const projected = Fixture.recordedRequest(req)
        const delta = { type: "tool-call-delta" as const, id: s.id, arguments: s.output }
        const events: Array<ModelEventLike> = [
          { type: "tool-call-start", id: s.id, name: s.name },
          delta,
          { type: "tool-call-delta", id: s.id, arguments: s.prompt },
          { type: "tool-call-end", id: s.id },
          { type: "settle", stopReason: "tool-calls" }
        ]
        const original = structuredClone(events)
        const source = yield* FixtureStore.makeMemory()
        yield* source.append({ model: req.modelId, request: projected, events })
        const first = Option.getOrThrow(yield* source.load())
        delta.arguments += "changed"
        yield* source.append({ model: req.modelId, request: projected, events })
        expect(first.calls).toHaveLength(1)
        expect(first.calls[0]!.events).toStrictEqual(original)
        const both = Option.getOrThrow(yield* source.load())
        expect(both.calls[1]!.events).toStrictEqual(events)
        expect(Fixture.index(both).get(Fixture.canonicalRequestDigest(req))).toBe(both.calls[0])

        const store = yield* FixtureStore.makeMemory()
        const recorder = RecordingModel.make(CachedModel.make({ fixture: source }), store.append)
        expect(yield* Stream.runCollect(recorder.stream(req))).toStrictEqual(original)
        const fixture = Option.getOrThrow(yield* store.load())
        const portable = yield* Fixture.decode(JSON.parse(JSON.stringify(fixture)))
        expect(portable).toStrictEqual({ calls: [{ model: req.modelId, request: projected, events: original }] })
        expect((yield* Effect.flip(Fixture.decode({ calls: [{ ...portable.calls[0], model: "different" }] })))._tag)
          .toBe("SchemaError")
        const replay = yield* RecordedModel.make(portable, { strictRequestOrder: true })
        const wrong = { ...projected, modelId: "wrong" }
        expect(yield* defect(Stream.runDrain(replay.model.stream(wrong)))).toMatchObject({
          _tag: "ReplayHarnessMismatchError",
          expected: req.modelId,
          actual: wrong.modelId
        })
        expect(yield* defect(Stream.runDrain(replay.model.stream({ ...projected, messages: [] })))).toMatchObject({
          _tag: "UnscriptedModelError",
          modelId: req.modelId,
          messageCount: 0
        })
        expect(yield* replay.controller.unconsumed()).toStrictEqual(portable.calls)
        expect(yield* Stream.runCollect(replay.model.stream(request(s, 0, 0, true)))).toStrictEqual(original)
        expect(yield* replay.controller.unconsumed()).toStrictEqual([])
        expect(yield* defect(Stream.runDrain(replay.model.stream(req)))).toMatchObject({ _tag: "UnscriptedModelError" })
      })))

  it("records provider failures after their streamed prefix and ignores a consumer that stops early", () =>
    property(sample, ioExecutions, (s) =>
      Effect.gen(function*() {
        const req = request(s, 0, 0)
        const events: Array<ModelEventLike> = [
          { type: "text-start", id: s.id },
          { type: "text-delta", id: s.id, text: s.output }
        ]
        const failure = {
          code: "rate_limited" as const,
          message: s.prompt,
          requestId: s.id,
          httpStatus: 429,
          retryAfterMillis: s.budget
        }
        const source = yield* FixtureStore.makeMemory({
          calls: [{
            request: Fixture.recordedRequest(req),
            model: req.modelId,
            events,
            failure
          }]
        })
        const store = yield* FixtureStore.makeMemory()
        const recorder = RecordingModel.make(CachedModel.make({ fixture: source }), store.append)
        yield* Stream.runHead(recorder.stream(req))
        expect(Option.isNone(yield* store.load())).toBe(true)

        const readFailure = <E>(stream: Stream.Stream<ModelEventLike, E>) =>
          Effect.gen(function*() {
            const seen: Array<ModelEventLike> = []
            const error = yield* Effect.flip(Stream.runForEach(stream, (event) =>
              Effect.sync(() => {
                seen.push(event)
              })))
            expect(seen).toStrictEqual(events)
            expect(error).toMatchObject({ ...failure, _tag: "flows/model/ModelError" })
          })
        yield* readFailure(recorder.stream(req))
        const portable = yield* Fixture.decode(JSON.parse(JSON.stringify(Option.getOrThrow(yield* store.load()))))
        expect(portable.calls).toHaveLength(1)
        expect(portable.calls[0]!.failure).toStrictEqual(failure)
        const replay = yield* RecordedModel.make(portable)
        yield* readFailure(replay.model.stream(req))
        expect(yield* replay.controller.unconsumed()).toStrictEqual([])
        yield* readFailure(CachedModel.make({ fixture: store }).stream(req))
        expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(1)
      })))

  it("scrubs header names and secrets, preserves hostile JSON text, and claims interleaved HTTP responses FIFO per request", () =>
    property(
      Arbitrary.all({ payload: text, commands: Arbitrary.array(integer(0, 2), { maxLength: 8 }) }),
      ioExecutions,
      ({ payload, commands }) =>
        Effect.gen(function*() {
          const secret = "private-fixture-value"
          const raw = "https://u:p@example.test/items?token=private-fixture-value"
          const order = [1, 0, 1, 2, ...commands]
          const exchanges = order.map((key, index) => {
            const request = { method: "POST", url: raw, body: { bucket: key, payload, key: secret } }
            const response = {
              status: 200 + index % 3,
              headers: {
                "CoNtEnT-TyPe": "application/json",
                "Retry-After": String(index),
                ["X-" + payload + "\0\r\n"]: payload + "\r\n\0" + secret,
                "Set-Cookie": secret
              },
              body: { index, data: [payload, secret] }
            }
            const exchange = HttpRecording.scrubExchange({ request, response }, { secrets: [secret] })
            expect(exchange.response.headers).toStrictEqual({
              "content-type": "application/json",
              "retry-after": String(index)
            })
            expect(exchange.response.body).toStrictEqual({ index, data: [payload, "[REDACTED]"] })
            expect(exchange.request).toStrictEqual({
              method: "POST",
              url: "https://example.test/items?token=%5BREDACTED%5D",
              body: { bucket: key, payload, key: "[REDACTED]" }
            })
            expect(HttpRecording.scrubExchange(exchange, { secrets: [secret] })).toStrictEqual(exchange)
            return exchange
          })
          const recording = { label: payload, exchanges }
          const encoded = yield* HttpRecording.encode("case.json", recording, [secret])
          const files = TestHost.layer({
            files: {
              "/recording.json": encoded,
              "/malformed.json": JSON.stringify({ exchanges: [exchanges[0]!.request] })
            }
          })
          const decoded = yield* HttpRecording.load("/recording.json").pipe(Effect.provide(files))
          for (const path of ["/missing.json", "/malformed.json"]) {
            const error = yield* defect(HttpRecording.load(path).pipe(Effect.provide(files)))
            expect(error).toBeInstanceOf(Error)
            expect(String(error)).toContain("Recording " + path + ":")
          }
          expect(decoded).toStrictEqual(recording)
          expect(yield* HttpRecording.encode("case.json", decoded, [secret])).toBe(encoded)
          const failure = yield* Effect.flip(
            HttpRecording.encode("case.json", { ...recording, label: secret }, [secret])
          )
          expect(failure).toMatchObject({
            _tag: "CredentialInRecordingError",
            path: "case.json",
            rules: ["live-secret"]
          })

          const client = HttpRecording.replay(decoded)
          const post = (key: number) =>
            client.execute(
              HttpClientRequest.post(raw).pipe(HttpClientRequest.bodyJsonUnsafe({ bucket: key, payload, key: secret }))
            )
          let remaining = order.length
          expect(yield* defect(post(-1))).toMatchObject({ _tag: "UnrecordedRequestError", recorded: 0 })
          for (const key of [2, 0, 1]) {
            const indices = order.flatMap((item, index) => item === key ? [index] : [])
            for (const index of indices) {
              expect(client.remaining()).toBe(remaining)
              const response = yield* post(key)
              expect(response.status).toBe(200 + index % 3)
              expect(response.headers["retry-after"]).toBe(String(index))
              expect(yield* response.json).toStrictEqual({ index, data: [payload, "[REDACTED]"] })
              remaining--
            }
            expect(yield* defect(post(key))).toMatchObject({
              _tag: "UnrecordedRequestError",
              method: "POST",
              url: exchanges[0]!.request.url,
              recorded: indices.length
            })
            expect(client.remaining()).toBe(remaining)
          }
        })
    ))

  it("reports the earliest journal difference in either direction including truncations and unequal entry indices", () =>
    property(
      Arbitrary.all({ keys: Arbitrary.array(text, { minLength: 1, maxLength: 7 }), n: integer(0, 10) }),
      pureExecutions,
      ({ keys, n }) =>
        Effect.gen(function*() {
          const entries = keys.map((stepKey, i): JournalEntryLike => ({
            index: 2 * i + 1,
            stepKey,
            kind: i % 2 ? "effect" : "step",
            outcome: "completed",
            value: { i, stepKey }
          }))
          const position = n % entries.length
          const entry = entries[position]!
          const reordered = entries.map((e, i) => ({ ...e, value: { stepKey: e.stepKey, i } }))
          yield* Divergence.assertNoDivergence(entries, reordered)
          const checks = expectJournal(Object.freeze([...entries].reverse()))
          for (let pass = 0; pass < 2; pass++) {
            yield* checks.executedInOrder(keys.filter((_, i) => i % 2 === 0))
            yield* checks.terminal("completed")
            expect(checks.prefix(entry.index)).toStrictEqual(entries.slice(0, position + 1))
            expect((yield* Effect.flip(checks.executedInOrder([...keys, entry.stepKey]))).code).toBe(
              "execution_order_mismatch"
            )
          }

          for (const field of ["index", "stepKey", "kind", "outcome", "value", "entry"] as const) {
            const changed = {
              ...entry,
              [field]: {
                index: -3,
                stepKey: entry.stepKey + "!",
                kind: "other",
                outcome: "failed",
                value: null,
                entry: null
              }[field]
            }
            const actual = field === "entry" ? entries.slice(0, position) : [...entries.slice(0, position), changed]
            for (const [left, right] of [[entries, actual], [actual, entries]] as const) {
              const l = left[position]
              const r = right[position]
              const expected = {
                index: (l ?? r)!.index,
                field,
                expected: field === "entry" ? l : l![field],
                actual: field === "entry" ? r : r![field]
              }
              expect(Option.getOrThrow(Divergence.firstDivergence(left, right))).toStrictEqual(expected)
              expect(yield* Effect.flip(Divergence.assertNoDivergence(left, right))).toMatchObject({
                ...expected,
                code: "fixture_divergence"
              })
            }
          }
        })
    ))

  it("canonicalizes plan permutations idempotently and distinguishes edges even when their printed names coincide", () =>
    property(
      Arbitrary.all({ labels: Arbitrary.array(text, { maxLength: 6 }), a: text, b: text }),
      pureExecutions,
      ({ labels, a, b }) =>
        Effect.gen(function*() {
          const first = "A" + a
          const last = "C" + b
          const edge = { from: first + " -> B", to: last }
          const collision = { from: first, to: "B -> " + last }
          const ids = [edge.from, edge.to, collision.from, collision.to, ...labels.map((s, i) => i + s)]
          const nodes = ids.map((id) => ({
            id,
            key: id + "!",
            kind: "step",
            tier: "sealed",
            sealed: true,
            effects: [b, a]
          }))
          const edges = [edge, ...labels.map((_, i) => ({ from: ids[i + 3]!, to: ids[i + 4]! }))]
          const input = { nodes, edges }
          const before = structuredClone(input)
          const permutation = {
            nodes: [...nodes].reverse().map((node) => ({ ...node, effects: [a, b] })),
            edges: [...edges].reverse()
          }
          const canonical = Plan.make(input)
          expect(Plan.make(canonical)).toStrictEqual(canonical)
          expect(Plan.make(permutation)).toStrictEqual(canonical)
          expect(Plan.render(permutation)).toBe(Plan.render(input))
          const check = expectPlan(permutation)
          for (let pass = 0; pass < 2; pass++) {
            yield* check.edges(edges, { exact: true })
            yield* check.keys(Object.fromEntries(nodes.map((n) => [n.id, n.key])))
            expect((yield* Effect.flip(check.edges([collision]))).code).toBe("missing_edge")
            expect((yield* Effect.flip(check.edges(edges.slice(1), { exact: true }))).code).toBe("unexpected_edge")
          }
          expect(input).toStrictEqual(before)
        })
    ))

  it("resumes only the unfinished frontier and preserves terminal results across resubmission, conflicts and restarts", () =>
    property(
      Arbitrary.all({
        prefix: Arbitrary.array(integer(1, 5), { minLength: 1, maxLength: 5 }),
        payload: integer(-5, 5),
        abort: Arbitrary.schema(Schema.Boolean),
        suspensions: integer(1, 3),
        operations: Arbitrary.array(
          Arbitrary.schema(Schema.Literals(["resume", "restart", "kill", "interrupt", "join", "conflict"])),
          { maxLength: 9 }
        )
      }),
      ioExecutions,
      ({ prefix, payload, abort, suspensions, operations }) =>
        Effect.scoped(Effect.gen(function*() {
          const harness = yield* RestartableEngine.make()
          const { engine } = harness
          const entered = yield* Effect.forEach(Array.from({ length: suspensions + 1 }), () => Latch.make())
          const release = yield* Latch.make()
          let frontiers = 0
          const ran: Array<number> = []
          const flow: FlowSpec = {
            name: "sum",
            steps: [
              ...prefix.map((delta, i) => ({
                key: "add",
                kind: "step" as const,
                sealed: false,
                run: (input: unknown) =>
                  Effect.sync(() => {
                    ran.push(i)
                    return Number(input) + delta
                  })
              })),
              {
                key: "finish",
                kind: "step",
                sealed: true,
                run: (input) =>
                  Effect.gen(function*() {
                    yield* entered[frontiers++]!.open
                    yield* release.await
                    return input
                  })
              }
            ]
          }
          const executionId = "sum/one"
          const options = { flow, payload, executionId, idempotencyKey: "once" }
          let total = payload
          const journal: Array<JournalEntryLike> = prefix.map((delta, index) => ({
            index,
            stepKey: "add",
            kind: "step",
            outcome: "completed",
            value: total += delta
          }))
          for (let attempt = 0; attempt < suspensions; attempt++) {
            const run = yield* Effect.forkChild(attempt === 0 ? engine.run(options) : engine.resume(executionId))
            yield* entered[attempt]!.await
            expect(yield* engine.journal(executionId)).toStrictEqual(journal)
            yield* harness.restart
            expect((yield* Fiber.join(run)).status).toBe("suspended")
            journal.push({ index: journal.length, kind: "step", stepKey: "finish", outcome: "suspended" })
            expect(yield* engine.journal(executionId)).toStrictEqual(journal)
            expect(frontiers).toBe(attempt + 1)
            expect(ran).toStrictEqual(prefix.map((_, i) => i))
          }
          if (abort) {
            yield* engine.interrupt(executionId)
            journal.push({ index: journal.length, kind: "step", stepKey: "finish", outcome: "aborted" })
          } else {
            yield* release.open
            yield* engine.resume(executionId)
            journal.push({ index: journal.length, kind: "step", stepKey: "finish", outcome: "completed", value: total })
          }
          const terminal = abort
            ? { executionId, status: "aborted" }
            : { executionId, status: "completed", value: total }
          for (const op of ["join", "conflict", ...operations]) {
            switch (op) {
              case "restart":
                yield* harness.restart
                break
              case "kill":
                yield* harness.kill
                break
              case "resume":
                expect(yield* engine.resume(executionId)).toStrictEqual(terminal)
                break
              case "interrupt":
                yield* engine.interrupt(executionId)
                break
              case "join":
                expect(yield* engine.run({ ...options, executionId: "another-id" })).toStrictEqual(terminal)
                break
              case "conflict":
                expect(yield* Effect.flip(engine.run({ ...options, payload: payload + 1 }))).toMatchObject({
                  code: "execution_conflict",
                  executionId,
                  field: "payload"
                })
                break
            }
            expect(yield* engine.result(executionId)).toStrictEqual(terminal)
            expect(yield* engine.journal(executionId)).toStrictEqual(journal)
            expect(ran).toStrictEqual(prefix.map((_, i) => i))
            expect(frontiers).toBe(suspensions + (abort ? 0 : 1))
          }
        })),
      { execution: FuzzSimulation.execution() }
    ))

  it("checks immediate wait conditions once and rejects invalid deadlines before checking the predicate", () =>
    property(
      Arbitrary.array(Arbitrary.schema(Schema.Literals(["ready", "expired", "negative", "nan"])), {
        minLength: 1,
        maxLength: 8
      }),
      pureExecutions,
      (operations) =>
        Effect.promise(async () => {
          let probes = 0
          let expected = 0
          for (const op of operations) {
            const deadline = op === "nan" ? NaN : op === "negative" ? -1 : 0
            const wait = Faults.waitFor(
              () => {
                probes++
                return op === "ready"
              },
              "frontier",
              deadline
            )
            if (op === "ready") await wait
            else if (op === "expired") await expect(wait).rejects.toThrow("timed out after 0ms waiting for frontier")
            else await expect(wait).rejects.toThrow(RangeError)
            if (deadline === 0) expected++
            expect(probes).toBe(expected)
          }
        })
    ))
})
