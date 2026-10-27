import { PendingSnapshot } from "@smthrs/platform-browser"
import { WriteIntents } from "../../writeAdmission"
import { Effect, Option } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { nodeDevice, openTab, openTestApp, TEST_REPOSITORY, TestChatApi } from "../../test/chatApi"
import { SqlClient } from "effect/sql"
import { FlowDispatch } from "../../flows/dispatch"
import { type FlowName } from "../../flows/registry"
import { reloadAfter } from "../../test/reloadTiming"
import { AuthStore, SESSION } from "../auth/store"
import { ChatStore } from "../chat/store"
import { COMPOSER } from "../chat/schema"
import { IssuesStore } from "../issues/store"
import { TodosStore } from "../todos/store"
import { SteerWrites } from "../runs/writes"
import { Commands } from "./commands"
import { admitCommand } from "./admission"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose() })
const until = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 30_000, interval: 25 })
const open = async (refusing = false, engine = false) => {
  const app = openTestApp({ answers: false }, { actor: {
    subject: { kind: "person", id: "person-member" }, role: "admin", session: crypto.randomUUID(),
  } })
  runtimes.push(app)
  const api = await app.runPromise(Effect.service(TestChatApi))
  const base = nodeDevice(engine ? { agent: api } : {})
  const down: { value: boolean; hold?: () => Promise<void> } = { value: refusing }
  const retained = new Map<string, string>()
  const writeSnapshot = PendingSnapshot.make({ getItem: key => retained.get(key) ?? null, setItem: (key, value) => { retained.set(key, value) }, removeItem: key => { retained.delete(key) } }, "writes")
  const host = { ...base, writeSnapshot, outbox: { ...base.outbox, online: { ...base.outbox.online, isOnline: () => engine }, storage: { ...base.outbox.storage,
    set: async (key: string, value: string) => { await down.hold?.(); if (down.value) throw new Error("quota"); return base.outbox.storage.set(key, value) },
  } } }
  const tab = openTab(api, { host, answers: !engine ? false : undefined })
  runtimes.push(tab)
  const commands = await tab.runPromise(Effect.service(Commands))
  const auth = await tab.runPromise(Effect.service(AuthStore))
  await until(() => expect(auth.session.tanstack.get(SESSION)?.status).not.toBe("loading"))
  await tab.runPromise(auth.session.update(SESSION, (row) => { row.status = "signed_in"; row.role = "admin" }))
  return { app, api, host, down, tab, commands }
}

const writes: ReadonlyArray<readonly [FlowName, Record<string, unknown>]> = [
  ["issue/create", { repo: "octo/hello", title: "Title" }],
  ["issue/comment", { repo: "octo/hello", number: 7, body: "Comment" }],
  ["issue/triage", { repo: "octo/hello", number: 7, decision: "reject", reason: "Reason" }],
  ["issue/commitment", { repo: "octo/hello", number: 7, commitment: "next" }],
  ["triage/run", { repo: "octo/hello", number: 7 }],
  ["triage/enable", { repo: "octo/hello" }],
  ["triage/pause", { repo: "octo/hello" }],
  ["todo/commit", { repo: "octo/hello", title: "TODO", prompt: "Prompt" }],
  ["todo/commit", { repo: "octo/hello", title: "Full TODO", prompt: "Full prompt", acceptance: ["Done"], issue: 7 }],
  ["todo/drop", { repo: "octo/hello", number: 7 }],
  ["todo/Retry", { repo: "octo/hello", number: 7 }],
  ["run/steer", { runId: "todo:00000000-0000-4000-8000-000000000007", body: "Steer" }],
]

test("all command-capable outbox writes admit before an unavailable engine can run", async () => {
  const t = await open()
  expect(await t.tab.runPromise(admitCommand("app/theme/set", {}, crypto.randomUUID()))).toEqual(Option.none())
  expect(await t.tab.runPromise(admitCommand("issue/comment", { repo: "octo/hello", number: -1, body: "Bad" }, crypto.randomUUID()))).toEqual(Option.some("not_admitted"))
  for (const [name, payload] of writes) expect(await t.tab.runPromise(admitCommand(name, payload, crypto.randomUUID()))).toEqual(Option.some("queued"))
  const issues = await t.tab.runPromise(Effect.service(IssuesStore))
  const todos = await t.tab.runPromise(Effect.service(TodosStore))
  const steers = await t.tab.runPromise(Effect.service(SteerWrites))
  expect(await t.tab.runPromise(issues.sending.toArray)).toHaveLength(7)
  expect(await t.tab.runPromise(todos.sending.toArray)).toHaveLength(4)
  expect(await t.tab.runPromise(steers.sending.toArray)).toHaveLength(1)
})

for (const delay of [0, 100, 300] as const) {
  test(`slash issue and TODO writes survive reload after ${delay} ms`, async () => {
    const t = await open()
    for (const text of ["/issue octo/hello Slash title", "/comment octo/hello 7 Slash comment", "/triage octo/hello 7 accept", "/issue.commitment octo/hello 7 next", "/triage.run octo/hello 7", "/triage.enable octo/hello 123", "/triage.pause octo/hello", "/todo.drop octo/hello 7"]) {
      await t.commands.actions.type(text)
      await t.commands.actions.submit(text)
    }
    const issues = await t.tab.runPromise(Effect.service(IssuesStore))
    const todos = await t.tab.runPromise(Effect.service(TodosStore))
    const ids = (await t.tab.runPromise(issues.sending.toArray)).map((row) => row.id).sort()
    expect(ids).toHaveLength(7)
    const todoIds = (await t.tab.runPromise(todos.sending.toArray)).map((row) => row.id)
    expect(todoIds).toHaveLength(1)
    await reloadAfter(delay, () => t.tab.dispose())
    runtimes.splice(runtimes.indexOf(t.tab), 1)
    const restored = openTab(t.api, { host: t.host, answers: false })
    runtimes.push(restored)
    const nextIssues = await restored.runPromise(Effect.service(IssuesStore))
    const nextTodos = await restored.runPromise(Effect.service(TodosStore))
    await until(async () => expect((await restored.runPromise(nextIssues.sending.toArray)).map((row) => row.id).sort()).toEqual(ids))
    await until(async () => expect((await restored.runPromise(nextTodos.sending.toArray)).map((row) => row.id)).toEqual(todoIds))
  }, 90_000)
}

test("a refused slash admission retains the command and retries its original receipt", async () => {
  const t = await open(true)
  const issues = await t.tab.runPromise(Effect.service(IssuesStore))
  const todos = await t.tab.runPromise(Effect.service(TodosStore))
  for (const [text, store] of [["/comment octo/hello 7 Retained", issues], ["/todo.drop octo/hello 7", todos]] as const) {
    t.down.value = true
    await t.commands.actions.type(text)
    await t.commands.actions.submit(text)
    const [held] = await t.tab.runPromise<ReadonlyArray<{ readonly id: string; readonly status: string }>, never>(store.requested.toArray)
    expect(held?.status).toBe("not_sent")
    const intents = await t.tab.runPromise(Effect.service(WriteIntents))
    const commandId = intents.pending()[0]!.commandId
    await t.commands.actions.submit(text)
    expect(intents.pending().map(row => row.commandId)).toEqual([commandId])
    t.down.value = false
    await t.commands.actions.submit(text)
    expect((await t.tab.runPromise<ReadonlyArray<{ readonly id: string }>, never>(store.sending.toArray)).map((row) => row.id)).toContain(held!.id)
  }
})

test("a recovered slash command delivers the original write without starting a second flow", async () => {
  const t = await open(true, true)
  const issues = await t.tab.runPromise(Effect.service(IssuesStore))
  const text = `/comment ${TEST_REPOSITORY} 7 Retained by slash`
  await t.commands.actions.type(text)
  await t.commands.actions.submit(text)
  const [held] = await t.tab.runPromise(issues.requested.toArray)
  expect(held?.status).toBe("not_sent")
  t.down.value = false
  await t.commands.actions.submit(text)
  const rows = () => t.tab.runPromise(t.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly id: string }>`SELECT id::text AS id FROM github_writes`)))
  await until(async () => expect(await rows()).toEqual([{ id: held!.id }]))
  // A subsequent real engine dispatch is a barrier: its completion proves the worker is running,
  // while the recovered command must have skipped dispatch entirely.
  const dispatch = await t.tab.runPromise(Effect.service(FlowDispatch))
  expect(await t.tab.runPromise(dispatch.dispatch("app/theme/set", { mode: "dark" }, { door: "slash" }))).toMatchObject({ _tag: "Done" })
  expect(await rows()).toEqual([{ id: held!.id }])
}, 90_000)

test("steer command recovery reuses only the matching local refusal", async () => {
  const t = await open(true)
  const sent = (await t.tab.runPromise(Effect.service(SteerWrites))).sent
  const payload = { runId: `todo:${crypto.randomUUID()}`, body: "Retained steer" }
  for (const fields of [{ status: "sent" as const, reason: null }, { status: "not_sent" as const, reason: "not_working" as const }, { status: "not_sent" as const, reason: null, body: "Another message" }]) {
    await t.tab.runPromise(sent.insert({ ...payload, id: crypto.randomUUID(), queuedAt: 1, ...fields }))
  }
  expect(await t.tab.runPromise(admitCommand("run/steer", payload, crypto.randomUUID()))).toEqual(Option.some("not_admitted"))
  const held = (await t.tab.runPromise(sent.toArray)).find((row) => row.body === payload.body && row.status === "not_sent" && row.reason === null)!
  t.down.value = false
  expect(await t.tab.runPromise(admitCommand("run/steer", payload, crypto.randomUUID()))).toEqual(Option.some("recovered"))
  expect((await t.tab.runPromise((await t.tab.runPromise(Effect.service(SteerWrites))).sending.toArray)).map((row) => row.id)).toEqual([held.id])
})

for (const accepts of [true, false]) {
  test(`a ${accepts ? "queued" : "refused"} slash admission preserves later composer typing`, async () => {
    const t = await open(!accepts)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    t.down.hold = async () => { enter(); await held }
    const text = "/comment octo/hello 7 Earlier command"
    await t.commands.actions.type(text)
    const submitted = t.commands.actions.submit(text)
    try {
      await entered
      await t.commands.actions.type("Later draft")
    } finally { release() }
    await submitted
    const store = await t.tab.runPromise(Effect.service(ChatStore))
    expect(Option.getOrThrow(await t.tab.runPromise(store.composer.get(COMPOSER))).draft).toBe("Later draft")
  })
}

for (const [name, payload] of writes.filter(([flow]) => flow === "issue/comment" || flow === "todo/commit" || flow === "run/steer")) {
  test(`exact recovery keeps distinct ${name} identities even when their payloads match`, async () => {
    const t = await open(true)
    const first = crypto.randomUUID()
    const second = crypto.randomUUID()
    expect(await t.tab.runPromise(admitCommand(name, payload, first, "exact"))).toEqual(Option.some("not_admitted"))
    expect(await t.tab.runPromise(admitCommand(name, payload, second, "exact"))).toEqual(Option.some("not_admitted"))
    const rows = name === "run/steer" ? (await t.tab.runPromise(Effect.service(SteerWrites))).sent
      : name === "todo/commit" ? (await t.tab.runPromise(Effect.service(TodosStore))).requested
      : (await t.tab.runPromise(Effect.service(IssuesStore))).requested
    expect(new Set(rows.tanstack.toArray.map(row => row.id)).size).toBe(2)
  })
}

