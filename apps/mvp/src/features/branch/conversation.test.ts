// One conversation per branch (decision 0013 §1, docs/features/branch-workspace.md#the-conversation): chat, the views and
// a person's `/web` on the browser's own layer (`appLayer`) over a Node device whose engine leads, against ChatApi's
// real handler over the compose Postgres and Electric (src/test/chatApi.ts). Branches are recorded as `POST
// /api/branches` records them; another device asks in a branch's conversation through ChatApi's real questions route.
// Only the model is scripted. Unhappy paths get the faulty ChatApi client and shape source (src/test/faults.ts).
import { ShapeSource, SyncPolicy } from "@smthrs/effect-electric"
import { read as readTelemetry } from "../../test/otlp"
import type { Outbox } from "@smthrs/effect-tanstack-db"
import { Effect, type ManagedRuntime, Scheduler, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import * as Conversations from "../../../worker/branch/Conversations.ts"
import { shaOf } from "../../../worker/test/branch.ts"
import { framable } from "../../../worker/test/pages.ts"
import { member, nodeDevice, openFaultyApp, openTestApp, type TabOptions, TestChatApi } from "../../test/chatApi"
import { QuestionFaults, ShapeRecovery } from "../../test/faults"
import { AuthStore, SESSION } from "../auth/store"
import { Chat } from "../chat/chat"
import { COULDNT_ANSWER, QUESTIONS_ROUTE } from "../chat/contract"
import { ChatStore } from "../chat/store"
import { Commands } from "../commands/commands"
import { ViewsStore } from "../views/store"
import { Views } from "../views/views"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long a flow may take on the device's engine, its first start included, on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: flows on a fresh device's engine, each with its first start, on a loaded machine. */
const WITHIN = 90_000

// A quick deadline and sync policy, so an outage shows in a test's time.
const quick: TabOptions = {
  unreachableAfter: "300 millis",
  confirmWithin: "1 second",
  retry: SyncPolicy.backoff({ initial: "20 millis", max: "50 millis" }),
}

/** A tab on `runtime`, signed in as a Member, with the live queries React starts on first render. */
const tabOn = async <R, E>(
  runtime: ManagedRuntime.ManagedRuntime<R | Chat | ChatStore | Views | ViewsStore | Commands | AuthStore | TestChatApi, E>,
) => {
  runtimes.push(runtime)
  const chat = await runtime.runPromise(Effect.service(Chat))
  const store = await runtime.runPromise(Effect.service(ChatStore))
  const views = await runtime.runPromise(Effect.service(Views))
  const commands = await runtime.runPromise(Effect.service(Commands))
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  for (const query of [chat.queries.conversation, chat.queries.place, chat.queries.history, views.queries.shown, views.queries.rowsIn(undefined), commands.queries.menu]) {
    query.startSyncImmediate()
  }
  // Signed in as sign-in's `load` sets it, so the composer offers the slash commands.
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  await until(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await runtime.runPromise(
    session.update(SESSION, (row) =>
      void Object.assign(row, { status: "signed_in", login: member.subject.id, role: member.role })),
  )
  const sql = <A>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
    runtime.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, statement)))
  /** The conversation `conversationId` as a person reads it (the home one for `null`): role, status and text. */
  const shown = (conversationId: string | null) => {
    const window = chat.queries.of(conversationId)
    window.conversation.startSyncImmediate()
    // A view renders from its own row, by id (src/features/views/views.ts `rowsIn`).
    const rows = views.queries.rowsIn(conversationId ?? undefined)
    rows.startSyncImmediate()
    return window.conversation.toArray.map((row) =>
      row.role === "view"
        ? `view ${row.template} ${(rows.toArray.find((view) => view.id === row.id)?.props as { url?: string } | undefined)?.url}`
        : `${row.role} ${row.status} ${row.text}`
    )
  }
  return {
    runtime,
    api,
    chat,
    store,
    views,
    commands,
    shown,
    history: (conversationId: string | null) => {
      const { history } = chat.queries.of(conversationId)
      history.startSyncImmediate()
      return history.toArray[0]
    },
    place: () => chat.queries.place.toArray[0]?.conversationId,
    /** Branch `name` of `octo/hello`, recorded as `POST /api/branches` records it: its conversation's id. */
    branch: (name: string) =>
      runtime.runPromise(api.branches.run(Conversations.track("github/octo/hello", name, "open", shaOf(name))))
        .then((tracked) => tracked.branch.conversationId),
    /** Asks `text` in conversation `conversationId` as another device does, through ChatApi. */
    askIn: async (conversationId: string, text: string) => {
      const ids = { id: crypto.randomUUID(), answerId: crypto.randomUUID() }
      const response = await api.fetch(`${api.origin}${QUESTIONS_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...ids, text, conversationId }),
      })
      if (response.status !== 202) throw new Error(`ChatApi answered ${response.status}`)
      return ids
    },
    /** The texts of conversation `conversationId`'s messages in Postgres, in order. */
    rows: (conversationId: string) =>
      sql((sql) =>
        sql<{ readonly text: string }>`SELECT text FROM messages WHERE conversation_id = ${conversationId} ORDER BY position`
      ).then((rows) => rows.map(({ text }) => text)),
    /** The views of conversation `conversationId` in Postgres: their pages. */
    viewsIn: (conversationId: string) =>
      sql((sql) =>
        sql<{ readonly url: string }>`SELECT props->>'url' AS url FROM views WHERE conversation_id = ${conversationId}`
      ).then((rows) => rows.map(({ url }) => url)),
  }
}

const openChat = (options: TabOptions = {}) => tabOn(openTestApp(options))

const asked = (result: Awaited<ReturnType<Chat["Service"]["actions"]["ask"]>>) => {
  if (!result.asked) throw new Error(`the question was refused: ${result.reason}`)
  return result
}

describe("a branch's conversation", () => {
  test("is its own: what is asked there syncs to it and never home, and home keeps its own", async () => {
    const tab = await openChat()
    const branch = await tab.branch("feature/one")
    await tab.chat.actions.show(branch)
    expect(tab.place()).toBe(branch)

    const { answerId } = asked((await tab.chat.actions.ask("asked in the branch")))
    expect(tab.shown(branch)).toEqual(["user queued asked in the branch"])
    await until(() => expect(tab.shown(branch)).toEqual(["user done asked in the branch", "assistant streaming "]))
    const reply = await tab.runtime.runPromise(tab.api.answerTo("asked in the branch"))
    reply.say("Here.")
    reply.done()
    await until(() => expect(tab.shown(branch)).toEqual(["user done asked in the branch", "assistant done Here."]))
    expect(tab.store.opened(branch)?.messages.tanstack.get(answerId)?.conversationId).toBe(branch)
    expect(await tab.rows(branch)).toEqual(["asked in the branch", "Here."])
    expect(tab.shown(null)).toEqual([])

    // Showing it again changes nothing; home asks at home.
    await tab.chat.actions.show(branch)
    expect(tab.place()).toBe(branch)
    await tab.chat.actions.show(null)
    expect(tab.place()).toBeNull()
    asked((await tab.chat.actions.ask("asked at home")))
    await until(() => expect(tab.shown(null)).toEqual(["user done asked at home", "assistant streaming "]))
    expect(tab.shown(branch)).toEqual(["user done asked in the branch", "assistant done Here."])
  }, WITHIN)

  test("a question keeps the conversation it was asked in, however the tab moves before it is delivered", async () => {
    const tab = await openChat()
    const [first, second] = [await tab.branch("feature/one"), await tab.branch("feature/two")]
    await tab.chat.actions.show(first)

    asked((await tab.chat.actions.ask("asked in the first")))
    await tab.chat.actions.show(second)

    await until(() => expect(tab.shown(first)).toEqual(["user done asked in the first", "assistant streaming "]))
    // The send waited for its own conversation's delivery, then let go of the question.
    await until(() => expect(tab.store.asking.tanstack.size).toBe(0))
    expect(tab.shown(second)).toEqual([])
    expect(tab.shown(null)).toEqual([])
    expect(await tab.rows(first)).toEqual(["asked in the first", ""])
  }, WITHIN)

  test("a frontend reads a branch's window once it is shown, and home's for none or one not opened", async () => {
    const tab = await openChat()
    const branch = await tab.branch("feature/one")
    const home = tab.chat.queries.of(null)
    expect(home.conversation).toBe(tab.chat.queries.conversation)
    expect(home.history).toBe(tab.chat.queries.history)
    expect(tab.chat.queries.of(undefined).conversation).toBe(tab.chat.queries.conversation)
    expect(tab.chat.queries.of(branch).conversation).toBe(tab.chat.queries.conversation)

    await tab.chat.actions.show(branch)

    expect(tab.chat.queries.of(branch).conversation).toBe(tab.store.opened(branch)!.shown.tanstack)
    expect(tab.chat.queries.of(branch).history).toBe(tab.store.opened(branch)!.historyState.tanstack)
    expect(tab.chat.queries.of(crypto.randomUUID()).conversation).toBe(tab.chat.queries.conversation)
  }, WITHIN)

  test("two callers opening one conversation at once open it once", async () => {
    const tab = await openChat()
    const branch = await tab.branch("feature/one")

    // Each fiber yields every 16 operations, so the two interleave: the second asks while the first opens it.
    const [first, second] = await tab.runtime.runPromise(
      Effect.all([tab.store.open(branch), tab.store.open(branch)], { concurrency: 2 }).pipe(
        Effect.provideService(Scheduler.MaxOpsBeforeYield, 16),
      ),
    )

    expect(second).toBe(first)
    expect(tab.store.opened(branch)).toBe(first)
    expect(first.messages.id).toBe(`chat-messages:${branch}`)
  }, WITHIN)

  test("Retry on a failed answer asks its question again in the conversation shown", async () => {
    const tab = await openChat()
    const branch = await tab.branch("feature/one")
    await tab.chat.actions.show(branch)
    const first = asked((await tab.chat.actions.ask("hello branch")))
    const reply = await tab.runtime.runPromise(tab.api.answerTo("hello branch"))
    reply.fail()
    await until(() => expect(tab.shown(branch)).toEqual(["user done hello branch", `assistant failed ${COULDNT_ANSWER}`]))

    tab.chat.actions.retryAnswer(first.answerId)

    await until(() => expect(tab.shown(branch)).toHaveLength(4))
    expect((await tab.rows(branch)).filter((text) => text === "hello branch")).toHaveLength(2)
    expect(tab.shown(null)).toEqual([])
    // A retry of something that isn't a failed answer with its question changes nothing.
    tab.chat.actions.retryAnswer(first.questionId)
    tab.chat.actions.retryAnswer("not-there")
    expect(tab.shown(branch)).toHaveLength(4)
  }, WITHIN)

  test("Load earlier widens the window of the conversation shown, from the device", async () => {
    const tab = await openChat({ pageSize: 2 })
    const branch = await tab.branch("feature/one")
    await tab.chat.actions.show(branch)
    for (const text of ["one", "two"]) {
      const { answerId } = await tab.askIn(branch, text)
      await until(() => expect(tab.store.opened(branch)?.messages.tanstack.has(answerId)).toBe(true))
    }
    await until(() => expect(tab.history(branch)).toMatchObject({ opened: true, earlier: true, limit: 2 }))
    expect(tab.shown(branch)).toEqual(["user done two", "assistant streaming "])

    tab.chat.actions.loadEarlier()

    expect(tab.history(branch)).toMatchObject({ earlier: false, limit: 4 })
    await until(() =>
      expect(tab.shown(branch)).toEqual(["user done one", "assistant streaming ", "user done two", "assistant streaming "])
    )
    // Home's window is its own.
    expect(tab.history(null)).toMatchObject({ limit: 2, earlier: false })
  }, WITHIN)
})

describe("a branch's unsent questions", () => {
  test("a refused question stays unsent in the conversation it was asked in, never home", async () => {
    const tab = await tabOn(openFaultyApp(quick))
    const questions = await tab.runtime.runPromise(Effect.service(QuestionFaults))
    const branch = await tab.branch("feature/one")
    await tab.chat.actions.show(branch)
    tab.runtime.runSync(questions.failNext("bad_request"))

    const { questionId } = asked((await tab.chat.actions.ask("refused in the branch")))

    await until(() => expect(tab.shown(branch)).toEqual(["user unsent refused in the branch"]))
    expect(tab.store.unsent.tanstack.get(questionId)).toMatchObject({ reason: "refused", conversationId: branch })
    expect(tab.shown(null)).toEqual([])
    expect(await tab.rows(branch)).toEqual([])
  }, WITHIN)

  test("a question the outbox couldn't take is sent again to the conversation it was asked in", async () => {
    // The outbox's storage behind a switch: a write it refuses is a question the outbox couldn't take.
    const device = nodeDevice()
    const real = device.outbox.storage
    const refusing = { now: false }
    const storage: Outbox.Options<never>["storage"] = {
      get: (key) => real.get(key),
      keys: () => real.keys(),
      delete: (key) => real.delete(key),
      clear: () => real.clear(),
      set: (key, value) => (refusing.now ? Promise.reject(new Error("quota")) : real.set(key, value)),
    }
    const tab = await tabOn(openTestApp({ host: { ...device, outbox: { ...device.outbox, storage } } }))
    const branch = await tab.branch("feature/one")
    await tab.chat.actions.show(branch)
    refusing.now = true
    const { questionId } = asked((await tab.chat.actions.ask("kept in the branch")))
    await until(() => expect(tab.shown(branch)).toEqual(["user unsent kept in the branch"]))
    // Home now: Retry still sends it where it was asked.
    await tab.chat.actions.show(null)
    refusing.now = false

    tab.chat.actions.resendUnsent(questionId)

    await until(() => expect(tab.shown(branch)).toEqual(["user done kept in the branch", "assistant streaming "]))
    expect(tab.shown(null)).toEqual([])
    expect(await tab.rows(branch)).toEqual(["kept in the branch", ""])
  }, WITHIN)
})

describe("syncing a branch's conversation", () => {
  test("Retry on the pill restarts a branch conversation's stopped shape too", async () => {
    const tab = await tabOn(openFaultyApp(quick))
    const shapes = await tab.runtime.runPromise(Effect.service(ShapeSource.Faults))
    const branch = await tab.branch("feature/one")
    await tab.chat.actions.show(branch)
    await tab.askIn(branch, "before the fault")
    await until(() => expect(tab.shown(branch)).toContain("user done before the fault"))
    const { messages } = tab.store.opened(branch)!
    const latest = () => tab.runtime.runPromise(Stream.runHead(messages.sync))

    // Electric's next live answer comes back cut short: the branch's shape stops, and stays stopped.
    tab.runtime.runSync(shapes.corrupt("live"))
    await tab.askIn(branch, "wake the shape")
    await until(async () => expect(await latest()).toMatchObject({ _tag: "Some", value: { _tag: "Stopped" } }))
    tab.runtime.runSync(shapes.heal)

    tab.chat.actions.retry()

    // The shape follows Postgres again.
    await until(async () => expect(await latest()).toMatchObject({ _tag: "Some", value: { _tag: "Sent" } }))
    await tab.askIn(branch, "after the restart")
    await until(() => expect(tab.shown(branch)).toContain("user done after the restart"))
    // The question in the answer that came back cut short reaches the device too: the restart asks for it again.
    expect(tab.shown(branch)).toContain("user done wake the shape")
  }, WITHIN)
})

describe("delivering to a branch's conversation", () => {
  test("a question ChatApi already had is done once its own conversation delivers it, not before", async () => {
    // ChatApi's 202 is cut short and the outbox's backoff is slow, so the question sits until Retry sends it again.
    const tab = await tabOn(openFaultyApp({ retry: quick.retry }))
    const questions = await tab.runtime.runPromise(Effect.service(QuestionFaults))
    const shapes = await tab.runtime.runPromise(Effect.service(ShapeSource.Faults))
    const branch = await tab.branch("feature/one")
    await tab.chat.actions.show(branch)
    await until(() => expect(tab.history(branch)).toMatchObject({ opened: true }))
    // Electric's answers are held, so the device doesn't have the question when ChatApi says it has (200).
    tab.runtime.runSync(shapes.stall())
    tab.runtime.runSync(questions.failNext("duplicate"))

    const { questionId } = asked((await tab.chat.actions.ask("sent twice")))

    // The answer's run started: the send is past it, waiting for its own conversation to deliver the question.
    await tab.runtime.runPromise(tab.api.answerTo("sent twice"))
    expect(tab.store.asking.tanstack.has(questionId)).toBe(true)
    expect(tab.shown(branch)).toEqual(["user queued sent twice"])
    tab.runtime.runSync(shapes.heal)
    await until(() => expect(tab.store.asking.tanstack.has(questionId)).toBe(false))
    expect(tab.shown(branch)).toEqual(["user done sent twice", "assistant streaming "])
    // The network sent it twice: ChatApi took the first and answered the second as one it had.
    expect(tab.api.questionStatuses()).toEqual([202, 200])
    expect(await tab.rows(branch)).toEqual(["sent twice", ""])
  }, WITHIN)

  test("a branch this device never showed is blank until its conversation arrives, never empty for a frame", async () => {
    const tab = await openChat()
    const branch = await tab.branch("feature/flicker")
    await tab.askIn(branch, "Asked before this device ever showed the branch")

    // Every time the conversation says it has opened, its messages are already on the device.
    await tab.chat.actions.show(branch)
    const state = tab.store.opened(branch)!
    const seen: Array<{ readonly opened: boolean; readonly messages: number }> = []
    const subscription = state.history.tanstack.subscribeChanges(() => {
      seen.push({ opened: state.history.tanstack.get("history")?.opened === true, messages: state.messages.tanstack.size })
    }, { includeInitialState: true })
    // The page reads the conversation as it shows it.
    tab.shown(branch)
    await until(() => expect([state.messages.tanstack.status, tab.history(branch)?.opened]).toEqual(["ready", true]))
    subscription.unsubscribe()
    expect(seen.filter((frame) => frame.opened)).not.toEqual([])
    expect(seen.filter((frame) => frame.opened && frame.messages === 0)).toEqual([])
  }, WITHIN)

  test("a new branch recovers its conversation and composer after three shape 503s without reload", async () => {
    const tab = await tabOn(openFaultyApp({ ...quick, shapeFailures: 3 }))
    const branch = await tab.branch("feature/recovery")
    await tab.chat.actions.show(branch)
    tab.shown(branch)
    await until(() => expect(tab.history(branch)).toMatchObject({ opened: true }))
    expect(await tab.runtime.runPromise(Effect.flatMap(ShapeRecovery, (fault) => fault.failures))).toBe(3)
    // Later healthy batches must not report another recovery or failure.
    const { id } = await tab.askIn(branch, "after recovery")
    await until(() => expect(tab.store.opened(branch)?.messages.tanstack.has(id)).toBe(true))
    await tab.runtime.dispose()
    const exports = tab.api.telemetry.map((entry) => entry.body).join("\n")
    expect(exports).toContain("chat load failed")
    expect(exports).toContain("chat load recovered")
    expect(exports).toContain("chat.messages")
    // One transition per surface, counted as log lines: the failure counter names the record too.
    const lines = readTelemetry(tab.api.telemetry)
    expect(lines.log("chat load failed")).toHaveLength(2)
    expect(lines.log("chat load recovered")).toHaveLength(2)
    expect(exports).not.toContain("after recovery")
  }, WITHIN)

  test("a network outage records status zero and recovers through the client's policy", async () => {
    const tab = await tabOn(openFaultyApp(quick, (faults) => faults.down()))
    const branch = await tab.branch("feature/network-recovery")
    await tab.chat.actions.show(branch)
    tab.shown(branch)
    const messages = tab.store.opened(branch)!.messages
    await until(async () => expect(await tab.runtime.runPromise(Stream.runHead(messages.sync))).toMatchObject({
      _tag: "Some", value: { _tag: "Failed" },
    }))
    await tab.runtime.runPromise(Effect.flatMap(ShapeSource.Faults, (faults) => faults.heal))
    await until(() => expect(tab.history(branch)).toMatchObject({ opened: true }))
    await tab.runtime.dispose()
    const exports = tab.api.telemetry.map((entry) => entry.body).join("\n")
    expect(exports).toContain("chat load failed")
    expect(exports).toContain("chat load recovered")
    expect(exports).toContain('"key":"status","value":{"intValue":0}')
  }, WITHIN)

  test("a branch with no messages at all opens empty once its shape has synced", async () => {
    const tab = await openChat()
    const branch = await tab.branch("feature/empty")
    await tab.chat.actions.show(branch)
    await until(() => expect(tab.history(branch)).toMatchObject({ opened: true }))
    expect(tab.shown(branch)).toEqual([])
  }, WITHIN)

  test("a cached branch opens its conversation while the reloaded device's shapes are offline", async () => {
    const device = nodeDevice()
    const first = await openChat({ host: device })
    const branch = await first.branch("feature/cached")
    await first.chat.actions.show(branch)
    await first.askIn(branch, "kept on this device")
    await until(() => expect(device.stored(`chat-messages:${branch}`)).toBe(2))
    await first.runtime.dispose()
    const offline = await tabOn(openFaultyApp({ ...quick, host: device }, (faults) => faults.down()))
    await offline.chat.actions.show(branch)
    await until(() => expect(offline.history(branch)).toMatchObject({ opened: true }))
    expect(offline.shown(branch)).toContain("user done kept on this device")
    expect(offline.history(branch)?.opened).toBe(true)
  }, WITHIN)

  test("a branch's conversation the device can't read stays blank, never empty", async () => {
    const device = nodeDevice()
    // A database that opens, then fails every statement: no conversation can be restored.
    const broken = {
      ...device,
      persistence: {
        ...device.persistence,
        open: () => ({ execute: () => Promise.reject(new Error("disk")), close: () => undefined }),
      },
    }
    const tab = await tabOn(openTestApp({ host: broken }))
    const branch = await tab.branch("feature/one")

    await tab.chat.actions.show(branch)

    const { messages } = tab.store.opened(branch)!
    await until(() => expect(messages.tanstack.status).toBe("error"))
    expect(tab.history(branch)).toMatchObject({ opened: false })
  }, WITHIN)
})

describe("pages in a branch's conversation", () => {
  /** The app with example.com's pages on the outside web, framed when opened (worker/test/pages.ts). */
  const openWithPages = () =>
    tabOn(openTestApp({}, { pages: { "https://example.com/": framable(), "https://example.com/docs": framable() } }))

  test("a person's /web lands in the branch they sent it from, even when the tab moves before its step runs", async () => {
    const tab = await openWithPages()
    const [from, to] = [await tab.branch("feature/from"), await tab.branch("feature/to")]
    await tab.chat.actions.show(to)
    await tab.chat.actions.show(from)

    await tab.commands.actions.type("/web https://example.com/")
    await tab.commands.actions.submit("/web https://example.com/")
    // The tab moves to another branch at once; the flow's steps run on the engine after.
    await tab.chat.actions.show(to)

    await until(() => expect(tab.shown(from)).toEqual(["view webpage https://example.com/"]))
    expect(tab.place()).toBe(to)
    expect(tab.shown(to)).toEqual([])
    expect(tab.shown(null)).toEqual([])
    expect(await tab.viewsIn(from)).toEqual(["https://example.com/"])
    expect(await tab.viewsIn(to)).toEqual([])
  }, WITHIN)

  test("the full-screen route shows a branch's view from that branch, and home's for none or one never opened", async () => {
    const tab = await openWithPages()
    const [branch, other] = [await tab.branch("feature/one"), await tab.branch("feature/two")]
    await tab.chat.actions.show(branch)
    tab.commands.actions.type("/web https://example.com/docs")
    tab.commands.actions.submit("/web https://example.com/docs")
    await until(() => expect(tab.shown(branch)).toEqual(["view webpage https://example.com/docs"]))
    const viewId = tab.chat.queries.of(branch).conversation.toArray[0]!.id
    await tab.chat.actions.show(null)

    await tab.views.actions.show(viewId, branch)

    const inBranch = tab.views.queries.shownIn(branch)
    inBranch.startSyncImmediate()
    await until(() => expect(inBranch.toArray).toEqual([expect.objectContaining({ id: viewId, props: expect.objectContaining({ url: "https://example.com/docs" }) })]))
    // Home's own query for none, or a conversation this tab never opened: the view isn't home's.
    expect(tab.views.queries.shownIn(undefined)).toBe(tab.views.queries.shown)
    expect(tab.views.queries.shownIn(crypto.randomUUID())).toBe(tab.views.queries.shown)
    expect(tab.views.queries.shown.toArray).toEqual([])
    // Another branch's view route opens that branch's views, which don't have it.
    await tab.views.actions.show(viewId, other)
    const inOther = tab.views.queries.shownIn(other)
    expect(inOther).not.toBe(tab.views.queries.shown)
    inOther.startSyncImmediate()
    await tab.runtime.runPromise(
      Effect.flatMap(Effect.flatMap(ViewsStore, (views) => views.forConversation(other)), (views) => views.preload),
    )
    expect(inOther.toArray).toEqual([])
  }, WITHIN)

  test("the agent's page lands in its answer's conversation, however the asking tab moved", async () => {
    const tab = await openWithPages()
    const [asking, moved] = [await tab.branch("feature/asking"), await tab.branch("feature/moved")]
    await tab.chat.actions.show(moved)
    await tab.chat.actions.show(asking)
    asked((await tab.chat.actions.ask("Show me example.com")))
    const call = await tab.runtime.runPromise(tab.api.answerTo("Show me example.com"))

    // The person moves to another branch before the agent's call runs.
    await tab.chat.actions.show(moved)
    call.cell(`await ctx.call("app/web/open", { url: "https://example.com/" })`)
    const done = await tab.runtime.runPromise(tab.api.answerTo("Show me example.com", 1))
    done.say("Opened example.com.")
    done.done()

    await until(() =>
      expect(tab.shown(asking)).toEqual([
        "user done Show me example.com",
        "assistant done Opened example.com.",
        "view webpage https://example.com/",
      ])
    )
    expect(tab.shown(moved)).toEqual([])
    expect(tab.shown(null)).toEqual([])
    expect(await tab.viewsIn(moved)).toEqual([])
  }, WITHIN)
})
