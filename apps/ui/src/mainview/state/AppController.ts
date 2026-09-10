import { createGuideController } from "./controller/guide"
import type { CommandActions } from "../flows/Flows"
import { createActorBindings } from "./ActorBindings"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { RepositoryAccess } from "@smthrs/rpc/NativeRepository"
import { createCommandRegistry } from "../flows/Commands"
import type { CommandRegistry } from "../flows/Commands"
import type { CatalogItem } from "../flows/Commands"
import type { SlashItem, SlashRow } from "../flows/registry"
import { flowRequirements } from "../flows/registry"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { repoStep } from "../Onboarding"
import { localSocketProtocols } from "../runtime/LocalSession"
import type { FrameHistoryPort } from "../runtime/FrameHistory"
import type { AppTransition } from "./AppState"
import type { AppStore } from "./AppStore"
import { activeCatalogRepositoryId, activeRepositoryId, knownRepositories, resolveTargetRepo } from "./RepoContext"
import type { KnownRepositories } from "./RepoContext"
import { createPtyClient, pageSocketUrl } from "./PtyClient"
import { createSearchSeam } from "./seams/SearchSeam"
import type { PaletteAnswer, SearchSeam } from "./seams/SearchSeam"
import type { PtyClient } from "./PtyClient"
import { createLspClient } from "./LspClient"
import { createCloudLspClient, pageCloudLspSocketUrl } from "./CloudLspClient"
import { createCloudTerminalClient, pageCloudSocketUrl } from "./CloudTerminalClient"
import type { CloudTerminalClient } from "./CloudTerminalClient"
import { createTargetRunClient } from "./TargetRunClient"
import { createAppShellController } from "./controller/app"
import type { AppShellController } from "./controller/app"
import { createAccountController } from "./controller/account"
import type { AccountController } from "./controller/account"
import { createAuthBillingController } from "./controller/auth-billing"
import { createConnectorController } from "./controller/connectors"
import { createControllerContext } from "./controller/context"
import type { NetEntry } from "./controller/context"
import { createFailureController } from "./controller/failures"
import { createFramesController } from "./controller/frames"
import { createPluginsController } from "./controller/plugins"
import { createPresentationController } from "./controller/presentation"
import { createExplainController } from "./controller/explain"
import type { ExplainConfig, ExplainController } from "./controller/explain"
import { createRecommendController } from "./controller/recommend"
import type { RecommenderConfig } from "./controller/recommend"
import { createTabsController } from "./controller/tabs"
import { createAgentsController } from "./controller/agents"
import { createFormsController } from "./controller/forms"
import type { FormsController } from "./controller/forms"
import type { AgentsController } from "./controller/agents"
import { createSidebarController } from "./controller/sidebar"
import type { SidebarController } from "./controller/sidebar"
import type { TabsController } from "./controller/tabs"
import { createTargetsController } from "./controller/targets"
import type { TargetsController } from "./controller/targets"
import { createTargetGraphController } from "./controller/targetGraph"
import type { TargetGraphController } from "./controller/targetGraph"
import { createTargetGraphDevFixtures } from "../dev/fixtureRunStream"
import { createTurnController } from "./controller/turns"
import { createWorkflowPumpController } from "./controller/workflow-pump"
import { createWorkflowController, type WorkflowController } from "./controller/workflows"
import { createRunsController, type RunsController } from "./controller/runs"
import { createWorldController } from "./controller/world"
import { createCloudWikiController } from "./controller/cloud-wiki"
import type { MarkdownEditorHandle } from "@smthrs/ui/adapters/markdown-editor"
import type { WikiEditorHandle } from "./controller/world"
import { createGitHubSeam } from "./seams/GitHubSeam"
import type { GitHubSeam } from "./seams/GitHubSeam"
import { createBillingSeam } from "./seams/BillingSeam"
import type { BillingSeam } from "./seams/BillingSeam"
import { createBookmarksSeam } from "./seams/BookmarksSeam"
import type { BookmarksSeam } from "./seams/BookmarksSeam"
import { createCloudSeam } from "./seams/CloudSeam"
import type { CloudSeam } from "./seams/CloudSeam"
import { createEnvironmentSeam } from "./seams/EnvironmentSeam"
import type { EnvironmentSeam } from "./seams/EnvironmentSeam"
import { createFilesSeam } from "./seams/FilesSeam"
import { createFactorySeam } from "./seams/FactorySeam"
import type { FactorySeam } from "./seams/FactorySeam"
import { createSecretsSeam } from "./seams/SecretsSeam"
import { createHistorySeam } from "./seams/HistorySeam"
import type { HistorySeam } from "./seams/HistorySeam"
import { createTriggersSeam } from "./seams/TriggersSeam"
import type { TriggersSeam } from "./seams/TriggersSeam"
import { createRepositoryFlowsSeam } from "./seams/RepositoryFlowsSeam"
import type { RepositoryFlowCatalog } from "../flows/entries/flow"
import type { SecretsSeam } from "./seams/SecretsSeam"
import { createOnboardingController } from "./controller/onboarding"
import type { OnboardingController } from "./controller/onboarding"
import type { FilesSeam } from "./seams/FilesSeam"
import { createCodeIntelSeam } from "./seams/CodeIntelSeam"
import type { CodeIntelSeam } from "./seams/CodeIntelSeam"
import { createRepoTreeSeam } from "./seams/RepoTreeSeam"
import { createIssuesSeam } from "./seams/IssuesSeam"
import type { IssuesSeam } from "./seams/IssuesSeam"
import { createLandingsSeam } from "./seams/LandingsSeam"
import type { LandingsSeam } from "./seams/LandingsSeam"
import { createNotificationsSeam } from "./seams/NotificationsSeam"
import type { NotificationsSeam } from "./seams/NotificationsSeam"
import { createRepositoriesSeam } from "./seams/RepositoriesSeam"
import { createWorkspaceSeam } from "./seams/WorkspaceSeam"
import { createEgressSeam } from "./seams/EgressSeam"
import type { WorkspaceSeam } from "./seams/WorkspaceSeam"
import type { EgressSeam } from "./seams/EgressSeam"
import { createChangeSeam } from "./seams/ChangeSeam"
import type { ChangeSeam } from "./seams/ChangeSeam"
import type { RepositoriesSeam } from "./seams/RepositoriesSeam"
import { createRepoImportSeam } from "./seams/RepoImportSeam"
import { createLinearSeam } from "./seams/LinearSeam"
import type { LinearSeam } from "./seams/LinearSeam"
import type { RepoImportSeam } from "./seams/RepoImportSeam"
import type { SeamContext } from "./seams/SeamContext"
import { createStorageRecoveryController } from "./controller/storage-recovery"
import type { StorageRecoveryAction, StorageRecoveryHost } from "./StorageRecoveryAction"

export interface AppController {
  readonly storageRecoveryState: StorageRecoveryAction["state"]
  readonly promptStorageRecovery: () => Promise<void>
  readonly exportStorageRecovery: () => Promise<string | void>
  readonly store: AppStore
  readonly bootstrap: AppBootstrap | undefined
  /** The native app's download URL this page offers; null while no native release carries an asset (controller/app.ts). */
  readonly downloadUrl: string | null
  /** The resolved feature flags (every flag defaults off). */
  readonly features: Required<AppFeatures>
  readonly nativeAgentAvailable: boolean
  readonly nativeRepositoriesAvailable: boolean
  /** The command registry: every interactive affordance routes through it. */
  readonly commands: CommandRegistry
  /**
   * The active repository's declared flows (the `flows` rows of its
   * .smithers/factory.json, seams/RepositoryFlowsSeam.ts), from which the
   * registry derives one slash leaf each; undefined without a target
   * repository or before its projection has landed.
   */
  readonly repositoryFlows: () => RepositoryFlowCatalog | undefined
  /**
   * The repositories a trailing `owner/repo` token beside other text may
   * name (RepoContext.ts knownRepositories): the slash grammar's check that
   * `fix src/index.ts` keeps its path.
   */
  readonly knownRepositories: () => KnownRepositories
  readonly slashItems: (needle: string) => Array<SlashItem<CatalogItem>>
  readonly slashTree: (needle: string) => Array<SlashRow<CatalogItem>>
  readonly changeDraft: (draft: string) => void
  readonly reset: () => void
  readonly debugReset: () => Promise<string | void>
  readonly stop: () => void
  readonly send: (text: string) => void
  readonly showChat: () => void
  readonly showWorld: () => void
  readonly showConnectors: () => void
  /** The Library: the plugin shelf this workspace browses and installs from. */
  readonly showPlugins: () => void
  readonly installPlugin: (id: string) => string | void
  readonly removePlugin: (id: string) => string | void
  readonly listPlugins: () => { readonly value: string }
  readonly askReset: () => void
  readonly cancelReset: () => void
  readonly runCommand: (name: string, args?: string) => boolean
  readonly connectLocalRepository: (access: RepositoryAccess) => Promise<void>
  readonly makeConnectorReadOnly: (id: string) => Promise<string | void>
  readonly askConnectorRemoval: (id: string) => string | void
  readonly cancelConnectorRemoval: () => void
  readonly removeConnector: (id: string) => Promise<string | void>
  readonly selectWorldDocument: (id: string) => string | void
  readonly changeWorldDocument: (id: string, body: string) => Promise<string | void>
  readonly listCloudWiki: (repo: string, page?: number) => Promise<string | { value: string }>
  readonly openCloudWiki: (repo: string, slug: string) => Promise<string | { value: string }>
  readonly retryCloudWiki: (id: string) => Promise<string | void | { value: string }>
  readonly attachWorldEditor: (id: string, slot: string, editor: MarkdownEditorHandle | null) => void
  readonly selectWikiCardDocument: (cardId: string, documentId: string) => string | void
  readonly setWikiCardView: (cardId: string, view: "outline" | "document") => string | void
  readonly createWorldDocument: () => void
  /** Ask whether to delete a note; the answer is `world.delete.confirm|cancel`. */
  readonly removeWorldDocument: (id: string) => string | void
  readonly confirmWorldDelete: () => string | void
  readonly cancelWorldDelete: () => void
  /** `wiki.open <path>` embeds the note for either actor and returns its links to the agent. */
  readonly openWorldDocument: (path: string) => string | void | { readonly value: string }
  /** `wiki.backlinks <path>`: the note's link rail as an embedded card, for either actor; the agent reads the names back. */
  readonly showWorldLinks: (path: string) => string | void | { readonly value: string }
  /** `wiki.graph [path]` embeds the graph for either actor and returns its counts to the agent. */
  readonly showWorldGraph: (path?: string) => string | void | { readonly value: string }
  /** The Wiki pane's editor mount registers its handle here (null on unmount); `wiki.heading` scrolls through it. */
  readonly attachWikiEditor: (editor: WikiEditorHandle | null) => void
  /** `wiki.heading <line>`: bring the open note's heading at that source line into view. */
  readonly jumpToHeading: (line: string) => string | void
  readonly decideApproval: (id: string, decision: "approved" | "denied") => void
  readonly retryLastTurn: () => string | void
  readonly guideAct: (action: string, value?: string) => Promise<string | void>
  readonly toggleTheme: () => void
  /** Wear a color theme (/theme) — the axis orthogonal to light/dark. */
  readonly setPalette: (args: string) => string | void
  /** Archive locally and start fresh; model-generated notes are opt-in. */
  readonly clearConversation: (options?: { readonly summarize?: boolean }) => Promise<string | void>
  /* The browser tool + surface (§2d/§2d′). */
  readonly openBrowser: (url: string) => Promise<string | void | { readonly value: string }>
  /*
   * Wave 11 — workflows in the conversation. Create/list/run through the
   * per-user gateway seam; runs render as embedded run cards tracked live.
   */
  readonly createWorkflow: (
    description: string,
    repo?: string
  ) => Promise<string | void | { readonly value: string }>
  readonly listWorkspaceWorkflows: (repo?: string, sourceCard?: string) => Promise<string | void | { readonly value: string }>
  /** The dispatchers waiting on the repository (triggers.list): declared rules for every visitor, live rows when a box answered. */
  readonly listTriggers: TriggersSeam["listTriggers"]
  /** The register door (triggers.register): signed-in by requirement. */
  readonly registerTrigger: TriggersSeam["registerTrigger"]
  /** Ask 5: the Flows pane — the surface switch and the listing that fills it. */
  readonly showFlows: () => Promise<string | void | { readonly value: string }>
  readonly runWorkflow: (name: string, repo?: string, input?: Record<string, unknown>, sourceCard?: string) => Promise<string | void | { readonly value: string }>
  /* Wave 12 §2 — the answer to "which loaded repository?" (one act). */
  readonly chooseWorkflowRepo: (fullName: string) => Promise<string | void | { readonly value: string }>
  /* Wave 12 §3 — the two acts a run that has gone quiet offers. */
  readonly stopWatchingRun: (cardId: string, reason?: string) => string | void
  readonly retryRunWatch: (cardId: string) => string | void
  /** Boot reconciliation: resume the event pump for any run card still live. */
  readonly resumeWorkflowRuns: () => void
  /* Lane runs — the run lifecycle beyond launch (see controller/runs.ts). */
  readonly listRuns: RunsController["listRuns"]
  readonly openRun: RunsController["openRun"]
  readonly resumeRun: RunsController["resumeRun"]
  readonly rerunRun: RunsController["rerunRun"]
  readonly signalRun: RunsController["signalRun"]
  readonly steerRun: RunsController["steerRun"]
  readonly steerRunSeat: RunsController["steerRunSeat"]
  readonly steerRunThinking: RunsController["steerRunThinking"]
  readonly steerRunTools: RunsController["steerRunTools"]
  readonly showRunLogs: RunsController["showRunLogs"]
  readonly showRunSteps: RunsController["showRunSteps"]
  readonly showRunEvents: RunsController["showRunEvents"]
  readonly traceFilter: RunsController["traceFilter"]
  readonly traceSelect: RunsController["traceSelect"]
  readonly selectCodingChange: RunsController["selectCodingChange"]
  readonly traceView: RunsController["traceView"]
  readonly traceLive: RunsController["traceLive"]
  readonly stopAllRuns: RunsController["stopAllRuns"]
  readonly listApprovals: RunsController["listApprovals"]
  readonly openApproval: RunsController["openApproval"]
  /* Card maximize/minimize — the user's presentation transition (§2d′). */
  readonly maximizeCard: (id: string) => string | void
  readonly minimizeCard: () => void
  readonly frameBack: () => void
  readonly frameForward: () => void
  readonly forkFrame: () => string | void
  /* The local-app tabs (docs/LOCAL-APP.md "Tabs"); see controller/tabs.ts. */
  readonly openTerminalTab: TabsController["openTerminalTab"]
  readonly openHarnessTab: TabsController["openHarnessTab"]
  readonly readTab: TabsController["readTab"]
  readonly openCardTab: TabsController["openCardTab"]
  readonly selectTab: TabsController["selectTab"]
  readonly closeTab: TabsController["closeTab"]
  readonly confirmTabClose: TabsController["confirmTabClose"]
  readonly cancelTabClose: TabsController["cancelTabClose"]
  readonly toggleTabMenu: TabsController["toggleTabMenu"]
  readonly selectRepo: TabsController["selectRepo"]
  readonly unpinRepo: TabsController["unpinRepo"]
  /* The sidebar's file tree and workspace heading (docs/workbench-lanes/sidebar-tree.md); see controller/sidebar.ts. */
  readonly toggleRepoTree: SidebarController["toggleRepoTree"]
  readonly renameWorkspace: SidebarController["renameWorkspace"]
  readonly toggleWorkspaceRename: SidebarController["toggleWorkspaceRename"]
  readonly openLocalRepo: TabsController["openLocalRepo"]
  readonly loadHarnesses: TabsController["loadHarnesses"]
  /* Agents as data (docs/workbench-lanes/custom-agents.md); see controller/agents.ts. */
  readonly loadAgents: AgentsController["loadAgents"]
  readonly listAgents: AgentsController["listAgents"]
  readonly newAgent: AgentsController["newAgent"]
  readonly createAgent: AgentsController["createAgent"]
  readonly editAgent: AgentsController["editAgent"]
  readonly removeAgent: AgentsController["removeAgent"]
  readonly listHarnessModels: AgentsController["listHarnessModels"]
  /* THE FORM LAW (apps/ui/AGENTS.md): the flow-form card's render, field commits, submit, and dismiss; see controller/forms.ts. */
  readonly renderFlowForm: FormsController["renderFlowForm"]
  readonly setFormField: FormsController["setFormField"]
  readonly submitForm: FormsController["submitForm"]
  readonly dismissCard: FormsController["dismissCard"]
  readonly loadRepos: TabsController["loadRepos"]
  readonly notePtyExit: TabsController["notePtyExit"]
  /** The PTY transport the terminal tabs attach to (docs/LOCAL-APP.md "/ws"). */
  readonly pty: PtyClient
  /** Lane citc: the cloud-workspace terminal transport (one socket per workspace session). */
  readonly cloudTerminal: CloudTerminalClient
  /* Lane L3 (docs/LOCAL-APP.md "Target presentation"); see controller/targets.ts. */
  readonly openRepo: TargetsController["openRepo"]
  readonly listTargets: TargetsController["listTargets"]
  readonly runTarget: TargetsController["runTarget"]
  readonly runPattern: TargetsController["runPattern"]
  readonly openTarget: TargetsController["openTarget"]
  readonly filterTargets: TargetsController["filterTargets"]
  readonly selectTarget: TargetsController["selectTarget"]
  readonly starTarget: TargetsController["starTarget"]
  readonly expandTargetGroup: TargetsController["expandTargetGroup"]
  readonly pickTargets: TargetsController["pickTargets"]
  readonly runTargetSet: TargetsController["runTargetSet"]
  /* The target-graph cards (docs/LOCAL-APP.md "Cards: target graph"); see controller/targetGraph.ts. */
  readonly showGraph: TargetGraphController["showGraph"]
  readonly focusGraphNode: TargetGraphController["focusGraph"]
  readonly filterGraph: TargetGraphController["filterGraph"]
  readonly showRunTimeline: TargetGraphController["showTimeline"]
  readonly showRunHistory: TargetGraphController["showHistory"]
  readonly selectRunReplay: TargetGraphController["selectRun"]
  readonly scrubRunReplay: TargetGraphController["scrubRun"]
  readonly showAffected: TargetGraphController["showAffected"]
  readonly showCiMatrix: TargetGraphController["showCi"]
  readonly openTargetSource: TargetGraphController["openSource"]
  /* The admin dev-tools panel + debug reads (§2b/§2d; admin registry only). */
  readonly toggleDevtools: () => void
  /** Report what drives a turn (admin /debug.backend; DESIGN.md §14). */
  readonly describeAgentBackend: (backend: string) => string | { readonly value: string }
  /* The composer surfaces menu — the /surfaces command's open state. */
  readonly toggleSurfacesMenu: () => void
  /*
   * The search palette (Search and Command Palette Spec 2026-09-07): the
   * overlay's rows read synchronously from the store (the button door), the
   * `search.*` flow handler (the slash and agent doors), and the session
   * acts the overlay dispatches (state/seams/SearchSeam.ts).
   */
  readonly searchPalette: (text: string) => PaletteAnswer
  readonly search: SearchSeam["search"]
  readonly openPalette: (prefix?: string) => void
  readonly closePalette: (lastQuery?: string) => void
  readonly togglePaletteActions: (ref: string) => void
  readonly notePaletteItemOpened: (item: { readonly kind: string; readonly ref: string }) => void
  readonly paletteRecent: () => { readonly value: string }
  /*
   * The composer connect menu's open state. Not a command — the chip is a
   * pointer affordance, not a registry entry — but the state is still the
   * store's, reached through the dispatcher with the actor recorded.
   */
  readonly toggleConnectMenu: () => void
  readonly closeConnectMenu: () => void
  /* The composer `+` menu — the /composer.add command's open state. */
  readonly toggleAddMenu: () => void
  readonly closeAddMenu: () => void
  /** /files.add — attachments, or the honest answer that this host has none. */
  readonly addFiles: () => void
  readonly debugSnapshot: () => { readonly value: string }
  readonly debugEvents: () => { readonly value: string }
  readonly debugSeams: () => Promise<string | void | { readonly value: string }>
  /** The chain x-ray (DESIGN.md §14 debug mode): the journal fold, as data. */
  readonly debugChain: () => { readonly value: string }
  /** The wire tap: the controller's fetch ring, newest first. */
  readonly debugNet: () => { readonly value: string }
  /**
   * The same ring, read WITHOUT surfacing it.
   *
   * `debugNet` is the flow: it renders the read for the human who typed it.
   * The dev-tools panel reads the ring while rendering, so it needs the pure
   * read — dispatching from a render is a re-render loop.
   */
  readonly netTap: () => string
  /**
   * The same ring as rows, for the panel that renders them. `netTap`
   * serializes for the debug read a human types; a renderer takes the rows
   * so nothing has to parse that string back into a shape it restates.
   */
  readonly netTapEntries: () => ReadonlyArray<NetEntry>
  /** Drop every chain grant and pending denial (admin /debug.grants.reset). */
  readonly resetGrants: () => Promise<string | { readonly value: string }>
  /**
   * The tapped fetch, exposed so the chain runtime's model-relay traffic
   * records into the same ring as every controller seam.
   */
  readonly tappedFetch: FetchLike
  /** Adopt an identity answer already resolved by the server renderer. */
  readonly adoptSession: (session: import("./controller/auth-billing").ResolvedSession) => Promise<void>
  /** Load the identity session record from the identity seam (actor: system). */
  readonly loadSession: () => Promise<void>
  /** Redirect to the identity seam's GitHub OAuth start. */
  readonly signIn: () => void
  readonly signOut: () => Promise<string | void>
  readonly requestAccess: () => Promise<string | void>
  /**
   * Consume a `?auth=failed` return from a failed OAuth redirect: the failure
   * renders as a Smithers message in the chat (honest error + retry action),
   * never a bare page. Answers whether the search string carried one.
   */
  readonly handleAuthReturn: (search: string) => boolean
  /*
   * The requirement axis (registry.ts commandRequirements): park a
   * user-invoked command on an unmet requirement, and resume it when the
   * requirement's predicate flips true. Deferral is durable (the session
   * row) because sign-in is a full OAuth redirect; every seam that can
   * SATISFY a requirement calls resumeDeferredCommand after it settles.
   */
  readonly deferCommand: (name: string, args: string | null, requirement: string) => void
  readonly resumeDeferredCommand: () => void
  /** Record a visible command run for the slash menu's recency ranking. */
  readonly noteCommandRun: (name: string) => void
  /** The /verbose switch: trace every flow and background transition in the transcript. */
  readonly toggleVerbose: () => void
  /** Record one settled flow invocation (every trigger) — the verbose trace's source. */
  readonly traceFlow: (record: Extract<AppTransition, { type: "flow.invoked" }>) => void
  /**
   * A `confirm` flow asked for by the MODEL: post the confirmation message
   * whose action button runs the flow as the user (Commands.ts runAs).
   */
  readonly requestFlowConfirmation: (name: string, args: string | null, label: string) => void
  /** The `recommend` flow: regenerate the next-step pills for the current state (Recommend.ts). */
  readonly recommend: () => Promise<void>
  /** The `explain` flow: one side turn on the explainer role, answered as an embedded card (controller/explain.ts). */
  readonly explain: ExplainController["explain"]
  /** Render the full visible-flow catalog into the chat (the /chat.commands answer). */
  readonly showCommandCatalog: () => void
  /** Render the sign-in step into the chat (auth.prompt — the agent's door to login). */
  readonly promptSignIn: () => void
  /** Render the Smithers Cloud sign-in step into the chat (cloud.prompt — the agent's door to the cloud session). */
  readonly promptCloudSignIn: () => void
  /** Reload the app window — the /reload affordance (dev loop, stuck states). */
  readonly reloadApp: () => void
  /** Open the native app's download page (app.download — the web app's one door to the native app). */
  readonly openDownload: AppShellController["openDownload"]
  /** Render the native-only refusal card with the download action (app.download.prompt — the agent's door). */
  readonly promptDownload: AppShellController["promptDownload"]
  /** Render and return the identity line (smithers.who). */
  readonly introduce: AppShellController["introduce"]
  /** Render the account card, or the sign-in step signed out (account.show). */
  readonly showAccount: AccountController["showAccount"]
  /* The repository welcome and its three answers (controller/onboarding.ts). */
  readonly welcomeRepo: OnboardingController["welcomeRepo"]
  readonly maintainRepo: OnboardingController["maintainRepo"]
  readonly contributeRepo: OnboardingController["contributeRepo"]
  readonly exploreRepo: OnboardingController["exploreRepo"]
  readonly homeRepo: OnboardingController["homeRepo"]
  readonly prototypeFeature: OnboardingController["prototypeFeature"]
  /*
   * The multi-parity domain seams (MULTI-ACTIONS-GAP.md Tier 1/2): issues,
   * PRs/landings, billing checkout, notifications, the agent
   * environment, and repo import. One method per command; each seam owns its
   * backend domain in state/seams/*.
   */
  readonly listIssues: IssuesSeam["listIssues"]
  readonly viewIssue: IssuesSeam["viewIssue"]
  readonly createIssue: IssuesSeam["createIssue"]
  readonly setIssueState: IssuesSeam["setIssueState"]
  readonly commentOnIssue: IssuesSeam["commentOnIssue"]
  readonly linkIssueLinear: IssuesSeam["linkLinear"]
  readonly unlinkIssueLinear: IssuesSeam["unlinkLinear"]
  readonly listLandings: LandingsSeam["listLandings"]
  readonly viewLanding: LandingsSeam["viewLanding"]
  readonly createLanding: LandingsSeam["createLanding"]
  readonly landLanding: LandingsSeam["landLanding"]
  readonly reviewLanding: LandingsSeam["reviewLanding"]
  readonly startCheckout: BillingSeam["startCheckout"]
  readonly openBillingPortal: BillingSeam["openBillingPortal"]
  readonly listNotifications: NotificationsSeam["listNotifications"]
  readonly markNotificationsRead: NotificationsSeam["markNotificationsRead"]
  readonly viewEnvironment: EnvironmentSeam["viewEnvironment"]
  readonly setEnvironmentVar: EnvironmentSeam["setEnvironmentVar"]
  readonly listSecrets: SecretsSeam["listSecrets"]
  readonly showHistory: HistorySeam["showHistory"]
  readonly retellHistory: HistorySeam["retellHistory"]
  /** The repository's factory (factory.show): wiki stats and the box's infra-as-code files. */
  readonly showFactory: FactorySeam["showFactory"]
  readonly importRepository: RepoImportSeam["importRepository"]
  readonly retryImport: RepoImportSeam["retryImport"]
  readonly listBookmarks: BookmarksSeam["listBookmarks"]
  readonly listFiles: FilesSeam["listFiles"]
  readonly readFile: FilesSeam["readFile"]
  /* Code intelligence (docs/code-intel/PLAN.md §4): the three code.* reads against the local language server (seams/CodeIntelSeam.ts). */
  readonly codeHover: CodeIntelSeam["hover"]
  readonly codeDefinition: CodeIntelSeam["definition"]
  readonly codeDiagnostics: CodeIntelSeam["diagnostics"]
  /*
   * Lane sync (ADR 0005): Linear and GitHub sync as actions — the
   * connector-setup cards, the sync-ops card, and the GitHub App status
   * behind the `/api/cloud/*` proxy (state/seams/LinearSeam.ts,
   * GitHubSeam.ts).
   */
  readonly linearConnect: LinearSeam["connect"]
  readonly linearConnectOpen: LinearSeam["openLinear"]
  readonly linearConnectTeam: LinearSeam["pickTeam"]
  readonly linearConnectRepo: LinearSeam["pickRepository"]
  readonly linearConnectConfirm: LinearSeam["confirmConnect"]
  readonly linearSync: LinearSeam["syncNow"]
  readonly linearActivity: LinearSeam["activity"]
  readonly linearDisconnect: LinearSeam["disconnect"]
  readonly retrySyncOp: LinearSeam["retryOp"]
  readonly showMoreSyncOps: LinearSeam["showMoreOps"]
  readonly loadOlderSyncOps: LinearSeam["loadOlderOps"]
  readonly githubApp: GitHubSeam["app"]
  readonly githubOpenInstall: GitHubSeam["openInstall"]
  readonly githubReconcile: GitHubSeam["reconcile"]
  readonly retryMirrorRef: GitHubSeam["retryMirrorRef"]
  readonly githubMirrorSync: GitHubSeam["mirrorSync"]
  /*
   * Lane piper: the Smithers Cloud session (the CLI browser login; the token
   * never reaches the renderer) and the repository inventory behind the
   * `/api/cloud/*` proxy (state/seams/CloudSeam.ts, RepositoriesSeam.ts).
   */
  readonly loadCloudSession: CloudSeam["loadSession"]
  readonly signInCloud: CloudSeam["signIn"]
  readonly signOutCloud: CloudSeam["signOut"]
  readonly loadRepositories: RepositoriesSeam["loadRepositories"]
  /*
   * Lane citc (ADR 0002): the persistent cloud computers behind the
   * `/api/cloud/*` proxy (state/seams/WorkspaceSeam.ts).
   */
  readonly listWorkspaces: WorkspaceSeam["listWorkspaces"]
  readonly openWorkspace: WorkspaceSeam["openWorkspace"]
  readonly viewWorkspace: WorkspaceSeam["viewWorkspace"]
  readonly openWorkspaceTerminal: WorkspaceSeam["openTerminal"]
  readonly suspendWorkspace: WorkspaceSeam["suspendWorkspace"]
  readonly resumeWorkspace: WorkspaceSeam["resumeWorkspace"]
  readonly forkWorkspace: WorkspaceSeam["forkWorkspace"]
  readonly snapshotWorkspace: WorkspaceSeam["snapshotWorkspace"]
  readonly deleteWorkspaceSnapshot: WorkspaceSeam["deleteSnapshot"]
  readonly forkWorkspaceFromSnapshot: WorkspaceSeam["forkFromSnapshot"]
  readonly templateWorkspaceSnapshot: WorkspaceSeam["templateSnapshot"]
  readonly listWorkspaceSessions: WorkspaceSeam["listSessions"]
  readonly destroyWorkspaceSession: WorkspaceSeam["destroySession"]
  readonly deleteWorkspace: WorkspaceSeam["deleteWorkspace"]
  readonly setWorkspaceFacet: WorkspaceSeam["setFacet"]
  /* Lane L3: the workspace facets plue#449 and the sandbox egress audit answer. */
  readonly listWorkspaceFiles: WorkspaceSeam["listFiles"]
  readonly readWorkspaceFile: WorkspaceSeam["readFile"]
  readonly listWorkspaceServices: WorkspaceSeam["listServices"]
  readonly listWorkspaceEgress: WorkspaceSeam["listEgress"]
  /* Lane L3b: the NixOS desktop and the environment images a repository has built. */
  readonly openWorkspaceDesktop: WorkspaceSeam["openDesktop"]
  readonly rotateWorkspaceDesktop: WorkspaceSeam["rotateDesktop"]
  readonly listEnvironmentImages: WorkspaceSeam["listEnvironmentImages"]
  readonly listSessionEgress: EgressSeam["listSessionEgress"]
  /*
   * Lane change (ADR 0003): the change is the unit — the change and diff
   * cards behind the `/api/cloud/*` proxy (state/seams/ChangeSeam.ts).
   */
  readonly viewChange: ChangeSeam["viewChange"]
  readonly diffChange: ChangeSeam["diffChange"]
  readonly landChange: ChangeSeam["landChange"]
  readonly splitReadyChange: ChangeSeam["splitReady"]
  readonly splitChange: ChangeSeam["splitChange"]
  readonly resolveChangeConflict: ChangeSeam["resolveConflict"]
  readonly revertChange: ChangeSeam["revertChange"]
  readonly setChangeFacet: ChangeSeam["setFacet"]
  /* Lane L1: the live plue routes — pins, checks per revision, threads, findings, the snapshot fork. */
  readonly setChangePins: ChangeSeam["setPins"]
  readonly checksOfChangeAt: ChangeSeam["checksAt"]
  readonly openChangeComputer: ChangeSeam["openComputer"]
  readonly diffSinceMyReview: ChangeSeam["sinceMyReview"]
  readonly reviewThreadDone: ChangeSeam["threadDone"]
  readonly reviewThreadAck: ChangeSeam["threadAck"]
  readonly reviewThreadReopen: ChangeSeam["threadReopen"]
  readonly fixFinding: ChangeSeam["pleaseFix"]
  readonly findingNotUseful: ChangeSeam["notUseful"]
  readonly requestChangeReview: ChangeSeam["requestReview"]
  readonly unrequestChangeReview: ChangeSeam["unrequestReview"]
  /** Dismiss one toast on the shared corner stack (the toast.dismiss command). */
  readonly dismissToast: (id: string) => void
  /** Refresh the billing record from the billing seam (actor: system). */
  readonly refreshBalance: () => Promise<void>
  /** Refresh the balance and surface it as a card in the transcript. */
  readonly showBalance: () => Promise<string | { readonly value: string }>
  /* The admin plugin's controller half — registered as commands only for admin sessions. */
  readonly adminAllowlist: (action: "add" | "remove", login: string) => Promise<string | void>
  readonly adminGrant: (amountUsd: number, login: string) => string | void
  readonly adminGrantConfirm: (cardId: string) => Promise<string | void>
  readonly adminGrantCancel: (cardId: string) => string | void
  readonly adminRequests: () => Promise<string | void>
  readonly adminQueueApprove: (login: string) => Promise<string | void>
  readonly adminHealth: () => Promise<string | void>
  /**
   * Close the controller's scope: stop the workflow pumps and release
   * everything the controllers opened (the agent subscription, the
   * cross-tab identity listeners, the identity BroadcastChannel). Nothing a
   * controller opened outlives it.
   */
  readonly dispose: () => Promise<void>
}
/**
 * The product-Worker backend seams the controller talks to. Injectable so tests
 * bind honest doubles instead of a network; production uses same-origin fetch.
 */
export interface AppServices {
  /** Trusted local handoff, injectable by the embedding host; never projected as a tool. */
  readonly storageRecoveryHost?: StorageRecoveryHost
  readonly fetchImpl?: FetchLike
  /**
   * The `/ws` URL the PTY and target-run clients open; default the page's
   * own origin. A test binds `() => undefined` so no real socket is opened
   * against an origin that is not listening.
   */
  readonly socketUrl?: () => string | undefined
  /**
   * The per-launch local capability every `/ws` socket carries as its
   * subprotocol; default the page's injected token (runtime/LocalSession.ts).
   * A test against a real local origin binds the server's protocol.
   */
  readonly socketProtocols?: () => ReadonlyArray<string>
  /**
   * Lane citc: the `/api/cloud-ws/` tunnel URL for one workspace session;
   * default the page's own origin. Tests bind `() => undefined`.
   */
  readonly cloudSocketUrl?: (repo: string, sessionId: string) => string | undefined
  /**
   * Lane L6: the `/api/cloud-ws/…/lsp` tunnel URL for one workspace
   * language-server session; default the page's own origin. Tests bind
   * `() => undefined` or a real local origin.
   */
  readonly cloudLspSocketUrl?: (repo: string, sessionId: string, language: string) => string | undefined
  readonly bootstrap?: AppBootstrap
  readonly frameHistory?: FrameHistoryPort
  readonly baseUrl?: string
  /** The toast debounce (the 300ms law); injectable so tests pin both sides of it. */
  readonly toastDebounceMs?: number
  /**
   * Open a URL in the system browser (the native shell's door). Present =
   * the sign-in handoff runs OAuth outside the webview, where passkeys
   * work; absent = pure web keeps the same-page navigation.
   */
  readonly openExternal?: (url: string) => Promise<boolean>
  /**
   * The native app's download URL, when the composition root knows one;
   * default the shared constant (AppLinks.ts), null until a release carries
   * an asset. Tests inject a URL to exercise the door, and null to prove it
   * is absent.
   */
  readonly downloadUrl?: string | null
  /** The handoff claim poll cadence; tests shorten it. */
  readonly handoffPollMs?: number
  /** How long a settled-ok toast states its result before dismissing itself. */
  readonly toastAutoDismissMs?: number
  /**
   * Wave 11 — the run card's event-pump cadence (the floor under the relay's
   * SSE pokes) and the provision poll gap. Injectable so tests drive a whole
   * run journey without waiting out real seconds.
   */
  readonly workflowPollMs?: number
  /**
   * Wave 12 §3 — how long a run may make no progress before the card states
   * that it has gone quiet and the pump stops (10 minutes in production).
   */
  readonly workflowQuietMs?: number
  /**
   * How long a request/response seam may take before it is an honest failure
   * (§22.6). Streaming paths carry no deadline; tests shorten this one.
   */
  readonly seamTimeoutMs?: number
  /**
   * The next-step recommender (Recommend.ts): whether it asks the server's
   * POST /api/recommend at all (off by default) and its debounce.
   */
  readonly recommender?: RecommenderConfig
  /** The explainer side turn's timeout (controller/explain.ts). */
  readonly explainer?: ExplainConfig
  /**
   * Feature flags. `suggestionPills`: the next-action pills under the
   * composer and the recommender's POST /api/recommend requests behind them.
   * Default ON for the cloud host (the Worker serves the route) and OFF
   * elsewhere; an explicit value wins, so a test can turn the row off on the
   * cloud host or on elsewhere. Off, the pill row is absent from the DOM and
   * no request leaves; the `recommend` flow still writes its rule row so
   * turning the flag on later works without a schema change.
   */
  readonly features?: AppFeatures
}

export interface AppFeatures {
  readonly suggestionPills?: boolean
}

/**
 * Environment-agnostic: the native bridge is injected by the composition root so this
 * module never pulls the Electrobun runtime into pure-web or test contexts.
 */
export const createAppController = (
  store: AppStore,
  repositories: NativeRepositories,
  agent: AgentPort,
  services: AppServices = {}
): AppController => {
  const ctx = createControllerContext(store, repositories, agent, services)
  // A reload resumes the lesson and work, with the conversation tucked away.
  const restoredGuide = store.session().guide
  if (restoredGuide?.conversationOpen) store.dispatch({ type: "guide.changed", actor: "system", guide: { ...restoredGuide, conversationOpen: false } })
  const actors = createActorBindings(ctx.onDispose)
  const { guideAct } = actors.pair(ctx, createGuideController)
  if (store.dispose !== undefined) ctx.onDispose(store.dispose)
  const { baseUrl, http } = ctx
  const features: Required<AppFeatures> = {
    suggestionPills: services.features?.suggestionPills ?? services.bootstrap?.host === "cloud"
  }
  const { withToast, resolveToast, dismissToast, surfaceCommandFailure } = createFailureController(ctx)
  ctx.withToast = withToast
  ctx.resolveToast = resolveToast

  const nextTranscriptOrdinal = (): number => {
    let highest = -1
    for (const message of store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
    for (const card of store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
    return highest + 1
  }

  /*
   * The multi-parity domain seams: each owns one backend domain behind the
   * platform proxy, constructed on the shared seam context (the tapped
   * fetch, the store, the transcript-ordinal door).
   */
  /*
   * The domain seams ride boundedFetch (Ruling B): every request/response
   * seam call carries the seam deadline, and the tap plus 401 recovery still
   * apply because boundedFetch wraps the tapped http.
   */
  const seamCtx: SeamContext = {
    http: (input, init) => ctx.boundedFetch(input, init),
    baseUrl,
    store,
    dispatch: store.dispatch,
    actor: () => ctx.commandActor,
    nextOrdinal: nextTranscriptOrdinal
  }
  const repositoryFlowsSeam = createRepositoryFlowsSeam(seamCtx)
  const repositoryFlows = (): RepositoryFlowCatalog | undefined => {
    const target = resolveTargetRepo(store, undefined)
    if ("error" in target) return undefined
    const row = store.collections.repositoryFlows.get(target.repo)
    return row === undefined ? undefined : { repo: row.id, flows: row.flows, loadedAt: row.loadedAt }
  }
  const issuesSeam = actors.pair(seamCtx, (context) => createIssuesSeam(context))
  const landingsSeam = actors.pair(seamCtx, (context) => createLandingsSeam(context))
  const billingSeam = actors.pair(seamCtx, (context) => createBillingSeam(context))
  const notificationsSeam = actors.pair(seamCtx, (context) => createNotificationsSeam(context))
  const environmentSeam = actors.pair(seamCtx, (context) => createEnvironmentSeam(context))
  const secretsSeam = actors.pair(seamCtx, (context) => createSecretsSeam(context))
  const historySeam = actors.pair(seamCtx, (context) => createHistorySeam(context))
  /*
   * The mythical history read walks the mirror's change feed page by page
   * (up to MAX_CHANGE_PAGES sequential requests) before it can state a
   * thing: on a large repository that is many seconds with nothing on
   * screen (probe 2026-09-07 on smithersai/smithers: the walk took ~15 s and
   * read as a silent no-op). The 300ms toast law names the wait; the card
   * lands when the walk settles, and a refusal resolves the same toast.
   */
  const showMythicalHistory: HistorySeam["showHistory"] = (repo) =>
    withToast("history.show", "Reading the mythical history…", "Mythical history read", () => historySeam.showHistory(repo))
  const factorySeam = actors.pair(seamCtx, (context) => createFactorySeam(context))
  const triggersSeam = actors.pair(seamCtx, (context) => createTriggersSeam(context))
  const repoImportSeam = actors.pair(seamCtx, (context) => createRepoImportSeam(context))
  const bookmarksSeam = actors.pair(seamCtx, (context) => createBookmarksSeam(context))
  const filesSeam = actors.pair(seamCtx, (context) => createFilesSeam(context))
  const repoTreeSeam = actors.pair(seamCtx, (context) => createRepoTreeSeam(context))
  /*
   * Lane sync: the Linear and GitHub seams. The OAuth handoffs ride the
   * same native openExternal door as cloud sign-in; the Linear handoff's
   * receiver is the Bun server's /api/linear-auth/* (bun/LinearAuth.ts).
   */
  const gitHubSeam = actors.pair(seamCtx, (context) => createGitHubSeam(context, {
    ...(services.openExternal === undefined ? {} : { openExternal: services.openExternal })
  }))
  const linearSeam = actors.pair(seamCtx, (context) => createLinearSeam(context, {
    ...(services.openExternal === undefined ? {} : { openExternal: services.openExternal })
  }))
  /*
   * Lane piper: the cloud session and inventory seams. A definitive
   * signed-in answer pulls the repository inventory; sign-in does the same
   * when its wait settles.
   */
  const cloudSeam = actors.pair(seamCtx, (context) => createCloudSeam(context, {
    ...(services.openExternal === undefined ? {} : { openExternal: services.openExternal })
  }))
  const repositoriesSeam = actors.pair(seamCtx, (context) => createRepositoriesSeam(context))
  /* Lane citc: the cloud workspaces; its settle watches die with the controller. */
  const workspaceSeam = actors.pair(seamCtx, (context) => createWorkspaceSeam(context))
  /*
   * The palette's seam reads the registry it is registered in: the thunk
   * resolves once `commands` exists below, and nothing calls it during
   * construction.
   */
  const searchSeam = actors.pair(seamCtx, (context, select) =>
    createSearchSeam(context, { registry: () => commands, refreshWorkspaces: select(workspaceSeam.refreshWorkspaces) }))
  const egressSeam = actors.pair(seamCtx, (context) => createEgressSeam(context))
  ctx.onDispose(workspaceSeam.dispose)
  /* Lane change: the change/diff cards and their acts. */
  /* Lane L1: a revision's snapshot forks into a computer whose card the workspace seam renders. */
  const changeSeam = actors.pair(seamCtx, (context, select) => createChangeSeam(context, { viewWorkspace: select(workspaceSeam.viewWorkspace) }))
  const reloadRepositoriesWhenSignedIn = (): void => {
    if (store.collections.cloudSessions.get("cloud")?.state === "signed-in") {
      void repositoriesSeam.loadRepositories()
      void workspaceSeam.refreshWorkspaces()
      /* Lane sync: the integrations the Connectors surface's Linear row reads. */
      void linearSeam.refreshIntegrations()
    }
  }
  const loadCloudSession = async (): Promise<void> => {
    await cloudSeam.loadSession()
    reloadRepositoriesWhenSignedIn()
  }
  const signInCloud = async (): Promise<string | void> => {
    const refusal = await cloudSeam.signIn()
    reloadRepositoriesWhenSignedIn()
    return refusal
  }

  const {
    handleAuthReturn,
    adoptSession,
    loadSession,
    signIn,
    signOut,
    requestAccess,
    refreshBalance,
    showBalance,
    adminAllowlist,
    adminGrant,
    adminGrantConfirm,
    adminGrantCancel,
    adminRequests,
    adminQueueApprove,
    adminHealth,
    settleTurnBilling,
    watchIdentityAcrossTabs
  } = actors.pair(ctx, (context) => createAuthBillingController(context, nextTranscriptOrdinal))
  const { showPlugins, installPlugin, removePlugin, listPlugins } = actors.pair(ctx, createPluginsController)
  const { downloadUrl, openDownload, promptDownload, introduce } = actors.pair(ctx, (context) => createAppShellController(context))
  const { storageRecoveryState, promptStorageRecovery, exportStorageRecovery } = actors.pair(ctx, createStorageRecoveryController)

  const {
    showChat,
    showWorld,
    showConnectors,
    toggleDevtools,
    toggleSurfacesMenu,
    toggleConnectMenu,
    closeConnectMenu,
    toggleAddMenu,
    closeAddMenu,
    addFiles,
    askReset,
    cancelReset,
    describeAgentBackend,
    debugSnapshot,
    debugEvents,
    debugChain,
    netTap,
    netTapEntries,
    debugNet,
    resetGrants,
    debugSeams,
    openBrowser,
    toggleTheme,
    setPalette
  } = actors.pair(ctx, (context, select) => createPresentationController(context, select(adminHealth)))

  const {
    maximizeCard,
    minimizeCard,
    frameBack,
    frameForward,
    forkFrame
  } = createFramesController(ctx, services.frameHistory)

  const {
    openTerminalTab,
    openHarnessTab,
    readTab,
    openCardTab: openCardTabOnly,
    selectTab,
    closeTab,
    confirmTabClose,
    cancelTabClose,
    toggleTabMenu,
    selectRepo,
    unpinRepo,
    openLocalRepo,
    loadHarnesses,
    loadRepos,
    notePtyExit,
    installKeyboard
  } = actors.pair(ctx, (context) => createTabsController(context))
  const { renderFlowForm, setFormField, submitForm, dismissCard } = actors.pair(ctx, (context) => createFormsController(context, { nextOrdinal: nextTranscriptOrdinal }))
  const {
    loadAgents,
    listAgents,
    newAgent,
    createAgent,
    editAgent,
    removeAgent,
    listHarnessModels
  } = actors.pair(ctx, (context, select) => createAgentsController(context, { nextOrdinal: nextTranscriptOrdinal, loadHarnesses: select(loadHarnesses), renderFlowForm: select(renderFlowForm) }))
  const { toggleRepoTree, renameWorkspace, toggleWorkspaceRename } = actors.pair(ctx, (context, select) => createSidebarController(context, select(repoTreeSeam)))
  /*
   * "Open in tab" is offered on the maximized card, so opening the tab also
   * returns the transcript's copy to its embedded form — through the frames
   * controller, which moves the address bar back to the root frame. A bare
   * `card.minimized` dispatch left the URL at the maximized frame and a
   * reload restored the card maximized twice over.
   */
  const openCardTab: TabsController["openCardTab"] = (cardId) => {
    const wasMaximized = store.session().maximizedCardId === cardId
    const refusal = openCardTabOnly(cardId)
    if (refusal !== undefined) return refusal
    if (wasMaximized) minimizeCard()
  }
  const socketUrl = services.socketUrl ?? pageSocketUrl
  const socketProtocols = services.socketProtocols ?? localSocketProtocols
  const pty = createPtyClient({ http, baseUrl, socketUrl, socketProtocols })
  ctx.onDispose(pty.dispose)
  /* Lane citc: the cloud-workspace terminal transport, one socket per session. */
  const cloudTerminal = createCloudTerminalClient({
    socketUrl: services.cloudSocketUrl ?? pageCloudSocketUrl,
    socketProtocol: () => socketProtocols()[0]
  })
  ctx.onDispose(cloudTerminal.dispose)
  const targetRuns = createTargetRunClient({ socketUrl, socketProtocols })
  ctx.onDispose(targetRuns.dispose)
  /*
   * Code intelligence (docs/code-intel/PLAN.md §3-4): the `/api/lsp/*`
   * transport with the `lsp:<repoId>` diagnostics stream, and the seam that
   * turns the three code.* acts into `{ value }` for the model and patches to
   * the file card. A request past 300 ms states itself on the toast stack (the
   * 300 ms law): the host spawns the language server on first use.
   */
  const lsp = createLspClient({ http: (input, init) => ctx.boundedFetch(input, init), baseUrl, socketUrl, socketProtocols })
  ctx.onDispose(lsp.dispose)
  /*
   * Lane L6: the workspace language-server transport (plue #505), one socket
   * per (workspace, language) through the same tunnel the cloud terminal
   * rides — so it exists exactly where that tunnel does (`cloud.terminal`);
   * elsewhere the seam tells a cloud file so instead of dialing nothing.
   */
  const cloudLsp = services.bootstrap === undefined || services.bootstrap.capabilities.includes("cloud.terminal")
    ? createCloudLspClient({
      http: seamCtx.http,
      baseUrl,
      socketUrl: services.cloudLspSocketUrl ?? pageCloudLspSocketUrl,
      socketProtocol: () => socketProtocols()[0]
    })
    : undefined
  if (cloudLsp !== undefined) ctx.onDispose(cloudLsp.dispose)
  const codeIntelSeam = actors.pair(seamCtx, (context, select) => createCodeIntelSeam(context, { lsp, readFile: select(filesSeam.readFile), ...(cloudLsp === undefined ? {} : { cloudLsp }) }))
  ctx.onDispose(codeIntelSeam.dispose)
  const { codeHover, codeDefinition, codeDiagnostics } = actors.pair(seamCtx, (_context, select) => {
    const seam = select(codeIntelSeam)
    return {
      codeHover: (path: string, line: number, column: number, repo?: string) =>
        withToast("code.hover", `Asking the language server about ${path}:${line}:${column}…`, "Language server answered", () => seam.hover(path, line, column, repo)),
      codeDefinition: (path: string, line: number, column: number, repo?: string) =>
        withToast("code.definition", `Asking the language server where ${path}:${line}:${column} is defined…`, "Language server answered", () => seam.definition(path, line, column, repo)),
      codeDiagnostics: (path: string, repo?: string) =>
        withToast("code.diagnostics", `Asking the language server about ${path}…`, "Language server answered", () => seam.diagnostics(path, repo))
    }
  })
  const targetGraph = actors.pair(ctx, (context) => createTargetGraphController(context, {
    nextOrdinal: nextTranscriptOrdinal,
    runs: targetRuns,
    devFixtures: createTargetGraphDevFixtures()
  }))
  const { openRepo, listTargets, runTarget, runPattern, openTarget, filterTargets, selectTarget, starTarget, expandTargetGroup, pickTargets, runTargetSet } =
    actors.pair(ctx, (context, select) => createTargetsController(context, {
    nextOrdinal: nextTranscriptOrdinal,
    loadRepos: select(loadRepos),
    runs: targetRuns,
    onRunStarted: select(targetGraph.noteRunStarted)
  }))
  ctx.openRepo = openRepo

  const {
    pumpWorkflowRun,
    stopWatchingRun,
    retryRunWatch,
    resumeWorkflowRuns
  } = createWorkflowPumpController(ctx, nextTranscriptOrdinal)

  const workflowController: WorkflowController = actors.pair(ctx, (context) => createWorkflowController(context, nextTranscriptOrdinal, pumpWorkflowRun))
  const {
    createWorkflow,
    listWorkspaceWorkflows,
    showFlows,
    runWorkflow,
    chooseWorkflowRepo,
    forwardApprovalDecision,
    forwardInboxApprovalDecision
  } = workflowController
  const { listTriggers, registerTrigger } = triggersSeam
  const runs = actors.pair(ctx, (context, select) => createRunsController(context, nextTranscriptOrdinal, select(workflowController)))
  const {
    subscribeToAgent,
    send,
    reset,
    stop,
    decideApproval,
    retryLastTurn
  } = createTurnController(ctx, {
    settleTurnBilling,
    nextOrdinal: nextTranscriptOrdinal,
    surfaceCommandFailure,
    forwardApprovalDecision,
    forwardInboxApprovalDecision
  })
  const cloudWiki = actors.pair(ctx, (context) => createCloudWikiController(context, nextTranscriptOrdinal))
  const { listCloudWiki, openCloudWiki, retryCloudWiki, attachWorldEditor } = cloudWiki
  const {
    clearConversation,
    selectWorldDocument,
    changeWorldDocument,
    createWorldDocument,
    removeWorldDocument,
    confirmWorldDelete,
    cancelWorldDelete,
    openWorldDocument,
    showWorldLinks,
    showWorldGraph,
    attachWikiEditor,
    jumpToHeading,
    selectWikiCardDocument,
    setWikiCardView
  } = actors.pair(ctx, (context, select) => createWorldController(context, { nextOrdinal: nextTranscriptOrdinal, cloudWiki: select(cloudWiki) }))

  const changeDraft = (draft: string): void => {
    store.dispatch({ type: "composer.changed", actor: "user", draft })
  }

  /*
   * The requirement axis (registry.ts commandRequirements): the registry's
   * run path parks a user-invoked command here when a requirement is unmet,
   * and the seams that can satisfy one (identity load) resume it. Durable in
   * the session row because sign-in is a
   * full OAuth redirect. One parking spot, latest wins.
   */
  const deferCommand = (name: string, args: string | null, requirement: string): void => {
    store.dispatch({ type: "command.deferred", actor: "user", name, args, requirement })
  }

  const noteCommandRun = (name: string): void => {
    store.dispatch({ type: "command.ran", actor: "user", name })
  }

  /* The palette's session acts (palette spec §3): open, close, the actions panel, the recents ledger. */
  const openPalette = (prefix?: string): void => {
    if (prefix !== undefined && prefix !== "") store.dispatch({ type: "composer.changed", actor: "user", draft: prefix })
    if (store.session().paletteOpen !== true) store.dispatch({ type: "palette.toggled", actor: "user", open: true })
  }
  const closePalette = (lastQuery?: string): void => {
    if (store.session().paletteOpen !== true) return
    store.dispatch({ type: "palette.toggled", actor: "user", open: false, ...(lastQuery === undefined ? {} : { lastQuery }) })
  }
  const togglePaletteActions = (ref: string): void => {
    if (store.session().paletteOpen !== true) store.dispatch({ type: "palette.toggled", actor: "user", open: true })
    const current = store.session().paletteActionsRef ?? null
    store.dispatch({ type: "palette.actions.toggled", actor: "user", ref: current === ref ? null : ref })
  }
  const notePaletteItemOpened = (item: { readonly kind: string; readonly ref: string }): void => {
    store.dispatch({ type: "palette.item.opened", actor: "user", ref: item.ref, kind: item.kind, at: Date.now() })
  }
  const paletteRecent = (): { readonly value: string } => ({ value: JSON.stringify({ items: store.session().paletteRecents ?? [] }) })

  const toggleVerbose = (): void => {
    store.dispatch({ type: "verbose.toggled", actor: "user", on: store.session().verbose !== true })
  }

  const traceFlow = (record: Extract<AppTransition, { type: "flow.invoked" }>): void => {
    store.dispatch(record)
  }

  /*
   * A `confirm` flow the MODEL asked for: the act is consequential (land a
   * PR, remove a credential), so the agent's invocation never runs the
   * handler — it posts this message, and the button runs the flow as the
   * user. The honest middle between "user-only" (the agent cannot even ask,
   * the refusal Will read as a bug) and silent execution.
   */
  const requestFlowConfirmation = (name: string, args: string | null, label: string): void => {
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: `Smithers wants to ${label}${args === null ? "" : ` (${args})`}. It runs when you confirm.`,
      action: {
        flow: name,
        ...(args === null ? {} : { args }),
        label: `Confirm: ${label}`
      }
    })
  }

  /*
   * The next-step recommender: the registry does not exist yet at this point,
   * so every dependency is a closure read at regeneration time.
   */
  const recommender = createRecommendController(ctx, {
    catalog: () => ctx.commands.all(),
    state: () => ctx.commands.state(),
    repoStep: () =>
      repoStep({
        localPickerAvailable: repositories.available && ctx.commands.find("repo.open") !== undefined,
        connectors: [...store.collections.connectors.values()],
        repos: [...store.collections.repos.values()]
      }),
    repo: () => activeRepositoryId(store),
    // Without the pills there is nowhere for the server's answer to show, so no request leaves.
    config: { ...services.recommender, enabled: (services.recommender?.enabled ?? false) && features.suggestionPills }
  })
  const recommend = recommender.recommend
  const { explain } = createExplainController(ctx, services.explainer ?? {})

  /*
   * auth.prompt: the agent cannot navigate the user to OAuth (auth.sign-in
   * is user-only — a model must not yank the page mid-turn), but it CAN
   * hand the step over: one message whose action IS the sign-in button.
   * Every identity state answers honestly, including a build with no seam.
   */
  const promptSignIn = (): void => {
    const identity = store.collections.identitySessions.get("identity")
    if (identity?.state === "signed-in") {
      store.dispatch({
        type: "message.appended",
        actor: "system",
        text: `GitHub is already connected as ${identity.login ?? "you"}.`
      })
      return
    }
    if (identity === undefined || identity.state === "unavailable") {
      store.dispatch({
        type: "message.appended",
        actor: "system",
        text:
          "Sign-in isn't available on this build — no identity service is configured here. Use the deployed app to sign in."
      })
      return
    }
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: "One step connects GitHub: sign in, and Smithers can read the repositories you choose.",
      action: { flow: "auth.sign-in", label: "Sign in with GitHub" }
    })
  }

  /*
   * cloud.prompt, mirroring auth.prompt (agent-parity.md): the agent cannot
   * run cloud.sign-in (the browser login is the human's gesture), but it CAN
   * hand the step over — one message whose action IS the Smithers Cloud
   * sign-in button. A host without the PAT door (the web) has no
   * cloud.sign-in to offer: there the GitHub sign-in IS the Cloud sign-in
   * (Instructions.ts WEB_HOST_LINE), so that step is the one rendered.
   * Referenced before `commands` initializes; only ever called after.
   */
  const promptCloudSignIn = (): void => {
    const cloud = store.collections.cloudSessions.get("cloud")
    if (cloud?.state === "signed-in") {
      store.dispatch({
        type: "message.appended",
        actor: "system",
        text: `Smithers Cloud is already signed in as ${cloud.username ?? "you"}.`
      })
      return
    }
    if (commands.find("cloud.sign-in") === undefined) {
      promptSignIn()
      return
    }
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: "One step signs in to Smithers Cloud: workspaces, changes and sync need it.",
      action: { flow: "cloud.sign-in", label: "Sign in to Smithers Cloud" }
    })
  }

  /*
   * The repository welcome and its three answers: the sign-in gate rides the
   * requirement axis' park (deferCommand) and the auth.prompt step; the
   * feature prototype rides flow.run's launch path as a run of kind prototype.
   */
  const onboarding = actors.pair(ctx, (context, select) =>
    createOnboardingController(context, {
      nextOrdinal: nextTranscriptOrdinal,
      deferCommand,
      promptSignIn,
      workflows: select(workflowController)
    }))

  /*
   * The account card (mock 21): seam facts about the signed-in person, or the
   * sign-in step when no one is, through auth.prompt's renderer.
   */
  const account = actors.pair(ctx, (context) =>
    createAccountController(context, { nextOrdinal: nextTranscriptOrdinal, promptSignIn }))

  /*
   * The /chat.commands answer: the LIVE visible catalog as one chat message —
   * the slash menu caps at 8 for calm, so this is where "all of it" lives.
   * Referenced before `commands` initializes; only ever called after.
   */
  const showCommandCatalog = (): void => {
    const lines = commands
      .all()
      .filter((command) => command.hidden !== true)
      .map((command) => `- \`/${command.name}\` — ${command.summary}`)
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: `Everything Smithers can do right now:\n\n${
        lines.join("\n")
      }\n\nType \`/\` in the composer to filter these as you type.`
    })
  }

  const reloadApp = (): void => {
    if (typeof window !== "undefined") window.location.reload()
  }

  /** A deferral older than this resumes nothing: firing it would surprise, not continue. */
  const deferralMaxAgeMs = 15 * 60 * 1000

  const resumeDeferredCommand = (): void => {
    const pending = store.session().pendingCommand
    if (pending === undefined || pending === null) return
    const requirement = flowRequirements.find((candidate) => candidate.id === pending.requirement)
    // Still waiting (or the requirement id no longer exists): leave it parked.
    if (requirement !== undefined && !requirement.satisfied(commands.state())) return
    store.dispatch({ type: "command.deferral.cleared", actor: "system" })
    if (requirement === undefined || Date.now() - pending.requestedAt > deferralMaxAgeMs) return
    // The app acting on its own is announced (300ms law does not apply: this
    // IS the act, not its latency) — then the command re-enters the one run
    // path, where the NEXT unmet requirement, if any, parks it again.
    const key = `command.resume.${pending.name}`
    store.dispatch({ type: "toast.shown", actor: "system", key, title: `Continuing /${pending.name}` })
    void commands.run(pending.name, pending.args ?? undefined).then((outcome) => {
      resolveToast(key, {
        status: outcome.status === "failed" ? "failed" : "ok",
        detail: outcome.status === "failed"
          ? outcome.error
          : outcome.status === "unknown-command"
          ? `/${pending.name} is no longer a command`
          : `/${pending.name} continued`
      })
    })
  }
  ctx.resumeDeferredCommand = resumeDeferredCommand

  const {
    connectLocalRepository,
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector
  } = actors.pair(ctx, (context) => createConnectorController(context))

  // A fresh-user reset closes producers only after the durable clear succeeds.
  const debugReset = async (): Promise<string | void> => {
    if (store.collections.identitySessions.get("identity")?.state === "signed-in") {
      const error = await signOut()
      if (typeof error === "string") return error
    }
    if (store.collections.cloudSessions.get("cloud")?.state === "signed-in") {
      const error = await cloudSeam.signOut()
      if (typeof error === "string") return error
    }
    if (ctx.activeTurn !== undefined) await agent.cancelTurn(ctx.activeTurn.id)
    ctx.activeTurn = undefined
    ctx.stopWorkflowPumps()
    await store.dispatch({ type: "app.reset", actor: "user" }).isPersisted.promise
    await ctx.dispose()
    if (typeof window !== "undefined") {
      const path = window.location.pathname.startsWith("/w/") ? "/" : window.location.pathname
      window.history.replaceState(null, "", path)
      window.location.reload()
    }
  }

  /*
   * The agent's entry point uses fixed smithers bindings — whether it
   * arrives through the streaming tool
   * loop or a direct executeForAgent call — so agent invocations render
   * embedded cards and record via:"agent", never user chrome.
   */
  const commandActions: CommandActions = {
    promptStorageRecovery,
    exportStorageRecovery,
    bootstrap: services.bootstrap,
    repositoryFlows,
    knownRepositories: () => knownRepositories(store),
    changeDraft,
    reset,
    debugReset,
    askReset,
    cancelReset,
    stop,
    send,
    showChat,
    showWorld,
    showConnectors,
    showPlugins,
    installPlugin,
    removePlugin,
    listPlugins,
    connectLocalRepository,
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector,
    selectWorldDocument,
    changeWorldDocument,
    createWorldDocument,
    removeWorldDocument,
    confirmWorldDelete,
    cancelWorldDelete,
    openWorldDocument,
    showWorldLinks,
    showWorldGraph,
    attachWikiEditor,
    jumpToHeading,
    listCloudWiki,
    openCloudWiki,
    retryCloudWiki,
    attachWorldEditor,
    selectWikiCardDocument,
    setWikiCardView,
    decideApproval,
    retryLastTurn,
    clearConversation,
    openBrowser,
    createWorkflow,
    listWorkspaceWorkflows,
    listTriggers,
    showFlows,
    runWorkflow,
    chooseWorkflowRepo,
    stopWatchingRun,
    retryRunWatch,
    resumeWorkflowRuns,
    listRuns: runs.listRuns,
    openRun: runs.openRun,
    resumeRun: runs.resumeRun,
    rerunRun: runs.rerunRun,
    signalRun: runs.signalRun,
    steerRun: runs.steerRun,
    steerRunSeat: runs.steerRunSeat,
    steerRunThinking: runs.steerRunThinking,
    steerRunTools: runs.steerRunTools,
    showRunLogs: runs.showRunLogs,
    showRunSteps: runs.showRunSteps,
    showRunEvents: runs.showRunEvents,
    traceFilter: runs.traceFilter,
    traceSelect: runs.traceSelect,
    selectCodingChange: runs.selectCodingChange,
    traceView: runs.traceView,
    traceLive: runs.traceLive,
    stopAllRuns: runs.stopAllRuns,
    listApprovals: runs.listApprovals,
    openApproval: runs.openApproval,
    maximizeCard,
    minimizeCard,
    frameBack,
    frameForward,
    forkFrame,
    openTerminalTab,
    openHarnessTab,
    readTab,
    openCardTab,
    selectTab,
    closeTab,
    confirmTabClose,
    cancelTabClose,
    toggleTabMenu,
    selectRepo,
    unpinRepo,
    toggleRepoTree,
    renameWorkspace,
    toggleWorkspaceRename,
    openLocalRepo,
    loadHarnesses,
    loadAgents,
    listAgents,
    newAgent,
    createAgent,
    editAgent,
    removeAgent,
    listHarnessModels,
    renderFlowForm,
    setFormField,
    submitForm,
    dismissCard,
    loadRepos,
    notePtyExit,
    pty,
    cloudTerminal,
    openRepo,
    listTargets,
    runTarget,
    runPattern,
    openTarget,
    filterTargets,
    selectTarget,
    starTarget,
    expandTargetGroup,
    pickTargets,
    runTargetSet,
    showGraph: targetGraph.showGraph,
    focusGraphNode: targetGraph.focusGraph,
    filterGraph: targetGraph.filterGraph,
    showRunTimeline: targetGraph.showTimeline,
    showRunHistory: targetGraph.showHistory,
    selectRunReplay: targetGraph.selectRun,
    scrubRunReplay: targetGraph.scrubRun,
    showAffected: targetGraph.showAffected,
    showCiMatrix: targetGraph.showCi,
    openTargetSource: targetGraph.openSource,
    toggleDevtools,
    toggleSurfacesMenu,
    searchPalette: searchSeam.palette,
    search: searchSeam.search,
    openPalette,
    closePalette,
    togglePaletteActions,
    notePaletteItemOpened,
    paletteRecent,
    toggleConnectMenu,
    closeConnectMenu,
    toggleAddMenu,
    closeAddMenu,
    addFiles,
    describeAgentBackend,
    debugSnapshot,
    debugEvents,
    debugChain,
    debugNet,
    netTap,
    netTapEntries,
    resetGrants,
    debugSeams,
    guideAct,
    toggleTheme,
    setPalette,
    adoptSession,
    loadSession,
    signIn,
    signOut,
    requestAccess,
    handleAuthReturn,
    deferCommand,
    resumeDeferredCommand,
    noteCommandRun,
    toggleVerbose,
    traceFlow,
    requestFlowConfirmation,
    recommend,
    explain,
    showCommandCatalog,
    promptSignIn,
    promptCloudSignIn,
    reloadApp,
    openDownload,
    promptDownload,
    introduce,
    showAccount: account.showAccount,
    welcomeRepo: onboarding.welcomeRepo,
    maintainRepo: onboarding.maintainRepo,
    contributeRepo: onboarding.contributeRepo,
    exploreRepo: onboarding.exploreRepo,
    homeRepo: onboarding.homeRepo,
    prototypeFeature: onboarding.prototypeFeature,
    listIssues: issuesSeam.listIssues,
    viewIssue: issuesSeam.viewIssue,
    createIssue: issuesSeam.createIssue,
    setIssueState: issuesSeam.setIssueState,
    commentOnIssue: issuesSeam.commentOnIssue,
    linkIssueLinear: issuesSeam.linkLinear,
    unlinkIssueLinear: issuesSeam.unlinkLinear,
    listLandings: landingsSeam.listLandings,
    viewLanding: landingsSeam.viewLanding,
    createLanding: landingsSeam.createLanding,
    landLanding: landingsSeam.landLanding,
    reviewLanding: landingsSeam.reviewLanding,
    startCheckout: billingSeam.startCheckout,
    openBillingPortal: billingSeam.openBillingPortal,
    listNotifications: notificationsSeam.listNotifications,
    markNotificationsRead: notificationsSeam.markNotificationsRead,
    viewEnvironment: environmentSeam.viewEnvironment,
    setEnvironmentVar: environmentSeam.setEnvironmentVar,
    listSecrets: secretsSeam.listSecrets,
    showHistory: showMythicalHistory,
    retellHistory: historySeam.retellHistory,
    showFactory: factorySeam.showFactory,
    registerTrigger,
    importRepository: repoImportSeam.importRepository,
    retryImport: repoImportSeam.retryImport,
    listBookmarks: bookmarksSeam.listBookmarks,
    listFiles: filesSeam.listFiles,
    readFile: filesSeam.readFile,
    codeHover,
    codeDefinition,
    codeDiagnostics,
    linearConnect: linearSeam.connect,
    linearConnectOpen: linearSeam.openLinear,
    linearConnectTeam: linearSeam.pickTeam,
    linearConnectRepo: linearSeam.pickRepository,
    linearConnectConfirm: linearSeam.confirmConnect,
    linearSync: linearSeam.syncNow,
    linearActivity: linearSeam.activity,
    linearDisconnect: linearSeam.disconnect,
    retrySyncOp: linearSeam.retryOp,
    showMoreSyncOps: linearSeam.showMoreOps,
    loadOlderSyncOps: linearSeam.loadOlderOps,
    githubApp: gitHubSeam.app,
    githubOpenInstall: gitHubSeam.openInstall,
    githubReconcile: gitHubSeam.reconcile,
    retryMirrorRef: gitHubSeam.retryMirrorRef,
    githubMirrorSync: gitHubSeam.mirrorSync,
    loadCloudSession,
    signInCloud,
    signOutCloud: cloudSeam.signOut,
    loadRepositories: repositoriesSeam.loadRepositories,
    listWorkspaces: workspaceSeam.listWorkspaces,
    openWorkspace: workspaceSeam.openWorkspace,
    viewWorkspace: workspaceSeam.viewWorkspace,
    openWorkspaceTerminal: workspaceSeam.openTerminal,
    suspendWorkspace: workspaceSeam.suspendWorkspace,
    resumeWorkspace: workspaceSeam.resumeWorkspace,
    forkWorkspace: workspaceSeam.forkWorkspace,
    snapshotWorkspace: workspaceSeam.snapshotWorkspace,
    deleteWorkspaceSnapshot: workspaceSeam.deleteSnapshot,
    forkWorkspaceFromSnapshot: workspaceSeam.forkFromSnapshot,
    templateWorkspaceSnapshot: workspaceSeam.templateSnapshot,
    listWorkspaceSessions: workspaceSeam.listSessions,
    destroyWorkspaceSession: workspaceSeam.destroySession,
    deleteWorkspace: workspaceSeam.deleteWorkspace,
    setWorkspaceFacet: workspaceSeam.setFacet,
    listWorkspaceFiles: workspaceSeam.listFiles,
    readWorkspaceFile: workspaceSeam.readFile,
    listWorkspaceServices: workspaceSeam.listServices,
    listWorkspaceEgress: workspaceSeam.listEgress,
    openWorkspaceDesktop: workspaceSeam.openDesktop,
    rotateWorkspaceDesktop: workspaceSeam.rotateDesktop,
    listEnvironmentImages: workspaceSeam.listEnvironmentImages,
    listSessionEgress: egressSeam.listSessionEgress,
    viewChange: changeSeam.viewChange,
    diffChange: changeSeam.diffChange,
    landChange: changeSeam.landChange,
    splitReadyChange: changeSeam.splitReady,
    splitChange: changeSeam.splitChange,
    resolveChangeConflict: changeSeam.resolveConflict,
    revertChange: changeSeam.revertChange,
    setChangeFacet: changeSeam.setFacet,
    setChangePins: changeSeam.setPins,
    checksOfChangeAt: changeSeam.checksAt,
    openChangeComputer: changeSeam.openComputer,
    diffSinceMyReview: changeSeam.sinceMyReview,
    reviewThreadDone: changeSeam.threadDone,
    reviewThreadAck: changeSeam.threadAck,
    reviewThreadReopen: changeSeam.threadReopen,
    fixFinding: changeSeam.pleaseFix,
    findingNotUseful: changeSeam.notUseful,
    requestChangeReview: changeSeam.requestReview,
    unrequestChangeReview: changeSeam.unrequestReview,
    dismissToast,
    refreshBalance,
    showBalance,
    adminAllowlist,
    adminGrant,
    adminGrantConfirm,
    adminGrantCancel,
    adminRequests,
    adminQueueApprove,
    adminHealth,
    snapshot: () => {
      const identity = store.collections.identitySessions.get("identity")
      const signedIn = identity?.state === "signed-in"
      return {
        surface: store.session().surface,
        plugins: store.session().plugins ?? [],
        typing: store.session().phase === "responding",
        // Sign-in IS the GitHub connector (§2a′): a valid session means
        // work IS connected, so "connect" stops leading the next actions.
        hasConnectors: signedIn || [...store.collections.connectors.values()].length > 0,
        // A Vite dev build unlocks the admin plugin (devtools, debug reads)
        // without a session — dev has no identity seam to grant admin, and
        // the machinery panel is exactly what dev needs. Vite serves DEV as
        // the boolean true; production builds and bun tests see
        // undefined/"" (tsc types the field string, hence the cast).
        admin: (signedIn && identity.admin) ||
          (import.meta.env?.DEV as boolean | string | undefined) === true,
        signedOut: identity?.state === "signed-out",
        hasOpenRepos: store.collections.repos.size > 0,
        publicRepo: activeCatalogRepositoryId(store) !== null,
        recent: store.session().recentCommands ?? [],
        identity: identity === undefined
          ? "unknown"
          : identity.state === "signed-in"
          ? `signed-in as ${identity.login ?? "?"}`
          : identity.state
      }
    }
  }
  const registry = createCommandRegistry(commandActions, actors.select(commandActions))
  /*
   * The user's one door (slash, button, pill, form submit) also answers the
   * standing recommendation: the recommender reports the dispatched flow as
   * its outcome before the flow runs. The agent's doors never pass here.
   */
  const commands: CommandRegistry = {
    ...registry,
    run: (name, args) => {
      recommender.noteDispatch(name)
      return registry.run(name, args)
    }
  }
  ctx.commands = commands

  subscribeToAgent()
  // Material transitions regenerate the next-step pills through the `recommend` flow.
  recommender.subscribe()
  // The active repository's flow catalog, read now and on every change of target, so its leaves are in the registry.
  repositoryFlowsSeam.subscribe(ctx.onDispose)
  watchIdentityAcrossTabs()
  // Cmd+T / Cmd+W / Cmd+1..9 on the document, released with the controller.
  if (typeof document !== "undefined") ctx.onDispose(installKeyboard(document))
  // One completion identity, including for a reentrant close from a resource.
  // The scope stops pumps, then releases consumers before their hosts.
  const dispose = ctx.dispose

  const runCommand = (name: string, args?: string): boolean => {
    if (commands.find(name) === undefined) return false
    void commands.run(name, args).then((outcome) => surfaceCommandFailure(name, outcome))
    return true
  }

  /*
   * The public controller IS the command surface: one map feeds the registry
   * and the UI, so a binding cannot drift between the two doors. Only the
   * composition root's own members join here; the registry's state read stays
   * internal to it.
   */
  const { snapshot: _snapshot, ...sharedActions } = commandActions
  return {
    ...sharedActions,
    store,
    storageRecoveryState,
    downloadUrl,
    features,
    nativeAgentAvailable: agent.available,
    nativeRepositoriesAvailable: repositories.available,
    tappedFetch: http,
    commands,
    slashItems: (needle) => commands.slashItems(needle),
    slashTree: (needle) => commands.slashTree(needle),
    runCommand,
    dispose
  }
}
