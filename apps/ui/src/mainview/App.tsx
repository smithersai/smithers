import { GuideComposerHost, GuideShell } from "./onboarding/GuideShell"
import {
  Badge,
  Button,
  ChatMessage,
  ChatTranscript,
  EmptyState,
  FileTree,
  Markdown,
  Marker,
  Reasoning,
  SmithersUiStyles,
  Suggestion,
  SuggestionGroup
} from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import {
  BookOpen,
  CheckCircle2,
  Copy,
  Factory,
  HelpCircle,
  Plus,
  RotateCcw,
  Sparkles,
  Timer,
  Trash2,
  Waypoints,
  Workflow
} from "lucide-react"
import { BacklinksPanel, OutlineView } from "@smthrs/ui/vault"
import { lazy, Suspense, useMemo, useContext, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { createPortal } from "react-dom"
import { CardView } from "./ChatCards"
import { cardActions } from "./cards/CardActions"
import { TriggerListCardBody } from "./cards/TriggersCard"
import { WorkflowListCardBody } from "./cards/WorkflowCards"
import { Composer } from "./Composer"
import { ConnectorsSurface } from "./ConnectorsSurface"
import { PluginsSurface } from "./plugins/PluginsSurface"
import { useController } from "./ControllerContext"
import { DevtoolsPanel } from "./DevtoolsPanel"
import { stampFlows } from "./FlowStamp"
import { INIT_GREETING, INIT_TITLE, initMessage, repoStep, repoSuggestion } from "./Onboarding"
import type { InitMessage } from "./Onboarding"
import type { Card, Message, Suggestion as SuggestionBinding } from "./state/AppState"
import { WIKI_DISPLAY_NAME, WIKI_GRAPH_ALL_SCOPE } from "./state/AppState"
import { scrubToolEcho } from "./state/MessageScrub"
import { conversationTabIdOf, inConversation, MAIN_TAB_ID } from "./state/AppState"
import { catalogRepositoryOf } from "./state/RepoContext"
import { ConfirmDialog, SurfaceHeader } from "./SurfaceChrome"
import { ChromeBar } from "./tabs/ChromeBar"
import { TabBodies } from "./tabs/TabBodies"
import { timeLabel } from "./Timestamps"
import { ToastStack } from "./ToastStack"
import { useCardRows, useWorkflowCatalogRows } from "./state/useCardRows"
import { linkGraphOf, linksOf, neighbourhoodOf } from "./wiki/VaultAdapter"
import { StorageRecoveryButton } from "./StorageRecoveryButton"
import { STORAGE_RECOVERY_EXPORT } from "./state/StorageRecoveryContract"

const MarkdownEditorSurface = lazy(() =>
  import("./MarkdownEditorSurface").then((module) => ({ default: module.MarkdownEditorSurface }))
)
/* The Wiki pane's graph mode renders over d3-force; it loads on first use like the editor. */
const KnowledgeGraphSurface = lazy(() =>
  import("./KnowledgeGraphSurface").then((module) => ({ default: module.KnowledgeGraphSurface }))
)

const systemNoteLabel = (message: Message): string => {
  if (message.statusDetail !== undefined) return `Turn interrupted — ${message.statusDetail}`
  return message.status === "failed" ? "Turn failed" : "Turn interrupted"
}

type TranscriptEntry =
  | { readonly kind: "message"; readonly message: Message }
  | { readonly kind: "init"; readonly message: InitMessage }
  | { readonly kind: "card"; readonly card: Card }

const entryOrdinal = (entry: TranscriptEntry): number =>
  entry.kind === "card" ? entry.card.ordinal : entry.message.ordinal

const entryCreatedAt = (entry: TranscriptEntry): number =>
  entry.kind === "card" ? entry.card.createdAt : entry.message.createdAt

function CopyMessageButton({
  text,
  onCopy
}: {
  readonly text: string
  readonly onCopy: (text: string) => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="message-action"
      data-flow="chat.copy-message"
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      onClick={() => {
        onCopy(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <span className="message-action-copied">Copied</span> : <Copy size={12} />}
    </Button>
  )
}


function App() {
  const controller = useController()
  const { collections } = controller.store
  /*
   * The transcript's order is the QUERY's order (§hot path): sorting a copy of
   * every row on every render made each keystroke O(messages log messages) on
   * top of the render it should not have caused at all. The collection sorts
   * incrementally and hands back rows already in order.
   */
  const { data: messageRows } = useLiveQuery((q) =>
    q.from({ message: collections.messages }).orderBy(({ message }) => message.ordinal)
  )
  /*
   * The shell reads the session WITHOUT the draft.
   *
   * The draft changes on every keystroke, and this subscription carried it —
   * so typing one character re-rendered App, and App renders the whole
   * transcript. The projection is consolidated by the query, so a draft-only
   * write produces no change here at all and the transcript stays still;
   * `Composer` below subscribes to the draft, one component deep, and is the
   * only thing a keystroke re-renders.
   */
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      phase: session.phase,
      theme: session.theme,
      surface: session.surface,
      selectedWorldDocumentId: session.selectedWorldDocumentId,
      maximizedCardId: session.maximizedCardId,
      activeWorkspaceId: session.activeWorkspaceId,
      activeBranchId: session.activeBranchId,
      activeFrameId: session.activeFrameId,
      devtoolsOpen: session.devtoolsOpen,
      surfacesMenuOpen: session.surfacesMenuOpen,
      connectMenuOpen: session.connectMenuOpen,
      pendingWorldDeleteId: session.pendingWorldDeleteId,
      wikiPane: session.wikiPane,
      wikiGraphPath: session.wikiGraphPath,
      activeTabId: session.activeTabId,
      tabMenuOpen: session.tabMenuOpen,
      addMenuOpen: session.addMenuOpen,
      paletteOpen: session.paletteOpen,
      paletteLastQuery: session.paletteLastQuery,
      resetConfirmOpen: session.resetConfirmOpen,
      verbose: session.verbose,
      activeRepoKey: session.activeRepoKey
    }))
  )
  const { data: worldDocumentRows } = useLiveQuery(collections.worldDocuments)
  const cardRows = useCardRows(collections.cards)
  const workflowCatalogs = useWorkflowCatalogRows(collections.cards)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)
  const { data: toastRows } = useLiveQuery((q) =>
    q.from({ toast: collections.toasts }).orderBy(({ toast }) => toast.createdAt)
  )
  const { data: harnessRows } = useLiveQuery(collections.harnesses)
  const { data: connectorRows } = useLiveQuery(collections.connectors)
  const { data: repoRows } = useLiveQuery(collections.repos)
  const { data: repositoryRows } = useLiveQuery(collections.repositories)
  const { data: recommendationRows } = useLiveQuery(collections.recommendations)
  /*
   * §10.6: the delete question lives in the store, not here — a component is
   * a projection, never an authority, and the local-state version was
   * bypassed entirely by `/wiki.delete <id>` typed into the composer.
   */
  /* The surfaces trigger, refocused by this shell's Escape and by the menu itself. */
  const surfacesTriggerRef = useRef<HTMLButtonElement>(null)
  /* The composer wrap: Cmd+K focuses the textarea inside it (the palette opens on the composer). */
  const composerWrapRef = useRef<HTMLDivElement>(null)
  /*
   * The guide's composer host: inside the guide shell the composer is hidden
   * by default and Command-K summons ONLY it into the transparent overlay;
   * outside the guide (undefined) the composer stays docked as before.
   */
  const composerHost = useContext(GuideComposerHost)
  /* The connect trigger has the same shell-level Escape exit as surfaces. */
  const connectTriggerRef = useRef<HTMLButtonElement>(null)
  /* The composer's `+` menu is the third session menu the shell closes the same way. */
  const addTriggerRef = useRef<HTMLButtonElement>(null)
  const session = sessionRows[0] ?? controller.store.session()
  /*
   * The conversation on screen (docs/LOCAL-APP.md "Tabs"): there is ONE
   * Smithers, the first tab, aware of every other one — so the conversation is
   * always main's. Rows keep their conversation stamp (a turn in flight writes
   * where it started), and this filter reads it.
   */
  const conversationTabId = conversationTabIdOf(session)
  const messages = messageRows.filter((message) => inConversation(message, conversationTabId))
  const conversationCards = cardRows.filter((card) => inConversation(card, conversationTabId))
  /*
   * Ask 5 (will, 2026-09-02): the Flows pane shows what `flow.list` last
   * answered with — the newest listing card, rendered through that card's own
   * rows below. NO INVENTION: with no listing yet the pane holds nothing and
   * the seam's refusal (why it could not list) stands in the chat beside it.
   */
  const flowsCard = cardRows
    .filter((card): card is Extract<Card, { kind: "workflow-list" }> => card.kind === "workflow-list")
    .reduce<Extract<Card, { kind: "workflow-list" }> | undefined>(
      (latest, card) => (latest === undefined || card.ordinal > latest.ordinal ? card : latest),
      undefined
    )
  /* The dispatchers beside the flows: the newest triggers.list card, rendered through its own rows. */
  const triggersCard = cardRows
    .filter((card): card is Extract<Card, { kind: "trigger-list" }> => card.kind === "trigger-list")
    .reduce<Extract<Card, { kind: "trigger-list" }> | undefined>(
      (latest, card) => (latest === undefined || card.ordinal > latest.ordinal ? card : latest),
      undefined
    )
  const canListTriggers = controller.commands.find("triggers.list") !== undefined
  const canShowFactory = controller.commands.find("factory.show") !== undefined
  /*
   * A stable array: CardView is memoized, and re-sorting the same rows into a
   * fresh array on every render would re-render every card body regardless.
   */
  const worldDocuments = useMemo(
    () => [...worldDocumentRows].sort((left, right) => left.path.localeCompare(right.path)),
    [worldDocumentRows]
  )
  const pendingWorldDelete = worldDocuments.find(
    (document) => document.id === (session.pendingWorldDeleteId ?? null)
  )
  const selectedWorldDocument = worldDocuments.find((document) => document.id === session.selectedWorldDocumentId) ??
    worldDocuments[0]
  /*
   * Librarian L5: the link rail and the graph are derived from the same
   * notes the sidebar lists, during render (no effect, no second store).
   * The rail shows the open note's backlinks and resolved links out; the
   * graph mode shows every page (the All scope) or one note's
   * neighbourhood.
   */
  const selectedWorldLinks = selectedWorldDocument === undefined ? undefined : linksOf(worldDocuments, selectedWorldDocument.path)
  const wikiGraphMode = session.surface === "world" && session.wikiPane === "graph"
  const wikiWholeGraph = wikiGraphMode ? linkGraphOf(worldDocuments) : undefined
  const wikiGraph = wikiWholeGraph === undefined ?
    undefined :
    session.wikiGraphPath === null || session.wikiGraphPath === undefined ?
    wikiWholeGraph :
    neighbourhoodOf(wikiWholeGraph, session.wikiGraphPath) ?? wikiWholeGraph
  const typing = session.phase === "responding"
  const activeTabId = session.activeTabId ?? MAIN_TAB_ID
  const streamingMessageId = typing ? messages[messages.length - 1]?.id : undefined
  const identity = identityRows[0]
  const toasts = toastRows

  /*
   * Outside-pointer dismissal belongs to the shell that owns both menus.
   * Capture keeps the original click working and removes global listeners —
   * React remains a projection, and controller disposal owns every external
   * subscription. If focus was inside Surfaces, return it to its trigger.
   */
  const onShellPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (session.surfacesMenuOpen && target.closest(".composer-surfaces") === null) {
      const heldFocus = document.activeElement?.closest(".composer-surfaces") !== null
      controller.runCommand("chat.surfaces")
      if (heldFocus) requestAnimationFrame(() => surfacesTriggerRef.current?.focus())
    }
    if (session.connectMenuOpen === true && target.closest(".composer-connect") === null) {
      controller.closeConnectMenu()
    }
    if (session.addMenuOpen === true && target.closest(".composer-add") === null) {
      controller.closeAddMenu()
    }
  }
  /*
   * One page: the chat. Auth is a conversation state, never a view — a
   * definitive signed-out or non-allowlisted answer opens the transcript
   * with the Smithers message whose action IS the one available step.
   * "Unknown" is not a definitive answer and changes nothing. "Unavailable"
   * IS one about the BUILD: a deployment with no identity seam can never
   * sign in, and pretending otherwise walked live users into empty choosers
   * and dead sign-in flows — so the state names itself up front, once,
   * derived like the rest (never stored, gone the moment a seam answers).
   *
   * Signed out on the web (docs/web-mode/PLAN.md §3) is the third definitive
   * state: the visitor reads what this is and the one act that is theirs,
   * in the shape auth.prompt renders (message + CTA bound to auth.sign-in).
   * Only the cloud host: local keeps its opening read (sign-in is an option
   * there), and a build with no identity seam is "unavailable", not this.
   *
   * With a public catalog repository selected (the /owner/name path,
   * apps/server/PUBLIC-REPOSITORIES.md) the signed-out visitor is not gated:
   * the transcript opens on the repository's welcome card instead
   * (repo.welcome, controller/onboarding.ts), whose maintain and contribute
   * doors render the sign-in step when it is needed. Reads and chat work.
   */
  /*
   * The host, named once, because the sign-in message and the gate below both
   * read it. `AppBootstrap.host` is exactly "cloud" or "local", so on every
   * real host `cloudHost` and the gate's `host !== "local"` are the same
   * answer; they part only where there is no bootstrap at all (a harness),
   * and there the empty transcript is the pinned behaviour — a build that
   * cannot name its host has no sign-in to offer and no opening read to give.
   */
  const cloudHost = controller.bootstrap?.host === "cloud"
  const exploringRepo = identity?.state === "signed-out" && cloudHost
    ? catalogRepositoryOf(session.activeRepoKey, repositoryRows)
    : null
  const authMessage: Message | undefined = identity?.state === "signed-out" && cloudHost
    ? exploringRepo === null
      ? {
        id: "auth-state",
        role: "smithers",
        text: "This is the Smithers web app. Sign in with GitHub to open one of your repositories and read its files here.",
        status: "complete",
        action: { flow: "auth.sign-in", label: "Sign in with GitHub" },
        createdAt: 0,
        ordinal: 0
      }
      : undefined
    : identity?.state === "signed-in" && !identity.allowlisted
    ? {
      id: "auth-state",
      role: "smithers",
      text: `${
        identity.accessRequested
          ? "Your request is in — we'll let you know as soon as there's a spot."
          : `You're signed in as ${
            identity.login ?? "a GitHub user"
          }, but Smithers is open to design partners only right now.`
      }${identity.accessError !== null ? `\n\n${identity.accessError}` : ""}${
        identity.accessRequested ? "" : "\n\nType /auth.sign-out to use a different GitHub account."
      }`,
      status: "complete",
      ...(identity.accessRequested
        ? {}
        : { action: { flow: "auth.request-access", label: "Request access" } }),
      createdAt: 0,
      ordinal: 0
    }
    : identity?.state === "unavailable"
    ? {
      id: "auth-state",
      role: "smithers",
      text:
        "This host doesn't provide Smithers identity, so GitHub sign-in and Smithers Cloud account features are unavailable. Commands supported by this host remain available below. Use a Smithers Cloud deployment with identity configured for the signed-in experience.",
      status: "complete",
      createdAt: 0,
      ordinal: 0
    }
    : undefined

  /*
   * The one step the auth state offers, named once because it renders twice:
   * inside the message that explains it, and again as the keyboard shortcut
   * below.
   */
  const authAction = authMessage?.action

  /*
   * The suggestion row is DERIVED (§2a/§2f — never stored, never
   * fabricated): the genuinely-next state-derived step when one exists
   * (signed-out → Sign in; no repo open → Select a repo). An empty pill row
   * is a correct state; a fabricated one is a violation.
   */
  /*
   * Selecting a repository is the one next step, and locally it is the native
   * folder picker (repo.open) — the IDE's open-folder — never a sign-in.
   */
  const step = repoStep({
    localPickerAvailable: controller.nativeRepositoriesAvailable && controller.commands.find("repo.open") !== undefined,
    connectors: connectorRows,
    repos: repoRows
  })
  /*
   * The pills are the recommendation row's projection (state/Recommend.ts):
   * regenerated by the `recommend` flow after every material change — a cheap
   * agent's pick, or the rule's. Before the first regeneration lands the rule
   * answers inline; a pill whose flow this host does not register is dropped.
   */
  const recommended = recommendationRows[0]?.suggestions
  const suggestions: ReadonlyArray<SuggestionBinding> = (recommended ?? repoSuggestion(step))
    .filter((suggestion) => controller.commands.find(suggestion.flow) !== undefined)
  /*
   * The opening entry: what the host registered, derived from the live
   * collections (never stored), with the repo step riding it as its action.
   * A gated auth state (signed out, not allowlisted) still shows only itself.
   */
  /*
   * On the local host sign-in is an option, never a gate (docs/LOCAL-APP.md):
   * repositories, terminals, and harnesses all work signed out, so the
   * opening read shows. Signed out on Cloud, sign-in is the whole transcript.
   */
  const gatedByAuth = (identity?.state === "signed-out" && controller.bootstrap?.host !== "local") ||
    (identity?.state === "signed-in" && !identity.allowlisted)
  // A new conversation opens empty; the host's opening read belongs to main alone.
  const openingMessage: InitMessage | undefined = gatedByAuth || conversationTabId !== undefined ? undefined : initMessage({
    bootstrap: controller.bootstrap,
    flowCount: controller.commands.all().length,
    harnesses: harnessRows,
    connectors: connectorRows,
    repos: repoRows,
    repoStep: step
  })
  // Admin chrome follows the same capability-filtered registry as every act.
  const isAdmin = controller.commands.find("admin.devtools") !== undefined
  /*
   * One binding object for every card in the transcript, and the same one a
   * card tab spreads (cards/CardActions.ts). Built against the controller, not
   * this render, so a card whose record did not change can bail out.
   */
  const actions = cardActions(controller)

  /*
   * §2a″ (wave 12 §4): auth is a conversation STATE, and a state shows only
   * itself. Signed out, the auth message is the whole transcript. Wave 14 §1
   * removed the seeded welcome that used to sit under it, so there is no
   * longer a filler message to filter out here — the transcript is exactly
   * what the session actually said.
   */
  const entries: ReadonlyArray<TranscriptEntry> = [
    ...(openingMessage === undefined ? [] : [{ kind: "init", message: openingMessage } as const]),
    ...(authMessage === undefined ? [] : [{ kind: "message", message: authMessage } as const]),
    ...messages.map((message): TranscriptEntry => ({ kind: "message", message })),
    ...conversationCards.map((card): TranscriptEntry => ({ kind: "card", card }))
  ].sort((left, right) => {
    if (entryOrdinal(left) !== entryOrdinal(right)) return entryOrdinal(left) - entryOrdinal(right)
    return entryCreatedAt(left) - entryCreatedAt(right)
  })

  /*
   * The composer's one home. Docked in the chat column when the app stands
   * alone; hidden while the guide owns the window (the UI is full-screen
   * without a composer by default); summoned through a portal into the
   * guide's transparent Command-K overlay, where it is the only thing shown.
   */
  const composerWrap = (
    <div className="composer-wrap" ref={composerWrapRef} hidden={composerHost === null}>
      <Composer
        minimal
        typing={typing}
        surface={session.surface}
        surfacesMenuOpen={session.surfacesMenuOpen}
        connectMenuOpen={session.connectMenuOpen === true}
        addMenuOpen={session.addMenuOpen === true}
        surfacesTriggerRef={surfacesTriggerRef}
        connectTriggerRef={connectTriggerRef}
        addTriggerRef={addTriggerRef}
        autoFocus={composerHost ? true : authMessage === undefined}
        placeholder="Ask Smithers to work on something…"
      />
      {/* The next-step pills sit UNDER the chat box; DOM order is focus order: composer, then pills. Feature-flagged (features.suggestionPills), on for the cloud host. */}
      {composerHost === undefined && controller.features.suggestionPills ? <SuggestionGroup className="smithers-suggestions">
        {suggestions.map((suggestion) => (
          <Suggestion
            className="smithers-suggestion"
            data-gold={suggestion.emphasis === "primary"}
            data-flow={suggestion.flow}
            key={suggestion.id}
            suggestion={suggestion.label}
            title={suggestion.why}
            disabled={typing}
            onClick={() => controller.runCommand(suggestion.flow, suggestion.args)}
          >
            <Sparkles size={12} />
            {suggestion.label}
          </Suggestion>
        ))}
      </SuggestionGroup> : null}
    </div>
  )

  return (
    // data-flows is the live registry manifest (visible AND hidden names):
    // under commands-are-the-app the registry is not secret — the agent tool
    // lists it to the model — and the launch checklist verifies every
    // data-flow binding against exactly this surface.
    <div
      className="app-shell"
      data-frame-maximized={session.maximizedCardId !== null}
      data-flows={controller.commands.all().map((command) => command.name).join(" ")}
      onPointerDownCapture={onShellPointerDownCapture}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return
        if (event.key === "Escape" && session.maximizedCardId !== null) {
          controller.runCommand("card.minimize")
          return
        }
        // The `+` menu is one more session menu the shell closes on Escape.
        if (event.key === "Escape" && session.tabMenuOpen === true) {
          event.preventDefault()
          controller.runCommand("tab.menu")
          return
        }
        // §21.4 — an open menu closes before anything else the shell owns.
        if (event.key === "Escape" && session.surfacesMenuOpen) {
          event.preventDefault()
          controller.runCommand("chat.surfaces")
          requestAnimationFrame(() => {
            surfacesTriggerRef.current?.focus()
          })
          return
        }
        // §21.4: both menus are session state now, so the shell closes whichever is open.
        if (event.key === "Escape" && session.connectMenuOpen === true) {
          event.preventDefault()
          controller.closeConnectMenu()
          requestAnimationFrame(() => {
            connectTriggerRef.current?.focus()
          })
          return
        }
        if (event.key === "Escape" && session.addMenuOpen === true) {
          event.preventDefault()
          controller.closeAddMenu()
          requestAnimationFrame(() => {
            addTriggerRef.current?.focus()
          })
          return
        }
        // The dev-tools keyboard path (§2b): unregistered for non-admins, so a no-op there.
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "d") {
          event.preventDefault()
          controller.runCommand("admin.devtools")
          return
        }
        /*
         * The palette (Search and Command Palette Spec 2026-09-07 §3): Cmd+K
         * focuses the composer and opens the overlay on the draft as it
         * stands; Cmd+Shift+K reopens the last query. The composer handles a
         * Cmd+K of its own while the overlay is open (the actions panel) and
         * prevents the default first, so this is the closed-overlay path.
         */
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
          event.preventDefault()
          const last = session.paletteLastQuery ?? ""
          if (event.shiftKey && last !== "") controller.runCommand("palette.open", last)
          else controller.runCommand("palette.open")
          requestAnimationFrame(() => {
            composerWrapRef.current?.querySelector("textarea")?.focus()
          })
        }
      }}
    >
      <SmithersUiStyles />

      {/* The chrome bar: the tab strip upper-left, the repo chip and chrome actions right. */}
      <ChromeBar />

      <div className="app-main">

      {
        /*
         * The main tab's body IS the chat. Every tab body stays mounted; an
         * inactive one is hidden, never unmounted (docs/LOCAL-APP.md "Tabs").
         */
      }
      <div
        className="tab-body"
        data-kind="main"
        data-conversation={conversationTabId}
        data-testid="tab-body-main"
        hidden={activeTabId !== MAIN_TAB_ID && conversationTabId === undefined}
      >
      <div className="chat-frame" data-pane={session.surface === "chat" ? undefined : session.surface}>
        <div className="chat-column">
          {
            /*
             * The one available step, first in the focus ring.
             *
             * While auth is the conversation state this is the only thing a
             * visitor can do, but the message's own CTA cannot be the document's
             * first tab stop: it renders inside the transcript, and @smthrs/ui
             * wraps the transcript in a scroller viewport that carries
             * tabindex="0". That tabindex is the dependency's keyboard access to
             * a scrollable region and is not ours to delete, and moving the CTA
             * out of the message would take the action away from the state that
             * explains it. So the step renders a second time here, ahead of the
             * scroller, as the control one Tab reaches from the document. It is
             * out of flow and clipped until focused, so the page looks the same
             * and the shortcut appears exactly when it is the thing you are on.
             */
          }
          {authAction !== undefined ?
            (
              <Button
                className="auth-shortcut"
                data-flow={authAction.flow}
                onClick={() => controller.runCommand(authAction.flow)}
              >
                {authAction.label}
              </Button>
            ) :
            null}

          <ChatTranscript
            className="smithers-transcript"
            data-testid="transcript"
            pending={typing}
            pendingLabel="Smithers is responding"
            aria-label="Conversation"
            empty={
              <EmptyState
                className="transcript-empty"
                icon={<Sparkles size={20} />}
                title="Nothing here yet"
                description="Ask Smithers anything to get started."
              />
            }
          >
            {entries.map((entry) =>
              entry.kind === "card" ?
                (
                  <CardView
                    key={entry.card.id}
                    card={entry.card}
                    maximized={session.maximizedCardId === entry.card.id}
                    debugVerbose={session.verbose === true}
                    signedOut={identity?.state === "signed-out"}
                    worldDocuments={worldDocuments}
                    workflowCatalogs={workflowCatalogs}
                    {...actions}
                  />
                ) :
                entry.message.act !== undefined ?
                (
                  <Marker
                    key={entry.message.id}
                    variant="note"
                    className="bubble-system-note tool-act-line"
                  >
                    {entry.message.text}
                  </Marker>
                ) :
                (
                  <ChatMessage
                    className="smithers-chat-message"
                    key={entry.message.id}
                    role={entry.message.role === "user" ? "user" : "assistant"}
                    meta={entry.message.status !== "complete" ?
                      (
                        <Marker variant="note" live className="bubble-system-note">
                          {systemNoteLabel(entry.message)}
                        </Marker>
                      ) :
                      undefined}
                  >
                    {entry.message.reasoning !== undefined && entry.message.reasoning !== "" ?
                      (
                        <Reasoning
                          className="message-reasoning"
                          streaming={entry.message.id === streamingMessageId}
                          title="Reasoning"
                        >
                          <div className="message-reasoning-text">{entry.message.reasoning}</div>
                        </Reasoning>
                      ) :
                      null}
                    {entry.kind === "init" ?
                      (
                        <div className="message-init" data-testid="init-message">
                          <CheckCircle2 size={16} className="message-init-check" aria-label="Initialized" />
                          <div className="message-init-body">
                            <Markdown
                              className="message-markdown message-init-greeting"
                              content={`**${INIT_GREETING}**`}
                            />
                            <Markdown
                              className="message-markdown message-init-title"
                              content={`**${INIT_TITLE}**`}
                            />
                            <details className="message-init-details">
                              <summary>Details</summary>
                              <Markdown
                                className="message-markdown message-init-details-content"
                                content={entry.message.details}
                              />
                            </details>
                            {entry.message.prompt === undefined ?
                              null :
                              (
                                <Markdown
                                  className="message-markdown message-init-prompt"
                                  content={entry.message.prompt}
                                />
                              )}
                          </div>
                        </div>
                      ) :
                      entry.message.text !== "" ?
                      (
                        // scrubToolEcho: a weak model's tool call written into prose
                        // is wire debris, never content — stripped at render only;
                        // the store and dev-tools keep the raw truth.
                        <Markdown
                          className="message-markdown"
                          content={scrubToolEcho(entry.message.text)}
                        />
                      ) :
                      null}
                    {/* The synthetic auth message has no clock time to tell. */}
                    {entry.message.createdAt > 0 ?
                      (
                        <time
                          className="message-time"
                          dateTime={new Date(entry.message.createdAt).toISOString()}
                        >
                          {timeLabel(entry.message.createdAt)}
                        </time>
                      ) :
                      null}
                    {entry.message.action?.flow === STORAGE_RECOVERY_EXPORT ?
                      <StorageRecoveryButton state={controller.storageRecoveryState} onDownload={() => { controller.runCommand(STORAGE_RECOVERY_EXPORT) }} /> :
                      entry.message.action !== undefined ?
                      (
                        <Button
                          className="message-cta"
                          data-flow={entry.message.action.flow}
                          autoFocus={entry.message.id === "auth-state"}
                          onClick={() =>
                            // A confirm flow's button carries the agent's argument text.
                            controller.runCommand(entry.message.action?.flow ?? "", entry.message.action?.args)}
                        >
                          {entry.message.action.label}
                        </Button>
                      ) :
                      null}
                    <span className="message-actions">
                      <CopyMessageButton
                        text={entry.message.text}
                        onCopy={(text) => controller.runCommand("chat.copy-message", text)}
                      />
                      {entry.message.status === "failed" ?
                        (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="message-action"
                            aria-label="Retry turn"
                            title="Retry turn"
                            onClick={() => controller.runCommand("chat.retry")}
                          >
                            <RotateCcw size={12} />
                          </Button>
                        ) :
                        null}
                      {/* The Explainer (AgentRoles.ts) on a failed turn: an embedded answer, only where the explain flow registers. */}
                      {entry.message.status === "failed" && controller.commands.find("agent.explain") !== undefined ?
                        (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="message-action"
                            data-flow="agent.explain"
                            aria-label="Explain this"
                            title="Explain this"
                            onClick={() =>
                              controller.runCommand(
                                "agent.explain",
                                `This turn failed: ${systemNoteLabel(entry.message)}. ${entry.message.text}`.trim()
                              )}
                          >
                            <HelpCircle size={12} />
                          </Button>
                        ) :
                        null}
                    </span>
                  </ChatMessage>
                )
            )}
          </ChatTranscript>

          {composerHost ? createPortal(composerWrap, composerHost) : composerWrap}

        </div>

        {session.surface === "world" ?
          (
            <section className="world-surface embedded-pane" aria-label={`Smithers ${WIKI_DISPLAY_NAME} state`}>
              <SurfaceHeader
                icon={<BookOpen size={17} aria-hidden="true" />}
                title={WIKI_DISPLAY_NAME}
                subtitle="What Smithers currently understands"
                closeCommand="chat"
                onClose={() => controller.runCommand("chat")}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  data-flow="wiki.new-note"
                  onClick={() => controller.runCommand("wiki.new-note")}
                >
                  <Plus size={14} aria-hidden="true" />
                  New note
                </Button>
                {/* The button door of wiki.graph: the same registry entry the slash and the agent run; it toggles. */}
                <Button
                  variant="ghost"
                  size="sm"
                  data-flow="wiki.graph"
                  data-testid="wiki-graph"
                  aria-pressed={wikiGraphMode}
                  onClick={() =>
                    // A button always carries its args: a focused graph toggles back from its own focus.
                    session.wikiGraphPath ?
                      controller.runCommand("wiki.graph", session.wikiGraphPath) :
                      controller.runCommand("wiki.graph")}
                >
                  <Waypoints size={14} aria-hidden="true" />
                  Graph
                </Button>
                {/* The button door of factory.show: the same registry entry the slash and the agent run. */}
                {canShowFactory ?
                  (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-flow="factory.show"
                      data-testid="wiki-factory"
                      onClick={() => controller.runCommand("factory.show")}
                    >
                      <Factory size={14} aria-hidden="true" />
                      Factory
                    </Button>
                  ) :
                  null}
              </SurfaceHeader>

              <div className="world-workspace" data-pane={wikiGraphMode ? "graph" : "document"}>
                <aside
                  className="world-sidebar"
                  aria-label={`${WIKI_DISPLAY_NAME} notes`}
                >
                  <FileTree
                    nodeProps={() => ({ "data-flow": "wiki.select" })}
                    nodes={worldDocuments.map((document) => ({
                      path: document.path,
                      label: document.title
                    }))}
                    selected={selectedWorldDocument?.path}
                    onSelect={(path) => {
                      const document = worldDocuments.find((candidate) => candidate.path === path)
                      if (document) controller.runCommand("wiki.select", document.id)
                    }}
                  />
                </aside>

                {wikiGraph !== undefined ?
                  (
                    <main
                      className="world-graph"
                      aria-label={`${WIKI_DISPLAY_NAME} graph`}
                      data-testid="wiki-graph-pane"
                      ref={stampFlows([["button", "wiki.open"]])}
                    >
                      <div className="world-document-meta">
                        <span data-testid="wiki-pane-graph-scope">
                          {session.wikiGraphPath === null || session.wikiGraphPath === undefined ?
                            WIKI_GRAPH_ALL_SCOPE :
                            `Around ${session.wikiGraphPath}`}
                        </span>
                      </div>
                      <Suspense fallback={<p className="smithers-card-note">Loading graph…</p>}>
                        <KnowledgeGraphSurface
                          notes={wikiGraph.notes}
                          links={wikiGraph.links}
                          height="100%"
                          onOpenNote={(path) => controller.runCommand("wiki.open", path)}
                        />
                      </Suspense>
                    </main>
                  ) :
                <main className="world-document">
                  {selectedWorldDocument ?
                    (
                      <>
                        <div className="world-document-meta">
                          <span>{selectedWorldDocument.path}</span>
                          <div>
                            <Badge variant="outline">
                              {Math.round(selectedWorldDocument.confidence * 100)}% confidence
                            </Badge>
                            <Badge variant="muted">
                              {selectedWorldDocument.sources.length} source
                              {selectedWorldDocument.sources.length === 1 ? "" : "s"}
                            </Badge>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="world-delete-btn"
                              data-flow="wiki.delete"
                              aria-label={`Delete ${selectedWorldDocument.title}`}
                              title="Delete note"
                              onClick={() => controller.runCommand("wiki.delete", selectedWorldDocument.id)}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </div>
                        {/* Layout only: the editor releases Tab itself (§21.2, `escapeTabOrder`). */}
                        <div className="world-editor-region">
                          <Suspense fallback={<p className="smithers-card-note">Loading editor…</p>}>
                            <MarkdownEditorSurface
                              value={selectedWorldDocument.body}
                              resetKey={selectedWorldDocument.id}
                              label={`Edit ${selectedWorldDocument.title}`}
                              onChange={(body) => controller.changeWorldDocument(selectedWorldDocument.id, body)}
                              onEditor={controller.attachWikiEditor}
                            />
                          </Suspense>
                        </div>
                      </>
                    ) :
                    (
                      <EmptyState
                        icon={<BookOpen size={20} />}
                        title={`No ${WIKI_DISPLAY_NAME} notes yet`}
                        description="Smithers will keep what it learns here."
                        action={<Button onClick={() => controller.runCommand("wiki.new-note")}>Create a note</Button>}
                      />
                    )}
                </main>}
                {wikiGraph === undefined && selectedWorldDocument !== undefined && selectedWorldLinks !== undefined ?
                  (
                    <aside
                      className="world-rail"
                      aria-label={`${selectedWorldDocument.title} links and outline`}
                      data-testid="wiki-rail"
                      ref={stampFlows([['[data-slot="vault-outline"] button', "wiki.heading"], ["button", "wiki.open"]])}
                    >
                      <BacklinksPanel
                        backlinks={[...selectedWorldLinks.backlinks]}
                        linksOut={[...selectedWorldLinks.linksOut]}
                        onOpenNote={(path) => controller.runCommand("wiki.open", path)}
                      />
                      {/* Each heading is the button door of wiki.heading: the editor scrolls to its source line. */}
                      <OutlineView
                        markdown={selectedWorldDocument.body}
                        onHeadingClick={(line) => controller.runCommand("wiki.heading", String(line))}
                      />
                    </aside>
                  ) :
                  null}
              </div>
              <ConfirmDialog
                open={pendingWorldDelete !== undefined}
                title={`Delete ${pendingWorldDelete?.title ?? "note"}?`}
                body={`This note leaves the ${WIKI_DISPLAY_NAME}. You can write it again, but Smithers will treat it as new.`}
                confirmLabel="Delete"
                destructive
                onConfirm={() => controller.runCommand("wiki.delete.confirm")}
                onCancel={() => controller.runCommand("wiki.delete.cancel")}
              />
            </section>
          ) :
          session.surface === "connectors" ?
          <ConnectorsSurface /> :
          session.surface === "flows" ?
          (
            <section className="flows-surface embedded-pane" aria-label="Flows on your workspace">
              <SurfaceHeader
                icon={<Workflow size={17} aria-hidden="true" />}
                title="Flows"
                subtitle={flowsCard?.payload.repo ?? ""}
                closeCommand="chat"
                onClose={() => controller.runCommand("chat")}
              >
                {/* The button door of triggers.list: the same registry entry the slash and the agent run. */}
                {canListTriggers ?
                  (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-flow="triggers.list"
                      data-testid="flows-triggers"
                      onClick={() => controller.runCommand("triggers.list")}
                    >
                      <Timer size={14} aria-hidden="true" />
                      Triggers
                    </Button>
                  ) :
                  null}
              </SurfaceHeader>
              <div className="flows-content">
                {flowsCard === undefined ?
                  null :
                  (
                    <WorkflowListCardBody
                      card={flowsCard}
                      onRunCommand={actions.onRunCommand}
                    />
                  )}
                {triggersCard === undefined ?
                  null :
                  (
                    <TriggerListCardBody
                      card={triggersCard}
                      onRunCommand={(name, commandArgs) => controller.runCommand(name, commandArgs)}
                    />
                  )}
              </div>
            </section>
          ) :
          session.surface === "plugins" ?
          <PluginsSurface /> :
          null}

        {/* Admin-only: the panel is absent — not hidden — for everyone else. */}
        {isAdmin && session.devtoolsOpen ? <DevtoolsPanel /> : null}
      </div>
      </div>

      {/* Terminal, harness, and card tabs; hidden while inactive, never unmounted. */}
      <TabBodies />
      </div>

      {
        /*
         * §28.4: reset destroys the transcript with no undo, so it names what
         * goes before it goes. The count is the transcript's own, so the
         * confirm cannot claim more or less than is actually there.
         */
      }
      <ConfirmDialog
        open={session.resetConfirmOpen === true}
        title="Start a fresh conversation?"
        body={`${
          messages.length === 1 ? "1 message" : `${messages.length} messages`
        } and everything on screen will be discarded. Nothing is kept.`}
        confirmLabel="Discard and start fresh"
        destructive
        onConfirm={() => {
          controller.runCommand("admin.reset")
        }}
        onCancel={() => controller.runCommand("admin.reset.cancel")}
      />

      {/*
       * The one shared toast stack: every background flow past 300ms reports
       * here. Inside the guide shell the guide's own stack is the toast
       * surface — this one is confined to the app layer's stacking context
       * (invisible during the lessons, covered by the floating chrome at the
       * workspace) and would duplicate every notification.
       */}
      {composerHost === undefined ?
        (
          <ToastStack
            toasts={toasts}
            onDismiss={(id) => controller.runCommand("toast.dismiss", id)}
          />
        ) :
        null}
    </div>
  )
}

/*
 * The bare app is the default export: the DOM suites mount it directly, and
 * inside it the composer keeps its docked home. The product mount is the
 * guide-wrapped shell (AppIsland takes GuidedApp), where the UI stands
 * full-screen and Command-K summons the composer.
 */
export default App
export function GuidedApp() { return <GuideShell><App /></GuideShell> }
