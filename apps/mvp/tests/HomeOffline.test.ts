import { createElement } from "react"
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { expect, test, vi } from "vitest"
import { AuthStore } from "../src/features/auth/store"
import { RepoGate, repoGated } from "../src/features/repo/components/RepoGate"
import { RepoHomeScreen } from "../src/screens/repo/RepoHomeScreen"
import { HomePage } from "../src/features/home/components/HomePage"
import { LOCAL_RECIPIENT } from "../src/features/attention/contract"
import { AttentionStore } from "../src/features/attention/store"
import { RepoStore } from "../src/features/repo/store"
import { HomeStore } from "../src/features/home/store"
import { Home } from "../src/features/home/home"
import { appViews } from "../src/test/appViews"
import { nodeDevice, openTestApp } from "../src/test/chatApi"
import { renderRepositoryPages } from "./fixtures/repository-pages"

test.each([false, true])("a cached home has one Offline connection signal (repository header: %s)", async (withHeader) => {
  const app = openTestApp({ host: nodeDevice({ isOnline: () => false }) })
  const scope = await Effect.runPromise(Scope.make())
  try {
    const homeContext = await app.runPromise(Layer.buildWithScope(HomeStore.layer, scope))
    const home = Context.get(homeContext, HomeStore)
    const homeView = await app.runPromise(Effect.service(Home).pipe(Effect.provide(Home.layer), Effect.provideContext(homeContext)))
    const services = { ...await app.runPromise(appViews), home: homeView }
    const repo = await app.runPromise(Effect.service(RepoStore))
    await app.runPromise(Effect.all([
      repo.view.update("view", row => { row.owner = "acme"; row.name = "widgets"; row.repoId = "github/acme/widgets" }),
      home.current.update("current", row => { row.owner = "acme"; row.name = "widgets"; row.repoId = "github/acme/widgets"; row.answering = false }),
      home.curated.insert({ key: "github/acme/widgets", state: "declared", defaultBranch: "main", sections: [{ audience: "everyone", blocks: [{ type: "text", text: "Cached home" }] }] }),
    ]))
    for (const query of [services.repo.queries.view, services.repo.queries.roles, services.attention.queries.unread, services.attention.queries.needs, services.attention.queries.panel, services.home.queries.home, services.chat.queries.connection, services.chat.queries.place, services.chat.queries.of(null).queued]) query.startSyncImmediate()
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/$owner/$repo", component: withHeader ? RepoHomeScreen : () => createElement(HomePage, { tree: "Cached tree" }) })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/acme/widgets"] }) })
    await router.load()
    await vi.waitFor(() => {
      const html = renderRepositoryPages(router, services)
      expect(html).toContain("Cached home")
      expect(html).toContain("Offline")
      expect(html.match(/aria-label="Connection"/g)).toHaveLength(1)
    })
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); await app.dispose() }
}, 60_000)


test.each([false, true].flatMap(page => [false, true].map(visitor => ({ page, visitor }))))("a denied repository keeps page controls without cached content (%j)", async ({ page, visitor }) => {
  const app = openTestApp({ host: nodeDevice({ isOnline: () => false }) }, visitor ? { actor: null } : {})
  try {
    const services = await app.runPromise(appViews)
    const repo = await app.runPromise(Effect.service(RepoStore))
    const attention = await app.runPromise(Effect.service(AttentionStore))
    services.auth.queries.session.startSyncImmediate()
    await vi.waitFor(() => expect(services.auth.queries.session.toArray[0]?.status).toBe(visitor ? "signed_out" : "signed_in"))
    // The test server has no OAuth credentials; render a deployment whose sign-in is configured.
    const auth = await app.runPromise(Effect.service(AuthStore))
    await app.runPromise(auth.session.update("session", row => { row.available = true }))
    await app.runPromise(repo.roles.insert({ id: "github/acme/unreadable", role: null, own: false, readable: false }))
    const at = new Date().toISOString()
    await app.runPromise(attention.launches.insert({
      subject: "page-notice", recipient: LOCAL_RECIPIENT, kind: "run", state: "working", mine: true, quiet: false,
      runId: null, conversationId: null, repoId: null, actor: null, title: "Another run is working", ref: null,
      href: "/app", version: 1, readVersion: 0, dismissedVersion: 0, hiddenVersion: 0,
      occurredAt: at, createdAt: at, updatedAt: at,
    }))
    for (const query of [services.auth.queries.session, services.repo.queries.roles, services.attention.queries.stack,
      services.attention.queries.unread, services.attention.queries.needs, services.attention.queries.panel,
      services.spend.queries.open, services.chat.queries.connection, services.chat.queries.place, services.chat.queries.of(null).queued]) query.startSyncImmediate()
    const root = createRootRoute()
    const contents = () => createElement("p", null, "Private cached content")
    const route = createRoute({ getParentRoute: () => root, path: "/$owner/$repo", component: page ? repoGated(contents) : () => createElement(RepoGate, {
      owner: "acme", name: "unreadable", children: createElement(contents),
    }) })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/acme/unreadable"] }) })
    await router.load()
    await vi.waitFor(() => {
      const html = renderRepositoryPages(router, services)
      expect(html).toContain(visitor ? "Sign in" : "Not found")
      if (visitor) expect(html).not.toContain("Not found")
      if (page) {
        expect(html).toContain("acme / unreadable")
        expect(html.match(/data-slot="notification-bell"/g)).toHaveLength(1)
        expect(html).toContain("Another run is working")
        expect(html).toContain("sui-toast-stack")
      } else {
        expect(html).not.toContain('data-slot="notification-bell"')
        expect(html).not.toContain("sui-toast-stack")
      }
      expect(html.match(/aria-label="Connection"/g) ?? []).toHaveLength(page ? 1 : 0)
      expect(html.match(/<main/g) ?? []).toHaveLength(page ? 1 : 0)
      expect(html).not.toContain("Private cached content")
      expect(html).not.toContain("Clone")
      expect(html).not.toContain("You don")
    })
  } finally { await app.dispose() }
}, 60_000)
