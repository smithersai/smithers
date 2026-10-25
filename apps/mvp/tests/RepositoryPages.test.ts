import { createElement } from "react"
import { FlowsUi } from "../src/features/flows-ui/flowsUi"
import { HomePage } from "../src/features/home/components/HomePage"
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Context, Effect, Layer, Scope, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test, vi } from "vitest"
import { renderRepositoryPages } from "./fixtures/repository-pages"
import { openTestApp, TestChatApi } from "../src/test/chatApi"
import { put } from "../src/features/repo/actions"
import { RepoStore } from "../src/features/repo/store"
import { HomeStore } from "../src/features/home/store"
import { AuthStore } from "../src/features/auth/store"
import { TodosStore } from "../src/features/todos/store"
import { IssuesStore } from "../src/features/issues/store"
import { IssuesScreen } from "../src/screens/issues/IssuesScreen"
import { PullsScreen } from "../src/screens/pulls/PullsScreen"
import { NewIssueScreen } from "../src/screens/issues/NewIssueScreen"
import { StackScreen } from "../src/screens/stack/StackScreen"
import { SecretsScreen } from "../src/screens/secrets/SecretsScreen"
import { ActionsScreen } from "../src/screens/actions/ActionsScreen"
import { Auth } from "../src/features/auth/auth"
import { Repo } from "../src/features/repo/repo"
import { Home } from "../src/features/home/home"
import { Issues } from "../src/features/issues/issues"
import { Todos } from "../src/features/todos/todos"
import { Pulls } from "../src/features/pulls/pulls"
import { Runs } from "../src/features/runs/runs"
import { Secrets } from "../src/features/secrets/secrets"
import { Attention } from "../src/features/attention/attention"
import { Chat } from "../src/features/chat/chat"
import { Spend } from "../src/features/spend/spend"
import { Views } from "../src/features/views/views"

// Real feature collections and views. These are stored row fixtures, with no module mocks or intercepted requests.
test("direct feature pages keep navigation, fence the deployment's own repository, and name GitHub instead of an unobservable write", async () => {
  const app = openTestApp({ sessionLifecycle: false })
  const scope = await Effect.runPromise(Scope.make())
  try {
    const homeContext = await app.runPromise(Layer.buildWithScope(HomeStore.layer, scope))
    const homeStore = Context.get(homeContext, HomeStore)
    const homeView = await app.runPromise(Effect.service(Home).pipe(Effect.provide(Home.layer), Effect.provideContext(homeContext)))
    const services = await app.runPromise(Effect.all({
      flows: Effect.service(FlowsUi),
      auth: Effect.service(Auth),
      repo: Effect.service(Repo),
      home: Effect.succeed(homeView),
      issues: Effect.service(Issues),
      todos: Effect.service(Todos),
      pulls: Effect.service(Pulls),
      runs: Effect.service(Runs),
      secrets: Effect.service(Secrets),
      attention: Effect.service(Attention),
      chat: Effect.service(Chat),
      spend: Effect.service(Spend),
      views: Effect.service(Views),
    }))
    const [repo, auth, todos] = await app.runPromise(Effect.all([Effect.service(RepoStore), Effect.service(AuthStore), Effect.service(TodosStore)]))
    const home = homeStore
    const api = await app.runPromise(Effect.service(TestChatApi))
    await Effect.runPromise(api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO repo_about (repo_id, app_absent_until) VALUES ('github/smithersai/vibelang', now() + interval '1 hour')`)))
    const vibelangIssues = await app.runPromise(Effect.flatMap(Effect.service(IssuesStore), (store) => store.forRepo("github/smithersai/vibelang")))
    services.repo.actions.openRoute("tree", { owner: "smithersai", repo: "vibelang" }, {})
    await app.runPromise(Effect.all([
      auth.session.update("session", row => { row.status = "signed_in"; row.role = "admin"; row.login = "reader" }),
      home.current.update("current", row => { row.owner = "smithersai"; row.name = "vibelang"; row.repoId = "github/smithersai/vibelang"; row.answering = false; row.defaultBranch = "main"; row.curatedDocs = "docs/index.md" }),
      home.curated.insert({ key: "github/smithersai/vibelang", state: "declared", defaultBranch: "main", sections: [{ audience: "everyone", blocks: [{ type: "text", text: "VibeLang" }, { type: "prompt", title: "Ask about this repository" }] }] }),
    ]))
    for (const query of [services.repo.queries.view, services.repo.queries.roles, services.home.queries.home, services.auth.queries.session, services.auth.queries.confirmed, services.chat.queries.connection, services.chat.queries.queued, services.chat.queries.place, services.attention.queries.unread, services.attention.queries.needs, services.attention.queries.panel]) query.startSyncImmediate()
    for (const feature of [services.issues, services.todos, services.pulls, services.runs, services.secrets, services.flows]) {
      for (const query of Object.values(feature.queries)) if (typeof query === "object" && query !== null && "startSyncImmediate" in query && typeof query.startSyncImmediate === "function") query.startSyncImmediate()
    }
    for (const [path, component, text] of [
      ["", () => createElement(HomePage, { tree: null }), "VibeLang"],
      ["issues", IssuesScreen, "Issues for this repository are on GitHub."],
      ["pulls", PullsScreen, "Pull requests for this repository are on GitHub."],
      ["issues/new", NewIssueScreen, "Open an issue on GitHub"],
      ["settings/secrets", SecretsScreen, "You can&#x27;t see this repository&#x27;s secrets."],
      ["actions", ActionsScreen, "Runs"],
      ["stack", StackScreen, "Members can make TODOs."],
    ] as const) {
      await services.issues.actions.open("smithersai", "vibelang")
      // The App isn't on smithersai/vibelang, as an About read found: its shapes answer 404 (decision 0079 slice 1b).
      await vi.waitFor(() => expect(vibelangIssues.access.tanstack.get("access")?.status).toBe("elsewhere"), { timeout: 30_000 })
      await app.runPromise(todos.view.update("view", row => { row.owner = "smithersai"; row.name = "vibelang"; row.repoId = "github/smithersai/vibelang" }))
      if (path === "stack") await app.runPromise(put(todos.access, "github/smithersai/vibelang", { id: "github/smithersai/vibelang", status: "forbidden" }))
      const root = createRootRoute()
      const route = createRoute({ getParentRoute: () => root, path: path === "" ? "/$owner/$repo" : `/$owner/$repo/${path}`, component })
      const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [path === "" ? "/smithersai/vibelang" : `/smithersai/vibelang/${path}`] }) })
      await router.load()
      expect(router.state.matches.at(-1)).toMatchObject({ routeId: route.id, status: "success" })
      await vi.waitFor(() => {
      const html = renderRepositoryPages(router, services)
      if (path !== "") expect(html).toContain('aria-label="Repository"')
      if (path !== "") expect(html).toContain("smithersai / vibelang")
      if (path !== "") expect(html).toContain('aria-label="Repository pages"')
      expect(html).toContain(text)
      expect(html).not.toContain("Ask about this repository")
      expect(html).not.toContain('>Secrets</a>')
      expect(html).not.toContain('>Settings</a>')
      expect(html).not.toContain('aria-label="Commitment"')
      })
    }
    // The deployment's own repository only once ChatApi answers it is, with the person's role there (decision 0079).
    await app.runPromise(put(repo.roles, "github/smithersai/vibelang", { id: "github/smithersai/vibelang", role: "admin", own: true }))
    for (const [path, component, expected] of [
      ["settings/secrets", SecretsScreen, "No secrets"],
      ["issues/new", NewIssueScreen, "You can’t open issues in this repository."],
    ] as const) {
      if (path === "issues/new") {
        // A repository this deployment syncs, where the person has no role: the form isn't theirs to use.
        await app.runPromise(put(repo.roles, "github/smithersai/vibelang", { id: "github/smithersai/vibelang", role: null, own: true }))
        await app.runPromise(vibelangIssues.access.update("access", (row) => { row.status = "allowed" }))
      }
      const root = createRootRoute()
      const route = createRoute({ getParentRoute: () => root, path: path === "" ? "/$owner/$repo" : `/$owner/$repo/${path}`, component })
      const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [path === "" ? "/smithersai/vibelang" : `/smithersai/vibelang/${path}`] }) })
      await router.load()
      expect(router.state.matches.at(-1)).toMatchObject({ routeId: route.id, status: "success" })
      await vi.waitFor(() => {
      const html = renderRepositoryPages(router, services)
      expect(html).toContain(expected)
      expect(html).not.toContain(">Sign in</")
      })
    }

  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); await app.dispose() }
}, 90_000)
