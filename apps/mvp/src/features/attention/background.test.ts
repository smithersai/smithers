// Background progress on the tab (decision 0124), driven as React drives it: the features' plain actions, the feed's
// entries as the toast stack reads them. Each device runs the browser's own layer (`appLayer`) on a Node device whose
// engine leads (src/test/chatApi.ts), against ChatApi's real routes over the compose Postgres and Electric. Unhappy
// paths inject faults through services only (test.faults-by-injection): the engine behind `EngineFaults`, an outbox
// whose storage refuses or waits. A reload is a new tab on the same device and the same tab's input receipts.
import { BrowserEngine, PendingSnapshot } from "@smthrs/platform-browser"
import { GitHub } from "@smthrs/integrations"
import { Effect, Fiber, Layer, Option, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import * as Store from "../../../worker/github/Store.ts"
import { CHATAPI_ORIGIN, nodeDevice, type NodeDevice, openFaultyTab, openTab, openTestApp, type TabOptions, TEST_REPOSITORY, TestChatApi } from "../../test/chatApi"
import { ChangeNotTaken, StackClient } from "../todos/api"
import { EngineFaults, ShapeRecovery } from "../../test/faults"
import { NOTIFICATIONS_SHAPE_ROUTE } from "./contract"
import { resumeAdmissions } from "../../resumeAdmissions"
import { whileAdmitting, WriteIntents } from "../../writeAdmission"
import { retryWrite } from "../issues/actions"
import type { Actor } from "../../../worker/Actor.ts"
import { AuthStore, SESSION } from "../auth/store"
import { COMPOSER } from "../chat/schema"
import { ChatStore } from "../chat/store"
import { Commands } from "../commands/commands"
import { role as readRepositoryRole } from "../repo/actions"
import { Issues } from "../issues/issues"
import { IssuesStore } from "../issues/store"
import { Todos } from "../todos/todos"
import { TodosStore } from "../todos/store"
import { dismiss, retry } from "./actions"
import type { Entry } from "./schema"
import { AttentionStore } from "./store"

const [OWNER, NAME] = TEST_REPOSITORY.split("/") as [string, string]
const REPO_ID = `github/${TEST_REPOSITORY}`
const WITHIN = 120_000
const until = (assertion: () => void | Promise<void>, timeout = 60_000) => vi.waitFor(assertion, { timeout, interval: 20 })

const closing: Array<{ readonly dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of closing.splice(0).reverse()) await runtime.dispose()
})

/** Maya, a Member who may write the test repository's issues. */
const maya: Actor = { subject: { kind: "person", id: "person-maya" }, role: "member", login: "maya", session: "6f1d7c1e-0b7a-4f1c-9d55-2a1c0b8e3f10" }

/** A ChatApi, as Maya unless `actor` is the test API's own Member. `/new` needs a forge to make branches on. */
const openApi = async (actor: Actor | undefined = maya) => {
  const server = openTestApp({ answers: false }, { ...(actor === undefined ? {} : { actor }), forge: "code-storage" })
  closing.push(server)
  return server.runPromise(Effect.service(TestChatApi))
}

/** One tab's input receipts, as its session storage keeps them across a reload of that tab only. */
const snapshot = () => {
  const data = new Map<string, string>()
  return PendingSnapshot.make({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }, "pending")
}

/** A tab's host: its device, and the tab's own input receipts. */
type Device = NodeDevice & { readonly writeSnapshot: PendingSnapshot.Service }

/** A device: its store and outbox, and one tab's input receipts, which a reload of that tab keeps. */
const deviceOf = (api: TestChatApi["Service"]): Device => ({ ...nodeDevice({ agent: api }), writeSnapshot: snapshot() })

/** Another tab of the same device: the device's store, outbox and engine, its own session storage. */
const otherTab = (device: Device): Device => ({ ...device, editorTabId: crypto.randomUUID(), writeSnapshot: snapshot() })

type Tab = Awaited<ReturnType<typeof tabOn>>

/** A tab of `host`, its features and feed, with every state each subject's entry took kept in order. */
const tabOn = async (api: TestChatApi["Service"], host: Device, options: boolean | (Pick<TabOptions, "replace"> & { readonly faulty?: boolean }) = false) => {
  const faulty = options === true || (typeof options === "object" && options.faulty === true)
  const replace = typeof options === "object" ? options.replace : undefined
  const tabOptions = { host, ...(replace === undefined ? {} : { replace }) }
  const runtime = faulty ? openFaultyTab(api, tabOptions) : openTab(api, tabOptions)
  closing.push(runtime)
  const services = await runtime.runPromise(Effect.all({
    attention: AttentionStore, issues: Issues, issuesStore: IssuesStore, todos: Todos, todosStore: TodosStore,
    commands: Commands, intents: WriteIntents,
  }))
  // Signed in as sign-in's `load` sets it, so the composer offers `/new`.
  const { session } = await runtime.runPromise(Effect.service(AuthStore))
  await until(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await runtime.runPromise(session.update(SESSION, (row) => void Object.assign(row, { status: "signed_in", login: "maya", role: "member" })))
  const seen = new Map<string, Array<string>>()
  const watching = runtime.runFork(services.attention.entries.changes({ initial: true }).pipe(
    Stream.runForEach(() => Effect.flatMap(services.attention.entries.toArray, (entries) => Effect.sync(() => {
      for (const entry of entries) {
        const states = seen.get(entry.id) ?? []
        const said = `${entry.state}${entry.word === "Requested" ? ":requested" : ""}${entry.local === true ? "" : ":synced"}`
        if (states.at(-1) !== said) seen.set(entry.id, [...states, said])
      }
    }))),
  ))
  closing.push({ dispose: () => Effect.runPromise(Fiber.interrupt(watching)) })
  const entries = () => runtime.runSync(services.attention.entries.toArray) as ReadonlyArray<Entry>
  return {
    runtime,
    ...services,
    entries,
    entry: (subject: string) => entries().find((entry) => entry.id === subject),
    /** What the stack says of `subject`, for a readable failure. */
    said: (subject: string) => {
      const found = entries().find((entry) => entry.id === subject)
      return found === undefined ? undefined : { state: found.state, word: found.word, href: found.href, local: found.local === true, stack: found.stack, listed: found.listed }
    },
    /** The entry whose detail is `title`: the one operation of that kind. */
    titled: (title: string) => entries().find((entry) => entry.detail === title),
    states: (subject: string) => seen.get(subject) ?? [],
    faults: (await runtime.runPromise(Effect.serviceOption(EngineFaults))).pipe(Option.getOrUndefined),
  }
}

/** The server: GitHub's answer to a new issue, and its rows. */
const github = (api: TestChatApi["Service"]) => ({
  opened: (writeId: string, number: number, title: string) =>
    Effect.runPromise(api.github.run(Store.settleWrite(writeId, { status: "done", itemNumber: number, githubId: 9_000 + number },
      Store.upsertIssue(REPO_ID, {
        id: 9_000 + number, node_id: `I_${number}`, number, title, body: GitHub.Issues.withWriteMarker("", writeId), state: "open",
        state_reason: null, user: { id: 1, login: "maya" }, comments: 0, created_at: "2026-10-20T10:00:00Z",
        updated_at: "2026-10-20T10:00:00Z", closed_at: null, labels: [],
      }, Date.now())))),
  issue: (number: number, title: string) =>
    Effect.runPromise(api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(
      `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, created_at, updated_at, source_updated_at, fetched_at)
      VALUES ('${REPO_ID}#${number}', '${REPO_ID}', ${number}, 'issue', ${7000 + number}, '${title}', 'Body', 'open', now(), now(), now(), now())`,
    )))),
  writes: () =>
    Effect.runPromise(api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly id: string }>`SELECT id::text AS id FROM github_writes`))),
})

/** A Create issue pressed on `tab`'s new-issue form; answers its write id. */
const createIssue = async (tab: Tab, title: string) => {
  await tab.issues.actions.open(OWNER, NAME)
  tab.issues.actions.setNewTitle(OWNER, NAME, title)
  await tab.issues.actions.create(OWNER, NAME)
  return tab.intents.pending().find((intent) => intent.flow === "issue/create")!.writeId!
}

describe("Create issue", () => {
  test("Requested at once, the server's Working, then Done on its issue, whose notification takes over; never Failed", async () => {
    const api = await openApi()
    const tab = await tabOn(api, deviceOf(api))
    const writeId = await createIssue(tab, "Progress")
    const subject = `write:${writeId}`
    await until(() => expect(tab.entry(subject)).toMatchObject({ stack: true, detail: "Create issue" }))
    await until(() => expect({ said: tab.said(subject), states: tab.states(subject) }).toMatchObject({ said: { state: "working" } }))
    await github(api).opened(writeId, 1, "Progress")
    await until(() => expect(tab.entry(subject)).toMatchObject({ state: "done", href: `/${TEST_REPOSITORY}/issues/1`, stack: true }))
    // The person's notification, folded with the write's result, replaces the device's row.
    await until(() => expect(tab.entry(subject)?.local).toBeUndefined())
    expect(tab.states(subject).some((state) => state.startsWith("failed"))).toBe(false)
    expect(tab.states(subject)[0]).toMatch(/^waiting:requested|^working/)
  }, WITHIN)

  test("pressing twice is one write and one entry", async () => {
    const api = await openApi()
    const tab = await tabOn(api, deviceOf(api))
    await tab.issues.actions.open(OWNER, NAME)
    tab.issues.actions.setNewTitle(OWNER, NAME, "Once")
    await Promise.all([tab.issues.actions.create(OWNER, NAME), tab.issues.actions.create(OWNER, NAME)])
    await until(async () => expect(await github(api).writes()).toHaveLength(1))
    expect(tab.entries().filter((entry) => entry.detail === "Create issue")).toHaveLength(1)
  }, WITHIN)

  test("an outbox that refuses storage: Failed with Try again at the refusal; Try again admits the same write", async () => {
    const api = await openApi()
    const device = deviceOf(api)
    let refusing = true
    const storage = { ...device.outbox.storage, set: (key: string, value: string) => refusing ? Promise.reject(new Error("quota")) : device.outbox.storage.set(key, value) }
    const tab = await tabOn(api, { ...device, outbox: { ...device.outbox, storage } })
    const pressed = Date.now()
    const writeId = await createIssue(tab, "Refused once")
    const subject = `write:${writeId}`
    await until(() => expect(tab.entry(subject)).toMatchObject({ state: "failed", action: "retry", stack: true, listed: true }))
    const firstRefusal = tab.entry(subject)!.atMs
    expect(firstRefusal).toBeGreaterThanOrEqual(pressed)
    // Dismiss hides that refusal; the page's Try again, refused again, is a later receipt that shows, and its Dismiss
    // moves the dismissal on.
    await tab.runtime.runPromise(dismiss(subject))
    await until(() => expect(tab.entry(subject)).toBeUndefined())
    await tab.runtime.runPromise(retryWrite(writeId))
    await until(() => expect(tab.entry(subject)?.atMs).toBeGreaterThan(firstRefusal))
    await tab.runtime.runPromise(dismiss(subject))
    await until(() => expect(tab.entry(subject)).toBeUndefined())
    expect(tab.runtime.runSync(tab.attention.dismissed.toArray).map(({ id, at }) => ({ id, at }))).toEqual([{ id: subject, at: expect.any(Number) }])
    // Refused once more, its toast offers Try again, which admits the same write once storage works.
    await tab.runtime.runPromise(retryWrite(writeId))
    await until(() => expect(tab.entry(subject)).toMatchObject({ state: "failed", action: "retry" }))
    // Pressed while the page's Retry still runs, Try again starts nothing of its own.
    await tab.runtime.runPromise(whileAdmitting(writeId, retry(subject)))
    expect(tab.entry(subject)).toMatchObject({ state: "failed" })
    refusing = false
    await tab.runtime.runPromise(retry(subject))
    await until(async () => expect((await github(api).writes()).map((row) => row.id)).toEqual([writeId]))
    await until(() => expect(tab.entry(subject)).toMatchObject({ state: "working" }))
  }, WITHIN)
})

describe("an outbox that waits, then refuses storage", () => {
  test("its row while it waited proves nothing: once storage refuses, the toast is Failed with Try again", async () => {
    const api = await openApi()
    const device = deviceOf(api)
    let release: ((ok: boolean) => void) | undefined
    const verdict = new Promise<boolean>((resolve) => void (release = resolve))
    let first = true
    const storage = {
      ...device.outbox.storage,
      set: async (key: string, value: string) => {
        if (!first) return device.outbox.storage.set(key, value)
        first = false
        if (!(await verdict)) throw new Error("quota")
        return device.outbox.storage.set(key, value)
      },
    }
    const tab = await tabOn(api, { ...device, outbox: { ...device.outbox, storage } })
    await tab.issues.actions.open(OWNER, NAME)
    tab.issues.actions.setNewTitle(OWNER, NAME, "Held then refused")
    const created = tab.issues.actions.create(OWNER, NAME)
    await until(() => expect(tab.titled("Create issue")).toMatchObject({ state: "waiting", word: "Requested" }))
    // The outbox's optimistic row showed meanwhile.
    await until(() => expect(tab.runtime.runSync(tab.issuesStore.sending.toArray)).toHaveLength(1))
    release!(false)
    await created
    await until(() => expect(tab.titled("Create issue")).toMatchObject({ state: "failed", action: "retry" }))
  }, WITHIN)
})

describe("two tabs of one device", () => {
  test("the other tab never shows a write still being admitted as failed; a closed tab leaves no Requested behind", async () => {
    const api = await openApi()
    const device = deviceOf(api)
    // The first tab's outbox write never finishes: the tab closes before the outbox took it. Its work ends
    // with the tab, so nothing of it runs after the close.
    const never = new Promise<void>(() => {})
    const storage = { ...device.outbox.storage, set: async (key: string, value: string) => { await never; return device.outbox.storage.set(key, value) } }
    const first = await tabOn(api, { ...device, outbox: { ...device.outbox, storage } })
    const second = await tabOn(api, otherTab(device))
    void first.issues.actions.open(OWNER, NAME).then(() => {
      first.issues.actions.setNewTitle(OWNER, NAME, "Held admission")
      return first.issues.actions.create(OWNER, NAME)
    })
    // The first tab's pre-admission receipt reaches the device's store, where the second tab reads it.
    await until(() => expect(second.runtime.runSync(second.issuesStore.requested.toArray)).toHaveLength(1))
    const writeId = second.runtime.runSync(second.issuesStore.requested.toArray)[0]!.id
    await until(() => expect(first.said(`write:${writeId}`)).toMatchObject({ state: "waiting", word: "Requested" }))
    expect(second.entry(`write:${writeId}`)).toBeUndefined()
    // The first tab closes before the outbox took it: nothing anywhere says Requested, or Failed.
    await first.runtime.dispose()
    const third = await tabOn(api, otherTab(device))
    await until(() => expect(third.runtime.runSync(third.issuesStore.requested.toArray)).toHaveLength(1))
    await third.runtime.runPromise(Effect.sleep("300 millis"))
    expect(third.entry(`write:${writeId}`)).toBeUndefined()
    expect([...second.states(`write:${writeId}`), ...third.states(`write:${writeId}`)]).toEqual([])
  }, WITHIN)
})

describe("Commit", () => {
  test("Requested at once, then Done on its numbered TODO, whose notification takes over", async () => {
    const api = await openApi()
    const tab = await tabOn(api, deviceOf(api))
    // The stack's TODOs sync once the repository's role answers, as the stack page asks.
    await tab.runtime.runPromise(readRepositoryRole(OWNER, NAME))
    await tab.todos.actions.open(OWNER, NAME)
    const draft = tab.todos.actions.newDraft(OWNER, NAME)
    tab.todos.actions.setTitle(draft, "Progress")
    tab.todos.actions.setPrompt(draft, "Show it.")
    // The feed reads again whenever an opened stack's TODOs change.
    let changes = 0
    tab.runtime.runFork(tab.todosStore.todosChanged.pipe(Stream.runForEach(() => Effect.sync(() => void changes++))))
    await tab.todos.actions.commit(draft)
    await until(() => expect(tab.titled("Commit TODO")).toMatchObject({ state: "done", href: `/${TEST_REPOSITORY}/stack/1`, stack: true }))
    await until(() => expect(tab.runtime.runSync(Effect.map(tab.todosStore.opened(`github/${TEST_REPOSITORY}`)!.todos.toArray, (rows) => rows.length))).toBe(1))
    await until(() => expect(changes).toBeGreaterThan(0))
    const subject = tab.titled("Commit TODO")!.id
    await until(() => expect(tab.entry(subject)?.local).toBeUndefined())
    expect(tab.states(subject).some((state) => state.startsWith("failed"))).toBe(false)
  }, WITHIN)
})

describe("Commit whose answers are lost", () => {
  test("the stack committed it, its route reply was lost and its notification withheld: the synced TODO alone makes it Done", async () => {
    const api = await openApi()
    let answered = false
    // The stack takes the first send; every answer to it is lost, and every later send too.
    const lost = Layer.effect(StackClient, Effect.map(StackClient, (real) => StackClient.of({
      ...real,
      change: (owner, name, change) => change.op !== "commit"
        ? real.change(owner, name, change)
        : answered
        ? Effect.fail(new ChangeNotTaken({}))
        : Effect.andThen(real.change(owner, name, change), Effect.suspend(() => { answered = true; return Effect.fail(new ChangeNotTaken({})) })),
    }))).pipe(Layer.provide(StackClient.layer({ origin: CHATAPI_ORIGIN, within: "10 seconds" })))
    const tab = await tabOn(api, deviceOf(api), { faulty: true, replace: lost })
    const shapes = await tab.runtime.runPromise(Effect.serviceOption(ShapeRecovery))
    await tab.runtime.runPromise(Option.getOrThrow(shapes).withhold(NOTIFICATIONS_SHAPE_ROUTE))
    await tab.runtime.runPromise(readRepositoryRole(OWNER, NAME))
    await tab.todos.actions.open(OWNER, NAME)
    const draft = tab.todos.actions.newDraft(OWNER, NAME)
    tab.todos.actions.setTitle(draft, "Lost answers")
    tab.todos.actions.setPrompt(draft, "Settle from the stack.")
    await tab.todos.actions.commit(draft)
    await until(() => expect(tab.titled("Commit TODO")).toMatchObject({ state: "waiting", word: "Requested" }))
    await until(() => expect(answered).toBe(true))
    await until(() => expect(tab.titled("Commit TODO")).toMatchObject({ state: "done", href: `/${TEST_REPOSITORY}/stack/1`, local: true }))
    const subject = tab.titled("Commit TODO")!.id
    expect(tab.runtime.runSync(tab.attention.notices.toArray).some((row) => row.subject === subject)).toBe(false)
    expect(tab.runtime.runSync(tab.todosStore.requested.toArray)).toEqual([])
  }, WITHIN)
})

describe("Commit the route refuses", () => {
  test("Failed at the answer's time, opening the stack where Edit and Discard are; never Done", async () => {
    const api = await openApi()
    const refusing = Layer.effect(StackClient, Effect.map(StackClient, (real) => StackClient.of({
      ...real,
      change: (owner, name, change) => change.op === "commit" ? Effect.fail(new ChangeNotTaken({ status: 403 })) : real.change(owner, name, change),
    }))).pipe(Layer.provide(StackClient.layer({ origin: CHATAPI_ORIGIN, within: "10 seconds" })))
    const tab = await tabOn(api, deviceOf(api), { replace: refusing })
    await tab.todos.actions.open(OWNER, NAME)
    const draft = tab.todos.actions.newDraft(OWNER, NAME)
    tab.todos.actions.setTitle(draft, "Refused")
    tab.todos.actions.setPrompt(draft, "Refuse it.")
    const pressed = Date.now()
    await tab.todos.actions.commit(draft)
    await until(() => expect(tab.titled("Commit TODO")).toMatchObject({ state: "failed", href: `/${TEST_REPOSITORY}/stack`, action: "open", listed: true }))
    expect(tab.titled("Commit TODO")!.atMs).toBeGreaterThanOrEqual(pressed)
    expect(tab.states(tab.titled("Commit TODO")!.id).some((state) => state.startsWith("done"))).toBe(false)
  }, WITHIN)
})

describe("Make TODO", () => {
  test("Requested, then the engine's run: Done; a lost start reply is never Failed", async () => {
    const api = await openApi()
    await github(api).issue(7, "Fix it")
    const tab = await tabOn(api, deviceOf(api), true)
    await tab.runtime.runPromise(tab.faults!.loseStartReplies("todo/issue"))
    await tab.todos.actions.open(OWNER, NAME)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "done" }))
    const subject = tab.titled("Make TODO")!.id
    expect(subject).toMatch(/^run:/)
    expect(tab.states(subject).some((state) => state.startsWith("failed"))).toBe(false)
    // The run's own result admitted the input its lost reply couldn't, and retired it: the next press is a new Make TODO.
    await until(() => expect(tab.intents.pending()).toEqual([]))
    await tab.runtime.runPromise(tab.faults!.admitStarts("todo/issue"))
    await tab.todos.actions.discardDraft(tab.runtime.runSync(tab.todosStore.drafts.toArray)[0]!.id)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(tab.runtime.runSync(tab.todosStore.drafts.toArray)).toHaveLength(1))
  }, WITHIN)

  test("while the engine's reads fail it stays Requested; once they return, the settled run shows, never a stale Working", async () => {
    const api = await openApi()
    await github(api).issue(7, "Fix it")
    const tab = await tabOn(api, deviceOf(api), true)
    // The feed already follows the engine's reads; from now on none succeeds.
    await tab.runtime.runPromise(tab.faults!.holdRunReads)
    await tab.todos.actions.open(OWNER, NAME)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(tab.runtime.runSync(tab.todosStore.drafts.toArray)).toHaveLength(1))
    // The run finished, and no read says so: the engine's own answer to this tab's dispatch does.
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "done", local: true }))
    await tab.runtime.runPromise(tab.faults!.readRuns)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "done" }))
    const subject = tab.titled("Make TODO")!.id
    await until(() => expect(tab.states(subject)).toContain("done"))
    const states = tab.states(subject)
    expect(states.slice(states.indexOf("done"))).toEqual(["done"])
    expect(states[0]).toBe("waiting:requested")
  }, WITHIN)

  test("a run that fails is listed until dismissed, and stays dismissed after a reload; the next failure shows", async () => {
    const api = await openApi()
    const device = deviceOf(api)
    const tab = await tabOn(api, device)
    await tab.todos.actions.open(OWNER, NAME)
    // No such issue: the run fails.
    tab.todos.actions.fromIssue(OWNER, NAME, 404)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "failed", listed: true, local: true }))
    const subject = tab.titled("Make TODO")!.id
    await tab.runtime.runPromise(dismiss(subject))
    await until(() => expect(tab.entry(subject)).toBeUndefined())
    await tab.runtime.dispose()
    const reloaded = await tabOn(api, device)
    await reloaded.runtime.runPromise(Effect.sleep("500 millis"))
    expect(reloaded.entry(subject)).toBeUndefined()
    reloaded.todos.actions.fromIssue(OWNER, NAME, 404)
    await until(() => expect(reloaded.entries().filter((entry) => entry.detail === "Make TODO" && entry.state === "failed")).toHaveLength(1))
  }, WITHIN)
})

describe("staged engine operations", () => {
  test("a Make TODO held before the engine recorded it resumes on reload; one the engine then refuses is Failed with Try again", async () => {
    const api = await openApi()
    await github(api).issue(7, "Fix it")
    const device = deviceOf(api)
    const tab = await tabOn(api, device, true)
    await tab.runtime.runPromise(tab.faults!.holdStarts)
    await tab.todos.actions.open(OWNER, NAME)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "waiting", word: "Requested" }))
    const subject = tab.titled("Make TODO")!.id
    await tab.runtime.dispose()
    // Reopened on an engine that refuses it: the refusal is the engine's answer, so it is Failed, with Try again.
    const refusing = await tabOn(api, device, true)
    await refusing.runtime.runPromise(refusing.faults!.refuseStarts("todo/issue"))
    await refusing.runtime.runPromise(resumeAdmissions)
    await until(() => expect(refusing.said(subject)).toMatchObject({ state: "failed", local: true }))
    expect(refusing.entry(subject)!.action).toBe("retry")
    await refusing.runtime.dispose()
    // Reopened again on a healthy engine: the same execution runs and keeps the draft.
    const reloaded = await tabOn(api, device)
    await reloaded.runtime.runPromise(resumeAdmissions)
    await until(() => expect(reloaded.said(subject)?.state).toBe("done"))
    expect(reloaded.runtime.runSync(reloaded.todosStore.drafts.toArray)).toHaveLength(1)
  }, WITHIN)

  test("an engine input an older tab staged without its door starts through the button door on reload", async () => {
    const api = await openApi()
    await github(api).issue(7, "Fix it")
    const device = deviceOf(api)
    const tab = await tabOn(api, device)
    await tab.todos.actions.open(OWNER, NAME)
    expect(tab.intents.retain({ commandId: crypto.randomUUID(), flow: "todo/issue", payload: { repo: TEST_REPOSITORY, issue: 7 } })).toBe(true)
    await tab.runtime.runPromise(resumeAdmissions)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "done" }))
    const runs = await tab.runtime.runPromise(Effect.flatMap(BrowserEngine.BrowserEngine, (engine) => engine.list({ limit: 5 })))
    expect(runs.runs.find((run) => `run:${run.runId}` === tab.titled("Make TODO")!.id)?.origin?.door).toBe("button")
  }, WITHIN)

  test("refused, then Try again whose reply is lost while reads fail: Requested, never the old Failed; then the run's Done", async () => {
    const api = await openApi()
    await github(api).issue(7, "Fix it")
    const tab = await tabOn(api, deviceOf(api), true)
    await tab.runtime.runPromise(tab.faults!.refuseStarts("todo/issue"))
    await tab.todos.actions.open(OWNER, NAME)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "failed", action: "retry" }))
    const subject = tab.titled("Make TODO")!.id
    await tab.runtime.runPromise(Effect.all([
      tab.faults!.holdRunReads, tab.faults!.admitStarts("todo/issue"), tab.faults!.loseStartReplies("todo/issue"),
    ]))
    await tab.runtime.runPromise(retry(subject))
    await until(() => expect(tab.runtime.runSync(tab.todosStore.drafts.toArray)).toHaveLength(1))
    await tab.runtime.runPromise(Effect.sleep("300 millis"))
    expect(tab.said(subject)).toMatchObject({ state: "waiting", word: "Requested" })
    await tab.runtime.runPromise(tab.faults!.readRuns)
    await until(() => expect(tab.said(subject)?.state).toBe("done"))
    expect(tab.states(subject).slice(1)).not.toContain("failed")
  }, WITHIN)

  test("a start no engine answered stays Requested with Try again, which runs the same execution once the engine answers", async () => {
    const api = await openApi()
    await github(api).issue(7, "Fix it")
    const tab = await tabOn(api, deviceOf(api), true)
    await tab.runtime.runPromise(tab.faults!.dropStarts("todo/issue"))
    await tab.todos.actions.open(OWNER, NAME)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "waiting", word: "Requested", action: "retry" }))
    const subject = tab.titled("Make TODO")!.id
    await tab.runtime.runPromise(tab.faults!.admitStarts("todo/issue"))
    await tab.runtime.runPromise(retry(subject))
    await until(() => expect(tab.said(subject)?.state).toBe("done"))
    expect(tab.states(subject).some((state) => state.startsWith("failed"))).toBe(false)
    expect(tab.runtime.runSync(tab.todosStore.drafts.toArray)).toHaveLength(1)
  }, WITHIN)

  test("Make TODO pressed again before its run settled joins it; once it settled, a press is a new one", async () => {
    const api = await openApi()
    await github(api).issue(7, "Fix it")
    const tab = await tabOn(api, deviceOf(api))
    await tab.todos.actions.open(OWNER, NAME)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    expect(tab.intents.pending().filter((intent) => intent.flow === "todo/issue")).toHaveLength(1)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "done" }))
    await until(() => expect(tab.intents.pending()).toEqual([]))
    expect(tab.runtime.runSync(tab.todosStore.drafts.toArray)).toHaveLength(1)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(tab.runtime.runSync(tab.todosStore.drafts.toArray)).toHaveLength(2))
  }, WITHIN)

  test("a run that settled out of the feed's sight still retires its input on reload: the engine's own answer does", async () => {
    const api = await openApi()
    await github(api).issue(7, "Fix it")
    const device = deviceOf(api)
    const tab = await tabOn(api, device, true)
    await tab.runtime.runPromise(tab.faults!.holdRunReads)
    await tab.todos.actions.open(OWNER, NAME)
    // The dispatch's answer is lost too, so only a later answer can settle it.
    await tab.runtime.runPromise(tab.faults!.loseStartReplies("todo/issue"))
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(tab.runtime.runSync(tab.todosStore.drafts.toArray)).toHaveLength(1))
    expect(tab.intents.pending().filter((intent) => intent.flow === "todo/issue")).toHaveLength(1)
    await tab.runtime.dispose()
    // Reopened where the feed still can't read the run, as for a run older than its window.
    const reloaded = await tabOn(api, device, true)
    await reloaded.runtime.runPromise(reloaded.faults!.holdRunReads)
    await reloaded.runtime.runPromise(resumeAdmissions)
    await until(() => expect(reloaded.intents.pending()).toEqual([]))
    expect(reloaded.runtime.runSync(reloaded.todosStore.drafts.toArray)).toHaveLength(1)
  }, WITHIN)

  test("a refused read of how the run ended proves nothing: no Failed, the input stays, the engine's record settles it", async () => {
    const api = await openApi()
    await github(api).issue(7, "Fix it")
    const tab = await tabOn(api, deviceOf(api), true)
    await tab.runtime.runPromise(tab.faults!.refuseNextResult("todo/issue"))
    await tab.todos.actions.open(OWNER, NAME)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "done" }))
    const subject = tab.titled("Make TODO")!.id
    expect(tab.states(subject).some((state) => state.startsWith("failed"))).toBe(false)
    expect(tab.intents.answered.size).toBe(0)
    await until(() => expect(tab.intents.pending()).toEqual([]))
    expect(tab.runtime.runSync(tab.todosStore.drafts.toArray)).toHaveLength(1)
  }, WITHIN)

  test("a tab that can't keep inputs keeps Make TODO's in memory: Requested, joined while it runs, and Done", async () => {
    const api = await openApi()
    await github(api).issue(7, "Fix it")
    const tab = await tabOn(api, { ...deviceOf(api), editorTabPersistent: false }, true)
    // The engine holds the start: the first press is still being admitted when the second comes.
    await tab.runtime.runPromise(tab.faults!.holdStarts)
    await tab.todos.actions.open(OWNER, NAME)
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "waiting", word: "Requested" }))
    tab.todos.actions.fromIssue(OWNER, NAME, 7)
    expect(tab.intents.pending().filter((intent) => intent.flow === "todo/issue")).toHaveLength(1)
    await tab.runtime.runPromise(tab.faults!.releaseStarts)
    await until(() => expect(tab.titled("Make TODO")).toMatchObject({ state: "done" }))
    await until(() => expect(tab.intents.pending()).toEqual([]))
    expect(tab.runtime.runSync(tab.todosStore.drafts.toArray)).toHaveLength(1)
    expect(tab.entries().filter((entry) => entry.detail === "Make TODO")).toHaveLength(1)
  }, WITHIN)

  test("Try again stays out of a page Retry already running, and a dismissal older than the list is forgotten", async () => {
    const api = await openApi()
    const tab = await tabOn(api, deviceOf(api))
    const writeId = await createIssue(tab, "Guarded")
    expect(await tab.runtime.runPromise(whileAdmitting(writeId, tab.attention.retryInput(`write:${writeId}`)))).toBe(false)
    await tab.runtime.runPromise(tab.attention.dismissed.insert({ id: "run:long-ago", at: 1 }))
    await until(() => expect(tab.runtime.runSync(tab.attention.dismissed.toArray)).toEqual([]))
  }, WITHIN)
})

describe("/new", () => {
  test("refused, then Try again admitted, then its run fails: the line stays the person's, never cleared at admission", async () => {
    const api = await openApi(undefined)
    api.branches.github.publish(OWNER, NAME, { defaultBranch: "main", branches: { main: "1".repeat(40), taken: "2".repeat(40) } })
    const tab = await tabOn(api, deviceOf(api), true)
    await tab.runtime.runPromise(tab.faults!.refuseStarts("conversation/new"))
    // A branch of that name is on the forge already: the run, once it runs, fails.
    const line = `/new ${TEST_REPOSITORY} taken`
    await tab.commands.actions.type(line)
    await tab.commands.actions.submit(line)
    await until(() => expect(tab.titled("New conversation")).toMatchObject({ state: "failed", action: "retry" }))
    const subject = tab.titled("New conversation")!.id
    await tab.runtime.runPromise(tab.faults!.admitStarts("conversation/new"))
    await tab.runtime.runPromise(retry(subject))
    await until(() => expect(tab.said(subject)).toMatchObject({ state: "failed", href: expect.stringMatching(/^\/app\/runs\//) }))
    const chat = await tab.runtime.runPromise(Effect.service(ChatStore))
    expect(chat.composer.tanstack.get(COMPOSER)?.draft).toBe(line)
    await until(() => expect(tab.intents.pending()).toEqual([]))
    expect(chat.composer.tanstack.get(COMPOSER)?.draft).toBe(line)
  }, WITHIN)

  test("Requested while the engine holds its start, chat still usable; a reload keeps it Requested, and resuming settles it", async () => {
    // The test API's own Member, whom its forge lets make branches.
    const api = await openApi(undefined)
    const device = deviceOf(api)
    const tab = await tabOn(api, device, true)
    // GitHub has the repository, whose default branch `/new` branches from.
    api.branches.github.publish(OWNER, NAME, { defaultBranch: "main", branches: { main: "1".repeat(40) } })
    await tab.runtime.runPromise(tab.faults!.holdStarts)
    const line = `/new ${TEST_REPOSITORY} progress-held`
    await tab.commands.actions.type(line)
    void tab.commands.actions.submit(line)
    await until(() => expect(tab.titled("New conversation")).toMatchObject({ state: "waiting", word: "Requested", stack: true, stackHere: true }))
    const subject = tab.titled("New conversation")!.id
    // Neither Dismiss nor Try again touches a live admission.
    await tab.runtime.runPromise(dismiss(subject))
    expect(await tab.runtime.runPromise(tab.attention.retryInput(subject))).toBe(false)
    expect(await tab.runtime.runPromise(tab.attention.retryInput("run:nothing-staged"))).toBe(false)
    expect(tab.said(subject)).toMatchObject({ state: "waiting", word: "Requested" })
    // The composer is the person's still.
    await tab.commands.actions.type("still usable")
    await tab.runtime.dispose()
    const reloaded = await tabOn(api, device)
    expect(reloaded.entry(subject)).toMatchObject({ state: "waiting", word: "Requested" })
    await reloaded.runtime.runPromise(resumeAdmissions)
    await until(() => expect(reloaded.said(subject)?.state, JSON.stringify({ said: reloaded.said(subject), states: reloaded.states(subject) })).toBe("done"))
    // Its result clears only its own line: the newer typing stays.
    await until(() => expect(reloaded.intents.pending()).toEqual([]))
    expect((await reloaded.runtime.runPromise(Effect.service(ChatStore))).composer.tanstack.get(COMPOSER)?.draft).toBe("still usable")
    expect(reloaded.said(subject)?.href).toMatch(/^\/app\/runs\//)
    expect(reloaded.states(subject).some((state) => state.startsWith("failed"))).toBe(false)
  }, WITHIN)
})

