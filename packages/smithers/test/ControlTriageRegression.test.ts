import { NodeCrypto } from "@effect/platform-node"
import { ApprovalAuthority, ControlRuntime } from "@smthrs/control"
import { PersistenceError, Unauthorized } from "@smthrs/control/ControlError"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Bridge from "../src/cli/ControlBridge.ts"
import { createRunsCli } from "../src/cli/ControlCommands.ts"
import { targetsInstall } from "../src/internal/backend/Destination.ts"
import * as NodeControl from "../src/NodeControl.ts"

const home = mkdtempSync(join(tmpdir(), "smithers-control-triage-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const environment = { HOME: home, XDG_CONFIG_HOME: home }

describe("#4309 credential-only destination routing", () => {
  it.each([
    { SMITHERS_TOKEN_FILE: join(home, "absent-token") },
    { SMITHERS_TOKEN: "routing-test-token" },
    { SMITHERS_TOKEN_FILE: join(home, "absent-token"), SMITHERS_TOKEN: "routing-test-token" }
  ])("keeps local list and run inspection local with %j", (credential) => {
    const runtime = { environment: { ...environment, ...credential } }
    expect(targetsInstall({ args: {}, options: {} }, runtime)).toBe(false)
    expect(targetsInstall({ args: { run: "run-1" }, options: {} }, runtime)).toBe(false)
  })

  it("uses a configured origin and preserves explicit routing precedence", () => {
    const runtime = { environment: { ...environment, SMITHERS_URL: "https://smithers.example" } }
    expect(targetsInstall({ args: {}, options: {} }, runtime)).toBe(true)
    expect(targetsInstall({ args: { run: "run-1" }, options: {} }, runtime)).toBe(false)
    expect(targetsInstall({ args: {}, options: { root: home, cloud: true } }, runtime)).toBe(false)
    expect(targetsInstall({ args: {}, options: { repo: "owner/repo" } }, { environment })).toBe(true)
    expect(targetsInstall({ args: {}, options: { cloud: true } }, { environment })).toBe(true)
  })

  it("routes a saved install without requiring credentials", () => {
    const saved = join(home, "saved")
    mkdirSync(join(saved, "smithers"), { recursive: true })
    writeFileSync(join(saved, "smithers", "config.toon"), "api_origin: https://smithers.example\n")
    expect(targetsInstall({ args: {}, options: {} }, {
      environment: { ...environment, XDG_CONFIG_HOME: saved }
    })).toBe(true)
  })
})

const operator = { id: "local", kind: "operator", stampedAt: 1 }
const envelope = { capabilities: [], flows: [], budget: {} }

describe("#4242 scoped human-wait authority", () => {
  it.each(["memory", "sqlite"] as const)("checks the recorded flow and exact wait in %s", async (adapter) => {
    const policy = await Effect.runPromise(ApprovalAuthority.make([
      { principal: { id: operator.id, kind: operator.kind }, scopes: ["once"], targets: ["Plan"] },
      {
        principal: { id: operator.id, kind: operator.kind },
        scopes: ["once"],
        targets: ["Node"],
        flowId: "system/test",
        waitName: "question/1"
      }
    ]))
    const layer = adapter === "memory"
      ? ControlRuntime.layerMemory({ approvalAuthority: policy })
      : NodeControl.engineDurable(join(home, "scoped-authority"), undefined, { approvalAuthority: policy }).runtime
    const program = Effect.gen(function*() {
      const runtime = yield* ControlRuntime.ControlRuntime
      const launch = (flowId: string) =>
        Effect.gen(function*() {
          const { card } = yield* runtime.plan({ flowId, input: {} })
          const token = yield* runtime.lookupApproval(card.approval.target)
          yield* runtime.resolveApproval(token, "approved", operator, "once")
          const result = yield* runtime.launch(card.planId, card.digest, card.envelope)
          if (result._tag !== "Started") throw new Error("expected launch")
          return result.run.runId
        })
      const allowed = yield* launch("system/test")
      const other = yield* launch("system/target")
      for (
        const [runId, waitName, scope, expected] of [
          [allowed, "question/1", "once", "Success"],
          [allowed, "question/2", "once", "Failure"],
          [other, "question/1", "once", "Failure"],
          [allowed, "question/1", "remembered", "Failure"]
        ] as const
      ) {
        const exit = yield* Effect.exit(runtime.authorizeApproval({
          principal: operator,
          target: { _tag: "Node", runId, requestId: waitName, digest: "wait-token", envelope },
          scope,
          decision: "approved"
        }))
        expect(exit._tag).toBe(expected)
      }
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.provide(NodeCrypto.layer), Effect.scoped))
  })
})

it("#4242 verifies named proof on every decision and fails closed on revoked or unavailable proof", async () => {
  const delegation = {
    principal: { id: operator.id, kind: operator.kind },
    scopes: ["once" as const],
    targets: ["Node" as const],
    waitName: "question/1",
    requiredProof: "person-passkey"
  }
  const request = {
    principal: operator,
    target: { _tag: "Node" as const, runId: "run-proof", requestId: "question/1", digest: "token-1", envelope },
    scope: "once" as const,
    decision: "approved" as const
  }
  const absent = await Effect.runPromise(ApprovalAuthority.make([delegation]))
  expect((await Effect.runPromise(Effect.flip(absent.authorize(request))))._tag).toBe("/control/Unauthorized")
  let outcome: "valid" | "revoked" | "unavailable" = "valid"
  const checks: string[] = []
  const policy = await Effect.runPromise(ApprovalAuthority.make([delegation], {
    verifyProof: (name, decision) =>
      Effect.suspend((): Effect.Effect<void, PersistenceError | Unauthorized> => {
        checks.push(name)
        expect(decision.target).toEqual(request.target)
        if (outcome === "unavailable") {
          return Effect.fail(new PersistenceError({ operation: "proof", message: "offline" }))
        }
        if (outcome === "revoked") return Effect.fail(new Unauthorized({ message: "revoked" }))
        return Effect.void
      })
  }))
  await Effect.runPromise(policy.authorize(request))
  outcome = "revoked"
  expect((await Effect.runPromise(Effect.flip(policy.authorize(request))))._tag).toBe("/control/Unauthorized")
  outcome = "unavailable"
  expect((await Effect.runPromise(Effect.flip(policy.authorize(request))))._tag).toBe("/control/PersistenceError")
  expect(
    (await Effect.runPromise(Effect.flip(policy.authorize({ ...request, principal: { ...operator, id: "agent" } }))))
      ._tag
  )
    .toBe("/control/Unauthorized")
  expect(checks).toEqual(["person-passkey", "person-passkey", "person-passkey"])
})

it("#4247 pages signal delivery receipts across restart without reading answer payloads", async () => {
  const root = join(home, "signal-receipts")
  const run = <A, E>(effect: Effect.Effect<A, E, ControlRuntime.ControlRuntime>) =>
    Effect.runPromise(effect.pipe(Effect.provide(NodeControl.engineDurable(root).runtime), Effect.scoped))
  const runId = await run(Effect.gen(function*() {
    const runtime = yield* ControlRuntime.ControlRuntime
    const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
    yield* runtime.resolveApproval(yield* runtime.lookupApproval(card.approval.target), "approved", operator, "once")
    const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
    if (launched._tag !== "Started") throw new Error("expected launch")
    const id = launched.run.runId
    yield* runtime.admitSignal("first", id, { name: "question/1", payload: "x".repeat(17 * 1024 * 1024) }, operator)
    yield* runtime.admitSignal("second", id, { name: "question/2", payload: {} }, operator)
    yield* runtime.admitSignal("third", id, { name: "question/3", payload: {} }, operator)
    return id
  }))
  const first = await run(
    Effect.flatMap(ControlRuntime.ControlRuntime, (runtime) => runtime.querySignals({ runId, limit: 1 }))
  )
  expect(first.items).toMatchObject([{ commandId: "first", name: "question/1", state: "pending" }])
  expect(JSON.stringify(first).length).toBeLessThan(1000)
  await run(Effect.gen(function*() {
    const runtime = yield* ControlRuntime.ControlRuntime
    yield* runtime.bindSignal("first", "private-wait-token")
    yield* runtime.settleSignal("first", "delivered")
    yield* runtime.settleSignal("second", "rejected", "unauthorized")
    yield* runtime.settleSignal("third", "terminal")
    yield* runtime.settleSignal("first", "rejected")
  }))
  const settled = await run(
    Effect.flatMap(ControlRuntime.ControlRuntime, (runtime) => runtime.querySignals({ runId, limit: 3 }))
  )
  expect(settled.items.map((item) => item.state)).toEqual(["delivered", "rejected", "terminal"])
  expect(settled.items[1]).toMatchObject({ rejection: "unauthorized" })
  expect(JSON.stringify(settled)).not.toContain("private-wait-token")
  const next = await run(
    Effect.flatMap(
      ControlRuntime.ControlRuntime,
      (runtime) => runtime.querySignals({ runId, after: first.next, limit: 1 })
    )
  )
  expect(next.items).toMatchObject([{ commandId: "second", state: "rejected" }])
  let output = ""
  const codes: number[] = []
  await createRunsCli({ environment }).serve(["signals", runId, "--root", root, "--limit", "1", "--json"], {
    stdout: (text) => {
      output += text
    },
    exit: (code) => {
      codes.push(code)
    }
  })
  expect(codes.every((code) => code === 0), output).toBe(true)
  expect(JSON.parse(output)).toMatchObject({ items: [{ commandId: "first", state: "delivered" }], next: first.next })
  const commandId = ControlRuntime.signalCommandId("pending-receipt", operator)
  await run(
    Effect.flatMap(
      ControlRuntime.ControlRuntime,
      (runtime) => runtime.admitSignal(commandId, runId, { name: "pending", payload: {} }, operator)
    )
  )
  const pending = await Bridge.signalReceipts({ runId, limit: 1 }, { root, quiet: true }, { environment }, {
    receiptId: "pending-receipt",
    timeout: 0
  })
  expect(pending.items).toMatchObject([{ receiptId: "pending-receipt", state: "pending" }])
  await run(Effect.flatMap(ControlRuntime.ControlRuntime, (runtime) => runtime.settleSignal(commandId, "delivered")))
  const delivered = await Bridge.signalReceipts({ runId, limit: 1 }, { root, quiet: true }, { environment }, {
    receiptId: "pending-receipt",
    timeout: 0
  })
  expect(delivered.items).toMatchObject([{ receiptId: "pending-receipt", state: "delivered" }])

  expect(
    (await run(
      Effect.flatMap(
        ControlRuntime.ControlRuntime,
        (runtime) => Effect.flip(runtime.querySignals({ runId, limit: 501 }))
      )
    ))._tag
  )
    .toBe("/control/InvalidInput")
})
