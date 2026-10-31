import { createElement } from "react"
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { expect, test, vi } from "vitest"
import { FlowsUi } from "../src/features/flows-ui/flowsUi"
import { HomePage } from "../src/features/home/components/HomePage"
import { HomeStore } from "../src/features/home/store"
import { Auth } from "../src/features/auth/auth"
import { Chat } from "../src/features/chat/chat"
import { Home } from "../src/features/home/home"
import { Repo } from "../src/features/repo/repo"
import { Issues } from "../src/features/issues/issues"
import { Todos } from "../src/features/todos/todos"
import { Pulls } from "../src/features/pulls/pulls"
import { Runs } from "../src/features/runs/runs"
import { Secrets } from "../src/features/secrets/secrets"
import { Attention } from "../src/features/attention/attention"
import { Spend } from "../src/features/spend/spend"
import { Views } from "../src/features/views/views"
import { PluginsUi } from "../src/plugins/ui"
import { nodeDevice, openTestApp } from "../src/test/chatApi"
import { renderRepositoryPages } from "./fixtures/repository-pages"

test("a cached repository home remains visible with an Offline connection signal", async () => {
  const app = openTestApp({ host: nodeDevice({ isOnline: () => false }) })
  const scope = await Effect.runPromise(Scope.make())
  try {
    const homeContext = await app.runPromise(Layer.buildWithScope(HomeStore.layer, scope))
    const home = Context.get(homeContext, HomeStore)
    const homeView = await app.runPromise(Effect.service(Home).pipe(Effect.provide(Home.layer), Effect.provideContext(homeContext)))
    const services = await app.runPromise(Effect.all({ flows: Effect.service(FlowsUi), auth: Effect.service(Auth), chat: Effect.service(Chat), home: Effect.succeed(homeView), repo: Effect.service(Repo), issues: Effect.service(Issues), todos: Effect.service(Todos), pulls: Effect.service(Pulls), runs: Effect.service(Runs), secrets: Effect.service(Secrets), attention: Effect.service(Attention), spend: Effect.service(Spend), views: Effect.service(Views), plugins: Effect.service(PluginsUi) }))
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
