// `terminal/Open` (worker/flows/TerminalOpen.ts, docs/features/branch-workspace.md#opening-a-terminal) on the Node host
// (worker/test/flowHost.ts) and as its steps alone, over this file's schema of the compose Postgres (`pnpm db:up`). The
// branch's machine is a test `Sandboxes`, standing in for the Cloudflare `SandboxObject` (worker/BranchSandboxes.ts),
// whose real container the e2e suite drives (e2e/branch-workspace.spec.ts).
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Cause, Effect, Exit, Layer, Logger, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { ADMIT_WAIT_SECONDS, OPEN_DEADLINE_SECONDS } from "../../src/features/terminal/contract.ts"
import * as Budget from "../branch/Budget.ts"
import { CheckoutFailed, type SandboxBranch, Sandboxes, SandboxUnavailable } from "../branch/Sandboxes.ts"
import { resetBranches, terminal, terminalRows, tracked } from "../test/branch.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as TerminalOpen from "./TerminalOpen.ts"

const runtime = testFile("terminal_open")
beforeEach(() => resetBranches(runtime))

const REPO = "github/octocat/spoon-knife"
const OWNER = "person-owner"

type Wake = Sandboxes["Service"]["wake"]
type Session = Sandboxes["Service"]["session"]

/** A branch's machine that answers each call from its script, in order, recording every call. */
const machine = (wakes: ReadonlyArray<ReturnType<Wake>>, sessions: ReadonlyArray<ReturnType<Session>> = []) => {
  const calls: Array<string> = []
  let woke = 0
  let started = 0
  const service = Sandboxes.of({
    wake: (branch) =>
      Effect.suspend(() => {
        calls.push(`wake ${branch.branchId} ${branch.owner}/${branch.name}@${branch.branch}`)
        return wakes[Math.min(woke++, wakes.length - 1)]!
      }),
    session: (branchId, terminalId, ownerId) =>
      Effect.suspend(() => {
        calls.push(`session ${branchId} ${terminalId} ${ownerId}`)
        return sessions[Math.min(started++, sessions.length - 1)] ?? Effect.void
      }),
  })
  return { calls, layer: Layer.succeed(Sandboxes, service) }
}

/** A tracked branch with an `opening` terminal of `OWNER`, created `ageSeconds` ago: what the flow is started for. */
const opening = async (ageSeconds = 0) => {
  const { branchId } = await tracked(runtime, REPO, `b-${crypto.randomUUID().slice(0, 8)}`)
  const terminalId = crypto.randomUUID()
  await terminal(runtime, { id: terminalId, branchId, ownerId: OWNER, status: "opening", ageSeconds })
  const branch: SandboxBranch = { branchId, owner: "octocat", name: "Spoon-Knife", branch: "test-branch" }
  return { branchId, terminalId, branch }
}

const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))

const run = async (
  started: Awaited<ReturnType<typeof opening>>,
  sandboxes: ReturnType<typeof machine>,
) =>
  runFlow(
    TerminalOpen.TerminalOpen,
    { terminalId: started.terminalId, ownerId: OWNER, branch: started.branch },
    TerminalOpen.registration(await database()).pipe(Layer.provide(sandboxes.layer)),
  )

const row = async (branchId: string) => (await terminalRows(runtime, branchId))[0]!

const sql = <A extends object = Record<string, unknown>>(statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe<A>(statement))))

/** The branch's ledger slots (worker/branch/Budget.ts). */
const slots = (branchId: string) =>
  sql(`
    SELECT person_id AS "personId", kind, generation, ended_at IS NULL AS open
    FROM sandbox_generations WHERE branch_id = '${branchId}' ORDER BY id`)

/** The terminal's wait: whether it waits, and whether it was admitted after one. */
const waitOf = (terminalId: string) =>
  sql<{ waiting: boolean; admitted: boolean }>(
    `SELECT waiting, admitted_at IS NOT NULL AS admitted FROM terminal_sessions WHERE id = '${terminalId}'`,
  ).then(([found]) => found)

describe("terminal/Open on the Node host", () => {
  test("wakes the branch's machine, starts the owner's session and records the terminal open on that generation", async () => {
    const started = await opening()
    const sandboxes = machine([Effect.succeed({ generation: 3 })])
    const ran = await run(started, sandboxes)
    expect(ran.exit).toEqual(Exit.succeed({ recorded: true }))
    expect(ran.status).toBe("completed")
    expect(sandboxes.calls).toEqual([
      `wake ${started.branchId} octocat/Spoon-Knife@test-branch`,
      `session ${started.branchId} ${started.terminalId} ${OWNER}`,
    ])
    expect(await row(started.branchId)).toMatchObject({ status: "open", generation: "3", failure: null, ended: false })
    // The machine was admitted under the sandbox limits for the terminal's owner before it woke.
    expect(await slots(started.branchId)).toEqual([{ personId: OWNER, kind: "branch", generation: null, open: true }])
  })

  test("a machine that can't start yet is woken again, and the terminal opens", async () => {
    const started = await opening()
    const sandboxes = machine([
      Effect.fail(new SandboxUnavailable({ reason: "start" })),
      Effect.succeed({ generation: 1 }),
    ])
    const ran = await run(started, sandboxes)
    expect(ran.exit).toEqual(Exit.succeed({ recorded: true }))
    expect(sandboxes.calls.filter((call) => call.startsWith("wake"))).toHaveLength(2)
    expect(await row(started.branchId)).toMatchObject({ status: "open", generation: "1" })
  }, 30_000)

  test("a refused checkout isn't retried: the terminal fails as `checkout` and no session starts", async () => {
    const started = await opening()
    const sandboxes = machine([Effect.fail(new CheckoutFailed())])
    const ran = await run(started, sandboxes)
    expect(ran.exit).toEqual(Exit.succeed({ recorded: true }))
    expect(sandboxes.calls).toEqual([`wake ${started.branchId} octocat/Spoon-Knife@test-branch`])
    expect(await row(started.branchId)).toMatchObject({ status: "failed", failure: "checkout", ended: true })
  })

  test("an open that settles past the deadline fails the terminal as `unavailable`", async () => {
    const started = await opening(OPEN_DEADLINE_SECONDS + 5)
    const ran = await run(started, machine([Effect.succeed({ generation: 2 })]))
    expect(ran.exit).toEqual(Exit.succeed({ recorded: true }))
    expect(await row(started.branchId)).toMatchObject({
      status: "failed",
      failure: "unavailable",
      generation: "2",
      ended: true,
    })
  })

  test("a terminal no longer opening is left as it is", async () => {
    const { branchId } = await tracked(runtime, REPO, "settled")
    const terminalId = crypto.randomUUID()
    await terminal(runtime, { id: terminalId, branchId, ownerId: OWNER, status: "ended" })
    const ran = await run(
      { branchId, terminalId, branch: { branchId, owner: "octocat", name: "Spoon-Knife", branch: "settled" } },
      machine([Effect.succeed({ generation: 9 })]),
    )
    expect(ran.exit).toEqual(Exit.succeed({ recorded: false }))
    expect(await row(branchId)).toMatchObject({ status: "ended", generation: null })
  })
})

/** Runs `effect` with a logger and metric registry of its own: its result, log lines and the opens it counted. */
const observed = async <A, E>(effect: Effect.Effect<A, E>) => {
  const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logger = Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))
  const registry: Metric.MetricRegistry = new Map()
  const exit = await Effect.runPromiseExit(
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  const opens = (outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(TerminalOpen.opens, { outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ).count
  return { exit, lines, opens }
}

describe("the steps", () => {
  test("wake logs the generation it woke, or the failure's code, by branch", async () => {
    const steps = TerminalOpen.steps(await database())
    const branch: SandboxBranch = { branchId: "b-1", owner: "octocat", name: "Spoon-Knife", branch: "main" }
    const woke = await observed(
      steps.wake({ branch }).pipe(Effect.provide(machine([Effect.succeed({ generation: 4 })]).layer)),
    )
    expect(woke.exit).toEqual(Exit.succeed({ generation: 4 }))
    expect(woke.lines).toMatchObject([
      { message: "terminal.open.wake", level: "INFO", annotations: { branchId: "b-1", generation: 4 } },
    ])

    const refused = await observed(
      steps.wake({ branch }).pipe(Effect.provide(machine([Effect.fail(new CheckoutFailed())]).layer)),
    )
    expect(Exit.isFailure(refused.exit) && Cause.squash(refused.exit.cause)).toEqual(new CheckoutFailed())
    expect(refused.lines).toHaveLength(1)
    expect(refused.lines[0]).toMatchObject({ message: "terminal.open.wake", level: "WARN" })
    expect(refused.lines[0]!.annotations).toMatchObject({ branchId: "b-1" })
    expect(refused.lines[0]!.annotations).toHaveProperty("errorCode")
  })

  test("admit holds the branch a machine; with none free the row says waiting until one is, and its deadline counts from then", async () => {
    const steps = TerminalOpen.steps(await database())
    await runtime.runPromise(Budget.setLimits({ awake: 1, perPerson: 2, monthlyAlertUsd: 100 }, "person-admin"))
    // Another branch's machine is awake: the only one the limits allow.
    await runtime.runPromise(Budget.admit({ branchId: "busy-branch", personId: "person-other", kind: "branch" }))
    const started = await opening(OPEN_DEADLINE_SECONDS + 60)
    const payload = { terminalId: started.terminalId, ownerId: OWNER, branch: started.branch }

    const waiting = await observed(steps.admit(payload))
    expect(Exit.isFailure(waiting.exit) && Cause.squash(waiting.exit.cause)).toEqual(new TerminalOpen.NoSandboxFree())
    expect(await waitOf(started.terminalId)).toEqual({ waiting: true, admitted: false })
    expect(waiting.lines).toMatchObject([{ message: "sandbox.budget", level: "WARN", annotations: { outcome: "waiting" } }])
    // Asked again while still none is free: still waiting, nothing else changes.
    expect(Exit.isFailure(await Effect.runPromiseExit(steps.admit(payload)))).toBe(true)

    // The other machine sleeps: this terminal gets one, and opens although it was asked for long ago.
    await sql(`UPDATE sandbox_generations SET ended_at = now() WHERE branch_id = 'busy-branch'`)
    expect(await Effect.runPromise(steps.admit(payload))).toEqual({ awake: 1 })
    expect(await waitOf(started.terminalId)).toEqual({ waiting: false, admitted: true })
    expect(await Effect.runPromise(steps.settle({ terminalId: started.terminalId, outcome: { status: "open", generation: 1 } })))
      .toEqual({ recorded: true })
    expect(await row(started.branchId)).toMatchObject({ status: "open", failure: null })
  })

  test("admit fails AdmitUnavailable while Postgres can't be asked, for the engine to retry", async () => {
    const steps = TerminalOpen.steps(Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("connection refused"))))
    const branch: SandboxBranch = { branchId: "b-1", owner: "octocat", name: "Spoon-Knife", branch: "main" }
    const exit = await Effect.runPromiseExit(steps.admit({ terminalId: crypto.randomUUID(), ownerId: OWNER, branch }))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(new TerminalOpen.AdmitUnavailable())
  })

  test("admit for a terminal whose row is gone still holds the machine, and changes no row", async () => {
    const steps = TerminalOpen.steps(await database())
    const branch: SandboxBranch = { branchId: `b-${crypto.randomUUID().slice(0, 8)}`, owner: "octocat", name: "Spoon-Knife", branch: "main" }
    expect(await Effect.runPromise(steps.admit({ terminalId: crypto.randomUUID(), ownerId: OWNER, branch }))).toEqual({ awake: 1 })
  })

  test("a terminal waits for a free machine for half an hour, asked again from 5 s doubling to 30 s", () => {
    expect(ADMIT_WAIT_SECONDS).toBe(1800)
    expect(TerminalOpen.ADMIT_RETRY).toMatchObject({ initialMs: 5_000, factor: 2, maxMs: 30_000, expirationMs: 1_800_000 })
  })

  test("a session the machine can't start fails the step for the engine to retry", async () => {
    const steps = TerminalOpen.steps(await database())
    const sandboxes = machine([], [Effect.fail(new SandboxUnavailable({ reason: "exec" }))])
    const exit = await Effect.runPromiseExit(
      steps.session({ branchId: "b-1", terminalId: crypto.randomUUID(), ownerId: OWNER, generation: 1 }).pipe(
        Effect.provide(sandboxes.layer),
      ),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(new SandboxUnavailable({ reason: "exec" }))
  })

  test("failed names the machine's failure: `checkout` for a refused clone, else `unavailable`", async () => {
    const steps = TerminalOpen.steps(await database())
    expect(await Effect.runPromise(steps.failed({ error: new CheckoutFailed() }))).toEqual({
      status: "failed",
      failure: "checkout",
    })
    for (const reason of ["start", "exec", "waiting"] as const) {
      expect(await Effect.runPromise(steps.failed({ error: new SandboxUnavailable({ reason }) }))).toEqual({
        status: "failed",
        failure: "unavailable",
      })
    }
    // No machine came free within the wait, or Postgres couldn't be asked: `unavailable` too.
    for (const error of [new TerminalOpen.NoSandboxFree(), new TerminalOpen.AdmitUnavailable()]) {
      expect(await Effect.runPromise(steps.failed({ error }))).toEqual({ status: "failed", failure: "unavailable" })
    }
  })

  test("settle counts and logs an outcome it recorded, and only logs one it didn't", async () => {
    const steps = TerminalOpen.steps(await database())
    const opened = await opening()
    const open = await observed(steps.settle({ terminalId: opened.terminalId, outcome: { status: "open", generation: 1 } }))
    expect(open.exit).toEqual(Exit.succeed({ recorded: true }))
    expect(open.opens("open")).toBe(1)
    expect(open.lines).toMatchObject([
      {
        message: "terminal.open",
        level: "INFO",
        annotations: { terminalId: opened.terminalId, outcome: "open", recorded: true },
      },
    ])

    const failed = await opening()
    const refused = await observed(
      steps.settle({ terminalId: failed.terminalId, outcome: { status: "failed", failure: "checkout" } }),
    )
    expect(refused.exit).toEqual(Exit.succeed({ recorded: true }))
    expect(refused.opens("checkout")).toBe(1)
    expect(refused.lines).toMatchObject([
      { message: "terminal.open", level: "WARN", annotations: { outcome: "checkout", recorded: true } },
    ])
    expect(await row(failed.branchId)).toMatchObject({ status: "failed", failure: "checkout", ended: true })

    // The same outcome again finds the row settled: nothing counted, the line says so.
    const again = await observed(
      steps.settle({ terminalId: failed.terminalId, outcome: { status: "failed", failure: "checkout" } }),
    )
    expect(again.exit).toEqual(Exit.succeed({ recorded: false }))
    expect(again.opens("checkout")).toBe(0)
    expect(again.lines).toMatchObject([{ message: "terminal.open", annotations: { recorded: false } }])
  })

  test("settle fails as RecordUnavailable when Postgres can't be reached, for the engine to retry", async () => {
    const steps = TerminalOpen.steps(Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("connection refused"))))
    const exit = await Effect.runPromiseExit(
      steps.settle({ terminalId: crypto.randomUUID(), outcome: { status: "open", generation: 1 } }),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(TerminalOpen.RecordUnavailable)
  })
})
