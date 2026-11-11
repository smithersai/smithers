// A repository's schedules (worker/ci/Cron.ts): `triggers/Sync` registering the default branch's cron rows in the
// trigger store, and `triggers/Tick`'s steps firing them through `@smthrs/triggers` as `repo/Run`s, against the scripted
// GitHub, a trigger store in a schema of its own on the compose Postgres, and the starts recorded: the only stand-ins
// besides GitHub. Steps run on the test clock; the flows run on the Node host's engine.
import { TestSchemas } from "@smthrs/database"
import { TriggerError, TriggerStore } from "@smthrs/triggers"
import { Duration, Effect, Exit, Layer, Logger, Metric, Option, Result } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as Flows from "../Flows.ts"
import * as Expire from "../flows/Expire.ts"
import * as Pause from "../flows/Pause.ts"
import { database, REPOSITORY, reset, services as githubServices } from "../github/test/fixtures.ts"
import { type ScriptedGitHub, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile, uuid } from "../test/harness.ts"
import * as Cron from "./Cron.ts"
import type * as Dispatch from "./Dispatch.ts"

const runtime = testFile("ci_cron")
beforeEach(async () => {
  await reset(runtime)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM runs WHERE execution IS NOT NULL`))
})

const REPO = `${REPOSITORY.owner}/${REPOSITORY.name}`
const FLOW = "export default {}"
const MINUTE = 60_000

const schemas: Array<string> = []
afterAll(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(schemas, (schema) => sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`, { discard: true })))
)

/** A trigger store in a fresh schema of the compose Postgres, as `Cron.storeOn` builds it on Cloudflare. */
const freshStore = async () => {
  const url = (await Effect.runPromise(TestDatabase.serverUrl)).toString()
  const schema = TestSchemas.schemaName("triggers")
  schemas.push(schema)
  return { schema, store: Cron.storeOn(ExecutionHost.database(url, schema)) }
}

const manifest = (rows: ReadonlyArray<unknown>) => JSON.stringify({ apiVersion: 1, contributes: { triggers: rows } })

interface Started {
  readonly flow: string
  readonly executionId: string
  readonly payload: unknown
}

/** Schedules' services over `github`: this file's tables, a fresh store unless given, starts and cancels recorded. */
const scheduled = async (
  github: ScriptedGitHub,
  options: {
    readonly repositories?: ReadonlySet<string>
    readonly store?: Layer.Layer<TriggerStore.TriggerStore, unknown>
    readonly start?: () => Effect.Effect<void, unknown>
    readonly cancel?: () => Effect.Effect<void, unknown>
  } = {},
) => {
  const { services } = await githubServices(runtime, github)
  const fresh = await freshStore()
  const starts: Array<Started> = []
  const cancels: Array<string> = []
  const value: Cron.Services<unknown, never> = {
    ...services,
    repositories: options.repositories ?? new Set([REPO]),
    store: options.store ?? fresh.store,
    start: (flow, started) =>
      Effect.andThen(options.start?.() ?? Effect.void, Effect.sync(() => void starts.push({ flow: flow._tag, ...started }))),
    cancel: (executionId) => Effect.andThen(options.cancel?.() ?? Effect.void, Effect.sync(() => void cancels.push(executionId))),
  }
  return { services: value, starts, cancels, schema: fresh.schema }
}

/** Runs `effect` on this file's tables and the test clock at `at`, keeping its log lines and counts. */
const lines: Array<{ readonly message: unknown }> = []
const registry: Metric.MetricRegistry = new Map()
beforeEach(() => {
  lines.length = 0
  registry.clear()
})
const at = <A, E>(time: number, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  runtime.runPromise(Effect.result(Effect.andThen(TestClock.setTime(time), effect)).pipe(
    Effect.provide(TestClock.layer()),
    Effect.provideService(Metric.MetricRegistry, registry),
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => {
      lines.push({ message: options.message })
    })])),
  ))
const count = (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
  Effect.runSync(Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count
const messages = () => lines.map((line) => line.message).flat()

const stored = (store: Layer.Layer<TriggerStore.TriggerStore, unknown>) =>
  runtime.runPromise(Effect.flatMap(TriggerStore.TriggerStore, (triggers) => triggers.list()).pipe(
    Effect.map((listed) => listed.flatMap((row) => Result.isSuccess(row.trigger) ? [row.trigger.success] : [])),
    Effect.provide(store),
  ))

const history = (store: Layer.Layer<TriggerStore.TriggerStore, unknown>) =>
  runtime.runPromise(Effect.flatMap(TriggerStore.TriggerStore, (triggers) => triggers.history()).pipe(
    Effect.map((page) => page.items.map((fire) => [fire.occurrence, fire.outcome]).reverse()),
    Effect.provide(store),
  ))

const request = (delivery = uuid()): Cron.SyncRequest => ({ delivery, repo: REPO, defaultBranch: "main" })

/** A minute boundary ten minutes ago: every test's clock starts there. */
const T0 = Math.floor(Date.now() / MINUTE) * MINUTE - 10 * MINUTE

describe("ids and requests", () => {
  const dispatched: Dispatch.DispatchRequest = {
    delivery: "d1", repo: REPO, defaultBranch: "main", event: "push", ref: "refs/heads/main", branch: "main", tag: null,
    action: null, sha: "a".repeat(40), trusted: true,
  }

  test("only a push to the default branch syncs its schedules", () => {
    expect(Cron.syncRequestOf(dispatched)).toEqual(Option.some({ delivery: "d1", repo: REPO, defaultBranch: "main" }))
    expect(Cron.syncRequestOf({ ...dispatched, branch: "feature/x" })).toEqual(Option.none())
    expect(Cron.syncRequestOf({ ...dispatched, event: "pull_request", ref: "refs/pull/1/head" })).toEqual(Option.none())
    expect(Cron.syncExecutionId("d1")).toBe("triggers/sync:d1")
    expect(Cron.tickExecutionId({ from: 120_000, until: 180_000 })).toBe("triggers/tick:120000")
  })

  test("a trigger's id names its repository in lower case, flow, expression and timezone; a run's its occurrence", () => {
    expect(Cron.triggerId("Acme/Widgets", { flow: "nightly", cron: "0 3 * * *", timezone: "Europe/Paris" }))
      .toBe("acme/widgets#nightly#0 3 * * *#Europe/Paris")
    expect(Cron.triggerId("acme/widgets", { flow: "nightly", cron: "0 3 * * *" })).toBe("acme/widgets#nightly#0 3 * * *#")
    expect(Cron.runExecutionId("nightly", "acme/widgets#nightly#0 3 * * *#", "20261110T0300Z"))
      .toMatch(/^nightly:cron-[0-9a-f]{16}-20261110T0300Z$/)
  })
})

describe("triggers/Sync", { timeout: 60_000 }, () => {
  const sync = (services: Cron.Services<unknown, never>, sent = request()) =>
    runFlow(
      Cron.Sync,
      sent,
      ExecutionHost.withSchedules({ flows: [], registration: Layer.empty }, Effect.succeed(services)).registration,
      { executionId: Cron.syncExecutionId(sent.delivery) },
    )

  test("registers each active flow's cron rows, skips what the package refuses, and disables rows the manifest dropped", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", {
      ".smithers/factory.json": manifest([
        { on: "cron", flow: "nightly", cron: "0 3 * * *", timezone: "Europe/Paris", overlap: "supersede" },
        { on: "cron", flow: "nightly", cron: "0 3 * * *", timezone: "Europe/Paris" },
        { on: "cron", flow: "hourly", cron: "0 * * * *" },
        { on: "cron", flow: "hourly", cron: "0 0 30 2 *" },
        { on: "cron", flow: "unmerged", cron: "0 * * * *" },
        { on: "cron", flow: "seconds", cron: "* * * * * *" },
        { on: "github.push", flow: "hourly" },
      ]),
      ".smithers/flows/nightly/flow.ts": FLOW,
      ".smithers/flows/hourly/flow.ts": FLOW,
      ".smithers/flows/seconds/flow.ts": FLOW,
    })
    const { services } = await scheduled(github)
    const first = await sync(services)
    expect(first.exit).toEqual(Exit.succeed({ outcome: "registered", registered: 2, unchanged: 0, disabled: 0, refused: 1 }))
    expect(await stored(services.store)).toEqual([
      expect.objectContaining({
        id: "acme/widgets#hourly#0 * * * *#",
        flowId: "hourly",
        input: { repo: REPO, flow: "hourly", defaultBranch: "main", cron: "0 * * * *" },
        overlap: "skip",
        catchUp: "none",
        maxCatchUp: 0,
        enabled: true,
      }),
      expect.objectContaining({
        id: "acme/widgets#nightly#0 3 * * *#Europe/Paris",
        input: { repo: REPO, flow: "nightly", defaultBranch: "main", cron: "0 3 * * *", timezone: "Europe/Paris" },
        timezone: "Europe/Paris",
        overlap: "supersede",
        enabled: true,
      }),
    ])

    // The same manifest again changes nothing; a row it drops stays, disabled, and stays disabled after.
    expect((await sync(services)).exit).toEqual(Exit.succeed({ outcome: "registered", registered: 0, unchanged: 2, disabled: 0, refused: 1 }))
    github.push("main", { ".smithers/factory.json": manifest([{ on: "cron", flow: "hourly", cron: "0 * * * *" }]) })
    expect((await sync(services)).exit).toEqual(Exit.succeed({ outcome: "registered", registered: 0, unchanged: 1, disabled: 1, refused: 0 }))
    github.push("main", { ".smithers/factory.json": null })
    expect((await sync(services)).exit).toEqual(Exit.succeed({ outcome: "registered", registered: 0, unchanged: 0, disabled: 1, refused: 0 }))
    expect((await stored(services.store)).map((trigger) => [trigger.flowId, trigger.enabled]))
      .toEqual([["hourly", false], ["nightly", false]])
  })

  test("a trigger only another branch declares registers nothing: schedules come from the default branch", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", { ".smithers/flows/nightly/flow.ts": FLOW })
    github.push("feature/x", { ".smithers/factory.json": manifest([{ on: "cron", flow: "nightly", cron: "0 3 * * *" }]) })
    const { services } = await scheduled(github)
    expect((await sync(services)).exit).toEqual(Exit.succeed({ outcome: "registered", registered: 0, unchanged: 0, disabled: 0, refused: 0 }))
    expect(await stored(services.store)).toEqual([])
  })

  test("a repository outside the allowlist, or one the App can't read, registers nothing", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", { ".smithers/factory.json": manifest([{ on: "cron", flow: "nightly", cron: "0 3 * * *" }]) })
    const denied = await scheduled(github, { repositories: new Set() })
    expect((await sync(denied.services)).exit).toEqual(Exit.succeed({ outcome: "not_allowed", registered: 0, unchanged: 0, disabled: 0, refused: 0 }))
    expect(github.calls).toEqual([])
    github.contentsGranted = false
    const closed = await scheduled(github)
    expect((await sync(closed.services)).exit).toEqual(Exit.succeed({ outcome: "unreadable", registered: 0, unchanged: 0, disabled: 0, refused: 0 }))
  })

  test("GitHub's outages are tried again", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", {
      ".smithers/factory.json": manifest([{ on: "cron", flow: "nightly", cron: "0 3 * * *" }]),
      ".smithers/flows/nightly/flow.ts": FLOW,
    })
    github.faults.push(
      { match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), status: 502 },
      { match: (method, path) => method === "GET" && path.includes("/contents/"), status: 502 },
    )
    const { services } = await scheduled(github)
    expect((await sync(services)).exit).toEqual(Exit.succeed({ outcome: "registered", registered: 1, unchanged: 0, disabled: 0, refused: 0 }))
  })

  test("a store that can't answer fails the step, to be tried again", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", {
      ".smithers/factory.json": manifest([{ on: "cron", flow: "nightly", cron: "0 3 * * *" }]),
      ".smithers/flows/nightly/flow.ts": FLOW,
    })
    const { services } = await scheduled(github, { store: TriggerStore.layerNoop() })
    const registered = await at(T0, Cron.steps(services).register({ request: request() }))
    expect(registered).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/ci/ScheduleUnavailable", reason: "unavailable" } })
  })
})

/** A repository whose default branch declares `rows`, every flow merged; answers the branch's head. */
const declared = (github: ScriptedGitHub, rows: ReadonlyArray<{ readonly flow: string; readonly cron: string; readonly overlap?: string }>) =>
  github.push("main", {
    ".smithers/factory.json": manifest(rows.map((row) => ({ on: "cron", ...row }))),
    ...Object.fromEntries(rows.map((row) => [`.smithers/flows/${row.flow}/flow.ts`, FLOW])),
  })

const runRows = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly execution: string; readonly flow: string; readonly sha: string; readonly ref: string; readonly event: string; readonly status: string }>`
      SELECT execution, flow, sha, ref, event, status FROM runs WHERE execution IS NOT NULL ORDER BY created_at, execution`))

describe("triggers/Tick's steps", { timeout: 60_000 }, () => {
  test("a first tick fires nothing; the next fires the minute passed once, as a schedule run of the default branch's head", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const head = declared(github, [{ flow: "every", cron: "* * * * *" }])
    const { services, starts } = await scheduled(github)
    const steps = Cron.steps(services)
    await at(T0, steps.register({ request: request() }))

    expect(await at(T0 + 5_000, steps.since({ from: T0 }))).toEqual(Result.succeed(null))
    expect(await at(T0 + 5_000, steps.fire({ from: T0, since: null }))).toEqual(Result.succeed({ at: T0 + 5_000, watermark: T0 + 5_000 }))
    expect(starts).toEqual([])
    expect(await at(T0 + 65_000, steps.since({ from: T0 + MINUTE }))).toEqual(Result.succeed(T0 + 5_000))

    expect(await at(T0 + 65_000, steps.fire({ from: T0 + MINUTE, since: T0 + 5_000 })))
      .toEqual(Result.succeed({ at: T0 + 65_000, watermark: T0 + 65_000 }))
    // A step tried again with the same `since` fires nothing more: the claim protocol keeps an occurrence to once.
    await at(T0 + 66_000, steps.fire({ from: T0 + MINUTE, since: T0 + 5_000 }))
    const stamp = new Date(T0 + MINUTE).toISOString().slice(0, 16).replace(/[-:]/g, "") + "Z"
    const executionId = Cron.runExecutionId("every", "acme/widgets#every#* * * * *#", stamp)
    expect(starts).toEqual([{
      flow: "repo/Run",
      executionId,
      payload: {
        run: executionId, repo: REPO, flow: "every", sha: head, ref: "refs/heads/main", event: "schedule",
        secrets: true, input: { schedule: "* * * * *" },
      },
    }])
    expect(await runRows()).toEqual([{ execution: executionId, flow: "every", sha: head, ref: "refs/heads/main", event: "schedule", status: "working" }])
    expect(count(Cron.starts, { outcome: "started" })).toBe(1)
    expect(count(Cron.ticks, { outcome: "clean" })).toBe(3)
    expect(messages()).toEqual(expect.arrayContaining(["ci.schedule.since", "ci.schedule.tick", "ci.schedule.start"]))
  })

  test("overlap skip: a minute whose run is still working is skipped; once its row settles, the next one starts", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    declared(github, [{ flow: "every", cron: "* * * * *", overlap: "skip" }])
    const { services, starts } = await scheduled(github)
    const steps = Cron.steps(services)
    await at(T0, steps.register({ request: request() }))
    await at(T0 + 61_000, steps.fire({ from: T0 + MINUTE, since: T0 }))
    await at(T0 + 121_000, steps.fire({ from: T0 + 2 * MINUTE, since: T0 + 61_000 }))
    expect(starts).toHaveLength(1)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE runs SET status = 'done' WHERE execution IS NOT NULL`))
    await at(T0 + 181_000, steps.fire({ from: T0 + 3 * MINUTE, since: T0 + 121_000 }))
    expect(starts).toHaveLength(2)
    expect(await history(services.store)).toEqual([
      [T0 + MINUTE, "completed"],
      [T0 + 2 * MINUTE, "skipped"],
      [T0 + 3 * MINUTE, "launched"],
    ])
  })

  test("a repository taken off the allowlist, or a branch the App can't read, fails its occurrence; nothing starts", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    declared(github, [{ flow: "every", cron: "* * * * *" }])
    const fresh = await freshStore()
    const allowed = await scheduled(github, { store: fresh.store })
    await at(T0, Cron.steps(allowed.services).register({ request: request() }))
    const denied = await scheduled(github, { store: fresh.store, repositories: new Set() })
    await at(T0 + 61_000, Cron.steps(denied.services).fire({ from: T0 + MINUTE, since: T0 }))
    github.contentsGranted = false
    await at(T0 + 121_000, Cron.steps(allowed.services).fire({ from: T0 + 2 * MINUTE, since: T0 + 61_000 }))
    github.contentsGranted = true
    github.refs.delete("main")
    await at(T0 + 181_000, Cron.steps(allowed.services).fire({ from: T0 + 3 * MINUTE, since: T0 + 121_000 }))
    expect([...denied.starts, ...allowed.starts]).toEqual([])
    expect(await runRows()).toEqual([])
    expect(await history(fresh.store)).toEqual([[T0 + MINUTE, "failed"], [T0 + 2 * MINUTE, "failed"], [T0 + 3 * MINUTE, "failed"]])
    expect(count(Cron.starts, { outcome: "not_allowed" })).toBe(1)
    expect(count(Cron.starts, { outcome: "refused" })).toBe(2)
  })

  test("GitHub or the host unavailable leaves the occurrence pending; the next tick starts the same run", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    declared(github, [{ flow: "every", cron: "* * * * *" }])
    let refusals = 1
    const { services, starts } = await scheduled(github, {
      start: () => refusals-- > 0 ? Effect.fail(new Error("the object didn't answer")) : Effect.void,
    })
    const steps = Cron.steps(services)
    await at(T0, steps.register({ request: request() }))
    github.faults.push({ match: (method, path) => method === "GET" && path.includes("/git/ref/heads/"), status: 502 })
    await at(T0 + 61_000, steps.fire({ from: T0 + MINUTE, since: T0 }))
    await at(T0 + 62_000, steps.fire({ from: T0 + MINUTE, since: T0 + 61_000 }))
    expect(starts).toEqual([])
    expect(await runRows()).toEqual([])
    await at(T0 + 63_000, steps.fire({ from: T0 + MINUTE, since: T0 + 62_000 }))
    expect(starts).toHaveLength(1)
    expect(await history(services.store)).toEqual([[T0 + MINUTE, "launched"]])
    expect(count(Cron.starts, { outcome: "unavailable" })).toBe(2)
  })

  test("a start tried again after its row was recorded starts the same run at the commit it recorded", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const first = declared(github, [{ flow: "every", cron: "* * * * *" }])
    const { services, starts } = await scheduled(github)
    const runner = await runtime.runPromise(Cron.runner(services))
    const input = { repo: REPO, flow: "every", defaultBranch: "main", cron: "* * * * *" }
    const key = `acme/widgets#every#* * * * *#:${new Date(T0).toISOString()}`
    const started = await at(T0, runner.start({ flowId: "every", input, idempotencyKey: key }))
    github.push("main", { "README.md": "moved" })
    expect(await at(T0, runner.start({ flowId: "every", input, idempotencyKey: key }))).toEqual(started)
    expect(starts.map((start) => (start.payload as { readonly sha: string }).sha)).toEqual([first, first])
  })

  test("a trigger whose input or key names no scheduled run is refused", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { services, starts } = await scheduled(github)
    const runner = await runtime.runPromise(Cron.runner(services))
    const input = { repo: REPO, flow: "every", defaultBranch: "main", cron: "* * * * *" }
    const keys = [
      [{ repo: REPO }, `t:${new Date(T0).toISOString()}`],
      [input, "x"],
      [input, `t:${"z".repeat(24)}`],
      [input, "t:2026-11-10 03:00:00.000Z"],
    ] as const
    for (const [given, key] of keys) {
      expect(await at(T0, runner.start({ flowId: "every", input: given, idempotencyKey: key })))
        .toMatchObject({ _tag: "Failure", failure: { code: "runner" } })
    }
    expect(starts).toEqual([])
    expect(github.calls).toEqual([])
  })

  test("inspect answers a run's row as the package's run state; cancel stops its execution", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    declared(github, [{ flow: "every", cron: "* * * * *" }])
    let refusals = 1
    const { services, cancels } = await scheduled(github, {
      cancel: () => refusals-- > 0 ? Effect.fail(new Error("the object didn't answer")) : Effect.void,
    })
    const runner = await runtime.runPromise(Cron.runner(services))
    const input = { repo: REPO, flow: "every", defaultBranch: "main", cron: "* * * * *" }
    const runId = await at(T0, runner.start({ flowId: "every", input, idempotencyKey: `t:${new Date(T0).toISOString()}` }))
    const id = Result.getOrThrow(runId)
    const states = []
    for (const status of ["working", "done", "failed", "stopped"]) {
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE runs SET status = ${status} WHERE execution = ${id}`))
      states.push(Result.getOrThrow(await at(T0, runner.inspect(id))))
    }
    states.push(Result.getOrThrow(await at(T0, runner.inspect("unknown:run"))))
    expect(states).toEqual(["active", "completed", "failed", "cancelled", "missing"])
    expect(await at(T0, runner.cancel(id))).toMatchObject({ _tag: "Failure", failure: { code: "runner" } })
    expect(await at(T0, runner.cancel(id))).toEqual(Result.succeed(undefined))
    expect(cancels).toEqual([id])
    const offline = await scheduled(github, { store: TriggerStore.layerNoop() })
    const unreachable = await runtime.runPromise(Cron.runner({ ...offline.services, database: Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("down"))) }))
    expect(await at(T0, unreachable.inspect(id))).toMatchObject({ _tag: "Failure", failure: { code: "runner" } })
  })

  test("a tick that leaves a trigger undispatched fails to be tried again with the same since; a store that fails too", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    declared(github, [{ flow: "every", cron: "* * * * *" }])
    const { services, schema } = await scheduled(github)
    const steps = Cron.steps(services)
    await at(T0, steps.register({ request: request() }))
    // A row the store can't decode: the tick dispatches the rest and keeps its own since as the watermark.
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      INSERT INTO ${sql(schema)}.flows_triggers (trigger_id, flow_id, input_json, cron, overlap, catch_up, max_catch_up, enabled, revision)
      VALUES ('acme/widgets#corrupt#* * * * *#', 'corrupt', 'not json', '* * * * *', 'skip', 'none', 0, 1, 1)`))
    expect(await at(T0 + 61_000, steps.fire({ from: T0 + MINUTE, since: T0 })))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/ci/ScheduleUnavailable", reason: "unclean" } })
    expect(count(Cron.ticks, { outcome: "unclean" })).toBe(1)
    // The registration beside it skips the row it can't read.
    expect(await at(T0 + 62_000, steps.register({ request: request() })))
      .toEqual(Result.succeed({ outcome: "registered", registered: 0, unchanged: 1, disabled: 0, refused: 0 }))

    const offline = Cron.steps({ ...services, store: TriggerStore.layerNoop() })
    expect(await at(T0, offline.since({ from: T0 }))).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
    expect(await at(T0, offline.fire({ from: T0, since: null }))).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
    expect(count(Cron.ticks, { outcome: "failed" })).toBe(1)
  })
})

describe("the tick once a minute", () => {
  test("each alarm in a minute starts its one tick once; a start the host can't record is counted, never thrown", async () => {
    const started: Array<Started> = []
    const recording = Flows.FlowStarter.of({
      start: (flow, { executionId, payload }) => Effect.sync(() => void started.push({ flow: flow._tag, executionId, payload })),
    })
    const unavailable = Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "unreachable" })) })
    await runtime.runPromise(Effect.gen(function* () {
      const tick = yield* Cron.ticker
      yield* TestClock.setTime(T0 + 5_000)
      yield* tick.pipe(Effect.provideService(Flows.FlowStarter, unavailable))
      yield* tick.pipe(Effect.provideService(Flows.FlowStarter, recording))
      yield* tick.pipe(Effect.provideService(Flows.FlowStarter, recording))
    }).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Metric.MetricRegistry, registry)))
    expect(started).toEqual([{ flow: "triggers/Tick", executionId: `triggers/tick:${T0}`, payload: { from: T0, until: T0 + MINUTE } }])
    expect(count(Cron.ticks, { outcome: "not_started" })).toBe(1)
  })
})

describe("triggers/Tick", { timeout: 60_000 }, () => {
  test("ticks from the last heartbeat, starts the minute's run, then sleeps to the window's end", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    declared(github, [{ flow: "every", cron: "* * * * *" }])
    const { services, starts } = await scheduled(github)
    await at(Date.now(), Cron.steps(services).register({ request: request() }))
    // The last tick, a minute and a second ago.
    await at(Date.now() - 61_000, Effect.flatMap(TriggerStore.TriggerStore, (store) => store.heartbeat(Cron.HOST)).pipe(Effect.provide(services.store)))
    const now = Date.now()
    const window = { from: Flows.windowAt(now, Cron.WINDOW).from, until: now + 200 }
    const ran = await runFlow(
      Cron.Tick,
      window,
      ExecutionHost.withSchedules({ flows: [], registration: Layer.empty }, Effect.succeed(services)).registration,
      { executionId: Cron.tickExecutionId(window) },
    )
    expect(ran.exit).toEqual(Exit.void)
    expect(ran.status).toBe("completed")
    expect(starts.map((start) => start.payload)).toEqual([expect.objectContaining({ flow: "every", event: "schedule" })])
  })
})

/** A Durable Object's storage in memory, as worker/ExecutionHost.test.ts keeps one: values cross it by structured clone. */
const memory = () => {
  const values = new Map<string, unknown>()
  const storage: ExecutionHost.Storage = {
    get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
    put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
    delete: (key) => Effect.sync(() => values.delete(key)),
    setAlarm: () => Effect.void,
    deleteAlarm: () => Effect.void,
  }
  return { storage, values }
}

describe("on the execution host", { timeout: 120_000 }, () => {
  test("a registered every-minute row: past a minute boundary, the tick an alarm starts starts repo/Run, event schedule", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const head = declared(github, [{ flow: "every", cron: "* * * * *" }])
    // Each run on its own object, as worker/Executions.ts starts it.
    const runObject = memory()
    const { services } = await scheduled(github)
    const hosted: Cron.Services<unknown, never> = {
      ...services,
      start: (flow, { executionId, payload }) =>
        ExecutionHost.intent(flow, { executionId, payload: payload as never }).pipe(
          Effect.flatMap((intent) => ExecutionHost.recordStart(runObject.storage, intent)),
        ),
    }
    await at(Date.now(), Cron.steps(hosted).register({ request: request() }))
    // The last tick, a minute and a second ago: a minute boundary has passed since.
    await at(Date.now() - 61_000, Effect.flatMap(TriggerStore.TriggerStore, (store) => store.heartbeat(Cron.HOST)).pipe(Effect.provide(services.store)))
    const url = (await Effect.runPromise(TestDatabase.serverUrl)).toString()
    const engine = TestSchemas.schemaName("flows")
    schemas.push(engine)
    const flows = ExecutionHost.withSchedules(
      ExecutionHost.remote({ database: await database(runtime), expiry: Duration.fromInputUnsafe(Expire.DEFAULT_EXPIRY) }),
      Effect.succeed(hosted),
    )
    const tickObject = memory()
    const ticks: Array<string> = []
    const starter = Flows.FlowStarter.of({
      start: (flow, { executionId, payload }) =>
        ExecutionHost.intent(flow, { executionId, payload: payload as never }).pipe(
          Effect.flatMap((intent) => ExecutionHost.recordStart(tickObject.storage, intent)),
          Effect.tap(() => Effect.sync(() => void ticks.push(executionId))),
          Effect.orDie,
        ),
    })
    await Effect.runPromise(Effect.gen(function* () {
      const ticker = yield* Cron.ticker
      const hostFor = (object: ReturnType<typeof memory>, executionId: string) =>
        ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, engine),
          flows,
          router: { start: () => Effect.void, wake: () => Effect.void },
          afterAlarm: ticker.pipe(Effect.provideService(Flows.FlowStarter, starter)),
        })
      // Any execution's alarm starts the minute's tick on the tick's own object.
      const pauseId = uuid()
      const pause = hostFor(memory(), pauseId)
      yield* pause.start(yield* ExecutionHost.intent(Pause.Pause, { executionId: pauseId, payload: { label: "p", pauseMs: 0 } }))
      yield* pause.alarm()
      expect(ticks).toHaveLength(1)
      expect(ticks[0]).toMatch(/^triggers\/tick:\d+$/)
      // The tick's own alarm fires the minute that passed.
      yield* hostFor(tickObject, ticks[0]!).alarm()
    }))
    const intents = [...runObject.values.values()].flatMap((value) => {
      const parsed: unknown = typeof value === "string" ? JSON.parse(value) : undefined
      return typeof parsed === "object" && parsed !== null && "flow" in parsed && parsed.flow === "repo/Run" ? [parsed] : []
    })
    expect(intents).toEqual([expect.objectContaining({
      flow: "repo/Run",
      payload: expect.objectContaining({ repo: REPO, flow: "every", sha: head, event: "schedule", input: { schedule: "* * * * *" } }),
    })])
    expect((await runRows()).map((row) => [row.flow, row.event])).toEqual([["every", "schedule"]])
  })
})
