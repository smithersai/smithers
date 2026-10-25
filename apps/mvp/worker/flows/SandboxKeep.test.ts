// `sandbox/Keep` (worker/flows/SandboxKeep.ts, docs/features/sandbox-tools.md#sleep-and-wake) on the Node host
// (worker/test/flowHost.ts) and as its steps alone, over this file's schema of the compose Postgres (`pnpm db:up`). The
// branch's machine is a test `Machines`, standing in for the Cloudflare `SandboxObject` (worker/BranchSandboxes.ts);
// what the machine decides is idle is worker/branch/Machine.test.ts's. A busy machine is asked again only after
// `KEEP_EVERY_SECONDS`, by the engine's retry policy, so a busy answer is tested as the step's failure.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Cause, ConfigProvider, Effect, Exit, Layer, Logger, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { DEFAULT_IDLE_SECONDS, keepExecutionId } from "../../src/features/sandbox/contract.ts"
import { Machines, type SleepOutcome } from "../branch/Machines.ts"
import { noCommands } from "../test/commands.ts"
import { SandboxUnavailable } from "../branch/Sandboxes.ts"
import { resetBranches, tracked } from "../test/branch.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as SandboxKeep from "./SandboxKeep.ts"

const runtime = testFile("sandbox_keep")
beforeEach(() => resetBranches(runtime))

const REPO = "github/octocat/spoon-knife"

/** A machine that answers `sleepIfIdle` from its script, in order, recording every question. */
const machine = (answers: ReadonlyArray<Effect.Effect<SleepOutcome, SandboxUnavailable>>) => {
  const asked: Array<{ readonly branchId: string; readonly generation: number; readonly idleMs: number }> = []
  const service = Machines.of({
    commands: () => noCommands,
    tool: () => Effect.die("sandbox/Keep never runs a tool"),
    sleepIfIdle: (branchId, generation, idleMs) =>
      Effect.suspend(() => {
        asked.push({ branchId, generation, idleMs })
        return answers[Math.min(asked.length - 1, answers.length - 1)]!
      }),
  })
  return { asked, layer: Layer.succeed(Machines, service) }
}

/** A tracked branch with open terminals on generations 1 and 2, and an ended one on 2: their ids. */
const withTerminals = async () => {
  const { branchId } = await tracked(runtime, REPO, `b-${crypto.randomUUID().slice(0, 8)}`)
  const ids = { first: crypto.randomUUID(), second: crypto.randomUUID(), closed: crypto.randomUUID() }
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`
      INSERT INTO terminal_sessions (id, branch_id, owner_id, owner_login, owner_role, status, generation, ended_reason)
      VALUES (${ids.first}, ${branchId}, 'person-a', 'a', 'member', 'open', 1, NULL),
        (${ids.second}, ${branchId}, 'person-b', 'b', 'member', 'open', 2, NULL),
        (${ids.closed}, ${branchId}, 'person-c', 'c', 'member', 'ended', 2, 'closed')`))
  return { branchId, ...ids }
}

/** Every terminal of `branchId`: its id, status and why it ended. */
const terminals = (branchId: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly status: string; readonly endedReason: string | null }>`
      SELECT id, status, ended_reason AS "endedReason" FROM terminal_sessions WHERE branch_id = ${branchId}`))
    .then((rows) => Object.fromEntries(rows.map((row) => [row.id, [row.status, row.endedReason]])))

const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))

describe("sandbox/Keep on the Node host", () => {
  test("a machine idle for the default idle time sleeps, and that generation's open terminals end slept", async () => {
    const branch = await withTerminals()
    const machines = machine([Effect.succeed("slept")])
    const ran = await runFlow(
      SandboxKeep.Keep,
      { branchId: branch.branchId, generation: 2 },
      SandboxKeep.registration(await database()).pipe(Layer.provide(machines.layer)),
    )

    expect(ran.exit).toEqual(Exit.succeed({ ended: "slept", terminals: 1 }))
    expect(ran.status).toBe("completed")
    expect(machines.asked).toEqual([{ branchId: branch.branchId, generation: 2, idleMs: DEFAULT_IDLE_SECONDS * 1000 }])
    expect(await terminals(branch.branchId)).toEqual({
      [branch.first]: ["open", null],
      [branch.second]: ["ended", "slept"],
      [branch.closed]: ["ended", "closed"],
    })
  })

  test("a generation gone already ends its terminals too, and the idle time comes from SANDBOX_IDLE_SECONDS", async () => {
    const branch = await withTerminals()
    const machines = machine([Effect.succeed("gone")])
    const configured = Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ SANDBOX_IDLE_SECONDS: "60" }))
    const idleMs = (await runtime.runPromise(SandboxKeep.idleSeconds.pipe(Effect.provide(configured)))) * 1000
    const ran = await runFlow(
      SandboxKeep.Keep,
      { branchId: branch.branchId, generation: 1 },
      SandboxKeep.registration(await database(), idleMs).pipe(Layer.provide(machines.layer)),
    )

    expect(ran.exit).toEqual(Exit.succeed({ ended: "gone", terminals: 1 }))
    expect(machines.asked).toEqual([{ branchId: branch.branchId, generation: 1, idleMs: 60_000 }])
    expect((await terminals(branch.branchId))[branch.first]).toEqual(["ended", "slept"])
    expect((await terminals(branch.branchId))[branch.second]).toEqual(["open", null])
  })
})

/** Runs `effect` with a logger and metric registry of its own: its exit, log lines and the keeps it counted. */
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
  const counted = (outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(SandboxKeep.keeps, { outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ).count
  return { exit, lines, counted }
}

describe("the steps", () => {
  test("a busy machine, or one that can't answer, fails MachineBusy for the engine to ask again later", async () => {
    const steps = SandboxKeep.steps(await database(), 1_000)
    const busy = await observed(
      steps.sleepIfIdle({ branchId: "b-1", generation: 3 }).pipe(Effect.provide(machine([Effect.succeed("busy")]).layer)),
    )
    expect(Exit.isFailure(busy.exit) && Cause.squash(busy.exit.cause)).toBeInstanceOf(SandboxKeep.MachineBusy)
    expect(busy.counted("busy")).toBe(1)
    expect(busy.lines).toEqual([])

    const unavailable = await observed(
      steps.sleepIfIdle({ branchId: "b-1", generation: 3 }).pipe(
        Effect.provide(machine([Effect.fail(new SandboxUnavailable({ reason: "exec" }))]).layer),
      ),
    )
    expect(Exit.isFailure(unavailable.exit) && Cause.squash(unavailable.exit.cause)).toBeInstanceOf(
      SandboxKeep.MachineBusy,
    )
    expect(unavailable.counted("unavailable")).toBe(1)
    expect(unavailable.lines).toMatchObject([
      {
        message: "sandbox.keep",
        level: "WARN",
        annotations: { branchId: "b-1", generation: 3, errorCode: "@smthrs/mvp/branch/SandboxUnavailable" },
      },
    ])

    const slept = await observed(
      steps.sleepIfIdle({ branchId: "b-1", generation: 3 }).pipe(Effect.provide(machine([Effect.succeed("slept")]).layer)),
    )
    expect(slept.exit).toEqual(Exit.succeed("slept"))
    expect(slept.counted("slept")).toBe(1)
  })

  test("slept logs how many terminals it ended; Postgres down is SleptUnrecorded, for the engine to retry", async () => {
    const branch = await withTerminals()
    const steps = SandboxKeep.steps(await database(), 1_000)
    const ended = await observed(steps.slept({ branchId: branch.branchId, generation: 2, ended: "slept" }))
    expect(ended.exit).toEqual(Exit.succeed({ ended: "slept", terminals: 1 }))
    expect(ended.lines).toMatchObject([
      { message: "sandbox.slept", level: "INFO", annotations: { branchId: branch.branchId, generation: 2, terminals: 1 } },
    ])
    // Again, nothing is open on that generation any more.
    expect((await observed(steps.slept({ branchId: branch.branchId, generation: 2, ended: "slept" }))).exit).toEqual(
      Exit.succeed({ ended: "slept", terminals: 0 }),
    )

    const down = SandboxKeep.steps(Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("connection refused"))), 1_000)
    const exit = await Effect.runPromiseExit(down.slept({ branchId: branch.branchId, generation: 2, ended: "gone" }))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(SandboxKeep.SleptUnrecorded)
  })

  test("a busy machine renews its generation's ledger slot; a renewal Postgres refuses is logged and the keep asks on", async () => {
    const branchId = `ledger-${crypto.randomUUID()}`
    const sql = (statement: string) =>
      runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe<{ fresh: boolean }>(statement))))
    await sql(`
      INSERT INTO sandbox_generations (branch_id, generation, kind, instance, started_at, seen_at)
      VALUES ('${branchId}', 3, 'branch', 'standard-1', now() - interval '10 minutes', now() - interval '4 minutes'),
        ('${branchId}-other', 3, 'branch', 'standard-1', now() - interval '10 minutes', now() - interval '4 minutes')`)
    const fresh = () =>
      sql(`SELECT seen_at > now() - interval '5 seconds' AS fresh FROM sandbox_generations WHERE branch_id = '${branchId}'`)

    const busy = await observed(
      SandboxKeep.steps(await database(), 1_000).sleepIfIdle({ branchId, generation: 3 }).pipe(
        Effect.provide(machine([Effect.succeed("busy")]).layer),
      ),
    )
    expect(Exit.isFailure(busy.exit) && Cause.squash(busy.exit.cause)).toBeInstanceOf(SandboxKeep.MachineBusy)
    expect(await fresh()).toEqual([{ fresh: true }])
    // Only that branch's slot.
    expect(await sql(`SELECT seen_at > now() - interval '5 seconds' AS fresh FROM sandbox_generations WHERE branch_id = '${branchId}-other'`))
      .toEqual([{ fresh: false }])

    const down = SandboxKeep.steps(Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("connection refused"))), 1_000)
    const refused = await observed(
      down.sleepIfIdle({ branchId, generation: 3 }).pipe(Effect.provide(machine([Effect.succeed("busy")]).layer)),
    )
    expect(Exit.isFailure(refused.exit) && Cause.squash(refused.exit.cause)).toBeInstanceOf(SandboxKeep.MachineBusy)
    expect(refused.lines).toMatchObject([
      { message: "sandbox.keep.seen", level: "WARN", annotations: { branchId, generation: 3, errorCode: expect.any(String) } },
    ])
  })

  test("slept closes the generation's ledger slot, and only that generation's", async () => {
    const branch = await withTerminals()
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`
        INSERT INTO sandbox_generations (branch_id, generation, kind, instance, started_at, seen_at, ended_at)
        VALUES (${branch.branchId}, 1, 'branch', 'standard-1', now() - interval '1 hour', now() - interval '30 minutes',
          now() - interval '30 minutes'),
          (${branch.branchId}, 2, 'branch', 'standard-1', now() - interval '20 minutes', now(), NULL)`))
    const steps = SandboxKeep.steps(await database(), 1_000)
    expect((await observed(steps.slept({ branchId: branch.branchId, generation: 2, ended: "slept" }))).exit).toEqual(
      Exit.succeed({ ended: "slept", terminals: 1 }),
    )
    const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly generation: number; readonly ended: boolean; readonly recent: boolean }>`
        SELECT generation, ended_at IS NOT NULL AS ended, ended_at > now() - interval '5 seconds' AS recent
        FROM sandbox_generations WHERE branch_id = ${branch.branchId} ORDER BY generation`))
    expect(rows).toEqual([{ generation: 1, ended: true, recent: false }, { generation: 2, ended: true, recent: true }])
  })

  test("each generation of a branch's machine has its own sandbox/Keep execution", () => {
    const branchId = crypto.randomUUID()
    expect(keepExecutionId(branchId, 3)).toBe(keepExecutionId(branchId, 3))
    expect(new Set([keepExecutionId(branchId, 3), keepExecutionId(branchId, 4), keepExecutionId(crypto.randomUUID(), 3)]).size)
      .toBe(3)
  })

  test("the idle time is SANDBOX_IDLE_SECONDS, fifteen minutes unless set", async () => {
    const read = (config: Record<string, string>) =>
      Effect.runPromise(
        SandboxKeep.idleSeconds.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
        ),
      )
    expect(await read({})).toBe(DEFAULT_IDLE_SECONDS)
    expect(await read({ SANDBOX_IDLE_SECONDS: "120" })).toBe(120)
  })
})
