import { createElement } from "react"
import { HomePage } from "../src/features/home/components/HomePage"
import { RepoHeader } from "../src/features/repo/components/RepoHeader"
import { repoGated } from "../src/features/repo/components/RepoGate"
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Context, Effect, Layer, Scope, Exit, Option } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test, vi } from "vitest"
import { renderRepositoryPages } from "./fixtures/repository-pages"
import { appViews } from "../src/test/appViews"
import { openTestApp, TestChatApi } from "../src/test/chatApi"
import { put } from "../src/features/repo/actions"
import { FAILURE_COPY } from "../src/features/repo/contract"
import { RepoStore } from "../src/features/repo/store"
import type { About } from "../src/features/repo/schema"
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
import { Home } from "../src/features/home/home"
import { Issues } from "../src/features/issues/issues"
import { Runs } from "../src/features/runs/runs"
import { Secrets } from "../src/features/secrets/secrets"

/** What GitHub says of smithersai/vibelang, as an About read answers it. */
const vibelangAbout: About = {
  name: "smithersai/vibelang", description: "VibeLang", homepage: null, topics: [], stars: 0, forks: 0, watchers: 0,
  license: null, defaultBranch: "main", archived: false, languages: [], release: null, releases: 0, contributors: [],
  contributorCount: 0, commits: null, branches: null, tags: null, head: null, root: null, readme: null, installUrl: null,
}

// Real feature collections and views. These are stored row fixtures, with no module mocks or intercepted requests.
test("direct feature pages keep navigation, fence the deployment's own repository, and name GitHub instead of an unobservable write", async () => {
  const app = openTestApp({ sessionLifecycle: false })
  const scope = await Effect.runPromise(Scope.make())
  try {
    const homeContext = await app.runPromise(Layer.buildWithScope(HomeStore.layer, scope))
    const homeStore = Context.get(homeContext, HomeStore)
    const homeView = await app.runPromise(Effect.service(Home).pipe(Effect.provide(Home.layer), Effect.provideContext(homeContext)))
    const services = { ...await app.runPromise(appViews), home: homeView }
    const [repo, auth, todos] = await app.runPromise(Effect.all([Effect.service(RepoStore), Effect.service(AuthStore), Effect.service(TodosStore)]))
    const home = homeStore
    const api = await app.runPromise(Effect.service(TestChatApi))
    await Effect.runPromise(api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO repo_about (repo_id, app_absent_until) VALUES ('github/smithersai/vibelang', now() + interval '1 hour')`)))
    // GitHub shows smithersai/vibelang to anyone, so its home shows to a person with no role there (rulings GH-4, AUTH-1).
    api.github.scripted.publicElsewhere.add("smithersai/vibelang")
    const vibelangIssues = await app.runPromise(Effect.flatMap(Effect.service(IssuesStore), (store) => store.forRepo("github/smithersai/vibelang")))
    // GitHub has answered what it says of the repository. The test's GitHub is offline, so a read of its own would fail,
    // and a failed About hides the header's sections until metadata recovers (docs/features/repo.md): pages raced it.
    await app.runPromise(put(repo.abouts, "github/smithersai/vibelang", { key: "github/smithersai/vibelang", repoId: "github/smithersai/vibelang", state: "ready", about: vibelangAbout, message: null }))
    services.repo.actions.openRoute("tree", { owner: "smithersai", repo: "vibelang" }, {})
    // Every page renders after About has settled, the interleaving that failed when the read was the test's own.
    await vi.waitFor(async () => {
      const about = await app.runPromise(repo.abouts.get("github/smithersai/vibelang"))
      expect(Option.getOrUndefined(about)?.state).toBeOneOf(["ready", "missing", "failed"])
    }, { timeout: 10_000 })
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
        expect(html).toContain('aria-label="Repository sections"')
      }
      expect(html).toContain(text)
      expect(html).not.toContain("Ask about this repository")
      expect(html).not.toContain('>Secrets</a>')
      expect(html).not.toContain('>Settings</a>')
      expect(html).not.toContain('>Clone</button>')
      expect(html).not.toContain('aria-label="Commitment"')
      })
    }
    // Clone admission follows this repository's role, even when the session is an Admin elsewhere.
    await app.runPromise(repo.view.update("view", row => { row.answered = true; row.signedIn = true }))
    await app.runPromise(put(repo.abouts, "github/smithersai/vibelang", { key: "github/smithersai/vibelang", repoId: "github/smithersai/vibelang", state: "loading", about: null, message: null }))
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

// Lead decision 2026-11-11 (rulings GH-4 and AUTH-1): with the App absent from both, a public repository's home shows to a
// person with no role there, signed in or out, and a private one says what is true: Not found, or Sign in, with none of
// the other repository's home. Each role row here is ChatApi's own answer, from GitHub's metadata.
test("a public repository's home shows without a role, signed in or out; a private one shows none of it", async () => {
  const app = openTestApp({ sessionLifecycle: false })
  const scope = await Effect.runPromise(Scope.make())
  try {
    const homeContext = await app.runPromise(Layer.buildWithScope(HomeStore.layer, scope))
    const home = Context.get(homeContext, HomeStore)
    const homeView = await app.runPromise(Effect.service(Home).pipe(Effect.provide(Home.layer), Effect.provideContext(homeContext)))
    const services = { ...await app.runPromise(appViews), home: homeView }
    const [repo, auth] = await app.runPromise(Effect.all([Effect.service(RepoStore), Effect.service(AuthStore)]))
    const api = await app.runPromise(Effect.service(TestChatApi))
    await Effect.runPromise(api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO repo_about (repo_id, app_absent_until) VALUES
        ('github/smithersai/vibelang', now() + interval '1 hour'), ('github/smithersai/hidden', now() + interval '1 hour')`)))
    // GitHub shows smithersai/vibelang to anyone; smithersai/hidden is private, so its metadata answers 404.
    api.github.scripted.publicElsewhere.add("smithersai/vibelang")
    await app.runPromise(Effect.all([
      home.current.update("current", row => { row.owner = "smithersai"; row.name = "vibelang"; row.repoId = "github/smithersai/vibelang"; row.answering = false; row.defaultBranch = "main"; row.curatedDocs = "docs/index.md" }),
      home.curated.insert({ key: "github/smithersai/vibelang", state: "declared", defaultBranch: "main", sections: [{ audience: "everyone", blocks: [{ type: "text", text: "VibeLang" }] }] }),
    ]))
    for (const query of [services.repo.queries.view, services.repo.queries.roles, services.home.queries.home, services.auth.queries.session, services.auth.queries.confirmed, services.chat.queries.connection, services.attention.queries.unread, services.attention.queries.needs, services.attention.queries.panel]) query.startSyncImmediate()
    const page = async (name: string) => {
      const root = createRootRoute()
      const route = createRoute({ getParentRoute: () => root, path: "/$owner/$repo", component: repoGated(() => createElement(HomePage, { tree: null })) })
      const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [`/smithersai/${name}`] }) })
      await router.load()
      return router
    }
    for (const signedIn of [true, false]) {
      await app.runPromise(auth.session.update("session", (row) => {
        if (signedIn) { row.status = "signed_in"; row.role = "admin"; row.login = "reader" } else { row.status = "signed_out"; row.role = null; row.login = null; row.available = true }
      }))
      for (const name of ["vibelang", "hidden"]) {
        const id = `github/smithersai/${name}`
        if (Option.isSome(await app.runPromise(repo.roles.get(id)))) await app.runPromise(repo.roles.delete(id))
        services.repo.actions.role("smithersai", name)
        await vi.waitFor(async () => expect(Option.isSome(await app.runPromise(repo.roles.get(id)))).toBe(true), { timeout: 30_000 })
        const answer = Option.getOrThrow(await app.runPromise(repo.roles.get(id)))
        // The App is absent from both, so their shapes refuse everyone; only GitHub's metadata tells them apart.
        expect([answer.role, answer.readable, answer.synced, answer.public]).toEqual([null, false, false, name === "vibelang" ? true : undefined])
        const router = await page(name)
        await vi.waitFor(() => {
          const html = renderRepositoryPages(router, services)
          if (name === "vibelang") {
            expect(html).toContain("VibeLang")
            expect(html).not.toContain(">Not found<")
            expect(html).not.toContain("Sign in with GitHub")
          } else {
            expect(html).toContain("smithersai / hidden")
            expect(html).toContain(signedIn ? "Not found" : "Sign in with GitHub")
            expect(html).not.toContain("VibeLang")
          }
        }, { timeout: 10_000 })
      }
    }
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); await app.dispose() }
}, 90_000)

test.each(["queued", "missing"])("a %s Create URL has honest progress and recovery", async (state) => {
  const app = openTestApp({ sessionLifecycle: false })
  try {
    const services = await app.runPromise(appViews)
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
