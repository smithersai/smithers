import { expect, test } from "vitest"
import { webStorage } from "../../test/chatApi"
import { REFUSAL_MARKS_KEY } from "./contract"
import * as Marks from "./marks"

// The conversations' second record (marks.ts), over a device's Web Storage as its tabs share it.

const [first, second] = [{ id: "mark-1", conversationId: "conversation-1" }, { id: "mark-2", conversationId: "conversation-2" }]

/** A device's storage with one person's data open on the page. */
const device = (principal = "ada") => {
  const storage = webStorage()
  return { storage, host: { storage, principal: () => principal as string | undefined, changes: storage.changes } }
}

/** Storage that reads, and is over its quota: it takes no new key, and still removes one. */
const full = (storage: ReturnType<typeof webStorage>) => ({
  ...storage,
  get length() {
    return storage.length
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError")
  },
})

/** Storage that holds as much as it holds now and no more: it takes a value no wider than the room a removal left. */
const capped = (storage: ReturnType<typeof webStorage>) => {
  const size = () => [...storage.entries].reduce((sum, [key, value]) => sum + key.length + value.length, 0)
  const limit = size()
  return {
    ...storage,
    get length() {
      return storage.length
    },
    setItem: (key: string, value: string) => {
      if (size() - (storage.entries.has(key) ? key.length + storage.entries.get(key)!.length : 0) + key.length + value.length > limit) {
        throw new DOMException("full", "QuotaExceededError")
      }
      storage.setItem(key, value)
    },
  }
}

test("each refusal is a key of its own, read back by every tab and removed by itself", () => {
  const { storage, host } = device()
  const [one, two] = [Marks.make(host), Marks.make(host)]
  expect(one.read()).toEqual([])
  expect(one.add(first)).toBe(true)
  expect(two.add(second)).toBe(true)
  expect(one.read()).toEqual([first, second])
  expect([...storage.entries.keys()]).toEqual([
    `${REFUSAL_MARKS_KEY}:refused:ada:conversation-1:mark-1`,
    `${REFUSAL_MARKS_KEY}:refusal:ada:conversation-1`,
    `${REFUSAL_MARKS_KEY}:refused:ada:conversation-2:mark-2`,
    `${REFUSAL_MARKS_KEY}:refusal:ada:conversation-2`,
  ])
  expect([one.has(first), two.has(second), one.has({ id: "mark-9", conversationId: "conversation-1" })]).toEqual([true, true, false])
  // Said again, a refusal is the same key with a value no tab has seen, as wide as the one before: every tab is told
  // of the change, and storage that is full takes it.
  const said: Array<string | null> = []
  const hearing = storage.changes((key) => void said.push(key))
  const key = Marks.keyOf("refused", "ada", "conversation-1", "mark-1")
  const was = storage.entries.get(key)!
  expect(was).toMatch(/^[0-9a-f]{16}$/)
  expect(two.restate(first)).toBe(true)
  const next = storage.entries.get(key)!
  expect(Marks.make({ ...host, storage: capped(storage) }).restate(first)).toBe(true)
  expect(said).toEqual([key, key])
  expect(new Set([was, next, storage.entries.get(key)]).size).toBe(3)
  for (const value of [next, storage.entries.get(key)]) expect(value).toMatch(/^[0-9a-f]{16}$/)
  expect(one.read()).toEqual([first, second])
  // One no longer kept is not said again: another tab removed it, and saying it would bring it back.
  expect(two.restate({ id: "mark-9", conversationId: "conversation-1" })).toBe(false)
  expect(one.read()).toEqual([first, second])
  hearing()
  // Removing one that is not kept changes nothing; removing one that is leaves the rest.
  const writes: Array<string | null> = []
  const stop = storage.changes((key) => void writes.push(key))
  two.remove([{ id: "mark-9", conversationId: "conversation-1" }])
  expect(writes).toEqual([])
  two.remove([first, { id: "mark-9", conversationId: "conversation-1" }])
  expect(writes).toEqual([Marks.keyOf("refused", "ada", "conversation-1", "mark-1"), Marks.keyOf("refusal", "ada", "conversation-1")])
  expect(one.read()).toEqual([second])
  stop()
})

test("two tabs that refuse at once both keep their refusal: neither writes over the other's", () => {
  const { storage, host } = device()
  // Each tab's view of the storage as it stood before either wrote: what a tab that read one shared value, changed
  // it and wrote it back would have written over the other's with.
  const before = new Map(storage.entries)
  const [one, two] = [Marks.make(host), Marks.make(host)]
  expect(before.size).toBe(0)
  expect(one.add(first)).toBe(true)
  expect(two.add(second)).toBe(true)
  // A third refuses the first's conversation again, and the first tab's is answered meanwhile: the removal takes its
  // own key, and the two written beside it stand.
  const third = { id: "mark-3", conversationId: first.conversationId }
  expect(two.add(third)).toBe(true)
  one.remove([first])
  expect(one.read()).toEqual([second, third])
  expect(storage.entries.size).toBe(4)
})

test("a conversation is open only once ChatApi answered for it, until a refusal, and again once a read is answered", () => {
  const { storage, host } = device()
  const marks = Marks.make(host)
  const open = Marks.keyOf("open", "ada", "conversation-1")
  // No key says nothing is open: nothing here takes a conversation as new to the device.
  expect(marks.granted("conversation-1")).toBe(false)
  marks.grant("conversation-1")
  expect([...storage.entries.keys()]).toEqual([open])
  expect(marks.granted("conversation-1")).toBe(true)
  // Refused: open no longer, with no key left that could be read as anything else.
  marks.revoke("conversation-1")
  expect([...storage.entries.keys()]).toEqual([])
  expect(marks.granted("conversation-1")).toBe(false)
  // Answered whole: open again. Answered again: nothing is written.
  marks.grant("conversation-1")
  expect(marks.granted("conversation-1")).toBe(true)
  const writes: Array<string | null> = []
  const stop = storage.changes((key) => void writes.push(key))
  marks.grant("conversation-1")
  expect(writes).toEqual([])
  stop()
  // A conversation refused before anything answered for it stays not open.
  marks.revoke("conversation-2")
  expect(marks.granted("conversation-2")).toBe(false)
  // No part of a key holds the `:` that parts them.
  marks.grant("a:b")
  expect(storage.entries.has(`${REFUSAL_MARKS_KEY}:open:ada:a%3Ab`)).toBe(true)
  expect(marks.add({ id: "x:y", conversationId: "a:b" })).toBe(true)
  expect(marks.read()).toEqual([{ id: "x:y", conversationId: "a:b" }])
})

test("storage that is full takes no refusal and opens no conversation, and still takes away that one is open", () => {
  const { storage, host } = device()
  const before = Marks.make(host)
  before.grant("conversation-1")
  const marks = Marks.make({ ...host, storage: full(storage) })
  expect(marks.add(first)).toBe(false)
  expect(marks.restate(first)).toBe(false)
  expect(marks.read()).toEqual([])
  marks.revoke("conversation-1")
  expect(marks.granted("conversation-1")).toBe(false)
  expect([...storage.entries.keys()]).toEqual([])
  // Nothing new is recorded: an answer opens none, and with no key the conversation is not open on the next load.
  marks.revoke("conversation-3")
  marks.grant("conversation-1")
  marks.grant("conversation-4")
  expect([...storage.entries.keys()]).toEqual([])
  expect([marks.granted("conversation-1"), marks.granted("conversation-4")]).toEqual([false, false])
  // A removal the storage refuses leaves the refusal kept: it still hides.
  expect(before.add(first)).toBe(true)
  const stuck = Marks.make({ ...host, storage: { ...storage, length: 0, removeItem: () => { throw new DOMException("blocked", "SecurityError") } } })
  stuck.remove([first])
  stuck.revoke("conversation-1")
  expect(before.read()).toEqual([first])
})

test("storage with no room left takes the refusal of a conversation that was open: the open key held its room", () => {
  const { storage, host } = device()
  Marks.make(host).grant("conversation-1")
  const marks = Marks.make({ ...host, storage: capped(storage) })
  const refusal = { id: crypto.randomUUID(), conversationId: "conversation-1" }
  // Not while the conversation is open, and not for a conversation that never was.
  expect(marks.add(refusal)).toBe(false)
  marks.revoke("conversation-2")
  expect(marks.add({ id: crypto.randomUUID(), conversationId: "conversation-2" })).toBe(false)
  marks.revoke("conversation-1")
  expect(marks.add(refusal)).toBe(true)
  expect(marks.read()).toEqual([refusal])
  // Said again, it takes no more room; and the open key no longer fits beside it.
  expect(marks.restate(refusal)).toBe(true)
  marks.grant("conversation-1")
  expect(marks.granted("conversation-1")).toBe(false)
})

test("a read of the storage is what another tab did before this tab is told: a refusal written or said again, or open taken away, is later; a removal is not", () => {
  const { storage, host } = device()
  const [one, two] = [Marks.make(host), Marks.make(host)]
  one.grant("conversation-1")
  one.grant("conversation-2")
  expect(two.add(second)).toBe(true)
  const began = one.standing()
  expect([...began.open]).toEqual(["conversation-1", "conversation-2"])
  expect([...began.refused.values()]).toEqual([{ conversationId: "conversation-2", id: "mark-2", token: expect.stringMatching(/^[0-9a-f]{16}$/) }])
  expect([one.later("conversation-1", began), one.later("conversation-2", began)]).toEqual([false, false])
  // Another tab's refusal of the first conversation: its key, read at once. The second conversation's stands as it was.
  expect(two.add(first)).toBe(true)
  expect([one.later("conversation-1", began), one.later("conversation-2", began)]).toEqual([true, false])
  // A read that began after it is not older than it; the refusal said again is later than that read too.
  const after = one.standing()
  expect(one.later("conversation-1", after)).toBe(false)
  expect(two.restate(first)).toBe(true)
  expect(one.later("conversation-1", after)).toBe(true)
  // What the reader wrote itself, by the refusal's id and the token it holds now, is not later; another token is.
  const [mine, wrote] = [Marks.keyOf("refused", "ada", "conversation-1", "mark-1"), two.token(first)]
  expect(wrote).toBe(storage.entries.get(mine))
  expect(one.later("conversation-1", after, (id, token) => id === "mark-1" && token === wrote)).toBe(false)
  expect(one.later("conversation-1", after, (id, token) => id === "mark-1" && token === "0000000000000000")).toBe(true)
  expect([two.token({ id: "mark-9", conversationId: "conversation-1" }), Marks.none.token(first)]).toEqual([null, null])
  expect(Marks.make({ ...host, principal: () => undefined }).token(first)).toBeNull()
  // A removal, as an answered read makes, is nothing later; open taken away is, with no refusal written.
  two.remove([first, second])
  expect([one.later("conversation-1", after), one.later("conversation-2", after)]).toEqual([false, false])
  two.revoke("conversation-2")
  expect([one.later("conversation-1", began), one.later("conversation-2", began)]).toEqual([false, true])
  // Open put back is nothing later either, whatever it was before.
  two.grant("conversation-2")
  expect(one.later("conversation-2", one.standing())).toBe(false)
  // A key the storage counted and no longer names a value for reads as a refusal with none: later than any token.
  expect(two.add(first)).toBe(true)
  const emptied = Marks.make({ ...host, storage: { ...storage, length: storage.length, getItem: () => null } })
  expect([...emptied.standing().refused.values()]).toEqual([{ conversationId: "conversation-1", id: "mark-1", token: "" }])
  expect(emptied.later("conversation-1", one.standing())).toBe(true)
})

test("a tab hears another tab's change to a refusal or to whether a conversation is open, the storage cleared, and nothing else", () => {
  const { storage } = device()
  const heard: Array<Marks.MarkChange | string> = []
  const hear: { tell?: (key: string | null) => void } = {}
  const who = { now: "ada" as string | undefined }
  const marks = Marks.make({ storage, principal: () => who.now, changes: (listener) => {
    hear.tell = listener
    return () => void heard.push("stopped")
  } })
  const stop = marks.subscribe((change) => void heard.push(change ?? "reconcile"))
  // Another key, the person's knowing a conversation, another person's facts, and keys that are no fact.
  for (const key of [
    "smithers-theme",
    `${REFUSAL_MARKS_KEY}:known:ada:conversation-1`,
    Marks.keyOf("open", "bob", "conversation-1"),
    Marks.keyOf("route", "bob", "route"),
    Marks.keyOf("route-cleared", "bob", "route"),
    Marks.keyOf("refused", "bob", "conversation-1", "mark-1"),
    `${REFUSAL_MARKS_KEY}:refused:ada:conversation-1`,
    `${REFUSAL_MARKS_KEY}:open:ada:conversation-1:mark-1`,
    `${REFUSAL_MARKS_KEY}:other:ada:conversation-1`,
    `${REFUSAL_MARKS_KEY}:open:ada:%E0%A4%A`,
    REFUSAL_MARKS_KEY,
  ]) hear.tell!(key)
  expect(heard).toEqual([])
  hear.tell!(Marks.keyOf("refused", "ada", "conversation-1", "mark-1"))
  hear.tell!(Marks.keyOf("open", "ada", "conversation-2"))
  hear.tell!(Marks.keyOf("route", "ada", "route"))
  hear.tell!(Marks.keyOf("route-cleared", "ada", "route"))
  hear.tell!(null)
  expect(heard).toEqual([{ conversationId: "conversation-1", id: "mark-1" }, { conversationId: "conversation-2" }, "reconcile", "reconcile", "reconcile"])
  // A page that holds nobody's data hears no person's facts.
  who.now = undefined
  hear.tell!(Marks.keyOf("open", "ada", "conversation-2"))
  expect(heard).toHaveLength(5)
  stop()
  expect(heard[5]).toBe("stopped")
})

test("another person's facts are nobody's here, and each person's stand beside the other's", () => {
  const { storage } = device()
  const who = { now: "ada" as string | undefined }
  const marks = Marks.make({ storage, principal: () => who.now, changes: storage.changes })
  expect(marks.add(first)).toBe(true)
  marks.grant("conversation-1")
  const adas = marks.standing()
  // The device's data becomes another person's: they read none of the first person's facts, and change none.
  who.now = "bob"
  expect(marks.read()).toEqual([])
  expect([marks.has(first), marks.granted("conversation-1")]).toEqual([false, false])
  expect(marks.standing()).toEqual({ refused: new Map(), open: new Set() })
  marks.remove([first])
  marks.revoke("conversation-1")
  // Refused to them, it is not open; the first person's is open still. Answered for them, another is theirs alone.
  marks.grant("conversation-2")
  expect([marks.granted("conversation-1"), marks.granted("conversation-2")]).toEqual([false, true])
  expect(marks.add(second)).toBe(true)
  expect(marks.read()).toEqual([second])
  who.now = "ada"
  expect(marks.read()).toEqual([first])
  expect([marks.granted("conversation-1"), marks.granted("conversation-2")]).toEqual([true, false])
  expect(marks.standing()).toEqual(adas)
  // A key that is no fact, and one another tab removed while the keys were counted, read as none.
  storage.entries.set(`${REFUSAL_MARKS_KEY}:refused:ada`, "1")
  storage.entries.set(REFUSAL_MARKS_KEY, "{}")
  expect(marks.read()).toEqual([first])
  const counted = Marks.make({ storage: { ...storage, length: storage.length + 1 }, principal: () => "ada", changes: storage.changes })
  expect(counted.read()).toEqual([first])
  expect([...counted.standing().refused.keys()]).toEqual([Marks.keyOf("refused", "ada", first.conversationId, first.id)])
})

test("a page that holds nobody's data reads and keeps no grants", () => {
  const storage = webStorage()
  const marks = Marks.make({ storage, principal: () => undefined, changes: storage.changes })
  expect(marks.add(first)).toBe(false)
  expect(marks.restate(first)).toBe(false)
  marks.remove([first])
  marks.grant("conversation-1")
  marks.revoke("conversation-1")
  expect(marks.read()).toEqual([])
  expect([marks.has(first), marks.granted("conversation-1")]).toEqual([false, false])
  expect(marks.standing()).toEqual({ refused: new Map(), open: new Set() })
  expect(marks.later("conversation-1", marks.standing())).toBe(false)
  for (const page of [marks, Marks.none]) {
    expect(page.refuseRoute("unknown")).toBe(false)
    expect(page.refused("unknown")).toBe(false)
    expect(page.clearRoute("unknown", "0123456789abcdef")).toEqual({ changed: false, ok: true })
    expect(page.restoreRoute("unknown", null)).toBe(false)
    expect([...page.routeDenials().keys()]).toEqual([])
    expect(page.routeToken("unknown")).toBeNull()
    expect(page.hasRouteDenial("unknown")).toBe(false)
    page.listen(() => {})()
    page.broadcast({ kind: "refuse-route", route: "unknown" })
  }
  expect(storage.entries.size).toBe(0)
})

test("storage a browser blocks keeps nothing, opens nothing and says nothing is gone; a host without storage keeps none", () => {
  const blocked = () => { throw new DOMException("blocked", "SecurityError") }
  const marks = Marks.make({
    storage: { getItem: blocked, setItem: blocked, removeItem: blocked, key: blocked, get length(): number { return blocked() } },
    principal: () => "ada",
    changes: () => () => {},
  })
  expect(marks.read()).toEqual([])
  expect(marks.add(first)).toBe(false)
  marks.remove([first])
  marks.grant("conversation-1")
  marks.revoke("conversation-1")
  // What cannot be read is not said to be gone, and not said to be open.
  expect([marks.has(first), marks.granted("conversation-1")]).toEqual([true, false])
  // Nothing is read of it, so nothing in it is later than a read; open that a read saw is gone with it.
  expect(marks.standing()).toEqual({ refused: new Map(), open: new Set() })
  expect(marks.later("conversation-1", marks.standing())).toBe(false)
  expect(marks.later("conversation-1", { refused: new Map(), open: new Set(["conversation-1"]) })).toBe(true)
  expect(Marks.none.read()).toEqual([])
  expect(Marks.none.add(first)).toBe(false)
  expect(Marks.none.restate(first)).toBe(false)
  Marks.none.remove([first])
  Marks.none.grant("conversation-1")
  Marks.none.revoke("conversation-1")
  expect([Marks.none.has(first), Marks.none.granted("conversation-1")]).toEqual([false, false])
  expect(Marks.none.later("conversation-1", Marks.none.standing())).toBe(false)
  Marks.none.subscribe(() => {})()
})

test("the generation is one key as wide every time: written while there is room, moved in place by a refusal, and removed where even that is refused", () => {
  const { storage, host } = device()
  const marks = Marks.make(host)
  const key = `${REFUSAL_MARKS_KEY}:epoch:ada`
  // None until one is written; written once, and left as it is by a second writing.
  expect(marks.epoch()).toBeNull()
  marks.anchor()
  const first = marks.epoch()
  expect(first).toMatch(/^[0-9a-f]{16}$/)
  expect([...storage.entries.keys()]).toEqual([key])
  marks.anchor()
  expect(marks.epoch()).toBe(first)
  // A refusal moves it: another value as wide, which storage with no room left takes, since it takes none.
  const atQuota = Marks.make({ ...host, storage: capped(storage) })
  atQuota.advance()
  const second = atQuota.epoch()
  expect(second).toMatch(/^[0-9a-f]{16}$/)
  expect(second).not.toBe(first)
  expect(marks.epoch()).toBe(second)
  // Storage that refuses even that: the key is removed, so no read that began at a generation finds it again.
  const over = Marks.make({ ...host, storage: full(storage) })
  over.advance()
  expect([marks.epoch(), over.epoch(), storage.entries.has(key)]).toEqual([null, null, false])
  // Full, none can be written; with room, a new one is, unlike any before it. A refusal writes one too.
  over.anchor()
  expect(marks.epoch()).toBeNull()
  marks.anchor()
  const third = marks.epoch()
  expect(third).toMatch(/^[0-9a-f]{16}$/)
  expect([first, second]).not.toContain(third)
  storage.removeItem(key)
  marks.advance()
  expect(marks.epoch()).toMatch(/^[0-9a-f]{16}$/)
  // No fact of a conversation: nothing is read of it as a refusal or as open, and no tab is told of it as one.
  const heard: Array<unknown> = []
  const stop = marks.subscribe((change) => void heard.push(change))
  marks.advance()
  expect([marks.read(), marks.standing(), heard]).toEqual([[], { refused: new Map(), open: new Set() }, []])
  stop()
})

test("the tabs of one process count the refusals they were given, by the storage they share and the person, with no storage to write", () => {
  const { storage, host } = device()
  const who = { now: "ada" as string | undefined }
  const [one, two] = [Marks.make(host), Marks.make({ ...host, principal: () => who.now })]
  expect([one.memory(), two.memory()]).toEqual([0, 0])
  one.advance()
  two.advance()
  expect([one.memory(), two.memory()]).toEqual([2, 2])
  // Storage that takes nothing, and storage a browser blocks, still count: a tab's view of the storage is its own.
  const over = Marks.make({ ...host, storage: full(storage) })
  over.advance()
  expect([over.memory(), one.memory()]).toEqual([1, 2])
  const blocked = () => { throw new DOMException("blocked", "SecurityError") }
  const none = Marks.make({
    storage: { getItem: blocked, setItem: blocked, removeItem: blocked, key: blocked, get length(): number { return blocked() } },
    principal: () => "ada",
    changes: () => () => {},
  })
  none.anchor()
  none.advance()
  expect([none.epoch(), none.memory()]).toEqual([null, 1])
  // Another person's count is their own.
  who.now = "bob"
  expect(two.memory()).toBe(0)
  two.advance()
  expect([two.memory(), one.memory()]).toEqual([1, 2])
  // A page that holds nobody's data counts nothing and keeps no generation: the one it reads never moves.
  who.now = undefined
  two.anchor()
  two.advance()
  expect([two.memory(), two.epoch(), Marks.none.memory(), Marks.none.epoch()]).toEqual([0, "", 0, ""])
  Marks.none.anchor()
  Marks.none.advance()
  expect([Marks.none.memory(), Marks.none.epoch()]).toEqual([0, ""])
  expect(storage.entries.has(`${REFUSAL_MARKS_KEY}:epoch:bob`)).toBe(true)
})

/** A turn that waits until `release` is called, and tells `order` as it begins and ends. */
const held = (order: Array<string>, name: string) => {
  const gate = Promise.withResolvers<void>()
  const turn = async () => {
    order.push(`${name} begins`)
    await gate.promise
    order.push(`${name} ends`)
    return name
  }
  return { turn, release: () => gate.resolve() }
}

test("a turn is the person's Web Lock, exclusive: every tab's turn waits for the one asked for before it", async () => {
  const { host } = device(`ada-${crypto.randomUUID()}`)
  const [one, two] = [Marks.make(host), Marks.make(host)]
  const name = Marks.lockName(host.principal()!)
  expect(name).toBe(`smithers:refusal-lock:${host.principal()}`)
  const order: Array<string> = []
  const [first, second, third] = [held(order, "one"), held(order, "two"), held(order, "three")]
  const turns = [one.lock(first.turn), two.lock(second.turn), one.lock(third.turn)]
  // The browser's own lock holds it: the first is in its turn, the others wait behind it in the order asked.
  await expect.poll(async () => (await navigator.locks.query()).held?.filter((lock) => lock.name === name)).toEqual([expect.objectContaining({ mode: "exclusive" })])
  await expect.poll(async () => (await navigator.locks.query()).pending?.filter((lock) => lock.name === name)).toHaveLength(2)
  expect(order).toEqual(["one begins"])
  second.release()
  third.release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(order).toEqual(["one begins"])
  first.release()
  expect(await Promise.all(turns)).toEqual(["one", "two", "three"])
  expect(order).toEqual(["one begins", "one ends", "two begins", "two ends", "three begins", "three ends"])
  expect((await navigator.locks.query()).held?.filter((lock) => lock.name === name)).toEqual([])
  // A page that holds nobody's data takes no lock, and neither does a host with no storage.
  const nobody = Marks.make({ ...host, principal: () => undefined })
  expect(await nobody.lock(async () => (await navigator.locks.query()).held?.filter((lock) => lock.name === name))).toEqual([])
  expect(await Marks.none.lock(async () => "ran")).toBe("ran")
})

test("a host with no Web Locks takes turns among the tabs that share its storage, first come first served; a turn that fails ends like any other", async () => {
  const storage = webStorage()
  const order: Array<string> = []
  const lock = Marks.lockOf(undefined, storage)
  const [first, second] = [held(order, "one"), held(order, "two")]
  const failing = lock("turns", async () => {
    order.push("fails")
    throw new Error("turn failed")
  })
  const turns = [lock("turns", first.turn), lock("turns", second.turn)]
  // Another name, and another storage, wait for neither.
  expect(await lock("other", async () => "other name")).toBe("other name")
  expect(await Marks.inProcess(webStorage())("turns", async () => "other storage")).toBe("other storage")
  await expect(failing).rejects.toThrow("turn failed")
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(order).toEqual(["fails", "one begins"])
  second.release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(order).toEqual(["fails", "one begins"])
  first.release()
  expect(await Promise.all(turns)).toEqual(["one", "two"])
  expect(order).toEqual(["fails", "one begins", "one ends", "two begins", "two ends"])
  // The same storage's tabs share the turns, whichever of them made the lock; the host's own lock is used as given.
  const again = held(order, "three")
  const waiting = Marks.inProcess(storage)("turns", again.turn)
  const after = lock("turns", async () => order.at(-1))
  again.release()
  expect([await waiting, await after]).toEqual(["three", "three ends"])
  const asked: Array<string> = []
  const marks = Marks.make({ storage, principal: () => "ada", changes: storage.changes, lock: (name, turn) => {
    asked.push(name)
    return turn()
  } })
  expect(await marks.lock(async () => "given")).toBe("given")
  expect(asked).toEqual(["smithers:refusal-lock:ada"])
  // With Web Locks, the host's lock is theirs.
  const name = `turns-${crypto.randomUUID()}`
  expect(await Marks.lockOf(navigator.locks, storage)(name, async () => (await navigator.locks.query()).held?.map((lock) => lock.name))).toContain(name)
})

test("durable pages without a cross-process lock ignore old open keys and keep no new ones", () => {
  const { storage, host } = device()
  const previous = Marks.make(host)
  previous.grant("old")
  const unlocked = Marks.make({ ...host, persistOpen: false })
  expect(unlocked.granted("old")).toBe(false)
  unlocked.grant("new")
  expect(storage.getItem(Marks.keyOf("open", "ada", "new"))).toBeNull()
})

test("only the named principal's persisted route denials are read and cleared", () => {
  const { storage, host } = device()
  const marks = Marks.make(host)
  const own = "github/octo/hello\0branch/one"
  const other = "github/octo/hello\0branch/two"
  expect(marks.refuseRoute(own)).toBe(true)
  const foreign = Marks.make({ ...host, principal: () => "other" })
  foreign.refuseRoute(other)
  expect([...marks.routeDenials().keys()]).toEqual([own])
  expect([...foreign.routeDenials().keys()]).toEqual([other])
  const counted = Marks.make({ ...host, storage: { ...storage, length: storage.length + 1 } })
  expect([...counted.routeDenials().keys()]).toEqual([own])
  expect(marks.routeToken(own)).toMatch(/^[0-9a-f]{16}$/)
  expect(marks.routeDenials().get(own)).toBe(marks.routeToken(own))
  expect(foreign.routeToken(own)).toBeNull()
  const unowned = Marks.make({ ...host, principal: () => undefined })
  expect(unowned.routeToken(own)).toBeNull()
  expect(unowned.refused("unknown")).toBe(false)
  expect(unowned.routeDenials().size).toBe(0)
  const removedDuringScan = Marks.make({ ...host, storage: { ...storage, length: storage.length, getItem: () => null } })
  expect(removedDuringScan.routeDenials().size).toBe(0)
  expect(marks.clearRoute(own, marks.routeToken(own)!)).toMatchObject({ changed: true })
  expect([...marks.routeDenials().keys()]).toEqual([])
  expect([...foreign.routeDenials().keys()]).toEqual([other])
})

test("the default refusal channel relays a route denial even when its storage is blocked", async () => {
  const { storage, host } = device(crypto.randomUUID())
  const one = Marks.make({ ...host, storage: full(storage) })
  const two = Marks.make({ ...host, storageIdentity: {} })
  const received = Promise.withResolvers<Marks.Denial>()
  const stopOne = one.listen(() => {})
  const stopTwo = two.listen(received.resolve)
  try {
    const denial = { kind: "refuse-route", route: "github/octo/hello\0branch/one" } as const
    one.refuseRoute(denial.route)
    one.advance()
    one.broadcast(denial)
    expect(await received.promise).toEqual(denial)
    expect(two.memory()).toBe(1)
    expect([...two.routeDenials().keys()]).toEqual([])
  } finally {
    stopTwo()
    stopOne()
  }
})

test("a route denial at quota drops all open keys before retrying and reports whether it persisted", () => {
  const { storage, host } = device()
  const marks = Marks.make({ ...host, persistOpen: true })
  const route = "github/octo/hello\0topic"
  marks.grant(first.conversationId)
  marks.grant(second.conversationId)
  expect(Marks.make({ ...host, storage: capped(storage) }).refuseRoute(route)).toBe(true)
  expect(marks.routeToken(route)).toMatch(/^[0-9a-f]{16}$/)
  expect([marks.granted(first.conversationId), marks.granted(second.conversationId)]).toEqual([false, false])

  expect(marks.clearRoute(route, marks.routeToken(route)!)).toMatchObject({ changed: true })
  marks.grant(first.conversationId)
  expect(Marks.make({ ...host, storage: full(storage) }).refuseRoute(route)).toBe(false)
  expect(marks.routeToken(route)).toBeNull()
  expect(marks.granted(first.conversationId)).toBe(false)
})

test("a branch refusal at quota drops only open keys: every branch's cleared key stays, outlived or not", () => {
  const { storage, host } = device()
  const marks = Marks.make({ ...host, persistOpen: true })
  const [outlived, lifted, fresh] = ["github/octo/hello\0aaaa", "github/octo/hello\0bbbb", "github/octo/hello\0cccc"]
  for (const route of [outlived, lifted]) {
    expect(marks.refuseRoute(route)).toBe(true)
    expect(marks.clearRoute(route, marks.routeToken(route)!)).toMatchObject({ changed: true })
  }
  // Refused again since its clear: the clear names a token no longer kept, and lifts nothing.
  expect(marks.refuseRoute(outlived)).toBe(true)
  const clears = [outlived, lifted].map((route) => storage.getItem(Marks.routeClearedKey("ada", route)))
  marks.grant(first.conversationId)
  marks.grant(second.conversationId)
  expect(Marks.make({ ...host, storage: capped(storage) }).refuseRoute(fresh)).toBe(true)
  expect([marks.granted(first.conversationId), marks.granted(second.conversationId)]).toEqual([false, false])
  expect([outlived, lifted].map((route) => storage.getItem(Marks.routeClearedKey("ada", route)))).toEqual(clears)
  expect([outlived, lifted, fresh].map((route) => marks.hasRouteDenial(route))).toEqual([true, false, true])
})

test("a sibling's clear of another branch, made as a lockless refusal at quota frees room, is never removed by it", () => {
  const { storage, host } = device()
  const marks = Marks.make({ ...host, persistOpen: true })
  const [other, fresh] = ["github/octo/hello\0aaaa", "github/octo/hello\0cccc"]
  const [otherRefused, otherCleared] = [Marks.routeRefusedKey("ada", other), Marks.routeClearedKey("ada", other)]
  // Cleared once, then refused again: its clear lifts nothing until a sibling clears the newer refusal.
  expect(marks.refuseRoute(other)).toBe(true)
  expect(marks.clearRoute(other, marks.routeToken(other)!)).toMatchObject({ changed: true })
  expect(marks.refuseRoute(other)).toBe(true)
  const newer = marks.routeToken(other)!
  marks.grant(first.conversationId)
  marks.grant(second.conversationId)
  const room = capped(storage)
  let atQuota = false
  let cleared: Marks.RouteClear | undefined
  // The sibling clears the moment the refusing tab first reads the other branch's refusal once its write failed, or
  // once the refusal returns: either way, after the refusing tab could have judged the older clear stale.
  const sibling = () => {
    if (cleared === undefined) cleared = marks.clearRoute(other, newer)
  }
  const refuser = Marks.make({
    ...host,
    storage: {
      ...room,
      get length() { return room.length },
      getItem: (key) => {
        const value = storage.getItem(key)
        if (atQuota && key === otherRefused) sibling()
        return value
      },
      setItem: (key, value) => {
        try {
          room.setItem(key, value)
        } catch (error) {
          atQuota = true
          throw error
        }
      },
    },
  })
  expect(refuser.refuseRoute(fresh)).toBe(true)
  expect(atQuota).toBe(true)
  sibling()
  expect(cleared).toEqual({ changed: true, ok: true, prevCleared: expect.any(String) })
  expect([storage.getItem(otherCleared), marks.hasRouteDenial(other), marks.hasRouteDenial(fresh)]).toEqual([newer, false, true])
})

test("a live conversation refusal reads only its direct key without enumerating storage", () => {
  const { storage, host } = device()
  expect(Marks.make(host).add(first)).toBe(true)
  const reads: Array<string> = []
  let enumerations = 0
  const marks = Marks.make({
    ...host,
    storage: {
      ...storage,
      get length() { enumerations++; return storage.length },
      key: (index) => { enumerations++; return storage.key(index) },
      getItem: (key) => { reads.push(key); return storage.getItem(key) },
    },
  })
  expect(marks.refused(first.conversationId)).toBe(true)
  expect(marks.refused(second.conversationId)).toBe(false)
  expect(reads).toEqual([first, second].map(({ conversationId }) => Marks.keyOf("refusal", "ada", conversationId)))
  expect(enumerations).toBe(0)
})

test("a sibling refusal written while another tab removes the last one keeps its conversation refused", () => {
  const { storage, host } = device()
  const index = Marks.keyOf("refusal", "ada", first.conversationId)
  const sibling = Marks.make(host)
  const later = { id: "mark-3", conversationId: first.conversationId }
  expect(sibling.add(first)).toBe(true)
  let raced = false
  const remover = Marks.make({
    ...host,
    storage: {
      ...storage,
      get length() { return storage.length },
      removeItem: (key) => {
        // The sibling writes its mark and index after this tab found no mark left and before it drops the index.
        if (key === index && !raced) {
          raced = true
          expect(sibling.add(later)).toBe(true)
        }
        storage.removeItem(key)
      },
    },
  })
  remover.remove([first])
  expect(raced).toBe(true)
  expect([sibling.refused(first.conversationId), storage.entries.has(index)]).toEqual([true, true])
  remover.remove([later])
  expect([sibling.refused(first.conversationId), storage.entries.has(index)]).toEqual([false, false])
})

test("a refusal whose index cannot be written leaves no mark behind", () => {
  const { storage, host } = device()
  const marks = Marks.make({
    ...host,
    storage: {
      ...storage,
      get length() { return storage.length },
      setItem: (key, value) => {
        if (key.includes(":refusal:")) throw new DOMException("full", "QuotaExceededError")
        storage.setItem(key, value)
      },
    },
  })
  expect(marks.add(first)).toBe(false)
  expect([...storage.entries.keys()]).toEqual([])
  expect(marks.refused(first.conversationId)).toBe(false)
})

test("a route key whose percent escape does not decode is skipped as the branch refusals are read; the valid ones are still read", () => {
  const { storage, host } = device()
  const marks = Marks.make(host)
  const own = "github/octo/hello\0branch/one"
  expect(marks.refuseRoute(own)).toBe(true)
  const prefix = Marks.keyOf("route", "ada")
  for (const malformed of ["%E0%A4%A", "%ZZ"]) {
    expect(() => decodeURIComponent(malformed)).toThrow(URIError)
    storage.setItem(`${prefix}:${malformed}`, "0123456789abcdef")
  }
  expect([...marks.routeDenials()]).toEqual([[own, marks.routeToken(own)]])
})

test("a branch refused again stays refused at every step of the write, and asking reads two keys and enumerates none", () => {
  const { storage, host } = device()
  const route = "github/octo/hello\0topic"
  const refusedKey = Marks.routeRefusedKey("ada", route)
  const clearedKey = Marks.routeClearedKey("ada", route)
  expect(refusedKey).toBe(Marks.keyOf("route", "ada", route))
  expect(Marks.make(host).refuseRoute(route)).toBe(true)
  const old = Marks.make(host).routeToken(route)
  expect(storage.getItem(refusedKey)).toBe(old)
  const reads: Array<string> = []
  let enumerations = 0
  const reader = Marks.make({
    ...host,
    storage: {
      ...storage,
      get length() { enumerations++; return storage.length },
      key: (at) => { enumerations++; return storage.key(at) },
      getItem: (key) => { reads.push(key); return storage.getItem(key) },
    },
  })
  const steps: Array<{ readonly step: string; readonly denied: boolean }> = []
  const named = (key: string) => key === refusedKey ? "refused" : key === clearedKey ? "cleared" : key === Marks.keyOf("epoch", "ada") ? "epoch" : key
  const writer = Marks.make({
    ...host,
    storage: {
      ...storage,
      get length() { return storage.length },
      setItem: (key, value) => {
        storage.setItem(key, value)
        steps.push({ step: `set ${named(key)}`, denied: reader.hasRouteDenial(route) })
      },
      removeItem: (key) => {
        storage.removeItem(key)
        steps.push({ step: `remove ${named(key)}`, denied: reader.hasRouteDenial(route) })
      },
    },
  })
  expect(writer.refuseRoute(route)).toBe(true)
  // The new token over the old one in place, then the generation: nothing is removed, so nothing is ever unrefused.
  expect(steps).toEqual(["set refused", "set epoch"].map((step) => ({ step, denied: true })))
  expect(reads).toEqual([clearedKey, refusedKey, clearedKey, refusedKey])
  expect(enumerations).toBe(0)
  const next = Marks.make(host).routeToken(route)
  expect(next).toMatch(/^[0-9a-f]{16}$/)
  expect(next).not.toBe(old)
  expect(storage.getItem(refusedKey)).toBe(next)
  // Unreadable storage names no branch refusal.
  expect(Marks.make({ ...host, storage: { ...storage, getItem: () => { throw new DOMException("denied", "SecurityError") } } }).hasRouteDenial(route)).toBe(false)
})

test("a branch refusal the storage will not take leaves the older one standing", () => {
  const { storage, host } = device()
  const route = "github/octo/hello\0topic"
  const refusedKey = Marks.routeRefusedKey("ada", route)
  const marks = Marks.make(host)
  expect(marks.refuseRoute(route)).toBe(true)
  const old = marks.routeToken(route)
  marks.grant(first.conversationId)
  const refusing = Marks.make({
    ...host,
    storage: {
      ...storage,
      get length() { return storage.length },
      setItem: (key, value) => {
        if (key === refusedKey) throw new DOMException("full", "QuotaExceededError")
        storage.setItem(key, value)
      },
    },
  })
  expect(refusing.refuseRoute(route)).toBe(false)
  expect(marks.routeToken(route)).toBe(old)
  expect(storage.getItem(refusedKey)).toBe(old)
  expect(marks.hasRouteDenial(route)).toBe(true)
  // The retry dropped every open key first, as any refusal at quota does.
  expect(marks.granted(first.conversationId)).toBe(false)
})

test("a branch clear writes only the token it was fenced on, never removes the refusal, and says whether it wrote", () => {
  const { storage, host } = device()
  const route = "github/octo/hello\0topic"
  const refusedKey = Marks.routeRefusedKey("ada", route)
  const clearedKey = Marks.routeClearedKey("ada", route)
  const marks = Marks.make(host)
  expect(marks.refuseRoute(route)).toBe(true)
  const fenced = marks.routeToken(route)!
  expect(marks.clearRoute(route, fenced)).toEqual({ changed: true, ok: true, prevCleared: null })
  expect([marks.hasRouteDenial(route), storage.getItem(refusedKey), storage.getItem(clearedKey), marks.routeToken(route)]).toEqual([false, fenced, fenced, null])
  // A sibling cleared it first: this clear wrote nothing, and nothing else is refused.
  expect(marks.clearRoute(route, fenced)).toEqual({ changed: false, ok: true })
  // A refusal given since the fence: the clear writes nothing and is not ok, and the newer refusal stands.
  expect(marks.refuseRoute(route)).toBe(true)
  const stale = marks.routeToken(route)!
  expect(marks.refuseRoute(route)).toBe(true)
  const newer = marks.routeToken(route)!
  expect(marks.clearRoute(route, stale)).toEqual({ changed: false, ok: false })
  expect([storage.getItem(refusedKey), storage.getItem(clearedKey), marks.hasRouteDenial(route)]).toEqual([newer, fenced, true])
  // Nothing fenced: nothing is written, and nothing is in the way.
  expect(marks.clearRoute(route, undefined)).toEqual({ changed: false, ok: true })
  // Storage that cannot be read writes nothing it can say, and fails closed.
  const unreadable = Marks.make({ ...host, storage: { ...storage, getItem: () => { throw new DOMException("denied", "SecurityError") } } })
  expect(unreadable.clearRoute(route, newer)).toEqual({ changed: false, ok: false })
  expect(storage.getItem(clearedKey)).toBe(fenced)
  // Undone in the same turn: the clear goes back to the one before it, and the branch is refused again.
  expect(marks.clearRoute(route, newer)).toEqual({ changed: true, ok: true, prevCleared: fenced })
  expect(marks.hasRouteDenial(route)).toBe(false)
  expect(marks.restoreRoute(route, fenced)).toBe(true)
  expect([storage.getItem(clearedKey), marks.routeToken(route)]).toEqual([fenced, newer])
  expect(marks.clearRoute(route, newer)).toMatchObject({ changed: true })
  expect(marks.restoreRoute(route, null)).toBe(true)
  expect([storage.entries.has(clearedKey), marks.routeToken(route)]).toEqual([false, newer])
})

test("a branch clear whose write the storage refuses is no clear: it reports nothing changed and not ok", () => {
  const { storage, host } = device()
  const route = "github/octo/hello\0topic"
  const clearedKey = Marks.routeClearedKey("ada", route)
  const marks = Marks.make(host)
  expect(marks.refuseRoute(route)).toBe(true)
  const fenced = marks.routeToken(route)!
  const steps: Array<boolean> = []
  const failing = Marks.make({
    ...host,
    storage: {
      ...storage,
      get length() { return storage.length },
      getItem: (key) => {
        steps.push(marks.hasRouteDenial(route))
        return storage.getItem(key)
      },
      setItem: (key, value) => {
        steps.push(marks.hasRouteDenial(route))
        if (key === clearedKey) throw new DOMException("full", "QuotaExceededError")
        storage.setItem(key, value)
      },
    },
  })
  expect(failing.clearRoute(route, fenced)).toEqual({ changed: false, ok: false })
  expect(steps).toEqual([true, true, true])
  expect([storage.entries.has(clearedKey), marks.hasRouteDenial(route), marks.routeToken(route)]).toEqual([false, true, fenced])
})

/** Storage that refuses `failing` on `key` alone, and does everything else. */
const refusing = (storage: ReturnType<typeof webStorage>, key: string, failing: ReadonlyArray<"setItem" | "removeItem">) => ({
  ...storage,
  get length() {
    return storage.length
  },
  setItem: (written: string, value: string) => {
    if (written === key && failing.includes("setItem")) throw new DOMException("full", "QuotaExceededError")
    storage.setItem(written, value)
  },
  removeItem: (removed: string) => {
    if (removed === key && failing.includes("removeItem")) throw new DOMException("blocked", "SecurityError")
    storage.removeItem(removed)
  },
})

/** A branch refused, cleared, refused again and cleared again: the clear `restoreRoute` undoes names `earlier`. */
const twiceCleared = () => {
  const { storage, host } = device()
  const route = "github/octo/hello\0topic"
  const clearedKey = Marks.routeClearedKey("ada", route)
  const marks = Marks.make(host)
  expect(marks.refuseRoute(route)).toBe(true)
  const earlier = marks.routeToken(route)!
  expect(marks.clearRoute(route, earlier)).toMatchObject({ changed: true })
  expect(marks.refuseRoute(route)).toBe(true)
  const fenced = marks.routeToken(route)!
  expect(marks.clearRoute(route, fenced)).toEqual({ changed: true, ok: true, prevCleared: earlier })
  expect(marks.hasRouteDenial(route)).toBe(false)
  return { storage, host, route, clearedKey, marks, earlier, fenced }
}

test("an undone clear the storage will not write back removes the cleared key: the refusal it lifted denies the branch again, and no refusal is written", () => {
  const { storage, host, route, clearedKey, marks, earlier, fenced } = twiceCleared()
  const told: Array<unknown> = []
  const stop = marks.subscribe((denial) => told.push(denial))
  expect(Marks.make({ ...host, storage: refusing(storage, clearedKey, ["setItem"]) }).restoreRoute(route, earlier)).toBe(true)
  stop()
  // No cleared token: the refused token, unequal to none, is the branch's refusal, and every tab is told.
  expect([storage.getItem(clearedKey), marks.routeToken(route), marks.hasRouteDenial(route)]).toEqual([null, fenced, true])
  expect(told).toEqual([undefined])
  // Storage over its quota still removes: it takes no write, and the branch is denied all the same.
  expect(marks.clearRoute(route, fenced)).toEqual({ changed: true, ok: true, prevCleared: null })
  expect(Marks.make({ ...host, storage: full(storage) }).restoreRoute(route, earlier)).toBe(true)
  expect([storage.getItem(clearedKey), marks.routeToken(route), marks.hasRouteDenial(route)]).toEqual([null, fenced, true])
})

test("an undone clear the storage will neither write back nor remove refuses the branch again, and storage that takes nothing says it kept none", () => {
  const { storage, host, route, clearedKey, marks, earlier, fenced } = twiceCleared()
  expect(Marks.make({ ...host, storage: refusing(storage, clearedKey, ["setItem", "removeItem"]) }).restoreRoute(route, earlier)).toBe(true)
  const again = marks.routeToken(route)
  expect(again).toMatch(/^[0-9a-f]{16}$/)
  expect([again === fenced, again === earlier, storage.getItem(clearedKey), marks.hasRouteDenial(route)]).toEqual([false, false, fenced, true])
  expect(marks.clearRoute(route, again!)).toMatchObject({ changed: true })
  const locked = { ...full(storage), removeItem: () => { throw new DOMException("blocked", "SecurityError") } }
  expect(Marks.make({ ...host, storage: locked }).restoreRoute(route, fenced)).toBe(false)
  expect(marks.hasRouteDenial(route)).toBe(false)
})

/** The three storage steps of `clearRoute`, by name. */
const CLEAR_STEPS = ["get refused", "get cleared", "set cleared"] as const

test.each(CLEAR_STEPS.map((_, at) => at))("a sibling refusal written lockless before clear step %i is seen by every read from its write on, and no surviving open key admits a row", (at) => {
  const { storage, host } = device()
  const route = "github/octo/hello\0topic"
  const [refusedKey, clearedKey] = [Marks.routeRefusedKey("ada", route), Marks.routeClearedKey("ada", route)]
  const observer = Marks.make(host)
  const sibling = Marks.make(host)
  expect(sibling.refuseRoute(route)).toBe(true)
  const fenced = sibling.routeToken(route)!
  // Another tab's open grant survives the clear: only the branch refusal stands between it and a row.
  observer.grant(first.conversationId)
  const admits = () => observer.granted(first.conversationId) && !observer.hasRouteDenial(route)
  const seen: Array<{ readonly step: string; readonly denied: boolean; readonly admits: boolean }> = []
  const observe = (step: string) => seen.push({ step, denied: observer.hasRouteDenial(route), admits: admits() })
  let raced: string | null = null
  let step = 0
  const named = (key: string) => key === refusedKey ? "refused" : key === clearedKey ? "cleared" : "epoch"
  const racing = Marks.make({
    ...host,
    storage: {
      ...storage,
      get length() { return storage.length },
      setItem: (key, value) => {
        storage.setItem(key, value)
        observe(`sibling set ${named(key)}`)
      },
    },
  })
  const before = () => {
    if (step++ !== at) return
    expect(racing.refuseRoute(route)).toBe(true)
    raced = storage.getItem(refusedKey)
  }
  const clearing = Marks.make({
    ...host,
    storage: {
      ...storage,
      get length() { return storage.length },
      getItem: (key) => {
        before()
        const value = storage.getItem(key)
        observe(`clear get ${named(key)}`)
        return value
      },
      setItem: (key, value) => {
        before()
        storage.setItem(key, value)
        observe(`clear set ${named(key)}`)
      },
      removeItem: (key) => {
        before()
        storage.removeItem(key)
        observe(`clear remove ${named(key)}`)
      },
    },
  })
  const result = clearing.clearRoute(route, fenced)
  expect(raced).toMatch(/^[0-9a-f]{16}$/)
  expect(raced).not.toBe(fenced)
  // The clear never removes the refusal's key, and writes nothing but the fenced token as cleared.
  expect(seen.map(({ step }) => step).filter((name) => name.startsWith("clear"))).toEqual(CLEAR_STEPS.slice(0, at === 0 ? 2 : 3).map((name) => `clear ${name}`))
  expect(seen.every(({ denied, admits }) => denied && !admits)).toBe(true)
  expect(result).toEqual(at === 0 ? { changed: false, ok: false } : { changed: true, ok: true, prevCleared: null })
  expect([storage.getItem(refusedKey), observer.hasRouteDenial(route), observer.routeToken(route)]).toEqual([raced, true, raced])
})
