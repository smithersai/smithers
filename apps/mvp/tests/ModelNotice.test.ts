import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
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
import { syncModelNotice } from "../src/features/attention/modelNotice"
import { AttentionStore } from "../src/features/attention/store"
import { MODEL_NOTICE } from "../src/features/attention/contract"
import { PersonalModel } from "../src/features/personal-model/personalModel"
import { PersonalModelProvider } from "../src/features/personal-model/components/PersonalModelContext"
import { read } from "../src/test/otlp"
import { nodeDevice, openTestApp, TestChatApi } from "../src/test/chatApi"

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 40_000, interval: 20 })

test("a conversation without a model has one overlay CTA; Hide survives navigation and adding a model resolves it", async () => {
  const host = nodeDevice()
  const app = openTestApp({ answers: false, host })
  try {
    const api = await app.runPromise(Effect.service(TestChatApi))
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
      expect(out.slice(out.indexOf('<section aria-label="Conversation">'))).not.toContain("Add your model</")
      expect(out).toContain('data-placement="anchored"')
      expect(out).toContain("Open settings")
      expect(out.match(/data-add-model=/g)).toHaveLength(1)
      expect(out).toContain("Existing conversation")
      expect(out).not.toContain("<textarea")
    })
    const notice = attention.queries.stackHere.toArray.find(row => row.word === "Add your model")!
    attention.actions.open(notice.id, "conversation")
    expect(host.navigated).toContain("/app/settings")
    attention.actions.hide(notice.id)
    await until(() => expect(html()).not.toContain("Open settings"))
    await app.runPromise(store.session.update(SESSION, row => { row.restored = true }))
    await until(() => expect(html()).not.toContain("Open settings"))
    // A resolved condition rearms a later need, while repeated true observations preserve Hide.
    await app.runPromise(syncModelNotice(false))
    await app.runPromise(syncModelNotice(true))
    await until(() => expect(html()).toContain("Open settings"))
    // Real Postgres and Electric metadata, no credential or provider call needed to establish routing readiness.
    await app.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, sql => sql`
      INSERT INTO personal_models (person_id, kind, protocol, base_url, fast_model, ciphertext, nonce, key_version, key_last4)
      VALUES ('person-member', 'api_key', 'openai-chat', 'https://models.example.com', 'notice-test', 'unused', 'unused', 1, 'test')`)))
    await until(() => expect(html()).toContain("<textarea"))
    await until(() => expect(html()).not.toContain("Open settings"))
    const attentionStore = await app.runPromise(Effect.service(AttentionStore))
    expect(attentionStore.launches.tanstack.get(MODEL_NOTICE)).toBeUndefined()
    attention.actions.hide(MODEL_NOTICE) // A stale Hide after resolution is harmless.
    await app.runPromise(syncModelNotice(false))
    await app.dispose()
    const records = read(api.telemetry)
    expect(records.log("notifications.model").map(line => line.attributes.act)).toEqual(expect.arrayContaining(["open", "hide", "resolved"]))
    expect(records.log("notifications.shown").map(line => line.attributes.subject)).toContain(MODEL_NOTICE)
    expect(JSON.stringify(records.log("notifications.model"))).not.toContain("notice-test")
  } finally {
    await app.dispose()
  }
}, 120_000)
