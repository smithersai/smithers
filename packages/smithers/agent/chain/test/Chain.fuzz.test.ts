import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as Flows from "@smthrs/memory/Flows"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Arbitrary, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  Author,
  AuthorDeclaration,
  Authorize,
  CallKey,
  Catalog,
  Chain,
  Event,
  Journal,
  JsonBoundary,
  MemoryEntries,
  ModelAuthor,
  Observation,
  Outcome,
  Prompt,
  QuickJsRunner,
  RegistryCatalog,
  Script,
  ScriptRunner,
  Steering,
  SubChains
} from "../src/index.ts"
import { flow } from "./harness.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const pat = (action: CapabilityPattern["action"], resource: string): CapabilityPattern =>
  new CapabilityPattern({ action, resource })

describe("@smthrs/chain fuzz invariants", () => {
  it("JsonBoundary, Outcome, Observation, Script & Prompt enforce strict boundary & shape gates", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "primitive",
          "nested-valid",
          "prototype-pollution",
          "deep-overflow",
          "cycle",
          "nan-inf",
          "symbol-fn",
          "lone-surrogate",
          "null-proto",
          "throwing-getter",
          "tojson-obj",
          "array-sparse"
        ]),
        outcomeKind: Schema.Literals(["Done", "To", "ToObj", "Park", "InvalidTag", "BadPark"]),
        fenceStyle: Schema.Literals(["none", "one", "one-crlf", "one-4ticks", "two", "surrogate"]),
        role: Schema.Literals(["concierge", "sub"]),
        entryName: Schema.Literals(["repo/read", "author", "", "has space", "has`tick", "a".repeat(70), "sys/now"]),
        obsSize: Schema.Literals(["short", "long", "surrogate"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, outcomeKind, fenceStyle, role, entryName, obsSize }) =>
          Effect.sync(() => {
            let input: unknown
            let expectOk = true
            switch (kind) {
              case "primitive":
                input = "hello"
                break
              case "nested-valid":
                input = { a: [1, true, null, { b: "ok", z: -0 }] }
                break
              case "prototype-pollution":
                input = JSON.parse(`{"__proto__":{"polluted":true},"constructor":{"x":1},"safe":"yes"}`)
                break
              case "deep-overflow": {
                let cur: unknown = "leaf"
                for (let i = 0; i < JsonBoundary.maxJsonDepth + 5; i += 1) cur = { next: cur }
                input = cur
                expectOk = false
                break
              }
              case "cycle": {
                const obj: Record<string, unknown> = { a: 1 }
                obj.self = obj
                input = obj
                expectOk = false
                break
              }
              case "nan-inf":
                input = { bad: Number.NaN, inf: Number.POSITIVE_INFINITY }
                expectOk = false
                break
              case "symbol-fn":
                input = { fn: () => 1, sym: Symbol("x") }
                expectOk = false
                break
              case "lone-surrogate":
                input = { s: "bad\uD800surrogate" }
                expectOk = false
                break
              case "null-proto": {
                const obj = Object.create(null) as Record<string, unknown>
                obj.k = "v"
                input = obj
                break
              }
              case "throwing-getter": {
                const obj = {}
                Object.defineProperty(obj, "boom", {
                  enumerable: true,
                  get: () => {
                    throw new Error("getter boom")
                  }
                })
                input = obj
                expectOk = false
                break
              }
              case "tojson-obj":
                input = { toJSON: () => ({ ok: true }) }
                expectOk = false
                break
              case "array-sparse": {
                const arr: Array<unknown> = []
                arr[2] = "x"
                input = arr
                expectOk = false
                break
              }
            }

            const checked = JsonBoundary.jsonBoundary(input)
            if (expectOk) {
              if (checked._tag !== "Ok") throw new Error(`expected Ok for ${kind}`)
              if (kind === "prototype-pollution") {
                const rec = checked.value as Record<string, unknown>
                if (Object.getPrototypeOf(rec) !== Object.prototype) throw new Error("proto changed")
                if (({} as Record<string, unknown>).polluted !== undefined) throw new Error("polluted")
              }
            } else if (checked._tag !== "Refused") {
              throw new Error(`expected Refused for ${kind}`)
            }

            // Outcome decode
            const rawOutcome = outcomeKind === "Done"
              ? Outcome.done({ ok: true })
              : outcomeKind === "To"
              ? Outcome.to("return done(1)")
              : outcomeKind === "ToObj"
              ? Outcome.to({ text: "return done(2)" })
              : outcomeKind === "Park"
              ? Outcome.park("approval", "need approval")
              : outcomeKind === "BadPark"
              ? { _tag: "Park", reason: { code: "bogus", message: "x" } }
              : { _tag: "Unknown" }
            const decoded = JsonBoundary.decodeOutcome(rawOutcome)
            if (outcomeKind === "InvalidTag" || outcomeKind === "BadPark") {
              if (Option.isSome(decoded)) throw new Error(`expected None for ${outcomeKind}`)
            } else if (Option.isNone(decoded)) {
              throw new Error(`expected Some for ${outcomeKind}`)
            }

            if (JsonBoundary.failureMessage(new Error("boom")) !== "boom") return false
            if (JsonBoundary.failureMessage("plain") !== "plain") return false

            // Script extraction
            const rawScript = fenceStyle === "none"
              ? "no fence here"
              : fenceStyle === "one"
              ? flow("return done(1)")
              : fenceStyle === "one-crlf"
              ? "```flow\r\nreturn done(1)\r\n```\r\n"
              : fenceStyle === "one-4ticks"
              ? "````flow\nconst x = \"```js\\nhi\\n```\"\nreturn done(x)\n````"
              : fenceStyle === "two"
              ? `${flow("return done(1)")}\n${flow("return done(2)")}`
              : flow(`return done("${String.fromCharCode(0xd800)}")`)
            const extracted = Script.extract(rawScript)
            if (fenceStyle === "none" || fenceStyle === "two" || fenceStyle === "surrogate") {
              if (extracted._tag !== "Rejected") throw new Error(`expected Rejected for ${fenceStyle}`)
            } else if (extracted._tag !== "Extracted" || extracted.script.digest === "") {
              throw new Error(`expected Extracted for ${fenceStyle}`)
            }

            // Observation bounds & well-formedness
            const obsMsg = obsSize === "short"
              ? "ok"
              : obsSize === "long"
              ? "x".repeat(9000)
              : "bad\uD800text"
            const obs = Observation.make("catalog", obsMsg)
            if (obs.message.length > 8192) return false
            if (!Observation.render(obs).startsWith("[catalog] ")) return false

            // Prompt rendering
            const entries = Catalog.withSystem([
              { name: entryName, description: "desc\nwith\rcontrols", handler: () => Effect.succeed(1) }
            ])
            const cat = Catalog.make(entries)
            const assembled = Prompt.forCatalog(cat, role, role === "concierge" ? "host note" : undefined)
            if (!assembled.includes("sys/now") || !assembled.includes("sys/random")) return false
            if (entryName === AuthorDeclaration.authorName && assembled.includes("- author:")) return false
            if (Prompt.renderableName("") || Prompt.renderableName("a b") || Prompt.renderableName("a`b")) return false

            return AuthorDeclaration.authorDigest.length > 0 && AuthorDeclaration.authorCapability.length > 0
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("Authorize capability gate evaluates rules consistently and isolates rule mutations", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        claim: Schema.Literals([
          "fs:read:src/a.ts",
          "fs:write:/etc/passwd",
          "fs:read:secret/key",
          "model:call:author",
          "fs:read",
          "*",
          "bad:::",
          ""
        ]),
        policyMode: Schema.Literals(["allow-read-deny-write", "ask-secret", "deny-all", "allow-all", "noop"]),
        emptyClaims: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ claim, policyMode, emptyClaims }) =>
          Effect.gen(function*() {
            const parsed = Authorize.claimPattern(claim)
            if (claim === "" && Option.isSome(parsed)) return false
            if (claim === "fs:read" && Option.isNone(parsed)) return false

            const rules: Array<Rule> = policyMode === "allow-read-deny-write"
              ? [
                new Rule({ effect: "allow", pattern: pat("fs:read", "**") }),
                new Rule({ effect: "deny", pattern: pat("fs:write", "**") }),
                new Rule({ effect: "allow", pattern: pat("model:call", "**") })
              ]
              : policyMode === "ask-secret"
              ? [
                new Rule({ effect: "allow", pattern: pat("fs:read", "**") }),
                new Rule({ effect: "ask", pattern: pat("fs:read", "secret/*") })
              ]
              : policyMode === "deny-all"
              ? [new Rule({ effect: "deny", pattern: pat("*", "**") })]
              : []

            const layer = policyMode === "allow-all"
              ? Authorize.layerAllowAll
              : policyMode === "noop"
              ? Authorize.layerNoop()
              : Authorize.layerRules(rules)

            // Mutate caller rules after creating layer to verify snapshot isolation
            rules.length = 0

            const res = yield* Effect.result(
              Effect.flatMap(Authorize.Authorize, (auth) =>
                auth.authorize({
                  name: "probe",
                  capabilities: emptyClaims ? [] : [claim],
                  slot: { chain: "", link: 0, ordinal: 0 }
                })).pipe(Effect.provide(layer))
            )

            if (policyMode === "allow-all") return Result.isSuccess(res)
            if (policyMode === "noop") {
              return Result.isFailure(res) && res.failure.code === "authorize_unavailable"
            }
            if (policyMode === "deny-all") {
              return Result.isFailure(res) &&
                (res.failure.code === "denied" || res.failure.code === "approval_required")
            }
            if (emptyClaims) {
              return Result.isFailure(res) &&
                (res.failure.code === "approval_required" || res.failure.code === "denied")
            }
            if (policyMode === "allow-read-deny-write" && claim === "fs:write:/etc/passwd") {
              return Result.isFailure(res) && res.failure.code === "denied"
            }
            if (policyMode === "ask-secret" && claim === "fs:read:secret/key") {
              return Result.isFailure(res) && res.failure.code === "approval_required"
            }
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })

  it("Journal optimistic concurrency, Steering concurrent admit/drain, and Event folds under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        writers: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 5 }))),
        steeringMsgs: Schema.Array(Schema.Literals(["stop", "focus", "pivot", "check"])).pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(5))
        ),
        chainScope: Schema.Literals(["", "child/0"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ writers, steeringMsgs, chainScope }) =>
          Effect.gen(function*() {
            // Concurrent journal appends competing for position 0: exactly 1 succeeds, others get journal_conflict
            const journalLayer = Journal.layerMemory()
            const journalRes = yield* Effect.gen(function*() {
              const journal = yield* Journal.Journal
              const attempts = yield* Effect.forEach(
                Array.from({ length: writers }, (_, i) => i),
                (i) =>
                  Effect.result(
                    journal.append(
                      {
                        _tag: "ChainStarted",
                        ...(chainScope === "" ? {} : { chain: chainScope }),
                        goal: `goal-${i}`,
                        envelope: { i }
                      },
                      0
                    )
                  ),
                { concurrency: "unbounded" }
              )
              const events = yield* journal.read
              return { attempts, events }
            }).pipe(Effect.provide(journalLayer))

            const successes = journalRes.attempts.filter(Result.isSuccess).length
            const conflicts = journalRes.attempts.filter(
              (r) => Result.isFailure(r) && r.failure.code === "journal_conflict"
            ).length
            if (successes !== 1 || conflicts !== writers - 1 || journalRes.events.length !== 1) return false

            // Pure event folds over multi-event history
            const script0 = Script.make("return done(1)")
            const key0 = CallKey.make(0, script0.digest, 0, "entry-digest")
            const scoped = chainScope === "" ? {} : { chain: chainScope }
            const fullHistory: ReadonlyArray<Event.Event> = [
              ...journalRes.events,
              { _tag: "LinkAuthored", ...scoped, link: 0, script: script0 },
              { _tag: "SteeringDrained", ...scoped, link: 0, ordinal: 0, messages: [...steeringMsgs] },
              { _tag: "CallSettled", ...scoped, link: 0, key: key0, name: "work", payload: null, result: { ok: true } },
              {
                _tag: "GateRejected",
                ...scoped,
                link: 0,
                ordinal: 1,
                observation: Observation.make("catalog", "missing")
              },
              { _tag: "LinkEnded", ...scoped, link: 0, outcome: Outcome.done("finished") }
            ]
            if (!Event.started(fullHistory, chainScope)) return false
            if (Event.linkCount(fullHistory, chainScope) !== 1) return false
            if (Event.authored(fullHistory, 0, chainScope)?.digest !== script0.digest) return false
            if (Event.settled(fullHistory, 0, chainScope).size !== 1) return false
            if (Event.rejected(fullHistory, 0, chainScope).size !== 1) return false
            if (Event.observations(fullHistory, 0, chainScope).length < 1) return false
            if (Event.steeringLines(fullHistory, 0, chainScope).length !== steeringMsgs.length) return false
            if (!Event.steeredOrdinals(fullHistory, 0, chainScope).has(0)) return false
            if (Event.terminal(fullHistory, chainScope)?._tag !== "Done") return false
            // Unrelated chain scope sees empty state
            const otherScope = chainScope === "" ? "other" : ""
            if (Event.started(fullHistory, otherScope) || Event.linkCount(fullHistory, otherScope) !== 0) return false

            // Concurrent Steering admit + drain: total drained across all drains equals total admitted
            const steeringRes = yield* Effect.gen(function*() {
              const s = yield* Steering.Steering
              const drained1: Array<string> = []
              yield* Effect.all([
                Effect.forEach(steeringMsgs, (m) => s.admit(m), { concurrency: "unbounded" }),
                s.drain("0/0").pipe(Effect.map((ms) => drained1.push(...ms)))
              ], { concurrency: 2 })
              const drained2 = yield* s.drain("0/1")
              return [...drained1, ...drained2]
            }).pipe(Effect.provide(Steering.layerMemory()))
            if (steeringRes.length !== steeringMsgs.length) return false

            // Noop layers fail with typed unavailable errors
            const noopJ = yield* Effect.result(
              Effect.flatMap(Journal.Journal, (j) => j.read).pipe(Effect.provide(Journal.layerNoop()))
            )
            const noopS = yield* Effect.result(
              Effect.flatMap(Steering.Steering, (s) => s.drain("0/0")).pipe(Effect.provide(Steering.layerNoop()))
            )
            return Result.isFailure(noopJ) && Result.isFailure(noopS)
          }),
        { execution: FuzzSimulation.execution(), seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("Chain trampoline, gates, recovery, steering, and deterministic prefix replay under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "multi-link-done",
          "park-timer",
          "approval-wait-then-resume",
          "quota-max-links",
          "max-calls-exceeded",
          "unknown-entry-recovery",
          "call-error-recovery",
          "shape-gate-recovery",
          "script-failure-recovery",
          "envelope-divergence",
          "steering-drain",
          "author-exhausted"
        ]),
        replayAfter: Schema.Boolean,
        useSystemEntries: Schema.Boolean
      })
    )

    // Pure Effect ScriptRunner (no native Promises) so it runs natively inside FuzzSimulation
    const pureRunnerLayer = Layer.succeed(ScriptRunner.ScriptRunner)(
      ScriptRunner.make({
        run: (script, handler) =>
          Effect.gen(function*() {
            const text = script.text.trim()
            if (text === "COMPILE_ERR") {
              return yield* Effect.fail(new ScriptRunner.ScriptFailure({ code: "compile", message: "bad syntax" }))
            }
            if (text === "CALL_ECHO_DONE") {
              const res = yield* handler({ name: "echo", payload: { n: 1 } })
              return Outcome.done(res as typeof Schema.Json.Type)
            }
            if (text === "CALL_SYS_DONE") {
              const now = yield* handler({ name: "sys/now", payload: null })
              const rnd = yield* handler({ name: "sys/random", payload: null })
              return Outcome.done({ now, rnd } as typeof Schema.Json.Type)
            }
            if (text === "CALL_MISSING_THEN_TO") {
              yield* handler({ name: "does-not-exist", payload: {} })
              return Outcome.to("CALL_ECHO_DONE")
            }
            if (text === "CALL_FAIL_THEN_TO") {
              yield* handler({ name: "failer", payload: {} })
              return Outcome.to("CALL_ECHO_DONE")
            }
            if (text === "CALL_MANY") {
              yield* handler({ name: "echo", payload: { i: 1 } })
              yield* handler({ name: "echo", payload: { i: 2 } })
              yield* handler({ name: "echo", payload: { i: 3 } })
              return Outcome.done("many")
            }
            if (text === "BOUNCE_ONCE") {
              yield* handler({ name: "echo", payload: { step: 0 } })
              return Outcome.to("CALL_ECHO_DONE")
            }
            if (text === "BOUNCE_FOREVER") {
              return Outcome.to("BOUNCE_FOREVER")
            }
            if (text === "PARK_TIMER") {
              return Outcome.park("timer", "wait 5m")
            }
            return Outcome.done("default")
          })
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario, replayAfter, useSystemEntries }) =>
          Effect.gen(function*() {
            let echoCalls = 0
            const entries = Catalog.withSystem([
              {
                name: "echo",
                description: "echo payload",
                capabilities: ["fs:read:echo"],
                handler: (payload) =>
                  Effect.sync(() => {
                    echoCalls += 1
                    return { echoed: payload }
                  })
              },
              {
                name: "failer",
                description: "always fails",
                capabilities: ["fs:read:failer"],
                handler: () => Effect.fail(new Catalog.CallError({ name: "failer", message: "boom" }))
              }
            ])

            const authorScripts: ReadonlyArray<string> = scenario === "multi-link-done"
              ? [flow(useSystemEntries ? "CALL_SYS_DONE" : "BOUNCE_ONCE")]
              : scenario === "park-timer"
              ? [flow("PARK_TIMER")]
              : scenario === "approval-wait-then-resume"
              ? [flow("CALL_ECHO_DONE")]
              : scenario === "quota-max-links"
              ? [flow("BOUNCE_FOREVER")]
              : scenario === "max-calls-exceeded"
              ? [flow("CALL_MANY"), flow("CALL_ECHO_DONE")]
              : scenario === "unknown-entry-recovery"
              ? [flow("CALL_MISSING_THEN_TO"), flow("CALL_ECHO_DONE")]
              : scenario === "call-error-recovery"
              ? [flow("CALL_FAIL_THEN_TO"), flow("CALL_ECHO_DONE")]
              : scenario === "shape-gate-recovery"
              ? ["no flow block here", flow("CALL_ECHO_DONE")]
              : scenario === "script-failure-recovery"
              ? [flow("COMPILE_ERR"), flow("CALL_ECHO_DONE")]
              : scenario === "envelope-divergence"
              ? [flow("CALL_ECHO_DONE")]
              : scenario === "steering-drain"
              ? [flow("CALL_ECHO_DONE")]
              : [] // author-exhausted

            const authLayer = scenario === "approval-wait-then-resume"
              ? Authorize.layerRules([
                new Rule({ effect: "allow", pattern: pat("model:call", "**") }),
                new Rule({ effect: "ask", pattern: pat("fs:read", "echo") })
              ])
              : Authorize.layerAllowAll

            const steeringLayer = Steering.layerMemory(
              scenario === "steering-drain" ? ["hurry up", "stay safe"] : []
            )

            const runOnce = (
              initial: ReadonlyArray<Event.Event>,
              envVal: unknown,
              auth: Layer.Layer<Authorize.Authorize>
            ) =>
              Effect.gen(function*() {
                const outcome = yield* Chain.run({
                  goal: "fuzz goal",
                  envelope: envVal as typeof Schema.Json.Type,
                  maxLinks: scenario === "quota-max-links" ? 2 : 8,
                  maxCallsPerLink: scenario === "max-calls-exceeded" ? 2 : 16
                })
                const journal = yield* Journal.Journal
                const events = yield* journal.read
                return { outcome, events }
              }).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    Journal.layerMemory(initial),
                    Catalog.layer(entries),
                    Author.layerMock(authorScripts),
                    pureRunnerLayer,
                    steeringLayer,
                    auth
                  )
                )
              )

            const first = yield* Effect.result(runOnce([], { v: 1 }, authLayer))

            if (scenario === "author-exhausted") {
              return Result.isFailure(first)
            }
            if (Result.isFailure(first)) return false

            const { outcome, events } = first.success
            if (scenario === "park-timer" && outcome._tag !== "Park") return false
            if (scenario === "quota-max-links" && (outcome._tag !== "Park" || outcome.reason.code !== "quota")) {
              return false
            }
            if (scenario === "approval-wait-then-resume") {
              if (outcome._tag !== "ApprovalWait") return false
              // Resume with allowAll -> must complete cleanly
              const resumed = yield* Effect.result(runOnce(events, { v: 1 }, Authorize.layerAllowAll))
              return Result.isSuccess(resumed) && resumed.success.outcome._tag === "Done"
            }

            if (scenario === "envelope-divergence") {
              const diverged = yield* Effect.result(runOnce(events, { v: 2 }, authLayer))
              return Result.isFailure(diverged) && diverged.failure._tag === "/chain/ChainError"
                && diverged.failure.code === "replay_divergence"
            }

            if (replayAfter && outcome._tag === "Done") {
              const beforeReplayCalls = echoCalls
              const replayed = yield* Effect.result(runOnce(events, { v: 1 }, authLayer))
              if (Result.isFailure(replayed)) return false
              // Zero effects on replay!
              if (echoCalls !== beforeReplayCalls) return false
              if (replayed.success.outcome._tag !== "Done") return false
              if (replayed.success.events.length !== events.length) return false
            }

            return true
          }),
        { execution: FuzzSimulation.execution(), seed: seed + 3, executions }
      )
    )
    assertPassed(report)
  })

  it("ScriptRunner.layerInProcess and QuickJsRunner execute scripts & reject invalid calls/outcomes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "done",
          "to",
          "park",
          "call-ok",
          "call-err",
          "compile-err",
          "runtime-err",
          "invalid-outcome",
          "unserializable-call"
        ]),
        payloadNum: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -50, maximum: 50 })))
      })
    )

    // Pre-initialize one QuickJS service once for speed across all executions
    const qjs = await Effect.runPromise(QuickJsRunner.make({ steps: 2000 }))
    const qjsLayer = Layer.succeed(ScriptRunner.ScriptRunner)(qjs)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, payloadNum }) =>
          Effect.gen(function*() {
            const scriptText = mode === "done"
              ? `return done({ n: ${payloadNum} })`
              : mode === "to"
              ? `return to("return done(${payloadNum})")`
              : mode === "park"
              ? `return park("event", "waiting-${payloadNum}")`
              : mode === "call-ok"
              ? `const r = await ctx.call("add", { n: ${payloadNum} }); return done(r)`
              : mode === "call-err"
              ? `try { await ctx.call("boom", {}); return done("unreachable") } catch (e) { return done({ caught: e.message }) }`
              : mode === "compile-err"
              ? `return done(((`
              : mode === "runtime-err"
              ? `throw new Error("boom-${payloadNum}")`
              : mode === "invalid-outcome"
              ? `return { notAnOutcome: ${payloadNum} }`
              : `await ctx.call("add", { bad: Number.NaN }); return done(1)`

            const script = Script.make(scriptText)
            const handler = (req: ScriptRunner.Request) =>
              req.name === "boom"
                ? Effect.fail(new Catalog.CallError({ name: "boom", message: "exploded" }))
                : Effect.succeed({ ok: true, got: req.payload })

            const inProc = yield* Effect.result(
              Effect.flatMap(ScriptRunner.ScriptRunner, (r) => r.run(script, handler)).pipe(
                Effect.provide(ScriptRunner.layerInProcess)
              )
            )
            const quickJs = yield* Effect.result(
              Effect.flatMap(ScriptRunner.ScriptRunner, (r) => r.run(script, handler)).pipe(
                Effect.provide(qjsLayer)
              )
            )

            // Both runners must agree on success vs failure and outcome tag!
            if (Result.isSuccess(inProc) !== Result.isSuccess(quickJs)) return false
            if (Result.isSuccess(inProc) && Result.isSuccess(quickJs)) {
              if (inProc.success._tag !== quickJs.success._tag) return false
            }

            // Exercise QuickJsRunner pure helpers too
            const decodedOk = QuickJsRunner.decodeCallInput(JSON.stringify({ n: payloadNum }))
            const decodedBad = QuickJsRunner.decodeCallInput("{bad json")
            const cyclic: Record<string, unknown> = {}
            cyclic.self = cyclic
            const encBad = QuickJsRunner.encodeSettlement("x", cyclic)
            return decodedOk.refusal === undefined && decodedBad.refusal !== undefined &&
              encBad.includes("cannot be encoded")
          }),
        { seed: seed + 4, executions: Math.min(executions, 60) }
      )
    )
    assertPassed(report)

    // Exercise ScriptRunner.layerNoop & QuickJsRunner.cachedLoad retry after rejection
    const noopRes = await Effect.runPromise(
      Effect.result(
        Effect.flatMap(ScriptRunner.ScriptRunner, (r) => r.run(Script.make("return done(1)"), () => Effect.succeed(1)))
          .pipe(Effect.provide(ScriptRunner.layerNoop()))
      )
    )
    expect(Result.isFailure(noopRes)).toBe(true)

    let loadCalls = 0
    const loader = QuickJsRunner.cachedLoad(async () => {
      loadCalls += 1
      if (loadCalls === 1) throw new Error("transient")
      return "loaded"
    })
    await expect(loader()).rejects.toThrow("transient")
    expect(await loader()).toBe("loaded")
    expect(await loader()).toBe("loaded")
    expect(loadCalls).toBe(2)
  })

  it("MemoryEntries, ModelAuthor, RegistryCatalog, and SubChains uphold contracts over real layers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        key: Schema.Literals(["plan-a", "plan-b", "notes-1"]),
        bank: Schema.Literals(["worldview", "b", "disallowed"]),
        tag: Schema.Literals(["scope:release", "branch:main", "source:fuzz", "invalid-bare-tag"]),
        modelFails: Schema.Boolean,
        markdownFlow: Schema.Boolean,
        maxDepth: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2 })))
      })
    )

    const memServices = Layer.provideMerge(RecallKeyword.layer, TestMemory.layerWithDatabase)
    const policy = { banks: ["worldview", "b"], maxTokens: 1000 } as const

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ key, bank, tag, modelFails, markdownFlow, maxDepth }) =>
          Effect.gen(function*() {
            // 1. MemoryEntries over real SQLite TestMemory
            const memOk = yield* Effect.scoped(
              Effect.gen(function*() {
                const entries = yield* MemoryEntries.make(policy)
                const remember = entries[0]!
                const recall = entries[1]!
                const remRes = yield* Effect.result(
                  remember.handler({ bank, key, tags: [tag], text: `fuzz text for ${key}` })
                )
                const shouldFail = bank === "disallowed" || tag === "invalid-bare-tag" || tag === "source:fuzz"
                if (shouldFail) return Result.isFailure(remRes)
                if (Result.isFailure(remRes)) throw new Error(`remRes failed: ${JSON.stringify(remRes)}`)
                const recRes = yield* Effect.result(recall.handler({ banks: [bank], query: key }))
                if (Result.isFailure(recRes)) throw new Error(`recRes failed: ${JSON.stringify(recRes)}`)
                return Array.isArray(recRes.success)
              }).pipe(Effect.provide(memServices))
            )
            if (!memOk) throw new Error("memOk failed")

            // Digests deterministic
            const rememberContract = {
              name: Flows.rememberName,
              description: Flows.rememberDescription,
              effects: { ...Flows.rememberEffects },
              input: Flows.RememberInput,
              output: Flows.RememberOutput
            }
            const recallContract = {
              name: Flows.recallName,
              description: Flows.recallDescription,
              effects: { ...Flows.recallEffects },
              input: Flows.RecallInput,
              output: Flows.RecallOutput
            }
            const d1 = MemoryEntries.bindingDigest(rememberContract, policy)
            const d2 = MemoryEntries.bindingDigest(rememberContract, policy)
            if (d1 !== d2 || MemoryEntries.contractDigest(recallContract) === "") return false

            // 2. ModelAuthor over real Model.make stream
            const modelLayer = Layer.succeed(Model.Model)(
              Model.make({
                stream: () =>
                  modelFails
                    ? Stream.fail(
                      new ModelError.ModelError({
                        code: "transport",
                        message: "down"
                      })
                    )
                    : Stream.fromIterable([
                      { id: "t0", type: "text-start" as const },
                      { id: "t0", text: flow("return done(42)"), type: "text-delta" as const },
                      { id: "t0", type: "text-end" as const },
                      { stopReason: "stop" as const, type: "settle" as const }
                    ])
              })
            )
            const authorRes = yield* Effect.result(
              Effect.flatMap(Author.Author, (a) => a.author({ prefix: "sys", context: ["goal"] })).pipe(
                Effect.provide(
                  ModelAuthor.layer({ modelId: "test:model" }).pipe(
                    Layer.provide(ModelAuthor.layerStepUnsealed),
                    Layer.provide(modelLayer)
                  )
                )
              )
            )
            if (modelFails ? Result.isSuccess(authorRes) : Result.isFailure(authorRes)) {
              throw new Error(`authorRes mismatch: ${JSON.stringify(authorRes)}`)
            }
            if (Author.contextOf({ context: ["a", { b: 1 }] }).length !== 2) throw new Error("contextOf mismatch")

            // 3. RegistryCatalog projection
            const desc = new Descriptor.FlowDescriptor({
              body: markdownFlow
                ? new Descriptor.BodyRefMarkdown({ baseDirectory: "/flows", path: "/flows/f/flow.mdx" })
                : new Descriptor.BodyRefModule({ path: "/flows/f/flow.ts" }),
              capabilities: ["fs:read:**"],
              description: "desc",
              effects: { mode: "expected", onConflict: "serialize", reads: ["**"], tier: "sealed", writes: [] },
              flows: [],
              frontmatter: {},
              input: new Descriptor.SchemaRefNone(),
              model: Option.none(),
              modelInvocable: true,
              name: "f",
              output: new Descriptor.SchemaRefNone(),
              path: "/flows/f",
              placement: Option.none(),
              provenance: { root: "/flows", source: "test" }
            })
            const regLayer = Layer.succeed(Registry.Registry)(
              Registry.makeNoop({
                list: () => Effect.succeed([desc]),
                visible: () => Effect.succeed([desc]),
                getOption: (n) => Effect.succeed(n === "f" ? Option.some(desc) : Option.none())
              })
            )
            const cat = yield* RegistryCatalog.make({
              implementations: new Map([["f", (p) => Effect.succeed({ ok: p })]]),
              prompt: (rendered) => Effect.succeed(`ran:${rendered}`)
            }).pipe(Effect.provide(regLayer))
            const fEntry = cat.lookup("f")
            if (fEntry === undefined || RegistryCatalog.declarationDigest(desc) === "") {
              throw new Error("fEntry missing")
            }
            const fRes = yield* Effect.result(fEntry.handler({ args: "hi" }))
            if (Result.isFailure(fRes)) throw new Error(`fRes failed: ${JSON.stringify(fRes)}`)

            // 4. SubChains recursive entry + maxDepth
            const subDigest = SubChains.contractDigest({ entries: [], maxDepth })
            if (subDigest === "") return false
            const subBase = Layer.mergeAll(
              Journal.layerMemory(),
              Author.layerMock([
                flow(`const r = await ctx.call("agent", { goal: "child" }); return done(r)`),
                flow(`return done("leaf")`)
              ]),
              ScriptRunner.layerInProcess,
              Authorize.layerAllowAll
            )
            const subCat = SubChains.layer({ entries: [], maxDepth }).pipe(Layer.provide(subBase))
            const subOut = yield* Chain.run({ goal: "parent" }).pipe(Effect.provide(Layer.mergeAll(subBase, subCat)))
            if (maxDepth === 0) {
              // Child fails maxDepth; parent catches or gets observation / completes
              return subOut._tag === "Done" || subOut._tag === "Park"
            }
            return subOut._tag === "Done"
          }),
        { seed: seed + 5, executions: Math.min(executions, 40) }
      )
    )
    assertPassed(report)
  })
})
