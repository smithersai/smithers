import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, unavailableAgent } from "../state/TestFixtures"
import { AccountCardBody } from "./AccountCard"

GlobalRegistrator.register()
afterAll(async () => { await GlobalRegistrator.unregister() })
const createController = scopedControllers()

for (const provider of ["local", "github"] as const) {
  test(`${provider} account reports only its provider and survives reload`, async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const paths: string[] = []
    const controller = createController(store, unavailableAgent, {
      ...(provider === "local" ? {
        applicationTarget: resolveApplicationTarget({ apiVersion: 1, mode: "web-selfhost", apiOrigin: "", auth: { kind: "session" }, cors: "same-origin", developerExternal: false }, "https://owner.test"),
        localIdentity: {
          status: async () => ({ enabled: true, initialized: true }),
          login: async ({ username }: { username: string }) => ({ user: { id: 1, username } }),
          bootstrap: async ({ username }: { username: string }) => ({ user: { id: 1, username } })
        }
      } : { bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }), authFlow: "redirect", sandbox: null } }),
      fetchImpl: async input => {
        const path = new URL(String(input), "https://owner.test").pathname
        paths.push(path)
        return path === "/api/auth/scopes"
          ? Response.json({ scopes: [{ scope: "contents:read", plain: "Read repository files" }] })
          : new Response(null, { status: 404 })
      }
    })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const result = await controller.showAccount()
    await store.settled?.()
    expect(paths.includes("/api/auth/scopes")).toBe(provider === "github")
    expect(JSON.stringify(result).includes("GitHub")).toBe(provider === "github")
    const restored = await createAppStore({ kind: "localStorage", storage })
    try {
      const card = restored.collections.cards.get("account")!
      if (card.kind !== "account") throw new Error("Missing account card")
      expect(card.payload).toMatchObject({ provider, login: "owner" })
      const html = renderToStaticMarkup(<AccountCardBody card={card} onRunCommand={() => {}} />)
      expect(html.includes("GitHub")).toBe(provider === "github")
      expect(html.includes("read:user")).toBe(provider === "github")
      expect(html).toContain('data-flow="auth.sign-out"')
    } finally { await restored.dispose?.() }
  })
}

test("legacy account cards without provider evidence do not claim GitHub authorization", () => {
  const html = renderToStaticMarkup(<AccountCardBody card={{ id: "account", kind: "account", title: "Account", status: "active", createdAt: 1, ordinal: 1,
    payload: { login: "owner", allowlisted: true, accessRequested: false, scopes: [], boxes: [] } }} onRunCommand={() => {}} />)
  expect(html).not.toContain("GitHub")
  expect(html).not.toContain("read:user")
  expect(html).toContain("owner")
})
