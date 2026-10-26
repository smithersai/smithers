// Co-editing in the browser (decision 0013 §4, docs/features/coedit.md): the browser's own layer (`appLayer`) on Node
// devices whose engines lead, two people's, against ChatApi's real text routes and shapes (worker/branch/Texts.ts,
// src/test/chatApi.ts) over the compose Postgres and Electric, and real presence rooms on loopback (src/test/rooms.ts).
// The sandbox's `sandbox/Call` doesn't run here: a test settles each call's row with that flow's own `settle`, as it
// would.
import type { SandboxTools } from "@smthrs/sandbox"
import { PresenceProtocol, SharedText } from "@smthrs/sync"
import { type Duration, Effect, Exit, Layer, Logger, ManagedRuntime, Metric } from "effect"
import { Base64 } from "effect/encoding"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import { settle } from "../../../worker/flows/SandboxCall.ts"
import { shaOf } from "../../../worker/test/branch.ts"
import {
  asPerson,
  CHATAPI_ORIGIN,
  member,
  nodeDevice,
  openFaultyTab,
  openTab,
  openTestApp,
  type TabOptions,
  tabLayer,
  TestChatApi,
} from "../../test/chatApi"
import { EngineFaults } from "../../test/faults"
import { read as readTelemetry } from "../../test/otlp"
import { dialing, roomHost } from "../../test/rooms"
import { AuthStore, SESSION } from "../auth/store"
import { Branch } from "../branch/branch"
import { Chat } from "../chat/chat"
import { ChatStore } from "../chat/store"
import { Commands } from "../commands/commands"
import { postUpdate, TextsClient, UpdateNotTaken } from "./api"
import { textRoomRoute } from "./contract"
import { sends } from "./metrics"
import { CoeditStore, decodeCursor, encodeCursor, SAVED_MARK, savedMarkOf } from "./store"
import { answerOf, fileOf, openAnswerOf, promptOf, saveLabelOf } from "./view"
import { TextWrites } from "./writes"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const until = (assertion: () => void | Promise<void>, timeout = 60_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: fresh devices' engines and every change synced back, on a machine running the whole suite. */
const WITHIN = 240_000

const ben: Actor = { subject: { kind: "person", id: "person-ben" }, role: "member", login: "ben" }


/** One person's tab: their branch layer with its texts, their composer, and what they type with. */
const tab = async (
  runtime: ManagedRuntime.ManagedRuntime<Branch | Chat | ChatStore | Commands | AuthStore | TextWrites | CoeditStore, unknown>,
  login: string,
) => {
  const close = async () => {
    const index = closers.indexOf(close)
    if (index !== -1) closers.splice(index, 1)
    await runtime.dispose()
  }
  closers.push(close)
  const branch = await runtime.runPromise(Effect.service(Branch))
  const chat = await runtime.runPromise(Effect.service(Chat))
  const commands = await runtime.runPromise(Effect.service(Commands))
  const { sending } = await runtime.runPromise(Effect.service(TextWrites))
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  await until(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await runtime.runPromise(
    session.update(SESSION, (row) => void Object.assign(row, { status: "signed_in", login, role: "member" })),
  )
  branch.coedit.queries.texts.startSyncImmediate()
  branch.queries.current.startSyncImmediate()
  chat.queries.composer.startSyncImmediate()
  const texts = () => branch.coedit.queries.texts.toArray
  return {
    close,
    branch,
    coedit: branch.coedit.actions,
    type: commands.actions.type,
    submit: commands.actions.submit,
    texts,
    marks: (id: string) => runtime.runPromise(Effect.flatMap(CoeditStore, (store) => store.live(id)!.replica.marks)),
    prompt: () => promptOf(texts()),
    draft: () => chat.queries.composer.toArray[0]?.draft,
    saved: () => chat.queries.composer.toArray[0]?.saved,
    unsent: () => sending.tanstack.toArray.length,
    /** Resolves once the tab has put back the draft its device kept, as a reload does. */
    restored: async () => {
      await runtime.runPromise(Effect.flatMap(Effect.service(ChatStore), (store) => Effect.ignore(store.drafts.restored)))
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

/** A fresh ChatApi where Ben may sign in too, with GitHub's `octo/hello`; the rooms; the member's tab and Ben's. */
const open = async (options: Pick<TabOptions, "replace"> = {}) => {
  const rooms = await roomHost()
  closers.push(rooms.close)
  const as = (id: string, name: string, access: "read" | "write" = "write") => dialing(rooms.origin, { id, name, access })
  const runtime = openTestApp({ ...options, webSocket: as(member.subject.id, "member") }, { people: { ben } })
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  api.branches.github.publish("octo", "hello", {
    defaultBranch: "main",
    branches: { main: shaOf("main"), "feature/one": shaOf("feature/one"), "feature/two": shaOf("feature/two") },
  })
  const owner = await tab(runtime, member.subject.id)
  const benTab = (access: "read" | "write" = "write") =>
    tab(openTab(asPerson(api, "ben"), { webSocket: as("person-ben", "ben", access) }), "ben")
  /** Another tab of the member's, on `host` when given: a device's other tab. */
  const ownTab = (host?: ReturnType<typeof nodeDevice>) =>
    tab(openTab(api, { ...(host === undefined ? {} : { host }), webSocket: as(member.subject.id, "member") }), member.subject.id)
  /** Another tab of the member's on the faulty services, whose engine a test can refuse flows on. */
  const faultyTab = async () => {
    const faulty = openFaultyTab(api, { webSocket: as(member.subject.id, "member") })
    return { tab: await tab(faulty, member.subject.id), engine: await faulty.runPromise(Effect.service(EngineFaults)) }
  }
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(api.branches.run(effect))
  const count = (outcome: string) =>
    runtime.runSync(Metric.value(Metric.withAttributes(sends, { outcome }))).count
  return { api, rooms, owner, benTab, ownTab, faultyTab, run, count }
}

/** Shares branch `branchId` with `grantee` to `access`, as its owner does. */
const share = (sql: SqlClient.SqlClient, branchId: string, grantee: string, access: "view" | "edit") =>
  sql`INSERT INTO branch_shares (branch_id, grantee, login, access) VALUES (${branchId}, ${grantee}, 'ben', ${access})
    ON CONFLICT (branch_id, grantee) DO UPDATE SET access = EXCLUDED.access`

const shareWith = (opened: Awaited<ReturnType<typeof open>>, branchId: string, access: "view" | "edit") =>
  opened.run(Effect.flatMap(SqlClient.SqlClient, (sql) => share(sql, branchId, "person-ben", access)))

type Opened = Awaited<ReturnType<typeof open>>
type Tab = Awaited<ReturnType<Opened["ownTab"]>>

/** Whether `tab` shows its branch's prompt: the text its people type together. */
const showsPrompt = (tab: Tab) => tab.prompt()?.key === tab.branch.queries.current.toArray[0]?.conversationId

/**
 * Opens branch `ref` on the member's `tab`, the owner's, and shares it with Ben to edit, which makes its prompt one
 * text: resolves once `tab` shows it.
 */
const openShared = async (opened: Opened, tab: Tab, ref = "feature/one") => {
  const branchId = (await tab.branch.actions.open("octo", "hello", ref))!
  await shareWith(opened, branchId, "edit")
  await until(() => expect(showsPrompt(tab)).toBe(true))
  return branchId
}

/** The updates ChatApi stored, all texts'. */
const storedUpdates = async (opened: Opened) =>
  (await opened.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly count: number }>`SELECT count(*)::int AS count FROM text_updates`)))[0]!.count

describe("whose prompt is shared", () => {
  test("a person's own branch and the home conversation keep the draft on the device: another tab never shows it", async () => {
    const opened = await open()
    const device = nodeDevice({ agent: opened.api })
    const one = await opened.ownTab(device)
    const two = await opened.ownTab(device)
    await two.restored()
    // Two tabs of one device, both at home: what one types stays in its composer, kept on the device, never sent.
    one.type("home draft", { anchor: 10, head: 10 })
    await until(() => expect(device.stored("chat-drafts")).toBe(1))
    expect(one.prompt()).toBeUndefined()
    expect(two.draft()).toBe("")
    // The person's own branch, shared with nobody: the same.
    await one.branch.actions.open("octo", "hello", "feature/one")
    await two.branch.actions.open("octo", "hello", "feature/one")
    expect(one.draft()).toBe("")
    one.type("branch draft", { anchor: 12, head: 12 })
    await until(() => expect(device.stored("chat-drafts")).toBe(2))
    expect(one.prompt()).toBeUndefined()
    expect(two.draft()).toBe("")
    // Another device of theirs has none of it: nothing reached ChatApi.
    const elsewhere = await opened.ownTab()
    await elsewhere.branch.actions.open("octo", "hello", "feature/one")
    expect(elsewhere.draft()).toBe("")
    expect(await storedUpdates(opened)).toBe(0)
  }, WITHIN)

  test("the owner's first share makes the draft the branch's prompt, live; taking the last away makes it theirs again", async () => {
    const opened = await open()
    const device = nodeDevice({ agent: opened.api })
    const owner = await opened.ownTab(device)
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    owner.type("before sharing", { anchor: 14, head: 14 })
    await until(() => expect(device.stored("chat-drafts")).toBe(1))
    expect(owner.prompt()).toBeUndefined()

    // Shared: the draft goes into the prompt, the device forgets it, and Ben, opening the branch, has it.
    await shareWith(opened, branchId, "edit")
    await until(() => expect(showsPrompt(owner)).toBe(true))
    await until(() => expect(owner.prompt()?.text).toBe("before sharing"))
    expect(owner.draft()).toBe("before sharing")
    await until(() => expect(device.stored("chat-drafts")).toBe(0))
    const ben = await opened.benTab()
    await ben.branch.actions.open("octo", "hello", "feature/one")
    await until(() => expect(ben.draft()).toBe("before sharing"))
    await until(() => expect(owner.prompt()?.stored).toBe(true))
    const sent = await storedUpdates(opened)

    // The last share taken away: the composer keeps its text, as the owner's own on the device, and sends nothing.
    await opened.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM branch_shares WHERE branch_id = ${branchId}`))
    await until(() => expect(owner.prompt()).toBeUndefined())
    await until(() => expect(device.stored("chat-drafts")).toBe(1))
    expect(owner.draft()).toBe("before sharing")
    owner.type("before sharing, alone", { anchor: 21, head: 21 })
    expect(owner.saved()).toBe(false)
    await until(() => expect(owner.saved()).toBe(true))
    expect(await storedUpdates(opened)).toBe(sent)
  }, WITHIN)
})

describe("the shared prompt", () => {
  test("two people type in one prompt at once: both get every letter, see each other's caret, and either sends it", async () => {
    const opened = await open()
    const { owner, benTab } = opened
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    await shareWith(opened, branchId, "edit")
    const benTabOpen = await benTab()
    expect(await benTabOpen.branch.actions.open("octo", "hello", "feature/one")).toBe(branchId)
    await until(() => {
      expect(owner.prompt()?.key).toBe(owner.branch.queries.current.toArray[0]?.conversationId)
      expect(benTabOpen.prompt()?.key).toBe(owner.prompt()?.key)
    })

    // Two keystrokes at once: both are on their way to the device's outbox, and it says so until both are stored.
    owner.type("hell", { anchor: 4, head: 4 })
    owner.type("hello", { anchor: 5, head: 5 })
    expect(owner.prompt()?.stored).toBe(false)
    await until(() => expect(owner.prompt()?.stored).toBe(true))
    await until(() => expect(benTabOpen.draft()).toBe("hello"))
    // A caret moved without a change sends nothing; a text this tab hasn't opened takes nothing.
    owner.branch.coedit.actions.type(owner.prompt()!.id, "hello", { selection: { anchor: 5, head: 5 } })
    owner.branch.coedit.actions.type(crypto.randomUUID(), "nowhere")
    owner.branch.coedit.actions.select(crypto.randomUUID(), { anchor: 0, head: 0 })
    expect(owner.unsent()).toBe(0)
    // Each types before hearing the other: Ben at the end, the owner at the start.
    benTabOpen.type("hello world", { anchor: 11, head: 11 })
    owner.type("Ohello", { anchor: 1, head: 1 })
    await until(() => {
      expect(owner.draft()).toBe("Ohello world")
      expect(benTabOpen.draft()).toBe("Ohello world")
    })
    // Each sees the other's caret, by name, where it stands now; Ben's own caret moved with the owner's letter.
    await until(() => {
      expect(owner.prompt()?.collaborators).toEqual([expect.objectContaining({ name: "ben", anchor: 12, head: 12 })])
      expect(benTabOpen.prompt()?.collaborators).toEqual([expect.objectContaining({ name: "member", anchor: 1, head: 1 })])
    })
    expect(benTabOpen.prompt()?.selection).toEqual({ anchor: 12, head: 12 })
    // A selection shows as one.
    benTabOpen.branch.coedit.actions.select(benTabOpen.prompt()!.id, { anchor: 7, head: 1 })
    await until(() =>
      expect(owner.prompt()?.collaborators).toEqual([expect.objectContaining({ name: "ben", anchor: 7, head: 1 })])
    )

    // Sending is one person's act: the owner asks the merged text, and the prompt clears for everyone.
    owner.submit("Ohello world")
    await until(() => expect(benTabOpen.draft()).toBe(""))
    expect(owner.draft()).toBe("")
    const asked = await Effect.runPromise(opened.api.rows)
    expect(asked.map((row) => row.text)).toContain("Ohello world")
  }, WITHIN)

  test("what someone may only view, they see but can't change: ChatApi refuses their update", async () => {
    const opened = await open()
    const { owner, benTab } = opened
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    await shareWith(opened, branchId, "view")
    const viewer = await benTab("read")
    await viewer.branch.actions.open("octo", "hello", "feature/one")
    owner.type("read me", { anchor: 7, head: 7 })
    await until(() => expect(viewer.prompt()?.text).toBe("read me"))
    await until(() => expect(viewer.prompt()?.collaborators).toEqual([expect.objectContaining({ name: "member" })]))

    viewer.coedit.type(viewer.prompt()!.id, "read me, changed", { selection: { anchor: 16, head: 16 } })
    await until(() => expect(viewer.unsent()).toBe(0))
    const theirs = await opened.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly count: number }>`SELECT count(*)::int AS count FROM text_updates WHERE person_id = 'person-ben'`))
    expect(theirs).toEqual([{ count: 0 }])
    expect(owner.draft()).toBe("read me")
  }, WITHIN)

  test("the prompt outlives the tab: another tab finds it, and a draft typed before it opened goes into it", async () => {
    const opened = await open()
    const { owner, ownTab } = opened
    await openShared(opened, owner)
    owner.type("kept", { anchor: 4, head: 4 })
    const next = await ownTab()
    await openShared(opened, next, "feature/two")
    // Typed the moment the branch opens, before its prompt does, while the other branch's still shows: it waits for it.
    await next.branch.actions.open("octo", "hello", "feature/one")
    next.type("first ", { anchor: 6, head: 6 })
    await until(() => {
      expect(next.draft()).toContain("first ")
      expect(owner.draft()).toBe(next.draft())
    })
  }, WITHIN)

  test("a tab that doesn't lead its device's outbox takes the lead and sends what it typed", async () => {
    const opened = await open()
    const { api, ownTab } = opened
    const device = nodeDevice({ agent: api })
    const owner = await ownTab(device)
    await openShared(opened, owner)
    const follower = await ownTab(device)
    await follower.branch.actions.open("octo", "hello", "feature/one")
    await until(() => expect(follower.prompt()?.key).toBe(follower.branch.queries.current.toArray[0]?.conversationId))
    // Two keystrokes before the tab leads: they wait, and go as one update.
    follower.type("from the other", { anchor: 14, head: 14 })
    follower.type("from the other tab", { anchor: 18, head: 18 })
    await until(() => expect(owner.draft()).toBe("from the other tab"))
    // And back: the first tab types again once the second leads.
    owner.type("from the other tab!", { anchor: 19, head: 19 })
    await until(() => expect(follower.draft()).toBe("from the other tab!"))
  }, WITHIN)

  test("an update that isn't one is skipped, and the text stands", async () => {
    const opened = await open()
    const { owner } = opened
    await openShared(opened, owner)
    owner.type("stands", { anchor: 6, head: 6 })
    const textId = owner.prompt()!.id
    let scope = ""
    await until(async () => {
      const rows = await opened.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly scope: string }>`SELECT scope FROM text_updates WHERE text_id = ${textId}`))
      expect(rows.length).toBeGreaterThan(0)
      scope = rows[0]!.scope
    })
    await opened.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.forEach([Base64.encode(new Uint8Array([7, 255, 1, 3])), "%%%not-base64"], (data) =>
        sql`INSERT INTO text_updates (id, scope, text_id, data, person_id)
          VALUES (${crypto.randomUUID()}, ${scope}, ${textId}, ${data}, 'person-member')`)))
    const invalid: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const other = await tab(ManagedRuntime.make(tabLayer(opened.api, {
      webSocket: dialing(opened.rooms.origin, { id: member.subject.id, name: "member", access: "write" }),
    }).pipe(Layer.provide(Logger.layer([Logger.make((entry) => {
      const line = Logger.formatStructured.log(entry)
      if (line.message === "coedit.apply") invalid.push(line)
    })])))), member.subject.id)
    await other.branch.actions.open("octo", "hello", "feature/one")
    await until(() => expect(invalid.filter((line) => line.annotations.textId === textId)).toHaveLength(2))
    expect(invalid.map((line) => line.annotations.outcome)).toEqual(["invalid", "invalid"])
    await until(() => expect(other.draft()).toBe("stands"))
  }, WITHIN)
})

describe("a shared file", () => {
  /** The `sandbox/Call` the routes started for `tool`, the `count`th, and its call's id. */
  const call = async (opened: Awaited<ReturnType<typeof open>>, tool: SandboxTools.Tool, count = 1) => {
    let found: { readonly callId: string; readonly call: Record<string, unknown> } | undefined
    await until(() => {
      const calls = opened.api.branches.starts
        .filter((start) => start.flow === "sandbox/Call")
        .map((start) => start.payload as { readonly callId: string; readonly call: Record<string, unknown> })
        .filter((payload) => payload.call.tool === tool)
      expect(calls.length).toBeGreaterThanOrEqual(count)
      found = calls[count - 1]
    })
    return found!
  }

  test("opens from the working copy once, two people edit it with each other's carets, and Save writes it", async () => {
    const opened = await open()
    const { owner, benTab } = opened
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    await shareWith(opened, branchId, "edit")
    const conversation = owner.branch.queries.current.toArray[0]!.conversationId!
    const fileId = (await owner.coedit.showFile(branchId, "styles.css"))!
    expect(fileOf(owner.texts(), conversation, "styles.css")).toMatchObject({ status: "loading", shown: true })
    const read = await call(opened, "read")
    expect(read.call).toEqual({ tool: "read", path: "styles.css" })
    const content = "body {}\n"
    await opened.run(settle(read.callId, {
      status: "done",
      result: { tool: "read", path: "styles.css", content, bytes: content.length, truncated: false },
      generation: 1,
    }))
    await until(() => expect(fileOf(owner.texts(), conversation, "styles.css")).toMatchObject({ status: "ready", text: content }))

    // Ben opens it after: its text is the one seed, and nothing reads the file again.
    const benTabOpen = await benTab()
    await benTabOpen.branch.actions.open("octo", "hello", "feature/one")
    expect(await benTabOpen.coedit.showFile(branchId, "styles.css")).toBe(fileId)
    await until(() => expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.text).toBe(content))
    expect(opened.api.branches.starts.filter((start) => (start.payload as { call?: { tool?: string } }).call?.tool === "read"))
      .toHaveLength(1)

    benTabOpen.coedit.type(fileId, "body { color: red; }\n", { base: content, selection: { anchor: 19, head: 19 } })
    owner.coedit.type(fileId, "html, body {}\n", { base: content, selection: { anchor: 6, head: 6 } })
    const merged = "html, body { color: red; }\n"
    await until(() => {
      expect(fileOf(owner.texts(), conversation, "styles.css")?.text).toBe(merged)
      expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.text).toBe(merged)
    })
    await until(() =>
      expect(fileOf(owner.texts(), conversation, "styles.css")?.collaborators).toEqual([
        expect.objectContaining({ name: "ben", head: 25 }),
      ])
    )

    const saving = owner.coedit.save(fileId)
    await until(() => expect(fileOf(owner.texts(), conversation, "styles.css")?.saving).toBe(true))
    const write = await call(opened, "write")
    expect(write.call).toEqual({ tool: "write", path: "styles.css", content: merged })
    await opened.run(settle(write.callId, {
      status: "done",
      result: { tool: "write", path: "styles.css", bytes: merged.length },
      generation: 1,
    }))
    await saving
    const saved = fileOf(owner.texts(), conversation, "styles.css")!
    expect(saved).toMatchObject({ saving: false, saveFailed: false, saved: true, text: merged })
    expect(saveLabelOf(saved)).toBe("Saved")
    // The owner saved, and Ben's tab says so too: the save's mark reaches everyone with the text.
    await until(() => expect(fileOf(benTabOpen.texts(), conversation, "styles.css")).toMatchObject({ saved: true, saving: false }))

    // Ben types: neither says Saved. Ben saves: both do.
    const benEdit = "html, body { color: blue; }\n"
    benTabOpen.coedit.type(fileId, benEdit, { base: merged, selection: { anchor: 24, head: 24 } })
    await until(() => {
      expect(fileOf(owner.texts(), conversation, "styles.css")).toMatchObject({ text: benEdit, saved: false })
      expect(fileOf(benTabOpen.texts(), conversation, "styles.css")).toMatchObject({ text: benEdit, saved: false })
    })
    const benSaving = benTabOpen.coedit.save(fileId)
    const benWrite = await call(opened, "write", 2)
    expect(benWrite.call).toEqual({ tool: "write", path: "styles.css", content: benEdit })
    await opened.run(settle(benWrite.callId, {
      status: "done",
      result: { tool: "write", path: "styles.css", bytes: benEdit.length },
      generation: 1,
    }))
    await benSaving
    await until(() => {
      expect(fileOf(owner.texts(), conversation, "styles.css")?.saved).toBe(true)
      expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.saved).toBe(true)
    })

    // A save that missed an edit arriving while it ran: what it wrote isn't the text, so neither says Saved.
    const beforeLate = "html, body { color: green; }\n"
    benTabOpen.coedit.type(fileId, beforeLate, { base: benEdit, selection: { anchor: 25, head: 25 } })
    await until(() => expect(fileOf(owner.texts(), conversation, "styles.css")).toMatchObject({ text: beforeLate, saved: false }))
    const lateSave = owner.coedit.save(fileId)
    await until(() => expect(fileOf(owner.texts(), conversation, "styles.css")?.saving).toBe(true))
    expect(saveLabelOf(fileOf(owner.texts(), conversation, "styles.css")!)).toBe("Saving…")
    const lateWrite = await call(opened, "write", 3)
    expect(lateWrite.call).toMatchObject({ content: beforeLate })
    const late = `${beforeLate}/* late */\n`
    benTabOpen.coedit.type(fileId, late, { base: beforeLate, selection: { anchor: 39, head: 39 } })
    await until(() => expect(fileOf(owner.texts(), conversation, "styles.css")?.text).toBe(late))
    await opened.run(settle(lateWrite.callId, {
      status: "done",
      result: { tool: "write", path: "styles.css", bytes: beforeLate.length },
      generation: 1,
    }))
    await lateSave
    await until(() => {
      expect(fileOf(owner.texts(), conversation, "styles.css")).toMatchObject({ saving: false, saved: false, text: late })
      expect(fileOf(benTabOpen.texts(), conversation, "styles.css")).toMatchObject({ saved: false, text: late })
    })
    // Undoing the late edit makes the text what was written again: both say Saved.
    benTabOpen.coedit.type(fileId, beforeLate, { base: late, selection: { anchor: 25, head: 25 } })
    await until(() => {
      expect(fileOf(owner.texts(), conversation, "styles.css")?.saved).toBe(true)
      expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.saved).toBe(true)
    })

    // Showing it again changes nothing; Save on a text that isn't a file, or isn't open, does nothing.
    expect(await owner.coedit.showFile(branchId, "styles.css")).toBe(fileId)
    await owner.coedit.save(owner.prompt()!.id)
    await owner.coedit.save(crypto.randomUUID())
    expect(opened.api.branches.starts.filter((start) => (start.payload as { call?: { tool?: string } }).call?.tool === "write"))
      .toHaveLength(3)

    // Leaving the editor (`showFile` with no file) leaves the file's room: Ben stops seeing the owner's caret.
    expect(await owner.coedit.showFile(branchId, undefined)).toBeUndefined()
    expect(fileOf(owner.texts(), conversation, "styles.css")?.shown).toBe(false)
    await until(() => expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.collaborators).toEqual([]))
    // Typed out of its room, an edit still reaches everyone; only the caret stays home.
    owner.coedit.type(fileId, `${beforeLate}/* end */\n`, { base: beforeLate, selection: { anchor: 39, head: 39 } })
    const ended = `${beforeLate}/* end */\n`
    await until(() => expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.text).toBe(ended))
    expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.collaborators).toEqual([])
    // Back in it, the file is as everyone left it, and nothing reads it again.
    expect(await owner.coedit.showFile(branchId, "styles.css")).toBe(fileId)
    expect(fileOf(owner.texts(), conversation, "styles.css")).toMatchObject({ shown: true, text: ended })
    expect(opened.api.branches.starts.filter((start) => (start.payload as { call?: { tool?: string } }).call?.tool === "read"))
      .toHaveLength(1)
  }, WITHIN)

  test("someone who may only view sees a file once someone who may edit opened it; a tab that doesn't lead seeds it", async () => {
    const opened = await open()
    const { owner, benTab, api } = opened
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    await shareWith(opened, branchId, "view")
    const conversation = owner.branch.queries.current.toArray[0]!.conversationId!
    const viewer = await benTab("read")
    await viewer.branch.actions.open("octo", "hello", "feature/one")
    // Nobody opened it: the viewer may not read the working copy.
    await viewer.coedit.showFile(branchId, "index.html")
    await until(() => expect(fileOf(viewer.texts(), conversation, "index.html")).toMatchObject({ status: "failed", failure: "forbidden" }))

    // A second tab of the owner's device, which doesn't lead its outbox, opens it: it takes the lead to send the seed.
    const device = nodeDevice({ agent: api })
    const first = await opened.ownTab(device)
    const second = await opened.ownTab(device)
    await first.branch.actions.open("octo", "hello", "feature/one")
    await second.branch.actions.open("octo", "hello", "feature/one")
    await second.coedit.showFile(branchId, "index.html")
    const read = await call(opened, "read")
    await opened.run(settle(read.callId, {
      status: "done",
      result: { tool: "read", path: "index.html", content: "<p>hi</p>\n", bytes: 10, truncated: false },
      generation: 1,
    }))
    await until(() => expect(fileOf(second.texts(), conversation, "index.html")).toMatchObject({ status: "ready", text: "<p>hi</p>\n" }))
  }, WITHIN)

  test("a read or a save the engine refuses says so", async () => {
    const opened = await open()
    const { owner } = opened
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    const conversation = owner.branch.queries.current.toArray[0]!.conversationId!
    const { tab: faulty, engine } = await opened.faultyTab()
    await faulty.branch.actions.open("octo", "hello", "feature/one")
    await Effect.runPromise(engine.refuseStarts("sandbox/read"))
    await faulty.coedit.showFile(branchId, "a.txt")
    await until(() => expect(fileOf(faulty.texts(), conversation, "a.txt")).toMatchObject({ status: "failed", failure: "unavailable" }))

    // The owner opens another; the faulty tab's save is refused.
    const fileId = (await owner.coedit.showFile(branchId, "b.txt"))!
    const read = await call(opened, "read")
    await opened.run(settle(read.callId, {
      status: "done",
      result: { tool: "read", path: "b.txt", content: "b", bytes: 1, truncated: false },
      generation: 1,
    }))
    await faulty.coedit.showFile(branchId, "b.txt")
    await until(() => expect(fileOf(faulty.texts(), conversation, "b.txt")?.status).toBe("ready"))
    await Effect.runPromise(engine.refuseStarts("sandbox/write"))
    await faulty.coedit.save(fileId)
    expect(fileOf(faulty.texts(), conversation, "b.txt")).toMatchObject({ saving: false, saveFailed: true, saved: false })
    expect(saveLabelOf(fileOf(faulty.texts(), conversation, "b.txt")!)).toBe("Retry save")
    await faulty.coedit.hideFiles()
    expect(fileOf(faulty.texts(), conversation, "b.txt")?.shown).toBe(false)
  }, WITHIN)

  test("a file too large to edit, one the person may not read, and a Save that fails say so", async () => {
    const opened = await open()
    const { owner } = opened
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    const conversation = owner.branch.queries.current.toArray[0]!.conversationId!
    await owner.coedit.showFile(branchId, "huge.bin")
    const huge = await call(opened, "read")
    await opened.run(settle(huge.callId, {
      status: "done",
      result: { tool: "read", path: "huge.bin", content: "x", bytes: 9_000_000, truncated: true },
      generation: 1,
    }))
    await until(() => expect(fileOf(owner.texts(), conversation, "huge.bin")).toMatchObject({ status: "failed", failure: "too_large" }))

    await owner.coedit.showFile(branchId, "gone.txt")
    const gone = await call(opened, "read", 2)
    await opened.run(settle(gone.callId, { status: "failed", failure: "not_found" }))
    await until(() => expect(fileOf(owner.texts(), conversation, "gone.txt")).toMatchObject({ status: "failed", failure: "unavailable" }))

    const fileId = (await owner.coedit.showFile(branchId, "ok.txt"))!
    const ok = await call(opened, "read", 3)
    await opened.run(settle(ok.callId, {
      status: "done",
      result: { tool: "read", path: "ok.txt", content: "ok", bytes: 2, truncated: false },
      generation: 1,
    }))
    await until(() => expect(fileOf(owner.texts(), conversation, "ok.txt")?.status).toBe("ready"))
    const saving = owner.coedit.save(fileId)
    const write = await call(opened, "write")
    await opened.run(settle(write.callId, { status: "failed", failure: "unavailable" }))
    await saving
    expect(fileOf(owner.texts(), conversation, "ok.txt")).toMatchObject({ saving: false, saveFailed: true, saved: false })
    // Trying again clears the failure while it runs, and a write that lands says Saved.
    const retry = owner.coedit.save(fileId)
    await until(() => expect(fileOf(owner.texts(), conversation, "ok.txt")).toMatchObject({ saving: true, saveFailed: false }))
    const retried = await call(opened, "write", 2)
    await opened.run(settle(retried.callId, { status: "done", result: { tool: "write", path: "ok.txt", bytes: 2 }, generation: 1 }))
    await retry
    expect(fileOf(owner.texts(), conversation, "ok.txt")).toMatchObject({ saving: false, saveFailed: false, saved: true })
    expect(saveLabelOf(fileOf(owner.texts(), conversation, "ok.txt")!)).toBe("Saved")
  }, WITHIN)

  test.fails("a Save's mark follows when each tab heard its write was done, not the machine's write order (broken)", async () => {
    // Overlapping Saves mark completion order instead of write order: docs/features/coedit.md#saved.
    const opened = await open()
    const { owner, benTab } = opened
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    await shareWith(opened, branchId, "edit")
    const conversation = owner.branch.queries.current.toArray[0]!.conversationId!
    const fileId = (await owner.coedit.showFile(branchId, "styles.css"))!
    const read = await call(opened, "read")
    const content = "body {}\n"
    await opened.run(settle(read.callId, {
      status: "done",
      result: { tool: "read", path: "styles.css", content, bytes: content.length, truncated: false },
      generation: 1,
    }))
    await until(() => expect(fileOf(owner.texts(), conversation, "styles.css")).toMatchObject({ status: "ready", text: content }))
    const benTabOpen = await benTab()
    await benTabOpen.branch.actions.open("octo", "hello", "feature/one")
    expect(await benTabOpen.coedit.showFile(branchId, "styles.css")).toBe(fileId)
    await until(() => expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.text).toBe(content))

    const y = "body { color: red; }\n"
    benTabOpen.coedit.type(fileId, y, { base: content, selection: { anchor: 19, head: 19 } })
    await until(() => {
      expect(fileOf(owner.texts(), conversation, "styles.css")?.text).toBe(y)
      expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.text).toBe(y)
    })
    const benSaving = benTabOpen.coedit.save(fileId)
    const benWrite = await call(opened, "write")
    expect(benWrite.call).toEqual({ tool: "write", path: "styles.css", content: y })

    const x = "body { color: blue; }\n"
    owner.coedit.type(fileId, x, { base: y, selection: { anchor: 20, head: 20 } })
    await until(() => {
      expect(fileOf(owner.texts(), conversation, "styles.css")?.text).toBe(x)
      expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.text).toBe(x)
    })
    const ownerSaving = owner.coedit.save(fileId)
    const ownerWrite = await call(opened, "write", 2)
    expect(ownerWrite.call).toEqual({ tool: "write", path: "styles.css", content: x })

    // The machine wrote X then Y, leaving Y on disk; X's slow checkpoint settles last.
    await opened.run(settle(benWrite.callId, {
      status: "done",
      result: { tool: "write", path: "styles.css", bytes: y.length },
      generation: 1,
    }))
    await benSaving
    // The later completion must observe the earlier mark, rather than race concurrent CRDT marks.
    await until(async () => expect((await owner.marks(fileId)).get(SAVED_MARK)).toBe(savedMarkOf(y)))
    await opened.run(settle(ownerWrite.callId, {
      status: "done",
      result: { tool: "write", path: "styles.css", bytes: x.length },
      generation: 1,
    }))
    await ownerSaving
    await until(async () => {
      expect((await owner.marks(fileId)).get(SAVED_MARK)).toBe(savedMarkOf(x))
      expect((await benTabOpen.marks(fileId)).get(SAVED_MARK)).toBe(savedMarkOf(x))
    })
    await until(() => {
      expect(fileOf(owner.texts(), conversation, "styles.css")).toMatchObject({ text: x, saved: false })
      expect(fileOf(benTabOpen.texts(), conversation, "styles.css")).toMatchObject({ text: x, saved: false })
    }, 10_000)
  }, WITHIN)

  test.fails("a reload during a Save leaves no mark: the write finishes, but nobody's screen says Saved (broken)", async () => {
    // A reload loses the saving tab's mark after a durable write: docs/features/coedit.md#saved.
    const opened = await open()
    // Keep ChatApi alive when the saving tab closes.
    const owner = await opened.ownTab()
    const branchId = (await owner.branch.actions.open("octo", "hello", "feature/one"))!
    await shareWith(opened, branchId, "edit")
    const conversation = owner.branch.queries.current.toArray[0]!.conversationId!
    const fileId = (await owner.coedit.showFile(branchId, "styles.css"))!
    const read = await call(opened, "read")
    const content = "body {}\n"
    await opened.run(settle(read.callId, {
      status: "done",
      result: { tool: "read", path: "styles.css", content, bytes: content.length, truncated: false },
      generation: 1,
    }))
    await until(() => expect(fileOf(owner.texts(), conversation, "styles.css")).toMatchObject({ status: "ready", text: content }))
    const benTabOpen = await opened.benTab()
    await benTabOpen.branch.actions.open("octo", "hello", "feature/one")
    expect(await benTabOpen.coedit.showFile(branchId, "styles.css")).toBe(fileId)
    await until(() => expect(fileOf(benTabOpen.texts(), conversation, "styles.css")?.text).toBe(content))

    void owner.coedit.save(fileId).catch(() => {})
    const write = await call(opened, "write")
    expect(write.call).toEqual({ tool: "write", path: "styles.css", content })
    await owner.close()
    await opened.run(settle(write.callId, {
      status: "done",
      result: { tool: "write", path: "styles.css", bytes: content.length },
      generation: 1,
    }))
    await until(() => expect(fileOf(benTabOpen.texts(), conversation, "styles.css")).toMatchObject({ saved: true }), 10_000)
  }, WITHIN)
})

test("a file's Save button says what this tab's Save does, else whether the text is what the last Save wrote", () => {
  const file = (change: { saving?: boolean; saveFailed?: boolean; saved?: boolean }) =>
    ({ saving: false, saveFailed: false, saved: false, ...change }) as Parameters<typeof saveLabelOf>[0]
  expect(saveLabelOf(file({}))).toBe("Save")
  expect(saveLabelOf(file({ saving: true, saved: true }))).toBe("Saving…")
  expect(saveLabelOf(file({ saved: true, saveFailed: true }))).toBe("Saved")
  expect(saveLabelOf(file({ saveFailed: true }))).toBe("Retry save")
})

describe("a run's answer box", () => {
  test("the person's devices type its answer together, with each other's carets", async () => {
    const opened = await open()
    const { owner, ownTab } = opened
    const other = await ownTab()
    const runId = crypto.randomUUID()
    await opened.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO runs (id, flow, status, waiting, wait, version, launched_by)
        VALUES (${runId}, 'chat/Answer', 'needs_you', 'input',
          ${JSON.stringify({ execution: "ask-1", kind: "question", prompt: "Which branch?", options: [] })}::jsonb, 1,
          ${member.subject.id})`))
    await until(() => {
      expect(answerOf(owner.texts(), runId, 1)?.shown).toBe(true)
      expect(openAnswerOf(other.texts(), runId)?.shown).toBe(true)
    })
    const textId = answerOf(owner.texts(), runId, 1)!.id
    owner.coedit.type(textId, "docs-v2", { base: "", selection: { anchor: 7, head: 7 } })
    await until(() => {
      expect(answerOf(other.texts(), runId, 1)?.text).toBe("docs-v2")
      expect(answerOf(other.texts(), runId, 1)?.collaborators).toEqual([expect.objectContaining({ name: "member", head: 7 })])
    })

    // Answered, the box closes on every device.
    await opened.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE runs SET status = 'working', waiting = NULL, answer = '{"value":"docs-v2"}', answered_at = now()
        WHERE id = ${runId}`))
    await until(() => expect(answerOf(other.texts(), runId, 1)?.shown).toBe(false))
  }, WITHIN)
})

describe("sending", () => {
  /**
   * A texts client whose next writes go as `plan` says, then as the real one: no answer (`undefined`), a status, or
   * `drop`, ChatApi taking the write and its answer never arriving.
   */
  const faultyClient = (...plan: Array<number | "drop" | undefined>) =>
    Layer.effect(
      TextsClient,
      Effect.map(TextsClient, (real) =>
        TextsClient.of({
          write: (textId, request) =>
            Effect.suspend(() => {
              if (plan.length === 0) return real.write(textId, request)
              const next = plan.shift()
              if (next === "drop") return Effect.andThen(real.write(textId, request), Effect.fail(new UpdateNotTaken({})))
              return Effect.fail(new UpdateNotTaken(next === undefined ? {} : { status: next }))
            }),
        })),
    ).pipe(Layer.provide(TextsClient.layer({ origin: CHATAPI_ORIGIN, within: "10 seconds" })))

  test("an update ChatApi didn't take is sent again, after no answer, a 503 or a lost answer, until it is stored once", async () => {
    const opened = await open({ replace: faultyClient(undefined, 503, "drop") })
    const { owner } = opened
    await openShared(opened, owner)
    owner.type("again", { anchor: 5, head: 5 })
    const other = await opened.ownTab()
    await other.branch.actions.open("octo", "hello", "feature/one")
    await until(() => expect(other.draft()).toBe("again"))
    await until(() => expect(owner.unsent()).toBe(0))
    expect(opened.count("retry")).toBe(3)
    // The answer that was lost: ChatApi had it, so the resend stored nothing new.
    expect(opened.count("existing")).toBe(1)
  }, WITHIN)

  test("a keystroke the device couldn't store says so, and reaches nobody", async () => {
    const opened = await open()
    const base = nodeDevice({ agent: opened.api })
    const full = {
      ...base,
      outbox: { ...base.outbox, storage: { ...base.outbox.storage, set: () => Promise.reject(new Error("quota exceeded")) } },
    }
    const tab = await opened.ownTab(full)
    await openShared(opened, tab)
    tab.type("lost", { anchor: 4, head: 4 })
    await until(() => expect(tab.prompt()?.stored).toBe(false))
    // The next keystroke takes the one before with it; neither is stored.
    tab.type("lost?", { anchor: 5, head: 5 })
    expect(tab.prompt()?.text).toBe("lost?")
    await until(() => expect(tab.unsent()).toBe(0))
    expect(tab.prompt()?.stored).toBe(false)
    await opened.owner.branch.actions.open("octo", "hello", "feature/one")
    await until(() => expect(opened.owner.prompt()?.key).toBe(tab.prompt()?.key))
    expect(opened.owner.draft()).toBe("")
    await tab.close() // Flush the tab's exporter.
    // Each update the outbox's storage refused is one Warn line by its code, never the text or the storage's message.
    const refused = readTelemetry(opened.api.telemetry).log("coedit.admit")
    expect(refused.length).toBeGreaterThan(0)
    for (const line of refused) {
      expect(line).toMatchObject({
        severity: "Warn",
        attributes: { feature: "coedit", outcome: "failed", reason: "storage", errorCode: "NotAdmitted" },
      })
    }
    expect(JSON.stringify(refused)).not.toMatch(/lost|quota/)
  }, WITHIN)

  test("the route's answers a valid update never gets: no answer, a body that isn't the contract's, a bare refusal", async () => {
    const textId = crypto.randomUUID()
    const request = { scope: { conversation: "home" }, id: crypto.randomUUID(), update: "AAA=" }
    const post = (fetch: typeof globalThis.fetch, within: Duration.Input = "5 seconds") =>
      Effect.runPromise(Effect.exit(postUpdate("http://chat.test", textId, request, within).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      )))
    const answer = (status: number, body: string) => () => Promise.resolve(new Response(body, { status }))
    expect(await post(() => Promise.reject(new TypeError("fetch failed")))).toEqual(Exit.fail(new UpdateNotTaken({})))
    expect(await post(answer(200, "not json"))).toEqual(Exit.fail(new UpdateNotTaken({ status: 200 })))
    expect(await post(answer(403, "denied"))).toEqual(Exit.fail(new UpdateNotTaken({ status: 403 })))
    expect(await post(answer(403, JSON.stringify({ code: "view_only" })))).toEqual(
      Exit.fail(new UpdateNotTaken({ status: 403, code: "view_only" })),
    )
    expect(await post(answer(200, JSON.stringify({ txid: 7 })))).toEqual(Exit.succeed({ txid: 7 }))
    // An answer that never comes is no answer.
    const never = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
    expect(await post(never, "50 millis")).toEqual(Exit.fail(new UpdateNotTaken({})))
  })
})

describe("cursors in a room", () => {
  test("a caret into text this tab hasn't received isn't drawn", async () => {
    const opened = await open()
    const { owner } = opened
    await openShared(opened, owner)
    const textId = owner.prompt()!.id
    // Someone whose text never reached ChatApi says their caret is in it.
    const elsewhere = Effect.runSync(Effect.scoped(Effect.gen(function* () {
      const replica = yield* SharedText.make
      yield* replica.replace("unsent text")
      return { anchor: yield* replica.anchor(3), head: yield* replica.anchor(3) }
    })))
    const conversation = owner.branch.queries.current.toArray[0]!.conversationId!
    const ghost = dialing(opened.rooms.origin, { id: "person-ghost", name: "ghost" })(
      `ws://chatapi.test${textRoomRoute(textId)}?conversation=${conversation}`,
    ) as unknown as WebSocket
    closers.push(async () => ghost.close())
    await new Promise<void>((resolve) => ghost.addEventListener("message", () => resolve(), { once: true }))
    ghost.send(PresenceProtocol.encodeClientFrame({ type: "state", state: encodeCursor(elsewhere) }))
    owner.type("here", { anchor: 4, head: 4 })
    await until(() => expect(opened.rooms.occupants(textRoomRoute(textId))).toBe(2))
    await until(() => expect(owner.prompt()?.text).toBe("here"))
    expect(owner.prompt()?.collaborators).toEqual([])
    // Once the caret is somewhere the owner's text has, the end, it is drawn.
    const atEnd = Effect.runSync(Effect.scoped(Effect.gen(function* () {
      const replica = yield* SharedText.make
      return { anchor: yield* replica.anchor(0), head: yield* replica.anchor(0) }
    })))
    ghost.send(PresenceProtocol.encodeClientFrame({ type: "state", state: encodeCursor(atEnd) }))
    await until(() =>
      expect(owner.prompt()?.collaborators).toEqual([expect.objectContaining({ name: "ghost", anchor: 4, head: 4 })])
    )
  }, WITHIN)

  test("a cursor's anchors make a room state and back; a state that isn't one is no cursor", () => {
    const mine = { anchor: new Uint8Array([1, 2, 3]), head: new Uint8Array([4]) }
    expect(decodeCursor(encodeCursor(mine))).toEqual(mine)
    expect(decodeCursor(null)).toBeUndefined()
    expect(decodeCursor("not json")).toBeUndefined()
    expect(decodeCursor(JSON.stringify({ a: 1, h: "AA==" }))).toBeUndefined()
    expect(decodeCursor(JSON.stringify({ a: "%%%", h: "AA==" }))).toBeUndefined()
  })
})

test("a synced history deletion cannot erase text already applied to an open editor", async () => {
  const opened = await open()
  await openShared(opened, opened.owner)
  const host = nodeDevice({ agent: opened.api })
  const other = await opened.ownTab(host)
  await other.branch.actions.open("octo", "hello", "feature/one")
  opened.owner.type("stands", { anchor: 6, head: 6 })
  await until(() => expect(other.draft()).toBe("stands"))
  const id = other.prompt()!.id
  await until(() => expect(host.stored(`text-updates:${id}`)).toBeGreaterThan(0))
  // A faulty persisted history emits a real Electric deletion, rather than a text edit.
  await opened.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM text_updates WHERE text_id = ${id}`))
  await until(() => expect(host.stored(`text-updates:${id}`)).toBe(0))
  expect(other.draft()).toBe("stands")
}, WITHIN)
