// Opening a branch's page (decision 0013 §1-§2, docs/features/branch-workspace.md#tracking-a-branch): the browser's own
// layer (`appLayer`) on a Node device whose engine leads, against ChatApi's real `POST /api/branches`
// (worker/branch/Branches.ts, src/test/chatApi.ts) over the compose Postgres and Electric. The forge is GitHub with no
// credential, and GitHub is scripted at the network (worker/test/branch.ts `gitHost`). `branch/track`'s client and step
// are also driven over an injected `fetch` for the answers ChatApi's route never gives a valid request: a body cut
// short, a stalled answer, 400 and 413 (test.faults-by-injection).
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Deferred, Effect, Fiber, FiberHandle, Layer, Logger, Metric, Ref, Stream } from "effect"
import { ConversationOwners } from "../conversations/owners"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.vibe"
import { shaOf } from "../../../worker/test/branch.ts"
import { dispatches } from "../../flows/dispatch.vibe"
import {
  type ChatApiOptions,
  DEVICE_PRINCIPAL,
  failingWorker,
  nodeDevice,
  openTab,
  openTestApp,
  type TabOptions,
  TestChatApi,
} from "../../test/chatApi"
import { capStorage, fillStorage } from "../../test/writeFailure"
import { holdRestore } from "../../test/restoreFailure"
import { CONVERSATION_ID_HEADER, SHAPE_ROUTE } from "../chat/contract"
import { accessPath } from "../conversations/contract"
import { SESSION_ROUTE } from "../auth/contract"
import * as Marks from "../conversations/marks"
import { Auth } from "../auth/auth.vibe"
import { AuthClient } from "../auth/api.vibe"
import { load as loadSession } from "../auth/actions.vibe"
import { open as openBranch } from "./actions.vibe"
import { retry, wentOffline } from "../chat/actions"
import { Chat } from "../chat/chat"
import { BranchClient, TrackRefused } from "./api.vibe"
import { Branch } from "./branch.vibe"
import { BranchStore } from "./store.vibe"
import { openBranchPage } from "./navigation"
import { Terminal } from "../terminal/terminal.vibe"
import { TerminalStore } from "../terminal/store.vibe"
import { StatusStore } from "../status/store"
import { ChatStore } from "../chat/store"
import { Coedit } from "../coedit/coedit.vibe"
import { CoeditStore } from "../coedit/store.vibe"
import { Presence } from "../presence/presence.vibe"
import { PresenceStore } from "../presence/store.vibe"
import { BRANCHES_ROUTE, CONVERSATION_NAMESPACE } from "./contract"
import { BranchTrackRefused, BranchTrackUnavailable } from "./flows"
import { opens, reopens, tracks } from "./metrics"
import { requestTrack, stampOpen } from "./steps.vibe"

/** The home conversation's branch: the deployment repository's `main`, locked, which 0014_branch_workspace records. */
const HOME = { name: "main", mode: "locked" }

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long a flow may take on the device's engine, its first start included, on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: flows on a fresh device's engine, each with its first start, on a loaded machine. */
const WITHIN = 90_000

const conversationOf = (branchId: string) =>
  Effect.runPromise(Uuid.v5(CONVERSATION_NAMESPACE, branchId).pipe(Effect.provide(WebCrypto.layer)))

/** The app on a ChatApi whose GitHub has `octo/hello`, with `main` (its default) and `feature/one`. */
const open = async (options: TabOptions = {}, chatApi: ChatApiOptions = {}) => {
  const runtime = openTestApp(options, chatApi)
  runtimes.push(runtime)
  const branch = await runtime.runPromise(Effect.service(Branch))
  const chat = await runtime.runPromise(Effect.service(Chat))
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  const { conversations: cache } = await runtime.runPromise(Effect.service(BranchStore))
  branch.queries.current.startSyncImmediate()
  chat.queries.place.startSyncImmediate()
  api.branches.github.publish("octo", "hello", {
    defaultBranch: "main",
    branches: { main: shaOf("main"), "feature/one": shaOf("feature/one") },
  })
  return {
    runtime,
    api,
    cache,
    actions: branch.actions,
    current: () => branch.queries.current.toArray[0],
    /** The conversation this tab shows and asks in: a branch's id, or `null` for the home one. */
    place: () => chat.queries.place.toArray[0]?.conversationId,
    /** The branch's rows Postgres holds for `octo/hello`, the deployment's own repository, its home `main` (`HOME`) included. */
    rows: () =>
      runtime.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly name: string; readonly mode: string }>`
          SELECT name, mode FROM branches WHERE repo_id = 'github/octo/hello' ORDER BY name`))),
    opened: (outcome: string) => runtime.runSync(Metric.value(Metric.withAttributes(opens, { outcome }))).count,
    /** Branch pages opened offline that the browser coming back online reopened, or found abandoned. */
    reopens: (outcome: "reopened" | "abandoned") =>
      runtime.runSync(Metric.value(Metric.withAttributes(reopens, { outcome }))).count,
    dispatched: () =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(dispatches, { flow: "branch/track", door: "view", outcome: "done" })),
      ).count,
  }
}

const none = { owner: "", repo: "", name: "", status: "none", branchId: null, conversationId: null, mode: null, access: null }

describe("opening a branch", () => {
  test("tracking at once, then ready with its ids and mode; the tab shows and asks in its conversation", async () => {
    const tab = await open()
    expect(tab.current()).toMatchObject(none)

    const opening = tab.actions.open("octo", "hello", "feature/one")

    // The page renders tracking before anything waits.
    expect(tab.current()).toMatchObject({ owner: "octo", repo: "hello", name: "feature/one", status: "tracking", branchId: null })
    const branchId = await opening
    const conversationId = await conversationOf(branchId!)
    expect(tab.current()).toMatchObject({
      id: "current",
      owner: "octo",
      repo: "hello",
      name: "feature/one",
      status: "ready",
      branchId,
      conversationId,
      mode: "open",
      // Tracking a new branch makes it the person's own, private until they share it.
      access: "owner",
    })
    expect(tab.place()).toBe(conversationId)
    expect(tab.opened("ready")).toBe(1)
    expect(await tab.rows()).toEqual([{ name: "feature/one", mode: "open" }, HOME])

    // The repository's default branch is locked: changes reach it only by merge.
    await tab.actions.open("octo", "hello", "main")
    // The default branch is the team's: everyone in the repository edits it, and nobody owns it.
    expect(tab.current()).toMatchObject({ name: "main", status: "ready", mode: "locked", access: "edit" })
    expect(tab.place()).toBe(tab.current()?.conversationId)

    // Leaving shows the home conversation again.
    await tab.actions.leave()
    expect(tab.current()).toMatchObject(none)
    expect(tab.place()).toBeNull()

    // A branch the app tracks answers at once: GitHub isn't read again, and Postgres keeps one row.
    const reads = tab.api.branches.github.seen.length
    expect(await tab.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    expect(tab.api.branches.github.seen).toHaveLength(reads)
    expect(await tab.rows()).toEqual([{ name: "feature/one", mode: "open" }, { name: "main", mode: "locked" }])
    expect(tab.dispatched()).toBe(3)
  }, WITHIN)

  // The coordinator's ruling 5 on the data gate: a fresh branch's conversation shows nothing until its my-conversations
  // row syncs (fail closed). This measures that wait from the open's start.
  test("a fresh branch's conversation shows once its my-conversations row syncs, within seconds", async () => {
    const tab = await open()
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    owners.shown.tanstack.startSyncImmediate()
    const started = performance.now()
    const branchId = await tab.actions.open("octo", "hello", "feature/one")
    const conversationId = await conversationOf(branchId!)
    await vi.waitFor(() => expect(owners.shown.tanstack.toArray.map((row) => row.conversationId)).toContain(conversationId),
      { timeout: 10_000, interval: 10 })
    const ms = Math.round(performance.now() - started)
    console.log("MINE_DELAY_MS", ms)
    expect(ms).toBeLessThan(10_000)
  }, WITHIN)

  test("another page of the branch the tab shows keeps it ready: nothing unmounts, and ChatApi isn't asked again", async () => {
    const tab = await open()
    const branchId = await tab.actions.open("octo", "hello", "feature/one")
    const shown = tab.current()
    const tracked = tab.dispatched()
    const reads = tab.api.branches.github.seen.length

    // A file in the tree, then another: the page never goes back to tracking, not even for one render.
    const states: Array<string> = []
    const branch = await tab.runtime.runPromise(Effect.service(Branch))
    const watching = branch.queries.current.subscribeChanges((batch) => {
      for (const change of batch) states.push(change.value.status)
    })
    // Owner and repository as GitHub's URLs may spell them.
    expect(await tab.actions.open("Octo", "Hello", "feature/one")).toBe(branchId)
    expect(await tab.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    watching.unsubscribe()

    expect(states).toEqual([])
    expect(tab.current()).toEqual(shown)
    expect(tab.place()).toBe(shown?.conversationId)
    expect(tab.dispatched()).toBe(tracked)
    expect(tab.api.branches.github.seen).toHaveLength(reads)
    expect(tab.opened("kept")).toBe(2)

    // Another branch still tracks, and coming back to the first after it tracks again.
    await tab.actions.open("octo", "hello", "main")
    expect(await tab.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    expect(tab.dispatched()).toBe(tracked + 2)
  }, WITHIN)

  test("an answer that comes after the tab moved on, to another branch or home, isn't shown", async () => {
    const tab = await open()

    // Home before the branch is tracked: its answer leaves the tab at home.
    const left = tab.actions.open("octo", "hello", "feature/one")
    await tab.actions.leave()
    expect(await left).toBeUndefined()
    expect(tab.current()).toMatchObject(none)
    expect(tab.place()).toBeNull()

    // Another branch's page before the first answers: the tab shows the one it moved to.
    const first = tab.actions.open("octo", "hello", "feature/one")
    const second = tab.actions.open("octo", "hello", "main")
    expect(await first).toBeUndefined()
    const mainId = await second
    expect(tab.current()).toMatchObject({ name: "main", status: "ready", branchId: mainId, mode: "locked" })
    expect(tab.place()).toBe(tab.current()?.conversationId)
    expect(tab.opened("ready")).toBe(1)
    // Both were tracked: only showing them waited on the page.
    expect(await tab.rows()).toEqual([{ name: "feature/one", mode: "open" }, { name: "main", mode: "locked" }])
  }, WITHIN)

  test("a name that can't be a branch or a repository, such as a commit's path, is missing and asks nobody", async () => {
    const tab = await open()

    for (const [owner, repo, ref] of [["octo", "hello", "a..b"], ["octo", "hello", ""], ["-octo", "hello", "main"]]) {
      expect(await tab.actions.open(owner!, repo!, ref!)).toBeUndefined()
      expect(tab.current()).toMatchObject({ owner, repo, name: ref, status: "missing", branchId: null, conversationId: null })
    }

    expect(tab.api.branches.github.seen).toEqual([])
    expect(tab.dispatched()).toBe(0)
    // Counted by the dispatch's outcome, which these never had.
    expect(tab.opened("missing")).toBe(0)
    expect(tab.place()).toBeNull()
  }, WITHIN)

  test("a branch GitHub doesn't have is missing, at once: a refusal isn't tried again", async () => {
    const tab = await open()
    await tab.runtime.runPromise(tab.cache.restored)
    await tab.runtime.runPromise(tab.cache.insert({ id: "octo/hello/nope", conversationId: "deleted-conversation" }))

    expect(await tab.actions.open("octo", "hello", "nope")).toBeUndefined()

    expect(tab.current()).toMatchObject({ name: "nope", status: "missing", branchId: null, conversationId: null, mode: null })
    expect(tab.opened("missing")).toBe(1)
    expect(tab.cache.tanstack.has("octo/hello/nope")).toBe(false)
    // One read of the branch, never a second: the flow ended with the refusal.
    expect(tab.api.branches.github.seen.map(({ method, prefixes }) => [method, prefixes])).toEqual([
      ["POST", ["refs/heads/nope"]],
    ])
    expect(await tab.rows()).toEqual([HOME])
    expect(tab.place()).toBeNull()
    expect(await tab.actions.open("octo", "hello", "unseen")).toBeUndefined()
    expect(tab.cache.tanstack.has("octo/hello/unseen")).toBe(false)
  }, WITHIN)

  test("ChatApi unavailable is tried again by the step's retry policy, and the branch is tracked once", async () => {
    const tab = await open()
    // GitHub's first answer never comes: ChatApi answers 503, and the step asks again 500 ms later.
    tab.api.branches.github.fail("POST", "throw")

    const branchId = await tab.actions.open("octo", "hello", "feature/one")

    expect(branchId).toEqual(expect.any(String))
    expect(tab.current()).toMatchObject({ status: "ready", branchId })
    expect(tab.api.branches.github.seen.map(({ method }) => method)).toEqual(["POST", "POST", "GET"])
    expect(await tab.rows()).toEqual([{ name: "feature/one", mode: "open" }, HOME])
  }, WITHIN)

  test.each<[string, Actor | null, string]>([
    ["signed out", null, "sign_in"],
    ["a Guest", { subject: { kind: "person", id: "person-guest" }, role: "guest" }, "forbidden"],
  ])("%s may not watch a branch: %s, and nothing is recorded", async (_who, actor, status) => {
    const tab = await open({}, { actor })
    await tab.runtime.runPromise(tab.cache.restored)
    await tab.runtime.runPromise(tab.cache.insert({ id: "octo/hello/feature/one", conversationId: "previous-conversation" }))

    expect(await tab.actions.open("octo", "hello", "feature/one")).toBeUndefined()

    expect(tab.current()).toMatchObject({ status, branchId: null, conversationId: null })
    expect(tab.opened(status)).toBe(1)
    expect(tab.cache.tanstack.has("octo/hello/feature/one")).toBe(false)
    expect(tab.api.branches.github.seen).toEqual([])
    expect(await tab.rows()).toEqual([HOME])
    // ChatApi's forbidden is its word on the branch's conversation, recorded as a refusal of it. Signed out, ChatApi
    // was never asked, and nothing is recorded.
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    expect(owners.fence().seq > 0).toBe(status === "forbidden")
    expect(owners.refused("previous-conversation")).toBe(status === "forbidden")
  }, WITHIN)

  test("leaving a branch while it opens loses neither ChatApi's refusal of it nor its answer: the conversation the device kept is hidden with its run and its wait, and shows again once the branch is shared", async () => {
    const tab = await open()
    const sql = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      tab.runtime.runPromise(tab.api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))
    // A branch the person visited: the device keeps the route to its conversation, and one of its runs waits for them.
    const branchId = (await tab.actions.open("octo", "hello", "feature/one"))!
    const conversationId = await conversationOf(branchId)
    const runId = crypto.randomUUID()
    await sql((sql) => sql`
      INSERT INTO runs (id, flow, status, waiting, wait, version, launched_by, conversation_id)
      VALUES (${runId}, 'agent', 'needs_you', 'input',
        ${JSON.stringify({ execution: `ask-${runId}`, kind: "question", prompt: "Ship the secret plan?", options: ["Ship", "Hold"] })}::jsonb, 1,
        'person-member', ${conversationId})`)
    const status = await tab.runtime.runPromise(Effect.service(StatusStore))
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    // What every page lists of the person's runs, and `core/waits`: both show a run only through its conversation.
    for (const query of [status.waits, status.shownRuns]) query.tanstack.startSyncImmediate()
    const listed = () => [status.shownRuns.tanstack.toArray.map((run) => run.id), status.waits.tanstack.toArray.map((wait) => wait.runId)]
    await until(() => expect(listed()).toEqual([[runId], [runId]]))
    await tab.actions.leave()
    /**
     * Opens the branch's page and leaves it at once, its navigation cancelled: `branch/track` is asked before the open
     * first waits, and ChatApi's answer, which reads Postgres, comes after the page is gone.
     */
    const openAndLeave = async () => {
      const leaving = new AbortController()
      const opening = tab.actions.open("octo", "hello", "feature/one", leaving.signal)
      leaving.abort()
      await tab.actions.leave()
      expect(await opening).toBeUndefined()
      expect(tab.current()).toMatchObject(none)
    }

    // The branch is taken from the person; their repository stays theirs, and so do the rows that name the
    // conversation. They open its page and leave at once: nothing has answered, and nothing changed.
    await sql((sql) => sql`UPDATE branches SET created_by = 'someone-else' WHERE id = ${branchId}`)
    await sql((sql) => sql`DELETE FROM branch_shares WHERE branch_id = ${branchId}`)
    const before = owners.fence().seq
    await openAndLeave()
    expect(owners.fence().seq).toBe(before)
    expect(listed()).toEqual([[runId], [runId]])
    // ChatApi's answer arrives for a page nobody is on: forbidden. It is recorded all the same, and the run and its
    // wait go with the conversation, though the route and the synced rows still name it.
    await until(() => expect(owners.fence().seq).toBeGreaterThan(before))
    await until(() => expect(listed()).toEqual([[], []]))
    expect(tab.cache.tanstack.get("octo/hello/feature/one")?.conversationId).toBe(conversationId)
    expect(tab.current()).toMatchObject(none)
    expect(tab.opened("forbidden")).toBe(0)

    // Shared with them again. They open the page and leave at once again: ChatApi's answer, that they may read the
    // branch, is recorded for the page nobody is on, and the run and its wait return.
    await sql((sql) => sql`INSERT INTO branch_shares (branch_id, grantee, access) VALUES (${branchId}, 'repository', 'edit')`)
    await openAndLeave()
    expect(listed()).toEqual([[], []])
    await until(() => expect(listed()).toEqual([[runId], [runId]]))
    expect(tab.current()).toMatchObject(none)
    expect(tab.opened("ready")).toBe(1)
  }, WITHIN)

  test("a refusal goes only with ChatApi's word that the person may read: the home shape's answer to a read begun after it, and branch/track's for a branch, whose shape says nothing", async () => {
    const tab = await open()
    const sql = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      tab.runtime.runPromise(tab.api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))
    const branchId = (await tab.actions.open("octo", "hello", "feature/one"))!
    const conversationId = await conversationOf(branchId)
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    owners.shown.tanstack.startSyncImmediate()
    const shown = (id: string) => owners.shown.tanstack.has(id)
    // The tab reads both conversations' messages from Electric's shapes, the default reader.
    const chat = await tab.runtime.runPromise(Effect.service(ChatStore))
    const branchMessages = chat.opened(conversationId)!.messages
    await tab.runtime.runPromise(Effect.ignore(branchMessages.preload))
    await until(() => expect(owners.home()).toEqual(expect.any(String)))
    const home = owners.home()!
    await until(() => expect([shown(home), shown(conversationId)]).toEqual([true, true]))
    /** A message in `conversation`, once its shape has answered with it. */
    const say = async (conversation: string, messages: { readonly tanstack: { readonly has: (id: string) => boolean } }, text: string) => {
      const id = crypto.randomUUID()
      await sql((sql) => sql`INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${id}, 'user', ${text}, 'done', ${conversation})`)
      await until(() => expect(messages.tanstack.has(id)).toBe(true))
    }
    // Each shape is up to date, and its next request waits at ChatApi. Both conversations are refused meanwhile.
    await say(home, chat.messages, "before")
    await say(conversationId, branchMessages, "before")
    await new Promise((resolve) => setTimeout(resolve, 300))
    owners.refuse(home)
    owners.refuse(conversationId)
    expect([shown(home), shown(conversationId)]).toEqual([false, false])
    // The home shape's waiting request is answered: it began before the refusal, which may be later than its
    // answer, and stands.
    await say(home, chat.messages, "answered by the read that began before")
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(shown(home)).toBe(false)
    // The request after it began after the refusal. Answered whole, it is ChatApi's word that the person may read
    // their home conversation: it shows again.
    await say(home, chat.messages, "answered by the read that began after")
    await until(() => expect(shown(home)).toBe(true))
    // The branch's shape answers as often, and its refusal stands: ChatApi answers that shape for someone who may
    // not watch the branch too.
    await say(conversationId, branchMessages, "first")
    await say(conversationId, branchMessages, "second")
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(shown(conversationId)).toBe(false)
    // They open the branch again, and ChatApi answers that they may: it shows.
    await tab.actions.leave()
    expect(await tab.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    expect(shown(conversationId)).toBe(true)
  }, WITHIN)

  test("a device that only lists a branch's conversation, with no route kept for it, still records ChatApi's refusal of the branch when the person leaves as it opens: its run and its wait go", async () => {
    const tab = await open()
    const sql = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      tab.runtime.runPromise(tab.api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))
    const branchId = (await tab.actions.open("octo", "hello", "feature/one"))!
    const conversationId = await conversationOf(branchId)
    const runId = crypto.randomUUID()
    await sql((sql) => sql`
      INSERT INTO runs (id, flow, status, waiting, wait, version, launched_by, conversation_id)
      VALUES (${runId}, 'agent', 'needs_you', 'input',
        ${JSON.stringify({ execution: `ask-${runId}`, kind: "question", prompt: "Ship the secret plan?", options: ["Ship", "Hold"] })}::jsonb, 1,
        'person-member', ${conversationId})`)
    const status = await tab.runtime.runPromise(Effect.service(StatusStore))
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    for (const query of [status.waits, status.shownRuns]) query.tanstack.startSyncImmediate()
    const listed = () => [status.shownRuns.tanstack.toArray.map((run) => run.id), status.waits.tanstack.toArray.map((wait) => wait.runId)]
    await until(() => expect(listed()).toEqual([[runId], [runId]]))
    await tab.actions.leave()
    // As the person's second device holds it: their synced row names the conversation for the branch, and the device
    // never saved a route to it. The run and its wait, with its options, show through that row.
    await until(() => expect(owners.mine.tanstack.get(conversationId)).toMatchObject({ owner: "octo", repo: "hello", branch: "feature/one" }))
    const removed = await tab.runtime.runPromise(tab.cache.delete("octo/hello/feature/one"))
    await tab.runtime.runPromise(removed.persisted)
    expect(tab.cache.tanstack.size).toBe(0)
    expect(listed()).toEqual([[runId], [runId]])
    expect(status.waits.tanstack.toArray[0]).toMatchObject({ runId, options: ["Ship", "Hold"] })
    // The branch is taken from the person. They open its page and leave at once: ChatApi's forbidden arrives for a
    // page nobody is on, and is recorded for the conversation their row names.
    await sql((sql) => sql`UPDATE branches SET created_by = 'someone-else' WHERE id = ${branchId}`)
    await sql((sql) => sql`DELETE FROM branch_shares WHERE branch_id = ${branchId}`)
    const leaving = new AbortController()
    const opening = tab.actions.open("Octo", "Hello", "feature/one", leaving.signal)
    leaving.abort()
    await tab.actions.leave()
    expect(await opening).toBeUndefined()
    await until(() => expect(owners.refused(conversationId)).toBe(true))
    expect(listed()).toEqual([[], []])
    expect(tab.cache.tanstack.size).toBe(0)
    expect(tab.current()).toMatchObject(none)
  }, WITHIN)

  test("a home shape with no rows is no word that a Guest may read the home conversation: its refusal stands until ChatApi's answer says they may", async () => {
    const tab = await open({}, { actor: { subject: { kind: "person", id: "person-guest" }, role: "guest" } })
    const sql = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      tab.runtime.runPromise(tab.api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    owners.shown.tanstack.startSyncImmediate()
    const chat = await tab.runtime.runPromise(Effect.service(ChatStore))
    // Every answer ChatApi gives the home shape from here on.
    let answers = 0
    tab.runtime.runFork(chat.messages.sync.pipe(Stream.runForEach((event) => Effect.sync(() => {
      if (event._tag === "Succeeded") answers++
    }))))
    // The session names the deployment's conversation home for a Guest too, who has no share of its branch.
    await until(() => expect(owners.home()).toEqual(expect.any(String)))
    const home = owners.home()!
    await tab.runtime.runPromise(Effect.ignore(chat.messages.preload))
    // ChatApi answered their home shape with no rows, and that opened nothing.
    expect(owners.shown.tanstack.has(home)).toBe(false)
    // They open the home branch's page: forbidden, recorded as a refusal of the conversation the device kept for it.
    await tab.runtime.runPromise(tab.cache.restored)
    await tab.runtime.runPromise(tab.cache.insert({ id: "octo/hello/main", conversationId: home }))
    expect(await tab.actions.open("octo", "hello", "main")).toBeUndefined()
    expect(tab.current()).toMatchObject({ status: "forbidden" })
    expect(owners.refused(home)).toBe(true)
    await tab.actions.leave()
    // The home shape is asked again, twice, each request begun after the refusal, and ChatApi answers each whole
    // with no rows: the refusal stands, and nothing of the conversation shows.
    for (const _ of [1, 2]) {
      const before = answers
      await tab.runtime.runPromise(chat.messages.reconnect)
      await until(() => expect(answers).toBeGreaterThan(before), 60_000)
    }
    expect(owners.refused(home)).toBe(true)
    expect(owners.shown.tanstack.has(home)).toBe(false)
    // The branch is shared with them by name. The next answer says they may read the conversation: it shows.
    const [{ branchId }] = await sql((sql) => sql<{ readonly branchId: string }>`SELECT branch_id AS "branchId" FROM conversations WHERE id = ${home}`) as [{ readonly branchId: string }]
    await sql((sql) => sql`INSERT INTO branch_shares (branch_id, grantee, login, access) VALUES (${branchId}, 'person-guest', 'guest', 'view')`)
    await tab.runtime.runPromise(chat.messages.reconnect)
    await until(() => expect(owners.refused(home)).toBe(false), 60_000)
    await until(() => expect(owners.shown.tanstack.has(home)).toBe(true))
  }, 180_000)

  test("a branch's page that another tab's refused read hid asks ChatApi again without leaving: opening the same route, or Retry, shows it once the person may read", async () => {
    const route = { reopened: 0, open: (): unknown => undefined }
    const tab = await open({ reopenRoute: () => {
      route.reopened++
      route.open()
    } })
    route.open = () => tab.actions.open("octo", "hello", "feature/one")
    const branchId = (await tab.actions.open("octo", "hello", "feature/one"))!
    const conversationId = await conversationOf(branchId)
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    owners.shown.tanstack.startSyncImmediate()
    const shown = () => owners.shown.tanstack.has(conversationId)
    await until(() => expect(shown()).toBe(true))
    // Another page of the branch, while it shows: kept as it is, and ChatApi is not asked again.
    expect(await tab.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    expect([tab.opened("kept"), tab.dispatched()]).toEqual([1, 1])
    // Retry on a page that shows asks nothing of the branch either.
    await tab.runtime.runPromise(retry("button"))
    expect([route.reopened, tab.dispatched()]).toEqual([0, 1])
    // A refusal reaches this tab while the page stays open, as another tab's refused read does through the device.
    owners.refuse(conversationId)
    expect([shown(), tab.current()?.status]).toEqual([false, "ready"])
    // The person may read the branch, as after it is shared again. They open the same route: ChatApi is asked afresh,
    // and its answer shows the conversation, with no leaving first.
    expect(await tab.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    expect([tab.opened("kept"), tab.dispatched()]).toEqual([1, 2])
    expect([shown(), owners.refused(conversationId), tab.current()?.status]).toEqual([true, false, "ready"])
    // Hidden again, and this time they press Retry: the route opens again, and the branch is tracked afresh.
    owners.refuse(conversationId)
    expect(shown()).toBe(false)
    await tab.runtime.runPromise(retry("button"))
    expect(route.reopened).toBe(1)
    await until(() => expect(shown()).toBe(true))
    expect([tab.opened("kept"), tab.dispatched(), owners.refused(conversationId)]).toEqual([1, 3, false])
    // Off the branch, Retry opens no route.
    await tab.actions.leave()
    await tab.runtime.runPromise(retry("button"))
    expect(route.reopened).toBe(1)
  }, WITHIN)

  test("Retry asks ChatApi of the page's branch again each time, though an earlier Retry was answered no and left the page no conversation: shared again, the branch shows in place", async () => {
    const route = { reopened: 0, open: (): unknown => undefined }
    const tab = await open({ reopenRoute: () => {
      route.reopened++
      route.open()
    } })
    route.open = () => tab.actions.open("octo", "hello", "feature/one")
    const sql = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      tab.runtime.runPromise(tab.api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))
    const branchId = (await tab.actions.open("octo", "hello", "feature/one"))!
    const conversationId = await conversationOf(branchId)
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    owners.shown.tanstack.startSyncImmediate()
    const shown = () => owners.shown.tanstack.has(conversationId)
    await until(() => expect(shown()).toBe(true))
    // The branch is taken from the person, and another tab's refused read hides the page's conversation.
    await sql((sql) => sql`UPDATE branches SET created_by = 'someone-else' WHERE id = ${branchId}`)
    await sql((sql) => sql`DELETE FROM branch_shares WHERE branch_id = ${branchId}`)
    owners.refuse(conversationId)
    expect([shown(), tab.current()?.status]).toEqual([false, "ready"])
    // Retry: ChatApi is asked of the branch, and says no. The page says so, and names no conversation any more.
    await tab.runtime.runPromise(retry("button"))
    expect(route.reopened).toBe(1)
    await until(() => expect(tab.current()).toMatchObject({ owner: "octo", repo: "hello", name: "feature/one", status: "forbidden", conversationId: null }))
    expect(shown()).toBe(false)
    // Retry again, still refused: asked again, the same answer.
    await tab.runtime.runPromise(retry("button"))
    expect(route.reopened).toBe(2)
    await until(() => expect(tab.opened("forbidden")).toBe(2))
    expect(tab.current()).toMatchObject({ status: "forbidden", conversationId: null })
    // Shared with them again. Retry asks once more, with no leaving and no other navigation: the page is ready, and
    // its conversation shows.
    await sql((sql) => sql`INSERT INTO branch_shares (branch_id, grantee, access) VALUES (${branchId}, 'repository', 'edit')`)
    await tab.runtime.runPromise(retry("button"))
    expect(route.reopened).toBe(3)
    await until(() => expect(tab.current()).toMatchObject({ status: "ready", branchId, conversationId }))
    await until(() => expect(shown()).toBe(true))
    expect(owners.refused(conversationId)).toBe(false)
    // A page still opening, and no page, are left as they are.
    await tab.runtime.runPromise(retry("button"))
    expect(route.reopened).toBe(3)
    const release = tab.api.branches.github.hold()
    route.open = () => undefined
    await tab.actions.leave()
    const opening = tab.actions.open("octo", "hello", "feature/two")
    expect(tab.current()).toMatchObject({ status: "tracking" })
    await tab.runtime.runPromise(retry("button"))
    expect(route.reopened).toBe(3)
    release()
    await opening
  }, WITHIN)

  test.each(["same load", "offline reload", "quota retry", "quota exhausted"])("a branch denial before history restoration stays hidden on %s", async (scenario) => {
    const tab = await open()
    const sql = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      tab.runtime.runPromise(tab.api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))
    // A branch the person visited on this device, one of whose runs waits for them. The device keeps their row of its
    // conversation and the word that it is open, and no route to it, as their second device does.
    const reply = Promise.withResolvers<void>()
    let holdTrack = false
    let trackSent = false
    const device = nodeDevice({ agent: { ...tab.api, fetch: async (input, init) => {
      const request = new Request(input, init)
      if (holdTrack && request.method === "POST" && new URL(request.url).pathname === BRANCHES_ROUTE) {
        trackSent = true
        await reply.promise
      }
      return tab.api.fetch(request)
    } } })
    const warm = openTab(tab.api, { host: device })
    runtimes.push(warm)
    const first = await warm.runPromise(Effect.service(Branch))
    const branchId = (await first.actions.open("octo", "hello", "feature/one"))!
    const conversationId = await conversationOf(branchId)
    const runId = crypto.randomUUID()
    await sql((sql) => sql`
      INSERT INTO runs (id, flow, status, waiting, wait, version, launched_by, conversation_id)
      VALUES (${runId}, 'agent', 'needs_you', 'input',
        ${JSON.stringify({ execution: `ask-${runId}`, kind: "question", prompt: "Ship the secret plan?", options: ["Ship", "Hold"] })}::jsonb, 1,
        'person-member', ${conversationId})`)
    const firstStatus = await warm.runPromise(Effect.service(StatusStore))
    for (const query of [firstStatus.waits, firstStatus.shownRuns]) query.tanstack.startSyncImmediate()
    await until(() => expect(firstStatus.waits.tanstack.toArray.map((wait) => wait.runId)).toEqual([runId]))
    const firstOwners = await warm.runPromise(Effect.service(ConversationOwners))
    await until(() => expect(firstOwners.mine.tanstack.has(conversationId)).toBe(true))
    await first.actions.leave()
    const { conversations: routes } = await warm.runPromise(Effect.service(BranchStore))
    const removed = await warm.runPromise(routes.delete("octo/hello/feature/one"))
    await warm.runPromise(removed.persisted)
    const openKey = Marks.keyOf("open", "person-member", conversationId)
    expect(device.webStorage.entries.has(openKey)).toBe(true)
    // The branch is taken from the person. A cold load of the device reads their list late.
    await sql((sql) => sql`UPDATE branches SET created_by = 'someone-else' WHERE id = ${branchId}`)
    await sql((sql) => sql`DELETE FROM branch_shares WHERE branch_id = ${branchId}`)
    runtimes.splice(runtimes.indexOf(warm), 1)
    await warm.dispose()
    const route = `github/octo/hello\0feature/one`
    const routeMark = Marks.routeRefusedKey(DEVICE_PRINCIPAL, route)
    const routeMarks = () => [...device.webStorage.entries].filter(([key]) => key === routeMark).map(([, token]) => token)
    const capped = scenario === "quota retry" ? capStorage(device)
      : scenario === "quota exhausted" ? fillStorage(device) : undefined
    if (capped !== undefined) capped.quota.full = true
    const host = capped?.device ?? device
    const late = holdRestore(host, "my-conversations")
    const cold = openTab(tab.api, { host: late.device })
    runtimes.push(cold)
    const branch = await cold.runPromise(Effect.service(Branch))
    const owners = await cold.runPromise(Effect.service(ConversationOwners))
    const status = await cold.runPromise(Effect.service(StatusStore))
    branch.queries.current.startSyncImmediate()
    // Everything the cold load ever comes to show of the run: the runs every page lists, and the waits with their
    // prompt and options.
    const seen: Array<unknown> = []
    for (const query of [status.waits, status.shownRuns]) query.tanstack.startSyncImmediate()
    status.waits.tanstack.subscribeChanges((changes) => void seen.push(...changes.map((change) => change.value)), { includeInitialState: true })
    status.shownRuns.tanstack.subscribeChanges((changes) => void seen.push(...changes.map((change) => change.value)), { includeInitialState: true })
    owners.shown.tanstack.startSyncImmediate()
    owners.shown.tanstack.subscribeChanges((changes) => {
      for (const change of changes) if (change.key === conversationId) seen.push(change.value)
    }, { includeInitialState: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(owners.mine.tanstack.has(conversationId)).toBe(false)
    // Leave once the track request is on its way. The detached answer still denies the route while the
    // device has no history row naming its conversation.
    const before = owners.fence().seq
    const leaving = new AbortController()
    holdTrack = true
    const opening = branch.actions.open("octo", "hello", "feature/one", leaving.signal)
    try {
      await until(() => expect(trackSent).toBe(true))
      leaving.abort()
      await branch.actions.leave()
      expect(await opening).toBeUndefined()
    } finally {
      reply.resolve()
    }
    await until(() => expect(owners.fence().seq).toBeGreaterThan(before))
    await device.webStorage.lock(Marks.lockName(DEVICE_PRINCIPAL), async () => {})
    expect(owners.mine.tanstack.has(conversationId)).toBe(false)
    if (capped === undefined) expect(owners.refused(conversationId)).toBe(false)
    expect(branch.queries.current.toArray[0]).toMatchObject(none)
    if (scenario !== "same load") {
      if (scenario === "offline reload") expect(device.webStorage.entries.has(openKey)).toBe(true)
      if (scenario === "quota retry" || scenario === "quota exhausted") expect(device.webStorage.entries.has(openKey)).toBe(false)
      if (scenario === "quota exhausted") expect(routeMarks()).toEqual([])
      else expect(routeMarks()).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/)])
      runtimes.splice(runtimes.indexOf(cold), 1)
      await cold.dispose()
      late.release()
      const offline = openTab(tab.api, { host, transport: () => async () => { throw new TypeError("offline") } })
      runtimes.push(offline)
      const reloaded = await offline.runPromise(Effect.service(ConversationOwners))
      const reloadedStatus = await offline.runPromise(Effect.service(StatusStore))
      const restored: Array<unknown> = []
      for (const query of [reloadedStatus.waits, reloadedStatus.shownRuns]) query.tanstack.startSyncImmediate()
      reloadedStatus.waits.tanstack.subscribeChanges((changes) => void restored.push(...changes.map((change) => change.value)), { includeInitialState: true })
      reloadedStatus.shownRuns.tanstack.subscribeChanges((changes) => void restored.push(...changes.map((change) => change.value)), { includeInitialState: true })
      await until(() => expect(reloaded.mine.tanstack.has(conversationId)).toBe(true))
      expect(reloaded.refused(conversationId)).toBe(scenario !== "quota exhausted")
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(restored).toEqual([])
      return
    }
    // The list is read. Its row names the conversation for the refused branch: refused as it is named, and the word
    // that it was open is taken away. Nothing of its run ever showed.
    late.release()
    await until(() => expect(owners.mine.tanstack.has(conversationId)).toBe(true))
    expect(owners.refused(conversationId)).toBe(true)
    expect(device.webStorage.entries.has(openKey)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(seen).toEqual([])
    expect([status.shownRuns.tanstack.toArray, status.waits.tanstack.toArray, owners.shown.tanstack.has(conversationId)]).toEqual([[], [], false])
  }, WITHIN)

  test("the home shape's answer covers only the refusals recorded before its own request went: one recorded as the request goes stands, whenever the collection tells of that request", async () => {
    // What the test does as the home shape's next request reaches the network: after the request began, and before
    // anything the collection reports of it is heard.
    const going: { then?: () => void } = {}
    const tab = await open({ transport: (fetch) => (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === SHAPE_ROUTE && !url.searchParams.has("conversation")) {
        const then = going.then
        delete going.then
        then?.()
      }
      return fetch(request)
    } })
    const sql = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      tab.runtime.runPromise(tab.api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    owners.shown.tanstack.startSyncImmediate()
    const chat = await tab.runtime.runPromise(Effect.service(ChatStore))
    await until(() => expect(owners.home()).toEqual(expect.any(String)))
    const home = owners.home()!
    await until(() => expect(owners.shown.tanstack.has(home)).toBe(true))
    const say = async (text: string) => {
      const id = crypto.randomUUID()
      await sql((sql) => sql`INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${id}, 'user', ${text}, 'done', ${home})`)
      await until(() => expect(chat.messages.tanstack.has(id)).toBe(true))
    }
    // The shape is up to date, and its next request waits at ChatApi.
    await say("before")
    await new Promise((resolve) => setTimeout(resolve, 300))
    // The request after that one is refused the conversation as it goes: the refusal is later than its beginning.
    let refusedAt = 0
    going.then = () => {
      owners.refuse(home)
      refusedAt = owners.fence().seq
    }
    await say("answers the waiting request, and the next one goes")
    await until(() => expect(refusedAt).toBeGreaterThan(0))
    expect(owners.shown.tanstack.has(home)).toBe(false)
    // ChatApi answers that request whole, saying the person may read: it began before the refusal, which stands.
    await say("answered by the request that went as the refusal was recorded")
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect([owners.refused(home), owners.shown.tanstack.has(home)]).toEqual([true, false])
    // The request after it began after the refusal: its answer is ChatApi's word, and the conversation shows.
    await say("answered by the request that began after")
    await until(() => expect(owners.shown.tanstack.has(home)).toBe(true))
    expect(owners.refused(home)).toBe(false)
  }, WITHIN)

  test("a successful home response only clears the home named at dispatch and delivery", async () => {
    const arrived = Promise.withResolvers<string>()
    const release = Promise.withResolvers<void>()
    const continued = Promise.withResolvers<void>()
    let hold = false
    let delivered = false
    const device = nodeDevice()
    let refreshedHome: string | undefined
    const tab = await open({ host: device, transport: (fetch) => async (input, init) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      const homeShape = path === SHAPE_ROUTE
      if (homeShape && delivered) continued.resolve()
      const captured = hold && homeShape
      if (captured) hold = false
      const response = await fetch(request)
      if (captured) {
        arrived.resolve(response.headers.get(CONVERSATION_ID_HEADER) ?? "")
        await release.promise
        delivered = true
      }
      if (path === SESSION_ROUTE && refreshedHome !== undefined) {
        return Response.json({ ...await response.json(), homeConversationId: refreshedHome }, { status: response.status })
      }
      return response
    } })
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    const chat = await tab.runtime.runPromise(Effect.service(ChatStore))
    owners.shown.tanstack.startSyncImmediate()
    await until(() => expect(owners.shown.tanstack.has(owners.home() ?? "")).toBe(true))
    const home = owners.home()!
    const next = crypto.randomUUID()
    owners.refuse(next)
    const say = async () => {
      const id = crypto.randomUUID()
      await tab.runtime.runPromise(tab.api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${id}, 'user', 'home', 'done', ${home})`))))
      return id
    }
    try {
      hold = true
      const message = await say()
      expect(await arrived.promise).toBe(home)
      refreshedHome = next
      await tab.runtime.runPromise(loadSession)
      expect(owners.home()).toBe(next)
      release.resolve()
      await until(() => expect(chat.messages.tanstack.has(message)).toBe(true))
      await continued.promise
      await device.webStorage.lock(Marks.lockName(DEVICE_PRINCIPAL), async () => {})
      expect(owners.refused(next)).toBe(true)
    } finally {
      release.resolve()
    }
  }, WITHIN)

  test("a track success overtaken by a refusal never saves a route or makes the branch writable", async () => {
    const tab = await open()
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    const preceding = tab.api.branches.github.seen.length
    const release = tab.api.branches.github.hold()
    const opening = tab.actions.open("octo", "hello", "feature/one")
    try {
      await until(() => expect(tab.api.branches.github.seen.length).toBeGreaterThan(preceding))
      owners.refuseBranch("github/octo/hello", "feature/one")
    } finally {
      release()
    }
    expect(await opening).toBeUndefined()
    expect(tab.cache.tanstack.has("octo/hello/feature/one")).toBe(false)
    expect(tab.current()).toMatchObject({ status: "failed", conversationId: null })
    expect(tab.actions.writable()).toBe(false)
  }, WITHIN)

  test.each(["route", "undelivered durable conversation"] as const)("a %s refusal while the accepted track is persisting its route never publishes ready or becomes writable", async (kind) => {
    const { api } = await open()
    const device = nodeDevice({ agent: api })
    let writing = false
    const persist = Promise.withResolvers<void>()
    let table: string | undefined
    const runtime = openTab(api, { host: {
      ...device,
      ...(kind === "route" ? {} : { refusalMarks: Marks.make({
        storage: device.webStorage, principal: () => DEVICE_PRINCIPAL,
        changes: () => () => {}, channel: () => undefined, lock: device.webStorage.lock,
      }) }),
      persistence: { ...device.persistence, open: async () => {
        const database = await device.persistence.open()
        return { ...database, execute: async <T>(sql: string, params?: ReadonlyArray<unknown>): Promise<ReadonlyArray<T>> => {
          if (table !== undefined && /^\s*(insert|update|delete|replace)\b/i.test(sql) && sql.includes(table)) {
            writing = true
            await persist.promise
          }
          return database.execute<T>(sql, params)
        } }
      } },
    } })
    runtimes.push(runtime)
    const owners = await runtime.runPromise(Effect.service(ConversationOwners))
    const branch = await runtime.runPromise(Effect.service(Branch))
    const { conversations } = await runtime.runPromise(Effect.service(BranchStore))
    branch.queries.current.startSyncImmediate()
    const current = () => branch.queries.current.toArray[0]
    const seen: Array<string> = []
    const subscription = branch.queries.current.subscribeChanges((changes) => {
      for (const change of changes) seen.push(change.value.status)
    })
    await runtime.runPromise(conversations.restored)
    const database = await device.persistence.open()
    try {
      table = (await database.execute<{ readonly table_name: string }>(
        "select table_name from collection_registry where collection_id = 'branch-conversations'",
      ))[0]?.table_name
    } finally {
      database.close?.()
    }
    expect(table).toBeDefined()
    const opening = branch.actions.open("octo", "hello", "feature/one")
    try {
      await until(() => expect(writing).toBe(true))
      const { id } = (await runtime.runPromise(api.branches.run(Effect.orDie(Effect.flatMap(
        SqlClient.SqlClient, (sql) => sql<{ readonly id: string }>`SELECT id FROM branches WHERE name = 'feature/one'`,
      )))))[0]!
      const conversationId = await conversationOf(id)
      expect(device.webStorage.entries.has(Marks.keyOf("open", DEVICE_PRINCIPAL, conversationId))).toBe(true)
      expect(current()?.status).toBe("tracking")
      expect(branch.actions.writable()).toBe(false)
      if (kind === "route") owners.refuseBranch("github/octo/hello", "feature/one")
      else {
        const sibling = Marks.make({
          storage: device.webStorage, principal: () => DEVICE_PRINCIPAL,
          changes: () => () => {}, channel: () => undefined, lock: device.webStorage.lock,
        })
        // No open-key deletion, epoch change or broadcast tells the opening tab about this refusal.
        expect(sibling.add({ conversationId, id: crypto.randomUUID() })).toBe(true)
      }
    } finally {
      persist.resolve()
    }
    expect(await opening).toBeUndefined()
    expect(current()?.status).toBe("failed")
    expect(branch.actions.writable()).toBe(false)
    expect(seen).not.toContain("ready")
    subscription.unsubscribe()
  }, WITHIN)

  test.each(["conversation", "route"] as const)("a ready branch stops accepting writes after a live %s refusal", async (kind) => {
    const tab = await open()
    expect(await tab.actions.open("octo", "hello", "feature/one")).toEqual(expect.any(String))
    expect(tab.actions.writable()).toBe(true)
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    const conversationId = tab.current()!.conversationId!
    if (kind === "conversation") owners.refuse(conversationId)
    else {
      // The route can be denied after another tab evicts its cached conversation mapping.
      const removed = await tab.runtime.runPromise(tab.cache.delete("octo/hello/feature/one"))
      await tab.runtime.runPromise(removed.persisted)
      await tab.runtime.runPromise(tab.api.branches.run(Effect.orDie(Effect.flatMap(
        SqlClient.SqlClient, (sql) => sql`DELETE FROM conversation_people WHERE conversation_id = ${conversationId}`,
      ))))
      await until(() => expect(owners.mine.tanstack.has(conversationId)).toBe(false))
      await owners.refuseBranch("github/octo/hello", "feature/one")
      expect(owners.refused(conversationId)).toBe(false)
    }
    expect(tab.current()).toMatchObject({ status: "ready", conversationId })
    expect(tab.actions.writable()).toBe(false)
  }, WITHIN)

  test("a ready branch stops accepting writes after a live undelivered durable conversation refusal", async () => {
    const { api } = await open()
    const device = nodeDevice({ agent: api })
    const runtime = openTab(api, { host: { ...device, refusalMarks: Marks.make({
      storage: device.webStorage, principal: () => DEVICE_PRINCIPAL,
      changes: () => () => {}, channel: () => undefined, lock: device.webStorage.lock,
    }) } })
    runtimes.push(runtime)
    const tab = await runtime.runPromise(Effect.service(Branch))
    tab.queries.current.startSyncImmediate()
    expect(await tab.actions.open("octo", "hello", "feature/one")).toEqual(expect.any(String))
    expect(tab.actions.writable()).toBe(true)
    const conversationId = tab.queries.current.toArray[0]!.conversationId!
    expect(device.refusalMarks!.add({ conversationId, id: crypto.randomUUID() })).toBe(true)
    expect(tab.actions.writable()).toBe(false)
  }, WITHIN)

  test.each(["retained", "memory-only"])("a share taken away on a %s page leaves the person's list its row, and a device new to them nothing of the conversation: ChatApi is asked, says no, and the run and its wait never show", async (mode) => {
    const guest: Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest" }
    const laptop = await open({}, { actor: guest })
    const sql = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      laptop.runtime.runPromise(laptop.api.branches.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))
    // Its owner's branch, shared with the Guest by name.
    const [branchId, conversationId, runId] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    await sql((sql) => sql`INSERT INTO branches (id, repo_id, name, mode, created_by) VALUES (${branchId}, 'github/octo/hello', 'feature/one', 'open', 'person-owner')`)
    await sql((sql) => sql`INSERT INTO conversations (id, repo_id, branch_id) VALUES (${conversationId}, 'github/octo/hello', ${branchId})`)
    await sql((sql) => sql`INSERT INTO branch_shares (branch_id, grantee, login, access) VALUES (${branchId}, 'person-guest', 'guest', 'view')`)
    // The Guest opens it on their laptop: it is in their list from then, and one of their runs there waits for them.
    expect(await laptop.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    expect(laptop.current()).toMatchObject({ status: "ready", conversationId, access: "view" })
    await sql((sql) => sql`
      INSERT INTO runs (id, flow, status, waiting, wait, version, launched_by, conversation_id)
      VALUES (${runId}, 'agent', 'needs_you', 'input',
        ${JSON.stringify({ execution: `ask-${runId}`, kind: "question", prompt: "Ship the secret plan?", options: ["Ship", "Hold"] })}::jsonb, 1,
        'person-guest', ${conversationId})`)
    const listedOn = (status: StatusStore["Service"]) => {
      const seen: Array<unknown> = []
      for (const query of [status.waits, status.shownRuns]) query.tanstack.startSyncImmediate()
      status.waits.tanstack.subscribeChanges((changes) => void seen.push(...changes.map((change) => change.value)), { includeInitialState: true })
      status.shownRuns.tanstack.subscribeChanges((changes) => void seen.push(...changes.map((change) => change.value)), { includeInitialState: true })
      return { seen, now: () => [status.shownRuns.tanstack.toArray.map((run) => run.id), status.waits.tanstack.toArray.map((wait) => wait.runId)] }
    }
    const onLaptop = listedOn(await laptop.runtime.runPromise(Effect.service(StatusStore)))
    await until(() => expect(onLaptop.now()).toEqual([[runId], [runId]]))
    // Its owner takes the share away. The Guest's row of the conversation stays in their list: it is their history.
    await sql((sql) => sql`DELETE FROM branch_shares WHERE branch_id = ${branchId}`)
    expect(await sql((sql) => sql`SELECT person_id FROM conversation_people WHERE conversation_id = ${conversationId}`)).toEqual([{ person_id: "person-guest" }])
    // A device new to the Guest. ChatApi delivers the row, and the device asks whether they may read its conversation:
    // no. It is refused: never shown, never said to be open, and its run and wait, with its options, never show.
    const phone = nodeDevice({ agent: laptop.api })
    const replies: number[] = []
    const host = mode === "retained" ? phone : { ...phone, refusalMarks: Marks.make({
      storage: phone.webStorage, principal: () => undefined, changes: phone.webStorage.changes,
    }) }
    const fresh = openTab(laptop.api, { host, transport: (fetch) => async (input, init) => {
      const request = new Request(input, init)
      const response = await fetch(request)
      if (new URL(request.url).pathname === accessPath(conversationId)) replies.push(response.status)
      return response
    } })
    runtimes.push(fresh)
    const owners = await fresh.runPromise(Effect.service(ConversationOwners))
    owners.shown.tanstack.startSyncImmediate()
    const shows: Array<unknown> = []
    owners.shown.tanstack.subscribeChanges((changes) => {
      for (const change of changes) if (change.key === conversationId) shows.push(change.type)
    }, { includeInitialState: true })
    const onPhone = listedOn(await fresh.runPromise(Effect.service(StatusStore)))
    await until(() => expect(owners.mine.tanstack.has(conversationId)).toBe(true))
    await until(() => expect(owners.refused(conversationId)).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect([shows, onPhone.seen, onPhone.now()]).toEqual([[], [], [[], []]])
    expect([...phone.webStorage.entries.keys()].filter((key) => key.includes(":open:") && key.includes(conversationId))).toEqual([])
    expect(replies).toEqual([403])
    expect(phone.refusalMarks!.read().map((mark) => mark.conversationId)).toEqual(mode === "retained" ? [conversationId] : [])
    if (mode === "memory-only") {
      const allowedAccess: number[] = []
      await sql((sql) => sql`INSERT INTO branch_shares (branch_id, grantee, login, access) VALUES (${branchId}, 'person-guest', 'guest', 'view')`)
      const freshDevice = nodeDevice({ agent: laptop.api })
      const restored = openTab(laptop.api, {
        host: { ...freshDevice, refusalMarks: Marks.make({
          storage: freshDevice.webStorage, principal: () => undefined, changes: freshDevice.webStorage.changes,
        }) },
        transport: (fetch) => async (input, init) => {
          const request = new Request(input, init)
          const response = await fetch(request)
          if (new URL(request.url).pathname === accessPath(conversationId)) allowedAccess.push(response.status)
          return response
        },
      })
      runtimes.push(restored)
      const allowedOwners = await restored.runPromise(Effect.service(ConversationOwners))
      allowedOwners.shown.tanstack.startSyncImmediate()
      await until(() => expect(allowedOwners.shown.tanstack.has(conversationId)).toBe(true))
      expect(allowedAccess).toEqual([200])
    }
  }, WITHIN)

  test("signed out, as sign-in's row says, the page says sign in without running branch/track", async () => {
    const tab = await open({}, { actor: null })
    const auth = await tab.runtime.runPromise(Effect.service(Auth))
    auth.queries.session.startSyncImmediate()
    await until(() => expect(auth.queries.session.toArray[0]?.status).toBe("signed_out"))
    await tab.runtime.runPromise(tab.cache.restored)
    await tab.runtime.runPromise(tab.cache.insert({ id: "octo/hello/feature/one", conversationId: "previous-conversation" }))

    expect(await tab.actions.open("octo", "hello", "feature/one")).toBeUndefined()

    expect(tab.current()).toMatchObject({ status: "sign_in", branchId: null, conversationId: null })
    expect(tab.opened("sign_in")).toBe(1)
    expect(tab.cache.tanstack.has("octo/hello/feature/one")).toBe(false)
    // Nothing went to ChatApi: no branch/track ran, so no POST /api/branches came back 401.
    for (const outcome of ["done", "failed", "error"]) {
      expect(tab.runtime.runSync(
        Metric.value(Metric.withAttributes(dispatches, { flow: "branch/track", door: "view", outcome })),
      ).count).toBe(0)
    }
    expect(await tab.rows()).toEqual([HOME])
  }, WITHIN)

  test("a visitor opening a file before the first session answer never tracks its branch", async () => {
    const tab = await open({ sessionLifecycle: false }, { actor: null })
    const client = await tab.runtime.runPromise(Effect.service(AuthClient))
    const release = Deferred.makeUnsafe<void>()
    // Delay only the session service; releasing it reads the real signed-out ChatApi.
    const loading = tab.runtime.runPromise(loadSession.pipe(Effect.provideService(AuthClient, {
      ...client, session: Deferred.await(release).pipe(Effect.andThen(client.session)),
    })))
    const opening = tab.runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(openBranch("octo", "hello", "feature/one"), { startImmediately: true })
      expect(tab.current()).toMatchObject({ status: "tracking" })
      expect(tab.api.branches.github.seen).toEqual([])
      yield* Deferred.succeed(release, undefined)
      return yield* Fiber.join(fiber)
    })))
    expect(await opening).toBeUndefined()
    expect(await loading).toBe("signed_out")
    expect(tab.current()).toMatchObject({ status: "sign_in" })
    for (const outcome of ["done", "failed", "error"]) {
      expect(tab.runtime.runSync(Metric.value(Metric.withAttributes(dispatches,
        { flow: "branch/track", door: "view", outcome }))).count).toBe(0)
    }
  }, WITHIN)

  test("a server refusal of a stale session clears its cached conversation and shows sign in", async () => {
    const tab = await open({ sessionLifecycle: false }, { actor: null })
    const real = await tab.runtime.runPromise(Effect.service(AuthClient))
    // An injected stale session confirmation; the branch flow still reaches
    // the real signed-out ChatApi and receives its real 401.
    await tab.runtime.runPromise(loadSession.pipe(Effect.provideService(AuthClient, {
      ...real, session: Effect.succeed({ signedIn: true, login: "expired", role: "member" } as const),
    })))
    await tab.runtime.runPromise(tab.cache.restored)
    await tab.runtime.runPromise(tab.cache.insert({ id: "octo/hello/feature/one", conversationId: "old-conversation" }))
    const owners = await tab.runtime.runPromise(Effect.service(ConversationOwners))
    const before = owners.fence().seq
    expect(await tab.actions.open("octo", "hello", "feature/one")).toBeUndefined()
    expect(tab.current()).toMatchObject({ status: "sign_in", branchId: null, conversationId: null })
    expect(tab.cache.tanstack.has("octo/hello/feature/one")).toBe(false)
    expect(tab.opened("sign_in")).toBe(1)
    expect(await tab.rows()).toEqual([HOME])
    // ChatApi's 401 is its refusal of the conversation the device kept for the branch: recorded, and later than any
    // read begun before it.
    expect(owners.refused("old-conversation")).toBe(true)
    expect(owners.fence().seq).toBeGreaterThan(before)
  }, WITHIN)

  test("offline, the page shows at once without waiting for an answer, and opens the branch again once the browser is back online", async () => {
    let reopened = 0
    const recovered = new AbortController()
    const tab = await open({ reopenRoute: () => { reopened++; recovered.abort() } })
    // ChatApi can't answer while the browser is offline: GitHub holds its answer, so the request never ends by itself.
    const release = tab.api.branches.github.hold()

    const opening = tab.actions.open("octo", "hello", "feature/one", recovered.signal)
    await until(() => expect(tab.api.branches.github.seen).toHaveLength(1))
    expect(tab.current()).toMatchObject({ status: "tracking" })
    await tab.runtime.runPromise(wentOffline)

    expect(await opening).toBeUndefined()
    expect(tab.current()).toMatchObject({ owner: "octo", repo: "hello", name: "feature/one", status: "offline", branchId: null })
    expect(tab.opened("offline")).toBe(1)
    expect(tab.place()).toBeNull()
    expect(reopened).toBe(0)

    // Back online, the route opens again, once; its loader then tracks the branch.
    release()
    await tab.runtime.runPromise(retry("online"))
    await until(() => expect(reopened).toBe(1))
    // Replacing the recovered navigation aborts its old signal; it is still one reopened attempt, never abandoned.
    expect(tab.reopens("abandoned")).toBe(0)
    const branchId = await tab.actions.open("octo", "hello", "feature/one")
    expect(tab.current()).toMatchObject({ status: "ready", branchId })

    // A branch opened while the browser is offline doesn't wait at all; leaving it before the browser is back stops the
    // route opening again.
    await tab.runtime.runPromise(wentOffline)
    expect(await tab.actions.open("octo", "hello", "main")).toBeUndefined()
    expect(tab.current()).toMatchObject({ name: "main", status: "offline" })
    await tab.actions.leave()
    await tab.runtime.runPromise(retry("online"))

    // So does its navigation's signal aborting: a newer navigation took over, or the page closed for another route.
    const closed = new AbortController()
    await tab.runtime.runPromise(wentOffline)
    expect(await tab.actions.open("octo", "hello", "main", closed.signal)).toBeUndefined()
    closed.abort()
    // Abandonment settles while still offline, even if no connection recovery or newer branch open ever occurs.
    await until(() => expect(tab.reopens("abandoned")).toBe(1))
    expect(reopened).toBe(1)
    await tab.runtime.runPromise(retry("online"))

    // Even when it aborts while the open still waits, before the browser goes offline.
    const hold = tab.api.branches.github.hold()
    const abandoned = new AbortController()
    const late = tab.actions.open("octo", "hello", "feature/two", abandoned.signal)
    await until(() => expect(tab.current()).toMatchObject({ name: "feature/two", status: "tracking" }))
    abandoned.abort()
    await tab.runtime.runPromise(wentOffline)
    expect(await late).toBeUndefined()
    await tab.runtime.runPromise(retry("online"))
    hold()
    // Both aborted pages are counted once, and neither opened its route.
    await until(() => expect(tab.reopens("abandoned")).toBe(2))
    expect(tab.reopens("reopened")).toBe(1)
    expect(reopened).toBe(1)
  }, WITHIN)

  test("cancelling the navigation while the branch is tracked online settles the page at once, and the run goes on", async () => {
    const tab = await open()
    const chat = await tab.runtime.runPromise(Effect.service(Chat))
    chat.queries.connection.startSyncImmediate()
    // GitHub holds its answer, as a slow server or engine would, and the browser stays online: nothing else ends the
    // wait.
    const release = tab.api.branches.github.hold()
    const abandoned = new AbortController()
    const opening = tab.actions.open("octo", "hello", "feature/one", abandoned.signal)
    try {
      await until(() => expect(tab.api.branches.github.seen).toHaveLength(1))
      expect(tab.current()).toMatchObject({ name: "feature/one", status: "tracking", branchId: null })

      expect(chat.queries.connection.toArray[0]?.status).toBe("up")

      // A newer navigation took the page over: the open settles at once, abandoned, and sets nothing of the page.
      abandoned.abort()
      await until(() => expect(tab.reopens("abandoned")).toBe(1))
      expect(await opening).toBeUndefined()
      expect(chat.queries.connection.toArray[0]?.status).toBe("up")
      expect(tab.current()).toMatchObject({ name: "feature/one", status: "tracking", branchId: null })
      expect(tab.opened("offline")).toBe(0)
      expect(tab.place()).toBeNull()
    } finally {
      release()
      await opening
    }

    // The run went on in the tab's scope: GitHub's answer tracks the branch, and shows it nowhere.
    await until(() => expect(tab.dispatched()).toBe(1))
    expect(await tab.rows()).toEqual([{ name: "feature/one", mode: "open" }, HOME])
    expect(tab.opened("ready")).toBe(0)
    expect(tab.place()).toBeNull()
  }, WITHIN)

  test("a tab whose engine can't run fails to open the branch, and keeps the home conversation", async () => {
    const tab = await open({ host: nodeDevice({ engineWorker: failingWorker }) })
    await tab.runtime.runPromise(tab.cache.restored)
    await tab.runtime.runPromise(tab.cache.insert({ id: "octo/hello/feature/one", conversationId: "saved-conversation" }))

    expect(await tab.actions.open("octo", "hello", "feature/one")).toBeUndefined()

    expect(tab.current()).toMatchObject({ name: "feature/one", status: "failed", branchId: null })
    expect(tab.opened("failed")).toBe(1)
    expect(tab.cache.tanstack.has("octo/hello/feature/one")).toBe(true)
    expect(tab.place()).toBeNull()
  }, WITHIN)
})

/** `BranchClient` over `fetch`, as the engine's host builds it: what one track answers, or its refusal. */
const client = (fetch: typeof globalThis.fetch, within?: "50 millis") =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(BranchClient), (branches) =>
      branches.track({ owner: "octo", name: "hello", ref: "feature/one" })).pipe(
        Effect.match({ onSuccess: (tracked) => tracked, onFailure: (refused) => refused }),
        Effect.provide(
          BranchClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
          ),
        ),
      ),
  )

const trackedBody = {
  branchId: "0b5d7d1c-6f1d-4a65-9d7e-2c1a9c2f4b11",
  conversationId: "6a3c2d0e-8a8b-5c1f-9e0a-1d2b3c4d5e6f",
  repoId: "github/octo/hello",
  name: "feature/one",
  mode: "open",
  access: "owner",
  shared: false,
}

describe("the branch client", () => {
  test("an unavailable optional workspace keeps the access refusal", async () => {
    expect(await client(async () => new Response(null, {
      status: 204, headers: { "x-branch-state": "forbidden" },
    }))).toEqual(new TrackRefused({ status: 403, code: "forbidden" }))
    expect(await client(async () => new Response(null, { status: 204 }))).toEqual(new TrackRefused({ status: 204 }))
    expect(await client(async () => new Response(null, {
      status: 204, headers: { "x-branch-state": "not_found" },
    }))).toEqual(new TrackRefused({ status: 404, code: "not_found" }))
  })

  test("posts the branch; 200 or 201 with the branch is tracked, and anything else is a TrackRefused", async () => {
    const posted: Array<{ readonly url: string; readonly body: unknown }> = []
    const recording: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      posted.push({ url: request.url, body: await request.json() })
      return Response.json(trackedBody, { status: 201 })
    }
    expect(await client(recording)).toEqual(trackedBody)
    expect(posted).toEqual([{ url: "http://chat.test/api/branches?optional=true", body: { owner: "octo", name: "hello", ref: "feature/one" } }])
    expect(await client(async () => Response.json(trackedBody))).toEqual(trackedBody)

    expect(await client(() => Promise.reject(new TypeError("offline")))).toEqual(new TrackRefused({}))
    expect(await client(() => new Promise(() => {}), "50 millis")).toEqual(new TrackRefused({}))
    expect(await client(async () => Response.json({ code: "not_found" }, { status: 404 }))).toEqual(
      new TrackRefused({ status: 404, code: "not_found" }),
    )
    // A code the contract doesn't name, or no JSON at all, is still a refusal, by its status.
    expect(await client(async () => Response.json({ code: "teapot" }, { status: 418 }))).toEqual(
      new TrackRefused({ status: 418 }),
    )
    expect(await client(async () => new Response("busy", { status: 503 }))).toEqual(new TrackRefused({ status: 503 }))
    const cut = new ReadableStream({ start: (controller) => controller.error(new TypeError("cut")) })
    expect(await client(async () => new Response(cut, { status: 502 }))).toEqual(new TrackRefused({ status: 502 }))
    // A success outside the contract can't be shown: refused, by its status.
    expect(await client(async () => Response.json({ branchId: 1 }, { status: 200 }))).toEqual(
      new TrackRefused({ status: 200 }),
    )
  })
})

describe("the step", () => {
  /** `branch/track/request` over a client that answers `answer`: how it ended, and every record it left. */
  const step = async (answer: typeof globalThis.fetch, branch = "feature/one", create = false, openedAt?: number) => {
    const registry: Metric.MetricRegistry = new Map()
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
    const exit = await Effect.runPromise(
      requestTrack({ repo: "octo/hello", branch, openedAt }, create).pipe(
        Effect.match({ onSuccess: (tracked) => ({ tracked }), onFailure: (failed) => ({ failed }) }),
        Effect.provide(
          BranchClient.layer({ origin: "http://chat.test", within: "50 millis" }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, answer)),
          ),
        ),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    const count = (outcome: string) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(tracks, { outcome })).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count
    return { exit, logs, count }
  }

  test("an unconfigured forge remains a final refusal with its own count", async () => {
    const result = await step(async () => Response.json({ code: "not_configured" }, { status: 503 }))
    expect(result.exit).toEqual({ failed: new BranchTrackRefused({ reason: "not_configured" }) })
    expect(result.count("not_configured")).toBe(1)
    expect(result.logs[0]).toMatchObject({ level: "WARN", annotations: { outcome: "not_configured", status: 503 } })
  })

  test("the explicit create request sends and records creation without logging the branch name", async () => {
    const posted: unknown[] = []
    const result = await step(async (input, init) => {
      posted.push(await new Request(input, init).json())
      return Response.json(trackedBody, { status: 201 })
    }, "private-create", true, 42)
    expect(posted).toEqual([{ owner: "octo", name: "hello", ref: "private-create", create: true, openedAt: 42 }])
    expect(result.exit).toEqual({ tracked: trackedBody })
    expect(result.count("tracked")).toBe(1)
    expect(result.logs[0]).toMatchObject({ level: "INFO", annotations: { create: true, outcome: "tracked" } })
    expect(JSON.stringify(result.logs)).not.toContain("private-create")
  })

  test.each<[number, BranchTrackRefused | BranchTrackUnavailable, string]>([
    [400, new BranchTrackRefused({ reason: "invalid" }), "invalid"],
    [413, new BranchTrackRefused({ reason: "invalid" }), "invalid"],
    [401, new BranchTrackRefused({ reason: "sign_in" }), "sign_in"],
    [403, new BranchTrackRefused({ reason: "forbidden" }), "forbidden"],
    [404, new BranchTrackRefused({ reason: "not_found" }), "not_found"],
    [503, new BranchTrackUnavailable(), "unavailable"],
    [409, new BranchTrackUnavailable(), "unavailable"],
  ])("ChatApi's %s is %s, counted and logged by its outcome and status", async (status, failure, outcome) => {
    const { exit, logs, count } = await step(async () => Response.json({ code: "x" }, { status }))

    expect(exit).toEqual({ failed: failure })
    expect(count(outcome)).toBe(1)
    expect(logs).toEqual([
      expect.objectContaining({
        level: "WARN",
        message: "branch.track",
        annotations: expect.objectContaining({ outcome, status, feature: "branch", durationMs: expect.any(Number) }),
      }),
    ])
  })

  test("ChatApi's 409 exists, a name the forge already has, is refused exists and never tried again; another 409 is unavailable", async () => {
    const exists = await step(async () => Response.json({ code: "exists" }, { status: 409 }))
    expect(exists.exit).toEqual({ failed: new BranchTrackRefused({ reason: "exists" }) })
    expect(exists.count("exists")).toBe(1)
    const locked = await step(async () => Response.json({ code: "locked" }, { status: 409 }))
    expect(locked.exit).toEqual({ failed: new BranchTrackUnavailable() })
  })

  test("tracked is counted and logged as Info; no answer at all is unavailable, with no status; never the branch's name", async () => {
    const sentinel = "feature/sentinel-41c9"
    const tracked = await step(async () => Response.json({ ...trackedBody, name: sentinel }, { status: 201 }), sentinel)
    expect(tracked.exit).toEqual({ tracked: { ...trackedBody, name: sentinel } })
    expect(tracked.count("tracked")).toBe(1)
    expect(tracked.logs).toEqual([
      expect.objectContaining({
        level: "INFO",
        message: "branch.track",
        annotations: expect.objectContaining({ outcome: "tracked", feature: "branch" }),
      }),
    ])
    expect(tracked.logs[0]!.annotations).not.toHaveProperty("status")

    const stalled = await step(() => new Promise(() => {}), sentinel)
    expect(stalled.exit).toEqual({ failed: new BranchTrackUnavailable() })
    expect(stalled.count("unavailable")).toBe(1)
    expect(stalled.logs[0]).toMatchObject({ level: "WARN", annotations: { outcome: "unavailable" } })
    expect(stalled.logs[0]!.annotations).not.toHaveProperty("status")

    expect(JSON.stringify([tracked.logs, stalled.logs])).not.toContain("sentinel")
  })
})


describe("leaving a branch navigation", () => {
  test.each(["track", "join", "editor", "terminal"] as const)("a late %s answer cannot restore cleaned-up state", async (stage) => {
    const tab = await open()
    const real = await tab.runtime.runPromise(Effect.service(Branch))
    const terminal = await tab.runtime.runPromise(Effect.service(Terminal))
    const store = await tab.runtime.runPromise(Effect.service(PresenceStore))
    real.presence.queries.room.startSyncImmediate()
    terminal.queries.panel.startSyncImmediate()
    const reached = await tab.runtime.runPromise(Deferred.make<void>())
    const release = await tab.runtime.runPromise(Deferred.make<void>())
    // Fault injection into the Effect service: a real action completes, but its answer arrives after cleanup.
    const delay = <A>(answer: Promise<A>): Promise<A> => tab.runtime.runPromise(Effect.gen(function* () {
      const value = yield* Effect.promise(() => answer)
      yield* Deferred.succeed(reached, undefined)
      yield* Deferred.await(release)
      return value
    }))
    const faulty = Branch.of({
      ...real,
      actions: { ...real.actions, open: (...args) => stage === "track" ? delay(real.actions.open(...args)) : real.actions.open(...args) },
      presence: { ...real.presence, actions: { ...real.presence.actions,
        join: (id) => stage === "join" ? delay(real.presence.actions.join(id)) : real.presence.actions.join(id),
      } },
      coedit: { ...real.coedit, actions: { ...real.coedit.actions,
        showFile: (...args) => stage === "editor" ? delay(real.coedit.actions.showFile(...args)) : real.coedit.actions.showFile(...args),
      } },
    })
    const delayedTerminal = Terminal.of({ ...terminal, actions: { ...terminal.actions,
      showInBackground: (id, watching, shown, signal) => terminal.actions.showInBackground(
        id, watching,
        (terminalId) => stage === "terminal" ? delay(Promise.resolve(terminalId)).then(shown) : shown(terminalId),
        signal,
      ),
    } })
    const controller = new AbortController()
    const opening = openBranchPage(faulty, delayedTerminal, controller.signal,
      { owner: "octo", repo: "hello", ref: "feature/one" }, { terminal: "me" })
    try {
      await tab.runtime.runPromise(Deferred.await(reached))
      controller.abort()
      await real.presence.actions.leave()
      await real.coedit.actions.hideFiles()
      await terminal.actions.show(null)
    } finally {
      await tab.runtime.runPromise(Deferred.succeed(release, undefined))
    }
    await opening
    expect(real.presence.queries.room.toArray[0]).toMatchObject({ status: "idle", branchId: null })
    expect(terminal.queries.panel.toArray[0]).toMatchObject({ phase: "idle", branchId: null })
    expect(await tab.runtime.runPromise(Ref.get(store.where))).toBeNull()
  }, WITHIN)
})


describe("cancelling in-flight branch actions", () => {
  test.each(["terminal", "editor"] as const)("a pending %s action is interrupted before it can restore state", async (stage) => {
    const tab = await open()
    const branchId = (await tab.actions.open("octo", "hello", "feature/one"))!
    const reached = await tab.runtime.runPromise(Deferred.make<void>())
    const release = await tab.runtime.runPromise(Deferred.make<void>())
    const wait = Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(release))
    const terminalStore = await tab.runtime.runPromise(Effect.service(TerminalStore))
    const coeditStore = await tab.runtime.runPromise(Effect.service(CoeditStore))
    const terminal = await tab.runtime.runPromise(Terminal.make.pipe(Effect.provideService(TerminalStore, {
      ...terminalStore,
      terminals: (id) => Effect.andThen(wait, terminalStore.terminals(id)),
    })))
    const coedit = await tab.runtime.runPromise(Coedit.make.pipe(Effect.provideService(CoeditStore, {
      ...coeditStore,
      open: (of) => Effect.andThen(wait, coeditStore.open(of)),
    })))
    const controller = new AbortController()
    const pending = stage === "terminal"
      ? terminal.actions.show(branchId, undefined, controller.signal)
      : coedit.actions.showFile(branchId, "README.md", controller.signal)
    // Observe rejection immediately: aborting a real Effect rejects its Promise with interruption.
    const settled = pending.then(() => "completed", () => "interrupted")
    await tab.runtime.runPromise(Deferred.await(reached))
    controller.abort()
    await terminal.actions.show(null)
    await coedit.actions.hideFiles()
    await tab.runtime.runPromise(Deferred.succeed(release, undefined))
    expect(await settled).toBe("interrupted")
    expect(await tab.runtime.runPromise(terminalStore.panel.toArray)).toMatchObject([{ branchId: null, phase: "idle" }])
    expect((await tab.runtime.runPromise(coeditStore.texts.toArray)).filter((row) => row.kind === "file" && row.shown)).toEqual([])
  }, WITHIN)
})


test("cancelling a room join while the previous connection is closing cannot rejoin", async () => {
  const tab = await open()
  const branchId = (await tab.actions.open("octo", "hello", "feature/one"))!
  const store = await tab.runtime.runPromise(Effect.service(PresenceStore))
  const presence = await tab.runtime.runPromise(Effect.service(Presence))
  const started = await tab.runtime.runPromise(Deferred.make<void>())
  const closing = await tab.runtime.runPromise(Deferred.make<void>())
  const release = await tab.runtime.runPromise(Deferred.make<void>())
  // A real attached fiber whose finalizer waits, as a slow socket teardown does.
  await tab.runtime.runPromise(FiberHandle.run(store.attached, Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.andThen(Deferred.succeed(closing, undefined), Deferred.await(release)))
    yield* Deferred.succeed(started, undefined)
    yield* Effect.never
  }).pipe(Effect.scoped)))
  await tab.runtime.runPromise(Deferred.await(started))
  const controller = new AbortController()
  const settled = presence.actions.join(branchId, controller.signal).then(() => "completed", () => "interrupted")
  await tab.runtime.runPromise(Deferred.await(closing))
  controller.abort()
  const leaving = presence.actions.leave()
  await tab.runtime.runPromise(Deferred.succeed(release, undefined))
  await leaving
  expect(await settled).toBe("interrupted")
  expect(await tab.runtime.runPromise(store.room.toArray)).toMatchObject([{ branchId: null, status: "idle" }])
}, WITHIN)


test("a branch page handles missing branches, editor locations, aborts and action failures", async () => {
  const tab = await open()
  const branch = await tab.runtime.runPromise(Effect.service(Branch))
  const terminal = await tab.runtime.runPromise(Effect.service(Terminal))
  const presence = await tab.runtime.runPromise(Effect.service(PresenceStore))
  terminal.queries.panel.startSyncImmediate()
  const params = { owner: "octo", repo: "hello", ref: "feature/one" }
  const absent = { owner: "", repo: "", ref: "" }
  await openBranchPage(branch, terminal, AbortSignal.abort(), params, {})
  expect(tab.current()).toMatchObject(none)

  await openBranchPage(branch, terminal, new AbortController().signal, absent, {})
  expect(terminal.queries.panel.toArray[0]).toMatchObject({ branchId: null, phase: "idle" })
  expect(await tab.runtime.runPromise(Ref.get(presence.where))).toBeNull()

  // The real terminal clears its panel, but the route is cancelled before its answer arrives.
  const abortAfterShow = (controller: AbortController) => Terminal.of({
    ...terminal,
    actions: { ...terminal.actions, show: async (...args) => {
      const answer = await terminal.actions.show(...args)
      controller.abort()
      return answer
    } },
  })
  for (const of of [absent, params]) {
    const controller = new AbortController()
    await openBranchPage(branch, abortAfterShow(controller), controller.signal, of, {})
    expect(controller.signal.aborted).toBe(true)
    expect(await tab.runtime.runPromise(Ref.get(presence.where))).toBeNull()
  }

  await openBranchPage(branch, terminal, new AbortController().signal, params, {})
  expect(await tab.runtime.runPromise(Ref.get(presence.where))).toEqual({ view: "code", path: "" })
  await openBranchPage(branch, terminal, new AbortController().signal, params, { edit: "README.md" })
  expect(await tab.runtime.runPromise(Ref.get(presence.where))).toEqual({ view: "edit", path: "README.md" })

  const failure = new Error("branch action failed")
  const failing = Branch.of({ ...branch, actions: { ...branch.actions,
    open: () => tab.runtime.runPromise(Effect.fail(failure)),
  } })
  await expect(openBranchPage(failing, terminal, new AbortController().signal, params, {})).rejects.toBe(failure)
  const controller = new AbortController()
  const cancelled = Branch.of({ ...branch, actions: { ...branch.actions,
    open: () => tab.runtime.runPromise(Effect.andThen(Effect.sync(() => controller.abort()), Effect.fail(failure))),
  } })
  await expect(openBranchPage(cancelled, terminal, controller.signal, params, {})).resolves.toBeUndefined()
  await branch.presence.actions.leave()
  await branch.coedit.actions.hideFiles()
  await terminal.actions.show(null)
}, WITHIN)

test("a blob page's Markdown file opens in the live editor in place only for someone who may write the branch", async () => {
  const tab = await open()
  const branch = await tab.runtime.runPromise(Effect.service(Branch))
  const terminal = await tab.runtime.runPromise(Effect.service(Terminal))
  const presence = await tab.runtime.runPromise(Effect.service(PresenceStore))
  const coedit = await tab.runtime.runPromise(Effect.service(CoeditStore))
  const shownFiles = async () =>
    (await tab.runtime.runPromise(coedit.texts.toArray)).filter((row) => row.kind === "file" && row.shown).map((row) => row.key)
  // Nothing tracked yet: nobody may write.
  expect(branch.actions.writable()).toBe(false)
  const page = (ref: string, file: string) =>
    openBranchPage(branch, terminal, new AbortController().signal, { owner: "octo", repo: "hello", ref, _splat: file }, { file })

  // The person's own new branch is open to changes: its Markdown file's page is the live editor's text, and presence
  // still says they read the code there.
  await page("feature/one", "docs/guide.md")
  expect(branch.actions.writable()).toBe(true)
  const conversation = await conversationOf(tab.current()!.branchId!)
  expect(await shownFiles()).toEqual([`${conversation}/docs/guide.md`])
  expect(await tab.runtime.runPromise(Ref.get(presence.where))).toEqual({ view: "code", path: "docs/guide.md" })

  // A code file's page edits nothing in place: the editor's room is left.
  await page("feature/one", "src/app.ts")
  expect(await shownFiles()).toEqual([])

  // The default branch is locked: Can edit, but nothing changes it but a merge, so its Markdown stays read-only.
  await page("main", "README.md")
  expect(tab.current()).toMatchObject({ name: "main", access: "edit", mode: "locked" })
  expect(branch.actions.writable()).toBe(false)
  expect(await shownFiles()).toEqual([])

  // A branch GitHub doesn't have is no branch to write.
  await page("gone", "README.md")
  expect(branch.actions.writable()).toBe(false)
  expect(await shownFiles()).toEqual([])
  await branch.presence.actions.leave()
  await branch.coedit.actions.hideFiles()
  await terminal.actions.show(null)
}, WITHIN)

test("an open's time is the page's when it gave one, else the clock's now, which the stamp step records once", async () => {
  expect(await Effect.runPromise(stampOpen({ repo: "octo/hello", branch: "main", openedAt: 5 })))
    .toEqual({ repo: "octo/hello", branch: "main", openedAt: 5 })
  const now = await Effect.runPromise(stampOpen({ repo: "octo/hello", branch: "main" }))
  expect(Math.abs(now.openedAt - Date.now())).toBeLessThan(5_000)
})
