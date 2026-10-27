import { dom } from "./fixtures/dom"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, expect, test, vi } from "vitest"
import { Auth } from "../src/features/auth/auth"
import { AuthStore, SESSION } from "../src/features/auth/store"
import { AuthProvider } from "../src/features/auth/components/AuthContext"
import { Attention } from "../src/features/attention/attention"
import { AttentionProvider } from "../src/features/attention/components/AttentionContext"
import { PersonalModel } from "../src/features/personal-model/personalModel"
import { PersonalModelProvider } from "../src/features/personal-model/components/PersonalModelContext"
import { PersonalModelSettings } from "../src/features/personal-model/components/PersonalModelSettings"
import { Toasts } from "../src/screens/app/Toasts"
import { openTab, openTestApp, TestChatApi } from "../src/test/chatApi"

Object.assign(globalThis, { self: dom, HTMLFormElement: dom.HTMLFormElement, HTMLSelectElement: dom.HTMLSelectElement, DocumentFragment: dom.DocumentFragment, MutationObserver: dom.MutationObserver, CustomEvent: dom.CustomEvent, scrollTo: dom.scrollTo.bind(dom) })
afterAll(() => dom.happyDOM.close())

test("a saved model failure stays in Settings without following the person onto other pages", async () => {
  const server = openTestApp({ answers: false })
  const api = await server.runPromise(Effect.service(TestChatApi))
  const app = openTab(api, { answers: false })
  const container = document.createElement("div")
  document.body.append(container)
  const view = createRoot(container)
  try {
    // A display fixture in real Postgres, read through the real authenticated Electric shape.
    // No model call reads these sealed-key fields in this test.
    await server.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, sql => sql`
      INSERT INTO personal_models (person_id, protocol, base_url, fast_model, ciphertext, nonce, key_version, key_last4, failure_status, failed_at)
      VALUES ('person-member', 'openai-chat', 'https://models.example.com', 'display-test', 'unused', 'unused', 1, 'test', 402, now())`)))
    const model = await app.runPromise(Effect.service(PersonalModel))
    const auth = await app.runPromise(Effect.service(Auth))
    const attention = await app.runPromise(Effect.service(Attention))
    const { session } = await app.runPromise(Effect.service(AuthStore))
    await vi.waitFor(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"), { timeout: 40_000 })
    await app.runPromise(session.update(SESSION, row => { Object.assign(row, { status: "signed_in", login: "member", role: "member" }) }))
    model.queries.saved.startSyncImmediate()
    await vi.waitFor(() => expect(model.queries.saved.toArray[0]?.failureStatus).toBe(402), { timeout: 40_000 })
    const root = createRootRoute()
    const repo = createRoute({ getParentRoute: () => root, path: "/repo", component: () => createElement(Toasts, { surface: "page" }) })
    const chat = createRoute({ getParentRoute: () => root, path: "/chat", component: Toasts })
    const settings = createRoute({ getParentRoute: () => root, path: "/settings", component: () => createElement(PersonalModelSettings, { canSave: true }) })
    const router = createRouter({ isServer: false, routeTree: root.addChildren([repo, chat, settings]), history: createMemoryHistory({ initialEntries: ["/repo"] }) })
    await act(async () => {
      await router.load()
      view.render(createElement(AuthProvider, { value: auth },
        createElement(AttentionProvider, { value: attention },
          createElement(PersonalModelProvider, { value: model }, createElement(RouterProvider, { router })))))
    })
    expect(container.querySelectorAll("[data-personal-model]")).toHaveLength(0)
    expect(container.textContent).not.toContain("HTTP 402")
    await act(async () => { await router.navigate({ to: "/chat" }) })
    expect(container.querySelectorAll("[data-personal-model]")).toHaveLength(0)
    await act(async () => { await router.navigate({ to: "/settings" }) })
    await vi.waitFor(() => expect(container.textContent).toContain("models.example.com refused · HTTP 402"))
    expect(container.textContent?.match(/HTTP 402/g)).toHaveLength(1)
  } finally {
    await act(async () => view.unmount())
    container.remove()
    await app.dispose()
    await server.dispose()
  }
}, 120_000)
