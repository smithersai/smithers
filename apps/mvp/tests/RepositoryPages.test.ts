import { createElement } from "react"
import { FlowsUi } from "../src/features/flows-ui/flowsUi"
import { HomePage } from "../src/features/home/components/HomePage"
import { RepoHeader } from "../src/features/repo/components/RepoHeader"
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Context, Effect, Layer, Scope, Exit, Option } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test, vi } from "vitest"
import { renderRepositoryPages } from "./fixtures/repository-pages"
import { openTestApp, TestChatApi } from "../src/test/chatApi"
import { put } from "../src/features/repo/actions"
import { FAILURE_COPY } from "../src/features/repo/contract"
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
import { RepoSettingsScreen } from "../src/screens/repo-settings/RepoSettingsScreen"
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
import { PluginsUi } from "../src/plugins/ui"

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
      plugins: Effect.service(PluginsUi),
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
      ["runs", ActionsScreen, "Runs"],
      ["settings", RepoSettingsScreen, "No settings available"],
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
      if (path !== "" && path !== "settings") {
        expect(html).toContain('aria-label="Repository"')
        expect(html.match(/>Back to chat<\/a>/g)).toHaveLength(1)
        expect(html).toContain("smithersai / vibelang")
        expect(html).toContain('aria-label="Repository pages"')
      }
      expect(html).toContain(text)
      expect(html).not.toContain("Ask about this repository")
      expect(html).not.toContain('>Secrets</a>')
      expect(html).not.toContain('>Settings</a>')
      expect(html).not.toContain('>Clone</button>')
      expect(html).not.toContain('aria-label="Commitment"')
      })
    }
    // Settle the initial real read before installing the pending-metadata fixture for header admission.
    await vi.waitFor(async () => {
      const about = await app.runPromise(repo.abouts.get("github/smithersai/vibelang"))
      expect(Option.isSome(about)).toBe(true)
      if (Option.isSome(about)) expect(about.value.state).not.toBe("loading")
    }, { timeout: 10_000 })
    // Clone admission follows this repository's role, even when the session is an Admin elsewhere.
    await app.runPromise(repo.view.update("view", row => { row.answered = true; row.signedIn = true }))
    await app.runPromise(put(repo.abouts, "github/smithersai/vibelang", { key: "github/smithersai/vibelang", state: "loading", about: null, message: null }))
    const homeRoot = createRootRoute()
    const homeRoute = createRoute({ getParentRoute: () => homeRoot, path: "/$owner/$repo", component: RepoHeader })
    const homeRouter = createRouter({ routeTree: homeRoot.addChildren([homeRoute]), history: createMemoryHistory({ initialEntries: ["/smithersai/vibelang"] }) })
    await homeRouter.load()
    if (Option.isSome(await app.runPromise(repo.roles.get("github/smithersai/vibelang")))) await app.runPromise(repo.roles.delete("github/smithersai/vibelang"))
    await vi.waitFor(() => {
      const html = renderRepositoryPages(homeRouter, services)
      expect(html).not.toContain(">Clone</button>")
      expect(html).not.toContain(">Try again</button>")
      expect(html).not.toContain("Members can clone.")
    })
    await app.runPromise(put(repo.roles, "github/smithersai/vibelang", { id: "github/smithersai/vibelang", role: null, own: false, failure: "unavailable" }))
    await app.runPromise(put(repo.clones, "github/smithersai/vibelang", { id: "github/smithersai/vibelang", owner: "smithersai", name: "vibelang", status: "failed" as const }))
    await vi.waitFor(() => {
      const html = renderRepositoryPages(homeRouter, services)
      expect(html).toContain(FAILURE_COPY.unavailable.replaceAll("'", "&#x27;"))
      expect(html).not.toContain(">Clone</button>")
      expect(html).not.toContain(">Try again</button>")
    })
    await app.runPromise(repo.clones.delete("github/smithersai/vibelang"))
    for (const role of [null, "guest", "member", "maintainer", "admin"] as const) {
      await app.runPromise(put(repo.roles, "github/smithersai/vibelang", { id: "github/smithersai/vibelang", role, own: false, failure: undefined }))
      await vi.waitFor(() => {
        const html = renderRepositoryPages(homeRouter, services)
        if (role === null || role === "guest") {
          expect(html).toContain("Members can clone.")
          expect(html).not.toContain(">Clone</button>")
          expect(html).not.toContain(">Try again</button>")
        } else expect(html).toContain(">Clone</button>")
      })
    }
    // Visitors can sign in directly from every gated settings page.
    await app.runPromise(auth.session.update("session", (row) => { row.status = "signed_out"; row.available = true }))
    for (const [path, component] of [["runs", ActionsScreen], ["settings", RepoSettingsScreen], ["settings/secrets", SecretsScreen]] as const) {
      const root = createRootRoute()
      const route = createRoute({ getParentRoute: () => root, path: `/$owner/$repo/${path}`, component })
      const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [`/smithersai/vibelang/${path}`] }) })
      await router.load()
      await vi.waitFor(() => {
        const html = renderRepositoryPages(router, services)
        expect(html).toContain("Sign in with GitHub")
        expect(html).toContain(`return=${encodeURIComponent(`/smithersai/vibelang/${path}`)}`)
        expect(html).not.toContain("No runs yet")
      })
    }
    await app.runPromise(auth.session.update("session", (row) => { row.status = "signed_in"; row.role = "admin" }))
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
      if (path === "settings/secrets") expect(html).not.toContain("Admins add secrets")
      expect(html).not.toContain(">Sign in</")
      })
    }

    // A Member reads the names but needs an Admin to add the first secret.
    await app.runPromise(put(repo.roles, "github/smithersai/vibelang", { id: "github/smithersai/vibelang", role: "member", own: true }))
    {
      const root = createRootRoute()
      const route = createRoute({ getParentRoute: () => root, path: "/$owner/$repo/settings/secrets", component: SecretsScreen })
      const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/smithersai/vibelang/settings/secrets"] }) })
      await router.load()
      await vi.waitFor(() => {
        const html = renderRepositoryPages(router, services)
        expect(html).toContain("No secrets · Admins add secrets")
        expect(html).not.toContain('aria-label="Add secret"')
      })
    }

  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); await app.dispose() }
}, 90_000)

test.each(["queued", "missing"])("a %s Create URL has honest progress and recovery", async (state) => {
  const app = openTestApp({ sessionLifecycle: false })
  try {
    const services = await app.runPromise(Effect.all({
      flows: FlowsUi, auth: Auth, repo: Repo, home: Home, issues: Issues, todos: Todos,
      pulls: Pulls, runs: Runs, secrets: Secrets, attention: Attention, chat: Chat, spend: Spend, views: Views,
      plugins: PluginsUi,
    }))
    const store = await app.runPromise(Effect.service(IssuesStore))
    const auth = await app.runPromise(Effect.service(AuthStore))
    await services.issues.actions.open("octo", "hello")
    await app.runPromise(auth.session.update("session", (row) => { row.status = "signed_in"; row.login = "member"; row.role = "member" }))
    const write = crypto.randomUUID()
    if (state === "queued") await app.runPromise(store.requested.insert({ id: write, repo: "octo/hello", repoId: "github/octo/hello", op: "issue/create", title: "Queued", body: "Offline request", number: 0, queuedAt: Date.now(), status: "requested", reason: null }))
    for (const queries of [services.repo.queries, services.home.queries, services.issues.queries, services.auth.queries, services.chat.queries, services.attention.queries]) {
      for (const query of Object.values(queries)) if (typeof query === "object" && query !== null && "startSyncImmediate" in query && typeof query.startSyncImmediate === "function") query.startSyncImmediate()
    }
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/$owner/$repo/issues/new", component: NewIssueScreen, validateSearch: (search) => ({ write: String(search.write) }) })
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [`/octo/hello/issues/new?write=${write}`] }) })
    await router.load()
    await vi.waitFor(() => {
      const html = renderRepositoryPages(router, services)
      expect(html).toContain(state === "queued" ? 'role="status">Requested' : "Request unavailable")
      if (state === "missing") expect(html).toContain('href="/octo/hello/issues"')
      expect(html).not.toContain("Creating issue")
    }, { timeout: 30_000 })
  } finally { await app.dispose() }
}, 90_000)
