import { FlowRegistry } from "./flows/registry"
import { FetchFailures, LogFailures, Otlp } from "@smthrs/observability"
import { Persistence } from "@smthrs/effect-tanstack-db"
import {
  type BrowserEngine,
  type BrowserLanguageServer,
  type StoragePersistence,
  TabChannel,
} from "@smthrs/platform-browser"
import type { BrowserWASQLiteDatabase } from "@tanstack/browser-db-sqlite-persistence"
import { Clock, type Duration, Effect, Fiber, Layer, ManagedRuntime, Metric } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { Clipboard } from "./clipboard"
import { AuthClient } from "./features/auth/api"
import { Attention, type AttentionView } from "./features/attention/attention"
import { AttentionNavigation, AttentionStore } from "./features/attention/store"
import { Auth, bindSessionConnectivity, type AuthView } from "./features/auth/auth"
import { Branch, type BranchView } from "./features/branch/branch"
import { BranchStore } from "./features/branch/store"
import { DeviceWipe } from "./features/auth/device"
import { AuthStore, signedOut } from "./features/auth/store"
import { ChatClient } from "./features/chat/api"
import { Chat, type ChatView } from "./features/chat/chat"
import { bindConnectivity } from "./features/chat/connectivity"
import { QUESTIONS_ROUTE, TELEMETRY_ROUTE } from "./features/chat/contract"
import { storagePersisted } from "./features/chat/metrics"
import { chatShortcuts } from "./features/chat/shortcuts"
import { buttonShortcuts } from "./features/keys/keys"
import { tabSession } from "./features/auth/tab"
import { tabChat } from "./features/chat/tab"
import { type ChatConfig, type ChatHost, ChatStore, chatConfig } from "./features/chat/store"
import { CodeIntel, type CodeIntelView } from "./features/code-intel/codeIntel"
import { LanguageServers } from "./features/code-intel/session"
import { CodeIntelStore } from "./features/code-intel/store"
import { Commands, type CommandsView } from "./features/commands/commands"
import { FlowsUi, type FlowsUiView } from "./features/flows-ui/flowsUi"
import { FlowsUiStore } from "./features/flows-ui/store"
import { DocsClient } from "./features/docs/api"
import { Docs, type DocsView } from "./features/docs/docs"
import { DocsStore } from "./features/docs/store"
import { Home, type HomeView } from "./features/home/home"
import { HomeClient } from "./features/home/api"
import { HomeStore } from "./features/home/store"
import { CommandsStore } from "./features/commands/store"
import { IssuesClient } from "./features/issues/api"
import { Issues, type IssuesLayer } from "./features/issues/issues"
import { IssuesStore } from "./features/issues/store"
import { tabIssues } from "./features/issues/tab"
import { IssueWrites } from "./features/issues/writes"
import { PullsClient } from "./features/pulls/api"
import { Pulls, type PullsLayer } from "./features/pulls/pulls"
import { PullsStore } from "./features/pulls/store"
import { StackClient } from "./features/todos/api"
import { TodosStore } from "./features/todos/store"
import { tabTodos } from "./features/todos/tab"
import { Todos, type TodosView } from "./features/todos/todos"
import { StackWrites } from "./features/todos/writes"
import { TextsClient } from "./features/coedit/api"
import * as SharedPromptLayer from "./features/coedit/prompt"
import { CoeditStore } from "./features/coedit/store"
import { TextWrites } from "./features/coedit/writes"
import { tabNavigation } from "./features/navigation/tab"
import { FilesPage } from "./features/files/actions"
import { Files, type FilesView } from "./features/files/files"
import { FilesStore } from "./features/files/store"
import { tabFiles } from "./features/files/tab"
import { tabDoors } from "./flows/doors"
import { RepoClient, REQUEST_WITHIN } from "./features/repo/api"
import { tabClipboard } from "./features/repo/tab"
import { Repo, type RepoView } from "./features/repo/repo"
import { RepoStore } from "./features/repo/store"
import { RunsNavigation } from "./features/runs/actions"
import { Runs, type RunsView } from "./features/runs/runs"
import { RemoteRunsClient } from "./features/runs/api"
import { RunSteers, tabRuns } from "./features/runs/steers"
import { RunsStore } from "./features/runs/store"
import { SteerWrites } from "./features/runs/writes"
import { Status, type StatusView } from "./features/status/status"
import { Terminal, type TerminalView } from "./features/terminal/terminal"
import { StatusStore, TabTitle } from "./features/status/store"
import { SecretsClient } from "./features/secrets/api"
import { Secrets, type SecretsLayer } from "./features/secrets/secrets"
import { SecretsStore } from "./features/secrets/store"
import { Spend, type SpendView } from "./features/spend/spend"
import { pluginKeys } from "./plugins/keymap"
import { Plugins } from "./plugins/plugins"
import { PluginsUi, type PluginsView } from "./plugins/ui"
import { SpendStore } from "./features/spend/store"
import { BugsStore } from "./features/bugs/store"
import { tabBugContext } from "./features/bugs/tab"
import { Domains, type DomainsView } from "./features/domains/domains"
import { PersonalModelClient } from "./features/personal-model/api"
import { PersonalModel, type PersonalModelView } from "./features/personal-model/personalModel"
import { PersonalModelStore } from "./features/personal-model/store"
import { type ThemeHost, ThemeStore } from "./features/theme/store"
import { Theme, type ThemeView } from "./features/theme/theme"
import { embedsLayer } from "./features/views/embeds"
import { ViewsStore } from "./features/views/store"
import { Views, type ViewsView } from "./features/views/views"
import { type WebHost, WebTab } from "./features/web/actions"
import { Web, type WebView } from "./features/web/web"
import { type ClientEngine, FlowDispatch } from "./flows/dispatch"
import { TabErrors } from "./flows/errors"
import { failFastOnEngine, tabAnswers, tabEngine } from "./flows/engine"
import type { Endpoint } from "./flows/tabPort"
import { deviceRegistry } from "./device/registry"
import { Page } from "./page"
import { apiRoute } from "./apiRoutes"
import { recordUnhandled } from "./boundary"
import { markStage, recordStages, type Timeline } from "./bootStages"
import { codeOf } from "./errorCode"
import type { HostRecord, HostRecords } from "./hostRecords"
import { BROWSER_TELEMETRY, EXPORTED_SPANS, TELEMETRY_LIMITS, WEB_SERVICE } from "./telemetry"

/** From the page's start to the conversation shown from the device (`performance.timeOrigin` to restored). */
export const bootTime = Metric.histogram("smithers_web_boot_ms", {
  description: "Milliseconds from page start to the conversation restored from the device",
  boundaries: Metric.exponentialBoundaries({ start: 50, factor: 2, count: 10 }),
})

/**
 * What the device keeps and how it sends: the device store (`Persistence.layer`'s options: the database, the
 * persistence over it and the coordinator between tabs), chat's host (the outbox's entry point, storage, network
 * detector and lock service, and whether the browser is online), the request for persistent storage, the page the
 * theme paints, the clipboard, and this tab's engine worker. main.tsx gives the browser's; a test gives Node's.
 */
export interface Host extends ChatHost {
  readonly persistence: Persistence.Options<BrowserWASQLiteDatabase>
  /** One tab's stable, locally claimed editor identity across reloads. */
  readonly editorTabId: string
  /** False when the tab id cannot survive reload; editors refuse writes. */
  readonly editorTabPersistent: boolean
  /** Why the tab id can't survive reload, when it can't: `flows.editor.storage` logs it. */
  readonly editorTabRefusal?: string
  /** Asks the browser to keep this site's storage: `@smthrs/platform-browser`'s `StoragePersistence`. */
  readonly storage: StoragePersistence.Service
  /** Where the theme paints, mirrors and reads the system's mode (src/features/theme/store.ts). */
  readonly theme: ThemeHost
  /** Writes `text` to the system clipboard: `repo/copy` and `chat/copy`, in the tab that asked (src/clipboard.ts). */
  readonly clipboard: (text: string) => Promise<void>
  /** The tab's title, which agent status counts open questions in (`document.title`); none unless set. */
  readonly title?: TabTitle["Service"]
  /** Takes this tab to `path`, an app path: the router's `navigate` (src/features/navigation/tab.ts). */
  readonly navigate: (path: string) => void | Promise<void>
  /** Opens this tab’s route again after reconnecting. */
  readonly reopenRoute: () => void
  /** The router location: files open in the repository this page names. */
  readonly pathname?: () => string
  /** Hears each page the router shows, until the returned function stops it: a bug report names the page before its form. */
  readonly pages?: (listener: (path: string) => void) => () => void
  /** The build this tab runs (`version.json`'s), which a bug report carries; `dev` unless the build names one. */
  readonly build?: string
  /** The browser and the window's size, as `1280x800`, which a bug report carries. */
  readonly screen?: () => { readonly browser: string; readonly viewport: string }
  /** Which outside pages open, and a tab opened from the person's own click or key (src/features/web/actions.ts). */
  readonly web: WebHost
  /**
   * Starts a language server's worker (src/features/code-intel/language.worker.ts) for the repository view's code; a
   * host without one has no code intelligence.
   */
  readonly codeIntelWorker?: () => BrowserLanguageServer.WorkerLike
  /** Starts this tab's engine worker (src/flows/engine.worker.ts), which runs every client flow once it leads. */
  readonly engineWorker: () => BrowserEngine.WorkerLike & Endpoint
  /** The engine's name: its Web Lock, channel and store. `ENGINE_NAME` in the browser; a test names its own. */
  readonly engineName: string
  /**
   * Wipes what this device holds of a session that ended: its synced database, the engine's store and the outbox
   * (decision 0008 §4.6). Sign-out calls it once ChatApi has ended the session (src/features/auth/device.ts).
   */
  readonly wipe: () => Promise<void>
}

/**
 * What the browser's services are built from: ChatApi's `origin`, the page's `fetch` and `reload`, the host, how long
 * ChatApi gets to answer a question (default 15 s), and chat's settings.
 */
export interface AppOptions extends Omit<ChatConfig, "shapeUrl"> {
  readonly origin: string
  readonly fetch: typeof globalThis.fetch
  readonly reload: () => void
  readonly host: Host
  readonly answerWithin?: Duration.Input
}

/**
 * The real services the browser reaches ChatApi through: chat's client and sign-in's, each with `answerWithin`
 * (default 15 s) for a whole request. Electric's shape source needs no layer.
 */
export const realServices = (options: Pick<AppOptions, "origin" | "answerWithin">) => {
  const within = options.answerWithin ?? "15 seconds"
  return Layer.merge(
    ChatClient.layer({ url: `${options.origin}${QUESTIONS_ROUTE}`, within }),
    AuthClient.layer({ origin: options.origin, within }),
  )
}

/**
 * The browser's services: the chat, sign-in, theme, repository and slash-command layers; the command menu's store over
 * chat's composer; chat's store over the device store, which dispatches each question it sends to this device's agent;
 * the repository store, which reads who is signed in from sign-in's store; dispatch over this tab's engine (its worker,
 * `host.engineWorker`, started before the device store opens); the tab's answers to its worker; the theme's store;
 * RepoApi's client (`REQUEST_WITHIN` for a whole request) and the host's clipboard; the page; and telemetry exported
 * over OTLP to ChatApi's relay (`/api/telemetry`), which every Effect log, span and metric goes through. Every request
 * goes through `fetch`. `services` is how the browser reaches ChatApi and Electric: `realServices`, or, for a test of
 * an unhappy path or the end-to-end entry (`/app?faults`, src/test/e2e.ts), faulty ones (src/test/faults.ts), which may
 * also put this tab's engine (`ClientEngine`) behind a switch.
 */
export const appLayer = <S = never>(
  options: AppOptions,
  services: Layer.Layer<ChatClient | AuthClient | S, never, HttpClient.HttpClient | ClientEngine>,
) => {
  const { origin, reload, host, fetch: _fetch, answerWithin: _answerWithin, ...chat } = options
  // Sign-in, and this tab's answers to the `auth/refresh` it starts when a session check fails: both check the session,
  // which may wipe the device. Beside them, which door this tab's runs came through, so only the person's own press
  // runs with their session, and whether sign-in's row says nobody is signed in, so no run asks for a credential the
  // server would refuse.
  const auth = Layer.mergeAll(
    Auth.layer,
    tabSession({ name: host.engineName }).pipe(Layer.provide(TabChannel.layer)),
    tabDoors({ name: host.engineName, signedOut }).pipe(Layer.provide(TabChannel.layer)),
  ).pipe(Layer.provideMerge(DeviceWipe.layer(host.wipe)))
  return Layer.mergeAll(
    Chat.layer,
    auth,
    Theme.layer,
    Repo.layer,
    // File tabs (docs/features/files.md): this device's open files over the repository view, and this tab's answers to
    // the `file/open` and `file/close` steps it started.
    Files.layer.pipe(
      Layer.provideMerge(tabFiles({ name: host.engineName }).pipe(Layer.provide(TabChannel.layer))),
      Layer.provideMerge(FilesStore.layer),
      Layer.provideMerge(
        FilesPage.layer({ navigate: host.navigate, ...(host.pathname === undefined ? {} : { pathname: host.pathname }) }),
      ),
    ),
    // Code intelligence on the repository view's TypeScript and JavaScript (docs/features/code-intelligence.md).
    CodeIntel.layer.pipe(
      Layer.provide(CodeIntelStore.layer),
      Layer.provide(
        host.codeIntelWorker === undefined ? LanguageServers.layerNone : LanguageServers.layerBrowser(host.codeIntelWorker),
      ),
    ),
    // A repository's home (decision 0014 §4), over the repository store, RepoApi's client and ChatApi's home route, and
    // the issues', TODOs' and agent status's stores for its live blocks.
    Home.layer.pipe(Layer.provide(HomeStore.layer)),
    // A repository's docs (docs/features/docs.md): the Docs tab, over ChatApi's docs routes.
    Docs.layer.pipe(Layer.provide(DocsStore.layer)),
    Commands.layer,
    Views.layer,
    // The repository and issues views in the conversation the tab shows: what each renders, loaded as it arrives.
    embedsLayer,
    Web.layer,
    // Agent status, and the personal feed beside it (decision 0009): the one toast stack and the list behind `+N`.
    Layer.merge(Status.layer, Attention.layer),
    // Model spend alerts, which only an Admin's devices sync (docs/features/spend-alerts.md).
    Spend.layer.pipe(Layer.provideMerge(SpendStore.layer({ origin }))),
    // A repository's custom domains, which only a Maintainer's or Admin's Settings page syncs (docs/features/domains.md).
    Domains.layer({ origin }),
    // The branch workspace (docs/features/branch-workspace.md): the route's branch, who it is shared with, who is on it,
    // and its terminal.
    Branch.layer({ origin, reopenRoute: host.reopenRoute }),
    Terminal.layer({ origin }),
    // Git issues (decision 0012): the issue pages, and this tab's answers to the issue writes' steps it started.
    Issues.layer,
    // Pull requests (decision 0012 §6): the list and one pull request's tabs, over the issues' store, and a person's
    // merge and a comparison's files through ChatApi (`PullsClient`, below).
    Pulls.layer.pipe(Layer.provide(PullsStore.layer({ origin }))),
    // The plugin host (decision 0017): the built-in plugins, loaded through the public loader, and the one contract,
    // PluginHost, each plugin's tab reads and acts through (src/plugins/).
    PluginsUi.layer,
    // A repository's secrets (docs/features/secrets.md#the-secrets-page): their names, and an Admin's writes straight to
    // ChatApi (`SecretsClient`, below), never through the outbox, which would keep a value on the device.
    Secrets.layer.pipe(Layer.provideMerge(SecretsStore.layer({
      origin,
      ...(chat.confirmWithin === undefined ? {} : { confirmWithin: chat.confirmWithin }),
    }))),
    // A person's own models (docs/features/personal-model.md): their keys' rows, synced once they are signed in, and
    // their own Save straight to ChatApi (`PersonalModelClient`, below), never through the outbox, which would keep a
    // key on the device. Test and Remove are flows.
    PersonalModel.layer.pipe(Layer.provideMerge(PersonalModelStore.layer({
      origin,
      ...(chat.confirmWithin === undefined ? {} : { confirmWithin: chat.confirmWithin }),
    }))),
    tabIssues({ name: host.engineName }).pipe(Layer.provide(TabChannel.layer)),
    // TODOs and the stack (decision 0016): the stack pages, the drafts, and this tab's answers to the TODO steps it
    // started.
    Todos.layer,
    tabTodos({ name: host.engineName }).pipe(Layer.provide(TabChannel.layer)),
    // Chat's Copy and Edit, answered by the tab that asked, from its conversation, clipboard and composer.
    tabChat({ name: host.engineName }).pipe(Layer.provide(TabChannel.layer)),
    // Steering a TODO's agent (docs/features/runs.md#steering): this tab's answers to the steer steps it started, which
    // put the message in the device's outbox.
    tabRuns({ name: host.engineName }).pipe(Layer.provideMerge(RunSteers.layer), Layer.provide(TabChannel.layer)),
    // Your own flows and this device's runs (decision 0014): their pages, and the router's navigate their acts open.
    Layer.merge(Runs.layer.pipe(Layer.provide(RunsStore.layer({ origin }))), FlowsUi.layer.pipe(Layer.provide(FlowsUiStore.layer({
      origin,
      editorTabId: host.editorTabId,
      editorTabPersistent: host.editorTabPersistent,
      ...(host.editorTabRefusal === undefined ? {} : { editorTabRefusal: host.editorTabRefusal }),
      ...(chat.confirmWithin === undefined ? {} : { confirmWithin: chat.confirmWithin }),
    }))))
      .pipe(Layer.provide(Layer.succeed(RunsNavigation, RunsNavigation.of({
        navigate: host.navigate,
        ...(host.pathname === undefined ? {} : { pathname: host.pathname }),
      })))),
  ).pipe(
    // The feed reads the conversation chat shows and who sign-in says is signed in, and opens an entry's page through
    // the router (decision 0009). Agent status, beside it, reads chat's messages beside the runs, and answers through
    // dispatch (decision 0015). The plugin host sits above agent status, whose open waits it serves as `core/waits`, and
    // below the composer's commands, which offer the plugins' slash commands (decision 0017).
    Layer.provideMerge(
      Plugins.layer().pipe(
        // The bug reports the viewer may see, which the host serves as `core/bug-reports` (docs/features/bugs.md).
        Layer.provideMerge(BugsStore.layer({ origin })),
        Layer.provideMerge(
          AttentionStore.layer({ origin }).pipe(
            Layer.provideMerge(Layer.succeed(AttentionNavigation, AttentionNavigation.of({ navigate: host.navigate }))),
            Layer.provideMerge(
              StatusStore.layer({ origin }).pipe(Layer.provideMerge(Layer.succeed(TabTitle, host.title ?? TabTitle.none))),
            ),
          ),
        ),
      ),
    ),
    // The command menu completes chat's composer draft, which is the shown conversation's shared prompt: co-editing
    // (docs/features/coedit.md) sits between chat's store, whose outbox sends its updates, and the menu.
    Layer.provideMerge(
      CommandsStore.layer.pipe(
        Layer.provideMerge(SharedPromptLayer.layer.pipe(Layer.provideMerge(CoeditStore.layer({ origin })))),
      ),
    ),
    // Chat's store, between the issues' and the TODOs' two: an issue write, a change to a stack or a steer goes through
    // the device's one outbox, which chat's store builds over the writes below it hand over (src/outbox.ts) and leads
    // for the stores above it.
    Layer.provideMerge(
      Layer.merge(IssuesStore.layer({ origin }), TodosStore.layer({ origin })).pipe(
        Layer.provideMerge(ChatStore.layer(chatConfig(origin, chat), host)),
        Layer.provideMerge(StackWrites.layer),
        Layer.provideMerge(SteerWrites.layer),
        Layer.provideMerge(IssueWrites.layer),
        Layer.provideMerge(TextWrites.layer),
      ),
    ),
    // Below chat's store, whose conversation shows the views among the messages.
    Layer.provideMerge(ViewsStore.layer({ origin })),
    Layer.provideMerge(Layer.succeed(WebTab, host.web)),
    Layer.provideMerge(RepoStore.layer({ origin })),
    // Below the repository store, which shows the sign-in link in Clone's place from sign-in's row; beside it, the
    // branch this tab's route shows: the branch layer's, and the composer's, whose `/new` starts a conversation in its
    // repository (src/features/commands/actions.ts).
    Layer.provideMerge(Layer.merge(AuthStore.layer, BranchStore.layer)),
    // Above dispatch, which remembers this tab's requests and runs: `app/navigate` moves only the tab that asked,
    // `repo/copy` writes only its clipboard, and a bug report reads only its page and runs. The door each run came
    // through is answered with sign-in, above (`auth`).
    Layer.provideMerge(
      Layer.mergeAll(
        tabNavigation({ name: host.engineName, origin, navigate: host.navigate }),
        tabClipboard({ name: host.engineName }),
        // What this tab shows, which only it answers a bug report's step with (docs/features/bugs.md).
        tabBugContext({
          name: host.engineName,
          build: host.build ?? "dev",
          ...(host.pathname === undefined ? {} : { pathname: host.pathname }),
          ...(host.pages === undefined ? {} : { pages: host.pages }),
          ...(host.screen === undefined ? {} : { screen: host.screen }),
        }),
      ).pipe(Layer.provide(TabChannel.layer)),
    ),
    Layer.provideMerge(FlowDispatch.layer.pipe(Layer.provide(FlowRegistry.layer))),
    Layer.provideMerge(tabAnswers),
    Layer.provideMerge(ThemeStore.layer(host.theme)),
    Layer.provideMerge(services),
    // Below `services`, so a test's services may give a faulty `IssuesClient`, `StackClient`, `PullsClient`,
    // `SecretsClient` or `PersonalModelClient` in its place.
    Layer.provideMerge(
      Layer.mergeAll(
        IssuesClient.layer({ origin, within: REQUEST_WITHIN }),
        PullsClient.layer({ origin, within: REQUEST_WITHIN }),
        SecretsClient.layer({ origin, within: REQUEST_WITHIN }),
        PersonalModelClient.layer({ origin, within: REQUEST_WITHIN }),
        StackClient.layer({ origin, within: REQUEST_WITHIN }),
        TextsClient.layer({ origin, within: REQUEST_WITHIN }),
        RepoClient.layer({ origin, within: REQUEST_WITHIN }),
        HomeClient.layer({ origin, within: REQUEST_WITHIN }),
        DocsClient.layer({ origin }),
        // A TODO's run, read from Cloudflare (ruling TODO-3).
        RemoteRunsClient.layer({ origin, within: REQUEST_WITHIN }),
      ),
    ),
    Layer.provideMerge(Clipboard.layer(host.clipboard)),
    // The device store opens through the leading tab's engine worker; if this tab's worker fails, it opens in memory
    // at once instead of waiting for a leader that will never answer.
    // Every persisted collection must be one the device's registry declares, at its version (decision 0021). One tab
    // stores what each synced collection syncs: the one holding its lock on the host's lock service (decision 0002 §1).
    Layer.provideMerge(
      Layer.unwrap(
        Effect.map(failFastOnEngine({ ...host.persistence, registry: deviceRegistry, lock: host.lock }), Persistence.layer),
      ),
    ),
    // Built before the device store: the leading tab's engine worker serves the store's SQLite, so this tab starts
    // its worker first.
    Layer.provideMerge(tabEngine(host.engineWorker, host.engineName)),
    Layer.provideMerge(Page.layer(reload)),
    Layer.provide(FetchHttpClient.layer),
    // What went wrong in this tab lately, which a bug report carries (src/flows/errors.ts): the error records the
    // exporter relays, kept in a ring built on it, so it sees what the exporter sees.
    Layer.provideMerge(
      TabErrors.observing(new Set(BROWSER_TELEMETRY.records)).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            // Every request to the app's own /api/ that fails, Electric's shape requests the sync client sends again
            // included, logged once per run of failures and counted by route template, status class and whether it was a
            // retry (docs/observability.md#failed-requests). Above the exporter, which sends through the fetch below it.
            FetchFailures.layer({ route: apiRoute(origin) }),
            // Every line at Warn or above counted by record, code and feature, and the latest kept for a bug report.
            LogFailures.layer({ records: BROWSER_TELEMETRY.records }),
          ).pipe(
            // Only the spans the relay keeps: a tab's engine requests, hundreds per answer, stay in the tab.
            Layer.provideMerge(
              Otlp.layerFetch({
                baseUrl: `${origin}${TELEMETRY_ROUTE}`,
                serviceName: WEB_SERVICE,
                spans: EXPORTED_SPANS,
                ...TELEMETRY_LIMITS,
              }),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options.fetch)),
  )
}

/**
 * Logs what nothing caught on `target` (the window): an uncaught error or an unhandled rejection, by its name and,
 * for an error, where it was thrown. Never its message, which can quote what someone wrote. The listener runs its log
 * with the services it was bound with.
 */
export const logPageErrors = Effect.fnUntraced(function* (target: EventTarget) {
  const run = Effect.runSyncWith(yield* Effect.context<never>())
  const onError = (event: Event) => {
    const { error, reason, filename, lineno, colno } = event as Partial<ErrorEvent & PromiseRejectionEvent>
    const thrown: unknown = event.type === "error" ? error : reason
    const name = thrown instanceof Error ? thrown.name : typeof thrown
    run(
      Effect.logError(event.type === "error" ? "page error" : "unhandled rejection").pipe(
        Effect.annotateLogs({ name, ...(filename ? { source: `${filename}:${lineno}:${colno}` } : {}) }),
        Effect.annotateLogs({ feature: "app" }),
      ),
    )
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      target.addEventListener("error", onError)
      target.addEventListener("unhandledrejection", onError)
    }),
    () =>
      Effect.sync(() => {
        target.removeEventListener("error", onError)
        target.removeEventListener("unhandledrejection", onError)
      }),
  )
})

/** One record of the host's as a log line: never an error's message or a component's props. */
const logHostRecord = (record: HostRecord): Effect.Effect<void> => {
  switch (record._tag) {
    case "render":
      return Effect.logError("render error").pipe(Effect.annotateLogs({ boundary: record.boundary, name: record.name }))
    case "pwa.register":
      return Effect.logWarning("pwa.register").pipe(Effect.annotateLogs({ outcome: "failed", name: record.name }))
    case "pwa.install":
      return Effect.logWarning("pwa.install").pipe(Effect.annotateLogs({ outcome: "failed" }))
    case "pwa.update.check":
      return Effect.logWarning("pwa.update.check").pipe(Effect.annotateLogs({ outcome: "failed", trigger: record.trigger }))
    case "pwa.update":
      return (record.outcome === "activated" ? Effect.logInfo : Effect.logWarning)("pwa.update").pipe(
        Effect.annotateLogs({ outcome: record.outcome }),
      )
  }
}

/**
 * Logs what the page's host saw (src/hostRecords.ts): React's render errors as `render error`, and the service
 * worker's failed registration, install and update check and a reload an editor held back as `pwa.*`, those it saw
 * before the program started first. The listener runs each log with the services it was bound with.
 */
export const logHostRecords = Effect.fnUntraced(function* (records: HostRecords) {
  const run = Effect.runSyncWith(yield* Effect.context<never>())
  yield* Effect.acquireRelease(
    Effect.sync(() => records.listen((record) => run(logHostRecord(record).pipe(Effect.annotateLogs({ feature: "app" }))))),
    (stop) => Effect.sync(stop),
  )
})

/** Asks the browser to keep this site's storage, so it isn't cleared after days unused, and counts its answer. */
export const requestPersistentStorage = (storage: StoragePersistence.Service) =>
  storage.persist.pipe(
    Effect.map(String),
    Effect.flatMap((granted) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(storagePersisted, { granted }), 1),
        Effect.logInfo("persistent storage requested").pipe(Effect.annotateLogs({ granted, feature: "app" })),
      ),
    ),
  )

/**
 * Where the boot program renders and listens: the window, the page's start, and a renderer for the chat, sign-in,
 * theme, repository, slash-command, views, web-page, agent-status, branch, terminal and issues layers.
 */
export interface BootOptions {
  readonly target: EventTarget
  /** What the page's host saw go wrong, React's render errors and the service worker's, for the program to log. */
  readonly records?: HostRecords
  /** The page's start, in epoch milliseconds: `performance.timeOrigin`. */
  readonly startedAt: number
  /**
   * Where the boot's stages are marked and read (src/bootStages.ts): the page's `performance`. Without one, nothing
   * is marked or recorded.
   */
  readonly timeline?: Timeline
  /** Whether keys' `mod` is ⌘ (a Mac) rather than Ctrl. */
  readonly mac?: boolean
  readonly render: (
    chat: ChatView,
    auth: AuthView,
    theme: ThemeView,
    repo: RepoView,
    commands: CommandsView,
    views: ViewsView,
    web: WebView,
    status: StatusView,
    branch: BranchView,
    terminal: TerminalView,
    issues: IssuesLayer,
    runs: RunsView,
    flows: FlowsUiView,
    home: HomeView,
    spend: SpendView,
    attention: AttentionView,
    todos: TodosView,
    codeIntel: CodeIntelView,
    pulls: PullsLayer,
    plugins: PluginsView,
    files: FilesView,
    secrets: SecretsLayer,
    docs: DocsView,
    domains: DomainsView,
    personalModel: PersonalModelView,
  ) => void
}

/**
 * The browser program: logs page errors, renders with the chat, sign-in, theme, repository, slash-command, views and
 * web-page and agent-status layers, binds the chat keys and the browser's connectivity, asks to keep the device's storage, records how
 * long the conversation took to show from the device, then holds everything open until it is stopped.
 */
export const boot = (options: BootOptions & { readonly storage: StoragePersistence.Service }) =>
  Effect.gen(function* () {
    yield* logPageErrors(options.target)
    // Before the first render, whose errors React reports through them.
    if (options.records !== undefined) yield* logHostRecords(options.records)
    const chat = yield* Chat
    const auth = yield* Auth
    const theme = yield* Theme
    const repo = yield* Repo
    const commands = yield* Commands
    const views = yield* Views
    const web = yield* Web
    const status = yield* Status
    const branch = yield* Branch
    const terminal = yield* Terminal
    const issues = yield* Issues
    const runs = yield* Runs
    const flows = yield* FlowsUi
    const home = yield* Home
    const spend = yield* Spend
    const attention = yield* Attention
    const todos = yield* Todos
    const codeIntel = yield* CodeIntel
    const pulls = yield* Pulls
    const plugins = yield* PluginsUi
    const files = yield* Files
    const secrets = yield* Secrets
    const docs = yield* Docs
    const domains = yield* Domains
    const personalModel = yield* PersonalModel
    const store = yield* ChatStore
    yield* bindSessionConnectivity(options.target)
    const timeline = options.timeline
    if (timeline !== undefined) markStage(timeline, "services")
    yield* Effect.sync(() =>
      options.render(
        chat,
        auth,
        theme,
        repo,
        commands,
        views,
        web,
        status,
        branch,
        terminal,
        issues,
        runs,
        flows,
        home,
        spend,
        attention,
        todos,
        codeIntel,
        pulls,
        plugins,
        files,
        secrets,
        docs,
        domains,
        personalModel,
      )
    )
    if (timeline !== undefined) {
      markStage(timeline, "render")
      yield* recordStages(timeline)
    }
    yield* chatShortcuts(options.target)
    yield* buttonShortcuts(options.target)
    yield* pluginKeys(options.target, options.mac ?? false)
    yield* bindConnectivity(options.target)
    // One line for the device store's synced collections once each has taken its first role (writer or watcher),
    // instead of one per collection; each comes as soon as the lock answers, so this never waits on another tab.
    yield* Persistence.reportRoles
    yield* requestPersistentStorage(options.storage).pipe(Effect.forkScoped)
    yield* store.messages.restored.pipe(
      Effect.andThen(Clock.currentTimeMillis),
      Effect.flatMap((now) => Metric.update(bootTime, now - options.startedAt)),
      Effect.andThen(Effect.logInfo("chat ready")),
      Effect.catchTag("LoadFailed", (failure) =>
        Effect.logError("chat couldn't restore").pipe(Effect.annotateLogs({ errorCode: codeOf(failure.cause) }))
      ),
    )
    return yield* Effect.never
  }).pipe(Effect.scoped, Effect.annotateLogs({ feature: "app" }))

/**
 * The program's boundary, called once by main.tsx: builds the app's one runtime from `appLayer` and runs `boot` on it.
 * Every Effect in the app runs on this runtime, or with services taken from it. `services` is `realServices`, or
 * faulty ones, as in `appLayer`. Returns `stop`, which ends the program and closes the runtime, flushing telemetry, and `runtime`.
 */
export const start = <S = never>(
  options: AppOptions & BootOptions,
  services: Layer.Layer<ChatClient | AuthClient | S, never, HttpClient.HttpClient | ClientEngine>,
) => {
  const { target, startedAt, render, mac, timeline, records, ...app } = options
  const runtime = ManagedRuntime.make(appLayer(app, services))
  // Nothing awaits the program: a failure or defect that ends it is logged as `app.unhandled` (src/boundary.ts).
  const program = runtime.runFork(recordUnhandled(
    boot({
      target,
      startedAt,
      render,
      ...(mac === undefined ? {} : { mac }),
      ...(timeline === undefined ? {} : { timeline }),
      ...(records === undefined ? {} : { records }),
      storage: app.host.storage,
    }),
    "app",
    "fork",
  ))
  return { runtime, stop: () => runtime.runPromise(Fiber.interrupt(program)).then(() => runtime.dispose()) }
}
