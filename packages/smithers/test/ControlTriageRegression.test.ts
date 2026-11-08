import { NodeCrypto } from "@effect/platform-node"
import { NodeServices } from "@effect/platform-node"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { ApprovalAuthority, Control, ControlRuntime } from "@smthrs/control"
import { PersistenceError, Unauthorized } from "@smthrs/control/ControlError"
import * as ControlLive from "@smthrs/control/ControlLive"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { NodeRuntime } from "@smthrs/platform-node"
import { Registry } from "@smthrs/registry"
import * as Executable from "@smthrs/registry/Executable"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Effect, Layer, Schema, Stream } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, describe, expect, it } from "vitest"
import * as Application from "../src/Application.vibe"
import * as Bridge from "../src/cli/ControlBridge.ts"
import { createApprovalsCli, createRunsCli } from "../src/cli/ControlCommands.ts"
import { targetsInstall } from "../src/internal/backend/Destination.ts"
import * as NodeControl from "../src/NodeControl.ts"
import { databaseLayer } from "../src/operator/Store.vibe"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"

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

it("#4246 resolves a persisted child execution to the operator's control run", async () => {
  const root = join(home, "execution-correlation")
  const engine = NodeControl.engineDurable(root)
  const runId = await Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime.ControlRuntime
      const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
      yield* runtime.resolveApproval(yield* runtime.lookupApproval(card.approval.target), "approved", operator, "once")
      const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
      if (launched._tag !== "Started") throw new Error("expected launch")
      return launched.run.runId
    }).pipe(Effect.provide(engine.runtime), Effect.scoped)
  )
  await Effect.runPromise(Effect.void.pipe(
    Effect.provide(NodeRuntime.storage(join(root, ".flows", "engine.db"), root)),
    Effect.provide(NodeServices.layer),
    Effect.provide(NodeCrypto.layer)
  ))
  const db = new DatabaseSync(join(root, ".flows", "engine.db"))
  try {
    // Deliberately corrupt ancestry exercises refusal of historical damaged rows.
    db.exec("PRAGMA foreign_keys = OFF")
    const insert = db.prepare(
      "INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, parent_run_id, lineage_id, round_ordinal) VALUES (?, 'completed', 1, ?, ?, ?, ?)"
    )
    const state = JSON.stringify({ version: 1, flowName: "body", payload: {} })
    insert.run(runId, state, null, runId, 0)
    insert.run("body-execution", state, runId, "body-execution", 0)
    insert.run("nested-execution", state, "body-execution", "nested-execution", 0)
    insert.run("later-round", state, null, "nested-execution", 1)
    insert.run("unrelated", state, null, "unrelated", 0)
    insert.run("missing-parent", state, "missing", "missing-parent", 0)
    insert.run("cycle-a", state, "cycle-b", "cycle-a", 0)
    insert.run("cycle-b", state, "cycle-a", "cycle-b", 0)
    insert.run(
      "spawned",
      JSON.stringify({ version: 1, flowName: "body", payload: "x".repeat(17 * 1024 * 1024) }),
      null,
      "spawned",
      0
    )
    db.prepare("INSERT INTO flows_run_parents (child_id, parent_id, seq) VALUES (?, ?, ?)").run("spawned", runId, 1)
    for (let depth = 0; depth < 130; depth++) {
      insert.run(`deep-${depth}`, state, depth === 129 ? runId : `deep-${depth + 1}`, `deep-${depth}`, 0)
    }
  } finally {
    db.close()
  }
  for (const execution of [runId, "nested-execution", "later-round", "spawned"]) {
    let output = ""
    const codes: number[] = []
    await createRunsCli({ environment }).serve(["show", execution, "--root", root, "--json"], {
      stdout: (text) => {
        output += text
      },
      exit: (code) => {
        codes.push(code)
      }
    })
    expect(codes.every((code) => code === 0), output).toBe(true)
    expect(JSON.parse(output)).toMatchObject({ runId, flowId: "system/test" })
  }
  for (const execution of ["unrelated", "missing-parent", "cycle-a", "deep-0"]) {
    expect(
      await Bridge.read(Bridge.resolveRunId(execution, { root, quiet: true }, { environment }), { root, quiet: true }, {
        environment
      })
    ).toBe(execution)
  }
})

it("#4246 exposes the owning run inside a real module action", async () => {
  const root = join(home, "action-correlation")
  mkdirSync(join(root, ".smithers", "flows", "correlation"), { recursive: true })
  writeFileSync(
    join(root, ".smithers", "flows", "correlation", "flow.ts"),
    `import { Flow } from "@smthrs/flow"; import { Node } from "@smthrs/plan"; import { Schema } from "effect";
    export default Flow.make("correlation", { description: "Observe the owning run.", capabilities: [], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }, payload: {}, success: Schema.String, body: Node.capture({}, () => Node.succeed("identity")) });`
  )
  const Identity = Action.make("correlation/Identity", { payload: {}, success: Schema.String })
  const observed: Array<string | undefined> = []
  const Child = Flow.make("correlation/child", {
    payload: {},
    success: Schema.String,
    body: Node.capture({}, () => Identity.call({}))
  })
  const Main = Flow.make("correlation", {
    description: "Observe the owning run.",
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    payload: {},
    success: Schema.String,
    body: Node.capture({}, () => Child.to({}))
  })
  const modules = Executable.layer({
    delegates: [],
    load: () =>
      Effect.succeed({
        default: Main,
        layer: Layer.mergeAll(
          Interpreter.layer(Child),
          Identity.toLayer(() =>
            Effect.gen(function*() {
              const runId = yield* ControlRuntime.CurrentRunId
              observed.push(runId)
              return runId ?? "missing"
            })
          )
        )
      })
  }).pipe(Layer.orDie)
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const executor = NodeControl.layerExecutor(registry, engine, root, {
    evaluator: ScriptedJudge.layerAll,
    environment,
    modules
  })
  const receipt = await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const plan = yield* control.plan({ flowId: "correlation", input: {} })
      yield* control.approve(plan.approval)
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: plan.planId,
        digest: plan.digest,
        envelope: plan.envelope,
        idempotencyKey: "identity"
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) throw new Error("expected launch")
      const events = yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
        Stream.takeUntil((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
        Stream.runCollect
      )
      expect(events.at(-1)?.kind).toBe("control.run.completed")
      return receipt
    }).pipe(
      Effect.provide(Application.layer({ root }, registry, engine, executor) as Layer.Layer<Control.Control>),
      Effect.scoped
    )
  )
  expect(observed).toEqual([receipt.runId])
  expect(await Effect.runPromise(ControlRuntime.CurrentRunId)).toBeUndefined()
})

it("#4269 binds standing approval to a trigger revision and revokes it across restart", async () => {
  const root = join(home, "standing-approval")
  const controlLayer = () => {
    const engine = NodeControl.engineDurable(root)
    return ControlLive.layer.pipe(
      Layer.provide([engine.runtime, engine.journal, Registry.layerNoop(), NotificationQueue.layerNoop()])
    )
  }
  const run = <A, E>(effect: Effect.Effect<A, E, Control.Control | Scheduler.Runner>) =>
    Effect.runPromise(effect.pipe(
      Effect.provide(TriggerPlans.layer(root).pipe(Layer.provideMerge(controlLayer())))
    ))
  const declaration = {
    id: "daily",
    flowId: "system/test",
    input: { suite: "scheduled" },
    cron: "0 * * * *",
    overlap: "skip",
    catchUp: "none",
    maxCatchUp: 1,
    enabled: true
  } as const
  const register = (input: typeof declaration) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(input)
      }).pipe(Effect.provide(SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(root)))))
    )
  await register(declaration)
  const preview = await run(TriggerPlans.previewApproval(root, "daily"))
  const grant = await run(TriggerPlans.grantApproval(root, preview))
  expect(await run(TriggerPlans.grantApproval(root, preview))).toEqual(grant)
  const occurrence = (n: number) => Scheduler.idempotencyKey("daily", n)
  const start = (n: number) =>
    run(
      Effect.flatMap(Scheduler.Runner, (runner) =>
        runner.start({ flowId: declaration.flowId, input: declaration.input, idempotencyKey: occurrence(n) }))
    )
  const inspect = (handle: string) => run(Effect.flatMap(Scheduler.Runner, (runner) => runner.inspect(handle)))
  const first = await start(1000)
  await inspect(first)
  const firstPlan = await TriggerPlans.inspect(root, first)
  expect(firstPlan).toMatchObject({ status: "running", runId: expect.any(String) })
  await inspect(first)
  expect(await TriggerPlans.inspect(root, first)).toEqual(firstPlan)
  await run(TriggerPlans.revokeApproval(root, grant.grantId))
  await run(TriggerPlans.revokeApproval(root, grant.grantId))
  const second = await start(2000)
  await inspect(second)
  expect(await TriggerPlans.inspect(root, second)).toMatchObject({ status: "waiting-approval", runId: null })
  const nextPreview = await run(TriggerPlans.previewApproval(root, "daily"))
  await run(TriggerPlans.grantApproval(root, nextPreview))
  const third = await start(3000)
  await register(declaration)
  await inspect(third)
  expect(await TriggerPlans.inspect(root, third)).toMatchObject({ status: "waiting-approval", runId: null })
})

it.each(["before", "after"] as const)("#4269 revocation survives a crash %s Control acceptance", async (crash) => {
  const root = join(home, `standing-crash-${crash}`)
  const base = () => {
    const engine = NodeControl.engineDurable(root)
    return ControlLive.layer.pipe(
      Layer.provide([engine.runtime, engine.journal, Registry.layerNoop(), NotificationQueue.layerNoop()])
    )
  }
  const run = <A, E>(effect: Effect.Effect<A, E, Control.Control | Scheduler.Runner>, control = base()) =>
    Effect.runPromise(effect.pipe(
      Effect.provide(TriggerPlans.layer(root).pipe(Layer.provideMerge(control)))
    ))
  await Effect.runPromise(
    Effect.flatMap(TriggerStore.TriggerStore, (store) =>
      store.register({
        id: "daily",
        flowId: "system/test",
        input: {},
        cron: "0 * * * *",
        overlap: "skip",
        catchUp: "none",
        maxCatchUp: 1,
        enabled: true
      })).pipe(Effect.provide(SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(root)))))
  )
  const cli = async (args: string[]) => {
    let output = ""
    const codes: number[] = []
    await createApprovalsCli({ environment }).serve([...args, "--root", root, "--json"], {
      stdout: (text) => {
        output += text
      },
      exit: (code) => {
        codes.push(code)
      }
    })
    expect(codes.every((code) => code === 0), output).toBe(true)
    return JSON.parse(output)
  }
  const preview = await cli(["trigger-plan", "daily"])
  const grant = await cli(["grant-trigger", JSON.stringify(preview)])
  const handle = await run(
    Effect.flatMap(
      Scheduler.Runner,
      (runner) =>
        runner.start({ flowId: "system/test", input: {}, idempotencyKey: Scheduler.idempotencyKey("daily", 1000) })
    )
  )
  const broken = Layer.effect(
    Control.Control,
    Effect.map(Control.Control, (control) =>
      Control.make({
        ...control,
        run: (input) =>
          crash === "before" ? Effect.interrupt : control.run(input).pipe(Effect.andThen(Effect.interrupt))
      }))
  ).pipe(Layer.provide(base()))
  const crashed = await run(Effect.exit(Effect.flatMap(Scheduler.Runner, (runner) => runner.inspect(handle))), broken)
  expect(crashed._tag).toBe("Failure")
  await cli(["revoke-trigger", grant.grantId])
  await run(Effect.flatMap(Scheduler.Runner, (runner) => runner.inspect(handle)))
  const entry = await TriggerPlans.inspect(root, handle)
  expect(entry?.runId).toEqual(crash === "before" ? null : expect.any(String))
  const db = new DatabaseSync(NodeControl.databasePath(root), { readOnly: true })
  try {
    expect(db.prepare("SELECT * FROM control_trigger_approval_uses").all()).toHaveLength(1)
    expect(
      db.prepare("SELECT revoked_at_ms FROM control_trigger_approvals WHERE grant_id = ?").get(grant.grantId)
        ?.revoked_at_ms
    ).toEqual(expect.any(Number))
    expect(db.prepare("SELECT * FROM flows_journal_events WHERE event_type = 'control.approval.approved'").all().length)
      .toBeGreaterThanOrEqual(2)
  } finally {
    db.close()
  }
  if (crash === "before") {
    const error = await run(Effect.gen(function*() {
      return yield* Effect.flip(
        (yield* Control.Control).run({
          _tag: "Plan",
          planId: entry!.plan.planId,
          digest: entry!.plan.digest,
          envelope: entry!.plan.envelope,
          idempotencyKey: entry!.idempotencyKey
        })
      )
    }))
    expect(error._tag).toBe("/control/PlanDenied")
  }
})

it("#4269 rechecks operator authority and preserves a manual denial", async () => {
  const root = join(home, "standing-authority")
  let authorized = false
  const policy: ApprovalAuthority.Service = {
    authorize: (request, context) =>
      Effect.suspend(() =>
        authorized
          ? ApprovalAuthority.local.authorize(request, context)
          : Effect.fail(new Unauthorized({ message: "operator authority revoked" }))
      )
  }
  const base = () => {
    const engine = NodeControl.engineDurable(root, undefined, { approvalAuthority: policy })
    return ControlLive.layer.pipe(
      Layer.provide([engine.runtime, engine.journal, Registry.layerNoop(), NotificationQueue.layerNoop()])
    )
  }
  const run = <A, E>(effect: Effect.Effect<A, E, Control.Control | Scheduler.Runner>) =>
    Effect.runPromise(effect.pipe(
      Effect.provide(TriggerPlans.layer(root).pipe(Layer.provideMerge(base())))
    ))
  await Effect.runPromise(
    Effect.flatMap(TriggerStore.TriggerStore, (store) =>
      store.register({
        id: "daily",
        flowId: "system/test",
        input: {},
        cron: "0 * * * *",
        overlap: "skip",
        catchUp: "none",
        maxCatchUp: 1,
        enabled: true
      })).pipe(Effect.provide(SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(root)))))
  )
  const preview = await run(TriggerPlans.previewApproval(root, "daily"))
  expect((await run(Effect.flip(TriggerPlans.grantApproval(root, preview))))._tag).toBe("/control/Unauthorized")
  authorized = true
  const stale = { ...preview, declarationDigest: "stale" }
  expect((await run(Effect.flip(TriggerPlans.grantApproval(root, stale)))).message)
    .toContain("no longer matches")
  const grant = await run(TriggerPlans.grantApproval(root, preview))
  authorized = false
  expect((await run(Effect.flip(TriggerPlans.revokeApproval(root, grant.grantId))))._tag).toBe("/control/Unauthorized")
  const db = new DatabaseSync(NodeControl.databasePath(root), { readOnly: true })
  try {
    expect(db.prepare("SELECT grant_id, revoked_at_ms FROM control_trigger_approvals").all())
      .toEqual([{ grant_id: grant.grantId, revoked_at_ms: null }])
  } finally {
    db.close()
  }
  authorized = true
  const handle = await run(Effect.flatMap(Scheduler.Runner, (runner) =>
    runner.start({
      flowId: "system/test",
      input: {},
      idempotencyKey: Scheduler.idempotencyKey("daily", 1000)
    })))
  const entry = await TriggerPlans.inspect(root, handle)
  await run(
    Effect.flatMap(Control.Control, (control) => control.deny(entry!.plan.approval))
  )
  await run(Effect.flatMap(Scheduler.Runner, (runner) => runner.inspect(handle)))
  expect(await TriggerPlans.inspect(root, handle)).toMatchObject({ status: "failed", runId: null })
  await run(TriggerPlans.revokeApproval(root, grant.grantId))
  expect((await run(Effect.flip(TriggerPlans.grantApproval(root, preview)))).message).toContain("revoked")
})

it.each(["approval", "revoked-approval", "acceptance"] as const)(
  "#4269 recovers an interrupted %s using its recorded consent",
  async (stage) => {
    const root = join(home, `standing-recovery-${stage}`)
    let authorized = true
    const policy: ApprovalAuthority.Service = {
      authorize: (request, context) =>
        Effect.suspend(() =>
          authorized
            ? ApprovalAuthority.local.authorize(request, context)
            : Effect.fail(new Unauthorized({ message: "future approval authority withdrawn" }))
        )
    }
    const base = () => {
      const engine = NodeControl.engineDurable(root, undefined, { approvalAuthority: policy })
      return ControlLive.layer.pipe(
        Layer.provide([engine.runtime, engine.journal, Registry.layerNoop(), NotificationQueue.layerNoop()])
      )
    }
    const run = <A, E>(effect: Effect.Effect<A, E, Control.Control | Scheduler.Runner>, control = base()) =>
      Effect.runPromise(effect.pipe(Effect.provide(TriggerPlans.layer(root).pipe(Layer.provideMerge(control)))))
    await Effect.runPromise(
      Effect.flatMap(TriggerStore.TriggerStore, (store) =>
        store.register({
          id: "daily",
          flowId: "system/test",
          input: {},
          cron: "0 * * * *",
          overlap: "skip",
          catchUp: "none",
          maxCatchUp: 1,
          enabled: true
        })).pipe(Effect.provide(SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(root)))))
    )
    const original = await run(TriggerPlans.grantApproval(root, await run(TriggerPlans.previewApproval(root, "daily"))))
    const handle = await run(Effect.flatMap(Scheduler.Runner, (runner) =>
      runner.start({
        flowId: "system/test",
        input: {},
        idempotencyKey: Scheduler.idempotencyKey("daily", 1000)
      })))
    const broken = Layer.effect(
      Control.Control,
      Effect.map(Control.Control, (control) =>
        Control.make({
          ...control,
          ...(stage !== "acceptance" ?
            { approve: () => Effect.interrupt } :
            {
              run: (input: Parameters<typeof control.run>[0]) =>
                control.run(input).pipe(Effect.andThen(Effect.interrupt))
            })
        }))
    ).pipe(Layer.provide(base()))
    expect((await run(Effect.exit(Effect.flatMap(Scheduler.Runner, (runner) => runner.inspect(handle))), broken))._tag)
      .toBe("Failure")
    if (stage !== "acceptance") {
      const newer = await run(TriggerPlans.grantApproval(root, await run(TriggerPlans.previewApproval(root, "daily"))))
      expect(newer.grantId).not.toBe(original.grantId)
      if (stage === "revoked-approval") await run(TriggerPlans.revokeApproval(root, original.grantId))
    } else {
      authorized = false
    }
    await run(Effect.flatMap(Scheduler.Runner, (runner) => runner.inspect(handle)))
    const recovered = await TriggerPlans.inspect(root, handle)
    expect(recovered).toMatchObject(
      stage === "revoked-approval"
        ? { status: "waiting-approval", runId: null }
        : { status: "running", runId: expect.any(String) }
    )
    const db = new DatabaseSync(NodeControl.databasePath(root), { readOnly: true })
    try {
      expect(db.prepare("SELECT grant_id FROM control_trigger_approval_uses WHERE handle = ?").get(handle))
        .toEqual({ grant_id: original.grantId })
      expect(db.prepare("SELECT COUNT(*) AS count FROM control_runs").get()?.count).toBe(
        stage === "revoked-approval" ? 0 : 1
      )
    } finally {
      db.close()
    }
  }
)
