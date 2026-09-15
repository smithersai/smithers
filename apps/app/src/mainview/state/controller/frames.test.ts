import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import type { FrameHistoryPort, FrameLocation } from "../../runtime/FrameHistory"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { cardFrameId, DEFAULT_BRANCH_ID, DEFAULT_WORKSPACE_ID, initialGuide, rootFrameId } from "../AppState"

const storage = (): StorageApi => {
  const rows = new Map<string, string>()
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => void rows.set(key, value),
    removeItem: (key) => void rows.delete(key)
  }
}

const repositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "native only" })
}

const agent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const memoryHistory = (): FrameHistoryPort & { readonly value: () => FrameLocation | undefined } => {
  const entries: FrameLocation[] = []
  let index = -1
  const listeners = new Set<(location: FrameLocation | undefined) => void>()
  const publish = (): void => {
    for (const listener of listeners) listener(entries[index])
  }
  return {
    value: () => entries[index],
    current: () => entries[index],
    replace: (location) => {
      if (index < 0) {
        entries.push(location)
        index = 0
      } else entries[index] = location
    },
    push: (location) => {
      entries.splice(index + 1)
      entries.push(location)
      index = entries.length - 1
    },
    back: () => {
      if (index > 0) index -= 1
      publish()
    },
    forward: () => {
      if (index < entries.length - 1) index += 1
      publish()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("durable frame navigation", () => {
  for (const signOut of [false, true]) test(signOut
    ? "sign-out suppresses a late fork completion even when its root branch survives"
    : "the shared fork flow publishes its address and completion only after the fork receipt", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: storage() })
    await store.dispatch({ type: "guide.changed", actor: "system", guide: { ...initialGuide(), finished: true } }).isPersisted.promise
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const history = memoryHistory()
    const controller = createAppController({ ...store, dispatch: transition => {
      const transaction = store.dispatch(transition)
      if (transition.type !== "frame.forked") return transaction
      entered()
      return new Proxy(transaction, { get: (target, property, receiver) => property === "isPersisted"
        ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held) }
        : Reflect.get(target, property, receiver) })
    } }, repositories, agent, { frameHistory: history })
    const original = history.value()
    const pending = controller.commands.run("frame.fork")
    try {
      await started
      expect(history.value()).toEqual(original)
      expect(store.collections.toasts.get("toast-frame.fork")).toBeUndefined()
      expect([...store.collections.commandIntents.values()].find(row => row.name === "frame.fork"))
        .toMatchObject({ actor: "user", status: "accepted" })
      if (signOut) {
        const fork = store.session().activeBranchId
        await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
        // Privacy drops the branch's private snapshot but retains its root address.
        expect(store.session().activeBranchId).toBe(fork)
        expect(store.session().activeFrameId).toBe(rootFrameId(fork!))
      }
      release()
      expect(await pending).toMatchObject({ status: "executed" })
      if (signOut) {
        expect(history.value()).toEqual(original)
        expect(store.collections.toasts.get("toast-frame.fork")).toBeUndefined()
      } else {
        expect(history.value()?.branchId).not.toBe(original?.branchId)
        expect(store.collections.toasts.get("toast-frame.fork")).toMatchObject({ title: "Created Fork 1", status: "ok" })
      }
      expect((await store.verifyState()).valid).toBe(true)
    } finally {
      release()
      await pending
      await controller.dispose()
    }
  })

  test("a failed fork commit preserves its original branch and emits no successful address or notice", async () => {
    const bytes = storage()
    let refuse = false
    const host: StorageApi = { ...bytes, setItem: (key, value) => {
      if (refuse) throw new Error("fork persistence refused")
      bytes.setItem(key, value)
    } }
    const store = await createAppStore({ kind: "localStorage", storage: host })
    await store.dispatch({ type: "guide.changed", actor: "system", guide: { ...initialGuide(), finished: true } }).isPersisted.promise
    const history = memoryHistory()
    const controller = createAppController({ ...store, dispatch: transition => {
      if (transition.type === "frame.forked") refuse = true
      return store.dispatch(transition)
    } }, repositories, agent, { frameHistory: history })
    const original = history.value()
    try {
      expect(await controller.commands.run("frame.fork")).toMatchObject({ status: "failed", persistenceFailed: true })
      expect(history.value()).toEqual(original)
      expect(store.session().activeBranchId).toBe(DEFAULT_BRANCH_ID)
      expect(store.collections.branches.size).toBe(1)
      expect(store.collections.toasts.get("toast-frame.fork")).toBeUndefined()
    } finally {
      await Promise.resolve(controller.dispose()).catch(() => {})
    }
    refuse = false
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    try {
      expect(reopened.session().activeBranchId).toBe(DEFAULT_BRANCH_ID)
      expect(reopened.collections.branches.size).toBe(1)
      expect(reopened.collections.toasts.get("toast-frame.fork")).toBeUndefined()
      expect((await reopened.verifyState()).valid).toBe(true)
    } finally { await reopened.dispose?.() }
  })

  test("forked cards, messages and world notes are independent and survive branch switching and reload", async () => {
    const host = storage()
    const history = memoryHistory()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const controller = createAppController(store, repositories, agent, { frameHistory: history })
    const card = { id: "fork-content", kind: "status" as const, title: "Original", status: "active" as const,
      createdAt: 1, ordinal: 0, payload: { progress: 0.5 } }
    await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    controller.maximizeCard(card.id)
    await settle()
    const originalLocation = history.value()!
    await controller.forkFrame()
    await settle()
    const forkLocation = history.value()!
    expect([...store.collections.toasts.values()]).toContainEqual(expect.objectContaining({ title: "Created Fork 1", status: "ok" }))
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: "fork-turn", text: "Fork message" }).isPersisted.promise
    await store.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "fork-turn" }).isPersisted.promise
    await store.dispatch({ type: "card.updated", actor: "user", id: card.id, patch: { title: "Fork only" } }).isPersisted.promise
    await store.dispatch({ type: "world.document.upserted", actor: "user", document: {
      id: "fork-note", path: "fork.md", title: "Fork note", body: "Private to fork", links: [], tags: [], sources: [],
      confidence: 1
    } }).isPersisted.promise
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "Fork draft" }).isPersisted.promise
    controller.frameBack()
    await settle()
    expect(store.session().activeBranchId).toBe(originalLocation.branchId)
    expect(store.collections.cards.get(card.id)?.title).toBe("Original")
    expect(store.collections.worldDocuments.get("fork-note")).toBeUndefined()
    expect(store.collections.messages.get("message-fork-turn-user")).toBeUndefined()
    expect(store.session().selectedWorldDocumentId).toBe("world-home")
    expect(store.session().draft).toBe("")
    controller.frameForward()
    await settle()
    expect(store.session().activeBranchId).toBe(forkLocation.branchId)
    expect(store.collections.cards.get(card.id)?.title).toBe("Fork only")
    expect(store.collections.worldDocuments.get("fork-note")?.body).toBe("Private to fork")
    expect(store.collections.messages.get("message-fork-turn-user")?.text).toBe("Fork message")
    expect(store.session().selectedWorldDocumentId).toBe("fork-note")
    expect(store.session().draft).toBe("Fork draft")
    controller.dispose()
    const restored = await createAppStore({ kind: "localStorage", storage: host })
    const resumed = createAppController(restored, repositories, agent, { frameHistory: history })
    resumed.frameBack()
    await settle()
    expect(restored.collections.cards.get(card.id)?.title).toBe("Original")
    resumed.frameForward()
    await settle()
    await restored.dispatch({ type: "conversation.reset", actor: "user" }).isPersisted.promise
    resumed.frameBack()
    await settle()
    expect(restored.session().activeBranchId).toBe(originalLocation.branchId)
    expect(restored.collections.cards.get(card.id)?.title).toBe("Original")
    resumed.dispose()
  })
  test("forking a historical card starts at its recorded world revision", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: storage() })
    const controller = createAppController(store, repositories, agent, { frameHistory: memoryHistory() })
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "historical", kind: "status", title: "Earlier", status: "active",
      createdAt: 1, ordinal: 0, payload: { progress: 0.5 }
    } }).isPersisted.promise
    controller.maximizeCard("historical")
    await settle()
    const source = store.collections.frames.get(cardFrameId(DEFAULT_BRANCH_ID, "historical"))!
    controller.minimizeCard()
    await settle()
    await store.dispatch({ type: "world.document.upserted", actor: "user", document: {
      id: "later", path: "later.md", title: "Later", body: "Written after the frame", links: [], tags: [], sources: [], confidence: 1
    } }).isPersisted.promise
    controller.frameBack()
    await settle()
    await controller.forkFrame()
    await settle()
    expect(store.collections.branches.get(store.session().activeBranchId!)?.forkedAtRevision).toBe(source.stateRevision)
    expect(store.collections.worldDocuments.get("later")).toBeUndefined()
    controller.frameBack()
    await settle()
    expect(store.collections.worldDocuments.get("later")?.body).toBe("Written after the frame")
    controller.dispose()
  })
  test("maximizes, traverses browser history, forks immutably, and restores a deep link", async () => {
    const host = storage()
    const history = memoryHistory()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const controller = createAppController(store, repositories, agent, { frameHistory: history })
    const card = {
      id: "status-1",
      kind: "status" as const,
      title: "Status",
      status: "active" as const,
      createdAt: 1,
      ordinal: 0,
      payload: { progress: 0.5 }
    }
    await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise

    expect(history.value()).toEqual({
      workspaceId: DEFAULT_WORKSPACE_ID,
      branchId: DEFAULT_BRANCH_ID,
      frameId: rootFrameId(DEFAULT_BRANCH_ID)
    })
    controller.maximizeCard(card.id)
    await settle()
    const mainFrameId = cardFrameId(DEFAULT_BRANCH_ID, card.id)
    expect(store.session().activeFrameId).toBe(mainFrameId)
    expect(store.session().maximizedCardId).toBe(card.id)
    expect(history.value()?.frameId).toBe(mainFrameId)

    controller.frameBack()
    await settle()
    expect(store.session().activeFrameId).toBe(rootFrameId(DEFAULT_BRANCH_ID))
    expect(store.session().maximizedCardId).toBeNull()
    controller.frameForward()
    await settle()
    expect(store.session().activeFrameId).toBe(mainFrameId)

    const original = structuredClone(store.collections.frames.get(mainFrameId))
    await controller.forkFrame()
    await settle()
    const forkLocation = history.value()
    expect(forkLocation?.branchId).not.toBe(DEFAULT_BRANCH_ID)
    expect(store.collections.branches.get(forkLocation!.branchId)).toMatchObject({
      parentBranchId: DEFAULT_BRANCH_ID,
      forkedFromFrameId: mainFrameId,
      forkedAtRevision: original?.stateRevision
    })
    expect(store.collections.frames.get(mainFrameId)).toEqual(original)
    expect(store.session().activeFrameId).toBe(forkLocation?.frameId)

    controller.dispose()
    const restored = await createAppStore({ kind: "localStorage", storage: host })
    // Simulate the durable store restoring at root while the address bar keeps
    // the forked frame; controller boot must choose the valid deep link.
    await restored.dispatch({ type: "card.minimized", actor: "user" }).isPersisted.promise
    const restoredController = createAppController(restored, repositories, agent, { frameHistory: history })
    await settle()
    expect(restored.session().activeBranchId).toBe(forkLocation?.branchId)
    expect(restored.session().activeFrameId).toBe(forkLocation?.frameId)
    expect(restored.session().maximizedCardId).toBe(card.id)
    restoredController.dispose()
  })
  test("open-in-tab returns the address bar to the root frame, so a reload does not re-maximize the card", async () => {
    const host = storage()
    const history = memoryHistory()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const controller = createAppController(store, repositories, agent, { frameHistory: history })
    const card = {
      id: "status-2",
      kind: "status" as const,
      title: "Status",
      status: "active" as const,
      createdAt: 1,
      ordinal: 0,
      payload: { progress: 0.5 }
    }
    await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    controller.maximizeCard(card.id)
    await settle()
    expect(history.value()?.frameId).toBe(cardFrameId(DEFAULT_BRANCH_ID, card.id))

    controller.openCardTab(card.id)
    await settle()
    expect(store.session().activeTabId).toBe(`card-${card.id}`)
    expect(store.session().maximizedCardId).toBeNull()
    expect(store.session().activeFrameId).toBe(rootFrameId(DEFAULT_BRANCH_ID))
    expect(history.value()?.frameId).toBe(rootFrameId(DEFAULT_BRANCH_ID))

    // Opening the tab of an already-embedded card leaves the frame alone.
    controller.openCardTab(card.id)
    await settle()
    expect(history.value()?.frameId).toBe(rootFrameId(DEFAULT_BRANCH_ID))
    controller.dispose()
  })
})
