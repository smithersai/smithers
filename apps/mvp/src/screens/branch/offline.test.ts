import { Files } from "../../features/files/files"
import { branchRenderer, DeniedBranchHeader } from "./offline-render"
// A fresh device with tracking held at the injected engine service, as a durable branch/track waiting offline.
// The app, router, stores and components are real; releasing the fault runs the real flow against ChatApi.
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Effect } from "effect"
import { ShapeSource } from "@smthrs/effect-electric"
import { afterEach, expect, test, vi } from "vitest"
import { shaOf } from "../../../worker/test/branch.ts"
import { Attention } from "../../features/attention/attention"
import { Auth } from "../../features/auth/auth"
import { Branch } from "../../features/branch/branch"
import { BranchStore } from "../../features/branch/store"
import { retry, wentOffline } from "../../features/chat/actions"
import { Chat } from "../../features/chat/chat"
import { ChatStore } from "../../features/chat/store"
import { CodeIntel } from "../../features/code-intel/codeIntel"
import { FlowsUi } from "../../features/flows-ui/flowsUi"
import { Commands } from "../../features/commands/commands"
import { Domains } from "../../features/domains/domains"
import { Home } from "../../features/home/home"
import { Issues } from "../../features/issues/issues"
import { Docs } from "../../features/docs/docs"
import { Pulls } from "../../features/pulls/pulls"
import { PersonalModel } from "../../features/personal-model/personalModel"
import { Repo } from "../../features/repo/repo"
import { Runs } from "../../features/runs/runs"
import { Spend } from "../../features/spend/spend"
import { Secrets } from "../../features/secrets/secrets"
import { Status } from "../../features/status/status"
import { Terminal } from "../../features/terminal/terminal"
import { TerminalStore } from "../../features/terminal/store"
import { Theme } from "../../features/theme/theme"
import { Todos } from "../../features/todos/todos"
import { Views } from "../../features/views/views"
import { router as productionRouter } from "../../router"
import { openFaultyApp, TestChatApi } from "../../test/chatApi"
import { EngineFaults } from "../../test/faults"
import { dialing, roomHost } from "../../test/rooms"
import { read } from "../../test/otlp"
import { PluginsUi } from "../../plugins/ui"

const disposables: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposables.splice(0).reverse()) await dispose()
})

const open = async (reopenRoute?: () => void) => {
  const room = await roomHost()
  disposables.push(room.close)
  const runtime = openFaultyApp({
    webSocket: dialing(room.origin, { id: "person-member", name: "member" }),
    ...(reopenRoute === undefined ? {} : { reopenRoute }),
  })
  disposables.push(() => runtime.dispose())
  const [repo, home, views, branch, terminal, issues, pulls, todos, runs, flows, chat, attention, auth, intel, fault, api, status, commands, theme, spend, docs, domains, secrets] =
    await runtime.runPromise(Effect.all([
      Effect.service(Repo), Effect.service(Home), Effect.service(Views), Effect.service(Branch),
      Effect.service(Terminal), Effect.service(Issues), Effect.service(Pulls), Effect.service(Todos),
      Effect.service(Runs), Effect.service(FlowsUi), Effect.service(Chat), Effect.service(Attention),
      Effect.service(Auth), Effect.service(CodeIntel), Effect.service(EngineFaults), Effect.service(TestChatApi),
      Effect.service(Status), Effect.service(Commands), Effect.service(Theme), Effect.service(Spend), Effect.service(Docs),
      Effect.service(Domains), Effect.service(Secrets),
    ]))
  await runtime.runPromise(fault.holdStarts)
  const terminalStore = await runtime.runPromise(Effect.service(TerminalStore))
  const branchStore = await runtime.runPromise(Effect.service(BranchStore))
  const shapes = await runtime.runPromise(Effect.service(ShapeSource.Faults))
  // Tracking verifies the default branch too; HEAD must resolve to a published ref.
  api.branches.github.publish("octo", "hello", { defaultBranch: "main", branches: { main: shaOf("main"), work: shaOf("work") } })
  for (const query of [
    ...Object.values(repo.queries), branch.queries.current, branch.presence.queries.room, branch.presence.queries.participants,
    chat.queries.connection, chat.queries.place, chat.queries.queued, intel.queries.state, terminal.queries.panel, terminal.queries.tabs,
    attention.queries.unread, attention.queries.needs, attention.queries.panel, auth.queries.session,
  ]) query.startSyncImmediate()
  return {
    context: { repo, home, views, branch, terminal, issues, pulls, todos, runs, flows, docs, domains, secrets, plugins: await runtime.runPromise(Effect.service(PluginsUi)) },
    current: () => branch.queries.current.toArray[0],
    release: () => runtime.runPromise(fault.releaseStarts),
    downShapes: () => runtime.runPromise(shapes.down()),
    upShapes: () => runtime.runPromise(shapes.heal),
    savedQuestion: () => runtime.runPromise(Effect.gen(function* () {
      const store = yield* ChatStore
      const conversationId = crypto.randomUUID()
      yield* branchStore.conversations.restored
      yield* branchStore.conversations.insert({ id: "octo/hello/work", conversationId })
      yield* store.asking.insert({ v: 2, id: crypto.randomUUID(), answerId: crypto.randomUUID(),
        text: "saved offline question", queuedAt: 1, conversationId })
    })),
    previousBranch: () => runtime.runPromise(Effect.gen(function* () {
      repo.actions.openRoute("tree", { owner: "old-owner", repo: "old-repo", ref: "previous" }, {})
      yield* branchStore.current.update("current", (row) => void Object.assign(row,
        { owner: "old-owner", repo: "old-repo", name: "previous", status: "ready", branchId: "previous-branch",
          conversationId: crypto.randomUUID(), mode: "open", access: "owner" }))
      yield* terminalStore.panel.update("panel", (row) => void Object.assign(row,
        { branchId: "previous-branch", terminalId: "previous-terminal", phase: "open", access: "write" }))
      yield* terminalStore.tabs.insert({ id: "previous-terminal", ownerId: "previous-owner", ownerLogin: "previous-owner",
        mine: false, status: "open", createdAt: "2026-10-21T00:00:00Z" })
    })),
    exported: async () => { await runtime.dispose(); return read(api.telemetry) },
    /** The browser's `offline` and `online` events, as chat's connectivity binding runs them. */
    offline: () => runtime.runPromise(wentOffline),
    online: () => runtime.runPromise(retry("online")),
    render: branchRenderer({
      files: await runtime.runPromise(Effect.service(Files)), chat, auth, repo, branch, intel, status, commands, theme, terminal,
      attention, spend, personalModel: await runtime.runPromise(Effect.service(PersonalModel)), todos,
    }),
  }
}

const onBranch = (context: Awaited<ReturnType<typeof open>>["context"], terminal = false) => createRouter({
  ...productionRouter.options,
  context,
  origin: "http://localhost",
  history: createMemoryHistory({ initialEntries: [`/octo/hello/tree/work${terminal ? "?terminal=me" : ""}`] }),
})

// Node's server renderer does not mount the client's Suspense acknowledgement effects. Render the production route's
// actual selected pending component under the same route; the navigation/loader and its held services remain real.
const pendingView = async (tab: Awaited<ReturnType<typeof open>>, terminal = false) => {
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: "/$owner/$repo/tree/$ref/$",
    component: productionRouter.routesById["/$owner/$repo/tree/$ref/$"].options.pendingComponent,
  })
  const router = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/octo/hello/tree/work${terminal ? "?terminal=me" : ""}`] }),
  })
  await router.load()
  return () => tab.render(router)
}

test("an evicted device renders branch chrome while tracking waits, then opens the verified workspace", async () => {
  const tab = await open()
  const router = onBranch(tab.context)
  const entering = router.load()
  const render = () => tab.render(router)
  try {
    await vi.waitFor(() => expect(tab.current()?.status).toBe("tracking"), { timeout: 10_000 })
    const html = (await pendingView(tab))()
    expect(html).toContain('aria-label="Branch"')
    expect(html).toContain("octo / hello")
    expect(html).toContain('href="/octo/hello/tree/work"')
    expect(html).toContain('href="/octo/hello/tree/work?terminal=me"')
    expect(html).toContain('aria-label="Connection"')
    expect(html).not.toMatch(/>Owner<|>Can edit<|>Can view<|>Share</)
    expect(html).not.toContain('aria-label="Conversation"')
    expect(html).not.toContain('data-slot="chat-composer"')
  } finally {
    await tab.release()
    await entering
  }
  expect(tab.current()?.status).toBe("ready")
  const verified = render()
  expect(verified).toContain("Owner")
  expect(verified).toContain("Share")
  expect(verified).toContain('aria-label="Conversation"')

  // A revoked owner's stored grant cannot keep Share or its dialog visible.
  const root = createRootRoute()
  const route = createRoute({ getParentRoute: () => root, path: "/$owner/$repo/tree/$ref",
    component: DeniedBranchHeader,
  })
  const denied = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/octo/hello/tree/work"] }),
  })
  await denied.load()
  expect(tab.render(denied)).toBe("")
  const records = await tab.exported()
  expect(records.log("branch.open")).toContainEqual(expect.objectContaining({
    attributes: expect.objectContaining({ feature: "branch", outcome: "tracking" }),
    traceId: expect.any(String),
  }))
}, 90_000)

test("pending chrome names the destination and hides the previous branch through an outage and terminal preload", async () => {
  let router: ReturnType<typeof onBranch> | undefined
  const tab = await open(() => void router?.invalidate())
  await tab.previousBranch()
  router = onBranch(tab.context, true)
  const entering = router.load()
  const render = () => tab.render(router)
  try {
    const pending = await pendingView(tab, true)
    const warming = pending()
    expect(warming).toContain("octo / hello")
    expect(warming).toContain("work")
    expect(warming).not.toMatch(/old-owner|old-repo|previous|>Owner<|>Share</)
    await vi.waitFor(() => expect(tab.current()?.status).toBe("tracking"), { timeout: 10_000 })
    await tab.downShapes()
    await tab.offline()
    await tab.release()
    await entering
    expect(tab.current()?.status).toBe("offline")
    // While the connection is down, the destination's pending chrome cannot expose A's terminal or grants.
    const tracked = pending()
    expect(tracked).toContain('aria-label="Branch"')
    expect(tracked).not.toContain('aria-label="Terminal"')
    expect(tracked).not.toContain('aria-label="Conversation"')
    expect(tracked).not.toMatch(/previous|>Owner<|>Share<|Open terminal/)
  } finally {
    await tab.release()
    await tab.upShapes()
    await tab.online()
    await entering
  }
  await vi.waitFor(() => {
    expect(tab.current()?.status).toBe("ready")
    expect(tab.context.terminal.queries.panel.toArray[0]?.branchId).toBe(tab.current()?.branchId)
  }, { timeout: 40_000 })
  const verified = render()
  expect(verified).toContain('aria-label="Terminal"')
  expect(verified).not.toContain("previous-owner")
}, 90_000)

test("offline, an evicted device's branch page shows its chrome at once, and its route opens the workspace once the browser is back online", async () => {
  let router: ReturnType<typeof onBranch> | undefined
  const tab = await open(() => void router?.invalidate())
  router = onBranch(tab.context)
  const entering = router.load()
  await vi.waitFor(() => expect(tab.current()?.status).toBe("tracking"), { timeout: 10_000 })
  // Tracking can't answer: the engine holds its start, as it would wait on a ChatApi it can't reach.
  await tab.offline()
  await entering
  await vi.waitFor(() => expect(tab.current()?.status).toBe("offline"), { timeout: 10_000 })
  const offline = tab.render(router)
  expect(offline).toContain('aria-label="Branch"')
  expect(offline).toContain("work")
  expect(offline).toContain('href="/octo/hello/tree/work?terminal=me"')
  expect(offline).not.toMatch(/>Owner<|>Can edit<|>Can view<|>Share</)
  expect(offline).not.toContain('aria-label="Conversation"')

  await tab.release()
  await tab.online()
  await vi.waitFor(() => expect(tab.current()?.status).toBe("ready"), { timeout: 40_000 })
  await vi.waitFor(() => expect(router!.state.status).toBe("idle"), { timeout: 40_000 })
  const verified = tab.render(router)
  expect(verified).toContain("Owner")
  expect(verified).toContain('aria-label="Conversation"')

  // A ref that can't be a branch has no chrome, offline or not.
  await tab.offline()
  const missing = createRouter({
    ...productionRouter.options,
    context: tab.context,
    origin: "http://localhost",
    history: createMemoryHistory({ initialEntries: ["/octo/hello/tree/not..a-branch"] }),
  })
  await missing.load()
  await vi.waitFor(() => expect(tab.current()?.status).toBe("missing"), { timeout: 10_000 })
  expect(tab.render(missing)).not.toContain('aria-label="Branch"')
}, 90_000)

test("a saved branch shows its queued conversation and one counted pill offline without workspace controls", async () => {
  const tab = await open()
  await tab.savedQuestion()
  await tab.offline()
  const router = onBranch(tab.context)
  await router.load()
  const html = tab.render(router)
  expect(html.match(/aria-label="Connection"/g)).toHaveLength(1)
  expect(html).toContain("Offline · 1")
  expect(html).toContain('aria-label="Conversation"')
  expect(html).toContain("saved offline question")
  expect(html).not.toMatch(/>Owner<|>Can edit<|>Share<|>Edit<|>Discard<|data-slot="chat-composer"|aria-label="Terminal"/)
  await tab.release()
}, 90_000)
