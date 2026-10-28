import { dom } from "./fixtures/dom"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { act, createElement, Fragment } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, expect, test, vi } from "vitest"
import { ChatProvider } from "../src/AppContext"
import { Chat } from "../src/features/chat/chat"
import { COMMIT_UNAVAILABLE, COPY_DRAFT, FLOW_UNAVAILABLE } from "../src/features/chat/engineAvailability"
import { FlowsUi } from "../src/features/flows-ui/flowsUi"
import { FlowsUiStore } from "../src/features/flows-ui/store"
import { FlowsUiProvider } from "../src/features/flows-ui/components/FlowsUiContext"
import { FlowCodeCard } from "../src/features/flows-ui/components/FlowCodeCard"
import { Todos } from "../src/features/todos/todos"
import { TodosStore } from "../src/features/todos/store"
import { TodosProvider } from "../src/features/todos/components/TodosContext"
import { DraftCard } from "../src/features/todos/components/DraftCard"
import { failingWorker, idleWorker, nodeDevice, openTestApp, TestChatApi } from "../src/test/chatApi"

Object.assign(globalThis, { self: dom, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver })
afterAll(() => dom.happyDOM.close())

test("storage refusal leaves a recoverable draft, disables Commit, and explains an unreadable flow", async () => {
  const host = nodeDevice({ engineWorker: failingWorker })
  const app = openTestApp({ sessionLifecycle: false, host: {
    ...host,
    persistence: { ...host.persistence, open: () => { throw new DOMException("test storage refusal", "SecurityError") } },
  } })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    const { chat, flows, todos, store } = await app.runPromise(Effect.all({
      chat: Effect.service(Chat), flows: Effect.service(FlowsUi), todos: Effect.service(Todos), store: Effect.service(TodosStore),
    }))
    chat.queries.connection.startSyncImmediate()
    await vi.waitFor(() => expect(chat.queries.connection.toArray[0]?.status).toBe("stopped"))
    await flows.actions.openCode("existing-flow")
    const id = todos.actions.newDraft("octo", "hello")
    todos.actions.setTitle(id, "Keep this title")
    todos.actions.setPrompt(id, "Keep this prompt")
    const draft = Option.getOrThrow(await app.runPromise(store.drafts.get(id)))
    const parent = createRootRoute()
    const route = createRoute({ getParentRoute: () => parent, path: "/", component: () =>
      createElement(Fragment, null, createElement(FlowCodeCard), createElement(DraftCard, { draft })) })
    const router = createRouter({ isServer: false, routeTree: parent.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) })
    await act(async () => {
      await router.load()
      root.render(createElement(ChatProvider, { value: chat }, createElement(FlowsUiProvider, { value: flows },
        createElement(TodosProvider, { value: todos }, createElement(RouterProvider, { router })))))
    })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.textContent).toContain(FLOW_UNAVAILABLE)
      expect(container.textContent).toContain(COMMIT_UNAVAILABLE)
      expect(container.textContent).toContain(COPY_DRAFT)
    })
    const form = container.querySelector("form")!
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    expect(form.querySelector<HTMLInputElement>("input")!.disabled).toBe(false)
    expect(form.querySelector<HTMLInputElement>("input")!.value).toBe("Keep this title")
    await act(async () => {
      form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }))
      form.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }))
    })
    expect(Option.getOrThrow(await app.runPromise(store.drafts.get(id))).title).toBe("Keep this title")
    expect(await app.runPromise(store.requested.toArray)).toEqual([])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await app.dispose()
  }
}, 60_000)

test("a restored code editor warns about reload loss after the engine fails, and keeps newer input", async () => {
  let stop = () => {}
  const host = nodeDevice({ engineWorker: () => ({
    ...idleWorker(),
    addEventListener: (type: string, listener: (event: ErrorEvent) => void) => {
      if (type === "error") stop = () => listener({} as ErrorEvent)
    },
  }) as never })
  const app = openTestApp({ sessionLifecycle: false, host })
  let closeFlows = async () => {}
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    const { chat, api } = await app.runPromise(Effect.all({ chat: Effect.service(Chat), api: Effect.service(TestChatApi) }))
    const runtime = ManagedRuntime.make(FlowsUi.layer.pipe(Layer.provideMerge(FlowsUiStore.layer({
      origin: api.origin, editorTabId: host.editorTabId, editorTabPersistent: true,
    }).pipe(Layer.provideMerge(Layer.succeedContext(await app.context()))))))
    closeFlows = () => runtime.dispose()
    const { flows, store } = await runtime.runPromise(Effect.all({ flows: Effect.service(FlowsUi), store: Effect.service(FlowsUiStore) }))
    expect(await runtime.runPromise(store.editorReady)).toBe(true)
    await runtime.runPromise(Effect.flatMap(store.code.update(store.codeId, row => Object.assign(row, {
      name: "retained-flow", state: "read", revision: 1, source: "retained source", text: "retained source", busy: false, refusal: null,
    })), write => write.persisted))
    const parent = createRootRoute()
    const route = createRoute({ getParentRoute: () => parent, path: "/", component: FlowCodeCard })
    const router = createRouter({ isServer: false, routeTree: parent.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) })
    await act(async () => {
      await router.load()
      root.render(createElement(ChatProvider, { value: chat }, createElement(FlowsUiProvider, { value: flows }, createElement(RouterProvider, { router }))))
    })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelector("textarea")?.value).toBe("retained source")
    })
    await act(async () => { stop() })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.textContent).toContain(COPY_DRAFT)
    })
    await act(async () => { flows.actions.editCode("retained-flow", "newer edit") })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelector("textarea")?.value).toBe("newer edit")
    })
    expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true)
    expect(container.querySelector(".flows-code")?.getAttribute("data-draft")).toBe("unsaved")
    expect(container.textContent).toContain(FLOW_UNAVAILABLE)
    expect(flows.queries.editor.toArray[0]?.state).toBe("available")
    // Losing the engine during an unfinished read must not leave an empty page.
    await act(async () => { await runtime.runPromise(store.code.update(store.codeId, row => { row.state = "loading" })) })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.textContent).toContain(FLOW_UNAVAILABLE)
    })
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await closeFlows()
    await app.dispose()
  }
}, 60_000)
