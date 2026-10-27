import { openBranchPage } from "./features/branch/navigation"
import { createRootRouteWithContext, createRoute, createRouter, notFound, redirect } from "@tanstack/react-router"
import type { BranchView } from "./features/branch/branch"
import type { DomainsView } from "./features/domains/domains"
import type { FlowsUiView } from "./features/flows-ui/flowsUi"
import { pathOfSplat } from "./features/docs/contract"
import type { DocsView } from "./features/docs/docs"
import type { HomeView } from "./features/home/home"
import { issueNumberOf } from "./features/issues/contract"
import type { IssuesLayer } from "./features/issues/issues"
import { PULL_TABS, type PullTab } from "./features/pulls/contract"
import type { PullsLayer } from "./features/pulls/pulls"
import { type StackFilter, stackFilterOf, todoNumberOf } from "./features/todos/contract"
import type { TodosView } from "./features/todos/todos"
import { lineSearch } from "./features/repo/paths"
import type { RepoView } from "./features/repo/repo"
import type { RunsView } from "./features/runs/runs"
import type { SecretsLayer } from "./features/secrets/secrets"
import type { TerminalView } from "./features/terminal/terminal"
import type { ViewsView } from "./features/views/views"
import { AppScreen } from "./screens/app/AppScreen"
import { BlobScreen, TreeScreen } from "./screens/branch/BranchScreen"
import { BranchPendingScreen } from "./screens/branch/BranchPendingScreen"
import { CodeScreen } from "./screens/flows/CodeScreen"
import { DraftScreen } from "./screens/flows/DraftScreen"
import { FlowsScreen } from "./screens/flows/FlowsScreen"
import { NewFlowScreen } from "./screens/flows/NewFlowScreen"
import { IssueScreen } from "./screens/issues/IssueScreen"
import { PullScreen } from "./screens/pulls/PullScreen"
import { PullsScreen } from "./screens/pulls/PullsScreen"
import { StackScreen } from "./screens/stack/StackScreen"
import { TodoScreen } from "./screens/stack/TodoScreen"
import { commitmentSearch } from "./features/issues/lifecycle"
import { ActionRunScreen } from "./screens/actions/ActionRunScreen"
import { ActionsScreen } from "./screens/actions/ActionsScreen"
import { IssuesScreen } from "./screens/issues/IssuesScreen"
import { NewIssueScreen } from "./screens/issues/NewIssueScreen"
import { Landing } from "./screens/landing/Landing"
import { DocsScreen } from "./screens/docs/DocsScreen"
import { RepoHomeScreen } from "./screens/repo/RepoHomeScreen"
import { BranchesScreen } from "./screens/repo/BranchesScreen"
import { RepoScreen } from "./screens/repo/RepoScreen"
import { Root } from "./screens/root/Root"
import { RouteError } from "./screens/root/RouteError"
import { RunScreen } from "./screens/runs/RunScreen"
import { ConversationsScreen } from "./screens/conversations/ConversationsScreen"
import { runsSearch } from "./features/runs/page"
import { RunsScreen } from "./screens/runs/RunsScreen"
import { SecretsScreen } from "./screens/secrets/SecretsScreen"
import { RepoSettingsScreen } from "./screens/repo-settings/RepoSettingsScreen"
import { SettingsScreen } from "./screens/settings/SettingsScreen"
import { PluginScreen } from "./screens/plugin/PluginScreen"
import type { PluginsView } from "./plugins/ui"
import { ViewScreen } from "./screens/view/ViewScreen"

// The app's routes. A repository's are GitHub's paths (decision 0006 §2): swapping github.com for the app's domain
// opens the same view. Each route opens what it shows through the layers main.tsx hands the router, so nothing loads
// from a component; a new `?L=` line anchor opens the location again.
//
// Loading (docs/features/navigation.md): a link's hover or focus preloads its page (`defaultPreload: "intent"`), which
// warms what the page shows into the device; a navigation warms it too, then opens it. The router keeps the previous
// page on screen until then, and Root's LoadingBar shows only if that takes longer than LOADING_DELAY_MS. A page whose
// files are still on their way after a second shows with skeletons in their place, never blank.

/**
 * What every route gets: the repository, its home, views, branch, terminal, issues, pull requests, runs, flows and secrets
 * layers, from main.tsx's `RouterProvider`.
 */
export interface RouterContext {
  readonly repo: RepoView
  readonly home: HomeView
  readonly docs: DocsView
  readonly views: ViewsView
  readonly branch: BranchView
  readonly terminal: TerminalView
  readonly issues: IssuesLayer
  readonly pulls: PullsLayer
  readonly todos: TodosView
  readonly runs: RunsView
  readonly flows: FlowsUiView
  readonly plugins: PluginsView
  readonly domains: DomainsView
  readonly secrets: SecretsLayer
}

/**
 * A branch page's search: `?L=` as any repository page's; `?terminal`, which shows the branch's terminal: `me` for the
 * person's own, or a terminal's id to watch (decision 0013 §5); `?edit`, a file of the branch's working copy in the
 * live editor (docs/features/coedit.md#files); and `?compare`, what the published branch adds to its base
 * (docs/features/branch-publish.md#the-branch-page).
 */
const branchSearch = (
  search: Record<string, unknown>,
): { readonly L?: unknown; readonly terminal?: string; readonly edit?: string; readonly compare?: true } => ({
  ...lineSearch(search),
  ...(typeof search.terminal === "string" && search.terminal !== "" ? { terminal: search.terminal } : {}),
  ...(typeof search.edit === "string" && search.edit !== "" ? { edit: search.edit } : {}),
  ...(search.compare !== undefined && search.compare !== false ? { compare: true as const } : {}),
})

/** How long a link must be hovered before its page preloads, so a pointer sweeping over a list preloads nothing. */
export const PRELOAD_DELAY_MS = 50

/** What a route's `beforeLoad` knows of the load it is part of. */
interface Load {
  /** A link's hover or focus, not a navigation. */
  readonly preload: boolean
  /** Aborted once a newer navigation takes over. */
  readonly abortController: AbortController
}

/**
 * Every route opens what it shows in `beforeLoad`, never a loader: the router runs `beforeLoad` afresh for each
 * navigation and each preload, while a navigation adopts a loader a preload left in flight (router-core's flights), so
 * a loader can't tell a preload from the click that follows it. A preload only warms what the page shows; a navigation
 * warms it, then opens it, unless a newer navigation took over.
 */
const enter = async (load: Load, warm: () => unknown, open: () => unknown): Promise<void> => {
  await warm()
  if (load.preload || load.abortController.signal.aborted) return
  await open()
}

/**
 * A repository route's `enter`: warms and opens the page as `enter` does, and once it opens asks ChatApi who the person
 * is on the repository (decision 0079), for the header's links and the page's buttons.
 */
const enterRepo = (
  context: RouterContext,
  params: { readonly owner: string; readonly repo: string },
  load: Load,
  warm: () => unknown,
  open: () => unknown,
): Promise<void> =>
  enter(load, warm, () => {
    context.repo.actions.role(params.owner, params.repo)
    return open()
  })

/** Repository feature routes share the same frame, including on a direct visit. */
const enterRepository = (
  context: RouterContext,
  params: { readonly owner: string; readonly repo: string },
  load: Load,
  warm: () => unknown,
  open: () => unknown,
) => enterRepo(context, params, load,
  () => Promise.all([context.repo.actions.warmRoute("tree", params, {}), context.home.actions.warm(params.owner, params.repo), warm()]),
  () => {
    context.repo.actions.openRoute("tree", params, {})
    context.home.actions.open(params.owner, params.repo)
    return open()
  },
)

/** A page whose data is on the device already: nothing to warm. */
const local = () => undefined

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Root })

const landingRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Landing })

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  component: AppScreen,
  // The home conversation (decision 0013 §5): a tab that showed a branch asks here again.
  beforeLoad: (load) =>
    enter(load, local, () =>
      Promise.all([
        load.context.branch.actions.leave(),
        load.context.branch.presence.actions.leave(),
        load.context.terminal.actions.show(null),
      ])),
})

/**
 * `/app/views/$viewId`: one view of a conversation at its full size (decision 0004 §6); `?conversation=` names the
 * branch conversation it belongs to (decision 0013 §1), none the home conversation's.
 */
const viewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/views/$viewId",
  component: ViewScreen,
  validateSearch: (search: Record<string, unknown>): { readonly conversation?: string } =>
    typeof search.conversation === "string" && /^[0-9a-f-]{36}$/i.test(search.conversation)
      ? { conversation: search.conversation.toLowerCase() }
      : {},
  beforeLoad: (load) =>
    enter(load, local, () => load.context.views.actions.show(load.params.viewId, load.search.conversation)),
})

/** `/app/flows`: your own flows and drafts (decision 0014 §5). `app` is a reserved owner, so no repository matches. */
const flowsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/app/flows", component: FlowsScreen })
const flowsAliasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/flows",
  beforeLoad: () => { throw redirect({ to: "/app/flows" }) },
})

/** `/app/flows/new`: a new flow of your own; `?name=` drafts the next revision of the flow by that name. */
const newFlowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/flows/new",
  component: NewFlowScreen,
  validateSearch: (search: Record<string, unknown>): { readonly name?: string } =>
    typeof search.name === "string" && search.name !== "" ? { name: search.name } : {},
  beforeLoad: (load) => enter(load, local, () => load.context.flows.actions.openNew(load.search.name)),
})

/** `/app/flows/drafts/$draftId`: one draft at its full size. */
const draftRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/flows/drafts/$draftId",
  component: DraftScreen,
  beforeLoad: (load) => enter(load, local, () => load.context.flows.actions.openDraft(load.params.draftId)),
})

/** `/app/flows/code/$name`: a flow's code, to read and edit. */
const codeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/flows/code/$name",
  component: CodeScreen,
  beforeLoad: (load) => enter(load, local, () => load.context.flows.actions.openCode(load.params.name)),
})

/**
 * `/app/runs`: every run on this device and the runs on Cloudflare this person may read (decision 0014 §5, ruling
 * FLOW-13). `?flow=` lists one flow's runs; `?open=` shows one run opened in place, its jobs and steps.
 */
const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/runs",
  component: RunsScreen,
  validateSearch: runsSearch,
  beforeLoad: (load) =>
    enter(load, () => load.context.runs.actions.warmList(), () => load.context.runs.actions.openList(load.search.open)),
})

/** `/app/conversations`: your conversations, one per branch, synced to every device of yours. */
const conversationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/conversations",
  component: ConversationsScreen,
})

/**
 * `/app/$plugin` and `/app/$plugin/<path>`: a plugin's view at its full size (decision 0017, `views`). The host shows it
 * while the route is open, so its keys and its strip act on it; a path no plugin declares is not found.
 */
const pluginRoute = (path: "/app/$plugin" | "/app/$plugin/$") =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: PluginScreen,
    beforeLoad: ({ context, params, ...load }) => {
      const view = context.plugins.actions.viewAt(params.plugin, (params as { readonly _splat?: string })._splat ?? "")
      if (view === undefined) throw notFound()
      return enter(load, local, () => context.plugins.actions.show(view.id))
    },
    onLeave: ({ context }) => context.plugins.actions.show(null),
  })
const pluginIndexRoute = pluginRoute("/app/$plugin")
const pluginPathRoute = pluginRoute("/app/$plugin/$")

/** `/app/settings`: the deployment's settings, for an Admin; their rows sync to an Admin's devices. */
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/app/settings", component: SettingsScreen })

/** `/app/runs/$runId`: one run's page, read from this device's engine. */
const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/runs/$runId",
  component: RunScreen,
  beforeLoad: (load) => enter(load, local, () => load.context.runs.actions.openRun(load.params.runId)),
  onLeave: ({ context, params }) => context.runs.actions.closeRun(params.runId),
})

/**
 * `/$owner/$repo`: the repository's own home when it declares one (decision 0014 §4), else its root at its default
 * branch. Both the location and the home are warmed, then opened.
 */
const repoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo",
  component: RepoHomeScreen,
  validateSearch: lineSearch,
  beforeLoad: ({ context, params, search, ...load }) =>
    enterRepo(
      context,
      params,
      load,
      () =>
        Promise.all([
          context.repo.actions.warmRoute("tree", params, search),
          context.home.actions.warm(params.owner, params.repo),
        ]),
      () => {
        context.repo.actions.openRoute("tree", params, search)
        context.home.actions.open(params.owner, params.repo)
      },
    ),
})

/** Repository browsing infrastructure: the same visible refs as the picker, at GitHub's branch-list URL. */
const branchesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/branches",
  component: BranchesScreen,
  beforeLoad: ({ context, params, ...load }) =>
    enterRepo(context, params, load, () => context.repo.actions.warmRoute("tree", params, {}), () =>
      context.repo.actions.openRoute("tree", params, {})),
})

/**
 * `/$owner/$repo/tree/$ref/$`: a directory at a branch or commit, and the branch's workspace (decision 0013 §5): its
 * conversation, its room, and its terminal under `?terminal`. The location is warmed; then the route opens it and
 * tracks the branch at once, joins the branch's room and says where on the page this person is; leaving the route
 * leaves the room. A preload only warms the files: it joins no room.
 */
const treeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/tree/$ref/$",
  component: TreeScreen,
  pendingComponent: BranchPendingScreen,
  validateSearch: branchSearch,
  beforeLoad: ({ context, params, search, ...load }) =>
    enterRepo(context, params, load, () => Promise.all([context.repo.actions.warmRoute("tree", params, { L: search.L }), context.home.actions.warm(params.owner, params.repo)]), () =>
      Promise.all([
        context.repo.actions.openRoute("tree", params, { L: search.L }),
        context.home.actions.open(params.owner, params.repo),
        context.todos.actions.warm(params.owner, params.repo),
        openBranchPage(context.branch, context.terminal, load.abortController.signal, params, search),
      ])),
  onLeave: ({ context, abortController }) => {
    abortController.abort()
    leaveWorkspace(context)
  },
})

/**
 * `/$owner/$repo/blob/$ref/$`: a file at a branch or commit, `?L=<n>` or `?L=<a>-<b>` marking lines, in the branch's
 * workspace as the tree route opens it, so the conversation stays beside a file the agent opened (`file/open`,
 * docs/features/files.md); the home is opened for its tabs.
 */
const blobRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/blob/$ref/$",
  component: BlobScreen,
  pendingComponent: BranchPendingScreen,
  validateSearch: lineSearch,
  beforeLoad: ({ context, params, search, ...load }) =>
    enterRepo(context, params, load, () => context.repo.actions.warmRoute("blob", params, search), () =>
      Promise.all([
        context.repo.actions.openRoute("blob", params, search),
        context.home.actions.open(params.owner, params.repo),
        openBranchPage(context.branch, context.terminal, load.abortController.signal, params, params._splat === undefined ? {} : { file: params._splat }),
      ])),
  onLeave: ({ context, abortController }) => {
    abortController.abort()
    leaveWorkspace(context)
  },
})

/**
 * Leaving a branch's directory or file page leaves its room and its live editor, unless the router now shows a
 * directory or file page: that page's `beforeLoad` already joined its own branch's room, or left the room for a ref
 * that isn't a branch, and showed or hid its editor. A route's `onLeave` runs after the next route opened (router-core
 * `runRouteLifecycle`), so leaving here would undo what the next page just joined.
 */
const leaveWorkspace = (context: RouterContext) => {
  const next = router.state.matches.at(-1)?.routeId
  if (next === treeRoute.id || next === blobRoute.id) return
  void context.branch.presence.actions.leave()
  void context.branch.coedit.actions.hideFiles()
  void context.branch.publishing.actions.show(null)
  void context.terminal.actions.show(null)
}

/**
 * `/$owner/$repo/raw/$ref/$`: GitHub's raw path. Once the ref resolves, the page loads RepoApi's raw route of the file
 * at its commit in place of the app (a full document load, `reloadDocument`); until then, or when there is nothing to
 * load, it shows the file's view, which says why.
 */
const rawRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/raw/$ref/$",
  component: RepoScreen,
  // Nothing to warm: a preload would load the raw file in place of the app.
  beforeLoad: ({ context, params, ...load }) =>
    enterRepo(context, params, load, local, async () => {
      context.home.actions.open(params.owner, params.repo)
      const href = await context.repo.actions.rawRoute(params)
      if (href !== undefined) throw redirect({ href, reloadDocument: true })
    }),
})

/**
 * `/$owner/$repo/docs` and `/$owner/$repo/docs/$`: the repository's docs (docs/features/docs.md), its index or one page,
 * the splat being the page's path without its leading slash. The docs are warmed, then opened; the repository and its
 * home are opened too, for the header and the tabs.
 */
const docsBeforeLoad = (
  { context, params, ...load }: Load & {
    readonly context: RouterContext
    readonly params: { readonly owner: string; readonly repo: string; readonly _splat?: string | undefined }
  },
) => {
  const path = pathOfSplat(params._splat)
  return enterRepo(
    context,
    params,
    load,
    () =>
      Promise.all([
        context.docs.actions.warm(params.owner, params.repo, path),
        context.home.actions.warm(params.owner, params.repo),
      ]),
    () => {
      context.repo.actions.openRoute("tree", { owner: params.owner, repo: params.repo }, {})
      context.home.actions.open(params.owner, params.repo)
      context.docs.actions.open(params.owner, params.repo, path)
    },
  )
}

const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/docs",
  component: DocsScreen,
  beforeLoad: docsBeforeLoad,
})

const docsPageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/docs/$",
  component: DocsScreen,
  beforeLoad: docsBeforeLoad,
})

/**
 * `/$owner/$repo/issues`: the repository's issues (decision 0012 §6). The route opens its stack too, so each issue shows
 * the TODOs made from it; a preload starts both syncs.
 */
const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/issues",
  component: IssuesScreen,
  validateSearch: commitmentSearch,
  beforeLoad: ({ context, params, ...load }) =>
    enterRepository(context, params,
      load,
      () => Promise.all([context.issues.actions.warm(params.owner, params.repo), context.todos.actions.warm(params.owner, params.repo)]),
      () =>
        Promise.all([
          context.issues.actions.open(params.owner, params.repo),
          context.todos.actions.open(params.owner, params.repo),
        ]),
    ),
})

/** `/$owner/$repo/issues/new`: the new-issue form. */
const newIssueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/issues/new",
  component: NewIssueScreen,
  beforeLoad: ({ context, params, ...load }) =>
    enterRepository(context, params, load, () => context.issues.actions.warm(params.owner, params.repo), () => context.issues.actions.open(params.owner, params.repo)),
})

/** `/$owner/$repo/issues/$number`: one issue, and the TODOs made from it; any other `$number` matches no route. */
const issueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/issues/$number",
  component: IssueScreen,
  params: {
    parse: (params) => {
      const number = issueNumberOf(params.number)
      return number === undefined ? false : { ...params, number }
    },
    stringify: (params) => ({ ...params, number: String(params.number) }),
  },
  beforeLoad: ({ context, params, ...load }) =>
    enterRepository(
      context,
      params,
      load,
      () => Promise.all([context.issues.actions.warm(params.owner, params.repo), context.todos.actions.warm(params.owner, params.repo)]),
      () =>
        Promise.all([
          context.issues.actions.open(params.owner, params.repo, params.number),
          context.todos.actions.open(params.owner, params.repo),
        ]),
    ),
})

/** `/$owner/$repo/actions`: the repository's runs on Cloudflare (docs/features/actions.md); Electric keeps them. */
const actionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/actions",
  component: ActionsScreen,
  beforeLoad: ({ context, params, ...load }) => enterRepository(context, params, load, () => context.runs.actions.openRepoRuns(params.owner, params.repo), local),
})

/** `/$owner/$repo/actions/runs/$runId`: one of them, its jobs and their logs, read and followed on Cloudflare. */
const actionRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/actions/runs/$runId",
  component: ActionRunScreen,
  beforeLoad: (load) =>
    enterRepo(load.context, load.params, load, local, () =>
      load.context.runs.actions.openRun(load.params.runId, { owner: load.params.owner, name: load.params.repo })),
  onLeave: ({ context, params }) => context.runs.actions.closeRun(params.runId),
})

/** `/$owner/$repo/pulls`: the repository's pull requests (decision 0012 §6). */
const pullsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/pulls",
  component: PullsScreen,
  beforeLoad: ({ context, params, ...load }) =>
    enterRepository(context, params, load, () => context.pulls.actions.warm(params.owner, params.repo), () => context.pulls.actions.open(params.owner, params.repo)),
})

/** A pull request's number in its path, as an issue's is; any other matches no route. */
const pullParams = {
  parse: (params: { readonly owner: string; readonly repo: string; readonly number: string }) => {
    const number = issueNumberOf(params.number)
    return number === undefined ? false as const : { ...params, number }
  },
  stringify: (params: { readonly owner: string; readonly repo: string; readonly number: number }) => ({
    ...params,
    number: String(params.number),
  }),
}

/** `/$owner/$repo/pull/$number`: one pull request's conversation, with Merge for a Maintainer. */
const pullRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/pull/$number",
  component: () => <PullScreen tab="conversation" />,
  params: pullParams,
  beforeLoad: ({ context, params, ...load }) =>
    enterRepository(context, params, load, () => context.pulls.actions.warm(params.owner, params.repo), () => context.pulls.actions.open(params.owner, params.repo, params.number)),
})

/** `/$owner/$repo/pull/$number/$tab`: its commits, its checks (the Smithers runs on its head), or its files. */
const pullTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/pull/$number/$tab",
  component: function PullTab() {
    const { tab } = pullTabRoute.useParams()
    return <PullScreen tab={tab} />
  },
  params: {
    parse: (params: { readonly owner: string; readonly repo: string; readonly number: string; readonly tab: string }) => {
      const number = issueNumberOf(params.number)
      const tab = (PULL_TABS as ReadonlyArray<string>).includes(params.tab) && params.tab !== "conversation"
        ? params.tab as PullTab
        : undefined
      return number === undefined || tab === undefined ? false as const : { ...params, number, tab }
    },
    stringify: (params: { readonly owner: string; readonly repo: string; readonly number: number; readonly tab: PullTab }) => ({
      ...params,
      number: String(params.number),
    }),
  },
  beforeLoad: ({ context, params, ...load }) =>
    enterRepository(
      context,
      params,
      load,
      () => context.pulls.actions.warm(params.owner, params.repo),
      () => context.pulls.actions.open(params.owner, params.repo, params.number, params.tab),
    ),
})

/**
 * `/$owner/$repo/settings`: the repository's settings, for a Maintainer or Admin (decision 0039): its custom domains,
 * which sync while the page shows. Anyone else sees the page's header alone, and ChatApi gives them no rows.
 */
const repoSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/settings",
  component: RepoSettingsScreen,
  beforeLoad: ({ context, params, ...load }) =>
    enterRepository(context, params, load, local, () => context.domains.actions.open(params.owner, params.repo)),
})

/**
 * `/$owner/$repo/stack`: the repository's stack of TODOs (decision 0016 §4), as GitHub's issue list: the open TODOs in
 * merge order, or with `?state=closed` the merged and dropped ones.
 */
const stackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/stack",
  component: StackScreen,
  validateSearch: (search: Record<string, unknown>): { readonly state?: StackFilter } =>
    stackFilterOf(search.state) === "closed" ? { state: "closed" } : {},
  beforeLoad: ({ context, params, ...load }) =>
    enterRepository(context, params,
      load,
      () => context.todos.actions.warm(params.owner, params.repo),
      () => context.todos.actions.open(params.owner, params.repo),
    ),
})

/** `/$owner/$repo/stack/$number`: TODO `T<number>`'s page, as GitHub's issue page; any other `$number` matches no route. */
const todoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/stack/$number",
  component: TodoScreen,
  params: {
    parse: (params) => {
      const number = todoNumberOf(params.number)
      return number === undefined ? false : { ...params, number }
    },
    stringify: (params) => ({ ...params, number: String(params.number) }),
  },
  beforeLoad: ({ context, params, ...load }) =>
    enterRepo(
      context,
      params,
      load,
      () => context.todos.actions.warm(params.owner, params.repo),
      () => context.todos.actions.open(params.owner, params.repo, params.number),
    ),
})

/**
 * `/$owner/$repo/settings/secrets`: the repository's secrets by name, for a Member or above; an Admin adds, rotates and
 * deletes them (docs/features/secrets.md#the-secrets-page).
 */
const secretsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$owner/$repo/settings/secrets",
  component: SecretsScreen,
  beforeLoad: ({ context, params, ...load }) =>
    enterRepository(context, params,
      load,
      () => context.secrets.actions.warm(params.owner, params.repo),
      () => context.secrets.actions.open(params.owner, params.repo),
    ),
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    landingRoute,
    appRoute,
    viewRoute,
    flowsRoute,
    flowsAliasRoute,
    newFlowRoute,
    draftRoute,
    codeRoute,
    runsRoute,
    conversationsRoute,
    runRoute,
    settingsRoute,
    pluginIndexRoute,
    pluginPathRoute,
    repoSettingsRoute,
    repoRoute,
    treeRoute,
    blobRoute,
    branchesRoute,
    rawRoute,
    docsRoute,
    docsPageRoute,
    issuesRoute,
    newIssueRoute,
    issueRoute,
    pullsRoute,
    actionsRoute,
    actionRunRoute,
    pullRoute,
    pullTabRoute,
    stackRoute,
    todoRoute,
    secretsRoute,
  ]),
  // A page that fails to load or render shows Retry in the shell; React reports the error (main.tsx).
  defaultErrorComponent: RouteError,
  // A link's hover or focus preloads its page: its route's `beforeLoad` warms what it shows (`enter`).
  defaultPreload: "intent",
  defaultPreloadDelay: PRELOAD_DELAY_MS,
  // main.tsx's `RouterProvider` gives the real one before the first load.
  context: {
    repo: undefined!,
    home: undefined!,
    docs: undefined!,
    views: undefined!,
    branch: undefined!,
    terminal: undefined!,
    issues: undefined!,
    pulls: undefined!,
    todos: undefined!,
    plugins: undefined!,
    runs: undefined!,
    flows: undefined!,
    domains: undefined!,
    secrets: undefined!,
  },
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
