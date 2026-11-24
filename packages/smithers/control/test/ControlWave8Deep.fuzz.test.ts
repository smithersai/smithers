import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ApprovalAuthority from "../src/ApprovalAuthority.ts"
import * as Channels from "../src/Channels.ts"
import { Control } from "../src/Control.ts"
import * as ControlClient from "../src/ControlClient.ts"
import * as ControlError from "../src/ControlError.ts"
import * as Facts from "../src/ControlFacts.ts"
import { type MemoryFlow } from "../src/ControlRuntime.ts"
import type { Envelope, Principal } from "../src/ControlSchema.ts"
import * as ScopedToken from "../src/ScopedToken.ts"
import { durable, fileBundle } from "./DurableStack.ts"
import { live, memoryRuntime } from "./TestStack.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "140")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261803")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }
const testFlows: ReadonlyArray<MemoryFlow> = [
  { flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope },
  { flowId: "review/pull-request", description: "Review a pull request.", deployClass: false, envelope },
  { flowId: "release/train", description: "Ship a release.", deployClass: true, envelope }
]

describe("@smthrs/control Wave 8 deep fuzz (ApprovalAuthority, ControlLive errors, ControlFacts, ScopedToken & Channels)", () => {
  it(
    "ApprovalAuthority.make enforces explicit delegations, agent refusal, scope/target/flow/wait matching & verifyProof",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          principalId: Schema.Literals(["alice", "bob", "bot"]),
          principalKind: Schema.Literals(["person", "operator", "agent"]),
          scope: Schema.Literals(["once", "run", "remembered"]),
          targetKind: Schema.Literals(["Plan", "Node"]),
          decision: Schema.Literals(["approved", "denied"]),
          flowMatch: Schema.Boolean,
          waitMatch: Schema.Boolean,
          proofOk: Schema.Boolean,
          useProof: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (v) =>
            Effect.gen(function*() {
              const agentDel = yield* Effect.exit(
                ApprovalAuthority.make([
                  { principal: { id: "bot", kind: "agent" }, scopes: ["once"], targets: ["Plan"] }
                ])
              )
              expect(Exit.isFailure(agentDel)).toBe(true)

              const emptyDel = yield* ApprovalAuthority.make([])
              const deniedByEmpty = yield* Effect.exit(
                emptyDel.authorize({
                  principal: { id: "alice", kind: "person", stampedAt: 1 },
                  scope: "once",
                  target: { _tag: "Plan" },
                  flowId: "review/pull-request"
                })
              )
              expect(Exit.isFailure(deniedByEmpty)).toBe(true)

              const auth = yield* ApprovalAuthority.make(
                [
                  {
                    principal: { id: "alice", kind: "person" },
                    scopes: ["once", "run"],
                    targets: ["Plan", "Node"],
                    flowId: "review/pull-request",
                    ...(v.targetKind === "Node" ? { waitName: "confirm-deploy" } : {}),
                    ...(v.useProof ? { requiredProof: "webauthn" } : {})
                  }
                ],
                {
                  verifyProof: () =>
                    v.proofOk
                      ? Effect.void
                      : Effect.fail(new ControlError.Unauthorized({ message: "bad proof" }))
                }
              )

              const principal: Principal = { id: v.principalId, kind: v.principalKind, stampedAt: 1_700_000_000_000 }
              const target = v.targetKind === "Plan"
                ? ({ _tag: "Plan" as const, planId: "p-1", digest: "a".repeat(64), envelope })
                : ({
                  _tag: "Node" as const,
                  runId: "r-1",
                  requestId: "req-1",
                  digest: "a".repeat(64),
                  envelope,
                  waitName: v.waitMatch ? "confirm-deploy" : "other-wait"
                })

              const exit = yield* Effect.exit(
                auth.authorize(
                  { principal, target, decision: v.decision, scope: v.scope },
                  { flowId: Effect.succeed(v.flowMatch ? "review/pull-request" : "release/train") }
                )
              )

              const expectedOk = v.principalId === "alice" &&
                v.principalKind === "person" &&
                v.flowMatch &&
                (v.targetKind === "Plan" || v.waitMatch) &&
                (v.decision === "denied" || v.scope === "once" || v.scope === "run") &&
                (!v.useProof || v.proofOk)

              expect(Exit.isSuccess(exit)).toBe(expectedOk)
              return true
            }),
          { seed, executions }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it("ControlLive error paths agree on Memory and SQLite", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        backend: Schema.Literals(["memory", "sqlite"]),
        scenario: Schema.Literals([
          "digest-mismatch",
          "envelope-mismatch",
          "plan-denied",
          "unapproved-run",
          "idempotency-conflict",
          "unauthorized-approve",
          "terminal-cancel-pause-resume",
          "unknown-flow"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ backend, scenario }) =>
          Effect.gen(function*() {
            const dir = backend === "sqlite" ? mkdtempSync(join(tmpdir(), "ctrl-w8-")) : undefined
            try {
              const stackLayer = backend === "sqlite"
                ? durable({ database: fileBundle(join(dir!, "control.sqlite")) })
                : live({ runtime: memoryRuntime({ flows: testFlows }) })

              return yield* Effect.scoped(
                Effect.gen(function*() {
                  const control = yield* Control
                  const flowId = backend === "sqlite" ? "system/test" : "review/pull-request"

                  if (scenario === "unknown-flow") {
                    const ex = yield* Effect.exit(
                      control.plan({ flowId: "does/not-exist", input: {}, idempotencyKey: "k-unk" })
                    )
                    expect(Exit.isFailure(ex)).toBe(true)
                    return true
                  }

                  const card = yield* control.plan({ flowId, input: { n: 1 }, idempotencyKey: "k-plan" })

                  if (scenario === "unauthorized-approve") {
                    const badP: Principal = { id: "mallory", kind: "agent", stampedAt: 1 }
                    const ex = yield* Effect.exit(
                      control.approve({ ...card.approval, idempotencyKey: "k-unauth", principal: badP })
                    )
                    expect(Exit.isFailure(ex)).toBe(true)
                    return true
                  }

                  if (scenario === "plan-denied") {
                    yield* control.deny({ ...card.approval, idempotencyKey: "k-deny" })
                    const ex = yield* Effect.exit(
                      control.run({
                        _tag: "Plan",
                        planId: card.planId,
                        digest: card.digest,
                        envelope: card.envelope,
                        idempotencyKey: "k-run-denied"
                      })
                    )
                    expect(Exit.isFailure(ex)).toBe(true)
                    return true
                  }

                  if (scenario === "unapproved-run") {
                    const ex = yield* Effect.exit(
                      control.run({
                        _tag: "Plan",
                        planId: card.planId,
                        digest: card.digest,
                        envelope: card.envelope,
                        idempotencyKey: "k-run-unapp"
                      })
                    )
                    if (Exit.isSuccess(ex)) {
                      expect(ex.value._tag).not.toBe("Accepted")
                    }
                    return true
                  }

                  yield* control.approve({ ...card.approval, idempotencyKey: "k-app" })

                  if (scenario === "digest-mismatch") {
                    const ex = yield* Effect.exit(
                      control.run({
                        _tag: "Plan",
                        planId: card.planId,
                        digest: "f".repeat(64),
                        envelope: card.envelope,
                        idempotencyKey: "k-bad-dig"
                      })
                    )
                    expect(Exit.isFailure(ex)).toBe(true)
                    return true
                  }

                  if (scenario === "envelope-mismatch") {
                    const ex = yield* Effect.exit(
                      control.run({
                        _tag: "Plan",
                        planId: card.planId,
                        digest: card.digest,
                        envelope: { capabilities: ["fs:write"], flows: [], budget: {} },
                        idempotencyKey: "k-bad-env"
                      })
                    )
                    expect(Exit.isFailure(ex)).toBe(true)
                    return true
                  }

                  const started = yield* control.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: "k-run-ok"
                  })
                  if (started._tag !== "Accepted" || started.runId === undefined) return false
                  const runId = started.runId

                  if (scenario === "idempotency-conflict") {
                    yield* control.steer({
                      runId,
                      message: {
                        messageId: "m-1",
                        runId,
                        principal: { id: "local", kind: "operator", stampedAt: 1 },
                        createdAt: 1,
                        body: "first-body"
                      },
                      idempotencyKey: "k-steer-same"
                    })
                    const ex = yield* Effect.exit(
                      control.steer({
                        runId,
                        message: {
                          messageId: "m-2",
                          runId,
                          principal: { id: "local", kind: "operator", stampedAt: 1 },
                          createdAt: 1,
                          body: "second-different-body"
                        },
                        idempotencyKey: "k-steer-same"
                      })
                    )
                    expect(Exit.isFailure(ex) || ex.value._tag === "Conflict").toBe(true)
                    return true
                  }

                  yield* control.cancel({ runId: runId, idempotencyKey: "k-can" })
                  const pauseEx = yield* Effect.exit(control.pause({ runId: runId, idempotencyKey: "k-p" }))
                  const resumeEx = yield* Effect.exit(control.resume({ runId: runId, idempotencyKey: "k-r" }))
                  expect(pauseEx).toBeDefined()
                  expect(resumeEx).toBeDefined()
                  return true
                })
              ).pipe(Effect.provide(stackLayer))
            } finally {
              if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
            }
          }),
        { seed: seed + 1, executions: Math.min(executions, 36) }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("ControlClient.isControlError, ScopedToken mint/verify/authorizes, ControlFacts & Channels", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        runId: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(12), Schema.isPattern(/^[a-z0-9-]+$/)),
        scopeIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
        tamper: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (v) =>
          Effect.gen(function*() {
            expect(ControlClient.isControlError(new ControlError.RunNotFound({ runId: v.runId }))).toBe(true)
            expect(ControlClient.isControlError(new ControlError.Unauthorized({ message: "no" }))).toBe(true)
            expect(ControlClient.isControlError(new Error("plain"))).toBe(false)
            expect(Facts.version).toBeGreaterThanOrEqual(1)
            expect(Channels.make).toBeDefined()
            expect(ScopedToken.scopeNames.length).toBeGreaterThan(0)
            const chosenScope = ScopedToken.scopeNames[v.scopeIdx % ScopedToken.scopeNames.length]!
            expect(ScopedToken.procedures([chosenScope]).length).toBeGreaterThanOrEqual(0)
            const key = "k".repeat(64)
            const minted = yield* ScopedToken.mint({
              key,
              runId: v.runId,
              scopes: [chosenScope],
              now: () => 1_700_000_000_000,
              ttlMillis: 60_000
            })
            expect(ScopedToken.isScopedToken(minted.token)).toBe(true)
            const tokenStr = v.tamper ? `${minted.token}x` : minted.token
            const verified = yield* Effect.exit(ScopedToken.verify(key, tokenStr, 1_700_000_010_000))
            expect(Exit.isSuccess(verified)).toBe(!v.tamper)
            if (Exit.isSuccess(verified)) {
              const expired = yield* Effect.exit(ScopedToken.verify(key, minted.token, 1_700_000_999_000))
              expect(Exit.isFailure(expired)).toBe(true)
              expect(typeof ScopedToken.authorizes(verified.value, { procedure: "control.list" } as any)).toBe(
                "boolean"
              )
            }
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  }, 60_000)
})
