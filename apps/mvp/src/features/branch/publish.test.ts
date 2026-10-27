// Publish, Update branch, Resync and Compare on the branch page (src/features/branch/publish*.ts,
// docs/features/branch-publish.md#the-branch-page), driven as React drives them: the branch layer's `publishing` actions
// and live queries, read through the page's own view, with no React. The browser's own layer (`appLayer`) on a Node
// device whose engine leads, against ChatApi's real handler: `branch/publish` and `branch/update` run on the device's
// engine through the repository's selected flow to the writes route (worker/github/Api.ts), the publication shape syncs
// through the compose Electric, and the compare route reads the scripted GitHub. No remote host runs here: a test
// settles a write and writes the publication as `branch/Publish` and `branch/Update` would, through the server's own
// store. Unhappy paths: ChatApi's real refusals, this tab's engine behind `EngineFaults`, and a faulty `PullsClient`
// (test.faults-by-injection).
import type { GitHub } from "@smthrs/integrations"
import { Effect, Layer, type ManagedRuntime, Metric, Ref } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import * as Store from "../../../worker/github/Store.ts"
import { shaOf } from "../../../worker/test/branch.ts"
import { EngineFaults } from "../../test/faults"
import { CHATAPI_ORIGIN, member, openFaultyApp, openTestApp, type TabOptions, TestChatApi } from "../../test/chatApi"
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from "../issues/contract"
import { AttentionStore } from "../attention/store"
import { fold as foldWriteNotice } from "../../../worker/github/WriteFeed.ts"
import { Attention } from "../attention/attention"
import { PresenceStore } from "../presence/store"
import { PullsClient, PullsRequestFailed } from "../pulls/api"
import { repoId } from "../repo/contract"
import { Terminal } from "../terminal/terminal"
import { Branch } from "./branch"
import { publishExecutionId, resyncExecutionId, updateExecutionId } from "./contract"
import { publishes, resyncs, updates } from "./metrics"
import { openBranchPage } from "./navigation"
import { compareOf, type PublishBar, publishBarOf } from "./publishView"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long a flow may take on the device's engine, or Electric to deliver a row, on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 60_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: a fresh device's engine, the repository's flow selected and run, and every write synced back. */
const WITHIN = 240_000

const REPO_ID = repoId("octo", "hello")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Maya, a Member signed in with GitHub: her own writes run with her session's token. */
const maya: Actor = { ...member, login: "member", session: crypto.randomUUID() }

/** A faulty `PullsClient`: the real one, its next comparisons failing with the statuses queued in `compare`. */
const faultyPulls = () => {
  const compare: Array<number> = []
  const layer = Layer.effect(
    PullsClient,
    Effect.map(PullsClient, (real) =>
      PullsClient.of({
        merge: real.merge,
        compare: (owner, name, base, head) =>
          Effect.suspend(() => {
            const next = compare.shift()
            return next === undefined ? real.compare(owner, name, base, head) : Effect.fail(new PullsRequestFailed({ status: next }))
          }),
      })),
  ).pipe(Layer.provide(PullsClient.layer({ origin: CHATAPI_ORIGIN, within: "10 seconds" })))
  return { layer, compare }
}

/** The header as a person reads it: the link, each status and button (pressed ones in brackets), the form, the tab. */
const reads = (shown: PublishBar): ReadonlyArray<string> => [
  ...(shown.pull === undefined ? [] : [`#${shown.pull}`]),
  ...(shown.publishStatus === undefined ? [] : [shown.publishStatus]),
  ...(shown.publish ? [shown.publishBusy ? "[Publish]" : "Publish"] : []),
  ...(shown.updateStatus === undefined ? [] : [shown.updateStatus]),
  ...(shown.update ? [shown.updateBusy ? "[Update branch]" : "Update branch"] : []),
  ...(shown.form ? [`form: ${shown.formTitle}${shown.formDescription ? " + description" : ""}`] : []),
  ...(shown.compare ? ["Compare"] : []),
]

type Runtime = ManagedRuntime.ManagedRuntime<AttentionStore | Attention | Branch | TestChatApi | Terminal | PresenceStore, unknown>

/** Maya's device on `runtime`: `octo/hello` has `main` and `feature/one`; the page's queries started as React does. */
const device = async (runtime: Runtime) => {
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  api.branches.github.publish("octo", "hello", {
    defaultBranch: "main",
    branches: { main: shaOf("main"), "feature/one": shaOf("feature/one") },
  })
  const branch = await runtime.runPromise(Effect.service(Branch))
  const attention = await runtime.runPromise(Effect.service(Attention))
  attention.queries.stack.startSyncImmediate()
  attention.queries.feed.startSyncImmediate()
  const { publishing } = branch
  for (const query of [branch.queries.current, ...Object.values(publishing.queries)]) query.startSyncImmediate()
  const sql = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => runtime.runPromise(api.github.run(effect))
  const current = () => branch.queries.current.toArray[0]
  const publication = () => publishing.queries.publication.toArray[0]
  return {
    runtime,
    api,
    attention,
    notices: () => attention.queries.stack.toArray,
    branch,
    actions: publishing.actions,
    publication,
    press: () => publishing.queries.press.toArray[0],
    writes: () => publishing.queries.writes.toArray,
    /** What the header shows Maya, through the page's own view. */
    bar: () =>
      publishBarOf({
        access: current()?.access ?? undefined,
        mode: current()?.mode,
        name: current()?.name ?? "",
        publication: publication(),
        pullTitle: publishing.queries.pullTitle.toArray[0]?.title,
        press: publishing.queries.press.toArray[0],
        writes: publishing.queries.writes.toArray,
      }),
    compare: () => compareOf(publication(), publishing.queries.comparisons.toArray),
    count: (metric: typeof publishes, outcome: string) =>
      runtime.runSync(Metric.value(Metric.withAttributes(metric, { outcome }))).count,
    sql,
    /** The write's status and payload, as ChatApi recorded it. */
    recorded: async (id: string) =>
      (await sql(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly op: string; readonly status: string; readonly via: string; readonly session_id: string | null; readonly payload: Record<string, unknown> }>`
          SELECT op, status, via, session_id, payload FROM github_writes WHERE id = ${id}::uuid`)))[0],
    /** What `branch/Publish` writes once GitHub took the change: the publication, and its write settled with it. */
    published: (branchId: string, writeId: string, base: string, head: string) =>
      sql(Store.settleWrite(writeId, { status: "done", itemNumber: 7, githubId: null }, Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`
          INSERT INTO branch_publications
            (branch_id, repo_id, github_ref, base_ref, base_sha, head_sha, pushed_sha, pr_number, write_id)
          VALUES (${branchId}::uuid, ${REPO_ID}, 'feature/one-0123456789ab', 'main', ${base}, ${head}, ${head}, 7, ${writeId}::uuid)`))),
    /**
     * What `branch/Update` writes: how it ended on the publication, with the write settled done; a conflict refuses the
     * write, then says so on the publication for everyone.
     */
    updated: (branchId: string, writeId: string, state: "up_to_date" | "conflict") => {
      const record = Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`UPDATE branch_publications SET update_state = ${state}, updated_at = now() WHERE branch_id = ${branchId}::uuid`)
      return sql(
        state === "conflict"
          ? Effect.asVoid(Effect.andThen(Store.settleWrite(writeId, { status: "refused", failure: "conflict" }), record))
          : Effect.asVoid(Store.settleWrite(writeId, { status: "done", itemNumber: null, githubId: null }, record)),
      )
    },
  }
}

/** GitHub's pull request 7 as `github/Apply` projects its title: its `items` row. */
const pullIssue = (title: string): GitHub.Issues.Issue => ({
  id: 9_007,
  node_id: "I_7",
  number: 7,
  title,
  body: "Why",
  state: "open",
  state_reason: null,
  user: { id: 1, login: "member" },
  comments: 0,
  created_at: "2026-10-25T10:00:00Z",
  updated_at: "2026-10-25T10:00:00Z",
  closed_at: null,
  labels: [],
  pull_request: {},
})

const open = (options: TabOptions = {}, actor: Actor = maya) =>
  device(openTestApp(options, { actor, forge: "code-storage" }))

describe("Publish", () => {
  test("Maya publishes: Publishing… while her write is on its way, then the pull request's link, Compare and Update branch", async () => {
    const tab = await open()
    // Nothing to press before the page shows a branch.
    expect(await tab.actions.publish("Add a line", "")).toBe(false)
    expect(await tab.actions.update()).toBe(false)
    await tab.actions.openForm()
    await tab.actions.closeForm()
    expect(tab.press()).toBeUndefined()

    const branchId = (await tab.branch.actions.open("octo", "hello", "feature/one"))!
    await tab.actions.show(branchId)
    expect(reads(tab.bar())).toEqual(["Publish"])
    await tab.actions.openForm()
    await until(() => expect(reads(tab.bar())).toEqual(["form: feature/one + description"]))
    await tab.actions.closeForm()
    await until(() => expect(reads(tab.bar())).toEqual(["Publish"]))
    await tab.actions.openForm()

    // A blank title, or one or a description over GitHub's limits, presses nothing and keeps the form.
    expect(await tab.actions.publish("   ", "")).toBe(false)
    expect(await tab.actions.publish("x".repeat(MAX_TITLE_LENGTH + 1), "")).toBe(false)
    expect(await tab.actions.publish("Add a line", "x".repeat(MAX_BODY_LENGTH + 1))).toBe(false)
    expect(tab.press()).toMatchObject({ form: true, publishing: false })

    expect(await tab.actions.publish("  Add a line ", "Why it helps")).toBe(true)
    const writeId = tab.press()!.publishWriteId!
    expect(writeId).toMatch(UUID)
    expect(tab.press()).toMatchObject({ form: false, publishing: false, publishRefused: null })
    expect(await tab.recorded(writeId)).toMatchObject({
      op: "branch/publish",
      status: "pending",
      via: "person",
      session_id: maya.session,
      payload: expect.objectContaining({ branchId, title: "Add a line", body: "Why it helps" }),
    })
    expect(tab.api.github.starts.map((start) => start.executionId)).toContain(publishExecutionId(writeId))
    await until(() => expect(tab.writes()).toEqual([expect.objectContaining({ id: writeId, op: "branch/publish", status: "pending" })]))
    expect(reads(tab.bar())).toEqual(["Publishing…", "[Publish]"])
    await until(() => expect(tab.notices()).toContainEqual(expect.objectContaining({ id: `write:${writeId}`, state: "working", detail: "Publish", local: undefined })), 5_000)
    expect(await tab.sql(foldWriteNotice(writeId))).toBe(0)

    // A second press while hers is on its way: ChatApi refuses it, and the page still says where hers is.
    expect(await tab.actions.publish("Again", "")).toBe(true)
    expect(tab.press()).toMatchObject({ publishWriteId: null, publishRefused: "exists" })
    expect(reads(tab.bar())).toEqual(["Publishing…", "[Publish]"])
    expect([tab.count(publishes, "sent"), tab.count(publishes, "exists")]).toEqual([1, 1])

    // branch/Publish settles: the write and the publication together; the pull request's title syncs as its item.
    const base = tab.api.github.scripted.refs.get("main")!
    const head = tab.api.github.scripted.push("feature/one-0123456789ab", { "README.md": "# Widgets\n\nA line\n" })
    await tab.published(branchId, writeId, base, head)
    await until(() => expect(reads(tab.bar())).toEqual(["#7", "Publish", "Update branch", "Compare"]))
    expect(tab.publication()).toMatchObject({ branchId, baseSha: base, headSha: head, prNumber: 7, updateState: null })
    await until(() => expect(tab.attention.queries.feed.toArray).toContainEqual(expect.objectContaining({ id: `write:${writeId}`, state: "done", href: "/octo/hello/tree/feature/one" })))

    // Publish again pushes new changes as one commit: its form asks only for the title, the pull request's once known.
    await tab.actions.openForm()
    await until(() => expect(reads(tab.bar())).toEqual(["#7", "Update branch", "form: feature/one", "Compare"]))
    await tab.sql(Store.upsertIssue(REPO_ID, pullIssue("Add a line"), Date.now()))
    await until(() => expect(reads(tab.bar())).toEqual(["#7", "Update branch", "form: Add a line", "Compare"]))
    // The title is its repository's issues' (decision 0079 slice 1b), opened by the publication though no issues page
    // was: renamed on GitHub, the form follows.
    await tab.sql(Store.upsertIssue(REPO_ID, pullIssue("Add two lines"), Date.now()))
    await until(() => expect(reads(tab.bar())).toEqual(["#7", "Update branch", "form: Add two lines", "Compare"]))
    // Deleted on GitHub, the pull request's title is forgotten: the form falls back to the branch's name.
    await tab.sql(Store.tombstoneIssue(REPO_ID, 7, Date.now()))
    await until(() => expect(reads(tab.bar())).toEqual(["#7", "Update branch", "form: feature/one", "Compare"]))
    await tab.actions.closeForm()
  }, WITHIN)

  test("Update branch: Updating… while its write is on its way, then Up to date; a conflict says Conflict", async () => {
    const tab = await open()
    const branchId = (await tab.branch.actions.open("octo", "hello", "feature/one"))!
    await tab.actions.show(branchId)
    expect(await tab.actions.publish("Add a line", "")).toBe(true)
    const writeId = tab.press()!.publishWriteId!
    const base = tab.api.github.scripted.refs.get("main")!
    await tab.published(branchId, writeId, base, tab.api.github.scripted.push("feature/one-0123456789ab", { "A.md": "a\n" }))
    await until(() => expect(reads(tab.bar())).toEqual(["#7", "Publish", "Update branch", "Compare"]))

    expect(await tab.actions.update()).toBe(true)
    const first = tab.press()!.updateWriteId!
    expect(first).toMatch(UUID)
    expect(await tab.recorded(first)).toMatchObject({ op: "branch/update", status: "pending", payload: expect.objectContaining({ branchId }) })
    expect(tab.api.github.starts.map((start) => start.executionId)).toContain(updateExecutionId(first))
    await until(() => expect(reads(tab.bar())).toEqual(["#7", "Publish", "Updating…", "[Update branch]", "Compare"]))
    await until(() => expect(tab.notices()).toContainEqual(expect.objectContaining({ id: `write:${first}`, state: "working", detail: "Update branch" })))
    await tab.updated(branchId, first, "up_to_date")
    await until(() => expect(reads(tab.bar())).toEqual(["#7", "Publish", "Up to date", "Update branch", "Compare"]))

    expect(await tab.actions.update()).toBe(true)
    const second = tab.press()!.updateWriteId!
    await until(() => expect(tab.writes().find((write) => write.id === second)?.status).toBe("pending"))
    await tab.updated(branchId, second, "conflict")
    await until(() => expect(reads(tab.bar())).toEqual(["#7", "Publish", "Conflict", "Update branch", "Compare"]))
    // The write's refusal and the publication's state commit together, but sync on their own shapes.
    await until(() => expect(tab.publication()).toMatchObject({ updateState: "conflict" }))
    expect(tab.count(updates, "sent")).toBe(2)
    await until(() => expect(tab.attention.queries.feed.toArray).toContainEqual(expect.objectContaining({ id: `write:${second}`, state: "failed", detail: "Update branch" })))
  }, WITHIN)

  test("Resync: Behind once published, Resyncing… while its write is on its way, a conflict's files, then nothing", async () => {
    const tab = await open()
    const branchId = (await tab.branch.actions.open("octo", "hello", "feature/one"))!
    await tab.actions.show(branchId)
    expect(await tab.actions.publish("Add a line", "")).toBe(true)
    const writeId = tab.press()!.publishWriteId!
    const base = tab.api.github.scripted.refs.get("main")!
    const head = tab.api.github.scripted.push("feature/one-0123456789ab", { "A.md": "a\n" })
    await tab.published(branchId, writeId, base, head)
    // The working copy hasn't reached the head the Publish made.
    await until(() => expect(tab.bar()).toMatchObject({ resync: true, resyncBusy: false, resyncStatus: "Behind" }))

    expect(await tab.actions.resync()).toBe(true)
    const first = tab.press()!.resyncWriteId!
    expect(first).toMatch(UUID)
    expect(await tab.recorded(first)).toMatchObject({ op: "branch/resync", status: "pending", payload: { op: "branch/resync", branchId } })
    expect(tab.api.github.starts.map((start) => start.executionId)).toContain(resyncExecutionId(first))
    await until(() => expect(tab.bar()).toMatchObject({ resyncBusy: true, resyncStatus: "Resyncing…" }))
    // A second press while the first is on its way: the route keeps one Resync of a branch at a time.
    expect(await tab.actions.resync()).toBe(true)
    expect(tab.press()).toMatchObject({ resyncWriteId: null, resyncRefused: "exists" })
    // branch/Resync finds a file both sides changed: the write refused, the files on the publication.
    await tab.sql(Effect.andThen(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`UPDATE branch_publications SET sync_state = 'conflict', sync_conflicts = '["README.md"]'::jsonb, updated_at = now()
          WHERE branch_id = ${branchId}::uuid`),
      Store.settleWrite(first, { status: "refused", failure: "conflict" }),
    ))
    await until(() => expect(tab.bar().resyncStatus).toBe("Conflict · README.md"))

    expect(await tab.actions.resync()).toBe(true)
    const second = tab.press()!.resyncWriteId!
    await until(() => expect(tab.writes().find((write) => write.id === second)?.status).toBe("pending"))
    await tab.sql(Store.settleWrite(second, { status: "done", itemNumber: 7, githubId: null }, Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE branch_publications SET synced_sha = ${head}, sync_state = 'synced', sync_conflicts = NULL, updated_at = now()
        WHERE branch_id = ${branchId}::uuid`)))
    await until(() => expect(tab.bar()).toMatchObject({ resync: true, resyncBusy: false, resyncStatus: undefined }))
    expect(tab.publication()).toMatchObject({ syncedSha: head, syncState: "synced", syncConflicts: null })
    expect(tab.count(resyncs, "sent")).toBe(2)
    expect(tab.count(resyncs, "exists")).toBe(1)

    // While a Publish again is on its way, Resync waits for it: refused, and the page says so.
    expect(await tab.actions.publish("Two", "")).toBe(true)
    await until(() => expect(tab.writes().some((write) => write.op === "branch/publish" && write.status === "pending")).toBe(true))
    expect(await tab.actions.resync()).toBe(true)
    expect(tab.press()).toMatchObject({ resyncRefused: "exists" })
    expect(tab.bar().resyncStatus).toBe("Couldn't resync")
  }, WITHIN)

  test("a Publish GitHub refuses says why, with Publish available again; the next press starts a new write", async () => {
    const tab = await open()
    const branchId = (await tab.branch.actions.open("octo", "hello", "feature/one"))!
    await tab.actions.show(branchId)
    expect(await tab.actions.publish("Add a line", "")).toBe(true)
    const first = tab.press()!.publishWriteId!
    await until(() => expect(tab.writes()).toEqual([expect.objectContaining({ id: first, status: "pending" })]))
    // branch/Publish finds nothing changed in the working copy.
    await tab.sql(Store.settleWrite(first, { status: "refused", failure: "empty_change" }))
    await until(() => expect(reads(tab.bar())).toEqual(["No changes", "Publish"]))

    expect(await tab.actions.publish("Add a line", "")).toBe(true)
    const second = tab.press()!.publishWriteId!
    expect(second).not.toBe(first)
    await until(() => expect(tab.writes().find((write) => write.id === second)?.status).toBe("pending"))
    expect(reads(tab.bar())).toEqual(["Publishing…", "[Publish]"])
    expect(tab.count(publishes, "sent")).toBe(2)
  }, WITHIN)

  test("a press while this tab's last one runs presses nothing; one its engine can't run says Couldn't publish or update", async () => {
    const runtime = openFaultyApp({}, undefined, { actor: maya, forge: "code-storage" })
    const tab = await device(runtime)
    const engine = await runtime.runPromise(Effect.service(EngineFaults))
    // No branch shown yet: nothing to resync.
    expect(await tab.actions.resync()).toBe(false)
    const branchId = (await tab.branch.actions.open("octo", "hello", "feature/one"))!
    await tab.actions.show(branchId)

    // Held until the engine records it, as while its worker loads: Publishing…, and a second press presses nothing.
    await runtime.runPromise(engine.holdStarts)
    const publishing = tab.actions.publish("Add a line", "")
    await until(() => expect(tab.press()).toMatchObject({ publishing: true }))
    expect(reads(tab.bar())).toEqual(["Publishing…", "[Publish]"])
    expect(await tab.actions.publish("Again", "")).toBe(false)
    await until(() => expect(tab.notices()).toContainEqual(expect.objectContaining({ state: "waiting", detail: "Publish", local: true })))
    const launch = tab.notices().find((entry) => entry.local === true)!
    tab.attention.actions.open(launch.id, "page")
    const notices = await runtime.runPromise(Effect.service(AttentionStore))
    expect(notices.pending.tanstack.size).toBe(0)
    const updating = tab.actions.update()
    await until(() => expect(tab.press()).toMatchObject({ updating: true }))
    expect(await tab.actions.update()).toBe(false)
    await until(() => expect(tab.notices()).toContainEqual(expect.objectContaining({ state: "waiting", detail: "Update branch" })))
    const resyncing = tab.actions.resync()
    await until(() => expect(tab.press()).toMatchObject({ resyncing: true }))
    expect(await tab.actions.resync()).toBe(false)
    await runtime.runPromise(engine.releaseStarts)
    expect(await publishing).toBe(true)
    expect(await updating).toBe(true)
    expect(await resyncing).toBe(true)

    await runtime.runPromise(engine.refuseStarts("branch/resync"))
    expect(await tab.actions.resync()).toBe(true)
    expect(tab.press()).toMatchObject({ resyncing: false, resyncRefused: "unavailable", resyncWriteId: null })
    expect(tab.count(resyncs, "unavailable")).toBe(1)

    await runtime.runPromise(Effect.andThen(engine.refuseStarts("branch/publish"), engine.refuseStarts("branch/update")))
    expect(await tab.actions.publish("Add a line", "")).toBe(true)
    expect(tab.press()).toMatchObject({ publishRefused: "unavailable" })
    expect(await tab.actions.update()).toBe(true)
    expect(tab.press()).toMatchObject({ updateRefused: "unavailable", updateWriteId: null })
    expect([tab.count(publishes, "unavailable"), tab.count(updates, "unavailable")]).toEqual([1, 1])
    await until(() => expect(tab.notices().filter((entry) => entry.state === "failed").map((entry) => entry.detail)).toEqual(expect.arrayContaining(["Publish", "Update branch"])))
  }, WITHIN)
})

describe("Compare", () => {
  test("reads the publication's base and head: the commits, then each file; Couldn't load when the read fails, and again on the next", async () => {
    const pulls = faultyPulls()
    const tab = await open({ replace: pulls.layer })
    const branchId = (await tab.branch.actions.open("octo", "hello", "feature/one"))!
    const scripted = tab.api.github.scripted
    const base = scripted.refs.get("main")!
    const head = scripted.push("feature/one-0123456789ab", { "README.md": "# Widgets\n\nA line\n" })
    await tab.actions.show(branchId)
    expect(await tab.actions.publish("Add a line", "")).toBe(true)
    await tab.published(branchId, tab.press()!.publishWriteId!, base, head)
    await until(() => expect(tab.publication()).toMatchObject({ headSha: head }))
    // Without ?compare nothing is read.
    expect(tab.compare()).toEqual({ kind: "loading" })

    pulls.compare.push(503)
    await tab.actions.show(branchId, true)
    await until(() => expect(tab.compare()).toEqual({ kind: "failed", title: "Couldn't load" }))
    await tab.actions.show(branchId, true)
    await until(() =>
      expect(tab.compare()).toEqual({
        kind: "ready",
        commits: [{ sha: head, headline: "Update README.md", author: "octocat" }],
        files: [expect.objectContaining({ filename: "README.md", status: "modified", patch: expect.stringContaining("+A line") })],
      })
    )
  }, WITHIN)
})

describe("the branch page's route", () => {
  test("shows only the shown branch's publication, under ?compare reads it, and stops once a newer navigation took over", async () => {
    const tab = await open()
    const terminal = await tab.runtime.runPromise(Effect.service(Terminal))
    const presence = await tab.runtime.runPromise(Effect.service(PresenceStore))
    const params = { owner: "octo", repo: "hello", ref: "feature/one" }
    await openBranchPage(tab.branch, terminal, new AbortController().signal, params, { compare: true })
    const branchId = tab.branch.queries.current.toArray[0]!.branchId!
    expect(await tab.actions.publish("Add a line", "")).toBe(true)
    const scripted = tab.api.github.scripted
    const base = scripted.refs.get("main")!
    const head = scripted.push("feature/one-0123456789ab", { "B.md": "b\n" })
    await tab.published(branchId, tab.press()!.publishWriteId!, base, head)
    await until(() => expect(tab.compare()).toMatchObject({ kind: "ready", files: [expect.objectContaining({ filename: "B.md" })] }))

    // Another branch's page shows none of it; back on this one, it shows again.
    await tab.actions.show(crypto.randomUUID())
    expect(tab.publication()).toBeUndefined()
    await tab.actions.show(branchId)
    await until(() => expect(tab.publication()).toMatchObject({ prNumber: 7 }))
    await tab.actions.show(null)
    expect(tab.publication()).toBeUndefined()

    // A newer navigation takes over while the publication is shown: the page goes no further.
    const abortingShow = (controller: AbortController) => Branch.of({
      ...tab.branch,
      publishing: {
        ...tab.branch.publishing,
        actions: {
          ...tab.branch.publishing.actions,
          show: async (...args) => {
            await tab.branch.publishing.actions.show(...args)
            controller.abort()
          },
        },
      },
    })
    await tab.branch.presence.actions.at({ view: "edit", path: "sentinel.md" })
    const missing = new AbortController()
    await openBranchPage(abortingShow(missing), terminal, missing.signal, { owner: "", repo: "", ref: "" }, {})
    expect(missing.signal.aborted).toBe(true)
    // It never left the room: the newer page owns it.
    expect(await tab.runtime.runPromise(presence.room.toArray)).toMatchObject([{ branchId }])
    const shown = new AbortController()
    await openBranchPage(abortingShow(shown), terminal, shown.signal, params, {})
    expect(shown.signal.aborted).toBe(true)
    // It never said where the person is: the newer page does.
    expect(await tab.runtime.runPromise(Ref.get(presence.where))).toEqual({ view: "edit", path: "sentinel.md" })

    // Watching someone's terminal: the page goes on to it.
    const watching = new AbortController()
    await openBranchPage(tab.branch, terminal, watching.signal, params, { terminal: "someone-else", compare: true })
    watching.abort()
    await tab.branch.presence.actions.leave()
    await terminal.actions.show(null)
  }, WITHIN)
})
