import { createElement } from "react"
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { expect, test, vi } from "vitest"
import { HomePage } from "../src/features/home/components/HomePage"
import { HomeStore } from "../src/features/home/store"
import { Home } from "../src/features/home/home"
import { appViews } from "../src/test/appViews"
import { nodeDevice, openTestApp } from "../src/test/chatApi"
import { renderRepositoryPages } from "./fixtures/repository-pages"

test("a cached repository home remains visible with an Offline connection signal", async () => {
  const app = openTestApp({ host: nodeDevice({ isOnline: () => false }) })
  const scope = await Effect.runPromise(Scope.make())
  try {
    const homeContext = await app.runPromise(Layer.buildWithScope(HomeStore.layer, scope))
    const home = Context.get(homeContext, HomeStore)
    const homeView = await app.runPromise(Effect.service(Home).pipe(Effect.provide(Home.layer), Effect.provideContext(homeContext)))
    const services = { ...await app.runPromise(appViews), home: homeView }
    await app.runPromise(Effect.all([
      home.current.update("current", row => { row.owner = "acme"; row.name = "widgets"; row.repoId = "github/acme/widgets"; row.answering = false }),
      home.curated.insert({ key: "github/acme/widgets", state: "declared", defaultBranch: "main", sections: [{ audience: "everyone", blocks: [{ type: "text", text: "Cached home" }] }] }),
    ]))
    for (const query of [services.home.queries.home, services.chat.queries.connection, services.chat.queries.place, services.chat.queries.of(null).queued]) query.startSyncImmediate()
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/", component: () => createElement(HomePage, { tree: "Cached tree" }) })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) })
    await router.load()
    await vi.waitFor(() => {
      const html = renderRepositoryPages(router, services)
      expect(html).toContain("Cached home")
      expect(html).toContain("Offline")
      expect(html).toContain('aria-label="Connection"')
    })
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); await app.dispose() }
}, 60_000)
