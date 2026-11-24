import { Fuzz } from "@smthrs/fuzz"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import { NodeHost } from "@smthrs/platform-node"
import { Arbitrary, Cause, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as BuiltinScript from "../src/BuiltinScript.ts"
import * as CachedEvaluator from "../src/CachedEvaluator.ts"
import * as Fixture from "../src/Fixture.ts"
import * as FixtureStore from "../src/FixtureStore.ts"
import * as ModelServer from "../src/ModelServer.ts"
import * as ModelServerCli from "../src/ModelServerCli.ts"
import * as ProcessTable from "../src/ProcessTable.ts"
import * as RealCliDriver from "../src/RealCliDriver.ts"
import * as ScriptedModel from "../src/ScriptedModel.ts"
import * as TurnGate from "../src/TurnGate.ts"
import * as TurnLog from "../src/TurnLog.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const pureExecs = Math.max(20, Math.min(baseExecutions, 120))
const ioExecs = Math.max(8, Math.min(Math.ceil(baseExecutions / 6), 24))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const property = <A, E>(
  input: Arbitrary.Arbitrary<A>,
  executions: number,
  check: (value: A) => Effect.Effect<void, E, never>
) =>
  Effect.runPromise(Fuzz.run(input, (value) => check(value).pipe(Effect.as(true)), { seed, executions }))
    .then((report) => {
      expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
    })

const intBetween = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))

const safeWord = Arbitrary.schema(
  Schema.Literals(["alpha", "beta-1", "t_2", "file.md", "docs/note.md", "a1.b2"])
)

const bool = Arbitrary.schema(Schema.Boolean)

const makeReq = (systemText: string, userText: string, modelId = "test-model") =>
  ModelRequest.make({
    modelId,
    system: systemText === "" ? [] : [{ type: "text", text: systemText }],
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    tools: [{ name: "read", description: "read file", parameters: {} }],
    params: {}
  })

describe("Wave-6 testing scripts, models, server, CLI, process table & CLI driver fuzz properties", () => {
  it("fuzzes BuiltinScript tag/directives roundtrip, validation errors, all steps, wiki review, conflicts, and evaluator", () =>
    property(
      Arbitrary.all({
        ask: bool,
        fail: bool,
        failOnce: bool,
        restore: bool,
        fixed: bool,
        noResolve: bool,
        flowEdit: bool,
        changelog: bool,
        probeReview: bool,
        hasHold: bool,
        holdKey: safeWord,
        hasFile: bool,
        fileName: safeWord,
        hasUid: bool,
        uid: intBetween(0, 65534),
        payloadStyle: intBetween(0, 2),
        requiredChecks: intBetween(0, 3),
        answerStyle: intBetween(0, 2),
        wikiMode: intBetween(0, 4),
        greeting: safeWord
      }),
      pureExecs,
      (s) =>
        Effect.sync(() => {
          const dirs: BuiltinScript.Directives = {
            ask: s.ask,
            fail: s.fail,
            failOnce: s.failOnce,
            restore: s.restore,
            fixed: s.fixed,
            noResolve: s.noResolve,
            flowEdit: s.flowEdit,
            changelog: s.changelog,
            probeReview: s.probeReview,
            hold: s.hasHold ? s.holdKey.replace(/\//g, "_") : undefined,
            file: s.hasFile ? s.fileName : undefined,
            observeUid: s.hasUid ? s.uid : undefined
          }
          const tagged = BuiltinScript.tag(dirs)
          const parsed = BuiltinScript.directives(tagged)
          expect(parsed.ask).toBe(s.ask)
          expect(parsed.fail).toBe(s.fail && !s.fixed)
          expect(parsed.failOnce).toBe(s.failOnce && !s.fixed)
          expect(parsed.restore).toBe(s.restore)
          expect(parsed.fixed).toBe(s.fixed)
          expect(parsed.noResolve).toBe(s.noResolve)
          expect(parsed.flowEdit).toBe(s.flowEdit)
          expect(parsed.changelog).toBe(s.changelog)
          expect(parsed.probeReview).toBe(s.probeReview)
          expect(parsed.hold).toBe(dirs.hold)
          expect(parsed.file).toBe(dirs.file)
          expect(parsed.observeUid).toBe(dirs.observeUid)
          // Non-string input to directives
          expect(BuiltinScript.directives([tagged]).ask).toBe(s.ask)
          expect(BuiltinScript.directives(undefined).ask).toBe(false)

          // Invalid tag inputs throw
          expect(() => BuiltinScript.tag({ hold: "bad key!" })).toThrow()
          expect(() => BuiltinScript.tag({ file: "bad file!" })).toThrow()
          expect(() => BuiltinScript.tag({ observeUid: -1 })).toThrow()
          expect(() => BuiltinScript.tag({ observeUid: 1.5 })).toThrow()

          const validTodoFlow = "export default () => Request.call(input)"
          const script = BuiltinScript.make({
            greeting: s.greeting,
            todoFlow: validTodoFlow,
            holdAt: ["coding/draft-plan"],
            reviewFindings: [{
              path: "src/a.ts",
              startLine: 1,
              endLine: 2,
              content: "issue",
              existingCode: "const x = 1",
              severity: "high",
              category: "bug",
              confidence: "high",
              reason: "real bug"
            }]
          })

          const wrapPayload = (
            teaching: string,
            payload: Record<string, unknown>
          ): ReadonlyArray<BuiltinScript.ChatMessage> => {
            if (s.payloadStyle === 0) {
              return [
                {
                  role: "system",
                  content: [{ text: `${teaching}\nThe task for this run: ${JSON.stringify(payload)} trailing` }]
                },
                { role: "user", content: "go" }
              ]
            }
            if (s.payloadStyle === 1) {
              const sections = Object.entries(payload).map(([k, v]) => `## ${k}\n\n${JSON.stringify(v)}`).join("\n\n")
              return [
                { role: "system", content: `${teaching}\n# Arguments\n\n${sections}` },
                { role: "user", content: [{ text: "run" }, { notText: 1 }] }
              ]
            }
            return [
              { role: "system", content: teaching },
              { role: "user", content: `prefix ${JSON.stringify(payload)} suffix` }
            ]
          }

          // 1. coding/review-request
          const r1 = script.respond(wrapPayload(BuiltinScript.teachings["coding/review-request"], {
            input: { prompt: `Do work ${tagged}` }
          }))
          expect(r1?.name).toBe("coding/review-request")
          expect(r1?.text.includes(BuiltinScript.QUESTION)).toBe(s.ask)

          // 2. coding/draft-plan
          const checks = Array.from({ length: s.requiredChecks + 1 }, (_, i) => ({
            id: `chk-${i}`,
            required: i < s.requiredChecks
          }))
          const answer = s.answerStyle === 0 ? "hello-ans" : s.answerStyle === 1 ? { text: "obj-ans" } : { other: 1 }
          const r2 = script.respond(wrapPayload(BuiltinScript.teachings["coding/draft-plan"], {
            input: { prompt: `Plan ${tagged}`, feedback: "fb" },
            answer,
            context: { head: { changeId: "chg-1" }, checks }
          }))
          expect(r2?.name).toBe("coding/draft-plan")
          expect(r2?.hold).toBe(dirs.hold)

          // 3. coding/edit-atom (both plain and JSON-wrapped atom intent)
          const editIntent = `${tagged} [ANSWER "quoted \\"ok\\""]`
          const atomField = s.payloadStyle === 0 ? JSON.stringify({ atom: editIntent }) : editIntent
          const r3 = script.respond(wrapPayload(BuiltinScript.teachings["coding/edit-atom"], {
            atom: { intent: atomField }
          }))
          expect(r3?.name).toBe("coding/edit-atom")
          expect(r3?.hold).toBe(dirs.hold)

          // flowEdit error cases
          if (s.flowEdit) {
            const noFlowScript = BuiltinScript.make({ greeting: s.greeting })
            expect(() =>
              noFlowScript.respond(wrapPayload(BuiltinScript.teachings["coding/edit-atom"], {
                atom: { intent: "[FLOWEDIT]" }
              }))
            ).toThrow()
            const badFlowScript = BuiltinScript.make({ todoFlow: "no match here" })
            expect(() =>
              badFlowScript.respond(wrapPayload(BuiltinScript.teachings["coding/edit-atom"], {
                atom: { intent: "[FLOWEDIT]" }
              }))
            ).toThrow()
          }

          // 4. coding/select-owner-repair
          const r4 = script.respond(wrapPayload(BuiltinScript.teachings["coding/select-owner-repair"], {
            nested: [{ changeId: "chg-repair", intent: `[FAIL] [FAILONCE] ${s.fixed ? "[FIXED]" : ""}` }]
          }))
          expect(r4?.name).toBe("coding/select-owner-repair")
          expect(r4?.text).toContain("RESTORE")

          // 5. coding/review-final-history & review-lens & review/change
          const r5 = script.respond(wrapPayload(BuiltinScript.teachings["coding/review-final-history"], {
            request: { outcome: { result: { changes: [{ implementation: { atoms: [{ changeId: "c1" }] } }] } } }
          }))
          expect(r5?.name).toBe("coding/review-final-history")
          const r6 = script.respond([{ role: "system", content: BuiltinScript.teachings["coding/review-lens"] }])
          expect(r6?.name).toBe("coding/review-lens")
          const r7 = script.respond([
            { role: "system", content: BuiltinScript.teachings["review/change"] },
            { role: "user", content: s.probeReview ? "[PROBEREVIEW]" : "normal" }
          ])
          expect(r7?.name).toBe("review/change")
          expect(r7?.text.includes("REVIEW_BOUNDARY_TOOL_REFUSALS")).toBe(s.probeReview)

          // 6. review/file & review/verify
          const r8 = script.respond([
            { role: "system", content: BuiltinScript.teachings["review/file"] },
            { role: "user", content: "File src/a.ts has const x = 1" }
          ])
          expect(r8?.name).toBe("review/file")
          expect(r8?.text).toContain("const x = 1")
          const r9 = script.respond([{ role: "system", content: BuiltinScript.teachings["review/verify"] }])
          expect(r9?.name).toBe("review/verify")

          // 7. conflict resolution (uses remembered fileDirectives or prompt directive)
          const targetFile = dirs.file ?? "JOURNEY.md"
          const r10 = script.respond([
            { role: "user", content: `${BuiltinScript.teachings.conflict} "${targetFile}"` }
          ])
          expect(r10?.name).toBe(s.noResolve ? "conflict/noresolve" : "conflict/resolve")

          // 8. wiki/review-page
          const wikiSources = [
            { path: "src/own.ts", lines: "1 | own line alpha\n2 |    \n3 | own line beta" },
            { path: "src/ref.ts", lines: "1 | export const helloWorld = true\r\n2 | second line" }
          ]
          const wikiSection = s.wikiMode === 0
            ? { id: "s1", markdown: "See [ref](../sources/src/ref.ts#L1) and [ref](../sources/src/ref.ts#L1)" }
            : s.wikiMode === 1
            ? { id: "s2", markdown: "Quotes export const helloWorld = true verbatim" }
            : s.wikiMode === 2
            ? { id: "s3", markdown: "## src/ref.ts" }
            : s.wikiMode === 3
            ? { id: "s4", markdown: "## Other Heading" }
            : { id: "s5", markdown: "Uncited paragraph with no matching text." }
          const wikiEvidence = {
            spec: { kind: s.wikiMode % 2 === 0 ? "current" : "intent", document: "src/own.ts" },
            sources: wikiSources,
            sections: [wikiSection]
          }
          const r11 = script.respond([{
            role: "system",
            content: `${BuiltinScript.teachings["wiki/review-page"]}\nThe task for this run:\n${
              JSON.stringify(wikiEvidence)
            }`
          }])
          expect(r11?.name).toBe("wiki/review-page")
          // Malformed wiki evidence returns undefined
          expect(script.respond([{
            role: "system",
            content: `${BuiltinScript.teachings["wiki/review-page"]}\nThe task for this run:\n{broken`
          }])).toBeUndefined()

          // 9. Unknown step returns undefined; unscripted produces cell
          expect(script.respond([{ role: "system", content: "totally unknown" }, { role: "user", content: 123 }]))
            .toBeUndefined()
          const unscriptedReply = BuiltinScript.unscripted(makeReq("sys", "usr"))
          expect(unscriptedReply?.name).toBe("unscripted")

          // 10. isJudgement & answer & evaluator
          expect(BuiltinScript.isJudgement({ route: {}, other: {} })).toBe(true)
          expect(BuiltinScript.isJudgement({ needed_1: {} })).toBe(true)
          expect(BuiltinScript.isJudgement({ unrelated: {} })).toBe(false)
          expect(BuiltinScript.isJudgement(null)).toBe(false)
          expect(BuiltinScript.answer("complete", { type: "boolean" })).toStrictEqual({
            type: "boolean",
            probability: 0.99
          })
          expect(BuiltinScript.answer("overclaims", { type: "boolean" })).toStrictEqual({
            type: "boolean",
            probability: 0.01
          })
          expect(BuiltinScript.answer("confident", { type: "score", criteria: ["a", "b", "c"] })).toStrictEqual({
            type: "score",
            score: 2
          })
          expect(BuiltinScript.answer("other", { type: "score" })).toStrictEqual({ type: "score", score: 0 })
          expect(BuiltinScript.answer("route", { type: "choice", criteria: { implement: "go", skip: "no" } }))
            .toStrictEqual({ type: "choice", choice: "implement" })
          expect(BuiltinScript.answer("support", { type: "choice", criteria: { supports: "yes" } }))
            .toStrictEqual({ type: "choice", choice: "supports" })
          expect(() => BuiltinScript.answer("bad", { type: "choice", criteria: { nope: "x" } })).toThrow()
          expect(() => BuiltinScript.answer("bad", { type: "bogus" })).toThrow()
        })
    ))

  it("fuzzes ScriptedModel, TurnGate, TurnLog, and CachedEvaluator end-to-end", () =>
    property(
      Arbitrary.all({
        key: safeWord,
        replyText: safeWord,
        modelId: safeWord,
        shouldFail: bool,
        withFile: bool,
        withMessages: bool,
        errorCode: Arbitrary.schema(Schema.Literals(["invalid_question", "timeout", "unreachable", "refused"]))
      }),
      ioExecs,
      (s) =>
        Effect.gen(function*() {
          const dir = mkdtempSync(join(tmpdir(), "testing-wave6-turnlog-"))
          const logFile = join(dir, "turns.jsonl")
          try {
            const gate = yield* TurnGate.make()
            const log = yield* TurnLog.make({
              file: s.withFile ? logFile : undefined,
              messages: s.withMessages
            })

            // Hold and interrupt a waiter cleanly
            const interruptedFiber = yield* Effect.forkDetach(gate.hold(`intr-${s.key}`))
            yield* Effect.yieldNow
            yield* Fiber.interrupt(interruptedFiber)
            expect(yield* gate.held()).not.toContain(`intr-${s.key}`)

            // ScriptedModel.fromTurns + gate + log + fallback + error
            const fallback = Model.make({
              providerName: "fallback-prov",
              stream: () =>
                Stream.fromIterable<ModelEvent.ModelEvent>([
                  { type: "text-start", id: "fb" },
                  { type: "text-delta", id: "fb", text: "from-fallback" },
                  { type: "text-end", id: "fb" },
                  { type: "settle", stopReason: "stop" }
                ])
            })
            const scripted = ScriptedModel.make({
              script: ScriptedModel.fromTurns([
                {
                  name: "held-step",
                  when: (req) => req.modelId === `hold-${s.modelId}`,
                  reply: () => s.replyText,
                  hold: () => s.key
                },
                {
                  name: "boom-step",
                  when: (req) => req.modelId === "boom",
                  reply: () => {
                    throw new Error("script-refused")
                  }
                }
              ]),
              fallback,
              gate,
              log
            })
            expect(scripted.providerName).toBe("fallback-prov")

            // Held turn blocks until released; release is sticky
            const heldFiber = yield* Effect.forkDetach(
              Stream.runCollect(scripted.stream(makeReq("s", "u", `hold-${s.modelId}`)))
            )
            for (let i = 0; i < 50 && !(yield* gate.held()).includes(s.key); i++) yield* Effect.sleep("2 millis")
            expect(yield* gate.held()).toContain(s.key)
            yield* gate.release(s.key)
            const heldEvents = yield* Fiber.join(heldFiber)
            expect(heldEvents.some((e) => e.type === "text-delta" && e.text === s.replyText)).toBe(true)
            // Sticky second call does not wait
            const secondEvents = yield* Stream.runCollect(scripted.stream(makeReq("s", "u", `hold-${s.modelId}`)))
            expect(secondEvents.length).toBeGreaterThan(0)

            // Fallback path
            const fbEvents = yield* Stream.runCollect(scripted.stream(makeReq("s", "u", "other-model")))
            expect(fbEvents.some((e) => e.type === "text-delta" && e.text === "from-fallback")).toBe(true)

            // Throwing script yields ModelError invalid_request
            const boomExit = yield* Effect.exit(Stream.runCollect(scripted.stream(makeReq("s", "u", "boom"))))
            expect(Exit.isFailure(boomExit)).toBe(true)

            // Unscripted without fallback dies
            const noFb = ScriptedModel.make({ script: () => undefined })
            const unscriptedExit = yield* Effect.exit(Stream.runCollect(noFb.stream(makeReq("s", "u", "miss"))))
            expect(Exit.isFailure(unscriptedExit)).toBe(true)

            // TurnGate.model & TurnLog.model wrappers
            const gatedModel = TurnGate.model(TurnLog.model(fallback, { log, step: () => "wrapped" }), {
              gate,
              key: (req) => (req.modelId === "pass" ? undefined : s.key)
            })
            yield* Stream.runCollect(gatedModel.stream(makeReq("s", "u", "pass")))
            yield* Stream.runCollect(gatedModel.stream(makeReq("s", "u", "gated")))

            // CachedEvaluator + TurnLog.evaluator (record then replay)
            const store = yield* FixtureStore.makeMemory()
            let liveCalls = 0
            const liveEval: Evaluator.Evaluator = {
              evaluate: () => {
                liveCalls++
                if (s.shouldFail) {
                  return Effect.fail(
                    new Evaluator.EvaluatorError({
                      code: s.errorCode,
                      message: "eval failed",
                      status: 503,
                      resetAtEpochMillis: 12345
                    })
                  )
                }
                return Effect.succeed({
                  answers: { complete: { type: "boolean", probability: 0.9 } },
                  confidence: { complete: 0.9 },
                  usage: { inputTokens: 10, outputTokens: 2 },
                  latencyMs: 5
                })
              }
            }
            const cached = TurnLog.evaluator(
              CachedEvaluator.make({
                fixture: store,
                live: liveEval,
                modelId: s.modelId
              }),
              { log }
            )
            const evalReq: Evaluator.Request = {
              state: { key: s.key },
              questions: {
                complete: { type: "boolean", instructions: "done?", criteria: { true: "yes", false: "no" } }
              }
            }
            const res1 = yield* Effect.exit(cached.evaluate(evalReq))
            const res2 = yield* Effect.exit(
              Effect.provide(
                Effect.flatMap(Evaluator.Evaluator, (ev) => ev.evaluate(evalReq)),
                CachedEvaluator.layer({ fixture: store, modelId: s.modelId })
              )
            )
            expect(liveCalls).toBe(1)
            expect(Exit.isSuccess(res1)).toBe(!s.shouldFail)
            expect(Exit.isSuccess(res2)).toBe(!s.shouldFail)

            // Non-JSON state fails with invalid_question
            const badEval = yield* Effect.exit(
              cached.evaluate({
                state: { big: BigInt(1) },
                questions: {}
              })
            )
            expect(Exit.isFailure(badEval)).toBe(true)

            const summary = yield* log.summary()
            expect(summary.total).toBeGreaterThan(0)
            const entries = yield* log.entries()
            expect(entries.length).toBe(summary.total)
            if (s.withFile) {
              const lines = readFileSync(logFile, "utf8").trim().split("\n")
              expect(lines.length).toBe(entries.length)
            }
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        })
    ), 120_000)

  it(
    "fuzzes ModelServer HTTP routes, SSE streaming, heartbeats, errors, and ModelServerCli parse/serve/run",
    () =>
      property(
        Arbitrary.all({
          text: safeWord,
          toolName: safeWord,
          holdKey: safeWord,
          stopReason: Arbitrary.schema(
            Schema.Literals(["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"])
          ),
          evalStatusCode: Arbitrary.schema(Schema.Literals(["invalid_question", "timeout", "unreachable"])),
          withHeartbeat: bool
        }),
        Math.min(ioExecs, 10),
        (s) =>
          Effect.gen(function*() {
            const dir = mkdtempSync(join(tmpdir(), "testing-wave6-modelserver-"))
            try {
              const cleanKey = s.holdKey.replace(/[^A-Za-z0-9._-]/g, "_")
              const gate = yield* TurnGate.make()
              const log = yield* TurnLog.make()

              const backingModel = Model.make({
                stream: (req) => {
                  if (req.modelId === "die-before") {
                    return Stream.die(new Error("unrecorded")) as Stream.Stream<ModelEvent.ModelEvent, ModelError>
                  }
                  if (req.modelId === "die-mid") {
                    return Stream.concat(
                      Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "text-delta", id: "1", text: "part" }]),
                      Stream.die(new Error("mid-die"))
                    )
                  }
                  if (req.modelId === "fail-before") {
                    return Stream.fail(
                      new ModelError({
                        code: "rate_limited",
                        providerCode: "429",
                        message: "slow down",
                        httpStatus: 429
                      })
                    )
                  }
                  if (req.modelId === "fail-mid") {
                    return Stream.concat(
                      Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "text-delta", id: "1", text: "part" }]),
                      Stream.fail(new ModelError({ code: "unknown", message: "mid-fail" }))
                    )
                  }
                  if (req.modelId === "held-heartbeat") {
                    return Stream.unwrap(
                      Effect.sleep("40 millis").pipe(
                        Effect.as(Stream.fromIterable<ModelEvent.ModelEvent>([
                          { type: "text-delta", id: "1", text: s.text },
                          { type: "settle", stopReason: "stop" }
                        ]))
                      )
                    )
                  }
                  return Stream.fromIterable<ModelEvent.ModelEvent>([
                    { type: "text-start", id: "1" },
                    { type: "text-delta", id: "1", text: s.text },
                    { type: "tool-call-start", id: "tc1", name: s.toolName },
                    { type: "tool-call-delta", id: "tc1", arguments: "{\"a\":1}" },
                    {
                      type: "usage",
                      inputTokens: 12,
                      outputTokens: 5,
                      totalTokens: 17,
                      cachedInputTokens: 3,
                      costUsd: 0.001
                    },
                    { type: "settle", stopReason: s.stopReason, responseId: "resp-1", servedTier: "default" },
                    { type: "usage", inputTokens: 12, outputTokens: 5, totalTokens: 17 }
                  ])
                }
              })

              const backingEvaluator: Evaluator.Evaluator = {
                evaluate: (req) => {
                  if ("die" in req.questions) return Effect.die(new Error("unrecorded-eval"))
                  if ("fail" in req.questions) {
                    return Effect.fail(new Evaluator.EvaluatorError({ code: s.evalStatusCode, message: "eval err" }))
                  }
                  return Effect.succeed({
                    answers: { complete: { type: "boolean", probability: 0.95 } },
                    usage: { inputTokens: 5, outputTokens: 1 },
                    confidence: { complete: 0.95 },
                    latencyMs: 0
                  })
                }
              }

              const scope = yield* Scope.make()
              try {
                const server = yield* Scope.provide(
                  ModelServer.make({
                    model: TurnLog.model(backingModel, { log, step: (r) => r.modelId }),
                    evaluator: backingEvaluator,
                    gate,
                    log,
                    heartbeatMs: s.withHeartbeat ? 15 : 15_000
                  }),
                  scope
                )

                // 1. Health + 404 + control routes
                const health = yield* Effect.promise(() => fetch(`${server.url}${ModelServer.paths.health}`))
                expect(health.status).toBe(200)
                const notFound = yield* Effect.promise(() => fetch(`${server.url}/nope`))
                expect(notFound.status).toBe(404)
                const heldRes = yield* Effect.promise(() => fetch(`${server.url}${ModelServer.paths.held}`))
                expect(heldRes.status).toBe(200)
                const relRes = yield* Effect.promise(() =>
                  fetch(`${server.url}${ModelServer.paths.release}${cleanKey}`, { method: "POST" })
                )
                expect(relRes.status).toBe(204)

                // 2. Chat valid with all message roles + max_completion_tokens alias
                const chatBody = {
                  model: "ok-model",
                  stream: true,
                  max_completion_tokens: 64,
                  temperature: 0.5,
                  top_p: 0.9,
                  reasoning_effort: "low",
                  tools: [{ type: "function", function: { name: s.toolName, description: "d", parameters: {} } }],
                  messages: [
                    { role: "system", content: "sys" },
                    { role: "user", content: "hi" },
                    {
                      role: "assistant",
                      content: "thinking",
                      tool_calls: [{ id: "tc1", type: "function", function: { name: s.toolName, arguments: "{}" } }]
                    },
                    { role: "tool", tool_call_id: "tc1", content: "r1" },
                    { role: "tool", tool_call_id: "tc2", content: "r2" }
                  ]
                }
                const okChat = yield* Effect.promise(() =>
                  fetch(`${server.url}${ModelServer.paths.chat}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(chatBody)
                  }).then((r) => r.text().then((body) => ({ status: r.status, body })))
                )
                expect(okChat.status).toBe(200)
                expect(okChat.body).toContain("data: [DONE]")

                // Heartbeat SSE comment when slow
                if (s.withHeartbeat) {
                  const hbChat = yield* Effect.promise(() =>
                    fetch(`${server.url}${ModelServer.paths.chat}`, {
                      method: "POST",
                      body: JSON.stringify({
                        model: "held-heartbeat",
                        stream: true,
                        messages: [{ role: "user", content: "wait" }]
                      })
                    }).then((r) => r.text())
                  )
                  expect(hbChat).toContain(": held")
                }

                // Chat 400s (bad JSON, response_format)
                const badJson = yield* Effect.promise(() =>
                  fetch(`${server.url}${ModelServer.paths.chat}`, { method: "POST", body: "{not-json" })
                )
                expect(badJson.status).toBe(400)
                const respFmt = yield* Effect.promise(() =>
                  fetch(`${server.url}${ModelServer.paths.chat}`, {
                    method: "POST",
                    body: JSON.stringify({
                      model: "ok",
                      stream: true,
                      response_format: { type: "json_object" },
                      messages: [{ role: "user", content: "hi" }]
                    })
                  })
                )
                expect(respFmt.status).toBe(400)

                // Chat 501 / mid-stream die / 429 / mid-stream error
                for (
                  const [m, expectedStatus] of [["die-before", 500], ["die-mid", 200], ["fail-before", 429], [
                    "fail-mid",
                    200
                  ]] as const
                ) {
                  const res = yield* Effect.promise(() =>
                    fetch(`${server.url}${ModelServer.paths.chat}`, {
                      method: "POST",
                      body: JSON.stringify({ model: m, stream: true, messages: [{ role: "user", content: "x" }] })
                    })
                  )
                  expect(res.status).toBe(expectedStatus)
                  yield* Effect.promise(() => res.text())
                }

                // Evaluation routes (200, 400, 501, error)
                const evOk = yield* Effect.promise(() =>
                  fetch(`${server.url}${ModelServer.paths.evaluation}`, {
                    method: "POST",
                    body: JSON.stringify({
                      state: { a: 1 },
                      questions: {
                        complete: { type: "boolean", instructions: "q", criteria: { true: "yes", false: "no" } }
                      }
                    })
                  })
                )
                expect(evOk.status).toBe(200)
                const evBad = yield* Effect.promise(() =>
                  fetch(`${server.url}${ModelServer.paths.evaluation}`, { method: "POST", body: "{}" })
                )
                expect(evBad.status).toBe(400)
                const evDie = yield* Effect.promise(() =>
                  fetch(`${server.url}${ModelServer.paths.evaluation}`, {
                    method: "POST",
                    body: JSON.stringify({
                      state: {},
                      questions: { die: { type: "boolean", instructions: "q", criteria: { true: "yes", false: "no" } } }
                    })
                  })
                )
                expect(evDie.status).toBe(500)
                const evFail = yield* Effect.promise(() =>
                  fetch(`${server.url}${ModelServer.paths.evaluation}`, {
                    method: "POST",
                    body: JSON.stringify({
                      state: {},
                      questions: {
                        fail: { type: "boolean", instructions: "q", criteria: { true: "yes", false: "no" } }
                      }
                    })
                  })
                )
                expect([400, 502, 504]).toContain(evFail.status)

                // Turns summary
                const turnsRes = (yield* Effect.promise(() =>
                  fetch(`${server.url}${ModelServer.paths.turns}`).then((r) => r.json())
                )) as { total: number }
                expect(turnsRes.total).toBeGreaterThan(0)

                // ModelServerCli.parse validation + serve + run (record from upstream server, then replay!)
                const flowPath = join(dir, "flow.ts")
                writeFileSync(flowPath, "export default () => Request.call(input)")
                const cfgPath = join(dir, "script-config.json")
                writeFileSync(cfgPath, JSON.stringify({ greeting: s.text, todoFlow: "flow.ts" }))
                const badCfgPath = join(dir, "bad.json")
                writeFileSync(badCfgPath, "[]")
                const missingFlowCfg = join(dir, "missing-flow.json")
                writeFileSync(missingFlowCfg, JSON.stringify({ todoFlow: "nope.ts" }))

                const parsedBuiltin = ModelServerCli.parse(
                  [
                    "--script",
                    "builtin",
                    "--script-config",
                    cfgPath,
                    "--hold",
                    `HOLD:(${cleanKey})`,
                    "--normalize",
                    "foo",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "0",
                    "--trace",
                    join(dir, "trace.jsonl"),
                    "--trace-messages"
                  ],
                  {}
                )
                expect(parsedBuiltin.script?.greeting).toBe(s.text)

                for (
                  const badArgs of [
                    ["--bogus"],
                    ["--fixture"],
                    ["--script", "other"],
                    ["--script-config", cfgPath],
                    ["--trace-messages", "--script", "builtin"],
                    [],
                    ["--fixture", "a.json", "--upstream", "http://127.0.0.1:1"],
                    ["--script", "builtin", "--port", "abc"],
                    ["--fixture", "a.json", "--record"],
                    ["--fixture", "a.json", "--record", "--upstream", "http://127.0.0.1:1"],
                    ["--fixture", "a.json", "--record", "--upstream", "http://127.0.0.1:1", "--key-env", "MISSING_KEY"],
                    ["--script", "builtin", "--hold", "["],
                    ["--script", "builtin", "--hold", "no-group"],
                    ["--script", "builtin", "--script-config", join(dir, "missing.json")],
                    ["--script", "builtin", "--script-config", badCfgPath],
                    ["--script", "builtin", "--script-config", missingFlowCfg]
                  ]
                ) {
                  expect(() =>
                    ModelServerCli.parse(badArgs, {})
                  ).toThrow()
                }

                // ModelServerCli.run in --record mode against our real loopback server, then replay!
                const fixturePath = join(dir, "recorded.json")
                let stopRec!: () => void
                const stoppedRec = new Promise<void>((resolve) => {
                  stopRec = resolve
                })
                let printedUrl = ""
                const recRun = ModelServerCli.run(
                  [
                    "--fixture",
                    fixturePath,
                    "--record",
                    "--upstream",
                    server.url,
                    "--upstream-model",
                    "ok-model",
                    "--key-env",
                    "UP_KEY",
                    "--normalize",
                    "nonce-[0-9]+",
                    "--hold",
                    "NEVER_MATCH_([a-z]+)",
                    "--trace",
                    join(dir, "rec-trace.jsonl")
                  ],
                  { UP_KEY: "test-secret-key" },
                  {
                    print: (line) => {
                      printedUrl = (JSON.parse(line) as { url: string }).url
                      void fetch(`${printedUrl}${ModelServer.paths.chat}`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                          model: "client-m",
                          stream: true,
                          messages: [{ role: "user", content: "nonce-42" }]
                        })
                      }).then((r) => r.text()).then(() =>
                        fetch(`${printedUrl}${ModelServer.paths.evaluation}`, {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({
                            state: { n: "nonce-99" },
                            questions: {
                              complete: { type: "boolean", instructions: "ok?", criteria: { true: "y", false: "n" } }
                            }
                          })
                        }).then((r) => r.text())
                      ).finally(() => stopRec())
                    },
                    stopped: stoppedRec
                  }
                )
                yield* Effect.promise(() => recRun)
                expect(printedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
                expect(existsSync(fixturePath)).toBe(true)

                // Replay mode over missing file dies
                const missScope = yield* Scope.make()
                const missExit = yield* Effect.exit(
                  Scope.provide(
                    ModelServerCli.serve(ModelServerCli.parse(["--fixture", join(dir, "nope.json")], {})),
                    missScope
                  )
                )
                yield* Scope.close(missScope, Exit.void)
                expect(Exit.isFailure(missExit)).toBe(true)

                // Builtin serve mode answers health + chat + evaluation
                const builtinScope = yield* Scope.make()
                try {
                  const builtinSrv = yield* Scope.provide(ModelServerCli.serve(parsedBuiltin), builtinScope)
                  const bChat = yield* Effect.promise(() =>
                    fetch(`${builtinSrv.url}${ModelServer.paths.chat}`, {
                      method: "POST",
                      body: JSON.stringify({
                        model: "m",
                        stream: true,
                        messages: [{ role: "user", content: "unscripted" }]
                      })
                    })
                  )
                  expect(bChat.status).toBe(200)
                  yield* Effect.promise(() => bChat.text())
                  const bEval = yield* Effect.promise(() =>
                    fetch(`${builtinSrv.url}${ModelServer.paths.evaluation}`, {
                      method: "POST",
                      body: JSON.stringify({
                        state: {},
                        questions: {
                          complete: { type: "boolean", instructions: "ok?", criteria: { true: "yes", false: "no" } }
                        }
                      })
                    })
                  )
                  expect(bEval.status).toBe(200)
                } finally {
                  yield* Scope.close(builtinScope, Exit.void)
                }
              } finally {
                yield* Scope.close(scope, Exit.void)
              }
            } finally {
              rmSync(dir, { recursive: true, force: true })
            }
          })
      ),
    120_000
  )

  it("fuzzes ProcessTable POSIX & Windows query paths and RealCliDriver real process execution/bounds", () =>
    property(
      Arbitrary.all({
        payload: safeWord,
        exitCode: intBetween(0, 3),
        winError: bool
      }),
      Math.min(ioExecs, 10),
      (s) =>
        Effect.gen(function*() {
          // ProcessTable real POSIX query on current pid
          const selfRow = ProcessTable.query({ columns: ["pid", "comm"], pid: process.pid })
          expect(selfRow).toContain(String(process.pid))
          // Invalid pid rejected
          expect(() => ProcessTable.query({ columns: ["pid"], pid: 0 })).toThrow()
          expect(() => ProcessTable.query({ columns: ["pid"], pid: -5 })).toThrow()
          // Injected spawn boundary for POSIX error / missing pid / failure
          const fakeSpawn = (status: number, stdout: string, stderr = "", error?: Error): ProcessTable.Spawn => () => ({
            pid: 1,
            output: [null, stdout, stderr],
            stdout,
            stderr,
            status,
            signal: null,
            ...(error === undefined ? {} : { error })
          })
          expect(ProcessTable.query({ columns: ["pid"], pid: 999999 }, fakeSpawn(1, ""))).toBe("")
          expect(() => ProcessTable.query({ columns: ["pid"] }, fakeSpawn(1, "", "perm"))).toThrow()
          expect(() => ProcessTable.query({ columns: ["pid"] }, fakeSpawn(0, "", "", new Error("enoent")))).toThrow()

          // ProcessTable Windows query path via platform: "win32"
          expect(() => ProcessTable.query({ columns: ["pgid"], platform: "win32" }, fakeSpawn(0, "1"))).toThrow()
          const winOut = ProcessTable.query(
            { columns: ["pid", "ppid", "stat", "comm", "args", "rss", "lstart"], pid: 42, platform: "win32" },
            fakeSpawn(0, "42 1 S node node.exe 1024 Mon")
          )
          expect(winOut).toContain("42")
          if (s.winError) {
            expect(() => ProcessTable.queryWindows({ columns: ["pid"] }, fakeSpawn(1, "", "boom"))).toThrow()
            expect(() => ProcessTable.queryWindows({ columns: ["pid"] }, fakeSpawn(0, "", "", new Error("fail"))))
              .toThrow()
          }

          // RealCliDriver with real NodeHost services
          const hostLayer = NodeHost.layer
          yield* Effect.scoped(
            Effect.gen(function*() {
              const driver = yield* RealCliDriver.make({
                executable: process.execPath,
                args: ["-e"],
                timeoutMs: 5_000,
                maxBytes: 4096
              })
              const res = yield* driver.run([
                `const fs=require("fs");const input=fs.readFileSync(0,"utf8");process.stdout.write("OUT:"+input);process.stderr.write("ERR");process.exit(${s.exitCode})`
              ], s.payload)
              expect(res.code).toBe(s.exitCode)
              expect(res.stdout).toBe(`OUT:${s.payload}`)
              expect(res.stderr).toBe("ERR")

              // invalid-options
              const badOpts = yield* Effect.exit(RealCliDriver.make({ executable: process.execPath, timeoutMs: 0 }))
              expect(Exit.isFailure(badOpts)).toBe(true)

              // output-limit
              const overLimit = yield* Effect.exit(RealCliDriver.execute({
                executable: process.execPath,
                args: ["-e", "process.stdout.write(\"x\".repeat(100))"],
                cwd: driver.cwd,
                maxBytes: 16
              }))
              expect(Exit.isFailure(overLimit)).toBe(true)
              if (Exit.isFailure(overLimit)) {
                const err = Cause.findErrorOption(overLimit.cause)
                expect(err._tag === "Some" && err.value._tag === "DriverError" && err.value.reason === "output-limit")
                  .toBe(true)
              }

              // timeout
              const timedOut = yield* Effect.exit(RealCliDriver.execute({
                executable: process.execPath,
                args: ["-e", "setTimeout(() => {}, 5000)"],
                cwd: driver.cwd,
                timeoutMs: 80
              }))
              expect(Exit.isFailure(timedOut)).toBe(true)
            })
          ).pipe(Effect.provide(hostLayer))
        })
    ), 120_000)
})
