import { Files } from "../files/files"
// The real router and terminal view on the browser layer, with Electric's injected slow transport. No dev server:
// ChatApi, Postgres and Electric are the same dependencies as terminal.test.ts. Only the shape responses are held.
import { ShapeSource } from "@smthrs/effect-electric"
import { Collection } from "@smthrs/effect-tanstack-db"
import { createMemoryHistory } from "@tanstack/react-router"
import { Effect, Ref } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, expect, test, vi } from "vitest"
import { router } from "../../router"
import { renderTerminalScreen } from "../../test/terminalScreen"
import { openFaultyApp, TestChatApi } from "../../test/chatApi"
import { shaOf } from "../../../worker/test/branch"
import { read } from "../../test/otlp"
import { Attention } from "../attention/attention"
import { Auth } from "../auth/auth"
import { AuthStore, SESSION } from "../auth/store"
import { Branch } from "../branch/branch"
import { Chat } from "../chat/chat"
import { Commands } from "../commands/commands"
import { Domains } from "../domains/domains"
import { FlowsUi } from "../flows-ui/flowsUi"
import { Home } from "../home/home"
import { Issues } from "../issues/issues"
import { Docs } from "../docs/docs"
import { Pulls } from "../pulls/pulls"
import { PresenceStore } from "../presence/store"
import { Repo } from "../repo/repo"
import { RepoStore } from "../repo/store"
import { Runs } from "../runs/runs"
import { Secrets } from "../secrets/secrets"
import { Spend } from "../spend/spend"
import { PersonalModel } from "../personal-model/personalModel"
import { Status } from "../status/status"
import { Theme } from "../theme/theme"
import { Todos } from "../todos/todos"
import { Views } from "../views/views"
import { Terminal } from "./terminal"
import { TerminalStore } from "./store"
import { show } from "./actions"
import { PluginsUi } from "../../plugins/ui"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  await router.navigate({ to: "/" })
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

test.each(["empty", "mine", "watching"] as const)(
  "Terminal navigation commits and renders its screen while rows are held (%s), then shows their state",
  async (kind) => {
    const runtime = openFaultyApp()
    runtimes.push(runtime)
    const context = await runtime.runPromise(Effect.gen(function* () {
      return {
        repo: yield* Repo, home: yield* Home, views: yield* Views, branch: yield* Branch,
        terminal: yield* Terminal, issues: yield* Issues, pulls: yield* Pulls,
        todos: yield* Todos, runs: yield* Runs, flows: yield* FlowsUi, plugins: yield* PluginsUi, docs: yield* Docs,
        domains: yield* Domains, secrets: yield* Secrets,
      }
    }))
    const theme = await runtime.runPromise(Effect.service(Theme))
    const views = await runtime.runPromise(Effect.gen(function* () {
      return {
        chat: yield* Chat, auth: yield* Auth, attention: yield* Attention, status: yield* Status, commands: yield* Commands,
        spend: yield* Spend, personalModel: yield* PersonalModel,
      }
    }))
    const api = await runtime.runPromise(Effect.service(TestChatApi))
    api.branches.github.publish("octo", "hello", {
      defaultBranch: "main", branches: { main: shaOf("main"), feature: shaOf("feature") },
    })
    context.terminal.queries.panel.startSyncImmediate()
    context.terminal.queries.tabs.startSyncImmediate()
    context.branch.queries.current.startSyncImmediate()
    theme.queries.theme.startSyncImmediate()
    const { session } = await runtime.runPromise(Effect.service(AuthStore))
    await vi.waitFor(() => expect(session.tanstack.get(SESSION)?.status).not.toBe("loading"))
    await runtime.runPromise(session.update(SESSION, (row) => void Object.assign(row, {
      status: "signed_in", login: "person-member", role: "member",
    })))
    const panel = () => context.terminal.queries.panel.toArray[0]
    router.update({ history: createMemoryHistory({ initialEntries: ["/"] }), context, isServer: false, origin: api.origin })
    await router.load()
    const params = { owner: "octo", repo: "hello", ref: "feature", _splat: "" }
    await router.navigate({ to: "/$owner/$repo/tree/$ref/$", params })
    expect(router.state.matches.map((match) => ({
      route: match.routeId, status: match.status,
      error: match.error instanceof Error ? match.error.message : match.error,
    }))).toEqual([
      { route: "__root__", status: "success", error: undefined },
      { route: "/$owner/$repo/tree/$ref/$", status: "success", error: undefined },
    ])
    await vi.waitFor(() => expect(context.branch.queries.current.toArray[0]?.status).toBe("ready"))
    const repoStore = await runtime.runPromise(Effect.service(RepoStore))
    await runtime.runPromise(repoStore.repositories.preload)
    const branchId = context.branch.queries.current.toArray[0]!.branchId!
    const terminalId = crypto.randomUUID()
    if (kind !== "empty") {
      await runtime.runPromise(api.branches.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`INSERT INTO terminal_sessions (id, branch_id, owner_id, owner_login, status, generation)
          VALUES (${terminalId}, ${branchId}, ${kind === "mine" ? "person-member" : "someone-else"},
            ${kind === "mine" ? "person-member" : "someone-else"}, 'open', 1)`)))
    }
    const faults = await runtime.runPromise(Effect.service(ShapeSource.Faults))
    await runtime.runPromise(faults.stall())
    const selected = kind === "watching" ? terminalId : "me"
    // Navigation completes while terminal sync is held. The old route waits for its 10s timeout and offers Open
    // terminal with unknown rows; checking the loading state makes this independent of branch/track's own latency.
    await router.navigate({ to: "/$owner/$repo/tree/$ref/$", params, search: { terminal: selected } })
    expect(router.state.matches.at(-1)?.search).toMatchObject({ terminal: selected })
    await vi.waitFor(() => expect(panel()).toMatchObject({ branchId, terminalId: null, phase: "loading" }))
    const files = await runtime.runPromise(Effect.service(Files))
    const screen = () => renderTerminalScreen(router, context, { ...views, files }, theme)
    expect(screen()).toContain("terminal-panel-screen")
    expect(screen()).not.toContain("Open terminal")
    expect(screen()).not.toContain("No terminals")

    if (kind === "watching") {
      // Leaving while sync is held cancels selection; its eventual rows cannot take Code back over.
      await router.navigate({ to: "/$owner/$repo/tree/$ref/$", params })
      expect(panel()).toMatchObject({ branchId: null, phase: "idle" })
      expect(router.state.matches.at(-1)?.search).not.toHaveProperty("terminal")
      await router.navigate({ to: "/$owner/$repo/tree/$ref/$", params, search: { terminal: selected } })
      await vi.waitFor(() => expect(panel()?.phase).toBe("loading"))
      // A route abort interrupts selection itself, even before onLeave can clear the panel.
      router.state.matches.at(-1)!.abortController.abort()
    }

    await runtime.runPromise(faults.heal)
    if (kind === "watching") {
      const store = await runtime.runPromise(Effect.service(TerminalStore))
      await runtime.runPromise(Effect.flatMap(store.terminals(branchId), (rows) => rows.preload))
      // Rows arriving after abort cannot select a terminal or publish presence.
      expect(panel()).toMatchObject({ branchId, terminalId: null, phase: "loading" })
      const presence = await runtime.runPromise(Effect.service(PresenceStore))
      expect(runtime.runSync(Ref.get(presence.where))).toEqual({ view: "code", path: "" })
      await router.navigate({ to: "/$owner/$repo/tree/$ref/$", params })
      await router.navigate({ to: "/$owner/$repo/tree/$ref/$", params, search: { terminal: selected } })
    }
    await vi.waitFor(() => expect(panel()).toMatchObject(kind === "empty"
      ? { terminalId: null, phase: "idle" }
      : { terminalId, phase: "connecting" }), { timeout: 10_000 })
    expect(screen()).toContain(kind === "empty" ? "Open terminal" : 'data-screen="frame"')
    if (kind === "mine") expect(screen()).not.toContain("Open terminal")
    // A background completion publishes presence only after it knows the terminal.
    const presence = await runtime.runPromise(Effect.service(PresenceStore))
    await vi.waitFor(() => expect(runtime.runSync(Ref.get(presence.where))).toEqual(
      { view: "terminal", terminalId: kind === "empty" ? null : terminalId }))
    if (kind === "empty") {
      let called = false
      context.terminal.actions.showInBackground(branchId, undefined, async () => { called = true }, AbortSignal.abort())
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(called).toBe(false)
      expect(panel()).toMatchObject({ terminalId: null, phase: "idle" })
      await new Promise<void>((resolve) => context.terminal.actions.showInBackground(branchId, undefined, async () => {
        resolve()
        throw new Error("callback failed")
      }))
      await new Promise<void>((resolve) => setImmediate(resolve))
      const store = await runtime.runPromise(Effect.service(TerminalStore))
      const faulty = TerminalStore.of({
        ...store,
        terminals: (id) => Effect.map(store.terminals(id), (rows) => ({
          ...rows, preload: Effect.fail(new Collection.LoadFailed({ cause: new Error("preload failed") })),
        })),
      })
      await runtime.runPromise(show(branchId).pipe(Effect.provideService(TerminalStore, faulty)))
      expect(panel()?.phase).toBe("loading")
      expect(screen()).not.toContain("Open terminal")
    }
    await router.navigate({ to: "/" })
    await context.terminal.actions.show(null)
    await runtime.dispose()
    const records = read(api.telemetry)
    expect(records.logs).toContainEqual(expect.objectContaining({
      message: "terminal.show", attributes: expect.objectContaining({
        preloadMs: expect.any(Number), rowCount: kind === "empty" ? 0 : 1, outcome: "ready",
      }),
    }))
    expect(records.spans).toContainEqual(expect.objectContaining({
      name: "terminal.show", attributes: expect.objectContaining({ outcome: "ready" }),
    }))
    if (kind === "watching") expect(records.logs).toContainEqual(expect.objectContaining({
      message: "terminal.show", attributes: expect.objectContaining({ outcome: "cancelled" }),
    }))
    if (kind === "empty") {
      // The callback that failed and the rows that couldn't load are each logged with a code, never the message.
      expect(records.logs).toContainEqual(expect.objectContaining({
        message: "terminal.show.failed",
        severity: "Error",
        attributes: expect.objectContaining({ feature: "terminal", errorCode: expect.any(String) }),
      }))
      expect(records.logs).toContainEqual(expect.objectContaining({
        message: "terminal.show",
        severity: "Warn",
        attributes: expect.objectContaining({ outcome: "failed", errorCode: "LoadFailed" }),
      }))
      expect(JSON.stringify(records.logs)).not.toContain("callback failed")
    }
  },
  90_000,
)
