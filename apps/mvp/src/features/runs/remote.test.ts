import { writeFile } from "node:fs/promises"
import { ShapeSource } from "@smthrs/effect-electric"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserEngine } from "@smthrs/platform-browser"
// Watching a TODO's run on Cloudflare from a tab (ruling TODO-3, docs/features/runs.md#a-run-on-cloudflare): the
// browser's own layer (`appLayer`) on a Node device, against ChatApi's real handler with its remote runs routes
// (worker/RemoteRuns.ts) and the compose Postgres and Electric (src/test/chatApi.ts). The run is the remote host's
// `probe/Pause`, run under a TODO attempt's id by an engine on a schema of its own, as the Durable Object runs a TODO's
// `todo` run: so what the tab reads, and when it reads it again, is what it does for a TODO's run.
import { Effect, Layer, Logger, ManagedRuntime, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { read as telemetry } from "../../test/otlp"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type * as Actor from "../../../worker/Actor.ts"
import { asPerson, nodeDevice, openFaultyTab, openTab, openTestApp, CHATAPI_ORIGIN, TEST_REPOSITORY, TestChatApi } from "../../test/chatApi"
import { ACTIONS_SHAPE_ROUTE, actionRunPath } from "../actions/contract"
import { detailsOf } from "./details"
import { actsOf, hostOf, listRows, missingOf, repoRunRows, repoRunsLoaded, steerOpen, steersOf } from "./page"
import { Runs } from "./runs"
import { REMOTE_RUN_SHAPE_ROUTE, stopRoute } from "./contract"
import { RunSteers } from "./steers"
import { AuthStore } from "../auth/store"
import { role as readRole } from "../repo/actions"
import { RepoStore } from "../repo/store"
import { RunsStore } from "./store"
import { openRun } from "./actions"
import { RemoteRunsClient } from "./api"
import type { CloudRun, Inspection, RepoRunRow, RepoRunsLoaded, RunPage, SteerSending, SteerSent } from "./schema"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>, timeout = 30_000) => vi.waitFor(assertion, { timeout, interval: 25 })

const guest: Actor.Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest", login: "gus" }

/**
 * ChatApi, and a tab of a device of `person` (the Member unless set) showing runs, started as React starts them. With
 * `engine`, the device's engine runs the tab's flows, as a steer needs.
 */
const open = async (person?: string, engine = false) => {
  const app = openTestApp({}, { people: { gus: guest } })
  runtimes.push(app)
  const api = await app.runPromise(Effect.service(TestChatApi))
  const as = person === undefined ? api : asPerson(api, person)
  const revisions = new Map<string, number>()
  let quiet = 0
  const observed = { ...as, fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await as.fetch(input, init)
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === REMOTE_RUN_SHAPE_ROUTE && response.ok) {
      const messages = await response.clone().json() as Array<{ value?: { run_id?: string; revision?: string } }>
      if (url.searchParams.get("live") === "true" && messages.every((message) => message.value === undefined)) quiet += 1
      for (const { value } of messages) if (value?.run_id !== undefined && value.revision !== undefined) {
        revisions.set(value.run_id, Number(value.revision))
      }
    }
    return response
  } }
  const host = engine ? nodeDevice({ agent: as }) : nodeDevice()
  const tab = openTab(observed, { host })
  runtimes.push(tab)
  await tab.runPromise(readRole(...TEST_REPOSITORY.split("/") as [string, string]))
  const runs = await tab.runPromise(Effect.service(Runs))
  for (const query of Object.values(runs.queries)) query.startSyncImmediate()
  return {
    api,
    tab,
    host,
    revision: (runId: string) => revisions.get(runId),
    quiet: () => quiet,
    runs,
    page: () => runs.queries.page.toArray[0]?.page,
    inspection: () => runs.queries.page.toArray[0]?.page.inspection as Inspection | undefined,
    /** How many times ChatApi read a run for a tab. */
    reads: () => api.spans.filter((span) => span.name === "run.inspect").length,
    /** The run's messages to its agent, as its page lists them. */
    steers: () =>
      steersOf(
        runs.queries.page.toArray[0]!.page as RunPage,
        runs.queries.steerSending.toArray as ReadonlyArray<SteerSending>,
        runs.queries.steerSent.toArray as ReadonlyArray<SteerSent>,
      ),
    draft: () => runs.queries.view.toArray[0]?.steerDraft,
  }
}

describe("a TODO's run on Cloudflare", () => {
  test("a subscription warmed before navigation stays live without inventing a route timing attempt", async () => {
    const t = await open()
    const runId = await Effect.runPromise(t.api.remote.todoRun("Warmed feed"))
    // Exercise the store's public follow entry before the route, using real services and memory persistence.
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.layer([Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))])
    const engine = await t.tab.runPromise(Effect.service(BrowserEngine.BrowserEngine))
    const remote = await t.tab.runPromise(Effect.service(RemoteRunsClient))
    const shapes = await t.tab.runPromise(Effect.service(ShapeSource.ShapeSource))
    const runtime = ManagedRuntime.make(RunsStore.layer({ origin: CHATAPI_ORIGIN }).pipe(Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(BrowserEngine.BrowserEngine, engine), Layer.succeed(RemoteRunsClient, remote),
      Layer.succeed(ShapeSource.ShapeSource, shapes),
      Layer.succeed(AuthStore, await t.tab.runPromise(Effect.service(AuthStore))),
      Layer.succeed(RepoStore, await t.tab.runPromise(Effect.service(RepoStore))), Persistence.memory,
      Layer.succeed(FetchHttpClient.Fetch, t.api.fetch),
      logger,
    ))))
    runtimes.push(runtime)
    const store = await runtime.runPromise(Effect.service(RunsStore))
    const run = <A, E>(effect: Effect.Effect<A, E, RunsStore>) => runtime.runPromise(effect.pipe(Effect.provide(logger)))
    const page = () => Option.getOrUndefined(runtime.runSync(store.pages.get(runId)))
    const inspected = () => page()?.inspection as Inspection | undefined
    await run(store.follow(runId))
    await run(store.follow(runId))
    const stages = () => logs.filter((log) => log.message === "run.route.stage").map((log) => log.annotations)
    expect(stages()).toEqual([])

    await run(openRun(runId))
    await until(() => expect(page()?.state).toBe("not_started"), 5_000)
    await Effect.runPromise(t.api.remote.start(runId, { label: "warmed", pauseMs: 0 }))
    await until(() => expect(inspected()?.run.status).toBe("completed"), 5_000)
    expect(inspected()?.steps.filter((step) => step.action === "probe/Mark").map((step) => step.output?.text)).toEqual([
      "\"warmed:before\"", "\"warmed:after\"",
    ])
    // The existing feed belongs to no navigation. Only its reuse gets the new route's clock.
    const changes = stages().filter((stage) => stage.stage === "changes")
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((stage) => stage.phase === "reused")).toBe(true)
  })

  test("it lists among the runs on Cloudflare and moves there live; opened in place, its steps follow it", async () => {
    // The list reads this device's engine too, so the device's engine leads.
    const t = await open(undefined, true)
    const runId = await Effect.runPromise(t.api.remote.todoRun("Listed"))
    await t.runs.actions.openList(runId)
    const listed = () => (t.runs.queries.cloudRuns.toArray as ReadonlyArray<CloudRun>).find((run) => run.runId === runId)
    await until(() => expect(listed()).toMatchObject({ kind: "todo", flow: "todo", status: "pending", trigger: "commit", actor: expect.any(String) }))
    const opened = () => t.runs.queries.expandedPage.toArray[0]?.page as RunPage | undefined
    await until(() => expect(opened()).toMatchObject({ id: runId, state: "not_started" }))

    // The run starts and ends on the engine: its row of the change feed reads the list, and the opened run, again.
    await Effect.runPromise(t.api.remote.start(runId, { label: "listed", pauseMs: 0 }))
    await until(() => expect(listed()?.status).toBe("completed"))
    await until(() => expect((opened()?.inspection as Inspection | undefined)?.run.status).toBe("completed"))
    const { jobs } = detailsOf(opened()!, Date.now())
    expect(jobs[0]!.steps.filter((step) => step.label.endsWith("probe/Mark")).map((step) => step.state)).toEqual(["completed", "completed"])
    // Its row on the list says where it ran and opens its page.
    expect(listRows([], t.runs.queries.cloudRuns.toArray as ReadonlyArray<CloudRun>, { open: runId })[0]).toMatchObject({
      id: runId, where: "Cloud", expanded: true, href: `/app/runs/${encodeURIComponent(runId)}`,
    })
  }, 120_000)

  test("a Member watches it live: Not started, then each step as the run takes it, then done; no polling", async () => {
    const t = await open()
    const runId = await Effect.runPromise(t.api.remote.todoRun("Watch me"))
    await t.runs.actions.openRun(runId)
    await until(() => expect(t.page()).toMatchObject({ id: runId, state: "not_started" }))
    expect(missingOf(t.page()!)).toBe("Not started")

    // The run starts on the engine: its row of the change feed reads the page again, with no request of the tab's own.
    await Effect.runPromise(t.api.remote.start(runId, { label: "watched", pauseMs: 2_000, hold: true }))
    try {
      await until(() => expect(t.page()?.state).toBe("read"))
      await until(() => {
        const steps = t.inspection()!.steps.filter((step) => step.action === "probe/Mark")
        expect(steps.map((step) => step.status)).toContain("completed")
      })
      // Mid-run: one Mark done, the last action held open, the run not settled.
      expect(t.inspection()!.run.status).not.toBe("completed")
      expect(hostOf(t.inspection()!.run.runId)).toBe("Cloud")

      // Hold the last action until its persisted trail has reached this tab.
      await Effect.runPromise(t.api.remote.ready(runId))
      const beforeEligibility = t.page()
      const eligible = await Effect.runPromise(t.api.remote.prepareProgress(runId))
      // The owner's heartbeat (each second) advances the revision too, so the tab may already be past `eligible`.
      await until(() => {
        expect(t.revision(runId)).toBeGreaterThanOrEqual(eligible)
        expect(t.page()).not.toBe(beforeEligibility)
      })
      const beforeProgress = t.reads()
      expect(await Effect.runPromise(t.api.remote.progress(runId))).toBeGreaterThan(1)
      await until(() => {
        expect(t.revision(runId)).toBeGreaterThan(eligible)
        expect(t.inspection()!.journal.events.some((event) => event.eventType === "agent.turn")).toBe(true)
        expect(t.reads()).toBeGreaterThan(beforeProgress)
      })
      expect(t.inspection()!.run.status).not.toBe("completed")

      // The second Mark and the settling arrive the same way.
      await Effect.runPromise(t.api.remote.release(runId))
      await Effect.runPromise(t.api.remote.settled(runId))
      const finalRevision = await Effect.runPromise(t.api.remote.revision(runId))
      await until(() => expect(t.revision(runId)).toBe(finalRevision))
      await until(() => expect(t.inspection()!.run.status).toBe("completed"))
      expect(t.inspection()!.steps.filter((step) => step.action === "probe/Mark").map((step) => step.output?.text)).toEqual([
        "\"watched:before\"",
        "\"watched:after\"",
      ])
      expect(JSON.parse(t.inspection()!.run.result!.text)).toBe("watched:after")

      // Nothing changes now, so nothing reads it again: the tab follows the run, never a clock.
      await until(() => expect(t.page()?.state).toBe("read"))
      // A completed inspection can precede the last Electric update. Wait for the feed's own quiet long-poll
      // response before taking the count, then another quiet response proves a silent feed causes no reads.
      const catchingUp = t.quiet()
      await until(() => expect(t.quiet()).toBeGreaterThan(catchingUp))
      const settled = t.reads()
      const quiet = t.quiet()
      await until(() => expect(t.quiet()).toBeGreaterThan(quiet))
      expect(t.reads()).toBe(settled)
    } finally {
      await Effect.runPromise(t.api.remote.release(runId))
    }
  }, 120_000)

  test("a Member steers it while it works: Sending, then Sent from the run's queue; Not delivered once it ends", async () => {
    const t = await open(undefined, true)
    const runId = await Effect.runPromise(t.api.remote.todoRun("Steer me"))
    await Effect.runPromise(t.api.remote.start(runId, { label: "steered", pauseMs: 4_000 }))
    await t.runs.actions.openRun(runId)
    await until(() => expect(t.page()?.state).toBe("read"))
    expect(steerOpen(t.inspection()!)).toBe(true)

    // Nothing to send yet: Steer on an empty composer does nothing.
    t.runs.actions.steer()
    t.runs.actions.setSteerDraft("  Use tabs, not spaces  ")
    await until(() => expect(t.draft()).toBe("  Use tabs, not spaces  "))
    t.runs.actions.steer()
    // The composer empties at once; the message goes out through the device's outbox to the run's queue.
    await until(() => expect(t.draft()).toBe(""))
    await until(() => expect(t.steers().map((item) => [item.body, item.state])).toEqual([["Use tabs, not spaces", "sent"]]))
    const taken = t.api.spans.filter((span) => span.name === "run.steer")
    expect(taken).toHaveLength(1)
    // Asked again for the same message, as a step run again asks, the tab has it: nothing more is sent.
    const again = await t.tab.runPromise(Effect.flatMap(RunSteers, (steers) =>
      steers.queue({ id: t.steers()[0]!.id, runId, body: "Use tabs, not spaces" })))
    expect(again).toEqual({ kept: true })
    expect(t.api.spans.filter((span) => span.name === "run.steer")).toHaveLength(1)
    // Its next read shows it from the run's own journal, with who sent it.
    await until(() => expect(t.steers()[0]?.by).toBe("person-member"))

    // The run ends with no agent having read it: Not delivered, and the composer goes.
    await until(() => expect(t.inspection()!.run.status).toBe("completed"))
    await until(() => expect(t.steers().map((item) => item.state)).toEqual(["not_delivered"]))
    expect(steerOpen(t.inspection()!)).toBe(false)

    // The agent may still ask after it ended (ruling FLOW-3); ChatApi refuses it, and it reads Not sent with why.
    t.runs.actions.setSteerDraft("Too late")
    await until(() => expect(t.draft()).toBe("Too late"))
    t.runs.actions.steer()
    await until(() =>
      expect(t.steers().map((item) => [item.body, item.state, item.reason])).toEqual([
        ["Use tabs, not spaces", "not_delivered", null],
        ["Too late", "not_sent", "not_working"],
      ])
    )
  }, 120_000)

  test("a steer that can't run says so and gives the words back", async () => {
    const t = await open(undefined, true)
    // Not a TODO's run: run/steer refuses its payload before any step runs.
    await t.runs.actions.openRun("run-not-a-todo")
    t.runs.actions.setSteerDraft("Use tabs")
    await until(() => expect(t.draft()).toBe("Use tabs"))
    t.runs.actions.steer()
    await until(() => expect(t.runs.queries.view.toArray[0]?.refusal).toBe("unavailable"))
    expect(t.draft()).toBe("Use tabs")
    expect(t.api.spans.filter((span) => span.name === "run.steer")).toHaveLength(0)
  }, 60_000)

  test("a Guest can't watch it: the page reads Not found, and the run is never read for them", async () => {
    const t = await open("gus")
    const runId = await Effect.runPromise(t.api.remote.todoRun("Not yours"))
    await Effect.runPromise(t.api.remote.start(runId, { label: "private", pauseMs: 0 }))
    await t.runs.actions.openRun(runId)
    await until(() => expect(t.page()).toMatchObject({ id: runId, state: "not_found", inspection: null }))
    expect(missingOf(t.page()!)).toBe("Not found")
  }, 60_000)

  test("a run no TODO started reads Not found", async () => {
    const t = await open()
    // The engine's schema exists, as it does deployed: a run no attempt holds may still be a repository's.
    await Effect.runPromise(Effect.exit(t.api.remote.revision("none")))
    const runId = "todo:00000000-0000-4000-8000-000000000000"
    await t.runs.actions.openRun(runId)
    await until(() => expect(t.page()).toMatchObject({ id: runId, state: "not_found" }))
  }, 60_000)
})

describe("a repository's run on Cloudflare", () => {
  test("the list says a repository has no runs only once they have loaded, never while its shape is slow", async () => {
    // Production on 2026-10-25: the actions shape took longer than the page waited, and the list said "No runs yet"
    // for a repository whose run Electric already held.
    const app = openTestApp()
    runtimes.push(app)
    const api = await app.runPromise(Effect.service(TestChatApi))
    const tab = openFaultyTab(api)
    runtimes.push(tab)
    const faults = await tab.runPromise(Effect.service(ShapeSource.Faults))
    await tab.runPromise(readRole(...TEST_REPOSITORY.split("/") as [string, string]))
    // The tab's own store, over its faulty shape source, with its log lines collected.
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const runtime = ManagedRuntime.make(RunsStore.layer({ origin: CHATAPI_ORIGIN }).pipe(Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(BrowserEngine.BrowserEngine, await tab.runPromise(Effect.service(BrowserEngine.BrowserEngine))),
      Layer.succeed(RemoteRunsClient, await tab.runPromise(Effect.service(RemoteRunsClient))),
      Layer.succeed(ShapeSource.ShapeSource, await tab.runPromise(Effect.service(ShapeSource.ShapeSource))),
      Layer.succeed(AuthStore, await tab.runPromise(Effect.service(AuthStore))),
      Layer.succeed(RepoStore, await tab.runPromise(Effect.service(RepoStore))),
      Persistence.memory,
      Layer.succeed(FetchHttpClient.Fetch, api.fetch),
      Logger.layer([Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))]),
    ))))
    runtimes.push(runtime)
    const store = await runtime.runPromise(Effect.service(RunsStore))
    store.repoRunsLoaded.tanstack.startSyncImmediate()
    store.repoRunList.tanstack.startSyncImmediate()
    const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]
    const loaded = () => repoRunsLoaded(store.repoRunsLoaded.tanstack.toArray as ReadonlyArray<RepoRunsLoaded>, owner, name)
    await tab.runPromise(faults.stall())
    await runtime.runPromise(store.openRepoRuns(owner, name))
    // Electric's answer to the repository's shape is held, as on a slow link: nothing has loaded, so nothing is said.
    await until(async () => expect((await tab.runPromise(faults.sent)).some((url) => url.pathname === ACTIONS_SHAPE_ROUTE)).toBe(true))
    expect(loaded()).toBe(false)
    expect(logs.filter((log) => log.message === "run.route.stage").map((log) => log.annotations.phase)).toEqual(["start", "start", "ready"])
    await tab.runPromise(faults.heal)
    await until(() => expect(loaded()).toBe(true))
    expect(repoRunRows(store.repoRunList.tanstack.toArray as ReadonlyArray<RepoRunRow>, owner, name)).toEqual([])
    await until(() => expect(logs.filter((log) => log.message === "run.route.stage").at(-1)?.annotations)
      .toMatchObject({ stage: "repo-runs", phase: "loaded", rows: 0 }))
  }, 60_000)

  test("a second repository's run syncs live to its device list and remains watchable", async () => {
    const t = await open(undefined, true)
    const ownRun = await Effect.runPromise(t.api.remote.repoRun("own"))
    const runId = await Effect.runPromise(t.api.remote.repoRun("ci"))
    await Effect.runPromise(t.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.gen(function* () {
      yield* sql`UPDATE runs SET repo_id = 'github/elsewhere/project' WHERE execution = ${runId}`
      yield* sql`INSERT INTO github_repo_roles (repo_id, person_id, role)
        VALUES ('github/elsewhere/project', 'person-member', 'member')`
    }))))
    await t.runs.actions.openRepoRuns("octo", "hello")
    await until(() => expect(repoRunRows(t.runs.queries.repoRuns.toArray as ReadonlyArray<RepoRunRow>, "octo", "hello"))
      .toEqual([expect.objectContaining({ href: actionRunPath("octo", "hello", ownRun) })]))
    await t.tab.runPromise(readRole("elsewhere", "project"))
    await t.runs.actions.openRepoRuns("elsewhere", "project")
    const listed = () => repoRunRows(t.runs.queries.repoRuns.toArray as ReadonlyArray<RepoRunRow>, "elsewhere", "project")
    await until(() => expect(listed()).toEqual([
      expect.objectContaining({ flow: "ci · main", state: "running", href: actionRunPath("elsewhere", "project", runId) }),
    ]))
    await t.runs.actions.openRepoRuns("ELSEWHERE", "PROJECT")
    await t.runs.actions.openRun(runId, { owner: "elsewhere", name: "project" })
    await until(() => expect(t.page()).toMatchObject({ id: runId, state: "not_started" }))
    await Effect.runPromise(t.api.remote.start(runId, { label: "ci", pauseMs: 60_000 }))
    await until(() => expect(t.inspection()?.run.status).toBe("suspended"))
    t.runs.actions.stop()
    await until(() => expect(t.inspection()?.run.status).toBe("cancelled"))
    await Effect.runPromise(t.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE runs SET status = 'stopped' WHERE execution = ${runId}`)))
    await until(() => expect(listed()).toEqual([expect.objectContaining({ state: "cancelled" })]))
    // Reload the device from the same SQLite store, with fresh collections and subscriptions.
    await t.tab.dispose()
    const reloaded = openTab(t.api, { host: t.host })
    runtimes.push(reloaded)
    await reloaded.runPromise(readRole("elsewhere", "project"))
    const runs = await reloaded.runPromise(Effect.service(Runs))
    for (const query of Object.values(runs.queries)) query.startSyncImmediate()
    await runs.actions.openRepoRuns("elsewhere", "project")
    await until(() => expect(repoRunRows(runs.queries.repoRuns.toArray as ReadonlyArray<RepoRunRow>, "elsewhere", "project"))
      .toEqual([expect.objectContaining({ state: "cancelled", href: actionRunPath("elsewhere", "project", runId) })]))
    await runs.actions.openRun(runId, { owner: "elsewhere", name: "project" })
    await until(() => expect(runs.queries.page.toArray[0]?.page.inspection).toMatchObject({ run: { status: "cancelled" } }))
    await Effect.runPromise(t.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`DELETE FROM runs WHERE execution = ${runId}`)))
    await until(() => expect(repoRunRows(runs.queries.repoRuns.toArray as ReadonlyArray<RepoRunRow>, "elsewhere", "project")).toEqual([]))
  }, 120_000)

  test.each([null, "guest"])("the deployment's Member role grants no access to a second repository's run with role %s", async (role) => {
    const t = await open()
    const runId = await Effect.runPromise(t.api.remote.repoRun("ci"))
    await Effect.runPromise(t.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.gen(function* () {
      yield* sql`UPDATE runs SET repo_id = 'github/elsewhere/private' WHERE execution = ${runId}`
      yield* sql`INSERT INTO github_repo_roles (repo_id, person_id, role)
        VALUES ('github/elsewhere/private', 'person-member', ${role})`
    }))))
    await t.runs.actions.openRun(runId, { owner: "elsewhere", name: "private" })
    await until(() => expect(t.page()).toMatchObject({ id: runId, state: "not_found" }))
    expect((await t.api.fetch(`${CHATAPI_ORIGIN}${REMOTE_RUN_SHAPE_ROUTE}?run=${encodeURIComponent(runId)}&offset=-1`)).status).toBe(403)
    expect((await t.api.fetch(`${CHATAPI_ORIGIN}${stopRoute(runId)}`, { method: "POST" })).status).toBe(404)
    expect((await t.api.fetch(`${CHATAPI_ORIGIN}${ACTIONS_SHAPE_ROUTE}?repo=elsewhere%2Fprivate&offset=-1`)).status).toBe(role === null ? 403 : 200)
  }, 60_000)

  test("a Member on the run's repository can watch even with a Guest session role on the deployment", async () => {
    const t = await open("gus")
    const runId = await Effect.runPromise(t.api.remote.repoRun("ci"))
    await Effect.runPromise(t.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.gen(function* () {
      yield* sql`UPDATE runs SET repo_id = 'github/elsewhere/project' WHERE execution = ${runId}`
      yield* sql`INSERT INTO github_repo_roles (repo_id, person_id, role)
        VALUES ('github/elsewhere/project', 'person-guest', 'member')`
    }))))
    await t.runs.actions.openRun(runId, { owner: "elsewhere", name: "project" })
    await until(() => expect(t.page()).toMatchObject({ id: runId, state: "not_started" }))
    expect((await asPerson(t.api, "gus").fetch(`${CHATAPI_ORIGIN}${REMOTE_RUN_SHAPE_ROUTE}?run=${encodeURIComponent(runId)}&offset=-1`)).status).toBe(200)
  }, 60_000)

  test("a Member finds it in the repository's runs, watches it on its page, and stops it there", async () => {
    const t = await open(undefined, true)
    const runId = await Effect.runPromise(t.api.remote.repoRun("ci"))
    const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]

    // The list: Electric's rows of the repository's runs, each opening its page.
    await t.runs.actions.openRepoRuns(owner, name)
    await until(() =>
      expect(repoRunRows(t.runs.queries.repoRuns.toArray as ReadonlyArray<RepoRunRow>, owner, name)).toEqual([
        expect.objectContaining({ flow: "ci · main", state: "running", href: actionRunPath(owner, name, runId) }),
      ])
    )

    await t.runs.actions.openRun(runId, { owner, name })
    await until(() => expect(t.page()).toMatchObject({ id: runId, state: "not_started" }))
    await Effect.runPromise(t.api.remote.start(runId, { label: "ci", pauseMs: 60_000 }))
    await until(() => expect(t.inspection()?.run.status).toBe("suspended"))
    expect(hostOf(runId, true)).toBe("Cloud")
    expect(actsOf(t.inspection()!, Date.now(), undefined, true)).toEqual({ stop: true, retry: false, resume: false })

    // Stop: run/cancel on this device's engine, which asks ChatApi, whose object stops the run; the page follows it.
    t.runs.actions.stop()
    await until(() => expect(t.inspection()?.run.status).toBe("cancelled"))
    expect(await Effect.runPromise(t.api.remote.status(runId))).toBe("cancelled")
    expect(t.runs.queries.view.toArray[0]?.refusal).toBeNull()
    expect(t.api.spans.filter((span) => span.name === "run.stop")).toHaveLength(1)

    // A row gone from the repository's runs leaves the list; opening it again syncs nothing twice.
    await t.runs.actions.openRepoRuns(owner, name)
    await Effect.runPromise(t.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`DELETE FROM runs WHERE execution = ${runId}`)))
    await until(() => expect(repoRunRows(t.runs.queries.repoRuns.toArray as ReadonlyArray<RepoRunRow>, owner, name)).toEqual([]))
  }, 120_000)

  test("a job it started is followed too: the job's progress reads the run again", async () => {
    const t = await open()
    const runId = await Effect.runPromise(t.api.remote.repoRun("ci"))
    await Effect.runPromise(t.api.remote.start(runId, { label: "job", pauseMs: 0, hold: true, nested: true }))
    try {
      await Effect.runPromise(t.api.remote.ready(runId))
      await t.runs.actions.openRun(runId, { owner: "octo", name: "hello" })
      // The job holds its last step: the page shows it running under the run.
      await until(() => expect(t.page()?.descendants?.map((child) => (child as Inspection).run.status)).toEqual(["running"]))
      const reads = t.reads()
      await Effect.runPromise(t.api.remote.release(runId))
      // The job's own row moves first; the run's page reads it, and of its jobs, that one.
      await until(() => expect(t.inspection()?.run.status).toBe("completed"))
      await until(() => expect(t.page()?.descendants?.map((child) => (child as Inspection).run.status)).toEqual(["completed"]))
      expect(t.reads()).toBeGreaterThan(reads)
    } finally {
      await Effect.runPromise(t.api.remote.release(runId))
    }
  }, 120_000)

  test("a job opened from its run's page follows on its own page, with no Stop of its own", async () => {
    const t = await open()
    const runId = await Effect.runPromise(t.api.remote.repoRun("ci"))
    await Effect.runPromise(t.api.remote.start(runId, { label: "own", pauseMs: 0, hold: true, nested: true }))
    try {
      await Effect.runPromise(t.api.remote.ready(runId))
      await t.runs.actions.openRun(runId, { owner: "octo", name: "hello" })
      await until(() => expect(t.page()?.descendants).toHaveLength(1))
      const jobId = (t.page()!.descendants![0] as Inspection).run.runId
      t.runs.actions.closeRun(runId)
      await t.runs.actions.openRun(jobId, { owner: "octo", name: "hello" })
      await until(() => expect(t.inspection()?.run).toMatchObject({ runId: jobId, status: "running", parentRunId: runId }))
      expect(actsOf(t.inspection()!, Date.now(), undefined, true).stop).toBe(false)
      await Effect.runPromise(t.api.remote.release(runId))
      // The job's change reads the job's own page, through the subscription its run's page made.
      await until(() => expect(t.inspection()?.run).toMatchObject({ runId: jobId, status: "completed" }))
    } finally {
      await Effect.runPromise(t.api.remote.release(runId))
    }
  }, 120_000)

  test("a Guest reads it as Not found and can't stop it", async () => {
    const t = await open("gus")
    const runId = await Effect.runPromise(t.api.remote.repoRun("ci"))
    await Effect.runPromise(t.api.remote.start(runId, { label: "ci", pauseMs: 60_000 }))
    await t.runs.actions.openRun(runId, { owner: "octo", name: "hello" })
    await until(() => expect(t.page()).toMatchObject({ id: runId, state: "not_found" }))
    expect(missingOf(t.page()!, true)).toBe("Not found")
  }, 60_000)
})


test("a real repository run records the route's inspection and first subscribed rows", async () => {
  const t = await open()
  const runId = await Effect.runPromise(t.api.remote.repoRun("ci"))
  await Effect.runPromise(t.api.remote.start(runId, { label: "timed", pauseMs: 0, hold: true, nested: true }))
  try {
    await Effect.runPromise(t.api.remote.ready(runId))
    const started = performance.now()
    await t.runs.actions.openRun(runId, { owner: "octo", name: "hello" })
    const openedMs = performance.now() - started
    t.runs.actions.rendered(runId)
    await until(() => expect(t.page()?.descendants).toHaveLength(1))
    const stages = () => telemetry(t.api.telemetry).logs.filter((log) => log.message === "run.route.stage").map((log) => log.attributes)
    await until(() => expect(stages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "match", phase: "start" }),
      expect.objectContaining({ stage: "inspection", phase: "ready" }),
      expect.objectContaining({ stage: "changes", phase: "rows" }),
      expect.objectContaining({ stage: "render", phase: "ready" }),
    ])))
    if (process.env.RUN_ROUTE_TIMINGS) await writeFile(process.env.RUN_ROUTE_TIMINGS, JSON.stringify({ openedMs, stages: stages() }, null, 2))
    await t.runs.actions.openRun(runId, { owner: "octo", name: "hello" })
    await until(() => expect(stages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "changes", phase: "reused" }),
      expect.objectContaining({ stage: "repo-runs", phase: "reused" }),
    ])))
  } finally {
    await Effect.runPromise(t.api.remote.release(runId))
  }
}, 120_000)
