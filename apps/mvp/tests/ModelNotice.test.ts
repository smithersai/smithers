import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test, vi } from "vitest"
import { Auth } from "../src/features/auth/auth"
import { AuthProvider } from "../src/features/auth/components/AuthContext"
import { ComposerGate } from "../src/features/auth/components/ComposerGate"
import { AuthStore, SESSION } from "../src/features/auth/store"
import { Attention } from "../src/features/attention/attention"
import { AttentionProvider } from "../src/features/attention/components/AttentionContext"
import { Notices } from "../src/features/attention/components/Notices"
import { PersonalModel } from "../src/features/personal-model/personalModel.vibe"
import { PersonalModelProvider } from "../src/features/personal-model/components/PersonalModelContext"
import { nodeDevice, openTestApp } from "../src/test/chatApi"

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 40_000, interval: 20 })

test("a conversation with hosted inference off retains its composer", async () => {
  const host = nodeDevice()
  const app = openTestApp({ answers: false, host })
  try {
    const auth = await app.runPromise(Effect.service(Auth))
    const attention = await app.runPromise(Effect.service(Attention))
    const model = await app.runPromise(Effect.service(PersonalModel))
    const store = await app.runPromise(Effect.service(AuthStore))
    for (const query of [auth.queries.session, auth.queries.confirmed, attention.queries.stackHere, model.queries.saved]) query.startSyncImmediate()
    await until(() => expect(auth.queries.session.toArray[0]?.status).toBe("signed_in"))
    await app.runPromise(store.session.update(SESSION, row => { row.hostedModel = false }))
    const root = createRootRoute({ component: () => createElement("main", null,
      createElement("header", null, createElement(Notices, { surface: "conversation" })),
      createElement("section", { "aria-label": "Conversation" }, "Existing conversation",
        createElement(ComposerGate, null, createElement("textarea")))) })
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/app"] }) })
    await router.load()
    const html = () => renderToStaticMarkup(createElement(AuthProvider, { value: auth },
      createElement(AttentionProvider, { value: attention }, createElement(PersonalModelProvider, { value: model },
        createElement(RouterProvider, { router })))))
    await until(() => {
      const out = html()
      expect(out).toContain("Existing conversation")
      expect(out).toContain("<textarea")
      expect(out).not.toContain("Add your model")
    })
  } finally {
    await app.dispose()
  }
}, 120_000)
