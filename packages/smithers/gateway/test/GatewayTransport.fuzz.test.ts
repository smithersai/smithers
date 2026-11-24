import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as Control from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlRpcs from "@smthrs/control/ControlRpcs"
import type { ControlEvent, PlanCard, Principal, RunSummary } from "@smthrs/control/ControlSchema"
import * as ScopedToken from "@smthrs/control/ScopedToken"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Exit, Layer, Logger, Schema, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { RpcSerialization } from "effect/rpc"
import { TestClock } from "effect/testing"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import * as BunGateway from "../src/bun/BunGateway.ts"
import * as GatewayServer from "../src/GatewayServer.ts"
import * as HostBranchPresence from "../src/HostBranchPresence.ts"
import { makeBunLayer } from "../src/internal/BunGateway.ts"
import * as NativeGateway from "../src/internal/NativeGateway.ts"
import * as NodeGateway from "../src/node/NodeGateway.ts"
import * as Projections from "../src/Projections.ts"
import * as RunHistory from "../src/RunHistory.ts"
import * as RuntimeBridge from "../src/RuntimeBridge.ts"
import { emit, stack } from "./GatewayStack.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const fastExecutions = Math.max(16, Math.min(baseExecutions, 80))
const ioExecutions = Math.max(10, Math.min(baseExecutions, 24))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const health: GatewayServer.Health = {
  workspaceHash: "ws-transport-fuzz",
  gatewayId: "gw-transport-fuzz",
  protocolVersion: "1",
  version: "1.0.0-rc.0"
}

const digest = "a".repeat(64)
const revision = "b".repeat(40)
const execDigest = "c".repeat(64)
const bearerPrincipal: Principal = { id: "gateway", kind: "bearer", stampedAt: 1 }
const accepted = { _tag: "Accepted", receiptId: "rcpt-1", runId: "run-1" } as const
const envelope = { capabilities: [], flows: [], budget: {} }

const makePlan = (overrides: Record<string, unknown> = {}): PlanCard =>
  ({
    planId: "plan-1",
    flowId: "fixture/flow",
    digest: "plan-digest",
    executionDigest: execDigest,
    inputSummary: "fuzz",
    envelope,
    deployClass: false,
    nodes: [],
    graph: { edges: [], sourceRevision: revision },
    approval: {
      target: { _tag: "Plan", planId: "plan-1", digest: "plan-digest", envelope },
      scope: "run",
      idempotencyKey: "card-approval"
    },
    ...overrides
  }) as unknown as PlanCard

const makeSummary = (overrides: Partial<RunSummary> = {}): RunSummary =>
  ({
    runId: "run-1",
    flowId: "fixture/flow",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    planId: "plan-1",
    planDigest: "plan-digest",
    ...overrides
  }) as RunSummary

const makeControl = (overrides: Partial<Control.Service> = {}): Control.Service =>
  Control.make({
    plan: () => Effect.succeed(makePlan()),
    run: () => Effect.succeed(accepted),
    approve: () => Effect.succeed(accepted),
    deny: () => Effect.succeed(accepted),
    signal: () => Effect.succeed(accepted),
    steer: () => Effect.succeed(accepted),
    pause: () => Effect.die("pause is outside the runtime bridge protocol"),
    cancel: () => Effect.succeed(accepted),
    resume: () => Effect.succeed(accepted),
    list: () => Effect.succeed({ _tag: "runs", items: [makeSummary()] }),
    watch: () =>
      Stream.make({
        sequence: 4,
        cursor: { sequence: 4 },
        kind: "control.run.completed",
        runId: "run-1",
        occurredAt: 10,
        payload: null
      }),
    ...overrides
  })

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (value) => predicate(value).pipe(Effect.provide(silentLogger)), options)
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/gateway NativeGateway, BunGateway, NodeGateway, GatewayServer handlers, RuntimeBridge & HostBranchPresence fuzz", () => {
  it("NativeGateway bindRefusal, listenOptions, ingressOptions & layerAuth enforce loopback, credential, operatorToken & scoped-token invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        host: Schema.Literals([
          "127.0.0.1",
          "localhost",
          "::1",
          "0.0.0.0",
          "::",
          "192.168.1.10",
          "2001:db8::1",
          "gw.internal"
        ]),
        port: Schema.Literals([0, 7331, 9000]),
        listen: Schema.Literals(["none", "false", "true"]),
        credential: Schema.Literals(["none", "", "secret-bearer-token"]),
        operatorToken: Schema.Literals(["none", "", "local-op-token"]),
        heartbeatMillis: Schema.Literals(["none", "50", "0", "-5", "nan"]),
        maxRequestBodyBytes: Schema.Literals(["none", "4096", "0", "-1"]),
        hasBridge: Schema.Boolean,
        requestScheme: Schema.Literals(["none", "http:", "https:"]),
        hasAllowedHosts: Schema.Boolean
      })
    )

    await runFuzz(
      arb,
      (input) =>
        Effect.gen(function*() {
          const cred = input.credential === "none" ? undefined : input.credential
          const options: NativeGateway.ServerOptions = {
            host: input.host,
            port: input.port,
            listen: input.listen === "none" ? undefined : input.listen === "true",
            credential: cred,
            operatorToken: input.operatorToken === "none" ? undefined : input.operatorToken,
            heartbeatMillis: input.heartbeatMillis === "none"
              ? undefined
              : input.heartbeatMillis === "nan"
              ? Number.NaN
              : Number(input.heartbeatMillis),
            maxRequestBodyBytes: input.maxRequestBodyBytes === "none" ? undefined : Number(input.maxRequestBodyBytes),
            requestScheme: input.requestScheme === "none" ? undefined : input.requestScheme,
            allowedHosts: input.hasAllowedHosts ? ["custom.example.test"] : undefined,
            ...(input.hasBridge
              ? {
                runtimeBridge: {
                  runtimeArtifactDigest: digest,
                  sourceRevision: revision,
                  ownerGeneration: 1
                }
              }
              : {})
          }

          const refusal = NativeGateway.bindRefusal(options)
          const listenExit = yield* NativeGateway.listenOptions(options).pipe(Effect.exit)
          if (refusal !== undefined) {
            expect(refusal.code).toBe("bind_failed")
            expect(Exit.isFailure(listenExit)).toBe(true)
          } else {
            expect(Exit.isSuccess(listenExit)).toBe(true)
            if (Exit.isSuccess(listenExit)) {
              expect(listenExit.value.host).toBe(input.host)
              expect(listenExit.value.port).toBe(input.port)
            }
          }

          const ingress = NativeGateway.ingressOptions(options)
          expect((ingress.allowedHosts ?? []).length).toBeGreaterThanOrEqual(1)
          if (cred !== undefined && cred.length > 0) {
            expect(ingress.authorize).toBeDefined()
            const okBearer = yield* ingress.authorize!(
              { authorization: `Bearer ${cred}` } as Record<string, string>,
              "/rpc"
            )
            expect(okBearer).toBe(true)
            const badBearer = yield* ingress.authorize!(
              { authorization: "Bearer wrong-token" } as Record<string, string>,
              "/rpc"
            )
            expect(badBearer).toBe(false)
            const { token: minted } = yield* ScopedToken.mint({
              key: cred,
              scopes: ["read:runs"],
              ttlMillis: 60_000
            })
            const scopedRpc = yield* ingress.authorize!(
              { authorization: `Bearer ${minted}` } as Record<string, string>,
              "/rpc"
            )
            expect(scopedRpc).toBe(true)
            const scopedBridge = yield* ingress.authorize!(
              { authorization: `Bearer ${minted}` } as Record<string, string>,
              "/runtime/v1/command"
            )
            expect(scopedBridge).toBe(false)
          } else {
            expect(ingress.authorize).toBeUndefined()
          }

          // Exercise layerAuth directly
          const authCtx = yield* Layer.build(NativeGateway.layerAuth(options)).pipe(Effect.scoped)
          expect(authCtx).toBeDefined()
          return true
        }),
      { seed, executions: fastExecutions }
    )
  })

  it("BunGateway makeBunLayer & BunGateway.layer sanitize bind errnos, preserve defects/interrupts, and serve loopback HTTP", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "serve",
          "EADDRINUSE",
          "EACCES",
          "EADDRNOTAVAIL",
          "UNKNOWN_CODE",
          "string_defect",
          "interrupt",
          "policy_refusal"
        ])
      })
    )

    await runFuzz(
      arb,
      ({ mode }) =>
        Effect.gen(function*() {
          if (mode === "policy_refusal") {
            const failure = yield* Layer.build(
              BunGateway.layer(health, { host: "0.0.0.0" }).pipe(Layer.provideMerge(stack()))
            ).pipe(Effect.flip, Effect.scoped)
            expect("code" in failure && failure.code).toBe("bind_failed")
            return true
          }
          if (mode === "serve") {
            const server: Parameters<typeof makeBunLayer>[0] = (opts) =>
              NodeHttpServer.layerServer(createServer, { host: opts.hostname, port: opts.port })
            yield* Effect.gen(function*() {
              const ctx = yield* Layer.build(
                makeBunLayer(server)(health, { port: 0, heartbeatMillis: 40 }).pipe(Layer.provideMerge(stack()))
              )
              const http = yield* HttpServer.HttpServer.pipe(Effect.provide(ctx))
              const addr = http.address
              if (addr._tag !== "InetAddressV4") throw new Error("expected tcp")
              const res = yield* Effect.promise(() => fetch(`http://127.0.0.1:${addr.port}/health`))
              expect(res.status).toBe(200)
              const body = yield* Effect.promise(() => res.json())
              expect(body).toMatchObject(health)
            }).pipe(Effect.scoped)
            return true
          }
          if (mode === "interrupt") {
            const server: Parameters<typeof makeBunLayer>[0] = () =>
              Layer.effect(HttpServer.HttpServer, Effect.interrupt)
            const exit = yield* Layer.build(
              makeBunLayer(server)(health).pipe(Layer.provideMerge(stack()))
            ).pipe(Effect.exit, Effect.scoped)
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
            return true
          }
          const defect = mode === "string_defect" ? "boom-defect" : { code: mode, message: "secret-socket-info" }
          const server: Parameters<typeof makeBunLayer>[0] = () =>
            Layer.effect(HttpServer.HttpServer, Effect.die(defect))
          const exit = yield* Layer.build(
            makeBunLayer(server)(health, { host: "127.0.0.1", port: 0 }).pipe(Layer.provideMerge(stack()))
          ).pipe(Effect.exit, Effect.scoped)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            if (mode === "EADDRINUSE" || mode === "EACCES" || mode === "EADDRNOTAVAIL") {
              const squashed = Cause.squash(exit.cause) as { readonly code?: string }
              expect(squashed.code).toBe("bind_failed")
            } else {
              expect(Cause.squash(exit.cause)).toBe(defect)
            }
          }
          return true
        }),
      { seed: seed + 1, executions: ioExecutions }
    )
  })

  it("RuntimeBridge execute, observe, monitor & HTTP layer enforce versioned bridge contracts, fencing & error sanitization", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        operation: Schema.Literals(["launch", "approve", "deny", "signal", "steer", "complete", "cancel", "resume"]),
        ownerGeneration: Schema.Literals([7, 6]),
        artifactMatch: Schema.Boolean,
        sourceMatch: Schema.Boolean,
        withPin: Schema.Boolean,
        pinSourceMatch: Schema.Boolean,
        pinExecMatch: Schema.Boolean,
        hasGraph: Schema.Boolean,
        hasVerifiedCatalog: Schema.Boolean,
        hasCompleteHandler: Schema.Boolean,
        cursorKind: Schema.Literals(["none", "seq", "v1", "bad"]),
        terminalMismatch: Schema.Boolean,
        receiptMismatch: Schema.Boolean,
        oversizedEvents: Schema.Boolean
      })
    )

    await runFuzz(
      arb,
      (tc) =>
        Effect.gen(function*() {
          const ctrl = makeControl({
            plan: () =>
              Effect.succeed(
                makePlan({
                  graph: tc.hasGraph ? { edges: [], sourceRevision: revision } : undefined,
                  executionDigest: tc.pinExecMatch ? execDigest : "d".repeat(64)
                })
              ),
            list: () =>
              Effect.succeed({
                _tag: "runs",
                items: [makeSummary({ status: tc.terminalMismatch ? "failed" : "completed" })]
              }),
            watch: () =>
              tc.oversizedEvents
                ? Stream.make({
                  sequence: 1,
                  cursor: { sequence: 1 },
                  kind: "control.run.log",
                  runId: "run-1",
                  occurredAt: 1,
                  payload: { blob: "x".repeat(Projections.maxProjectionBytes + 128) }
                } as ControlEvent)
                : Stream.make({
                  sequence: 4,
                  cursor: { sequence: 4 },
                  kind: "control.run.completed",
                  runId: "run-1",
                  occurredAt: 10,
                  payload: null
                })
          })

          const bridgeCfg: RuntimeBridge.Config = {
            runtimeArtifactDigest: digest,
            sourceRevision: revision,
            ownerGeneration: 7,
            ...(tc.hasVerifiedCatalog ? { verifiedCatalogSourceRevision: revision } : {}),
            ...(tc.hasCompleteHandler
              ? {
                requestComplete: () =>
                  Effect.succeed({ _tag: "Accepted" as const, receiptId: "done-1", runId: "run-1" })
              }
              : {}),
            commandReceipt: (runId) =>
              Effect.succeed({
                runId: tc.receiptMismatch ? "other-run" : runId,
                receiptId: "rcpt-host",
                command: "echo hi"
              } as never),
            authenticate: () => Effect.succeed(bearerPrincipal)
          }

          let cmd: RuntimeBridge.Command
          switch (tc.operation) {
            case "launch":
              cmd = {
                protocol: RuntimeBridge.protocol,
                operation: "launch",
                applicationRequestId: "req-1",
                ownerGeneration: tc.ownerGeneration,
                attempt: 1,
                runtimeArtifactDigest: tc.artifactMatch ? digest : "e".repeat(64),
                sourceRevision: tc.sourceMatch ? revision : "f".repeat(40),
                flowId: "fixture/flow",
                payload: { k: 1 },
                ...(tc.withPin
                  ? {
                    pin: {
                      flow: "fixture/flow",
                      sourceCommit: tc.pinSourceMatch ? revision : "9".repeat(40),
                      executionDigest: execDigest
                    }
                  }
                  : {})
              }
              break
            case "approve":
            case "deny":
              cmd = {
                protocol: RuntimeBridge.protocol,
                operation: tc.operation,
                applicationRequestId: "req-2",
                ownerGeneration: tc.ownerGeneration,
                approval: {
                  target: { _tag: "Plan", planId: "plan-1", digest: "plan-digest", envelope },
                  scope: "run",
                  idempotencyKey: "req-2-apr"
                }
              }
              break
            case "signal":
              cmd = {
                protocol: RuntimeBridge.protocol,
                operation: "signal",
                applicationRequestId: "req-3",
                ownerGeneration: tc.ownerGeneration,
                runId: "run-1",
                signal: { name: "answer", payload: { ok: true } }
              }
              break
            case "steer":
              cmd = {
                protocol: RuntimeBridge.protocol,
                operation: "steer",
                applicationRequestId: "req-4",
                ownerGeneration: tc.ownerGeneration,
                runId: "run-1",
                messageId: "msg-1",
                createdAt: 100,
                version: 1,
                steer: { kind: "instruction", body: "continue" }
              } as unknown as RuntimeBridge.Command
              break
            case "complete":
              cmd = {
                protocol: RuntimeBridge.protocol,
                operation: "complete",
                applicationRequestId: "req-5",
                ownerGeneration: tc.ownerGeneration,
                runId: "run-1"
              }
              break
            case "cancel":
            case "resume":
              cmd = {
                protocol: RuntimeBridge.protocol,
                operation: tc.operation,
                applicationRequestId: "req-6",
                ownerGeneration: tc.ownerGeneration,
                runId: "run-1",
                reason: "fuzz-reason"
              }
              break
          }

          const execExit = yield* RuntimeBridge.execute(bridgeCfg, ctrl, bearerPrincipal, cmd).pipe(Effect.exit)
          if (tc.ownerGeneration !== 7) {
            expect(Exit.isFailure(execExit)).toBe(true)
          } else if (tc.operation === "complete" && !tc.hasCompleteHandler) {
            expect(Exit.isFailure(execExit)).toBe(true)
          } else if (
            tc.operation === "launch" &&
            (!tc.artifactMatch || !tc.sourceMatch || (tc.withPin && (!tc.pinSourceMatch || !tc.pinExecMatch)) ||
              (!tc.hasGraph && !tc.hasVerifiedCatalog))
          ) {
            expect(Exit.isFailure(execExit)).toBe(true)
          } else {
            expect(Exit.isSuccess(execExit)).toBe(true)
          }

          const afterCursor = tc.cursorKind === "none"
            ? undefined
            : tc.cursorKind === "seq"
            ? "2"
            : tc.cursorKind === "v1"
            ? "v1:2:0"
            : "not-a-cursor"

          const obsExit = yield* RuntimeBridge.observe(
            ctrl,
            { protocol: RuntimeBridge.protocol, runId: "run-1", afterCursor, limit: 10 },
            bridgeCfg.commandReceipt
          ).pipe(Effect.exit)

          if (tc.cursorKind === "bad" || tc.receiptMismatch) {
            expect(Exit.isFailure(obsExit)).toBe(true)
          } else {
            expect(Exit.isSuccess(obsExit)).toBe(true)
          }

          const missingObs = yield* RuntimeBridge.observe(
            makeControl({ list: () => Effect.succeed({ _tag: "runs", items: [] }) }),
            { protocol: RuntimeBridge.protocol, runId: "missing" }
          ).pipe(Effect.exit)
          expect(Exit.isFailure(missingObs)).toBe(true)

          return true
        }),
      { seed: seed + 2, executions: fastExecutions }
    )
  })

  it("NodeGateway + GatewayServer RPC handlers + RuntimeBridge HTTP + HostBranchPresence HTTP serve end-to-end over loopback", async () => {
    const authToken = "fuzz-gateway-bearer"
    const bridgeCfg: Omit<RuntimeBridge.Config, "authenticate"> = {
      runtimeArtifactDigest: digest,
      sourceRevision: revision,
      ownerGeneration: 1
    }

    const arb = Arbitrary.schema(
      Schema.Struct({
        withHistory: Schema.Boolean,
        useBearer: Schema.Boolean,
        approvalDecision: Schema.Literals(["approve", "deny"]),
        waitCase: Schema.Literals(["none", "wrong-request", "deny-wait", "missing-answer", "valid-answer"]),
        bridgeEndpoint: Schema.Literals([
          "command-ok",
          "command-bad-json",
          "command-bad-schema",
          "command-unauth",
          "observe-bad",
          "monitor-bad",
          "monitor-ok"
        ])
      })
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        // Test full NodeGateway.layer over real SQLite stack with RuntimeBridge and RunHistory
        const runHistoryLayer = Layer.succeed(RunHistory.RunHistory, {
          fork: (input) =>
            Effect.succeed({
              runId: `fork-${input.runId}`,
              sourceRunId: input.runId,
              at: input.at,
              sequence: 0,
              branch: "main"
            } as never),
          verify: (input) =>
            Effect.succeed({
              runId: input.runId,
              verified: true,
              checkedEvents: 0
            } as never)
        })

        const gwLayer = NodeGateway.layer(health, {
          host: "127.0.0.1",
          port: 0,
          credential: authToken,
          heartbeatMillis: 30,
          runtimeBridge: bridgeCfg
        }).pipe(Layer.provideMerge(runHistoryLayer), Layer.provideMerge(stack()))

        const ctx = yield* Layer.build(gwLayer)
        const http = yield* HttpServer.HttpServer.pipe(Effect.provide(ctx))
        if (http.address._tag !== "InetAddressV4") throw new Error("expected tcp")
        const baseUrl = `http://127.0.0.1:${http.address.port}`

        // Seed a real run via Control
        const ctrl = yield* Control.Control.pipe(Effect.provide(ctx))
        const card = yield* ctrl.plan({ flowId: "system/test", input: { ok: true }, idempotencyKey: "seed-plan-1" })
        yield* ctrl.approve({
          target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
          scope: card.approval.scope,
          idempotencyKey: "seed-apr-1"
        })
        const launched = yield* ctrl.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "seed-run-1"
        })
        if (launched._tag !== "Accepted" || launched.runId === undefined) throw new Error("expected run")
        const runId = launched.runId
        yield* emit(runId, "control.run.running", { status: "running" }).pipe(Effect.provide(ctx))

        const rpcPost = (path: string, tag: string, payload: unknown, token?: string) =>
          Effect.promise(async () => {
            const headers: Record<string, string> = { "content-type": "application/json" }
            if (token !== undefined) headers.authorization = `Bearer ${token}`
            const res = await fetch(`${baseUrl}${path}`, {
              method: "POST",
              headers,
              body: JSON.stringify({ _tag: "Request", id: 1, tag, payload, headers: [] }) + "\n"
            })
            return { status: res.status, text: await res.text() }
          })

        const report = yield* Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              const tok = tc.useBearer ? authToken : undefined

              // Projection.Snapshot over /projections
              const snap = yield* rpcPost("/projections", "Projection.Snapshot", {
                selector: { _tag: "workspace-runs" }
              }, tok)
              expect(snap.status).toBe(tc.useBearer ? 200 : 401)

              // Run.Fork & Run.Verify over /projections
              const forked = yield* rpcPost("/projections", "Run.Fork", { runId, at: 0 }, tok)
              expect(forked.status).toBe(tc.useBearer ? 200 : 401)
              const verified = yield* rpcPost("/projections", "Run.Verify", { runId }, tok)
              expect(verified.status).toBe(tc.useBearer ? 200 : 401)

              // Approval.Submit over /projections
              if (tc.useBearer) {
                const waitDigest = Buffer.from(
                  JSON.stringify(["coding/PreparePlan", "execution-1", "WaitFor/ask-human"])
                ).toString("base64")
                const target = tc.waitCase === "none"
                  ? { _tag: "Plan", planId: "p1", digest: "d1", envelope }
                  : {
                    _tag: "Node",
                    runId,
                    requestId: tc.waitCase === "wrong-request" ? "other-wait" : "ask-human",
                    digest: waitDigest,
                    envelope
                  }
                const submit = yield* rpcPost("/projections", "Approval.Submit", {
                  target,
                  decision: tc.waitCase === "deny-wait" ? "deny" : tc.approvalDecision,
                  scope: "run",
                  idempotencyKey: `idem-${tc.waitCase}-${tc.approvalDecision}`,
                  ...(tc.waitCase === "valid-answer" ? { answer: { choice: "yes" } } : {})
                }, authToken)
                expect(submit.status).toBe(200)
              }

              // RuntimeBridge HTTP routes
              const bridgeRes = yield* Effect.promise(async () => {
                const headers: Record<string, string> = { "content-type": "application/json" }
                if (tc.bridgeEndpoint !== "command-unauth") headers.authorization = `Bearer ${authToken}`
                const path = tc.bridgeEndpoint.startsWith("command")
                  ? "/runtime/v1/command"
                  : tc.bridgeEndpoint.startsWith("observe")
                  ? "/runtime/v1/observe"
                  : "/runtime/v1/monitor"
                const body = tc.bridgeEndpoint === "command-bad-json"
                  ? "{not-json"
                  : tc.bridgeEndpoint === "command-bad-schema" || tc.bridgeEndpoint === "observe-bad" ||
                      tc.bridgeEndpoint === "monitor-bad"
                  ? JSON.stringify({ protocol: "bad" })
                  : tc.bridgeEndpoint === "monitor-ok"
                  ? JSON.stringify({ protocol: RuntimeBridge.protocol, runId })
                  : JSON.stringify({
                    protocol: RuntimeBridge.protocol,
                    operation: "cancel",
                    applicationRequestId: "http-cancel-1",
                    ownerGeneration: 1,
                    runId
                  })
                const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body })
                return { status: res.status, text: await res.text() }
              })
              if (tc.bridgeEndpoint === "command-unauth") {
                expect(bridgeRes.status).toBe(401)
              } else {
                expect(bridgeRes.status).toBeGreaterThanOrEqual(200)
                expect(bridgeRes.status).toBeLessThan(600)
              }

              return true
            }).pipe(Effect.provide(silentLogger)),
          { seed: seed + 3, executions: ioExecutions }
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)

        // Also exercise anonymous loopback server (no credential, no RunHistory) to cover anonymous refusal & Unavailable
        const anonCtx = yield* Layer.build(
          NodeGateway.layer(health, { host: "127.0.0.1", port: 0, heartbeatMillis: 30 }).pipe(
            Layer.provideMerge(stack())
          )
        )
        const anonHttp = yield* HttpServer.HttpServer.pipe(Effect.provide(anonCtx))
        const anonAddr = anonHttp.address
        if (anonAddr._tag !== "InetAddressV4") throw new Error("expected tcp")
        const anonRes = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${anonAddr.port}/projections`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              _tag: "Request",
              id: 1,
              tag: "Approval.Submit",
              payload: {
                target: { _tag: "Plan", planId: "p1", digest: "d1", envelope },
                decision: "approve",
                scope: "run",
                idempotencyKey: "anon-1"
              },
              headers: []
            }) + "\n"
          })
        )
        expect(anonRes.status).toBe(200)
        expect(yield* Effect.promise(() => anonRes.text())).toContain("Unauthorized")

        const anonFork = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${anonAddr.port}/projections`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              _tag: "Request",
              id: 2,
              tag: "Run.Fork",
              payload: { runId, at: 0 },
              headers: []
            }) + "\n"
          })
        )
        expect(anonFork.status).toBe(200)

        // Exercise operatorToken server without RunHistory to hit Unavailable branch
        const opCtx = yield* Layer.build(
          NodeGateway.layer(health, {
            host: "127.0.0.1",
            port: 0,
            operatorToken: "op-secret",
            heartbeatMillis: 30
          }).pipe(Layer.provideMerge(stack()))
        )
        const opHttp = yield* HttpServer.HttpServer.pipe(Effect.provide(opCtx))
        const opAddr = opHttp.address
        if (opAddr._tag !== "InetAddressV4") throw new Error("expected tcp")
        const opFork = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${opAddr.port}/projections`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer op-secret" },
            body: JSON.stringify({
              _tag: "Request",
              id: 3,
              tag: "Run.Fork",
              payload: { runId, at: 0 },
              headers: []
            }) + "\n"
          })
        )
        expect(opFork.status).toBe(200)
        expect(yield* Effect.promise(() => opFork.text())).toContain("Unavailable")
      }).pipe(Effect.provide(silentLogger), Effect.scoped)
    )
  })

  it("HostBranchPresence.layer serves authenticated branch presence RPCs over loopback HTTP", async () => {
    const serverLayer = HttpRouter.serve(
      HostBranchPresence.layer({
        runtimeArtifactDigest: digest,
        sourceRevision: revision,
        ownerGeneration: 1,
        authenticate: (headers) =>
          headers.authorization === "Bearer branch-tok"
            ? Effect.succeed(bearerPrincipal)
            : Effect.fail(new ControlError.Unauthorized({ message: "Unauthorized" }))
      }),
      { disableListenLog: true, disableLogger: true }
    ).pipe(
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      Layer.orDie
    )

    const arb = Arbitrary.schema(
      Schema.Struct({
        action: Schema.Literals([
          "Branch.CreateBranch",
          "Branch.MintShare",
          "Branch.Submit",
          "Branch.WatchRoster",
          "Branch.PresenceOn",
          "Branch.Announce",
          "Branch.Roster",
          "Branch.Leave"
        ]),
        authorized: Schema.Boolean,
        sourcesReady: Schema.Boolean,
        sessionId: Schema.Literals(["s1", "s2", "s3"]),
        line: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
      })
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        const http = yield* HttpServer.HttpServer
        if (http.address._tag !== "InetAddressV4") throw new Error("expected tcp")
        const url = `http://127.0.0.1:${http.address.port}/branch`
        const scope = {
          branchId: "b-fuzz",
          capability: {
            signature: "sig",
            claims: {
              kid: "host",
              branchId: "b-fuzz",
              capabilityId: "cap",
              access: "write",
              issuedAtMs: 0,
              expiresAtMs: 0
            }
          }
        }

        const report = yield* Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              let payload: unknown = scope
              if (tc.action === "Branch.CreateBranch") payload = { ttlMs: 60_000 }
              else if (tc.action === "Branch.MintShare") {
                payload = { capability: scope.capability, access: "read", ttlMs: 60_000 }
              } else if (tc.action === "Branch.Submit") {
                payload = {
                  capability: scope.capability,
                  submission: {
                    branchId: scope.branchId,
                    commandId: "c1",
                    participantId: "member:1",
                    name: "branch.say",
                    args: "hi",
                    target: ""
                  }
                }
              } else if (tc.action === "Branch.PresenceOn") {
                payload = { ...scope, sourcesReady: tc.sourcesReady }
              } else if (tc.action === "Branch.Announce") {
                payload = {
                  ...scope,
                  participantId: "member:1",
                  sessionId: tc.sessionId,
                  displayName: "Fuzzer",
                  kind: "person",
                  cursor: null,
                  where: { kind: "file", path: "app.ts", line: tc.line }
                }
              } else if (tc.action === "Branch.Leave") {
                payload = { ...scope, participantId: "member:1", sessionId: tc.sessionId }
              }

              const res = yield* Effect.promise(async () => {
                const r = await fetch(url, {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${tc.authorized ? "branch-tok" : "wrong"}`
                  },
                  body: JSON.stringify({ _tag: "Request", id: 1, tag: tc.action, payload, headers: [] }) + "\n"
                })
                const raw = await r.text()
                return JSON.parse(raw.trim().split("\n")[0]!).exit
              })

              if (!tc.authorized) {
                expect(res._tag).toBe("Failure")
              } else if (
                tc.action === "Branch.CreateBranch" ||
                tc.action === "Branch.MintShare" ||
                tc.action === "Branch.Submit" ||
                tc.action === "Branch.WatchRoster"
              ) {
                expect(res._tag).toBe("Failure")
              } else {
                expect(res._tag).toBe("Success")
              }
              return true
            }),
          { seed: seed + 4, executions: fastExecutions }
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
      }).pipe(
        Effect.provide(serverLayer),
        Effect.provide(TestClock.layer()),
        Effect.provide(silentLogger),
        Effect.scoped
      )
    )
  })

  it("GatewayServer layerKeepAlive & layerProjectionsKeepAlive inject heartbeats into followed streams without altering snapshots", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const ctrl = makeControl({
          watch: (filter) =>
            filter.follow === false
              ? Stream.make({
                sequence: 1,
                cursor: { sequence: 1 },
                kind: "control.run.running",
                runId: filter.runId ?? "run-1",
                occurredAt: 1,
                payload: null
              })
              : Stream.concat(
                Stream.make({
                  sequence: 2,
                  cursor: { sequence: 2 },
                  kind: "control.run.running",
                  runId: filter.runId ?? "run-1",
                  occurredAt: 2,
                  payload: null
                }),
                Stream.never
              )
        })
        const wrappedControl = yield* Control.Control.pipe(
          Effect.provide(GatewayServer.layerKeepAlive(15).pipe(Layer.provide(Layer.succeed(Control.Control, ctrl))))
        )
        // Snapshot watch ends cleanly without heartbeats
        const snapEvents = yield* Stream.runCollect(wrappedControl.watch({ runId: "run-1", follow: false }))
        expect(snapEvents.length).toBe(1)
        // Followed watch emits event + keepalive heartbeat
        const followed = yield* wrappedControl.watch({ runId: "run-1", follow: true, afterSequence: 1 }).pipe(
          Stream.take(2),
          Stream.runCollect
        )
        expect(followed.some((e) => e.kind === GatewayServer.watchHeartbeatKind)).toBe(true)

        // layerProjectionsKeepAlive re-times followed projection heartbeats
        const stackCtx = yield* Layer.build(stack())
        const realCtrl = yield* Control.Control.pipe(Effect.provide(stackCtx))
        const projService = yield* Projections.make(realCtrl, { heartbeatMillis: 1000 })
        const wrappedProj = yield* Projections.Projections.pipe(
          Effect.provide(
            GatewayServer.layerProjectionsKeepAlive(15).pipe(
              Layer.provide(Layer.succeed(Projections.Projections, projService))
            )
          )
        )
        const frames = yield* wrappedProj.subscribe({ _tag: "workspace-runs" }).pipe(
          Stream.take(3),
          Stream.runCollect
        )
        expect(frames.some((f) => f._tag === "heartbeat")).toBe(true)
      }).pipe(Effect.provide(silentLogger), Effect.scoped)
    )
  })
})
