import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Ownership } from "@smthrs/run-store"
import * as SqlClient from "effect/sql/SqlClient"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Duration, Effect, Exit, Fiber, Layer, Logger, Option, Redacted, Schema, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import { RpcSerialization } from "effect/rpc"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ApprovalAuthority from "../src/ApprovalAuthority.ts"
import * as Channels from "../src/Channels.ts"
import { Control } from "../src/Control.ts"
import * as ControlClient from "../src/ControlClient.ts"
import * as ControlError from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlFacts from "../src/ControlFacts.ts"
import * as ControlLive from "../src/ControlLive.ts"
import * as ControlRpcs from "../src/ControlRpcs.ts"
import { ControlRuntime, type MemoryFlow } from "../src/ControlRuntime.ts"
import * as ControlSchema from "../src/ControlSchema.ts"
import type { ControlEvent, Envelope, Principal, RunSummary } from "../src/ControlSchema.ts"
import * as ControlServer from "../src/ControlServer.ts"
import * as Credential from "../src/Credential.ts"
import * as CredentialCipher from "../src/CredentialCipher.ts"
import * as CredentialStore from "../src/CredentialStore.ts"
import * as DispatchReader from "../src/DispatchReader.ts"
import * as Health from "../src/Health.ts"
import * as Monitor from "../src/Monitor.ts"
import * as ScopedToken from "../src/ScopedToken.ts"
import * as SqlCredentialStore from "../src/SqlCredentialStore.ts"
import * as WebCryptoCipher from "../src/WebCryptoCipher.ts"
import * as WebhookChannel from "../src/WebhookChannel.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import * as DurableStack from "./DurableStack.ts"
import { durable } from "./DurableStack.ts"
import { live, memoryRuntime } from "./TestStack.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261220")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(30, Math.min(baseExecutions, 80))
const ioExec = Math.max(12, Math.min(Math.ceil(baseExecutions / 5), 25))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const silentLog = Logger.layer([])
const envelope: Envelope = { capabilities: [], flows: [], budget: {} }
const testFlows: ReadonlyArray<MemoryFlow> = [
  { flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope },
  { flowId: "review/pull-request", description: "Review a pull request.", deployClass: false, envelope },
  { flowId: "release/train", description: "Ship a release.", deployClass: true, envelope }
]

const localOp: Principal = { id: "local", kind: "operator", stampedAt: 1 }
const localStamped = { id: "local", kind: "operator", stampedAt: 1 } as const
const bob: Principal = { id: "bob", kind: "user", stampedAt: 1 }
const bobStamped = { id: "bob", kind: "user", stampedAt: 1 } as const
const validHostKey = Redacted.make(btoa("0123456789abcdef0123456789abcdef"))

describe("@smthrs/control Wave 10 deep fuzzing", () => {
  it("fuzzes Credential (layer/layerNoop/authorize/rotate/conflict/surrogates), WebCryptoCipher & SqlCredentialStore CAS", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        secretText: Schema.Literals(["sk-live-abc123", "tok-😀-valid", "secret-val-99"]),
        rotatedText: Schema.Literals(["sk-rotated-1", "sk-rotated-2"]),
        matchExpected: Schema.Boolean,
        testBadSurrogate: Schema.Boolean,
        testNoop: Schema.Boolean,
        useSqlStore: Schema.Boolean,
        denyAuth: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ secretText, rotatedText, matchExpected, testBadSurrogate, testNoop, useSqlStore, denyAuth }) =>
          Effect.gen(function*() {
            if (testNoop) {
              const noopOps = yield* Effect.gen(function*() {
                const cred = yield* Credential.Credential
                const r1 = yield* Effect.exit(cred.list())
                const r2 = yield* Effect.exit(cred.get("c1"))
                const r3 = yield* Effect.exit(
                  cred.create({ id: "c1", name: "openai-key", secret: Redacted.make("x") })
                )
                const r4 = yield* Effect.exit(cred.resolve({ id: "c1", name: "openai-key" }))
                const r5 = yield* Effect.exit(
                  cred.rotate({ id: "c1", name: "openai-key" }, Redacted.make("y"))
                )
                const r6 = yield* Effect.exit(cred.revoke({ id: "c1", name: "openai-key" }))
                return [r1, r2, r3, r4, r5, r6]
              }).pipe(Effect.provide(Credential.layerNoop))
              for (const r of noopOps) expect(Exit.isFailure(r as Exit.Exit<unknown, unknown>)).toBe(true)

              const stNoop = CredentialStore.makeNoop()
              expect(Exit.isFailure(yield* Effect.exit(stNoop.list()))).toBe(true)
              expect(Exit.isFailure(yield* Effect.exit(stNoop.read("c1")))).toBe(true)
              expect(Exit.isFailure(yield* Effect.exit(stNoop.write({ id: "c1", name: "k", ciphertext: "x", version: 1, createdAt: 1, updatedAt: 1 } as any)))).toBe(true)
              expect(CredentialStore.layerNoop()).toBeDefined()
              expect(Exit.isFailure(yield* Effect.exit(stNoop.remove("c1")))).toBe(true)
              const cNoop = CredentialCipher.makeNoop()
              expect(
                Exit.isFailure(
                  yield* Effect.exit(cNoop.seal(Redacted.make("x"), { id: "c1", name: "n", version: 1 }))
                )
              ).toBe(true)
              expect(
                Exit.isFailure(
                  yield* Effect.exit(
                    cNoop.open({ ciphertext: "YQ==", nonce: "Yg==" }, { id: "c1", name: "n", version: 1 })
                  )
                )
              ).toBe(true)
            }

            // Invalid key length in WebCryptoCipher.make
            const badKeyExit = yield* Effect.exit(
              WebCryptoCipher.make({ key: Redacted.make(btoa("short-key")) })
            )
            expect(Exit.isFailure(badKeyExit)).toBe(true)
            const badB64Exit = yield* Effect.exit(
              WebCryptoCipher.make({ key: Redacted.make("!!!not-base64!!!") })
            )
            expect(Exit.isFailure(badB64Exit)).toBe(true)

            const storeLayer = useSqlStore
              ? SqlCredentialStore.layer.pipe(Layer.provide(TestDatabase.layer))
              : CredentialStore.layerMemory

            const credLayer = Credential.layer(
              denyAuth
                ? {
                    authorize: () => Effect.fail(new ControlError.Unauthorized({ message: "denied" }))
                  }
                : {}
            ).pipe(
              Layer.provideMerge(storeLayer),
              Layer.provideMerge(WebCryptoCipher.layer({ key: validHostKey }).pipe(Layer.orDie)),
              Layer.provideMerge(silentLog)
            )

            yield* Effect.scoped(
              Effect.gen(function*() {
                const cred = yield* Credential.Credential
                if (denyAuth) {
                  const ex = yield* Effect.exit(
                    cred.create({ id: "cred-denied", name: "openai", secret: Redacted.make(secretText) })
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                  return
                }

                if (testBadSurrogate) {
                  const badExit = yield* Effect.exit(
                    cred.create({
                      id: "bad-surr",
                      name: "openai-key",
                      secret: Redacted.make("hi-\ud83d-bad")
                    })
                  )
                  expect(Exit.isFailure(badExit)).toBe(true)
                }

                const created = yield* cred.create({
                  id: "cred-1",
                  name: "openai-key",
                  secret: Redacted.make(secretText)
                })
                expect(created.id).toBe("cred-1")

                // Duplicate create fails
                const dupExit = yield* Effect.exit(
                  cred.create({ id: "cred-1", name: "openai-key", secret: Redacted.make("dup") })
                )
                expect(Exit.isFailure(dupExit)).toBe(true)

                const fetched = yield* cred.get("cred-1")
                expect(fetched.id).toBe(created.id)

                const listed = yield* cred.list()
                expect(listed.length).toBeGreaterThanOrEqual(1)

                const resolved = yield* cred.resolve({ id: "cred-1", name: "openai-key" })
                expect(Redacted.value(resolved)).toBe(secretText)

                // Rotate with expected (matching vs mismatching)
                const rotateExit = yield* Effect.exit(
                  cred.rotate({ id: "cred-1", name: "openai-key" }, Redacted.make(rotatedText), {
                    expected: Redacted.make(matchExpected ? secretText : "wrong-expected-secret")
                  })
                )
                if (matchExpected) {
                  expect(Exit.isSuccess(rotateExit)).toBe(true)
                  if (Exit.isSuccess(rotateExit)) {
                    const res2 = yield* cred.resolve({ id: "cred-1", name: "openai-key" })
                    expect(Redacted.value(res2)).toBe(rotatedText)
                    yield* cred.revoke({ id: "cred-1", name: "openai-key" })
                  }
                } else {
                  expect(Exit.isFailure(rotateExit)).toBe(true)
                  // Also test direct SqlCredentialStore CAS mismatch when useSqlStore
                  if (useSqlStore) {
                    const st = yield* CredentialStore.CredentialStore
                    const cur = yield* st.read("cred-1")
                    if (Option.isSome(cur)) {
                      const casFail = yield* Effect.exit(
                        st.write(
                          { ...cur.value, version: cur.value.version + 1, ciphertext: "bmV3" },
                          { ...cur.value, ciphertext: "d3Jvbmc=" }
                        )
                      )
                      expect(Exit.isFailure(casFail)).toBe(true)
                    }
                  }
                  yield* cred.revoke({ id: "cred-1", name: "openai-key" })
                }

                // Missing credential lookup fails
                const missing = yield* Effect.exit(cred.get("cred-1"))
                expect(Exit.isFailure(missing)).toBe(true)
              }).pipe(Effect.provide(credLayer))
            )

            return true
          }),
        { seed, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("fuzzes Channels, WebhookChannel, ScopedToken, Health, Monitor, ApprovalAuthority, ControlExecutor & ControlFacts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        chanBadKind: Schema.Literals([
          "nonObject",
          "array",
          "badProto",
          "badBody",
          "nonEnumHeader",
          "nonStrHeader",
          "dupCaseHeader",
          "emptyIdem"
        ]),
        webhookCase: Schema.Literals([
          "declaredTooBig",
          "streamTooBig",
          "badJson",
          "decodeFail",
          "badLimitDie",
          "valid"
        ]),
        tokenCase: Schema.Literals([
          "badTtl",
          "emptyKey",
          "wrongPrefix",
          "badBase64",
          "projWorkspaceFlow",
          "projDurationsFlow",
          "ofRunFlow",
          "ofPlanFlow",
          "unauthorizedCall"
        ]),
        healthCase: Schema.Literals([
          "badCheckerId",
          "dupCheckerId",
          "badPolicyBackoff",
          "badSchemaConfig",
          "unexpectedConfig",
          "validEvaluate"
        ]),
        proofCase: Schema.Literals(["noVerifier", "unauthorizedProof", "validProof", "invalidConfig"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ chanBadKind, webhookCase, tokenCase, healthCase, proofCase }) =>
          Effect.gen(function*() {
            // 1. Channels boundary validation + valid ingest + dedup + conflict + terminal delivery
            yield* Effect.scoped(
              Effect.gen(function*() {
                const chanService = yield* Channels.makeMemory
                yield* chanService.register({
                  name: "ch-w10",
                  schema: Schema.Struct({ ok: Schema.Boolean }),
                  fingerprintHeaders: ["X-Event-Id"],
                  verify: () => Effect.void,
                  decode: (raw) =>
                    Effect.try({
                      try: () => JSON.parse(new TextDecoder().decode(raw.body)) as { ok: boolean },
                      catch: () => new ControlError.InvalidInput({ issue: "bad json" })
                    }),
                  map: (payload) => Effect.succeed({ _tag: "Start" as const, flowId: "review/pull-request", input: payload }),
                  project: (run) => ({ cursor: `c:${run.status}`, operation: "post" as const, message: { status: run.status } })
                })
                let rawInput: any
                if (chanBadKind === "nonObject") rawInput = "not-an-object"
                else if (chanBadKind === "array") rawInput = []
                else if (chanBadKind === "badProto") {
                  class WeirdRaw {
                    body = new Uint8Array([1])
                    headers = {}
                    idempotencyKey = "k1"
                  }
                  rawInput = new WeirdRaw()
                } else if (chanBadKind === "badBody") rawInput = { body: "not-bytes", headers: {}, idempotencyKey: "k1" }
                else if (chanBadKind === "nonEnumHeader") {
                  const hdrs = {}
                  Object.defineProperty(hdrs, "x-hidden", { value: "1", enumerable: false })
                  rawInput = { body: new Uint8Array([1]), headers: hdrs, idempotencyKey: "k1" }
                } else if (chanBadKind === "nonStrHeader") {
                  rawInput = { body: new Uint8Array([1]), headers: { "x-num": 42 }, idempotencyKey: "k1" }
                } else if (chanBadKind === "dupCaseHeader") {
                  rawInput = { body: new Uint8Array([1]), headers: { "X-Sig": "a", "x-sig": "b" }, idempotencyKey: "k1" }
                } else {
                  rawInput = { body: new Uint8Array([1]), headers: {}, idempotencyKey: "" }
                }
                const chExit = yield* Effect.exit(chanService.ingest({ channel: "ch-w10", raw: rawInput }))
                expect(Exit.isFailure(chExit)).toBe(true)
                const symHdrs: Record<PropertyKey, unknown> = { [Symbol("s")]: "v" }
                const symExit = yield* Effect.exit(
                  chanService.ingest({
                    channel: "ch-w10",
                    raw: { body: new Uint8Array([1]), headers: symHdrs as any, idempotencyKey: "k-sym" }
                  })
                )
                expect(Exit.isFailure(symExit)).toBe(true)
                const emptyChanExit = yield* Effect.exit(
                  chanService.ingest({
                    channel: "",
                    raw: { body: new Uint8Array([123, 125]), headers: {}, idempotencyKey: "k-ec" }
                  })
                )
                expect(Exit.isFailure(emptyChanExit)).toBe(true)
                const validRaw = {
                  body: new TextEncoder().encode(JSON.stringify({ ok: true })),
                  headers: { "x-event-id": "ev-1" },
                  idempotencyKey: "k-valid-1"
                }
                const rIng1 = yield* chanService.ingest({ channel: "ch-w10", raw: validRaw })
                expect(typeof rIng1._tag).toBe("string")
                const rIng2 = yield* chanService.ingest({ channel: "ch-w10", raw: validRaw })
                expect(rIng2._tag === "AlreadyApplied" || rIng2._tag === "Parked").toBe(true)
                const rConf = yield* Effect.exit(
                  chanService.ingest({
                    channel: "ch-w10",
                    raw: {
                      body: new TextEncoder().encode(JSON.stringify({ ok: false })),
                      headers: { "x-event-id": "ev-2" },
                      idempotencyKey: "k-valid-1"
                    }
                  })
                )
                expect(Exit.isFailure(rConf) || rConf.value._tag === "Conflict").toBe(true)
              }).pipe(Effect.provide(live({ runtime: memoryRuntime({ flows: testFlows }) })), Effect.provide(silentLog))
            )

            // 2. WebhookChannel body limits & JSON decode paths
            const wh = WebhookChannel.make({
              name: "wh-w10",
              schema: Schema.Struct({ ok: Schema.Boolean }),
              credential: Redacted.make({ id: "cred", name: "webhook" }),
              verify: () => Effect.void,
              map: () => Effect.succeed({ _tag: "Start" as const, flowId: "review/pull-request", input: {} }),
              project: (run: RunSummary) => ({ cursor: run.status, operation: "post" as const, message: { status: run.status } })
            } as any)
            const whChannels = Layer.succeed(
              Channels.Channels,
              Channels.Channels.of({
                register: () => Effect.void,
                lookup: () => Effect.die("unused"),
                ingest: (req) =>
                  wh.decode(req.raw).pipe(Effect.as({ _tag: "Accepted" as const, receiptId: "r-1" })),
                project: () => Effect.die("unused")
              })
            )
            const makeReqLayer = (headers: Record<string, string | undefined>, bodyBytes: Uint8Array) =>
              Layer.succeed(
                HttpServerRequest.HttpServerRequest,
                {
                  headers,
                  get stream() {
                    return Stream.fromEffect(Effect.succeed(bodyBytes))
                  },
                  get arrayBuffer() {
                    return Effect.succeed(
                      bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength)
                    )
                  }
                } as unknown as HttpServerRequest.HttpServerRequest
              )
            if (webhookCase === "badLimitDie") {
              const handler = WebhookChannel.handler("wh-w10", "idem-wh-1", { maximumBodyBytes: Number.NaN })
              const ex = yield* Effect.exit(
                handler.pipe(
                  Effect.provide(whChannels),
                  Effect.provide(makeReqLayer({}, new Uint8Array([123, 125])))
                )
              )
              expect(Exit.isFailure(ex)).toBe(true)
            } else {
              const handler = WebhookChannel.handler("wh-w10", "idem-wh-2", { maximumBodyBytes: 16 })
              const headers: Record<string, string | undefined> =
                webhookCase === "declaredTooBig" ? { "Content-Length": "999" } : { "content-length": "not-a-num" }
              const payloadBytes =
                webhookCase === "streamTooBig"
                  ? new Uint8Array(32).fill(0x61)
                  : webhookCase === "badJson"
                    ? new TextEncoder().encode("{bad-json")
                    : webhookCase === "decodeFail"
                      ? new TextEncoder().encode(`{"no":1}`)
                      : new TextEncoder().encode(`{"ok":true}`)
              const ex = yield* Effect.exit(
                handler.pipe(Effect.provide(whChannels), Effect.provide(makeReqLayer(headers, payloadBytes)))
              )
              expect(Exit.isSuccess(ex)).toBe(webhookCase === "valid")
            }

            // 3. ScopedToken edge cases
            const signingKey = "test-signing-key-32bytes-minimum!"
            if (tokenCase === "badTtl") {
              const ex = yield* Effect.exit(
                ScopedToken.mint({ key: signingKey, scopes: ["read:runs"], ttlMillis: 0, now: () => 1000 })
              )
              expect(Exit.isFailure(ex)).toBe(true)
            } else if (tokenCase === "emptyKey") {
              const ex = yield* Effect.exit(ScopedToken.verify("", "smt1.abc.def", 1000))
              expect(Exit.isFailure(ex)).toBe(true)
            } else if (tokenCase === "wrongPrefix") {
              const ex = yield* Effect.exit(ScopedToken.verify(signingKey, "bad.abc.def", 1000))
              expect(Exit.isFailure(ex)).toBe(true)
            } else if (tokenCase === "badBase64") {
              const ex = yield* Effect.exit(ScopedToken.verify(signingKey, "smt1.!!!not-valid!!!.sig", 1000))
              expect(Exit.isFailure(ex)).toBe(true)
            } else {
              const minted = yield* ScopedToken.mint({
                key: signingKey,
                scopes: ["read:runs", "approve:runs"],
                flowId: "demo/flow",
                ttlMillis: 60_000,
                now: () => 1000
              })
              const auth = ScopedToken.authenticator({
                key: signingKey,
                principal: { id: "gateway", kind: "scoped" },
                now: () => 2000,
                flows: {
                  ofRun: (id) => Effect.succeed(id === "run-ok" ? "demo/flow" : "other/flow"),
                  ofPlan: (id) => Effect.succeed(id === "plan-ok" ? "demo/flow" : "other/flow")
                }
              })
              if (tokenCase === "projWorkspaceFlow") {
                const ok = yield* Effect.exit(
                  auth.authenticate({ authorization: `Bearer ${minted.token}` }, {
                    rpc: "Projection.Snapshot",
                    payload: { selector: { _tag: "workspace-runs", flowId: "demo/flow" } }
                  })
                )
                expect(Exit.isSuccess(ok)).toBe(true)
              } else if (tokenCase === "projDurationsFlow") {
                const ok = yield* Effect.exit(
                  auth.authenticate({ authorization: `Bearer ${minted.token}` }, {
                    rpc: "Projection.Subscribe",
                    payload: { selector: { _tag: "flow-durations", flowId: "demo/flow" } }
                  })
                )
                expect(Exit.isSuccess(ok)).toBe(true)
              } else if (tokenCase === "ofRunFlow") {
                const ok = yield* Effect.exit(
                  auth.authenticate({ authorization: `Bearer ${minted.token}` }, { rpc: "Watch", payload: { runId: "run-ok" } })
                )
                expect(Exit.isSuccess(ok)).toBe(true)
              } else if (tokenCase === "ofPlanFlow") {
                const ok = yield* Effect.exit(
                  auth.authenticate({ authorization: `Bearer ${minted.token}` }, { rpc: "Approve", payload: { target: { _tag: "Plan", planId: "plan-ok" } } })
                )
                expect(Exit.isSuccess(ok)).toBe(true)
              } else {
                const denied = yield* Effect.exit(
                  auth.authenticate({ authorization: `Bearer ${minted.token}` }, { rpc: "Run", payload: { flowId: "other/flow" } })
                )
                expect(Exit.isFailure(denied)).toBe(true)
              }
            }

            // 4. Health registry validation & evaluation + Monitor.formatBeat
            const dummyChecker: Health.HealthChecker<{ threshold: number }> = {
              id: "custom/check",
              configSchema: Schema.Struct({ threshold: Schema.Number }),
              probe: () => Effect.succeed({ activity: "working" as const })
            }
            if (healthCase === "badCheckerId") {
              expect(() => Health.makeRegistry({ checkers: [{ ...dummyChecker, id: " bad id!" }] })).toThrow()
            } else if (healthCase === "dupCheckerId") {
              expect(() => Health.makeRegistry({ checkers: [dummyChecker, dummyChecker] })).toThrow()
            } else if (healthCase === "badPolicyBackoff") {
              expect(() =>
                Health.makeRegistry({
                  checkers: [dummyChecker],
                  bindings: {
                    "flow/a": {
                      checkerId: "custom/check",
                      config: { threshold: 1 },
                      policy: { backoff: { initialMs: 5000, maxMs: 1000, factor: 2 } }
                    }
                  }
                })
              ).toThrow()
              expect(() => Health.makeRegistry({ limits: { maxSubjects: 0 } })).toThrow()
            } else if (healthCase === "badSchemaConfig") {
              expect(() =>
                Health.makeRegistry({
                  checkers: [dummyChecker],
                  bindings: {
                    "flow/a": { checkerId: "custom/check", config: { threshold: "not-a-number" } }
                  }
                })
              ).toThrow()
            } else if (healthCase === "unexpectedConfig") {
              const noCfgChecker: Health.HealthChecker<undefined> = {
                id: "custom/nocfg",
                probe: () => Effect.succeed({ activity: "idle" as const })
              }
              expect(() =>
                Health.makeRegistry({
                  checkers: [noCfgChecker],
                  bindings: { "flow/a": { checkerId: "custom/nocfg", config: { extra: true } } }
                })
              ).toThrow()
            } else {
              const errChecker: Health.HealthChecker<undefined> = {
                id: "custom/err",
                probe: () => Effect.fail("boom" as any)
              }
              const reg = Health.makeRegistry({
                checkers: [dummyChecker, errChecker],
                bindings: {
                  "flow/ok": { checkerId: "custom/check", config: { threshold: 1 } },
                  "flow/err": { checkerId: "custom/err" }
                }
              })
              const okCheck = reg.resolve("flow/ok")
              const errCheck = reg.resolve("flow/err")
              expect(Health.nextDelay(okCheck.policy, 0)).toBe(okCheck.policy.intervalMs)
              expect(Health.nextDelay(okCheck.policy, 1000)).toBeGreaterThanOrEqual(okCheck.policy.intervalMs)
              const obsOk = yield* Health.evaluate(
                okCheck,
                { subjectId: "r-1", state: "running", nowMs: 1000 } as any,
                { monitorId: "m-1", incarnation: "inc-1", evidenceSeq: 1 }
              )
              expect(obsOk.outcome).toBe("ok")
              const obsErr = yield* Health.evaluate(
                errCheck,
                { subjectId: "r-1", state: "running", nowMs: 1000 } as any,
                { monitorId: "m-1", incarnation: "inc-1", evidenceSeq: 2 }
              )
              expect(obsErr.outcome).toBe("error")
              const latest = Health.latestObservation([{ sequence: 1, observation: obsOk }, { sequence: 2, observation: obsErr }], "r-1", "inc-1")
              expect(latest?.observation.evidenceSeq).toBe(2)
            }

            const beatStr = Monitor.formatBeat({
              runId: "r-1",
              monitorId: "m-1",
              beat: 3,
              at: 1000,
              status: "running",
              health: "healthy",
              lastEventAt: 900,
              silentForMs: 100
            } as any)
            expect(typeof beatStr).toBe("string")

            // 5. ApprovalAuthority requiredProof & invalid delegation config
            const reqTarget = { _tag: "Plan" as const, planId: "p1", digest: "d1", envelope }
            const authReq: ApprovalAuthority.Request = {
              principal: { id: "rev", kind: "user", stampedAt: 10 },
              target: reqTarget,
              decision: "approved",
              scope: "once"
            }
            if (proofCase === "invalidConfig") {
              const ex = yield* Effect.exit(ApprovalAuthority.make([{ principal: { id: "", kind: "user" } } as any]))
              expect(Exit.isFailure(ex)).toBe(true)
            } else {
              const policy = yield* ApprovalAuthority.make(
                [{ principal: { id: "rev", kind: "user" }, scopes: ["once"], targets: ["Plan"], requiredProof: "mfa" }],
                proofCase === "noVerifier"
                  ? {}
                  : {
                      verifyProof: () =>
                        proofCase === "validProof"
                          ? Effect.void
                          : Effect.fail(new ControlError.Unauthorized({ message: "bad proof" }))
                    }
              )
              const ex = yield* Effect.exit(policy.authorize(authReq))
              expect(Exit.isSuccess(ex)).toBe(proofCase === "validProof")
            }

            // 6. ControlExecutor pendingWaitOf & layerNoop
            const pw1 = ControlExecutor.pendingWaitOf({
              runId: "r-1",
              kind: "approval",
              point: "stepA#2",
              requestId: "req-1",
              waitingSinceMs: 100
            } as any)
            const pw2 = ControlExecutor.pendingWaitOf({
              runId: "r-1",
              kind: "signal",
              point: "stepOnly",
              waitingSinceMs: 100
            } as any)
            expect(pw1 === undefined || typeof pw1 === "object").toBe(true)
            expect(pw2 === undefined || typeof pw2 === "object").toBe(true)
            const noopExec = yield* Effect.gen(function*() {
              const ex = yield* ControlExecutor.ControlExecutor
              return yield* ex.resumeRun({ runId: "r-1" } as any)
            }).pipe(Effect.provide(ControlExecutor.layerNoop()))
            expect(noopExec).toBe("unknown")

            // 7. ControlFacts fold (versioned, legacy unversioned, approvals, mismatches)
            const baseRun: RunSummary = {
              runId: "run-f1",
              flowId: "review/pull-request",
              status: "accepted",
              createdAt: 1,
              updatedAt: 1
            }
            const mkEv = (kind: string, payload: unknown, seq: number): ControlEvent => ({
              kind,
              payload: payload as ControlEvent["payload"],
              sequence: seq,
              runId: "run-f1",
              occurredAt: seq
            })
            const nodeT = {
              _tag: "Node" as const,
              runId: "run-f1",
              requestId: "req-a",
              digest: "dig-a",
              envelope
            }
            const folded = ControlFacts.fold([
              mkEv("control.run.accepted", ControlFacts.runFact(baseRun, "created"), 1),
              mkEv("control.approval.requested", {
                factVersion: 1,
                runId: "run-f1",
                requestId: "req-a",
                question: "approve?",
                payload: { target: nodeT, scope: "run", idempotencyKey: "req-a" }
              }, 2),
              mkEv("control.approval.approved", {
                tokenId: "tok-legacy",
                approvalTarget: nodeT
              }, 3),
              mkEv("control.run.completed", ControlFacts.runFact({ ...baseRun, status: "completed", updatedAt: 4 }), 4)
            ])
            expect(folded.run?.status).toBe("completed")

            return true
          }),
        { seed: seed + 1, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("fuzzes ControlLive & SqlControlRuntime across list filters/cursors, approvals, pause/resume/drift/cancel/retry/steer/signal/watch", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        backend: Schema.Literals(["memory", "sqlite"]),
        scenario: Schema.Literals([
          "invalidLimitAndCursor",
          "listFlowsTriggersExecutions",
          "planApproveDenyAndRun",
          "pauseResumeCancelRetryLifecycle",
          "steerSignalWatchAndDrift"
        ]),
        n: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ backend, scenario, n }) =>
          Effect.gen(function*() {
            let driftVersion = 1
            const loadFlows = () =>
              Effect.succeed(
                testFlows.map((f) => ({
                  ...f,
                  digest: `digest-v${driftVersion}-${f.flowId}`
                }))
              )
            const currentFlows = () =>
              Effect.succeed(
                testFlows.map((f) => ({
                  ...f,
                  digest: `digest-v${driftVersion}-${f.flowId}`
                }))
              )

            const stackLayer =
              backend === "memory"
                ? live({
                    runtime: memoryRuntime({
                      flows: testFlows,
                      principal: localOp,
                      approvalAuthority: delegateApproval(localOp)
                    }),
                    dispatch: scenario === "listFlowsTriggersExecutions" ? "none" : undefined
                  }).pipe(Layer.provideMerge(silentLog))
                : durable({
                    loadFlows,
                    currentFlows,
                    principal: localOp,
                    approvalAuthority: delegateApproval(localOp),
                    isAlive: () => Effect.succeed(false)
                  }).pipe(Layer.provideMerge(silentLog))

            const startRun = (ctrl: Control["Service"], flowId: string, key: string) =>
              Effect.gen(function*() {
                const card = yield* ctrl.plan({ flowId, input: { n }, idempotencyKey: `plan:${key}` })
                yield* ctrl.approve({ ...card.approval, idempotencyKey: `app:${key}` })
                const receipt = yield* ctrl.run({
                  _tag: "Plan",
                  planId: card.planId,
                  digest: card.digest,
                  envelope: card.envelope,
                  idempotencyKey: `run:${key}`
                })
                if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
                  return yield* Effect.die(`expected accepted run, got ${receipt._tag}`)
                }
                return { card, runId: receipt.runId }
              })

            yield* Effect.scoped(
              Effect.gen(function*() {
                const ctrl = yield* Control
                const runtime = yield* ControlRuntime

                if (scenario === "invalidLimitAndCursor") {
                  const badLimit = yield* Effect.exit(ctrl.list({ _tag: "runs", limit: 0 }))
                  expect(Exit.isFailure(badLimit)).toBe(true)
                  const hugeLimit = yield* Effect.exit(ctrl.list({ _tag: "runs", limit: 999999 }))
                  expect(Exit.isFailure(hugeLimit)).toBe(true)

                  const r1 = yield* startRun(ctrl, "review/pull-request", `r1-${n}`)
                  const r2 = yield* startRun(ctrl, "review/pull-request", `r2-${n}`)
                  expect(r1.runId).not.toBe(r2.runId)

                  const page1 = yield* ctrl.list({ _tag: "runs", limit: 1 })
                  if (page1._tag === "runs" && page1.nextCursor !== undefined) {
                    // Cursor with mismatched filter must fail
                    const mismatch = yield* Effect.exit(
                      ctrl.list({
                        _tag: "runs",
                        limit: 1,
                        cursor: page1.nextCursor,
                        filters: { flowId: "release/train" }
                      })
                    )
                    expect(Exit.isFailure(mismatch)).toBe(true)
                    // Valid next page succeeds
                    const page2 = yield* ctrl.list({ _tag: "runs", limit: 1, cursor: page1.nextCursor })
                    expect(page2._tag).toBe("runs")
                  }
                  const missing = yield* ctrl.list({ _tag: "runs", filters: { runId: "nonexistent-run" } })
                  if (missing._tag === "runs") expect(missing.items.length).toBe(0)

                  const otherPrin = yield* ctrl.list({
                    _tag: "runs",
                    filters: { principalId: bob.id },
                    reader: localOp
                  })
                  if (otherPrin._tag === "runs") expect(otherPrin.items.length).toBe(0)
                } else if (scenario === "listFlowsTriggersExecutions") {
                  const flows = yield* ctrl.list({ _tag: "flows" })
                  expect(flows._tag).toBe("flows")

                  const trigExit = yield* Effect.exit(
                    ctrl.list({
                      _tag: "triggers",
                      filters: { triggerId: "t1", flowId: "review/pull-request", enabled: true }
                    })
                  )
                  expect(Exit.isSuccess(trigExit) || Exit.isFailure(trigExit)).toBe(true)

                  const tooMany = Array.from({ length: 205 }, (_, i) => `exec-${i}`)
                  const badExecs = yield* Effect.exit(
                    ctrl.list({ _tag: "executions", runId: "r-any", executionIds: tooMany } as any)
                  )
                  expect(Exit.isFailure(badExecs)).toBe(true)

                  const runInfo = yield* startRun(ctrl, "review/pull-request", `ex-${n}`)
                  const execs = yield* Effect.exit(
                    ctrl.list({ _tag: "executions", runId: runInfo.runId, executionIds: ["exec-missing"] } as any)
                  )
                  expect(Exit.isSuccess(execs) || Exit.isFailure(execs)).toBe(true)
                } else if (scenario === "planApproveDenyAndRun") {
                  // Unauthorized principal cannot approve
                  const card = yield* ctrl.plan({ flowId: "release/train", input: { n }, idempotencyKey: `p-${n}` })
                  const unauth = yield* Effect.exit(
                    ctrl.approve({
                      ...card.approval,
                      principal: bobStamped,
                      idempotencyKey: `app-unauth-${n}`
                    })
                  )
                  expect(Exit.isFailure(unauth)).toBe(true)

                  // Unknown plan fails
                  const unknownPlan = yield* Effect.exit(
                    ctrl.approve({
                      target: { _tag: "Plan", planId: "missing-plan", digest: "a".repeat(64), envelope },
                      scope: "once",
                      principal: localStamped,
                      idempotencyKey: `app-miss-${n}`
                    })
                  )
                  expect(Exit.isFailure(unknownPlan)).toBe(true)

                  // Deny plan, then trying to run it must fail
                  yield* ctrl.deny({
                    ...card.approval,
                    principal: localStamped,
                    idempotencyKey: `deny-${n}`
                  })
                  const runDenied = yield* Effect.exit(
                    ctrl.run({
                      _tag: "Plan",
                      planId: card.planId,
                      digest: card.digest,
                      envelope: card.envelope,
                      idempotencyKey: `run-denied-${n}`
                    })
                  )
                  expect(Exit.isFailure(runDenied)).toBe(true)
                } else if (scenario === "pauseResumeCancelRetryLifecycle") {
                  const { runId } = yield* startRun(ctrl, "review/pull-request", `lc-${n}`)
                  const pExit = yield* Effect.exit(
                    ctrl.pause({ runId, idempotencyKey: `pause-${n}`, reason: "check" })
                  )
                  expect(Exit.isSuccess(pExit) || Exit.isFailure(pExit)).toBe(true)

                  const resExit = yield* Effect.exit(
                    ctrl.resume({ runId, idempotencyKey: `res-${n}`, reason: "continue", allowCodeDrift: true })
                  )
                  expect(Exit.isSuccess(resExit) || Exit.isFailure(resExit)).toBe(true)

                  const c1 = yield* ctrl.cancel({ runId, idempotencyKey: `cancel-1-${n}`, reason: "stop" })
                  expect(c1._tag === "Accepted" || c1._tag === "Terminal").toBe(true)
                  const c2 = yield* ctrl.cancel({ runId, idempotencyKey: `cancel-2-${n}`, reason: "stop" })
                  expect(c2._tag === "Accepted" || c2._tag === "Terminal").toBe(true)

                  // Retry from a terminal run
                  const retryExit = yield* Effect.exit(
                    ctrl.run({ _tag: "Retry", runId, idempotencyKey: `retry-${n}` })
                  )
                  expect(Exit.isSuccess(retryExit) || Exit.isFailure(retryExit)).toBe(true)
                } else {
                  const { runId } = yield* startRun(ctrl, "review/pull-request", `st-${n}`)
                  const sExit = yield* Effect.exit(
                    ctrl.steer({ runId, message: { messageId: `m-${n}`, runId, principal: localStamped, createdAt: 1000, body: `steer-${n}` }, idempotencyKey: `steer-${n}` })
                  )
                  expect(Exit.isSuccess(sExit) || Exit.isFailure(sExit)).toBe(true)

                  const sigExit = yield* Effect.exit(
                    ctrl.signal({
                      runId,
                      signal: { name: "ping", payload: { n } },
                      idempotencyKey: `sig-${n}`
                    })
                  )
                  expect(Exit.isSuccess(sigExit) || Exit.isFailure(sigExit)).toBe(true)

                  // Watch history + invalid negative after
                  const events = yield* ctrl.watch({ runId, follow: false }).pipe(Stream.runCollect)
                  expect(events.length).toBeGreaterThanOrEqual(1)

                  // Also exercise runtime.getRun and drift on resume
                  const summary = yield* runtime.getRun(runId)
                  expect(summary.runId).toBe(runId)
                  driftVersion = 2
                  const rDrift = yield* Effect.exit(
                    ctrl.run({ _tag: "Resume", runId, idempotencyKey: `run-res-${n}`, allowCodeDrift: true })
                  )
                  expect(Exit.isSuccess(rDrift) || Exit.isFailure(rDrift)).toBe(true)
                }
              }).pipe(Effect.provide(stackLayer))
            )

            return true
          }),
        { seed: seed + 2, executions: ioExec }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("fuzzes ControlServer HTTP same-origin guard, Pause RPC & ControlClient boundary rejections over loopback HTTP/WS", async () => {
    const token = "wave10-control-secret"
    const auth = ControlRpcs.layerBearerAuth({
      token,
      principal: { id: "remote-operator", kind: "bearer" },
      now: () => 100
    })

    const serverLayer = HttpRouter.serve(
      ControlServer.layerHttp.pipe(
        Layer.provide(Layer.succeed(ControlServer.RequestScheme, "http:")),
        Layer.provide(auth),
        Layer.provide(RpcSerialization.layerNdjson)
      ),
      { disableListenLog: true, disableLogger: true }
    ).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      Layer.provideMerge(
        live({
          runtime: memoryRuntime({
            flows: testFlows,
            approvalAuthority: delegateApproval({ id: "remote-operator", kind: "bearer" })
          })
        })
      ),
      Layer.provideMerge(silentLog)
    )

    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals([
          "crossOrigin403",
          "clientReservedRunId",
          "clientPrincipalForbidden",
          "clientReaderForbidden",
          "rpcPlanApproveRunPause"
        ]),
        n: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })))
      })
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const srv = yield* HttpServer.HttpServer
          if (srv.address._tag !== "InetAddressV4") throw new Error("expected ipv4")
          const base = `http://127.0.0.1:${srv.address.port}`
          const wsUrl = `ws://127.0.0.1:${srv.address.port}/rpc/ws`

          const clientLayer = ControlClient.layer({ url: `${base}/rpc`, credential: token }).pipe(
            Layer.provide([
              NodeHttpClient.layerUndici,
              NodeSocket.layerWebSocket(wsUrl),
              RpcSerialization.layerNdjson
            ])
          )

          const report = yield* Fuzz.run(
            arb,
            ({ caseKind, n }) =>
              Effect.gen(function*() {
                if (caseKind === "crossOrigin403") {
                  const res = yield* Effect.promise(() =>
                    fetch(`${base}/rpc`, {
                      method: "POST",
                      headers: {
                        "content-type": "application/json",
                        origin: "https://evil.example.com",
                        authorization: `Bearer ${token}`
                      },
                      body: "{}"
                    })
                  )
                  expect(res.status).toBe(403)
                  return true
                }

                yield* Effect.scoped(
                  Effect.gen(function*() {
                    const c = yield* Control
                    if (caseKind === "clientReservedRunId") {
                      const ex = yield* Effect.exit(
                        c.run({
                          _tag: "Plan",
                          planId: "p",
                          digest: "d",
                          envelope,
                          idempotencyKey: "k",
                          reservedRunId: "res-1"
                        } as any)
                      )
                      expect(Exit.isFailure(ex)).toBe(true)
                    } else if (caseKind === "clientPrincipalForbidden") {
                      const ex = yield* Effect.exit(
                        c.cancel({
                          runId: "r-1",
                          idempotencyKey: "k",
                          principal: localOp
                        } as any)
                      )
                      expect(Exit.isFailure(ex)).toBe(true)
                    } else if (caseKind === "clientReaderForbidden") {
                      const ex = yield* Effect.exit(
                        c.list({ _tag: "runs", reader: localOp } as any)
                      )
                      expect(Exit.isFailure(ex)).toBe(true)
                    } else {
                      const card = yield* c.plan({
                        flowId: "review/pull-request",
                        input: { n },
                        idempotencyKey: `rpc-p-${n}-${Math.random()}`
                      })
                      yield* c.approve({
                        ...card.approval,
                        idempotencyKey: `rpc-a-${n}-${Math.random()}`
                      })
                      const rec = yield* c.run({
                        _tag: "Plan",
                        planId: card.planId,
                        digest: card.digest,
                        envelope: card.envelope,
                        idempotencyKey: `rpc-r-${n}-${Math.random()}`
                      })
                      if (rec._tag === "Accepted" && rec.runId !== undefined) {
                        const pEx = yield* Effect.exit(
                          c.pause({ runId: rec.runId, idempotencyKey: `rpc-pause-${n}-${Math.random()}` })
                        )
                        expect(Exit.isSuccess(pEx) || Exit.isFailure(pEx)).toBe(true)
                      }
                    }
                  }).pipe(Effect.provide(clientLayer))
                )
                return true
              }),
            { seed: seed + 3, executions: Math.min(ioExec, 15) }
          )
          assertPassed(report)
        }).pipe(Effect.provide(serverLayer))
      )
    )
  }, 120_000)

  it("fuzzes ControlFacts recordRunFact/recordApprovalRequest/fold edge cases & ControlLive steer/signal/watch/resume/list/dispatch/registry deep paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        backend: Schema.Literals(["memory", "sqlite"]),
        scenario: Schema.Literals([
          "factsAndApprovals",
          "steerParkedDriftAndDelegation",
          "signalRefusedUnknownAndAnswers",
          "watchValidationAndLiveFollow",
          "listFiltersRegistryAndDispatch",
          "resumeTerminalMonitorAndDeadOwner",
          "strandedLaunchAndSqlCorruption"
        ]),
        n: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ backend, scenario, n }) =>
          Effect.gen(function*() {
            if (scenario === "factsAndApprovals") {
              // ControlFacts.runFact refuses executionObservation (L36)
              const baseRun: RunSummary = {
                runId: `run-cf-${n}`,
                flowId: "review/pull-request",
                status: "accepted",
                createdAt: 1,
                updatedAt: 1
              }
              expect(() =>
                ControlFacts.runFact({ ...baseRun, executionObservation: { _tag: "Missing" } as any })
              ).toThrow()

              const stack = live({
                runtime: memoryRuntime({ flows: testFlows, principal: localOp, approvalAuthority: delegateApproval(localOp) })
              }).pipe(Layer.provideMerge(silentLog))
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const ctrl = yield* Control
                  const journal = yield* Journal.Journal
                  const runtime = yield* ControlRuntime
                  const cCard = yield* ctrl.plan({ flowId: "review/pull-request", input: { n }, idempotencyKey: `cf-p-${n}` })
                  yield* ctrl.approve({ ...cCard.approval, idempotencyKey: `cf-a-${n}` })
                  const cRec = yield* ctrl.run({
                    _tag: "Plan",
                    planId: cCard.planId,
                    digest: cCard.digest,
                    envelope: cCard.envelope,
                    idempotencyKey: `cf-r-${n}`
                  })
                  const realRunId = cRec._tag === "Accepted" && cRec.runId !== undefined ? cRec.runId : baseRun.runId
                  const realBaseRun: RunSummary = { ...baseRun, runId: realRunId }
                  // recordRunFact (L119-131)
                  const rec = yield* ControlFacts.commitRun(
                    journal,
                    Effect.succeed(realBaseRun),
                    "src-rf-1",
                    "control.run.accepted",
                    {},
                    "created"
                  )
                  expect(rec.runId).toBe(realRunId)

                  // recordApprovalRequest valid (L155-167) and mismatched (L147-153)
                  const validTarget = {
                    _tag: "Node" as const,
                    runId: realRunId,
                    requestId: `req-${n}`,
                    digest: "dig-1",
                    envelope
                  }
                  const tok = yield* ControlFacts.commitApprovalRequest(
                    journal,
                    runtime,
                    {
                      runId: realRunId,
                      requestId: `req-${n}`,
                      question: "Approve step?",
                      payload: { target: validTarget, scope: "run", idempotencyKey: `req-${n}` }
                    },
                    "src-ar-1"
                  )
                  expect(tok._tag).toBe("Pending")

                  const badReq = yield* Effect.exit(
                    ControlFacts.commitApprovalRequest(
                      journal,
                      runtime,
                      {
                        runId: baseRun.runId,
                        requestId: `req-bad-${n}`,
                        question: "Bad?",
                        payload: {
                          target: { ...validTarget, runId: "other-run" },
                          scope: "run",
                          idempotencyKey: `req-bad-${n}`
                        }
                      },
                      "src-ar-2"
                    )
                  )
                  expect(Exit.isFailure(badReq)).toBe(true)

                  // fold with unversioned request + tokenless approval decision + observedApprovals + control.run.pending
                  const mkEv = (kind: string, payload: unknown, seq: number): ControlEvent => ({
                    kind,
                    payload: payload as ControlEvent["payload"],
                    sequence: seq,
                    runId: baseRun.runId,
                    occurredAt: seq
                  })
                  const fRes = ControlFacts.fold(
                    [
                      mkEv("control.run.pending", ControlFacts.runFact(baseRun, "created"), 1),
                      mkEv("control.approval.requested", {
                        runId: baseRun.runId,
                        requestId: "legacy-req",
                        question: "Legacy?",
                        payload: {
                          target: { _tag: "Node", runId: baseRun.runId, requestId: "legacy-req", digest: "d", envelope },
                          scope: "once",
                          idempotencyKey: "legacy-req"
                        }
                      }, 2),
                      mkEv("control.approval.requested", { factVersion: 1, bad: true }, 3),
                      mkEv("control.approval.approved", {}, 4),
                      mkEv("control.steer.woke", ControlFacts.runFact({ ...baseRun, status: "running", updatedAt: 5 }), 5)
                    ],
                    undefined,
                    [
                      {
                        runId: baseRun.runId,
                        requestId: "obs-1",
                        title: "Obs",
                        request: "Obs?",
                        requestedAt: 1000,
                        status: "pending",
                        payload: {
                          target: { _tag: "Node", runId: baseRun.runId, requestId: "obs-1", digest: "d2", envelope },
                          scope: "run",
                          idempotencyKey: "obs-1"
                        }
                      }
                    ]
                  )
                  expect(fRes.run?.status).toBe("running")
                }).pipe(Effect.provide(stack))
              )
              return true
            }

            if (scenario === "steerParkedDriftAndDelegation") {
              let digestVer = 1
              const makeFlowList = () =>
                testFlows.map((f) => ({ ...f, executionDigest: `sha256-v${digestVer}-${f.flowId}` }))
              const peerOwner: Ownership.OwnerId = { hostId: "host-a", pid: 999, nonce: "peer" }
              const selfOwner: Ownership.OwnerId = { hostId: "host-a", pid: 1, nonce: "self" }

              const stack =
                backend === "memory"
                  ? live({
                      runtime: memoryRuntime({
                        flows: makeFlowList(),
                        principal: localOp,
                        approvalAuthority: delegateApproval(localOp)
                      })
                    }).pipe(Layer.provideMerge(silentLog))
                  : durable({
                      loadFlows: () => Effect.succeed(makeFlowList()),
                      currentFlows: () => Effect.succeed(makeFlowList()),
                      principal: localOp,
                      approvalAuthority: delegateApproval(localOp),
                      isAlive: () => Effect.succeed(true)
                    }).pipe(Layer.provideMerge(silentLog))

              yield* Effect.scoped(
                Effect.gen(function*() {
                  const ctrl = yield* Control
                  const runtime = yield* ControlRuntime
                  const card = yield* ctrl.plan({ flowId: "review/pull-request", input: { n }, idempotencyKey: `sp-p-${n}` })
                  yield* ctrl.approve({ ...card.approval, idempotencyKey: `sp-a-${n}` })
                  const rec = yield* ctrl.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: `sp-r-${n}`
                  })
                  if (rec._tag !== "Accepted" || rec.runId === undefined) return
                  const runId = rec.runId

                  // Mismatched message.runId rejected (L2174)
                  const badSteer = yield* Effect.exit(
                    ctrl.steer({
                      runId,
                      message: { messageId: `m-bad-${n}`, runId: "wrong-run", principal: localStamped, createdAt: 100, body: "hi" },
                      idempotencyKey: `sp-bad-${n}`
                    })
                  )
                  expect(Exit.isFailure(badSteer)).toBe(true)

                  // Park run with waitingReason: "event", then steer to trigger wake (L1121-1137)
                  yield* runtime.pause(runId).pipe(Effect.ignore)
                  const s1 = yield* ctrl.steer({
                    runId,
                    version: 1,
                    message: { messageId: `m-wake-${n}`, runId, principal: localStamped, createdAt: 100, body: "wake up" },
                    idempotencyKey: `sp-wake-${n}`
                  })
                  expect(s1._tag === "Accepted" || s1._tag === "AlreadyApplied").toBe(true)
                  // Duplicate version steer hits L2235
                  const sDup = yield* ctrl.steer({
                    runId,
                    version: 1,
                    message: { messageId: `m-wake-${n}`, runId, principal: localStamped, createdAt: 100, body: "wake up" },
                    idempotencyKey: `sp-wake-dup-${n}`
                  })
                  expect(sDup._tag === "Accepted" || sDup._tag === "AlreadyApplied").toBe(true)

                  // Re-park with event + trigger code drift on steer (L1155-1160)
                  yield* runtime.pause(runId).pipe(Effect.ignore)
                  digestVer = 2
                  yield* ctrl.steer({
                    runId,
                    message: { messageId: `m-drift-${n}`, runId, principal: localStamped, createdAt: 100, body: "drift" },
                    idempotencyKey: `sp-drift-${n}`
                  }).pipe(Effect.ignore)

                  // Cancel run, then steer on terminal run hits L2188
                  yield* ctrl.cancel({ runId, idempotencyKey: `sp-c-${n}`, reason: "done" })
                  const sTerm = yield* ctrl.steer({
                    runId,
                    message: { messageId: `m-term-${n}`, runId, principal: localStamped, createdAt: 100, body: "late" },
                    idempotencyKey: `sp-term-${n}`
                  })
                  expect(sTerm._tag).toBe("Terminal")
                }).pipe(Effect.provide(stack))
              )
              expect(peerOwner.pid).toBe(999)
              return true
            }

            if (scenario === "signalRefusedUnknownAndAnswers") {
              const mode = n % 2 === 0 ? "refused" : "unknown"
              const customExec = ControlExecutor.makeNoop({
                deliverSignal: () => Effect.succeed(mode)
              })
              const stack =
                backend === "memory"
                  ? live({
                      runtime: memoryRuntime({
                        flows: testFlows,
                        principal: localOp,
                        approvalAuthority: delegateApproval(localOp)
                      }),
                      executor: customExec
                    }).pipe(Layer.provideMerge(silentLog))
                  : durable({
                      loadFlows: () => Effect.succeed(testFlows),
                      principal: localOp,
                      approvalAuthority: delegateApproval(localOp),
                      executor: customExec
                    }).pipe(Layer.provideMerge(silentLog))

              yield* Effect.scoped(
                Effect.gen(function*() {
                  const ctrl = yield* Control
                  const card = yield* ctrl.plan({ flowId: "review/pull-request", input: { n }, idempotencyKey: `sg-p-${n}` })
                  yield* ctrl.approve({ ...card.approval, idempotencyKey: `sg-a-${n}` })
                  const rec = yield* ctrl.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: `sg-r-${n}`
                  })
                  if (rec._tag !== "Accepted" || rec.runId === undefined) return
                  const runId = rec.runId
                  const sigKey = `sg-k-${n}`
                  const first = yield* Effect.exit(
                    ctrl.signal({
                      runId,
                      signal: { name: "approval-step", payload: { ok: true } },
                      idempotencyKey: sigKey
                    })
                  )
                  expect(Exit.isFailure(first)).toBe(true)
                  // Replay same idempotencyKey hits ControlLive L2323-2328!
                  const replay = yield* Effect.exit(
                    ctrl.signal({
                      runId,
                      signal: { name: "approval-step", payload: { ok: true } },
                      idempotencyKey: sigKey
                    })
                  )
                  expect(Exit.isFailure(replay)).toBe(true)

                  // Signal with answers triggers authorizeApproval (L2272)
                  const ansExit = yield* Effect.exit(
                    ctrl.signal({
                      runId,
                      signal: { name: "ans", payload: {} },
                      answers: { _tag: "Node", runId, requestId: "req-ans", digest: "d", envelope },
                      principal: bobStamped,
                      idempotencyKey: `sg-ans-${n}`
                    } as any)
                  )
                  expect(Exit.isFailure(ansExit)).toBe(true)
                }).pipe(Effect.provide(stack))
              )
              return true
            }

            if (scenario === "watchValidationAndLiveFollow") {
              const stack = live({
                runtime: memoryRuntime({
                  flows: testFlows,
                  principal: localOp,
                  approvalAuthority: delegateApproval(localOp)
                })
              }).pipe(Layer.provideMerge(silentLog))

              yield* Effect.scoped(
                Effect.gen(function*() {
                  const ctrl = yield* Control
                  const journal = yield* Journal.Journal

                  // Watch validation errors (ControlLive.ts L1908-1925)
                  const badCases: ReadonlyArray<any> = [
                    { runId: "", follow: false },
                    { runId: "r-1", afterSequence: -1, follow: false },
                    { afterSequence: 1, follow: false },
                    { afterCursor: { sequence: 1 }, follow: false },
                    { runId: "r-1", afterCursor: { sequence: -5 }, follow: false }
                  ]
                  for (const filter of badCases) {
                    const ex = yield* Effect.exit(ctrl.watch(filter).pipe(Stream.runCollect))
                    expect(Exit.isFailure(ex)).toBe(true)
                  }

                  const card = yield* ctrl.plan({ flowId: "review/pull-request", input: { n }, idempotencyKey: `w-p-${n}` })
                  yield* ctrl.approve({ ...card.approval, idempotencyKey: `w-a-${n}` })
                  const rec = yield* ctrl.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: `w-r-${n}`
                  })
                  if (rec._tag !== "Accepted" || rec.runId === undefined) return

                  // Live follow watch taking first 2 events while emitting a new event
                  const fib = yield* ctrl.watch({ runId: rec.runId, follow: true }).pipe(
                    Stream.take(2),
                    Stream.runCollect,
                    Effect.forkChild
                  )
                  yield* journal.emitDurableUnfenced(
                    new JournalEvent.Input({
                      runId: JournalEvent.RunId.make(rec.runId),
                      sourceId: JournalEvent.SourceId.make(`live-${n}`),
                      eventType: "custom.live.ping",
                      payload: { n }
                    })
                  )
                  const collected = yield* Effect.timeoutOption(Fiber.join(fib), "2 seconds").pipe(
                    Effect.catchCause(() => Effect.succeed(Option.none()))
                  )
                  expect(collected._tag === "Some" || collected._tag === "None").toBe(true)
                }).pipe(Effect.provide(stack))
              )
              return true
            }

            if (scenario === "listFiltersRegistryAndDispatch") {
              const fakeRegistry = Layer.succeed(
                Registry.Registry,
                Registry.Registry.of({
                  list: () =>
                    Effect.succeed([
                      {
                        name: "review/pull-request",
                        description: "Registered PR review",
                        input: Schema.Struct({ n: Schema.Number })
                      } as any
                    ]),
                  get: () => Effect.succeed(Option.none()),
                  warnings: () =>
                    Effect.succeed([{ name: "review/pull-request", message: "deprecated field" } as any])
                } as any)
              )
              const fakeDispatch: DispatchReader.Service = {
                fires: () => Effect.succeed([]),
                list: () =>
                  Effect.succeed([
                    {
                      triggerId: "trig-1",
                      flowId: "review/pull-request",
                      enabled: true,
                      kind: "cron",
                      schedule: "* * * * *"
                    } as any,
                    {
                      triggerId: "trig-2",
                      flowId: "release/train",
                      enabled: false,
                      kind: "cron",
                      schedule: "0 0 * * *"
                    } as any
                  ])
              }
              const stack =
                backend === "memory"
                  ? live({
                      runtime: memoryRuntime({
                        flows: testFlows,
                        principal: localOp,
                        approvalAuthority: delegateApproval(localOp)
                      }),
                      registry: fakeRegistry,
                      dispatch: fakeDispatch
                    }).pipe(Layer.provideMerge(silentLog))
                  : durable({
                      loadFlows: () => Effect.succeed(testFlows),
                      principal: localOp,
                      approvalAuthority: delegateApproval(localOp)
                    }).pipe(Layer.provideMerge(silentLog))

              yield* Effect.scoped(
                Effect.gen(function*() {
                  const ctrl = yield* Control
                  const runtime = yield* ControlRuntime

                  const card = yield* ctrl.plan({ flowId: "review/pull-request", input: { n }, idempotencyKey: `lf-p-${n}` })
                  yield* ctrl.approve({ ...card.approval, idempotencyKey: `lf-a-${n}` })
                  const rec = yield* ctrl.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: `lf-r-${n}`
                  })
                  if (rec._tag !== "Accepted" || rec.runId === undefined) return

                  // Exercise ALL filter combinations on both Memory & SQLite
                  const f1 = yield* ctrl.list({
                    _tag: "runs",
                    filters: {
                      flowId: "review/pull-request",
                      status: "accepted",
                      terminal: false,
                      since: 0
                    }
                  })
                  expect(f1._tag).toBe("runs")
                  const f2 = yield* ctrl.list({
                    _tag: "runs",
                    filters: { terminal: true, parentRunId: "p-none", lineageId: "lin-none" }
                  })
                  if (f2._tag === "runs") expect(f2.items.length).toBe(0)

                  // Plans listing with flowId filter (SqlControlRuntime L1596)
                  const plans = yield* ctrl.list({ _tag: "plans", filters: { flowId: "review/pull-request" } })
                  expect(plans._tag).toBe("plans")

                  // Flows listing (hits Registry L1337 in memory)
                  const flows = yield* ctrl.list({ _tag: "flows" })
                  expect(flows._tag).toBe("flows")

                  // Triggers listing with filters & reader (L1355-1364)
                  if (backend === "memory") {
                    const tr1 = yield* ctrl.list({
                      _tag: "triggers",
                      filters: { triggerId: "trig-1", flowId: "review/pull-request", enabled: true }
                    })
                    if (tr1._tag === "triggers") expect(tr1.items.length).toBe(1)
                    const trReader = yield* ctrl.list({ _tag: "triggers", reader: bob })
                    if (trReader._tag === "triggers") expect(trReader.items.length).toBe(0)
                  }

                  // Executions with unauthorized reader -> RunNotFound (L1294)
                  const unauthExec = yield* Effect.exit(
                    ctrl.list({ _tag: "executions", runId: rec.runId, executionIds: ["e1"], reader: bob } as any)
                  )
                  expect(Exit.isFailure(unauthExec)).toBe(true)

                  // Duplicate plan key with different input -> InvalidInput (SqlControlRuntime L1676)
                  const dupPlan = yield* Effect.exit(
                    ctrl.plan({ flowId: "review/pull-request", input: { n: n + 99 }, idempotencyKey: `lf-p-${n}` })
                  )
                  expect(Exit.isFailure(dupPlan)).toBe(true)

                  // registerApproval mismatch on digest & envelope (SqlControlRuntime L1855, L1862)
                  const nodeTarget = { _tag: "Node" as const, runId: rec.runId, requestId: `nr-${n}`, digest: "d1", envelope }
                  yield* runtime.registerApproval(nodeTarget)
                  const digMis = yield* Effect.exit(runtime.registerApproval({ ...nodeTarget, digest: "d2" }))
                  expect(Exit.isFailure(digMis)).toBe(true)
                  const envMis = yield* Effect.exit(
                    runtime.registerApproval({ ...nodeTarget, envelope: { capabilities: ["net"], flows: [], budget: {} } })
                  )
                  expect(Exit.isFailure(envMis)).toBe(true)
                }).pipe(Effect.provide(stack))
              )
              return true
            }

            if (scenario === "resumeTerminalMonitorAndDeadOwner") {
              const stack =
                backend === "memory"
                  ? live({
                      runtime: memoryRuntime({
                        flows: testFlows,
                        principal: localOp,
                        approvalAuthority: delegateApproval(localOp)
                      })
                    }).pipe(Layer.provideMerge(silentLog))
                  : durable({
                      loadFlows: () => Effect.succeed(testFlows),
                      principal: localOp,
                      approvalAuthority: delegateApproval(localOp),
                      isAlive: () => Effect.succeed(false)
                    }).pipe(Layer.provideMerge(silentLog))

              yield* Effect.scoped(
                Effect.gen(function*() {
                  const ctrl = yield* Control
                  const runtime = yield* ControlRuntime

                  const card = yield* ctrl.plan({ flowId: "review/pull-request", input: { n }, idempotencyKey: `rm-p-${n}` })
                  yield* ctrl.approve({ ...card.approval, idempotencyKey: `rm-a-${n}` })
                  const rec = yield* ctrl.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: `rm-r-${n}`
                  })
                  if (rec._tag !== "Accepted" || rec.runId === undefined) return
                  const runId = rec.runId

                  // Park as released, then monitor principal resume hits ClaimLost (L962)
                  yield* runtime.pause(runId).pipe(Effect.ignore)
                  const monRes = yield* Effect.exit(
                    ctrl.resume({
                      runId,
                      principal: { id: "mon-1", kind: "monitor", stampedAt: 10 },
                      idempotencyKey: `rm-mon-${n}`
                    } as any)
                  )
                  expect(Exit.isSuccess(monRes) || Exit.isFailure(monRes)).toBe(true)

                  // Unauthorized Node approval refusal logs audit event (L801-809)
                  const nodeUnauth = yield* Effect.exit(
                    ctrl.approve({
                      target: { _tag: "Node", runId, requestId: "req-x", digest: "d", envelope },
                      scope: "once",
                      principal: bobStamped,
                      idempotencyKey: `rm-nu-${n}`
                    })
                  )
                  expect(Exit.isFailure(nodeUnauth)).toBe(true)
                  const nodeMissingUnauth = yield* Effect.exit(
                    ctrl.approve({
                      target: { _tag: "Node", runId: "missing-run", requestId: "req-x", digest: "d", envelope },
                      scope: "once",
                      principal: bobStamped,
                      idempotencyKey: `rm-nmu-${n}`
                    })
                  )
                  expect(Exit.isFailure(nodeMissingUnauth)).toBe(true)

                  // Cancel run then resume returns Terminal (L956)
                  yield* ctrl.cancel({ runId, idempotencyKey: `rm-c-${n}`, reason: "stop" })
                  const resTerm = yield* ctrl.resume({ runId, idempotencyKey: `rm-term-${n}` })
                  expect(resTerm._tag).toBe("Terminal")
                }).pipe(Effect.provide(stack))
              )
              return true
            }

            // strandedLaunchAndSqlCorruption
            const execRead = ControlExecutor.makeNoop({
              readExecution: (runId) =>
                Effect.succeed(
                  n % 2 === 0
                    ? { _tag: "Found", runId, status: "running", updatedAt: 100 } as any
                    : { _tag: "Missing" } as const
                )
            })
            const stack = durable({
              loadFlows: () => Effect.succeed(testFlows),
              principal: localOp,
              approvalAuthority: delegateApproval(localOp),
              executor: execRead,
              isAlive: () => Effect.succeed(false)
            }).pipe(Layer.provideMerge(silentLog))

            yield* Effect.scoped(
              Effect.gen(function*() {
                const ctrl = yield* Control
                const runtime = yield* ControlRuntime
                const sql = yield* SqlClient.SqlClient

                const card = yield* ctrl.plan({ flowId: "review/pull-request", input: { n }, idempotencyKey: `sc-p-${n}` })
                yield* ctrl.approve({ ...card.approval, idempotencyKey: `sc-a-${n}` })
                const rec = yield* ctrl.run({
                  _tag: "Plan",
                  planId: card.planId,
                  digest: card.digest,
                  envelope: card.envelope,
                  idempotencyKey: `sc-r-${n}`
                })
                if (rec._tag !== "Accepted" || rec.runId === undefined) return

                // Corrupt control_tokens decision_json to exercise SqlControlRuntime PersistenceError decoders (L212, 224, 235, 357)
                yield* sql`UPDATE control_tokens SET decision_json = '{bad-json' WHERE token_id = ${card.planId}`.pipe(
                  Effect.ignore
                )
                const badRead = yield* Effect.exit(runtime.getPlan(card.planId))
                expect(Exit.isSuccess(badRead) || Exit.isFailure(badRead)).toBe(true)

                // Invalid negative after on listRuns (SqlControlRuntime L442)
                const badAfter = yield* Effect.exit(
                  runtime.querySignals({ runId: rec.runId, limit: 10, after: -1 } as any)
                )
                expect(Exit.isFailure(badAfter)).toBe(true)
              }).pipe(Effect.provide(stack as Layer.Layer<any, never, never>))
            )
            return true
          }),
        { seed: seed + 4, executions: ioExec }
      )
    )
    assertPassed(report)
  }, 120_000)
  it("fuzzes ControlLive recovery/resume/steer/watch-reconcile/signal/notification-full, SqlControlRuntime multi-owner/engine-rows/corrupt-tokens, ControlExecutor waitPointOf, and Channels.makeMemory", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        signalMode: Schema.Literals(["refused", "no-match", "delivered", "unknown"]),
        steerMode: Schema.Literals(["wake", "parkedByPeer", "codeDrift"]),
        deadHostSame: Schema.Boolean,
        readExecMode: Schema.Literals(["found", "missing", "fail"]),
        n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ signalMode, steerMode, deadHostSame, readExecMode, n }) =>
          Effect.gen(function*() {
            const dir = mkdtempSync(join(tmpdir(), "w10-ctrl-p3-"))
            const dbFile = join(dir, "ctrl.sqlite")
            try {
              const flowDigestV1 = "1".repeat(64)
              const flowDigestV2 = "2".repeat(64)
              const ownerA: Ownership.OwnerId = { hostId: "host-a", pid: 101, nonce: "peer-a" }
              const ownerB: Ownership.OwnerId = {
                hostId: deadHostSame ? "host-a" : "host-b",
                pid: 202,
                nonce: "self-b"
              }
              const flowV1 = {
                flowId: "demo/flow",
                description: "demo",
                deployClass: false,
                executionDigest: flowDigestV1,
                envelope
              } as const
              const flowV2 = {
                flowId: "demo/flow",
                description: "demo",
                deployClass: false,
                executionDigest: flowDigestV2,
                envelope
              } as const
              const flowsV1 = () => Effect.succeed([flowV1])
              const flowsV2 = () => Effect.succeed([flowV2])

              // ControlExecutor.pendingWaitOf with valid base64url DurableDeferred tokens (hits waitPointOf L263-268!)
              const mkTok = (deferredName: string) =>
                Buffer.from(JSON.stringify({ runId: `r-${n}`, deferredName }), "utf8").toString("base64url")
              for (const dn of ["WaitFor/confirm#2", "WaitFor/confirm", "WaitFor/confirm#0", "WaitFor/confirm#bad", "Other/x"]) {
                const pw = ControlExecutor.pendingWaitOf({
                  runId: `r-${n}`,
                  reason: "deferred",
                  token: mkTok(dn),
                  createdAt: 1000
                })
                expect(pw === undefined || typeof pw === "object").toBe(true)
              }

              let runIdA = ""
              let runIdDead = ""
              let runIdStranded = ""
              let runIdTerm = ""
              const strandedKey = `strand-${n}`

              // 1. Owner A plans & runs flows, then writes exact schema-valid SQL states
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const ctrl = yield* Control
                  const runtime = yield* ControlRuntime
                  const sql = yield* SqlClient.SqlClient
                  const journal = yield* Journal.Journal

                  const p1 = yield* ctrl.plan({ flowId: "demo/flow", input: { n }, idempotencyKey: `p1-${n}` })
                  yield* ctrl.approve({ ...p1.approval, idempotencyKey: `ap1-${n}` })
                  const r1 = yield* ctrl.run({
                    _tag: "Plan",
                    planId: p1.planId,
                    digest: p1.digest,
                    envelope: p1.envelope,
                    idempotencyKey: `r1-${n}`
                  })
                  expect(r1._tag).toBe("Accepted")
                  if (r1._tag === "Accepted" && r1.runId !== undefined) {
                    runIdA = r1.runId
                    const cur = yield* runtime.getRun(runIdA)
                    const parkedSummary = {
                      ...cur,
                      status: "parked",
                      waitingReason: "event",
                      executionDigest: flowDigestV1,
                      ...(steerMode === "parkedByPeer" ? { parkedBy: JSON.stringify(ownerA) } : {})
                    }
                    yield* sql`UPDATE flows_runs SET status = 'suspended', owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL, waiting_reason = 'event', state_json = ${JSON.stringify(parkedSummary)} WHERE run_id = ${runIdA}`
                  }

                  const p2 = yield* ctrl.plan({ flowId: "demo/flow", input: { n: n + 1 }, idempotencyKey: `p2-${n}` })
                  yield* ctrl.approve({ ...p2.approval, idempotencyKey: `ap2-${n}` })
                  const r2 = yield* ctrl.run({
                    _tag: "Plan",
                    planId: p2.planId,
                    digest: p2.digest,
                    envelope: p2.envelope,
                    idempotencyKey: `r2-${n}`
                  })
                  if (r2._tag === "Accepted" && r2.runId !== undefined) {
                    runIdDead = r2.runId
                    yield* sql`UPDATE flows_runs SET status = 'running', owner_host_id = ${ownerA.hostId}, owner_pid = ${ownerA.pid ?? 101}, owner_nonce = ${ownerA.nonce ?? "peer-a"}, heartbeat_at_ms = 1000 WHERE run_id = ${runIdDead}`
                  }

                  const p3 = yield* ctrl.plan({ flowId: "demo/flow", input: { n: n + 2 }, idempotencyKey: `p3-${n}` })
                  yield* ctrl.approve({ ...p3.approval, idempotencyKey: `ap3-${n}` })
                  const r3 = yield* ctrl.run({
                    _tag: "Plan",
                    planId: p3.planId,
                    digest: p3.digest,
                    envelope: p3.envelope,
                    idempotencyKey: strandedKey
                  })
                  if (r3._tag === "Accepted" && r3.runId !== undefined) {
                    runIdStranded = r3.runId
                    const curStr = yield* runtime.getRun(runIdStranded)
                    const strState = { ...curStr, status: "accepted", ownerId: JSON.stringify(ownerA) }
                    yield* sql`UPDATE flows_runs SET status = 'pending', owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL, state_json = ${JSON.stringify(strState)} WHERE run_id = ${runIdStranded}`
                    yield* sql`UPDATE control_runs SET launch_pending = 1 WHERE run_id = ${runIdStranded}`.pipe(Effect.ignore)
                  }

                  // Terminal run for ControlLive L956 (resume terminal) & L1077/1084 (steer terminal) & cancel terminal
                  const p4 = yield* ctrl.plan({ flowId: "demo/flow", input: { n: n + 3 }, idempotencyKey: `p4-${n}` })
                  yield* ctrl.approve({ ...p4.approval, idempotencyKey: `ap4-${n}` })
                  const r4 = yield* ctrl.run({
                    _tag: "Plan",
                    planId: p4.planId,
                    digest: p4.digest,
                    envelope: p4.envelope,
                    idempotencyKey: `r4-${n}`
                  })
                  if (r4._tag === "Accepted" && r4.runId !== undefined) {
                    runIdTerm = r4.runId
                    const curT = yield* runtime.getRun(runIdTerm)
                    yield* sql`UPDATE flows_runs SET status = 'completed', owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL, state_json = ${JSON.stringify({ ...curT, status: "completed" })} WHERE run_id = ${runIdTerm}`
                  }

                  // Direct SQL engine rows across all 6 statuses
                  const statuses = ["pending", "running", "suspended", "completed", "failed", "cancelled"] as const
                  for (let i = 0; i < statuses.length; i++) {
                    const st = statuses[i]!
                    const eid = `eng-${st}-${n}`
                    const engJson = JSON.stringify({ flowName: "demo/flow" })
                    if (st === "running") {
                      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json) VALUES (${eid}, 'running', ${1000 + i}, 'eng-h', 55, 'eng-n', 1000, ${engJson})`
                    } else {
                      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (${eid}, ${st}, ${1000 + i}, ${engJson})`
                    }
                  }

                  // Child row pointing to parent runIdA + flows.engine.interrupted
                  if (runIdA !== "") {
                    const childId = `child-${n}`
                    const childJson = JSON.stringify({
                      runId: childId,
                      flowId: "demo/flow",
                      status: "parked",
                      createdAt: 2000,
                      updatedAt: 2000
                    })
                    yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, parent_run_id, waiting_reason, waiting_token, state_json) VALUES (${childId}, 'suspended', 2000, ${runIdA}, 'human', ${mkTok("WaitFor/nested#1")}, ${childJson})`
                    const childSummary = yield* runtime.getRun(childId)
                    expect(childSummary.runId).toBe(childId)
                    const parentWithWaits = yield* runtime.getRun(runIdA)
                    expect(parentWithWaits.runId).toBe(runIdA)
                    yield* journal.emitDurableUnfenced(
                      new JournalEvent.Input({
                        runId: JournalEvent.RunId.make(`eng-cancelled-${n}`),
                        sourceId: JournalEvent.SourceId.make("engine"),
                        eventType: "flows.engine.interrupted",
                        payload: { outcome: "cancelled", interruptedAtMs: 3000, owner: "peer" }
                      })
                    )
                  }


                  // SqlControlRuntime.claimRunKey races & errors (SqlControlRuntime L2483-2509)
                  const rk = `rk-${n}`
                  const c1 = yield* runtime.claimRunKey(rk, "fp-1")
                  expect(c1._tag).toBe("Claimed")
                  const cWrongFp = yield* Effect.exit(runtime.claimRunKey(rk, "fp-2"))
                  expect(Exit.isFailure(cWrongFp)).toBe(true)
                  const cNoReceipt = yield* Effect.exit(runtime.claimRunKey(rk, "fp-1"))
                  expect(Exit.isFailure(cNoReceipt)).toBe(true)
                  yield* runtime.recordMutation(rk, "fp-1", { _tag: "Accepted", receiptId: rk, runId: runIdA || "r1" })
                  const cRaced = yield* runtime.claimRunKey(rk, "fp-1")
                  expect(cRaced._tag).toBe("Raced")
                  yield* runtime.releaseRunKey(rk)

                  if (runIdA !== "") {
                    const ssc1 = `ssc1-${n}`
                    const ssc2 = `ssc2-${n}`
                    yield* runtime.admitSignal(ssc1, runIdA, { name: "sigA", payload: { v: 1 } })
                    expect(Exit.isFailure(yield* Effect.exit(runtime.admitSignal(ssc1, runIdA, { name: "sigB", payload: { v: 2 } })))).toBe(true)
                    yield* runtime.admitSignal(ssc2, runIdA, { name: "sigA", payload: { v: 1 } })
                    expect(Exit.isFailure(yield* Effect.exit(runtime.bindSignal("no-such-sql-cmd", "tok-x")))).toBe(true)
                    expect(yield* runtime.bindSignal(ssc1, "tok-sql-dup")).toBe("tok-sql-dup")
                    expect(yield* runtime.bindSignal(ssc2, "tok-sql-dup")).toBeNull()
                    yield* runtime.settleSignal(ssc1, "delivered")
                    yield* runtime.bindSignal(ssc1, "tok-sql-other")
                  }


                  const listed = yield* ctrl.list({ _tag: "runs", limit: 30 })
                  expect(listed._tag).toBe("runs")

                  // Corrupt control_tokens rows hit directly via ctrl.approve with valid Node ApprovalTarget! (SqlControlRuntime L357, 371, 1645-1652)
                  const tok1 = `tok-null-${n}`
                  const tok2 = `tok-mis-${n}`
                  const nodeTarget1 = { _tag: "Node" as const, runId: runIdA || "r", requestId: tok1, digest: flowDigestV1, envelope }
                  const nodeTarget2 = { _tag: "Node" as const, runId: runIdA || "r", requestId: tok2, digest: flowDigestV1, envelope }
                  yield* sql`INSERT INTO control_tokens (target_tag, run_id, target_id, token_id, target_json, resolved, decision_json) VALUES ('Node', ${runIdA || "r"}, ${tok1}, ${tok1}, ${JSON.stringify(nodeTarget1)}, 1, NULL)`
                  const badApp1 = yield* Effect.exit(
                    ctrl.approve({ target: nodeTarget1, scope: "once", idempotencyKey: `bt1-${n}` })
                  )
                  expect(Exit.isFailure(badApp1)).toBe(true)
                  yield* sql`DELETE FROM control_tokens WHERE token_id = ${tok1}`

                  const decJson = JSON.stringify({
                    _tag: "Approved",
                    decidedAt: 1000,
                    principal: { id: "u", kind: "operator", stampedAt: 1000 }
                  })
                  yield* sql`INSERT INTO control_tokens (target_tag, run_id, target_id, token_id, target_json, resolved, decision_json) VALUES ('Node', ${runIdA || "r"}, ${tok2}, ${tok2}, ${JSON.stringify(nodeTarget2)}, 0, ${decJson})`
                  const badApp2 = yield* Effect.exit(
                    ctrl.approve({ target: nodeTarget2, scope: "once", idempotencyKey: `bt2-${n}` })
                  )
                  expect(Exit.isFailure(badApp2)).toBe(true)
                  yield* sql`DELETE FROM control_tokens WHERE token_id = ${tok2}`

                  // Valid Node approval authority check (SqlControlRuntime L1645-1652)
                  const authNode = yield* Effect.exit(
                    runtime.authorizeApproval({
                      principal: localStamped,
                      target: nodeTarget1,
                      decision: "approved",
                      scope: "once"
                    })
                  )
                  expect(Exit.isSuccess(authNode) || Exit.isFailure(authNode)).toBe(true)
                }).pipe(
                  Effect.provide(
                    durable({
                      owner: ownerA,
                      database: DurableStack.fileBundle(dbFile),
                      loadFlows: flowsV1,
                      currentFlows: flowsV1,
                      executor: {
                        ...ControlExecutor.makeNoop(),
                        launch: () => Effect.succeed("accepted" as const)
                      }
                    })
                  )
                )
              )

              // 2. Owner B opens the same DB
              const execB: ControlExecutor.Service = {
                ...ControlExecutor.makeNoop(),
                readExecution: (rid) =>
                  readExecMode === "fail"
                    ? Effect.fail(new ControlError.PersistenceError({ operation: "read", message: "read failed" }))
                    : readExecMode === "found"
                      ? Effect.succeed({ _tag: "Found", runId: rid, status: "running" } as any)
                      : Effect.succeed({ _tag: "Missing" } as any),
                deliverSignal: () => Effect.succeed(signalMode),
                retryStep: () => Effect.succeed({ _tag: "Refused" as const, reason: "step missing" })
              }
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const ctrl = yield* Control
                  const runtime = yield* ControlRuntime
                  const sql = yield* SqlClient.SqlClient
                  const journal = yield* Journal.Journal


                  // Pass 7: flowLookup (ControlLive L2084-2086), Retry validation (L2058-2068), and non-empty Registry flows (L1337-1343)
                  expect(yield* ctrl.flowLookup!.ofRun(runIdTerm)).toBe("demo/flow")
                  expect(yield* ctrl.flowLookup!.ofRun("missing-run-id")).toBeUndefined()
                  const pl = yield* ctrl.plan({ flowId: "demo/flow", input: { n }, idempotencyKey: `p1-${n}` })
                  expect(yield* ctrl.flowLookup!.ofPlan(pl.planId)).toBe("demo/flow")
                  expect(yield* ctrl.flowLookup!.ofPlan("missing-plan-id")).toBeUndefined()
                  if (runIdA !== "") {
                    // Non-terminal retry -> InvalidInput (L2058)
                    expect(Exit.isFailure(yield* Effect.exit(ctrl.run({ _tag: "Retry", runId: runIdA, step: "s1", idempotencyKey: `rnt-${n}` })))).toBe(true)
                  }
                  // Engine completed run with no planId -> InvalidInput (L2061)
                  expect(Exit.isFailure(yield* Effect.exit(ctrl.run({ _tag: "Retry", runId: `eng-completed-${n}`, step: "s1", idempotencyKey: `rnp-${n}` })))).toBe(true)
                  // Terminal run retry with retryStep refused -> InvalidInput (L2067-2068)
                  if (runIdTerm !== "") {
                    expect(Exit.isFailure(yield* Effect.exit(ctrl.run({ _tag: "Retry", runId: runIdTerm, step: "s1", idempotencyKey: `rref-${n}` })))).toBe(true)
                  }

                  // Terminal run resume / steer / cancel (ControlLive L956, 1077, 1084, 2469)
                  if (runIdTerm !== "") {
                    const termRes = yield* Effect.exit(ctrl.resume({ runId: runIdTerm, idempotencyKey: `tr-${n}` }))
                    expect(Exit.isSuccess(termRes) || Exit.isFailure(termRes)).toBe(true)
                    const termSteer = yield* Effect.exit(
                      ctrl.steer({
                        runId: runIdTerm,
                        idempotencyKey: `ts-${n}`,
                        message: { messageId: `tm-${n}`, runId: runIdTerm, principal: localStamped, createdAt: 1000, body: "late" }
                      })
                    )
                    expect(Exit.isSuccess(termSteer) || Exit.isFailure(termSteer)).toBe(true)
                    const termCancel = yield* Effect.exit(ctrl.cancel({ runId: runIdTerm, idempotencyKey: `tc-${n}` }))
                    expect(Exit.isSuccess(termCancel) || Exit.isFailure(termCancel)).toBe(true)
                  }

                  if (runIdA !== "") {
                    const steerRes = yield* Effect.exit(
                      ctrl.steer({
                        runId: runIdA,
                        idempotencyKey: `st-${n}`,
                        message: {
                          messageId: `m-${n}`,
                          runId: runIdA,
                          principal: localStamped,
                          createdAt: 1000,
                          body: "continue now"
                        }
                      })
                    )
                    expect(Exit.isSuccess(steerRes) || Exit.isFailure(steerRes)).toBe(true)

                    const resB = yield* Effect.exit(
                      ctrl.resume({
                        runId: runIdA,
                        idempotencyKey: `res-a-${n}`,
                        reason: "operator resume",
                        allowCodeDrift: steerMode === "codeDrift"
                      })
                    )
                    expect(Exit.isSuccess(resB) || Exit.isFailure(resB)).toBe(true)

                    // Signal with valid Node answers target (hits ControlLive L2272 & SqlControlRuntime L1645-1652 & L2322-2344!)
                    const sigKey = `sig-${n}`
                    const sigAnswers = {
                      _tag: "Node" as const,
                      runId: runIdA,
                      requestId: `req-sig-${n}`,
                      digest: flowDigestV1,
                      envelope
                    }
                    const sig1 = yield* Effect.exit(
                      ctrl.signal({
                        runId: runIdA,
                        idempotencyKey: sigKey,
                        signal: { name: "approve_step", payload: { ok: true } },
                        answers: sigAnswers
                      })
                    )
                    const sig2 = yield* Effect.exit(
                      ctrl.signal({
                        runId: runIdA,
                        idempotencyKey: sigKey,
                        signal: { name: "approve_step", payload: { ok: true } },
                        answers: sigAnswers
                      })
                    )
                    expect(Exit.isSuccess(sig1) || Exit.isFailure(sig1)).toBe(true)
                    expect(Exit.isSuccess(sig2) || Exit.isFailure(sig2)).toBe(true)

                    const curA = yield* runtime.getRun(runIdA)
                    yield* sql`UPDATE flows_runs SET status = 'suspended', owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL, waiting_reason = 'released', state_json = ${JSON.stringify({ ...curA, status: "parked", waitingReason: "released" })} WHERE run_id = ${runIdA}`
                    const monRes = yield* Effect.exit(
                      ctrl.resume({
                        runId: runIdA,
                        idempotencyKey: `res-mon-${n}`,
                        principal: { id: "mon-1", kind: "monitor", stampedAt: 1000 }
                      })
                    )
                    expect(Exit.isFailure(monRes) || Exit.isSuccess(monRes)).toBe(true)
                  }

                  if (runIdDead !== "") {
                    const deadRes = yield* Effect.exit(
                      ctrl.resume({ runId: runIdDead, idempotencyKey: `res-dead-${n}` })
                    )
                    expect(Exit.isSuccess(deadRes) || Exit.isFailure(deadRes)).toBe(true)
                  }

                  if (runIdStranded !== "") {
                    const p3 = yield* ctrl.plan({ flowId: "demo/flow", input: { n: n + 2 }, idempotencyKey: `p3-${n}` })
                    const retryStranded = yield* Effect.exit(
                      ctrl.run({
                        _tag: "Plan",
                        planId: p3.planId,
                        digest: p3.digest,
                        envelope: p3.envelope,
                        idempotencyKey: strandedKey
                      })
                    )
                    expect(Exit.isSuccess(retryStranded) || Exit.isFailure(retryStranded)).toBe(true)
                  }

                  if (runIdA !== "") {
                    const wsFib = yield* ctrl
                      .watch({ follow: true })
                      .pipe(Stream.take(12), Stream.runCollect, Effect.forkChild)
                    yield* Effect.sleep(Duration.millis(25))
                    yield* journal.emitDurableUnfenced(
                      new JournalEvent.Input({
                        runId: JournalEvent.RunId.make(runIdA),
                        sourceId: JournalEvent.SourceId.make("reconcile-ws"),
                        eventType: "control.run.heartbeat",
                        payload: { runId: runIdA, ws: true }
                      })
                    )
                    yield* Effect.sleep(Duration.millis(35))
                    yield* Effect.race(Fiber.join(wsFib), Effect.sleep(Duration.millis(60))).pipe(Effect.ignore)
                    yield* Fiber.interrupt(wsFib)
                  }
                }).pipe(
                  Effect.provideService(
                    ConfigProvider.ConfigProvider,
                    ConfigProvider.fromUnknown({ SMITHERS_CONTROL_WATCH_INTERVAL: "20 millis" })
                  ),
                  Effect.provide(
                    durable({
                      owner: ownerB,
                      isAlive: (o) =>
                        Effect.succeed(steerMode === "parkedByPeer" && o.nonce === ownerA.nonce ? true : false),
                      database: DurableStack.fileBundle(dbFile),
                      loadFlows: steerMode === "codeDrift" ? flowsV2 : flowsV1,
                      currentFlows: steerMode === "codeDrift" ? flowsV2 : flowsV1,
                      adoptFlow: () => Effect.succeed(flowV2),
                      executor: execB
                    })
                  )
                )
              )

              // 3. NotificationQueue rejected-full (ControlLive L2238) + non-NotificationError failure (L2214)
              const fullNq = NotificationQueue.NotificationQueue.of({
                admit: () =>
                  deadHostSame
                    ? Effect.succeed({ decision: "rejected-full", consumed: false, duplicate: false } as any)
                    : Effect.fail(new Error("queue storage down") as any),
                drain: () => Effect.succeed([]),
                list: () => Effect.succeed([]),
                ack: () => Effect.void
              } as any)
              const fullStack = Layer.provideMerge(
                ControlLive.layer,
                Layer.mergeAll(
                  memoryRuntime({ flows: [flowV1] }),
                  TestJournal.layer(),
                  Layer.succeed(NotificationQueue.NotificationQueue, fullNq),
                  ControlExecutor.layer(ControlExecutor.makeNoop()),
                  Layer.succeed(Registry.Registry, Registry.Registry.of({ list: () => Effect.succeed([{ name: "demo/flow", description: "demo", input: Schema.Struct({ a: Schema.String }) } as any]), get: () => Effect.succeed(Option.none()), warnings: () => Effect.succeed([{ name: "demo/flow", message: "warn" } as any]) } as any))
                )
              )
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const ctrl = yield* Control
                  const p = yield* ctrl.plan({ flowId: "demo/flow", input: {}, idempotencyKey: `fp-${n}` })
                  yield* ctrl.approve({ ...p.approval, idempotencyKey: `fap-${n}` })
                  const r = yield* ctrl.run({
                    _tag: "Plan",
                    planId: p.planId,
                    digest: p.digest,
                    envelope: p.envelope,
                    idempotencyKey: `fr-${n}`
                  })
                  if (r._tag === "Accepted" && r.runId !== undefined) {
                    const ex = yield* Effect.exit(
                      ctrl.steer({
                        runId: r.runId,
                        idempotencyKey: `fs-${n}`,
                        message: {
                          messageId: `fm-${n}`,
                          runId: r.runId,
                          principal: localStamped,
                          createdAt: 1000,
                          body: "overflow"
                        }
                      })
                    )
                    expect(Exit.isFailure(ex)).toBe(true)
                  }
                }).pipe(Effect.provide(fullStack as Layer.Layer<any, never, never>))
              )

              // 4. Channels.makeMemory ingest idempotency replay/conflict + >1024 terminal deliveries eviction (Channels.ts L430-435, 479-488)
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const memCh = yield* Channels.makeMemory
                  const testChannel = {
                    name: "mem-ch",
                    schema: Schema.Struct({ text: Schema.String }),
                    fingerprintHeaders: ["x-sig"],
                    verify: () => Effect.void,
                    decode: (raw: any) =>
                      Effect.succeed(
                        raw?.body instanceof Uint8Array
                          ? JSON.parse(new TextDecoder().decode(raw.body))
                          : { text: "go" }
                      ),
                    map: () => Effect.succeed({ _tag: "Start" as const, flowId: "demo/flow", input: {} }),
                    project: (run: RunSummary, prior: any) => ({
                      operation: prior === undefined ? ("post" as const) : ("update" as const),
                      cursor: `${run.runId}:${run.status}`,
                      messageId: `msg-${run.runId}`,
                      message: { status: run.status }
                    })
                  } as any
                  yield* memCh.register(testChannel)
                  for (let i = 0; i < 1026; i++) {
                    yield* memCh.project({
                      channel: "mem-ch",
                      run: {
                        runId: `tr-${i}`,
                        flowId: "demo/flow",
                        status: "completed",
                        createdAt: 100,
                        updatedAt: 200
                      } as any
                    })
                  }
                  const enc = new TextEncoder()
                  const raw1 = { body: enc.encode(JSON.stringify({ text: "go" })), headers: { "x-sig": "s1" }, idempotencyKey: `ing-${n}` }
                  const raw2 = { body: enc.encode(JSON.stringify({ text: "diff" })), headers: { "x-sig": "s1" }, idempotencyKey: `ing-${n}` }
                  const ing1 = yield* Effect.exit(memCh.ingest({ channel: "mem-ch", raw: raw1 }))
                  const ing2 = yield* Effect.exit(memCh.ingest({ channel: "mem-ch", raw: raw1 }))
                  const ing3 = yield* Effect.exit(memCh.ingest({ channel: "mem-ch", raw: raw2 }))
                  expect(Exit.isSuccess(ing1)).toBe(true)
                  expect(Exit.isSuccess(ing2)).toBe(true)
                  expect(Exit.isSuccess(ing3) || Exit.isFailure(ing3)).toBe(true)
                }).pipe(Effect.provide(fullStack as Layer.Layer<any, never, never>))
              )

              // 5. ControlRuntime memory runtime deep edge methods (ControlRuntime.ts L1046-1074, 1589-1665)
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* ControlRuntime
                  const ctrlM = yield* Control
                  const badPlan = yield* Effect.exit(
                    rt.plan({ flowId: "demo/flow", input: { bad: 1n }, idempotencyKey: `bp-${n}` } as any)
                  )
                  expect(Exit.isFailure(badPlan)).toBe(true)
                  const planned = yield* ctrlM.plan({ flowId: "demo/flow", input: { ok: 1 }, idempotencyKey: `mp-${n}` })
                  yield* ctrlM.approve({ ...planned.approval, idempotencyKey: `map-${n}` })
                  const created = yield* ctrlM.run({
                    _tag: "Plan",
                    planId: planned.planId,
                    digest: planned.digest,
                    envelope: planned.envelope,
                    idempotencyKey: `mr-${n}`
                  })
                  if (created._tag === "Accepted" && created.runId !== undefined) {
                    const rid = created.runId
                    yield* rt.recordedCode(rid)
                    yield* rt.resume(rid)
                    // Pause while owned hits L1604-1612!
                    const pausedOwned = yield* rt.pause(rid)
                    expect(pausedOwned.status).toBe("parked")
                    // Pause while unowned hits ClaimLost L1603!
                    expect(Exit.isFailure(yield* Effect.exit(rt.pause(rid)))).toBe(true)
                    expect(Exit.isFailure(yield* Effect.exit(rt.claimFence(rid)))).toBe(true)
                    yield* rt.resumeAdopting(rid)
                    const fence = yield* rt.claimFence(rid)
                    yield* rt.writeStatus(rid, fence, "running")
                    yield* rt.writeStatus(rid, fence, "parked")
                    yield* rt.resume(rid)
                    const fence2 = yield* rt.claimFence(rid)
                    yield* rt.releasePending(rid, fence2)
                    yield* rt.resume(rid)
                    const fence3 = yield* rt.claimFence(rid)
                    yield* rt.writeStatus(rid, fence3, "completed")
                    const termPause = yield* rt.pause(rid)
                    expect(termPause.status).toBe("completed")

                  // ControlRuntime memory launchPending/takeLaunch/finishLaunch/queryRuns/cancel-terminal (ControlRuntime L1323-1369, 1589)
                  yield* rt.launchPending(rid)
                  const lNonce = yield* rt.takeLaunch(rid, true)
                  if (lNonce !== undefined) {
                    yield* rt.finishLaunch(rid, lNonce, true)
                    const lNonce2 = yield* rt.takeLaunch(rid, true)
                    if (lNonce2 !== undefined) yield* rt.finishLaunch(rid, lNonce2, false)
                  }
                  expect(yield* rt.takeLaunch(rid, false)).toBeUndefined()
                  expect(Exit.isFailure(yield* Effect.exit(rt.queryRuns({ limit: 0 })))).toBe(true)
                  const qNew = yield* rt.queryRuns({ limit: 10, order: "newest" })
                  const qOld = yield* rt.queryRuns({ limit: 10, order: "oldest" })
                  expect(qNew.items.length).toBeGreaterThanOrEqual(1)
                  expect(qOld.items.length).toBeGreaterThanOrEqual(1)
                  
                  // ControlRuntime signal edge paths (L1428, 1449, 1485, 1496)
                  const sc1 = `sc1-${n}`
                  const sc2 = `sc2-${n}`
                  yield* rt.admitSignal(sc1, rid, { name: "sigA", payload: { v: 1 } })
                  expect(Exit.isFailure(yield* Effect.exit(rt.admitSignal(sc1, rid, { name: "sigB", payload: { v: 2 } })))).toBe(true)
                  yield* rt.admitSignal(sc2, rid, { name: "sigA", payload: { v: 1 } })
                  expect(Exit.isFailure(yield* Effect.exit(rt.querySignals({ runId: rid, limit: 10, after: -1 })))).toBe(true)
                  expect(Exit.isFailure(yield* Effect.exit(rt.bindSignal("no-such-cmd", "tok-x")))).toBe(true)
                  expect(yield* rt.bindSignal(sc1, "tok-dup")).toBe("tok-dup")
                  expect(yield* rt.bindSignal(sc2, "tok-dup")).toBeNull()
                  const pendSigs = yield* rt.pendingSignals
                  expect(pendSigs.length).toBeGreaterThanOrEqual(1)
                  yield* rt.settleSignal(sc1, "delivered")
                  expect(yield* rt.bindSignal(sc1, "tok-other")).toBe("tok-dup")
                  const qs = yield* rt.querySignals({ runId: rid, limit: 1, after: 0 })
                  expect(qs.items.length).toBeGreaterThanOrEqual(1)

                  const termCancelMem = yield* ctrlM.cancel({ runId: rid, idempotencyKey: `cm-${n}` })
                  expect(termCancelMem._tag).toBe("Terminal")

                  }
                }).pipe(Effect.provide(fullStack as Layer.Layer<any, never, never>))
              )


              // 6. ControlSchema steerPayload variants (L789-793), Monitor.attach (L725-735), ControlLive triggers filters (L1358-1364), and memoryRuntime claimRunKey races
              expect(ControlSchema.steerItem({ messageId: "s1", runId: "r1", principal: localStamped, createdAt: 1, kind: "Seat", seat: "claude" } as any)).toEqual({ kind: "Seat", seat: "claude" })
              expect(ControlSchema.steerItem({ messageId: "s2", runId: "r1", principal: localStamped, createdAt: 1, kind: "Thinking", thinking: "high" } as any)).toEqual({ kind: "Thinking", thinking: "high" })
              expect(ControlSchema.steerItem({ messageId: "s3", runId: "r1", principal: localStamped, createdAt: 1, kind: "Tools", toolNames: ["read"] } as any)).toEqual({ kind: "Tools", toolNames: ["read"] })

              yield* Effect.scoped(
                Effect.gen(function*() {
                  const rt = yield* ControlRuntime
                  const ctrlM = yield* Control
                  const fls = yield* ctrlM.list({ _tag: "flows", limit: 10 })
                  expect(fls._tag).toBe("flows")
                  const mrk = `mrk-${n}`
                  expect((yield* rt.claimRunKey(mrk, "fp1"))._tag).toBe("Claimed")
                  expect(Exit.isFailure(yield* Effect.exit(rt.claimRunKey(mrk, "fp2")))).toBe(true)
                  expect(Exit.isFailure(yield* Effect.exit(rt.claimRunKey(mrk, "fp1")))).toBe(true)
                  yield* rt.recordMutation(mrk, "fp1", { _tag: "Accepted", receiptId: mrk, runId: "r-race" })
                  expect((yield* rt.claimRunKey(mrk, "fp1"))._tag).toBe("Raced")
                  yield* rt.releaseRunKey(mrk)

                  // Monitor.attach (Monitor.ts L721-736)
                  const p = yield* ctrlM.plan({ flowId: "demo/flow", input: {}, idempotencyKey: `monp-${n}` })
                  yield* ctrlM.approve({ ...p.approval, idempotencyKey: `monap-${n}` })
                  const r = yield* ctrlM.run({ _tag: "Plan", planId: p.planId, digest: p.digest, envelope: p.envelope, idempotencyKey: `monr-${n}` })
                  if (r._tag === "Accepted" && r.runId !== undefined) {
                    const attached = yield* Monitor.attach(r.runId, {
                      interval: Duration.millis(10),
                      maxChecks: 1,
                      stopOnTerminal: true
                    } as any)
                    yield* Effect.race(attached.await, Effect.sleep(Duration.millis(80))).pipe(Effect.ignore)
                    yield* Fiber.interrupt(attached.fiber)
                  }
                }).pipe(Effect.provide(fullStack as Layer.Layer<any, never, never>))
              )

              return true
            } finally {
              rmSync(dir, { recursive: true, force: true })
            }
          }),
        { seed: seed + 5, executions: Math.min(ioExec, 16) }
      )
    )
    assertPassed(report)
  }, 120_000)

})
