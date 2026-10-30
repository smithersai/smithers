import * as PinSteps from "../features/pins/steps"
import { FlowRegistry } from "./registry"
import * as Timeline from "../features/timeline/steps"
import { Action } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Layer } from "effect"
import { AnswerApi } from "../features/agent/answers"
import * as AgentHost from "../features/agent/host"
import * as Attention from "../features/attention/steps"
import * as AuthSteps from "../features/auth/steps"
import * as ConversationSteps from "../features/conversations/steps"
import * as BranchSteps from "../features/branch/steps"
import * as PublishSteps from "../features/branch/publishSteps"
import * as ChatSteps from "../features/chat/steps"
import * as PersonalFlows from "../features/flows-ui/steps"
import * as Issues from "../features/issues/steps"
import * as Jev from "../features/jev/steps"
import * as Files from "../features/files/flows"
import * as Navigation from "../features/navigation/flows"
import { RepoClient, REQUEST_WITHIN } from "../features/repo/api"
import { TabClipboard } from "../features/repo/copy"
import * as Repo from "../features/repo/steps"
import { RemoteRunsClient } from "../features/runs/api"
import * as Runs from "../features/runs/steps"
import * as SharingSteps from "../features/sharing/steps"
import * as SpendSteps from "../features/spend/steps"
import * as BugSteps from "../features/bugs/steps"
import { BugTabs } from "../features/bugs/flows"
import * as DomainSteps from "../features/domains/steps"
import * as FeedSteps from "../features/feeds/steps"
import * as PersonalModelSteps from "../features/personal-model/steps"
import { RunsClient } from "../features/status/api"
import * as Status from "../features/status/flows"
import * as TerminalSteps from "../features/terminal/steps"
import * as SandboxSteps from "../features/sandbox/steps"
import { RunReporter } from "../features/status/reporter"
import * as Theme from "../features/theme/flows"
import * as TodoSteps from "../features/todos/steps"
import { ViewsClient } from "../features/views/api"
import * as ViewSteps from "../features/views/steps"
import { PreviewClient } from "../features/web/api"
import * as WebPages from "../features/web/steps"
import { DocsClient } from "../features/docs/api"
import * as DocsSearch from "../features/docs/steps"
import * as RunCredentials from "./credentials"
import { clientFlows } from "./declarations"
import { type Endpoint, TabPort } from "./tabPort"

// Every client flow's registration (docs/features/flows.md#the-engine-and-the-tab-port): what the leader tab's engine
// worker (src/flows/engine.worker.ts) and a Node or Bun host register alike. It imports the agent's implementation, so
// only an engine's host imports this module, never the tab (src/flows/tab.test.ts).

/**
 * The repository flows: the reads (`repo/tree`, `repo/read`, `repo/refs`, `repo/about`) over RepoApi's GET routes on `origin`
 * (src/features/repo/reader.ts), `repo/clone` asking RepoApi's `POST /api/repos`, and `repo/copy`, all through the
 * host's `HttpClient`: the device never holds the Code Storage key. Needs the host's `TabClipboard`, where a copy goes.
 */
export const repoFlows = (origin: string) =>
  Repo.registration.pipe(Layer.provide(RepoClient.layer({ origin, within: REQUEST_WITHIN })))

/**
 * `app/web/open`, checking each page and adding its views through ChatApi on `origin` (src/features/web/api.ts,
 * src/features/views/api.ts) and opening only what the policy allows: `http:` on this machine only when `localHttp`
 * (development), never the app's own origin.
 */
export const webPages = (origin: string, localHttp: boolean) =>
  WebPages.registration.pipe(
    Layer.provide(PreviewClient.layer({ origin })),
    Layer.provide(ViewsClient.layer({ origin })),
    Layer.provide(WebPages.WebPolicy.layer({ localHttp, appOrigin: origin })),
  )

/**
 * `app/docs/search`, searching a repository's docs and adding its pages as views through ChatApi on `origin`
 * (src/features/docs/api.ts, src/features/views/api.ts).
 */
export const docsSearch = (origin: string) =>
  DocsSearch.registration.pipe(
    Layer.provide(DocsClient.layer({ origin })),
    Layer.provide(ViewsClient.layer({ origin })),
  )

/** What every host's registrations take: the agent's host options, and whether `http:` pages on this machine open. */
export interface HostOptions extends AgentHost.HostOptions {
  /** Whether `app/web/open` opens `http:` pages on this machine: development only. Default `false`. */
  readonly localHttp?: boolean
  readonly summaryModel?: import("@smthrs/model").Model.Model
  /** The renderer's model in place of the endpoint's `renderer` role: only the end-to-end tests' scripted agent. */
  readonly rendererModel?: import("@smthrs/model").Model.Model
}

/**
 * `ui/form`, `ui/render` and `view/set-state` (docs/features/views.md): views added and moved through ChatApi on
 * `origin`, written by the model endpoint's `renderer` role (or `rendererModel`).
 */
export const views = (origin: string, rendererModel?: import("@smthrs/model").Model.Model) =>
  ViewSteps.registration.pipe(
    Layer.provide(ViewsClient.layer({ origin })),
    Layer.provide(ViewSteps.RendererSeat.layer(origin, rendererModel)),
  )

/** Jev's flows, `app/jev/classify` and `app/jev/evaluate`, judging through the model endpoint's `judge` role on `origin`. */
export const jev = (origin: string) => Jev.registration.pipe(Layer.provide(Jev.JudgeSeat.layer(origin)))

/**
 * Every client flow, registered with its steps: sign-in's refresh, the theme's, navigation's, web pages', docs search's,
 * the agent's, the repository's, Jev's, agent status's, your own flows', the acts on runs, the issue writes, chat's Copy
 * and Edit, the feed's, spend alerts' channels, custom domains' writes, a person's own model's test and remove, and bug
 * reports.
 * Needs the host's `FlowRuntime`, `Crypto`, `HttpClient` and `RunInspection`, the theme's `Preferences`, navigation's
 * `Tabs`, file tabs' `FileTabsTabs`, the repository's `TabClipboard`, the issues' `TabIssues`, the TODOs' `TabTodos`,
 * chat's `TabChat`, sign-in's `TabSession` and bug reports' `BugTabs`.
 */
export const registrations = (options: HostOptions) =>
  Layer.mergeAll(
    Timeline.registration.pipe(Layer.provide(Layer.merge(
      Timeline.SummarySeat.layer(options.origin, options.summaryModel), Timeline.SummaryLedger.layer(options.origin),
    ))),
    AuthSteps.registration,
    Theme.registration,
    Navigation.registration,
    Files.registration,
    webPages(options.origin, options.localHttp ?? false),
    docsSearch(options.origin),
    views(options.origin, options.rendererModel),
    AgentHost.layer(options),
    repoFlows(options.origin),
    jev(options.origin),
    Status.registration,
    PersonalFlows.layer(options.origin),
    // Stop on a repository's run goes to ChatApi, which its Durable Object answers (docs/features/actions.md#acts).
    Runs.registration.pipe(
      Layer.provide(AnswerApi.layerHttp(options.origin)),
      Layer.provide(RemoteRunsClient.layer({ origin: options.origin, within: REQUEST_WITHIN })),
    ),
    BranchSteps.registrationAt(options.origin),
    PublishSteps.registrationAt(options.origin),
    ConversationSteps.registrationAt(options.origin),
    SharingSteps.registrationAt(options.origin),
    TerminalSteps.registrationAt(options.origin),
    SandboxSteps.registrationAt(options.origin),
    Issues.registration,
    TodoSteps.registrationAt(options.origin),
    ChatSteps.registration,
    PinSteps.registrationAt(options.origin),
    Attention.registrationAt(options.origin),
    SpendSteps.registrationAt(options.origin),
    DomainSteps.registrationAt(options.origin),
    PersonalModelSteps.registrationAt(options.origin),
    BugSteps.registrationAt(options.origin),
    FeedSteps.registrationAt(options.origin),
  ).pipe(Layer.provide(FlowRegistry.layer), Layer.provide(statusReports(options.origin)), Layer.provideMerge(Action.layerImplementations))

/**
 * Where runs report their status and people's answers are recorded (docs/features/agent-status.md): ChatApi's runs
 * routes on `origin`, through the host's `HttpClient`. One reporter for every flow, so a run's repeated report is sent
 * once.
 */
export const statusReports = (origin: string) =>
  RunReporter.layer.pipe(Layer.provideMerge(RunsClient.layer({ origin })))

/** What the engine worker's registrations take: the host's options, and the engine's name. */
export interface WorkerOptions extends HostOptions {
  /** The engine's name (`ENGINE_NAME` in a browser): navigation asks its tabs on `<name>/navigate`. */
  readonly name: string
}

/**
 * What the engine worker registers: every client flow, its requests sent as the run that made them
 * (src/flows/credentials.ts), with this device's preferences written by the tab that started the worker, reached
 * through the worker's own global `scope` (src/flows/tabPort.ts), and navigation, file tabs, copies, issue writes and chat's Copy
 * and Edit asking the tab that started each request over the engine's channels (src/flows/askingTab.ts). Needs
 * the host's `FlowRuntime`, `Crypto` and `HttpClient`, which `BrowserRuntime` provides.
 */
export const workerRegistrations = (scope: Endpoint, options: WorkerOptions) =>
  registrations(options).pipe(
    // Every request a run makes to ChatApi goes as that run: the person's session only for their own press, else the
    // run's credential (decision 0017 slice 0).
    Layer.provide(RunCredentials.layer({ origin: options.origin, name: options.name, flows: clientFlows }).pipe(Layer.provide(FlowRegistry.layer))),
    Layer.provide(Theme.workerPreferences),
    Layer.provide(TabPort.layer(scope)),
    Layer.provide(Navigation.Tabs.layerChannel({ name: options.name, origin: options.origin })),
    Layer.provide(Files.FileTabsTabs.layerChannel({ name: options.name })),
    Layer.provide(TabClipboard.layerChannel({ name: options.name, origin: options.origin })),
    Layer.provide(Issues.TabIssues.layerChannel({ name: options.name })),
    Layer.provide(TodoSteps.TabTodos.layerChannel({ name: options.name })),
    Layer.provide(Runs.TabRuns.layerChannel({ name: options.name })),
    Layer.provide(ChatSteps.TabChat.layerChannel({ name: options.name })),
    Layer.provide(AuthSteps.TabSession.layerChannel({ name: options.name })),
    Layer.provide(BugTabs.layerChannel({ name: options.name })),
    Layer.provide(TabChannel.layer),
  )
