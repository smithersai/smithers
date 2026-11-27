import { Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, expect, test, vi } from "vitest"
import { DEVICE_PRINCIPAL, type NodeDevice, nodeDevice, openTab, openTestApi, TestChatApi } from "../../test/chatApi"
import { read } from "../../test/otlp"
import { failRestore, holdRestore } from "../../test/restoreFailure"
import { asOneTab, capStorage, deferEvents, fillStorage } from "../../test/writeFailure"
import { DEVICE_ADOPTED_EVENT } from "../auth/contract"
import { AuthStore, SESSION } from "../auth/store.vibe"
import { StatusStore } from "../status/store"
import { accessOf } from "./contract"
import { BranchStore } from "../branch/store.vibe"
import * as Marks from "./marks"
import { ConversationOwners, type Fence } from "./owners"

// The conversations ChatApi refused the person a read of, as the device keeps them (owners.ts `refuse`,
// `ConversationRefusalsStore`, and Web Storage beside it): real ChatApi, Electric, the device's SQLite and its tabs'
// own coordinator. Faults are the device's stores': rows it cannot read, rows it reads late, and writes it cannot make.

const closing: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of closing.splice(0).reverse()) await runtime.dispose()
})
const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 10 })

const hello = { repository: "github/octo/hello", branch: "topic" }
const STORE = "conversation-refusals"

/**
 * The device's turn, taken once every turn asked for so far has ended: the refusals given so far are recorded, in
 * Web Storage and, taken or refused, in the device's store.
 */
const turns = (device: NodeDevice) => device.webStorage.lock(Marks.lockName(DEVICE_PRINCIPAL), async () => {})

const open = async (host: NodeDevice, existing?: TestChatApi["Service"], transport?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch) => {
  const api = existing ?? await (async () => {
    const runtime = openTestApi()
    closing.push(runtime)
    return runtime.runPromise(Effect.service(TestChatApi))
  })()
  const runtime = openTab(api, { host, ...(transport === undefined ? {} : { transport }) })
  closing.push(runtime)
  const owners = await runtime.runPromise(Effect.service(ConversationOwners))
  owners.shown.tanstack.startSyncImmediate()
  /** The person's conversations that may show now. */
  const all = () => owners.shown.tanstack.toArray.map((row) => row.conversationId)
  /**
   * Those of them that are not the home conversation. ChatApi answers the home conversation's reads for as long as the
   * tab is open, each its word that the person may read it; nothing reads a branch's here, so only the test answers.
   */
  const shown = () => all().filter((id) => id !== owners.home())
  const close = async () => {
    closing.splice(closing.indexOf(runtime), 1)
    await runtime.dispose()
  }
  /** ChatApi answered whole a read of `id` that began at `fence`: whether the answer was taken, once it is weighed. */
  const clear = (id: string, fence: Fence) => runtime.runPromise(owners.clear(id, fence))
  /** ChatApi answered whole a read of `id` that began now, once every refusal given so far is recorded. */
  const answer = async (id: string) => {
    await turns(host)
    return clear(id, owners.fence())
  }
  return { api, runtime, owners, host, all, shown, answer, clear, close }
}

/**
 * A branch conversation of the person's, by a route the device verified on `tab` as ChatApi answered for the branch:
 * kept on the device, so its other tabs and its later loads name it too, and open where Web Storage took it.
 */
const branch = async (tab: Awaited<ReturnType<typeof open>>, allowed = true) => {
  const routes = (await tab.runtime.runPromise(Effect.service(BranchStore))).conversations
  await tab.runtime.runPromise(routes.restored)
  const conversationId = crypto.randomUUID()
  const written = await tab.runtime.runPromise(routes.insert({ id: "octo/hello/topic", conversationId }))
  await tab.runtime.runPromise(written.persisted)
  // The route alone shows nothing: no key says the conversation is open, and nothing answered for it on this load.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(tab.shown()).not.toContain(conversationId)
  expect(await tab.answer(conversationId)).toBe(allowed)
  await until(() => expect(tab.shown()).toEqual(allowed ? [conversationId] : []))
  return conversationId
}

/** The conversation of each refusal the device's SQLite holds. */
const kept = (device: NodeDevice) =>
  (device.storedRows(STORE) as ReadonlyArray<{ readonly conversationId: string }>).map((row) => row.conversationId).sort()

/** The conversation of each refusal the device's Web Storage holds. */
const mirrored = (device: NodeDevice) => device.refusalMarks!.read().map((mark) => mark.conversationId).sort()

/** The key that says conversation `id` is open, in a test device's Web Storage. */
const openKey = (id: string) => Marks.keyOf("open", DEVICE_PRINCIPAL, id)

/** The key of the device's generation, in a test device's Web Storage. */
const EPOCH = Marks.keyOf("epoch", DEVICE_PRINCIPAL)

/** A real device whose SQLite refuses every write while `faults.fail`. */
const failingWrites = (device: NodeDevice) => {
  const faults = { fail: false }
  const host: NodeDevice = { ...device, persistence: { ...device.persistence, open: async () => {
    const database = await device.persistence.open()
    return { ...database, execute: <T>(sql: string, params?: ReadonlyArray<unknown>): Promise<ReadonlyArray<T>> =>
      faults.fail && /^\s*(insert|update|delete|replace)\b/i.test(sql) ? Promise.reject(new Error("disk full")) : database.execute<T>(sql, params) }
  } } }
  return { host, faults }
}

/** How many of the device's writes to `STORE` failed on `tab`, by operation. */
const writeFailures = (tab: Awaited<ReturnType<typeof open>>, operation: string) =>
  tab.runtime.runSync(Metric.value(Metric.withAttributes(Persistence.writeFailures, { collection: STORE, operation }))).count

const logged = (tab: Awaited<ReturnType<typeof open>>) =>
  read(tab.api.telemetry).log("conversations.refusals").map((record) => record.attributes?.outcome)

test("a refusal is kept on the device and hides the conversation on the next load, until ChatApi answers whole a read that began after it; nothing shows before the device's refusals are read", async () => {
  const device = nodeDevice()
  const first = await open(device)
  // A branch's conversation, the person's by the route the device verified.
  const topic = await branch(first)
  const [other, another] = [crypto.randomUUID(), crypto.randomUUID()]
  // ChatApi refuses three conversations, one of them twice: each is hidden in the call, and a refusal of each is kept,
  // in the device's store and in its Web Storage. The one refused twice keeps one: its refusal moved (`refuse`).
  for (const id of [topic, other, another, other]) first.owners.refuse(id)
  expect(first.shown()).toEqual([])
  const each = [topic, other, another].sort()
  await turns(device)
  expect(mirrored(device)).toEqual(each)
  await until(() => expect(kept(device)).toEqual(each))
  await first.close()

  // The next load reads the device's refusals late. Until it has, no conversation shows, the person's own included:
  // which were refused is not known.
  const late = holdRestore(device, STORE)
  const second = await open(late.device, first.api)
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(second.all()).toEqual([])
  // Meanwhile ChatApi answers a read of the branch's conversation whole, and refuses `other` again. A branch route the
  // device verified comes and goes: its conversation is nobody's by the time the refusals are read.
  // The answer is weighed at once, and its turn ends only once the device's rows are read and written.
  const answered = second.answer(topic)
  await until(() => expect(mirrored(device)).not.toContain(topic))
  second.owners.refuse(other)
  const routes = (await second.runtime.runPromise(Effect.service(BranchStore))).conversations
  await second.runtime.runPromise(routes.restored)
  await second.runtime.runPromise(routes.insert({ id: "octo/hello/gone", conversationId: crypto.randomUUID() }))
  await second.runtime.runPromise(routes.delete("octo/hello/gone"))
  expect(second.all()).toEqual([])
  late.release()
  // Read: ChatApi's answer was later than the refusal the device kept, which Web Storage told this load of at its
  // start. The branch's conversation shows, and the device keeps that refusal no longer. The others stay kept.
  expect(await answered).toBe(true)
  await until(() => expect(second.shown()).toEqual([topic]))
  // `other`, refused again on this load, keeps the one refusal the device held of it, said again.
  const rest = [other, another].sort()
  await until(() => expect(kept(device)).toEqual(rest))
  await turns(device)
  expect(mirrored(device)).toEqual(rest)
  // Refused again, and answered again: hidden and shown in the call, kept and dropped on the device.
  second.owners.refuse(topic)
  expect(second.shown()).toEqual([])
  await until(() => expect(kept(device)).toContain(topic))
  await second.answer(topic)
  expect(second.shown()).toEqual([topic])
  await until(() => expect(kept(device)).toEqual(rest))
  // An answer to a read that began before the second of two refusals removes nothing: the refusal the device held
  // was said again, and is later than that read.
  await turns(device)
  const between = second.owners.fence()
  second.owners.refuse(another)
  expect(await second.clear(another, between)).toBe(false)
  await until(() => expect(kept(device)).toEqual(rest))
  await turns(device)
  expect(mirrored(device)).toEqual(rest)
  await second.close()

  // A third load, with a refusal of the branch's conversation kept: it stays hidden with nothing told to this tab.
  const third = await open(device, first.api)
  await until(() => expect(third.shown()).toEqual([topic]))
  third.owners.refuse(topic)
  await until(() => expect(kept(device)).toContain(topic))
  await third.close()
  const fourth = await open(device, first.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(fourth.shown()).toEqual([])
  await fourth.answer(topic)
  await until(() => expect(fourth.shown()).toEqual([topic]))
}, 120_000)

test("an answer never removes a refusal recorded after its read began, in this tab or another: the next read's answer does", async () => {
  const device = nodeDevice()
  const one = await open(device)
  const two = await open(device, one.api)
  const topic = await branch(one)
  await until(() => expect(two.shown()).toHaveLength(1))
  // In one tab: a read begins, ChatApi refuses the conversation, and the read is then answered whole. The answer may
  // be older than the refusal, so the refusal stands.
  const stale = one.owners.fence()
  one.owners.refuse(topic)
  expect(await one.clear(topic, stale)).toBe(false)
  expect(one.shown()).toEqual([])
  // The other tab, which never read the conversation, hides it as the device stores the refusal.
  await until(() => expect(two.shown()).toEqual([]))
  await until(() => expect(kept(device)).toEqual([topic]))
  // A read the second tab began before it heard of the first tab's refusal is answered after: the refusal stands, in
  // both tabs and on the device.
  const third = await open(device, one.api)
  await until(() => expect(third.shown()).toEqual([]))
  const now = two.owners.fence()
  expect(await two.clear(topic, { ...now, seq: now.seq - 1 })).toBe(false)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect([one.shown(), two.shown(), third.shown()]).toEqual([[], [], []])
  expect(kept(device)).toEqual([topic])
  // A read that began after it is answered whole: the conversation shows again in every tab, and the device keeps
  // nothing.
  await two.answer(topic)
  expect(two.shown()).toEqual([topic])
  await until(() => expect(one.shown()).toEqual([topic]))
  await until(() => expect(third.shown()).toEqual([topic]))
  await until(() => expect(kept(device)).toEqual([]))
  expect(mirrored(device)).toEqual([])
}, 60_000)

test("a conversation is one of the person's while a branch route the device verified, or the session, names it", async () => {
  const tab = await open(nodeDevice())
  await until(() => expect(tab.all()).toHaveLength(1))
  const [home] = tab.all() as [string]
  const run = tab.runtime.runPromise
  const routes = (await run(Effect.service(BranchStore))).conversations
  await run(routes.restored)
  const [one, two] = [crypto.randomUUID(), crypto.randomUUID()]
  const shown = () => tab.all().sort()
  // Two routes of one conversation, and a row that is no route: the conversation is theirs, once.
  await run(routes.insert([
    { id: "octo/hello/first", conversationId: one },
    { id: "octo/hello/second", conversationId: one },
    { id: "not-a-route", conversationId: two },
  ]))
  await new Promise((resolve) => setTimeout(resolve, 50))
  // A route names it, and nothing says it is open: ChatApi's answer for the branch does, as `branch/track`'s is.
  expect(shown()).toEqual([home])
  await tab.answer(one)
  expect(shown()).toEqual([home, one].sort())
  // One of its two routes goes: still theirs. The other comes to name another conversation: that one is, and it is not.
  await run(routes.delete("octo/hello/first"))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(shown()).toEqual([home, one].sort())
  await run(routes.update("octo/hello/second", (row) => {
    row.conversationId = two
  }))
  await until(() => expect(shown()).toEqual([home]))
  await tab.answer(two)
  expect(shown()).toEqual([home, two].sort())
  // Refused, a conversation a route names is hidden like any other. A read that begins once the refusal is given,
  // before the device has recorded it, is later than it: what the tab then writes of that refusal is no news to it.
  tab.owners.refuse(two)
  expect(shown()).toEqual([home])
  const after = tab.owners.fence()
  expect(mirrored(tab.host)).toEqual([])
  expect(await tab.clear(two, after)).toBe(true)
  expect(shown()).toEqual([home, two].sort())
  expect(mirrored(tab.host)).toEqual([])
  await run(routes.delete("octo/hello/second"))
  await until(() => expect(shown()).toEqual([home]))
  // The session comes to name another conversation home: that one shows as the person's own.
  const auth = await run(Effect.service(AuthStore))
  await run(auth.session.update(SESSION, (row) => {
    row.homeConversationId = two
  }))
  await until(() => expect(tab.all()).toContain(two))
  // And then none: a session that names no home conversation leaves that one nobody's.
  await run(auth.session.update(SESSION, (row) => {
    delete row.homeConversationId
  }))
  await until(() => expect(tab.all()).not.toContain(two))
})

test("a device that cannot read its refusals shows no conversation on that load", async () => {
  const device = nodeDevice()
  const first = await open(device)
  const topic = await branch(first)
  first.owners.refuse(crypto.randomUUID())
  await until(() => expect(kept(device)).toHaveLength(1))
  await first.close()
  // A host with no Web Storage: the device's store is the only record.
  const { refusalMarks: _none, ...bare } = failRestore(device, STORE)
  const tab = await open(bare as NodeDevice, first.api)
  await until(() => expect(tab.runtime.runSync(Metric.value(Metric.withAttributes(Persistence.restoreFailures, { collection: STORE }))).count).toBe(1))
  // Which conversations were refused is not known, so none shows: not even the one ChatApi then answers a read of,
  // on this load.
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(tab.all()).toEqual([])
  await tab.answer(topic)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(tab.all()).toEqual([])
  await tab.close()
  expect(logged(tab)).toEqual(["unavailable"])
})

test("a refusal the device's store cannot take hides the conversation on this tab, in the device's other tabs, and on the next load, until ChatApi answers a read whole", async () => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  const tab = await open(host)
  const sibling = await open(device, tab.api)
  const topic = await branch(tab)
  await until(() => expect(sibling.shown()).toHaveLength(1))
  faults.fail = true
  tab.owners.refuse(topic)
  expect(tab.shown()).toEqual([])
  await until(() => expect(writeFailures(tab, "insert")).toBe(1))
  // The device's store holds nothing of it. Web Storage does, and the tab's own word stands.
  expect(kept(device)).toEqual([])
  expect(mirrored(device)).toEqual([topic])
  expect(tab.shown()).toEqual([])
  // The other tab heard of it through Web Storage, in the turn it was written: no stored row told it.
  expect(sibling.shown()).toEqual([])
  await sibling.close()
  await tab.close()
  expect(logged(tab)).toEqual(["mirrored"])

  // The next load, of a device whose store was never told: the conversation is hidden from the start, and stays
  // hidden. This load stores the refusal Web Storage held.
  faults.fail = false
  const next = await open(device, tab.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(next.shown()).toEqual([])
  await until(() => expect(kept(device)).toEqual([topic]))
  // A read ChatApi answers whole shows it again, and both records let it go.
  await next.answer(topic)
  expect(next.shown()).toEqual([topic])
  await until(() => expect(kept(device)).toEqual([]))
  expect(mirrored(device)).toEqual([])
  await next.close()
  const later = await open(device, tab.api)
  await until(() => expect(later.shown()).toEqual([topic]))
}, 60_000)

test("an answer the device's store cannot take shows the conversation on this tab; the next load hides it until a read is answered", async () => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  const tab = await open(host)
  const topic = await branch(tab)
  tab.owners.refuse(topic)
  await until(() => expect(kept(device)).toEqual([topic]))
  faults.fail = true
  await tab.answer(topic)
  expect(tab.shown()).toEqual([topic])
  await until(() => expect(writeFailures(tab, "delete")).toBe(1))
  // The store's row came back as its write failed: this tab removed that refusal, and does not take it up again.
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(tab.shown()).toEqual([topic])
  expect(kept(device)).toEqual([topic])
  await tab.close()
  expect(logged(tab)).toEqual(["mirrored"])
  // The device still says refused, so the next load hides it (fail closed) until ChatApi answers.
  faults.fail = false
  const next = await open(device, tab.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(next.shown()).toEqual([])
  await next.answer(topic)
  await until(() => expect(kept(device)).toEqual([]))
}, 60_000)

test("a refusal neither store takes still hides the conversation on this tab and on the next load: storage that is full still takes away that the conversation is open, and the generation it could not move", async () => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  const { device: { refusalMarks: marks }, quota } = fillStorage(device)
  const tab = await open({ ...host, refusalMarks: marks! })
  // With room, the branch's conversation is the device's to know, and open, and the device has a generation.
  const topic = await branch(tab)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
  expect(device.webStorage.entries.get(EPOCH)).toMatch(/^[0-9a-f]{16}$/)
  // The disk fills and Web Storage reaches its quota: ChatApi's refusal reaches neither store.
  faults.fail = true
  quota.full = true
  tab.owners.refuse(topic)
  expect(tab.shown()).toEqual([])
  // What full storage still took, in the call: the conversation is open no longer, and the generation, which could
  // not be written over, is gone, so no read begun before the refusal finds the one it began at.
  expect([device.webStorage.entries.has(openKey(topic)), device.webStorage.entries.has(EPOCH)]).toEqual([false, false])
  await until(() => expect(writeFailures(tab, "insert")).toBe(1))
  await turns(device)
  expect(kept(device)).toEqual([])
  expect(mirrored(device)).toEqual([])
  expect(tab.shown()).toEqual([])
  await tab.close()
  expect(logged(tab)).toEqual(["unstored"])

  // The next load, of a device no store of which holds a refusal: the conversation the session still names topic shows
  // nothing, for as long as nothing answers a read of it.
  faults.fail = false
  const next = await open({ ...device, refusalMarks: marks! }, tab.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(next.shown()).toEqual([])
  expect(kept(device)).toEqual([])
  // Storage is still full. Even an authoritative response cannot establish a grant without a generation.
  expect(await next.answer(topic)).toBe(false)
  expect(next.shown()).toEqual([])
  expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
  await next.close()
  const third = await open({ ...device, refusalMarks: marks! }, tab.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(third.shown()).toEqual([])
  // Room is made while a read is under way. Its null fence still blocks the answer.
  const began = third.owners.fence()
  expect(began.epoch).toBeNull()
  quota.full = false
  expect(await third.clear(topic, began)).toBe(false)
  expect(third.shown()).toEqual([])
  expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
  // A fresh read establishes a generation.
  expect(third.owners.fence().epoch).toMatch(/^[0-9a-f]{16}$/)
  expect(await third.answer(topic)).toBe(true)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
  await third.close()
  const fourth = await open(device, tab.api)
  await until(() => expect(fourth.shown()).toEqual([topic]))
}, 60_000)

test("a refusal no store took hides the conversation in the device's other tabs too, until a read of theirs that began after it is answered", async () => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  const { device: full, quota } = fillStorage(host)
  const tab = await open(full)
  const sibling = await open(fillStorage(device, quota).device, tab.api)
  const topic = await branch(tab)
  await until(() => expect(sibling.shown()).toHaveLength(1))
  faults.fail = true
  quota.full = true
  const before = sibling.owners.fence()
  tab.owners.refuse(topic)
  // No refusal reached Web Storage. The other tab heard the one thing full storage still does, in the turn it did.
  await turns(device)
  expect(mirrored(device)).toEqual([])
  expect(sibling.shown()).toEqual([])
  // A read the other tab began before it heard is answered: the refusal may be later, and stands.
  expect(await sibling.clear(topic, before)).toBe(false)
  expect(sibling.shown()).toEqual([])
  // The refusal left the device without a generation. The sibling needs room for a fresh fence.
  expect(await sibling.answer(topic)).toBe(false)
  expect(sibling.shown()).toEqual([])
  expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
  quota.full = false
  expect(await sibling.answer(topic)).toBe(true)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
  // The refusing tab heard that, and its own refusal stands all the same, until a read of its own is answered.
  expect(tab.shown()).toEqual([])
  expect(await tab.answer(topic)).toBe(true)
  expect(tab.shown()).toEqual([topic])
}, 60_000)

test("a read refused again while its conversation is hidden is a later refusal: the answer to a read begun between the two removes it in no tab, though the refusing tab closes first", async () => {
  const device = nodeDevice()
  // Each tab is told of the other's writes to Web Storage and never of its own, as a browser tells them.
  const one = await open(asOneTab(device))
  const two = await open(asOneTab(device), one.api)
  const topic = await branch(one)
  await until(() => expect(two.shown()).toHaveLength(1))
  one.owners.refuse(topic)
  await until(() => expect(two.shown()).toEqual([]))
  await until(() => expect(kept(device)).toEqual([topic]))
  const [refusal] = device.storedRows(STORE) as [{ readonly id: string }]
  // A sibling read begins in each tab, after the refusal. Then the hidden reader's retry is refused again: the
  // refusal it kept is the same one, said again, and so later than both reads in both tabs.
  await turns(device)
  const [here, there] = [one.owners.fence(), two.owners.fence()]
  one.owners.refuse(topic)
  // In the call: the device's generation is no longer the one either read began at.
  expect(device.webStorage.entries.get(EPOCH)).not.toBe(there.epoch)
  await turns(device)
  expect(one.owners.fence().seq).toBeGreaterThan(here.seq)
  expect(two.owners.fence().seq).toBeGreaterThan(there.seq)
  expect(mirrored(device)).toEqual([topic])
  expect(device.storedRows(STORE)).toEqual([expect.objectContaining({ id: refusal.id })])
  // The sibling read in the refusing tab is answered whole: its answer may be older than the second refusal.
  expect(await one.clear(topic, here)).toBe(false)
  expect(one.shown()).toEqual([])
  // The refusing tab closes. The other tab's sibling read is answered whole only now: the refusal stands there too,
  // on the device and for the next load.
  await one.close()
  expect(await two.clear(topic, there)).toBe(false)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(two.shown()).toEqual([])
  expect(device.storedRows(STORE)).toEqual([expect.objectContaining({ id: refusal.id })])
  expect(mirrored(device)).toEqual([topic])
  const next = await open(asOneTab(device), one.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(next.shown()).toEqual([])
  // A refusal another tab recorded is said again the same way by a tab refused the same conversation: one refusal
  // kept, later than every read begun in either tab.
  await turns(device)
  const stale = two.owners.fence()
  next.owners.refuse(topic)
  await turns(device)
  expect(device.storedRows(STORE)).toEqual([expect.objectContaining({ id: refusal.id })])
  expect(await two.clear(topic, stale)).toBe(false)
  expect(two.shown()).toEqual([])
  // A read that began after the last refusal is answered whole: the conversation shows in both, and neither store
  // keeps a refusal.
  expect(await two.answer(topic)).toBe(true)
  expect(two.shown()).toEqual([topic])
  await until(() => expect(next.shown()).toEqual([topic]))
  await until(() => expect(kept(device)).toEqual([]))
  expect(mirrored(device)).toEqual([])
}, 60_000)

test("a read refused again that Web Storage cannot say again still outlasts another tab's answer to a read begun before it", async () => {
  const device = nodeDevice()
  const { device: full, quota } = fillStorage(device)
  const one = await open(full)
  const two = await open(device, one.api)
  const topic = await branch(one)
  await until(() => expect(two.shown()).toHaveLength(1))
  // Every time the refusing tab comes to show the conversation under test.
  const shows: Array<string> = []
  const watching = one.owners.shown.tanstack.subscribeChanges((changes) => {
    for (const change of changes) if (change.type === "insert" && change.key === topic) shows.push(String(change.key))
  })
  one.owners.refuse(topic)
  await until(() => expect(two.shown()).toEqual([]))
  await until(() => expect(kept(device)).toEqual([topic]))
  const [refusal] = device.storedRows(STORE) as [{ readonly id: string }]
  await turns(device)
  // The other tab's read begins. The refusing tab is refused again with Web Storage taking no write at all: no
  // refusal's key tells the other tab. The generation, which could not be written over, is removed in the call.
  const there = two.owners.fence()
  quota.full = true
  one.owners.refuse(topic)
  expect(two.owners.fence().seq).toBe(there.seq)
  expect(two.owners.fence().epoch).not.toBe(there.epoch)
  // The other tab's read is answered whole: it began at a generation the device no longer holds, so it removes
  // nothing, in either store.
  expect(await two.clear(topic, there)).toBe(false)
  expect(device.storedRows(STORE).map((row) => (row as { readonly conversationId: string }).conversationId)).toEqual([topic])
  // The refusing tab recorded a refusal of its own in its place as it was refused, held before the first one went,
  // and sent to the device's store whether or not the tab lives on: it shows the conversation at no moment, and the
  // other tab holds the new refusal as the device stores it.
  await until(() => expect(device.storedRows(STORE)).toEqual([expect.objectContaining({ conversationId: topic, id: expect.not.stringMatching(refusal.id) })]))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect([one.shown(), two.shown()]).toEqual([[], []])
  expect(shows).toEqual([])
  // Another tab's refusal, which Web Storage holds, is no record of the refusal of a tab that cannot say it again
  // there: that tab keeps one of its own.
  two.owners.refuse(topic)
  await until(() => expect(kept(device)).toEqual([topic, topic]))
  await turns(device)
  expect(mirrored(device)).toEqual([topic])
  const three = await open(full, one.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(three.shown()).toEqual([])
  three.owners.refuse(topic)
  await until(() => expect(kept(device)).toEqual([topic, topic, topic]))
  await turns(device)
  expect(mirrored(device)).toEqual([topic])
  const beganFull = one.owners.fence()
  expect(beganFull.epoch).toBeNull()
  quota.full = false
  expect(await one.clear(topic, beganFull)).toBe(false)
  expect(one.shown()).toEqual([])
  expect(one.owners.fence().epoch).toMatch(/^[0-9a-f]{16}$/)
  for (const tab of [one, two, three]) await tab.answer(topic)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
  for (const tab of [one, two, three]) await until(() => expect(tab.shown()).toEqual([topic]))
  await until(() => expect(kept(device)).toEqual([]))
  expect(mirrored(device)).toEqual([])
  watching.unsubscribe()
}, 60_000)

test("a refusal only Web Storage holds goes from a tab that only lists the conversation as another tab's read is answered whole; a refusal of its own stands", async () => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  const tab = await open(host)
  const listing = await open(device, tab.api)
  const topic = await branch(tab)
  await until(() => expect(listing.shown()).toHaveLength(1))
  faults.fail = true
  tab.owners.refuse(topic)
  await until(() => expect(writeFailures(tab, "insert")).toBe(1))
  await turns(device)
  expect(kept(device)).toEqual([])
  expect(mirrored(device)).toEqual([topic])
  expect(listing.shown()).toEqual([])
  // ChatApi answers the first tab's next read whole. No stored row goes, since none was stored: the listing tab hears
  // Web Storage let the refusal go, and shows the conversation in that turn.
  expect(await tab.answer(topic)).toBe(true)
  expect(mirrored(device)).toEqual([])
  expect(tab.shown()).toEqual([topic])
  expect(listing.shown()).toEqual([topic])

  // Again, and this time the listing tab is refused a read of its own after the first tab's next read began. That
  // read's answer may be older than the listing tab's refusal, so it removes nothing: the refusal, said again by the
  // listing tab, stands in both tabs, until a read that began after it is answered.
  tab.owners.refuse(topic)
  expect(listing.shown()).toEqual([])
  await turns(device)
  const began = tab.owners.fence()
  listing.owners.refuse(topic)
  expect(await tab.clear(topic, began)).toBe(false)
  await turns(device)
  expect(mirrored(device)).toEqual([topic])
  expect(tab.shown()).toEqual([])
  expect(listing.shown()).toEqual([])
  expect(await listing.answer(topic)).toBe(true)
  expect(listing.shown()).toEqual([topic])
  expect(mirrored(device)).toEqual([])
  await until(() => expect(tab.shown()).toEqual([topic]))

  // Once more: the first tab's refusal is held by Web Storage only, and the listing tab is refused a read of its own
  // while another tab holds the device's turn. Before the listing tab's turn comes, a read that began after its
  // refusal is answered whole elsewhere. The pending local refusal still hides the conversation and is recorded
  // once its turn arrives.
  tab.owners.refuse(topic)
  await turns(device)
  expect([mirrored(device), listing.shown()]).toEqual([[topic], []])
  const gate = Promise.withResolvers<void>()
  const held = device.webStorage.lock(Marks.lockName(DEVICE_PRINCIPAL), () => gate.promise)
  listing.owners.refuse(topic)
  const others = device.refusalMarks!
  others.remove(others.read())
  others.grant(topic)
  expect(listing.shown()).toEqual([])
  gate.resolve()
  await held
  await turns(device)
  expect([mirrored(device), device.webStorage.entries.has(openKey(topic)), listing.shown()]).toEqual([[topic], false, []])
}, 60_000)

test("Web Storage cleared under a tab opens nothing and hides nothing it holds; what a tab hears twice is one refusal, and what it never knew is none", async () => {
  const device = nodeDevice()
  // What the browser tells this tab of the storage, as the test says it.
  const tells = new Set<(key: string | null) => void>()
  // Web Storage that keeps a key it is asked to remove while `stuck.on`.
  const stuck = { on: false }
  const web = device.webStorage
  const marks = Marks.make({
    channel: () => undefined,
    storage: {
      getItem: web.getItem,
      setItem: web.setItem,
      key: web.key,
      get length() {
        return web.length
      },
      removeItem: (key) => {
        if (!stuck.on) web.removeItem(key)
      },
    },
    principal: () => DEVICE_PRINCIPAL,
    changes: (listener) => {
      tells.add(listener)
      return () => void tells.delete(listener)
    },
  })
  const tell = (key: string | null) => {
    for (const listener of tells) listener(key)
  }
  const tab = await open({ ...device, refusalMarks: marks })
  const topic = await branch(tab)
  const other = crypto.randomUUID()
  tab.owners.refuse(other)
  await until(() => expect(kept(device)).toEqual([other]))
  // Cleared: the tab keeps what it knows. The conversation it shows stays shown, and the one refused stays refused.
  device.webStorage.clear()
  tell(null)
  expect(tab.shown()).toEqual([topic])
  expect(kept(device)).toEqual([other])
  // Told, as another tab's refusal tells it, that the branch's conversation is open no longer, and told again before
  // anything says it is open: one refusal, in this tab's memory.
  const fence = tab.owners.fence()
  tell(openKey(topic))
  tell(openKey(topic))
  expect(tab.shown()).toEqual([])
  expect(tab.owners.fence().seq).toBe(fence.seq + 1)
  // Told of a refusal it never knew, gone already: nothing changes.
  tell(Marks.keyOf("refused", DEVICE_PRINCIPAL, topic, "gone"))
  expect(tab.owners.fence().seq).toBe(fence.seq + 1)
  await tab.answer(topic)
  expect(tab.shown()).toEqual([topic])
  // Answered again, with nothing refused: nothing changes.
  await tab.answer(topic)
  expect(tab.shown()).toEqual([topic])
  // A refusal the tab removed whose key Web Storage would not let go: told of that key, the tab does not take the
  // refusal up again, but the live key still blocks admission.
  stuck.on = true
  tab.owners.refuse(topic)
  const [left] = marks.read().filter((mark) => mark.conversationId === topic)
  await tab.answer(topic)
  expect(marks.has(left!)).toBe(true)
  const clearedAt = tab.owners.fence().seq
  tell(Marks.keyOf("refused", DEVICE_PRINCIPAL, topic, left!.id))
  expect(tab.owners.fence().seq).toBe(clearedAt)
  expect(tab.owners.refused(topic)).toBe(true)
  expect(tab.shown()).toEqual([])
}, 60_000)

/** A real device whose SQLite holds each write to `STORE`'s rows until `settle` is called, then takes it (`true`) or refuses it. */
const heldWrites = (device: NodeDevice) => {
  const held = Promise.withResolvers<boolean>()
  const seen = { writes: 0 }
  const host: NodeDevice = { ...device, persistence: { ...device.persistence, open: async () => {
    const database = await device.persistence.open()
    let table: string | undefined
    return { ...database, execute: async <T>(sql: string, params?: ReadonlyArray<unknown>): Promise<ReadonlyArray<T>> => {
      if (/^\s*(insert|update|delete|replace)\b/i.test(sql)) {
        table ??= (await database.execute<{ readonly table_name: string }>(
          "select table_name from collection_registry where collection_id = ?",
          [STORE],
        ))[0]?.table_name
        if (table !== undefined && sql.includes(table)) {
          seen.writes++
          if (!(await held.promise)) throw new Error("disk full")
        }
      }
      return database.execute<T>(sql, params)
    } }
  } } }
  return { host, seen, settle: (taken: boolean) => held.resolve(taken) }
}

test("Web Storage that was full when ChatApi first answered for a conversation leaves it nothing to show on the next load, though room is made since and no store holds its refusal", async () => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  const { device: { refusalMarks: marks }, quota } = fillStorage(device)
  // The first answer is rejected because storage was over quota before boot.
  quota.full = true
  const tab = await open({ ...host, refusalMarks: marks! })
  const topic = await branch(tab, false)
  expect([...device.webStorage.entries.keys()].filter((key) => key.includes(topic))).toEqual([])
  // Refused, with the disk full too: neither store holds the refusal, and there was no open key to take away.
  faults.fail = true
  tab.owners.refuse(topic)
  expect(tab.shown()).toEqual([])
  await until(() => expect(writeFailures(tab, "insert")).toBe(1))
  expect([kept(device), mirrored(device)]).toEqual([[], []])
  await tab.close()
  expect(logged(tab)).toEqual(["unstored"])
  // Room is made, on the disk and in Web Storage. The next load holds the route the device kept and no word that
  // the conversation is open: no key is not read as a conversation new to the device.
  faults.fail = false
  quota.full = false
  const next = await open(device, tab.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(next.shown()).toEqual([])
  expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
  // Only ChatApi's answer shows it, and is kept for the load after.
  await next.answer(topic)
  expect(next.shown()).toEqual([topic])
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
}, 60_000)

/** Runs SQL on the Postgres ChatApi reads. */
const sqlOn = (api: TestChatApi["Service"]) => <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(api.github.run(Effect.orDie(Effect.flatMap(SqlClient.SqlClient, use))))

/**
 * A conversation in the person's list, as ChatApi keeps it: branch `name` of `octo/hello`, made by `createdBy`, with
 * the person's row of it. Their own branch is theirs to read; another person's, shared with nobody, is not, and the
 * row is then all that is left of a share taken away.
 */
const listed = async (api: TestChatApi["Service"], name: string, createdBy: string = DEVICE_PRINCIPAL) => {
  const sql = sqlOn(api)
  const [conversationId, branchId] = [crypto.randomUUID(), crypto.randomUUID()]
  await sql((sql) => sql`INSERT INTO branches (id, repo_id, name, mode, created_by) VALUES (${branchId}, 'github/octo/hello', ${name}, 'open', ${createdBy})`)
  await sql((sql) => sql`INSERT INTO conversations (id, repo_id, branch_id) VALUES (${conversationId}, 'github/octo/hello', ${branchId})`)
  await sql((sql) => sql`
    INSERT INTO conversation_people (conversation_id, person_id, owner, repo, branch)
    VALUES (${conversationId}, ${DEVICE_PRINCIPAL}, 'octo', 'hello', ${name})`)
  return conversationId
}

/** A tab's network with ChatApi's access route as the test says: each question recorded, held, or left unanswered. */
const accessFaults = () => {
  const asked: Array<string> = []
  const net: { fault?: "offline" | number; held?: Promise<void> } = {}
  const transport = (fetch: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
    const request = new Request(input, init)
    const named = accessOf(new URL(request.url).pathname)
    if (named !== undefined) {
      asked.push(named)
      await net.held
      if (net.fault === "offline") throw new TypeError("fetch failed")
      if (net.fault !== undefined) return Response.json({ code: "unavailable" }, { status: net.fault })
    }
    return fetch(request)
  }
  return { transport, net, askedOf: (id: string) => asked.filter((named) => named === id).length }
}

test("a row of the person's list opens nothing by itself: ChatApi is asked whether they may read its conversation, and only its yes shows it, on a device new to it or one that kept the row", async () => {
  const device = nodeDevice()
  const { transport, net, askedOf } = accessFaults()
  const first = await open(device, undefined, transport)
  // ChatApi delivers the person's row of their own branch's conversation, which this device held nothing of. The row
  // opens nothing: ChatApi is asked, once, and its yes shows the conversation and is kept.
  const topic = await listed(first.api, "topic")
  await until(() => expect(first.all()).toContain(topic))
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
  expect(askedOf(topic)).toBe(1)
  // A row of a branch that is not theirs to read, as a share taken away leaves it in their list: ChatApi says no. The
  // conversation is refused, never shown, and nothing says it is open.
  const shows: Array<string> = []
  const watching = first.owners.shown.tanstack.subscribeChanges((changes) => {
    for (const change of changes) if (change.type === "insert") shows.push(String(change.key))
  })
  const gone = await listed(first.api, "gone", "person-other")
  await until(() => expect(first.owners.refused(gone)).toBe(true))
  await turns(device)
  expect([first.all().includes(gone), shows.includes(gone), device.webStorage.entries.has(openKey(gone))]).toEqual([false, false, false])
  expect(mirrored(device)).toEqual([gone])
  await until(() => expect(kept(device)).toEqual([gone]))
  expect(askedOf(gone)).toBe(1)

  // Both runs reach the raw shape. Only the one whose conversation was admitted can surface its run and wait.
  const status = await first.runtime.runPromise(Effect.service(StatusStore))
  status.shownRuns.tanstack.startSyncImmediate()
  status.waits.tanstack.startSyncImmediate()
  const allowedRun = crypto.randomUUID()
  const deniedRun = crypto.randomUUID()
  const wait = JSON.stringify({ execution: "run/call/0.0", kind: "question", prompt: "Which branch?", options: ["main", "release"] })
  await sqlOn(first.api)((sql) => sql`
    INSERT INTO runs (id, flow, status, waiting, wait, launched_by, conversation_id, branch_id, repo_id)
    SELECT r.id, 'chat/Answer', 'needs_you', 'input', ${wait}::jsonb, ${DEVICE_PRINCIPAL}, c.id, c.branch_id, c.repo_id
    FROM (VALUES (${allowedRun}::uuid, ${topic}::uuid), (${deniedRun}::uuid, ${gone}::uuid)) AS r(id, conversation_id)
    JOIN conversations c ON c.id = r.conversation_id`)
  await until(() => {
    expect(status.runs.tanstack.has(deniedRun)).toBe(true)
    expect(status.shownRuns.tanstack.toArray.map((row) => row.id)).toContain(allowedRun)
    expect(status.waits.tanstack.toArray.map((row) => row.runId)).toContain(allowedRun)
  })
  expect(status.shownRuns.tanstack.toArray.map((row) => row.id)).not.toContain(deniedRun)
  expect(status.waits.tanstack.toArray.map((row) => row.runId)).not.toContain(deniedRun)
  watching.unsubscribe()
  // The key is lost, as on a device that held the row before it kept such keys. The next load holds the row and no
  // word that the conversation is open: ChatApi is asked again. The one it refused is not asked of: it is refused.
  await first.close()
  device.webStorage.removeItem(openKey(topic))
  const second = await open(device, first.api, transport)
  await until(() => expect(second.all()).toContain(topic))
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
  expect([second.all().includes(gone), askedOf(topic), askedOf(gone)]).toEqual([false, 2, 1])
  await second.close()
  // A load ChatApi's route gives no answer on, offline and then failing: the row shows nothing and nothing is kept,
  // and nothing is refused. It is asked again each time ChatApi answers the person's list.
  device.webStorage.removeItem(openKey(topic))
  net.fault = "offline"
  const third = await open(device, first.api, transport)
  await until(() => expect(askedOf(topic)).toBeGreaterThan(2))
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect([third.all().includes(topic), third.owners.refused(topic), device.webStorage.entries.has(openKey(topic))]).toEqual([false, false, false])
  net.fault = 503
  const before = askedOf(topic)
  const other = await listed(first.api, "other")
  await until(() => expect(askedOf(other)).toBeGreaterThan(0))
  await until(() => expect(askedOf(topic)).toBeGreaterThan(before))
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(third.all().filter((id) => id === topic || id === other)).toEqual([])
  expect([third.owners.refused(topic), third.owners.refused(other)]).toEqual([false, false])
  // ChatApi answers again: asked as its list next answers, both show, and both are kept.
  delete net.fault
  const another = await listed(first.api, "another")
  await until(() => expect(third.all()).toEqual(expect.arrayContaining([topic, other, another])))
  expect([topic, other, another].map((id) => device.webStorage.entries.has(openKey(id)))).toEqual([true, true, true])
  expect(third.all()).not.toContain(gone)
}, 60_000)

test("ChatApi is asked of a listed conversation once at a time, and its yes is taken as any read's is: one a refusal overtook opens nothing, and is asked again", async () => {
  const device = nodeDevice()
  const { transport, net, askedOf } = accessFaults()
  const tab = await open(device, undefined, transport)
  const sql = sqlOn(tab.api)
  // ChatApi's answer is held on its way. The row changes meanwhile, as an archive does: no second question goes.
  const gate = Promise.withResolvers<void>()
  net.held = gate.promise
  const topic = await listed(tab.api, "topic")
  await until(() => expect(askedOf(topic)).toBe(1))
  await sql((sql) => sql`UPDATE conversation_people SET archived_at = now(), changed_at = now() WHERE conversation_id = ${topic}`)
  await until(() => expect(tab.owners.mine.tanstack.get(topic)?.archivedAt).not.toBeNull())
  expect([askedOf(topic), tab.all().includes(topic)]).toEqual([1, false])
  // A refusal is given meanwhile, of another conversation: the device's generation moves. The yes on its way began
  // before it, so it opens nothing; ChatApi is asked again, and that yes, begun after, shows the conversation.
  tab.owners.refuse(crypto.randomUUID())
  delete net.held
  gate.resolve()
  await until(() => expect(tab.all()).toContain(topic))
  expect(askedOf(topic)).toBe(2)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
}, 60_000)

test("a branch ChatApi refused is refused whatever conversation the device comes to name for it: a row read late or a route saved since is refused as it is named, once, until ChatApi's answer for the branch is taken", async () => {
  const device = nodeDevice()
  const first = await open(device)
  // The person's own branch, verified and open: its row and its `open` key are on the device.
  const topic = await listed(first.api, "topic")
  await until(() => expect(first.all()).toContain(topic))
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
  await first.close()
  // The next load reads the person's list late. ChatApi refuses the branch meanwhile: the device names no conversation
  // for it yet, so none is refused, and every read begun so far is older than the refusal all the same.
  const late = holdRestore(device, "my-conversations")
  const tab = await open(late.device, first.api)
  const shows: Array<string> = []
  const watching = tab.owners.shown.tanstack.subscribeChanges((changes) => {
    for (const change of changes) if (change.type === "insert") shows.push(String(change.key))
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(tab.owners.mine.tanstack.has(topic)).toBe(false)
  const before = tab.owners.fence()
  tab.owners.refuseBranch(hello.repository, hello.branch)
  expect(tab.owners.fence().seq).toBeGreaterThan(before.seq)
  await turns(device)
  expect(tab.owners.fence().epoch).not.toBe(before.epoch)
  expect(tab.owners.refused(topic)).toBe(false)
  // The list is read: the row names the conversation for the refused branch, and it is refused before it is kept,
  // `open` key or not. It shows at no moment.
  late.release()
  await until(() => expect(tab.owners.refused(topic)).toBe(true))
  await until(() => expect(tab.owners.mine.tanstack.has(topic)).toBe(true))
  await turns(device)
  expect([tab.all().includes(topic), shows.includes(topic), device.webStorage.entries.has(openKey(topic))]).toEqual([false, false, false])
  expect(mirrored(device)).toEqual([topic])
  // ChatApi's answer to a read of the branch that began before the refusal is not taken: the branch stays refused.
  expect(await tab.runtime.runPromise(tab.owners.clear(topic, before, hello))).toBe(false)
  // The row changes: the conversation was refused for this refusal already, and is not refused again.
  const refusedAt = tab.owners.fence().seq
  await sqlOn(tab.api)((sql) => sql`UPDATE conversation_people SET archived_at = now(), changed_at = now() WHERE conversation_id = ${topic}`)
  await until(() => expect(tab.owners.mine.tanstack.get(topic)?.archivedAt).not.toBeNull())
  expect(tab.owners.fence().seq).toBe(refusedAt)
  // A route saved for the branch names another conversation: refused as it is named. One of another branch is not.
  const routes = (await tab.runtime.runPromise(Effect.service(BranchStore))).conversations
  await tab.runtime.runPromise(routes.restored)
  const [moved, elsewhere] = [crypto.randomUUID(), crypto.randomUUID()]
  await tab.runtime.runPromise(routes.insert([{ id: "octo/hello/topic", conversationId: moved }, { id: "octo/hello/else", conversationId: elsewhere }]))
  await until(() => expect(tab.owners.refused(moved)).toBe(true))
  expect(tab.owners.refused(elsewhere)).toBe(false)
  // ChatApi answers for the branch, a read that began after every refusal: taken, the conversation shows, and the
  // branch is refused no longer, so a conversation a route comes to name for it since is not refused.
  await turns(device)
  expect(await tab.runtime.runPromise(tab.owners.clear(topic, tab.owners.fence(), hello))).toBe(true)
  expect(tab.all()).toContain(topic)
  const since = crypto.randomUUID()
  await tab.runtime.runPromise(routes.update("octo/hello/topic", (row) => {
    row.conversationId = since
  }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(tab.owners.refused(since)).toBe(false)
  // Refused again, with the device naming the branch's conversations: each is refused in the call.
  tab.owners.refuseBranch(hello.repository, hello.branch)
  expect([tab.owners.refused(topic), tab.owners.refused(since), tab.owners.refused(elsewhere)]).toEqual([true, true, false])
  expect(tab.all()).not.toContain(topic)
  // The row leaves the person's list: nothing names its conversation for the branch any more.
  await sqlOn(tab.api)((sql) => sql`DELETE FROM conversation_people WHERE conversation_id = ${topic}`)
  await until(() => expect(tab.owners.mine.tanstack.has(topic)).toBe(false))
  expect(tab.all()).not.toContain(topic)
  watching.unsubscribe()
}, 60_000)

test("an answer older than another tab's refusal removes nothing before the browser tells the tab: open taken away under full storage is read as the answer arrives, and never put back", async () => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  const { device: full, quota } = fillStorage(host)
  const one = await open(full)
  // The second tab is told of the first's changes to Web Storage only when the test says the browser tells it.
  const events = deferEvents(device)
  const two = await open(events.device, one.api)
  const topic = await branch(one)
  events.deliver()
  await until(() => expect(two.shown()).toEqual([topic]))
  // The second tab's read begins, with the conversation open. The first tab is then refused with the disk and Web
  // Storage full: the one thing that reaches any store is the removal of the open key.
  const began = two.owners.fence()
  faults.fail = true
  quota.full = true
  one.owners.refuse(topic)
  await until(() => expect(writeFailures(one, "insert")).toBe(1))
  await turns(device)
  expect([kept(device), mirrored(device), device.webStorage.entries.has(openKey(topic))]).toEqual([[], [], false])
  // Nothing has told the second tab: it still shows the conversation, and knows of no refusal.
  expect(events.pending()).toBeGreaterThan(0)
  expect(two.shown()).toEqual([topic])
  expect(two.owners.fence().seq).toBe(began.seq)
  // Its read is answered whole. The answer may be older than the refusal, which Web Storage shows now: nothing is
  // opened again, and the conversation is hidden in this tab in the same call.
  expect(await two.clear(topic, began)).toBe(false)
  expect(two.shown()).toEqual([])
  expect(two.owners.refused(topic)).toBe(true)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
  // The browser tells it at last. A fresh answer requires enough room to establish a generation.
  events.deliver()
  expect(two.shown()).toEqual([])
  expect(two.owners.fence().epoch).toMatch(/^[0-9a-f]{16}$/)
  expect(await two.answer(topic)).toBe(true)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
}, 60_000)

test("a read refused again says its refusal again in the room it had, and another tab's answer to a read begun between the two removes nothing before the browser tells that tab", async () => {
  const device = nodeDevice()
  const { device: capped, quota } = capStorage(device)
  const one = await open(capped)
  const events = deferEvents(device)
  const two = await open(events.device, one.api)
  const topic = await branch(one)
  events.deliver()
  await until(() => expect(two.shown()).toEqual([topic]))
  // Refused once, and the second tab is told.
  one.owners.refuse(topic)
  await turns(device)
  events.deliver()
  await until(() => expect(two.shown()).toEqual([]))
  await until(() => expect(kept(device)).toEqual([topic]))
  const [refusal] = device.storedRows(STORE) as [{ readonly id: string }]
  const key = Marks.keyOf("refused", DEVICE_PRINCIPAL, topic, refusal.id)
  const said = device.webStorage.entries.get(key)
  // The second tab's read begins, after that refusal. Web Storage fills, and the hidden reader's retry is refused
  // again: the same key, a token as wide, which storage with no room left takes.
  await turns(device)
  const began = two.owners.fence()
  quota.full = true
  one.owners.refuse(topic)
  // The generation moves in the call, written over in the room it had; the refusal is said again in its turn.
  expect(device.webStorage.entries.get(EPOCH)).toMatch(/^[0-9a-f]{16}$/)
  expect(device.webStorage.entries.get(EPOCH)).not.toBe(began.epoch)
  await turns(device)
  expect(device.webStorage.entries.get(key)).toMatch(/^[0-9a-f]{16}$/)
  expect(device.webStorage.entries.get(key)).not.toBe(said)
  expect(device.storedRows(STORE)).toEqual([expect.objectContaining({ id: refusal.id })])
  // The refusing tab closes, and nothing has told the second tab, by Web Storage or by the device's store.
  await one.close()
  expect(events.pending()).toBeGreaterThan(0)
  expect(two.owners.fence().seq).toBe(began.seq)
  // Its read is answered whole only now: the refusal said again is later than that read, in both records.
  expect(await two.clear(topic, began)).toBe(false)
  expect(two.shown()).toEqual([])
  expect([kept(device), mirrored(device)]).toEqual([[topic], [topic]])
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(device.storedRows(STORE)).toEqual([expect.objectContaining({ id: refusal.id })])
  expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
  // Told, and then answered a read that began after it: it shows, and neither store keeps a refusal.
  events.deliver()
  expect(await two.answer(topic)).toBe(true)
  expect(two.shown()).toEqual([topic])
  await until(() => expect(kept(device)).toEqual([]))
  expect(mirrored(device)).toEqual([])
}, 60_000)

test("a refusal another tab removed is not said again by a tab the browser has yet to tell: the tab refused since keeps one of its own, which hides in both", async () => {
  const device = nodeDevice()
  const events = deferEvents(device)
  const one = await open(events.device)
  const two = await open(device, one.api)
  const topic = await branch(two)
  events.deliver()
  await until(() => expect(one.shown()).toEqual([topic]))
  // The second tab is refused, and the first is told: it holds that refusal, another tab's.
  two.owners.refuse(topic)
  await turns(device)
  events.deliver()
  await until(() => expect(kept(device)).toEqual([topic]))
  const [refusal] = device.storedRows(STORE) as [{ readonly id: string }]
  expect(one.shown()).toEqual([])
  // The second tab's next read is answered whole and removes it. Before the browser tells the first tab, that tab is
  // refused a read: the key is gone, so it is not written back under a name the second tab has let go.
  expect(await two.answer(topic)).toBe(true)
  expect(two.shown()).toEqual([topic])
  one.owners.refuse(topic)
  await turns(device)
  expect(device.refusalMarks!.read().map((mark) => mark.id)).toEqual([expect.not.stringMatching(refusal.id)])
  // The first tab's own refusal hides the conversation there, and in the second tab as it is told of it.
  expect(two.shown()).toEqual([])
  events.deliver()
  expect(one.shown()).toEqual([])
  await until(() => expect(device.storedRows(STORE)).toEqual([expect.objectContaining({ conversationId: topic, id: expect.not.stringMatching(refusal.id) })]))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect([one.shown(), two.shown()]).toEqual([[], []])
  expect(await one.answer(topic)).toBe(true)
  expect(one.shown()).toEqual([topic])
  await until(() => expect(two.shown()).toEqual([topic]))
}, 60_000)

test("an answer and a refusal that race take the device's turn one after the other: the refusal is never said again between the answer's comparison and its removals, and neither store loses it", async () => {
  const device = nodeDevice()
  const one = await open(device)
  // The second tab is another process's: it reads the storage as it is, and is told of a change only later.
  const events = deferEvents(device)
  const two = await open(events.device, one.api)
  const topic = await branch(one)
  events.deliver()
  await until(() => expect(two.shown()).toEqual([topic]))
  one.owners.refuse(topic)
  await turns(device)
  events.deliver()
  await until(() => expect(two.shown()).toEqual([]))
  await until(() => expect(kept(device)).toEqual([topic]))
  const [refusal] = device.storedRows(STORE) as [{ readonly id: string }]
  const key = Marks.keyOf("refused", DEVICE_PRINCIPAL, topic, refusal.id)
  const tokens = [device.webStorage.entries.get(key)]
  const stands = () => {
    expect(device.storedRows(STORE)).toEqual([expect.objectContaining({ id: refusal.id })])
    expect(mirrored(device)).toEqual([topic])
    expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
    expect([one.shown(), two.shown()]).toEqual([[], []])
    // Said again each time: a value no read has seen.
    tokens.push(device.webStorage.entries.get(key))
    expect(new Set(tokens).size).toBe(tokens.length)
  }
  /** The device's turn, held by the test until `release`: what is asked meanwhile waits behind it, in the order asked. */
  const hold = () => {
    const gate = Promise.withResolvers<void>()
    const held = device.webStorage.lock(Marks.lockName(DEVICE_PRINCIPAL), () => gate.promise)
    return { release: () => (gate.resolve(), held) }
  }
  // The second tab's read began after that refusal. Its answer arrives as the first tab is refused again, and asks
  // for the turn first: weighed first, it finds the generation moved in the refusal's call, and removes nothing. The
  // refusal is then said again, in its own turn.
  let began = two.owners.fence()
  let turn = hold()
  let answered = two.clear(topic, began)
  one.owners.refuse(topic)
  await turn.release()
  expect(await answered).toBe(false)
  await turns(device)
  stands()
  // The other order: the refusal's turn comes first. Said again before the answer is weighed, it is later than the
  // read by its token too.
  began = two.owners.fence()
  turn = hold()
  one.owners.refuse(topic)
  answered = two.clear(topic, began)
  await turn.release()
  expect(await answered).toBe(false)
  await turns(device)
  stands()
  // With nothing held, as fast as the two can be given: no answer to a read begun before a refusal removes it.
  for (let round = 0; round < 5; round++) {
    began = two.owners.fence()
    answered = two.clear(topic, began)
    one.owners.refuse(topic)
    expect(await answered).toBe(false)
    await turns(device)
    stands()
  }
  // A read that began after the last refusal is answered whole: both stores let it go, and it shows in both.
  events.deliver()
  expect(await two.answer(topic)).toBe(true)
  expect(two.shown()).toEqual([topic])
  await until(() => expect(one.shown()).toEqual([topic]))
  await until(() => expect(kept(device)).toEqual([]))
  expect(mirrored(device)).toEqual([])
}, 60_000)

test("storage that was full before the device ever heard of a conversation: its first answer and its refusal both leave nothing, room is made, and another tab's older answer writes no open; the next load shows nothing", async () => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  // Two processes' views of the one storage, over its quota from the start: the device has no generation.
  const quota = { full: true }
  const one = await open({ ...host, refusalMarks: fillStorage(device, quota).device.refusalMarks! })
  const two = await open({ ...device, refusalMarks: fillStorage(device, quota).device.refusalMarks! }, one.api)
  expect(device.webStorage.entries.has(EPOCH)).toBe(false)
  // The first answer is rejected and no key is written.
  const topic = await branch(one, false)
  expect([...device.webStorage.entries.keys()]).toEqual([])
  // The second tab's read of it begins.
  const began = two.owners.fence()
  expect(began.epoch).toBeNull()
  // The first tab is refused, with the disk full too: neither store holds the refusal, there was no `open` key to
  // take away, and no generation to move. Nothing on the device tells the second tab's process.
  faults.fail = true
  one.owners.refuse(topic)
  expect(one.shown()).toEqual([])
  await until(() => expect(writeFailures(one, "insert")).toBe(1))
  await turns(device)
  expect([kept(device), mirrored(device), [...device.webStorage.entries.keys()]]).toEqual([[], [], []])
  expect(two.owners.fence()).toEqual(began)
  // Room is made, on the disk and in Web Storage. The second tab's older answer arrives: its read began with no
  // generation, so it writes no `open`, whatever room there is now.
  faults.fail = false
  quota.full = false
  expect(await two.clear(topic, began)).toBe(false)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
  expect(two.shown()).toEqual([])
  await one.close()
  await two.close()
  // The next load, offline or not, holds the route and no word that the conversation is open: nothing shows.
  const next = await open(device, one.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(next.shown()).toEqual([])
  expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
  // Only the answer to a read that began on a device with a generation is kept.
  expect(await next.answer(topic)).toBe(true)
  expect(next.shown()).toEqual([topic])
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
}, 60_000)

test("storage that fills once the device has a generation: a first answer and a refusal that both leave no key still stop another process's older answer, which writes no open though room is made", async () => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  // The first tab's storage reaches its quota after the device wrote its generation: nothing new fits, and a value
  // as wide as the one it replaces still does.
  const { device: capped, quota } = capStorage(host)
  const one = await open(capped)
  // The second tab is another process's: it reads the storage as it is, and is told of a change only later.
  const events = deferEvents(device)
  const two = await open(events.device, one.api)
  expect(device.webStorage.entries.get(EPOCH)).toMatch(/^[0-9a-f]{16}$/)
  quota.full = true
  // The first answer is rejected and no key is written.
  const topic = await branch(one)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
  // The second tab's read of it begins.
  const began = two.owners.fence()
  expect(began.epoch).toBe(device.webStorage.entries.get(EPOCH))
  // The first tab is refused, with the disk full too: neither store holds the refusal, and there was no `open` key
  // to take away. The generation moves all the same, written over in the room it had.
  faults.fail = true
  one.owners.refuse(topic)
  expect(device.webStorage.entries.get(EPOCH)).toMatch(/^[0-9a-f]{16}$/)
  expect(device.webStorage.entries.get(EPOCH)).not.toBe(began.epoch)
  await until(() => expect(writeFailures(one, "insert")).toBe(1))
  await turns(device)
  expect([kept(device), mirrored(device), device.webStorage.entries.has(openKey(topic))]).toEqual([[], [], false])
  // Nothing told the second tab, and no key of the conversation changed under it.
  expect(two.owners.fence()).toMatchObject({ seq: began.seq, memory: began.memory, standing: began.standing })
  // Room is made, on the disk and in Web Storage. The second tab's older answer arrives: the generation is not the
  // one its read began at, so it opens nothing, on this load or the next.
  faults.fail = false
  quota.full = false
  expect(await two.clear(topic, began)).toBe(false)
  expect([two.shown(), device.webStorage.entries.has(openKey(topic))]).toEqual([[], false])
  await one.close()
  await two.close()
  const next = await open(device, one.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(next.shown()).toEqual([])
  // A read that began after the refusal is answered whole: kept for the load after.
  expect(await next.answer(topic)).toBe(true)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
}, 60_000)

test("the tabs of one process stop each other's older answers with no storage at all: full from the start, and the disk full too", async () => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  const { device: { refusalMarks: marks }, quota } = fillStorage(device)
  quota.full = true
  const one = await open({ ...host, refusalMarks: marks! })
  const two = await open({ ...device, refusalMarks: marks! }, one.api)
  const topic = await branch(one, false)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(two.shown()).toEqual([])
  // The second tab's read begins; the first is refused, and nothing reaches any store or moves any key.
  const began = two.owners.fence()
  faults.fail = true
  one.owners.refuse(topic)
  await until(() => expect(writeFailures(one, "insert")).toBe(1))
  await turns(device)
  expect([kept(device), mirrored(device), [...device.webStorage.entries.keys()]]).toEqual([[], [], []])
  expect([began.epoch, two.owners.fence().epoch, two.owners.fence().seq]).toEqual([null, null, began.seq])
  // Its older answer opens nothing, even on this load: the process counted the refusal.
  expect(two.owners.fence().memory).toBeGreaterThan(began.memory)
  expect(await two.clear(topic, began)).toBe(false)
  expect(two.shown()).toEqual([])
  expect(await two.answer(topic)).toBe(false)
  expect(two.shown()).toEqual([])
  expect([...device.webStorage.entries.keys()]).toEqual([])
  faults.fail = false
  quota.full = false
  expect(two.owners.fence().epoch).toMatch(/^[0-9a-f]{16}$/)
  expect(await two.answer(topic)).toBe(true)
  expect(two.shown()).toEqual([topic])
}, 60_000)

test("an answer weighed as another process is refused takes back the word it wrote: open is read back against the generation", async () => {
  const device = nodeDevice()
  const web = device.webStorage
  // The first tab's storage, where another process's refusal lands in the middle of this tab's turn: between its
  // comparison and its reading back of the `open` key it wrote, as only a process outside the turn's thread can.
  const between: { refused?: () => void } = {}
  const marks = Marks.make({
    channel: () => undefined,
    storage: {
      getItem: web.getItem,
      removeItem: web.removeItem,
      key: web.key,
      get length() {
        return web.length
      },
      setItem: (key, value) => {
        web.setItem(key, value)
        const refused = key.includes(":open:") ? between.refused : undefined
        delete between.refused
        refused?.()
      },
    },
    principal: () => DEVICE_PRINCIPAL,
    changes: web.changes,
    lock: web.lock,
  })
  const one = await open({ ...device, refusalMarks: marks })
  const two = await open(device, one.api)
  const topic = await branch(one)
  await until(() => expect(two.shown()).toEqual([topic]))
  one.owners.refuse(topic)
  await until(() => expect(kept(device)).toEqual([topic]))
  await turns(device)
  const [refusal] = device.storedRows(STORE) as [{ readonly id: string }]
  // The first tab's read, begun after its refusal, is answered whole. As it writes `open`, the other process is
  // refused: the generation moves and `open` goes. The answer is not taken, and nothing it would remove is removed.
  between.refused = () => two.owners.refuse(topic)
  expect(await one.answer(topic)).toBe(false)
  expect(between.refused).toBeUndefined()
  await turns(device)
  expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
  expect(device.storedRows(STORE)).toEqual([expect.objectContaining({ id: refusal.id })])
  expect([mirrored(device), one.shown(), two.shown()]).toEqual([[topic], [], []])
  // A read that began after both is answered whole.
  expect(await one.answer(topic)).toBe(true)
  expect(one.shown()).toEqual([topic])
  await until(() => expect(two.shown()).toEqual([topic]))
  await until(() => expect(kept(device)).toEqual([]))
}, 60_000)

test("where the device can hold no generation, an answer is still weighed against the refusals' own keys: one said again since the read began stands", async () => {
  const device = nodeDevice()
  const web = device.webStorage
  /** Another process's view of the storage, which takes every key but the generation's: told of changes only later. */
  const view = () => {
    const queued: Array<() => void> = []
    let writing = false
    const marks = Marks.make({
      channel: () => undefined,
      storage: {
        getItem: web.getItem,
        key: web.key,
        get length() {
          return web.length
        },
        removeItem: (key) => {
          writing = true
          web.removeItem(key)
          writing = false
        },
        setItem: (key, value) => {
          if (key === EPOCH) throw new DOMException("full", "QuotaExceededError")
          writing = true
          web.setItem(key, value)
          writing = false
        },
      },
      principal: () => DEVICE_PRINCIPAL,
      changes: (listener) => web.changes((key) => {
        if (!writing) queued.push(() => listener(key))
      }),
      lock: web.lock,
    })
    return { marks, deliver: () => void queued.splice(0).forEach((tell) => tell()) }
  }
  const [first, second] = [view(), view()]
  const one = await open({ ...device, refusalMarks: first.marks })
  const two = await open({ ...device, refusalMarks: second.marks }, one.api)
  const told = () => {
    first.deliver()
    second.deliver()
  }
  const topic = await branch(one, false)
  told()
  expect(device.webStorage.entries.has(EPOCH)).toBe(false)
  one.owners.refuse(topic)
  await turns(device)
  told()
  await until(() => expect(two.shown()).toEqual([]))
  await until(() => expect(kept(device)).toEqual([topic]))
  const [refusal] = device.storedRows(STORE) as [{ readonly id: string }]
  const key = Marks.keyOf("refused", DEVICE_PRINCIPAL, topic, refusal.id)
  const said = device.webStorage.entries.get(key)
  // The second process's read begins after that refusal. The first is refused again: no generation moves, nothing
  // has told the second process, and its count of refusals is its own. The key is said again, in its turn.
  const began = two.owners.fence()
  one.owners.refuse(topic)
  await turns(device)
  expect(device.webStorage.entries.get(key)).not.toBe(said)
  expect(two.owners.fence()).toMatchObject({ seq: began.seq, epoch: null, memory: began.memory })
  // Its answer reads the key as it stands: said again since the read began, so nothing is removed.
  expect(await two.clear(topic, began)).toBe(false)
  expect(device.storedRows(STORE)).toEqual([expect.objectContaining({ id: refusal.id })])
  expect([mirrored(device), two.shown()]).toEqual([[topic], []])
  told()
  expect(await two.answer(topic)).toBe(false)
  expect(two.shown()).toEqual([])
  expect([kept(device), mirrored(device), device.webStorage.entries.has(openKey(topic))]).toEqual([[topic], [topic], false])
}, 60_000)

test("a tab that closes before its turn comes writes nothing more: what its refusal took away in the call is what the next load reads", async () => {
  const device = nodeDevice()
  const tab = await open(device)
  const topic = await branch(tab)
  // Another tab holds the device's turn as this one is refused and then closes.
  const gate = Promise.withResolvers<void>()
  const held = device.webStorage.lock(Marks.lockName(DEVICE_PRINCIPAL), () => gate.promise)
  const before = device.webStorage.entries.get(EPOCH)
  tab.owners.refuse(topic)
  expect(tab.shown()).toEqual([])
  await tab.close()
  gate.resolve()
  await held
  await turns(device)
  // Done in the call: `open` gone, the generation moved. Never done: the refusal's key and its row.
  expect([device.webStorage.entries.has(openKey(topic)), mirrored(device), kept(device)]).toEqual([false, [], []])
  expect(device.webStorage.entries.get(EPOCH)).not.toBe(before)
  const next = await open(device, tab.api)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(next.shown()).toEqual([])
  expect(await next.answer(topic)).toBe(true)
  expect(next.shown()).toEqual([topic])
}, 60_000)

test.each([
  ["refuses", false],
  ["takes", true],
])("a refusal only Web Storage held, removed after another tab's answer while this tab's copy of it to the device's store is under way, hides nothing once the store %s the copy", async (_outcome, taken) => {
  const device = nodeDevice()
  const { host: failing, faults } = failingWrites(device)
  const first = await open(failing)
  const topic = await branch(first)
  // Refused with the disk full: Web Storage holds the refusal, and the device's store none.
  faults.fail = true
  first.owners.refuse(topic)
  await until(() => expect(writeFailures(first, "insert")).toBe(1))
  expect([kept(device), mirrored(device)]).toEqual([[], [topic]])
  await first.close()
  // A tab that only lists opens: its load finds the refusal in Web Storage and copies it to the device's store, a
  // write the store holds, and every later statement of the device's behind it.
  faults.fail = false
  const writes = heldWrites(device)
  const listing = await open(writes.host, first.api)
  await until(() => expect(writes.seen.writes).toBeGreaterThan(0))
  expect(listing.shown()).toEqual([])
  // ChatApi answers another tab's read whole while that write is under way. What that tab does to Web Storage is
  // done here through the device's own marks, since no second tab can open while the store holds a write: the
  // refusal goes, and the conversation is open. The listing tab hears both. The row it is still writing is not the
  // store's word that the refusal is kept.
  const others = device.refusalMarks!
  others.remove(others.read())
  others.grant(topic)
  expect(mirrored(device)).toEqual([])
  expect(listing.shown()).toEqual([topic])
  // The store answers the write. Refused, the row rolls back; taken, the tab removes the row it no longer means.
  // Either way the listing shows, and no record is left to hide it on the next load.
  writes.settle(taken)
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(listing.shown()).toEqual([topic])
  await until(() => expect(kept(device)).toEqual([]))
  await listing.close()
  const next = await open(device, first.api)
  await until(() => expect(next.shown()).toEqual([topic]))
}, 60_000)

test("a queued restatement survives a sibling clear deleting its old SQLite refusal", async () => {
  const device = nodeDevice()
  const events = deferEvents(device)
  const one = await open(events.device)
  const two = await open(device, one.api)
  const topic = await branch(one)
  one.owners.refuse(topic)
  await turns(device)
  events.deliver()
  await until(() => expect(kept(device)).toEqual([topic]))
  await until(() => expect(two.owners.refused(topic)).toBe(true))
  const [old] = device.refusalMarks!.read()
  const oldKey = Marks.keyOf("refused", DEVICE_PRINCIPAL, topic, old!.id)
  const queued = Promise.withResolvers<void>()
  const between = Promise.withResolvers<void>()
  const exposed: string[] = []
  one.owners.shown.tanstack.subscribeChanges((changes) => {
    for (const change of changes) if (change.type === "insert") exposed.push(String(change.key))
  })
  const stop = device.webStorage.changes((key) => {
    if (key !== oldKey || device.webStorage.getItem(oldKey) !== null) return
    stop()
    void device.webStorage.lock(Marks.lockName(DEVICE_PRINCIPAL), () => {
      between.resolve()
      return queued.promise
    })
    // Tab two is inside clear's lock, before it deletes the SQLite row.
    one.owners.refuse(topic)
  })
  try {
    // The refusal landed inside the clear: the clear takes `open` back and reports the read refused.
    expect(await two.answer(topic)).toBe(false)
    await between.promise
    await until(() => expect(kept(device)).toEqual([]))
    // Deliver the storage deletion and let the SQLite coordinator deliver its deletion.
    events.deliver()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(one.owners.refused(topic)).toBe(true)
    expect(one.shown()).toEqual([])
    queued.resolve()
    await turns(device)
    await until(() => expect(kept(device)).toEqual([topic]))
    expect(exposed).not.toContain(topic)
  } finally {
    stop()
    queued.resolve()
  }
}, 60_000)

test.each(["shared counter", "broadcast across separate counters", "a route broadcast"])("full Web Storage and failed SQLite cannot reopen a refusal on a sibling using %s", async (mode) => {
  const device = nodeDevice()
  const { host, faults } = failingWrites(device)
  const web = device.webStorage
  const channelName = crypto.randomUUID()
  const make = () => Marks.make({
    storage: {
      getItem: web.getItem,
      key: web.key,
      get length() {
        return web.length
      },
      setItem: () => { throw new DOMException("full", "QuotaExceededError") },
      removeItem: web.removeItem,
    },
    storageIdentity: mode === "shared counter" ? web : {},
    channel: () => mode === "shared counter" ? undefined : new BroadcastChannel(channelName),
    principal: () => DEVICE_PRINCIPAL,
    changes: () => () => {},
    lock: web.lock,
  })
  const one = await open({ ...host, refusalMarks: make() })
  const two = await open({ ...device, refusalMarks: make() }, one.api)
  const topic = await branch(one, false)
  const routes = (await two.runtime.runPromise(Effect.service(BranchStore))).conversations
  await until(() => expect(routes.tanstack.has("octo/hello/topic")).toBe(true))
  const stale = two.owners.fence()
  faults.fail = true
  expect(await two.clear(topic, stale)).toBe(false)
  expect(two.shown()).toEqual([])
  if (mode === "a route broadcast") one.owners.refuseBranch("github/octo/hello", "topic")
  else one.owners.refuse(topic)
  await until(() => expect(writeFailures(one, "insert")).toBe(1))
  if (mode !== "shared counter") await until(() => expect(two.owners.refused(topic)).toBe(true))
  expect(stale.epoch).toBeNull()
  expect(two.owners.fence().epoch).toBeNull()
  expect(kept(device)).toEqual([])
  expect(await two.clear(topic, stale)).toBe(false)
  expect(two.shown()).toEqual([])
}, 60_000)

test("an adopted visitor exchanges refusals with a fresh tab on the person's channel", async () => {
  const device = nodeDevice()
  const web = device.webStorage
  const events = new EventTarget()
  const namespace = crypto.randomUUID()
  let principal = "visitor"
  let requested: (() => void) | undefined
  const lock: Marks.Lock = (name, turn) => {
    requested?.()
    return web.lock(name, turn)
  }
  const make = (owner: () => string) => Marks.make({
    storage: web, principal: owner, changes: () => () => {}, lock,
    adoptionEvents: events, storageIdentity: {},
    channel: (name) => new BroadcastChannel(`${namespace}:${name}`),
  })
  const visitor = await open({ ...device, refusalMarks: make(() => principal) })
  const topic = await branch(visitor)
  const persisted = crypto.randomUUID()
  visitor.owners.refuse(persisted)
  await web.lock(Marks.lockName("visitor"), async () => {})
  expect(kept(device)).toContain(persisted)
  const visitorRefused = crypto.randomUUID()
  const personRefused = crypto.randomUUID()
  web.setItem(Marks.keyOf("refused", "visitor", visitorRefused, crypto.randomUUID()), "0123456789abcdef")
  web.setItem(Marks.keyOf("refused", DEVICE_PRINCIPAL, personRefused, crypto.randomUUID()), "fedcba9876543210")
  const old = visitor.owners.fence()
  expect(visitor.owners.refused(visitorRefused)).toBe(true)
  expect(visitor.owners.refused(personRefused)).toBe(false)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const holder = web.lock(Marks.lockName("visitor"), () => {
    entered.resolve()
    return release.promise
  })
  const queued = Promise.withResolvers<void>()
  await entered.promise
  requested = queued.resolve
  const oldAnswer = visitor.clear(topic, old)
  await queued.promise
  requested = undefined
  principal = DEVICE_PRINCIPAL
  events.dispatchEvent(new Event(DEVICE_ADOPTED_EVENT))
  release.resolve()
  await holder
  expect(await oldAnswer).toBe(false)
  expect(visitor.owners.refused(visitorRefused)).toBe(false)
  expect(visitor.owners.refused(personRefused)).toBe(true)
  expect(visitor.owners.refused(persisted)).toBe(true)
  expect(visitor.shown()).toEqual([])
  expect(web.entries.get(EPOCH)).toMatch(/^[0-9a-f]{16}$/)
  const person = await open({ ...device, refusalMarks: make(() => DEVICE_PRINCIPAL) }, visitor.api)
  expect(await visitor.clear(topic, old)).toBe(false)
  expect(await visitor.clear(topic, { ...visitor.owners.fence(), principal: old.principal })).toBe(false)
  expect(await visitor.answer(topic)).toBe(true)
  const before = person.owners.fence().memory
  visitor.owners.refuseBranch(hello.repository, hello.branch)
  await until(() => expect(person.owners.fence().memory).toBeGreaterThan(before))
  expect(person.owners.routeDenied(hello.repository, hello.branch)).toBe(true)
  const back = crypto.randomUUID()
  const beforeReturn = visitor.owners.fence().memory
  person.owners.refuse(back)
  await until(() => expect(visitor.owners.fence().memory).toBeGreaterThan(beforeReturn))
  expect(visitor.owners.refused(back)).toBe(true)
}, 60_000)

test("an older track answer preserves a newer durable route token from a tab that cannot name its conversation", async () => {
  const device = nodeDevice()
  const first = await open(device)
  const topic = await branch(first)
  const isolated = nodeDevice()
  const web = device.webStorage
  const marks = () => Marks.make({
    storage: web, storageIdentity: {}, principal: () => DEVICE_PRINCIPAL,
    changes: () => () => {}, channel: () => undefined, lock: web.lock,
  })
  const two = await open({ ...isolated, refusalMarks: marks() }, first.api)
  const fence = first.owners.fence()
  const route = `${hello.repository}\0${hello.branch}`
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const holder = web.lock(Marks.lockName(DEVICE_PRINCIPAL), () => {
    entered.resolve()
    return release.promise
  })
  await entered.promise
  const refused = two.owners.refuseBranch(hello.repository, hello.branch)
  try {
    expect(device.refusalMarks!.routeToken(route)).toMatch(/^[0-9a-f]{16}$/)
  } finally {
    release.resolve()
  }
  const stale = first.runtime.runPromise(first.owners.clear(topic, fence, hello))
  await holder
  await refused
  const token = device.refusalMarks!.routeToken(route)
  expect(token).toMatch(/^[0-9a-f]{16}$/)
  expect(two.owners.refused(topic)).toBe(false)
  expect(await stale).toBe(false)
  // Hold all other fence fields equal so the route token comparison is exercised independently.
  expect(await first.runtime.runPromise(first.owners.clear(topic, { ...first.owners.fence(), routes: fence.routes }, hello))).toBe(false)
  expect(device.refusalMarks!.routeToken(route)).toBe(token)
  await first.close()
  await two.close()
  const offline = await open({ ...device, refusalMarks: marks() }, first.api, () => async () => { throw new TypeError("offline") })
  const { conversations } = await offline.runtime.runPromise(Effect.service(BranchStore))
  await offline.runtime.runPromise(conversations.restored)
  expect(conversations.tanstack.has("octo/hello/topic")).toBe(true)
  await until(() => expect(offline.owners.refused(topic)).toBe(true))
  expect(offline.shown()).toEqual([])
}, 60_000)

test("a starting sibling finds a route denial written during listener installation and ignores its old grant", async () => {
  const device = nodeDevice()
  const first = await open(device)
  const topic = await branch(first)
  await first.close()
  const web = device.webStorage
  const key = Marks.keyOf("route", DEVICE_PRINCIPAL, `${hello.repository}\0${hello.branch}`)
  const installed = Promise.withResolvers<void>()
  const marks = Marks.make({
    storage: web, principal: () => DEVICE_PRINCIPAL, changes: () => () => {}, lock: web.lock,
    channel: () => {
      expect(web.entries.has(openKey(topic))).toBe(true)
      web.setItem(key, "0123456789abcdef")
      installed.resolve()
      return undefined
    },
  })
  const cold = await open({ ...device, refusalMarks: marks }, first.api, () => async () => { throw new TypeError("offline") })
  await installed.promise
  const { conversations } = await cold.runtime.runPromise(Effect.service(BranchStore))
  await cold.runtime.runPromise(conversations.restored)
  await until(() => expect(cold.owners.refused(topic)).toBe(true))
  expect(conversations.tanstack.has("octo/hello/topic")).toBe(true)
  expect(cold.shown()).toEqual([])
}, 60_000)

test("a live route storage event hides a row and keeps it closed until its route token is removed", async () => {
  const device = nodeDevice()
  const tab = await open(device)
  const topic = await branch(tab)
  const key = Marks.keyOf("route", DEVICE_PRINCIPAL, `${hello.repository}\0${hello.branch}`)
  device.webStorage.setItem(key, "0123456789abcdef")
  expect(tab.owners.refused(topic)).toBe(true)
  expect(tab.shown()).toEqual([])
  expect(device.webStorage.entries.has(openKey(topic))).toBe(true)
  device.webStorage.removeItem(key)
  expect(tab.owners.refused(topic)).toBe(false)
  expect(tab.shown()).toEqual([topic])
}, 60_000)

test("adoption refreshes route admission while device refusals are still restoring", async () => {
  const host = nodeDevice()
  const web = host.webStorage
  const late = holdRestore(host, STORE)
  const events = new EventTarget()
  let principal = "visitor"
  const marks = Marks.make({
    storage: web, principal: () => principal, changes: () => () => {}, lock: web.lock,
    adoptionEvents: events, channel: () => undefined,
  })
  const tab = await open({ ...late.device, refusalMarks: marks }, undefined, () => async () => { throw new TypeError("offline") })
  try {
    expect(tab.owners.home()).toBeUndefined()
    const route = `${hello.repository}\0${hello.branch}`
    web.setItem(Marks.keyOf("route", DEVICE_PRINCIPAL, route), "0123456789abcdef")
    principal = DEVICE_PRINCIPAL
    events.dispatchEvent(new Event(DEVICE_ADOPTED_EVENT))
    expect(tab.owners.routeDenied(hello.repository, hello.branch)).toBe(true)
    expect(marks.epoch()).toMatch(/^[0-9a-f]{16}$/)
  } finally {
    late.release()
  }
}, 60_000)

test("a listed conversation with no durable epoch waits for the next list notification before verifying again", async () => {
  const host = nodeDevice()
  const { device, quota } = fillStorage(host, { full: true })
  const { transport, askedOf } = accessFaults()
  const tab = await open(device, undefined, transport)
  const id = await listed(tab.api, "topic")
  await until(() => expect(askedOf(id)).toBe(1))
  expect(tab.owners.fence().epoch).toBeNull()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(askedOf(id)).toBe(1)
  expect(tab.shown()).toEqual([])
  quota.full = false
  await listed(tab.api, "another")
  await until(() => expect(tab.shown()).toContain(id))
  expect(host.webStorage.entries.has(openKey(id))).toBe(true)
}, 60_000)

test("a branch refusal survives tab close before the Web Lock is granted and hides offline history", async () => {
  const device = nodeDevice()
  const tab = await open(device)
  const topic = await branch(tab)
  const before = device.webStorage.entries.get(EPOCH)
  const gate = Promise.withResolvers<void>()
  const held = device.webStorage.lock(Marks.lockName(DEVICE_PRINCIPAL), () => gate.promise)
  const refusal = tab.owners.refuseBranch(hello.repository, hello.branch)
  try {
    expect(device.refusalMarks!.routeToken(`${hello.repository}\0${hello.branch}`)).toMatch(/^[0-9a-f]{16}$/)
    expect(device.webStorage.entries.get(EPOCH)).toMatch(/^[0-9a-f]{16}$/)
    expect(device.webStorage.entries.get(EPOCH)).not.toBe(before)
    expect(device.webStorage.entries.has(openKey(topic))).toBe(false)
    await tab.close()
  } finally {
    gate.resolve()
    await held
    await refusal
  }
  // A standing open key cannot override the durable route refusal, even on a cold load.
  device.refusalMarks!.grant(topic)
  const offline = await open(device, tab.api, () => async () => { throw new TypeError("offline") })
  const { conversations } = await offline.runtime.runPromise(Effect.service(BranchStore))
  await offline.runtime.runPromise(conversations.restored)
  await until(() => expect(offline.owners.refused(topic)).toBe(true))
  expect(conversations.tanstack.get("octo/hello/topic")?.conversationId).toBe(topic)
  expect(offline.shown()).toEqual([])
}, 60_000)

test("a sibling clear cannot erase a newer branch refusal queued behind its Web Lock", async () => {
  const device = nodeDevice()
  const events = deferEvents(device)
  const first = await open(events.device)
  const topic = await branch(first)
  const web = device.webStorage
  const route = `${hello.repository}\0${hello.branch}`
  device.refusalMarks!.refuseRoute(route)
  const key = Marks.routeClearedKey(DEVICE_PRINCIPAL, route)
  events.deliver()
  expect(first.shown()).toEqual([])

  const queued: Array<Promise<void>> = []
  let reconciled: { token: string | null; denied: boolean; shown: Array<string> } | undefined
  const siblingMarks = Marks.make({
    storage: {
      ...web,
      get length() { return web.length },
      setItem: (written, value) => {
        if (written === key && reconciled === undefined) {
          queued.push(first.owners.refuseBranch(hello.repository, hello.branch))
          queued.push(first.owners.refuseBranch(hello.repository, hello.branch))
        }
        web.setItem(written, value)
        if (written === key && reconciled === undefined) {
          events.deliver()
          reconciled = {
            token: device.refusalMarks!.routeToken(route),
            denied: first.owners.routeDenied(hello.repository, hello.branch),
            shown: first.shown(),
          }
        }
      },
    },
    principal: () => DEVICE_PRINCIPAL, changes: () => () => {}, channel: () => undefined, lock: web.lock,
  })
  const sibling = await open({ ...device, refusalMarks: siblingMarks }, first.api)
  expect(await sibling.runtime.runPromise(sibling.owners.clear(topic, sibling.owners.fence(), hello))).toBe(false)
  expect(queued).toHaveLength(2)
  expect(reconciled).toEqual({ token: expect.stringMatching(/^[0-9a-f]{16}$/), denied: true, shown: [] })
  await Promise.all(queued)
  expect(device.refusalMarks!.routeToken(route)).toMatch(/^[0-9a-f]{16}$/)
  expect(mirrored(device)).toEqual([topic])
  expect(first.shown()).toEqual([])
}, 60_000)

test("a pending branch refusal stays denied when a covered sibling clear removes its token before its turn", async () => {
  const device = nodeDevice()
  // As in a browser, the tab is never told of its own writes: only the sibling's removal reaches it.
  const events = deferEvents(device)
  const tab = await open(events.device)
  const topic = await branch(tab)
  const web = device.webStorage
  const route = `${hello.repository}\0${hello.branch}`
  const sibling = Marks.make({
    storage: web, storageIdentity: {}, principal: () => DEVICE_PRINCIPAL,
    changes: () => () => {}, channel: () => undefined, lock: web.lock,
  })
  const gate = Promise.withResolvers<void>()
  const held = web.lock(Marks.lockName(DEVICE_PRINCIPAL), () => gate.promise)
  const refusal = tab.owners.refuseBranch(hello.repository, hello.branch)
  try {
    const token = sibling.routeToken(route)
    expect(token).toMatch(/^[0-9a-f]{16}$/)
    // A read that began after the token answered whole in another tab: its clear covered the token and lifted it.
    expect(sibling.clearRoute(route, token!)).toMatchObject({ changed: true })
    expect(sibling.routeToken(route)).toBeNull()
    events.deliver()
    await until(() => expect(tab.owners.routeDenied(hello.repository, hello.branch)).toBe(true))
    expect(tab.shown()).toEqual([])
  } finally {
    gate.resolve()
    await held
    await refusal
  }
  expect(sibling.routeToken(route)).toMatch(/^[0-9a-f]{16}$/)
  // The turn still records the refusal of the conversation it names.
  await until(() => expect(mirrored(device)).toEqual([topic]))
}, 60_000)

test("a sibling clear inside its Web Lock lifts only the route token it fenced, though the newer refusing tab closes before its turn", async () => {
  const device = nodeDevice()
  const first = await open(device)
  const topic = await branch(first)
  const web = device.webStorage
  const route = `${hello.repository}\0${hello.branch}`
  const marks = (storage: typeof web = web) => Marks.make({
    storage, storageIdentity: {}, principal: () => DEVICE_PRINCIPAL,
    changes: () => () => {}, channel: () => undefined, lock: web.lock,
  })
  expect(marks().refuseRoute(route)).toBe(true)
  const old = marks().routeToken(route)
  // A conversation refusal the sibling's read covers: removing it is the clear's last step before its route token.
  first.owners.refuse(topic)
  await turns(device)
  const [covered] = marks().read()
  const coveredKey = Marks.keyOf("refused", DEVICE_PRINCIPAL, topic, covered!.id)
  // Tab A has not restored its branch rows: it cannot name the conversation it refuses.
  const refusing = await open({ ...nodeDevice(), refusalMarks: marks() }, first.api)
  let written: string | null = null
  let refusal: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const sibling = await open({
    ...device,
    refusalMarks: marks({
      ...web,
      get length() { return web.length },
      removeItem: (removed) => {
        // Tab B holds the Web Lock, past every check, and is about to remove the route token its fence covered.
        if (removed === coveredKey && refusal === undefined) {
          refusal = refusing.owners.refuseBranch(hello.repository, hello.branch)
          written = marks().routeToken(route)
          closing = refusing.close()
        }
        web.removeItem(removed)
      },
    }),
  }, first.api)
  const fence = sibling.owners.fence()
  expect(fence.routes.get(route)).toBe(old)
  expect(sibling.owners.refused(topic)).toBe(true)
  expect(await sibling.runtime.runPromise(sibling.owners.clear(topic, fence, hello))).toBe(false)
  await closing
  await refusal
  expect(written).toMatch(/^[0-9a-f]{16}$/)
  expect(written).not.toBe(old)
  expect(refusal).toBeDefined()
  expect(marks().routeToken(route)).toBe(written)
  expect(web.entries.has(openKey(topic))).toBe(false)
  await sibling.close()
  await first.close()
  const offline = await open({ ...device, refusalMarks: marks() }, first.api, () => async () => { throw new TypeError("offline") })
  const { conversations } = await offline.runtime.runPromise(Effect.service(BranchStore))
  await offline.runtime.runPromise(conversations.restored)
  expect(conversations.tanstack.get("octo/hello/topic")?.conversationId).toBe(topic)
  await until(() => expect(offline.owners.refused(topic)).toBe(true))
  expect(offline.shown()).toEqual([])
}, 60_000)

test("a refusing tab shows the conversation again after a sibling clears its locally written route token", async () => {
  const device = nodeDevice()
  const events = deferEvents(device)
  const first = await open(events.device)
  const topic = await branch(first)
  const sibling = await open(device, first.api)
  await first.owners.refuseBranch(hello.repository, hello.branch)
  expect(first.shown()).toEqual([])
  expect(await sibling.runtime.runPromise(sibling.owners.clear(topic, sibling.owners.fence(), hello))).toBe(true)
  events.deliver()
  await until(() => expect(first.shown()).toEqual([topic]))
  expect(first.owners.routeDenied(hello.repository, hello.branch)).toBe(false)
}, 60_000)

test("a track answer rejected after its clear lifted the branch refusal undoes that clear in its turn: an older conversation's surviving open key shows nothing on an offline reload", async () => {
  const device = nodeDevice()
  const first = await open(device)
  // The saved route names `topic`, and Web Storage says `topic` is open.
  const topic = await branch(first)
  await first.close()
  const web = device.webStorage
  const route = `${hello.repository}\0${hello.branch}`
  const marks = (storage: typeof web = web) => Marks.make({
    storage, storageIdentity: {}, principal: () => DEVICE_PRINCIPAL,
    changes: () => () => {}, channel: () => undefined, lock: web.lock,
  })
  expect(marks().refuseRoute(route)).toBe(true)
  const old = marks().routeToken(route)
  const clearedKey = Marks.routeClearedKey(DEVICE_PRINCIPAL, route)
  expect(web.entries.has(openKey(topic))).toBe(true)
  // A sibling with no branch rows of its own: it names no conversation for the branch, so it refuses none.
  const refusing = await open({ ...nodeDevice(), refusalMarks: marks() }, first.api)
  let refused = false
  const clearing = await open({
    ...nodeDevice(),
    refusalMarks: marks({
      ...web,
      get length() { return web.length },
      setItem: (written, value) => {
        web.setItem(written, value)
        // The covered branch refusal is lifted; a sibling's conversation refusal moves the generation right then.
        if (written === clearedKey && !refused) {
          refusing.owners.refuse(crypto.randomUUID())
          refused = true
        }
      },
    }),
  }, first.api)
  const fence = clearing.owners.fence()
  expect(fence.routes.get(route)).toBe(old)
  // The track answer named a conversation other than the one the saved route names.
  const answered = crypto.randomUUID()
  expect(await clearing.runtime.runPromise(clearing.owners.clear(answered, fence, hello))).toBe(false)
  expect(refused).toBe(true)
  await turns(device)
  expect(web.entries.has(openKey(answered))).toBe(false)
  expect(web.entries.has(openKey(topic))).toBe(true)
  // The clear is undone, not a new refusal written: the refusal it lifted stands again.
  expect([marks().routeToken(route), web.entries.has(clearedKey)]).toEqual([old, false])
  expect(clearing.owners.routeDenied(hello.repository, hello.branch)).toBe(true)
  await clearing.close()
  await refusing.close()
  const offline = await open({ ...device, refusalMarks: marks() }, first.api, () => async () => { throw new TypeError("offline") })
  const { conversations } = await offline.runtime.runPromise(Effect.service(BranchStore))
  await offline.runtime.runPromise(conversations.restored)
  expect(conversations.tanstack.get("octo/hello/topic")?.conversationId).toBe(topic)
  await until(() => expect(offline.owners.refused(topic)).toBe(true))
  expect(offline.shown()).toEqual([])
}, 60_000)

test("a restore batch sees a sibling's route refusal written between two rows: the later row's old open key admits nothing", async () => {
  const device = nodeDevice()
  const first = await open(device)
  const topic = await branch(first)
  const routes = (await first.runtime.runPromise(Effect.service(BranchStore))).conversations
  const other = crypto.randomUUID()
  const written = await first.runtime.runPromise(routes.insert({ id: "octo/hello/other", conversationId: other }))
  await first.runtime.runPromise(written.persisted)
  expect(await first.answer(other)).toBe(true)
  await until(() => expect(first.shown().sort()).toEqual([topic, other].sort()))
  await first.close()
  const web = device.webStorage
  const sibling = Marks.make({
    storage: web, storageIdentity: {}, principal: () => DEVICE_PRINCIPAL,
    changes: () => () => {}, channel: () => undefined, lock: web.lock,
  })
  const routeOf = new Map<string, string>([[topic, `${hello.repository}\0topic`], [other, `${hello.repository}\0other`]])
  let armed = false
  let late: string | undefined
  // No storage event reaches this tab: only the generation tells it a sibling wrote since the batch began.
  const marks = Marks.make({
    storage: {
      ...web,
      get length() { return web.length },
      getItem: (key) => {
        const admitting = [topic, other].find((id) => key === openKey(id))
        if (armed && late === undefined && admitting !== undefined) {
          // The first row is being admitted: a sibling refuses the branch of the row after it.
          late = admitting === topic ? other : topic
          expect(sibling.refuseRoute(routeOf.get(late)!)).toBe(true)
        }
        return web.getItem(key)
      },
    },
    principal: () => DEVICE_PRINCIPAL, changes: () => () => {}, channel: () => undefined, lock: web.lock,
  })
  const held = holdRestore({ ...device, refusalMarks: marks }, STORE)
  const cold = await open(held.device, first.api)
  const cached = (await cold.runtime.runPromise(Effect.service(BranchStore))).conversations
  await cold.runtime.runPromise(cached.restored)
  expect(cached.tanstack.size).toBe(2)
  expect(cold.shown()).toEqual([])
  armed = true
  held.release()
  await until(() => expect(late).toBeDefined())
  const early = late === topic ? other : topic
  await until(() => expect(cold.shown()).toEqual([early]))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(cold.shown()).toEqual([early])
  expect(web.entries.has(openKey(late!))).toBe(true)
  expect(cold.owners.refused(late!)).toBe(true)
}, 60_000)

test("a branch refused again while a restore batch admits its rows stays refused at every step of the token's replacement: each row reads the branch's two keys alone and enumerates no key", async () => {
  const device = nodeDevice()
  const first = await open(device)
  const topic = await branch(first)
  const routes = (await first.runtime.runPromise(Effect.service(BranchStore))).conversations
  const other = crypto.randomUUID()
  const written = await first.runtime.runPromise(routes.insert({ id: "octo/hello/other", conversationId: other }))
  await first.runtime.runPromise(written.persisted)
  expect(await first.answer(other)).toBe(true)
  await until(() => expect(first.shown().sort()).toEqual([topic, other].sort()))
  await first.close()
  const web = device.webStorage
  const route = `${hello.repository}\0other`
  const index = Marks.routeRefusedKey(DEVICE_PRINCIPAL, route)
  let enumerations = 0
  let armed = false
  let cold: Awaited<ReturnType<typeof open>> | undefined
  const steps: Array<{ readonly step: string; readonly refused: boolean; readonly denied: boolean; readonly enumerations: number }> = []
  const weigh = (step: string) => {
    if (cold === undefined) return
    const before = enumerations
    const refused = cold.owners.refused(other)
    const denied = cold.owners.routeDenied(hello.repository, "other")
    steps.push({ step, refused, denied, enumerations: enumerations - before })
  }
  const named = (key: string) => key === index ? "refused" : key === EPOCH ? "epoch" : key
  // The sibling refuses the branch of `other` again; this tab is weighed after each of its writes.
  const sibling = Marks.make({
    storage: {
      ...web,
      get length() { return web.length },
      setItem: (key, value) => {
        web.setItem(key, value)
        weigh(`set ${named(key)}`)
      },
      removeItem: (key) => {
        web.removeItem(key)
        weigh(`remove ${named(key)}`)
      },
    },
    storageIdentity: {}, principal: () => DEVICE_PRINCIPAL, changes: () => () => {}, channel: () => undefined, lock: web.lock,
  })
  let replaced = false
  // No storage event reaches this tab. Were its keys enumerated, their order would shift with every write.
  const marks = Marks.make({
    storage: {
      ...web,
      get length() { enumerations++; return web.length },
      key: (at) => { enumerations++; return web.key((at + steps.length) % Math.max(web.length, 1)) },
      getItem: (key) => {
        if (armed && !replaced && key === openKey(topic)) {
          // The first row is being admitted: the sibling replaces the branch refusal of the row after it.
          replaced = true
          expect(sibling.refuseRoute(route)).toBe(true)
        }
        return web.getItem(key)
      },
    },
    principal: () => DEVICE_PRINCIPAL, changes: () => () => {}, channel: () => undefined, lock: web.lock,
  })
  const held = holdRestore({ ...device, refusalMarks: marks }, STORE)
  cold = await open(held.device, first.api)
  const cached = (await cold.runtime.runPromise(Effect.service(BranchStore))).conversations
  await cold.runtime.runPromise(cached.restored)
  expect(cached.tanstack.size).toBe(2)
  // The branch was refused after this tab began, and it was never told: only Web Storage says so.
  const plain = Marks.make({ storage: web, storageIdentity: {}, principal: () => DEVICE_PRINCIPAL, changes: () => () => {}, channel: () => undefined, lock: web.lock })
  expect(plain.refuseRoute(route)).toBe(true)
  const old = plain.routeToken(route)
  expect(steps).toEqual([])
  armed = true
  held.release()
  await until(() => expect(replaced).toBe(true))
  await until(() => expect(cold!.shown()).toEqual([topic]))
  // Every step of the replacement: the new token over the old one in place, then the generation. The branch is
  // refused at each, and asking enumerated no key.
  expect(steps).toEqual(["set refused", "set epoch"].map((step) => ({ step, refused: true, denied: true, enumerations: 0 })))
  const token = plain.routeToken(route)
  expect(token).toMatch(/^[0-9a-f]{16}$/)
  expect(token).not.toBe(old)
  expect(web.getItem(index)).toBe(token)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(cold.shown()).toEqual([topic])
  expect(web.entries.has(openKey(other))).toBe(true)
  const before = enumerations
  expect(cold.owners.refused(other)).toBe(true)
  expect(enumerations).toBe(before)
}, 60_000)

/** A device's branch-refusal setup: its storage, the branch, its two keys, and refusal records over the storage. */
const routeSetup = async () => {
  const device = nodeDevice()
  const first = await open(device)
  const topic = await branch(first)
  await first.close()
  const web = device.webStorage
  const route = `${hello.repository}\0${hello.branch}`
  const marks = (storage: typeof web = web) => Marks.make({
    storage, storageIdentity: {}, principal: () => DEVICE_PRINCIPAL,
    changes: () => () => {}, channel: () => undefined, lock: web.lock,
  })
  return {
    device, first, topic, web, route, marks,
    refusedKey: Marks.routeRefusedKey(DEVICE_PRINCIPAL, route),
    clearedKey: Marks.routeClearedKey(DEVICE_PRINCIPAL, route),
  }
}

test("a rejected track answer whose branch refusal a sibling already cleared writes no branch refusal again: it lifted none", async () => {
  const { first, web, route, marks, refusedKey, clearedKey, device } = await routeSetup()
  expect(marks().refuseRoute(route)).toBe(true)
  const old = marks().routeToken(route)!
  const refusing = await open({ ...nodeDevice(), refusalMarks: marks() }, first.api)
  let armed = false
  let previous: string | undefined
  let raced: { cleared: Marks.RouteClear; token: string | null } | undefined
  const clearing = await open({
    ...nodeDevice(),
    refusalMarks: marks({
      ...web,
      get length() { return web.length },
      getItem: (key) => {
        // This clear reads the refusal it is about to lift (a denial check reads the clear first): a sibling's clear
        // lifted it first, and an unrelated conversation refusal moves the generation right then.
        if (armed && raced === undefined && key === refusedKey && previous !== clearedKey) {
          raced = { cleared: marks().clearRoute(route, old), token: marks().routeToken(route) }
          refusing.owners.refuse(crypto.randomUUID())
        }
        previous = key
        return web.getItem(key)
      },
    }),
  }, first.api)
  const fence = clearing.owners.fence()
  expect(fence.routes.get(route)).toBe(old)
  armed = true
  const answered = crypto.randomUUID()
  expect(await clearing.runtime.runPromise(clearing.owners.clear(answered, fence, hello))).toBe(false)
  expect(raced).toEqual({ cleared: { changed: true, ok: true, prevCleared: null }, token: null })
  await turns(device)
  // The rejected answer opened nothing, and the branch the sibling cleared stays cleared: its refusal is kept, lifted.
  expect(web.entries.has(openKey(answered))).toBe(false)
  expect(marks().routeToken(route)).toBeNull()
  expect(marks().hasRouteDenial(route)).toBe(false)
  expect([web.getItem(refusedKey), web.getItem(clearedKey)]).toEqual([old, old])
  await clearing.close()
  await refusing.close()
}, 60_000)

test.each([0, 1, 2])("a branch refused again lockless before step %i of a sibling's clear stays refused at every storage step after, to a tab never told of it: its surviving open key admits nothing", async (at) => {
  const { device, first, topic, web, route, marks, refusedKey, clearedKey } = await routeSetup()
  // A tab never told of another's write: only Web Storage says the branch is refused.
  const watcher = await open({ ...device, refusalMarks: marks() }, first.api)
  await until(() => expect(watcher.shown()).toEqual([topic]))
  expect(web.entries.has(openKey(topic))).toBe(true)
  expect(marks().refuseRoute(route)).toBe(true)
  const old = marks().routeToken(route)!
  expect(watcher.owners.routeDenied(hello.repository, hello.branch)).toBe(true)
  const refusing = await open({ ...nodeDevice(), refusalMarks: marks() }, first.api)
  const named = (key: string) => key === refusedKey ? "refused" : key === clearedKey ? "cleared" : key === EPOCH ? "epoch" : "other"
  const seen: Array<{ readonly step: string; readonly denied: boolean; readonly stored: boolean }> = []
  const observe = (step: string) => seen.push({
    step, denied: watcher.owners.routeDenied(hello.repository, hello.branch), stored: marks().hasRouteDenial(route),
  })
  let armed = false
  let previous: string | undefined
  let step = -1
  let raced: Promise<void> | undefined
  // Every storage step from the clear's first read of the refusal on, and the lockless refusal before step `at`.
  const watch = <A>(op: string, key: string, act: () => A): A => {
    if (armed && step < 0 && op === "get" && key === refusedKey && previous !== clearedKey) step = 0
    if (step === at && raced === undefined) {
      raced = refusing.owners.refuseBranch(hello.repository, hello.branch)
      observe("sibling refused")
    }
    previous = key
    const result = act()
    if (step >= 0) {
      observe(`${op} ${named(key)}`)
      step++
    }
    return result
  }
  const clearing = await open({
    ...nodeDevice(),
    refusalMarks: marks({
      ...web,
      get length() { return web.length },
      getItem: (key) => watch("get", key, () => web.getItem(key)),
      setItem: (key, value) => watch("set", key, () => web.setItem(key, value)),
      removeItem: (key) => watch("remove", key, () => web.removeItem(key)),
    }),
  }, first.api)
  const fence = clearing.owners.fence()
  expect(fence.routes.get(route)).toBe(old)
  armed = true
  expect(await clearing.runtime.runPromise(clearing.owners.clear(crypto.randomUUID(), fence, hello))).toBe(false)
  await raced
  await turns(device)
  const clearSteps = seen.map(({ step }) => step).filter((name) => name !== "sibling refused").slice(0, at === 0 ? 2 : 3)
  expect(clearSteps).toEqual(["get refused", "get cleared", "set cleared"].slice(0, at === 0 ? 2 : 3))
  expect(seen.length).toBeGreaterThan(at)
  expect(seen.filter(({ denied, stored }) => !denied || !stored)).toEqual([])
  const token = marks().routeToken(route)
  expect(token).toMatch(/^[0-9a-f]{16}$/)
  expect(token).not.toBe(old)
  expect([web.getItem(refusedKey), watcher.owners.routeDenied(hello.repository, hello.branch)]).toEqual([token, true])
  await clearing.close()
  await refusing.close()
  await watcher.close()
}, 60_000)

test("a rejected clear whose undo the storage will not write back removes the cleared key: the branch is denied again by the refusal it lifted, with no refusal written", async () => {
  const { device, first, web, route, marks, refusedKey, clearedKey } = await routeSetup()
  // An earlier refusal, lifted, then a newer one: the undo writes the earlier clear back, which the storage refuses.
  expect(marks().refuseRoute(route)).toBe(true)
  const earlier = marks().routeToken(route)!
  expect(marks().clearRoute(route, earlier)).toMatchObject({ changed: true })
  expect(marks().refuseRoute(route)).toBe(true)
  const old = marks().routeToken(route)!
  const refusing = await open({ ...nodeDevice(), refusalMarks: marks() }, first.api)
  const writes: Array<string> = []
  let cleared = false
  const clearing = await open({
    ...nodeDevice(),
    refusalMarks: marks({
      ...web,
      get length() { return web.length },
      setItem: (key, value) => {
        writes.push(key)
        // The clear's write is taken; the undo's write of the earlier clear over it is not.
        if (key === clearedKey && cleared) throw new DOMException("full", "QuotaExceededError")
        web.setItem(key, value)
        // The branch refusal is lifted; a sibling's conversation refusal moves the generation right then.
        if (key === clearedKey) {
          cleared = true
          refusing.owners.refuse(crypto.randomUUID())
        }
      },
    }),
  }, first.api)
  const fence = clearing.owners.fence()
  expect(fence.routes.get(route)).toBe(old)
  const answered = crypto.randomUUID()
  expect(await clearing.runtime.runPromise(clearing.owners.clear(answered, fence, hello))).toBe(false)
  await turns(device)
  expect(writes.filter((key) => key === clearedKey)).toEqual([clearedKey, clearedKey])
  // No cleared token: the refusal the clear lifted stands again, as it was, and no new one was written.
  expect([web.getItem(refusedKey), web.getItem(clearedKey), marks().hasRouteDenial(route)]).toEqual([old, null, true])
  expect(writes.filter((key) => key === refusedKey)).toEqual([])
  expect(web.entries.has(openKey(answered))).toBe(false)
  expect(clearing.owners.routeDenied(hello.repository, hello.branch)).toBe(true)
  await clearing.close()
  await refusing.close()
}, 60_000)

test("a clear whose branch write the storage refuses fails closed: it counts no clear, and writes no branch refusal again", async () => {
  const { device, first, web, route, marks, refusedKey, clearedKey } = await routeSetup()
  // An earlier refusal, lifted, then a newer one: an undo would write the earlier clear back, which full storage refuses.
  expect(marks().refuseRoute(route)).toBe(true)
  const earlier = marks().routeToken(route)!
  expect(marks().clearRoute(route, earlier)).toMatchObject({ changed: true })
  expect(marks().refuseRoute(route)).toBe(true)
  const old = marks().routeToken(route)
  const epoch = web.getItem(EPOCH)
  const writes: Array<string> = []
  const clearing = await open({
    ...nodeDevice(),
    refusalMarks: marks({
      ...web,
      get length() { return web.length },
      setItem: (key, value) => {
        writes.push(key)
        if (key === clearedKey) throw new DOMException("full", "QuotaExceededError")
        web.setItem(key, value)
      },
    }),
  }, first.api)
  const fence = clearing.owners.fence()
  expect(fence.routes.get(route)).toBe(old)
  const answered = crypto.randomUUID()
  expect(await clearing.runtime.runPromise(clearing.owners.clear(answered, fence, hello))).toBe(false)
  await turns(device)
  expect(writes).toContain(clearedKey)
  // The refusal stands as it was: no clear was written, none undone, and no new refusal moved the generation.
  expect([web.getItem(refusedKey), web.getItem(clearedKey), web.getItem(EPOCH)]).toEqual([old, earlier, epoch])
  expect(writes.filter((key) => key === refusedKey)).toEqual([])
  expect(web.entries.has(openKey(answered))).toBe(false)
  expect(clearing.owners.routeDenied(hello.repository, hello.branch)).toBe(true)
  await clearing.close()
}, 60_000)
