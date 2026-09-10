import { Button, ChatComposer } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import {
  BookOpen,
  Bot,
  ChevronDown,
  Cloud,
  FolderGit2,
  GitPullRequest,
  HardDrive,
  Laptop,
  Library,
  MessageSquare,
  Paperclip,
  Plug,
  Plus,
  Server,
  Workflow
} from "lucide-react"
import { useRef, useState } from "react"
import type { KeyboardEvent, ReactNode, RefObject } from "react"
import { roleMenuEntries } from "./AgentRoleMenu"
import { useController } from "./ControllerContext"
import { actionForKey } from "./flows/SearchQuery"
import { SELECT_REPO_LABEL } from "./Onboarding"
import { paletteKey, PaletteOverlay, paletteRows } from "./SearchPalette"
import type { PaletteDecision, PaletteRow } from "./SearchPalette"
import { activeRepoOf, parseRepoSelection, repoKeyOf, WIKI_DISPLAY_NAME } from "./state/AppState"
import { workingCopyLabel } from "./state/WorkspaceViews"

/** Stable Playwright handle; spread past ChatComposer's excess-property check. */
const COMPOSER_INPUT_TEST_ID: Record<string, string> = { "data-testid": "composer-input" }

/* Send and Stop are `chat.send` and `chat.stop`'s doors, named through
 * ChatComposer's own pass-through props. Typed as records for the same reason
 * COMPOSER_INPUT_TEST_ID is: a bag of only `data-*` keys has no property in
 * common with `ComponentProps<"button">`. */

/** The Send button's flow marker, and Playwright's handle on it. */
const COMPOSER_SEND_PROPS: Record<string, string> = {
  "data-flow": "chat.send",
  "data-testid": "composer-send"
}

/** The Stop button is `chat.stop`'s door. */
const COMPOSER_STOP_PROPS: Record<string, string> = { "data-flow": "chat.stop" }

type Surface = "chat" | "world" | "connectors" | "flows" | "plugins"

/* The surface pill's label: what the composer is currently pointed at. */
const SURFACE_LABELS: Readonly<Record<Surface, string>> = {
  chat: "Chat",
  world: WIKI_DISPLAY_NAME,
  connectors: "Connect",
  flows: "Flows",
  plugins: "Plugins"
}

/** Shorten the local host's conventional home-directory roots for display. */
const abbreviateHomePath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/")
  const home = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/i
    .exec(normalized)?.[0]
  return home === undefined ? path : `~${normalized.slice(home.length)}`
}

/*
 * The composer's surface menu (§2c′): the surface buttons collapse into ONE
 * compact dropdown so the toolbar never accumulates horizontally. Every
 * entry is a direct command binding (never a prompt string), state-aware,
 * keyboard-complete (ArrowDown opens, arrows move, Enter invokes, Escape
 * closes). `/` remains the full command surface; this is the pointer subset.
 *
 * C-1 (wave 13): the trigger itself is the /surfaces command — the open state
 * lives in the session collection and the button dispatches through the
 * registry, so the affordance and the command are the same act.
 *
 * It sits beside the `+` as the main selection pill, and its label names the
 * surface the composer is on right now.
 */
function ComposerMenu({
  surface,
  open,
  triggerRef
}: {
  readonly surface: Surface
  readonly open: boolean
  /*
   * The trigger is owned here but refocused from two places — this menu's own
   * exits, and the shell's Escape handler — so the shell holds the ref and
   * hands it down. Reaching back through `document` for a node this package
   * renders is a query against our own DOM; a ref IS the handle.
   */
  readonly triggerRef: RefObject<HTMLButtonElement | null>
}) {
  const controller = useController()
  const [highlighted, setHighlighted] = useState(0)
  /* The entries are a fixed list, so index-assigned refs stay aligned with the DOM. */
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const entries = [
    {
      flow: "chat",
      label: SURFACE_LABELS.chat,
      icon: <MessageSquare size={14} aria-hidden="true" />,
      active: surface === "chat"
    },
    {
      flow: "connect",
      label: SURFACE_LABELS.connectors,
      icon: <Plug size={14} aria-hidden="true" />,
      active: surface === "connectors"
    },
    {
      flow: "wiki",
      label: SURFACE_LABELS.world,
      icon: <BookOpen size={14} aria-hidden="true" />,
      active: surface === "world"
    },
    /* Ask 5 (will, 2026-09-02): the workspace's flows are a surface like the other three. */
    {
      flow: "flows",
      label: SURFACE_LABELS.flows,
      icon: <Workflow size={14} aria-hidden="true" />,
      active: surface === "flows"
    },
    /* The Library: where the abilities on this workspace come from. */
    {
      flow: "plugins",
      label: SURFACE_LABELS.plugins,
      icon: <Library size={14} aria-hidden="true" />,
      active: surface === "plugins"
    }
  ] as const

  const openMenu = (): void => {
    setHighlighted(0)
    controller.runCommand("chat.surfaces")
    requestAnimationFrame(() => {
      itemRefs.current[0]?.focus()
    })
  }

  const closeMenu = (): void => {
    controller.runCommand("chat.surfaces")
    requestAnimationFrame(() => {
      triggerRef.current?.focus()
    })
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      if (open) {
        closeMenu()
      } else {
        openMenu()
      }
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      closeMenu()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const next = event.key === "ArrowDown"
        ? (highlighted + 1) % entries.length
        : (highlighted + entries.length - 1) % entries.length
      setHighlighted(next)
      itemRefs.current[next]?.focus()
    }
  }

  return (
    <div className="composer-menu composer-surfaces">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        className="composer-action composer-menu-trigger composer-pill"
        data-flow="chat.surfaces"
        data-testid="composer-surface-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Surface: ${SURFACE_LABELS[surface]}`}
        title="Surfaces"
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="composer-pill-label">{SURFACE_LABELS[surface]}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </Button>
      {open ?
        (
          <div className="composer-menu-list" role="menu" aria-label="Surfaces" onKeyDown={onMenuKeyDown}>
            {entries.map((entry, index) => (
              <button
                type="button"
                key={entry.flow}
                ref={(node) => {
                  itemRefs.current[index] = node
                }}
                role="menuitem"
                className="composer-menu-item"
                data-flow={entry.flow}
                data-active={entry.active}
                aria-pressed={entry.active}
                tabIndex={index === highlighted ? 0 : -1}
                onFocus={() => setHighlighted(index)}
                onClick={() => {
                  if (open) controller.runCommand("chat.surfaces")
                  controller.runCommand(entry.flow)
                }}
              >
                {entry.icon}
                {entry.label}
              </button>
            ))}
          </div>
        ) :
        null}
    </div>
  )
}

/* One store-owned menu's entry, built as data so index refs stay aligned with the DOM. */
interface MenuEntry {
  readonly key: string
  readonly flow: string
  readonly active?: boolean
  readonly disabled?: boolean
  readonly content: ReactNode
  readonly testId?: string
  /** What the entry does when chosen; defaults to running `flow` (with `args` when given). */
  readonly args?: string
  readonly onChoose?: () => void
}

/*
 * The composer's `+` (bottom-left): add files first, then a connector, a flow,
 * an agent. The open state is the session's (/composer.add), reached through
 * the dispatcher like the connect and surfaces menus.
 */
function ComposerAdd({
  open,
  triggerRef
}: {
  readonly open: boolean
  readonly triggerRef: RefObject<HTMLButtonElement | null>
}) {
  const controller = useController()
  const { collections } = controller.store
  const { data: harnessRows } = useLiveQuery(collections.harnesses)
  const { data: agentRows } = useLiveQuery(collections.agents)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const canAddFiles = controller.commands.find("files.add") !== undefined
  const canNewAgent = controller.commands.find("agent.new") !== undefined
  const canAddConnector = controller.nativeRepositoriesAvailable &&
    controller.commands.find("connector.add") !== undefined
  const canCreateFlow = controller.commands.find("flow.create") !== undefined
  const canOpenHarness = controller.commands.find("tab.harness") !== undefined
  const availableHarness = harnessRows.find((harness) => harness.status !== "unavailable")
  const firstHarness = harnessRows[0]

  const entries: ReadonlyArray<MenuEntry> = [
    ...(canAddFiles
      ? [{
        key: "files.add",
        flow: "files.add",
        testId: "composer-add-files",
        content: (
          <>
            <Paperclip size={14} aria-hidden="true" />
            Add files…
          </>
        )
      }]
      : []),
    ...(canAddConnector
      ? [{
        key: "connector.add",
        flow: "connector.add",
        args: "read",
        testId: "composer-add-connector",
        content: (
          <>
            <HardDrive size={14} aria-hidden="true" />
            New connector…
          </>
        )
      }]
      : []),
    ...(canCreateFlow
      ? [{
        key: "flow.create",
        flow: "flow.create",
        testId: "composer-add-flow",
        content: (
          <>
            <Workflow size={14} aria-hidden="true" />
            New flow…
          </>
        ),
        /* flow.create needs a description: the entry starts the invocation in the composer. */
        onChoose: () => controller.changeDraft("/flow.create ")
      }]
      : []),
    /* The agents (AgentRoles.ts + the app-agents mirror), one model each; a raw harness follows for everything else. */
    ...(canOpenHarness
      ? roleMenuEntries(harnessRows, agentRows).map((entry): MenuEntry => ({
        key: `agent.role:${entry.role.id}`,
        flow: "agent.role",
        args: entry.role.id,
        testId: `composer-add-role-${entry.role.id}`,
        disabled: !entry.available,
        content: (
          <>
            <Bot size={14} aria-hidden="true" />
            {entry.title}
            <span className="composer-connect-branch">{entry.available ? entry.account : entry.reason}</span>
          </>
        )
      }))
      : []),
    ...(canOpenHarness
      ? [{
        key: "tab.harness",
        flow: "tab.harness",
        testId: "composer-add-agent",
        disabled: availableHarness === undefined,
        ...(availableHarness === undefined ? {} : { args: availableHarness.id }),
        /* The raw harness session, named the way the sidebar's `+` names it: the harness, then its account or status. */
        content: (
          <>
            <Bot size={14} aria-hidden="true" />
            {availableHarness?.displayName ?? firstHarness?.displayName ?? "Harness"}
            {availableHarness === undefined
              ? (
                <span className="composer-connect-branch">
                  {firstHarness === undefined ? "no harness detected" : firstHarness.status}
                </span>
              )
              : <span className="composer-connect-branch">{availableHarness.account?.email ?? availableHarness.account?.label ?? ""}</span>}
          </>
        )
      }]
      : []),
    /* Agents as data (custom-agents.md): the last row opens the New agent form card. */
    ...(canNewAgent
      ? [{
        key: "agent.new",
        flow: "agent.new",
        testId: "composer-add-new-agent",
        content: (
          <>
            <Bot size={14} aria-hidden="true" />
            New agent…
          </>
        )
      }]
      : [])
  ]

  if (entries.length === 0) return null

  const enabledEntries = entries.flatMap((entry, index) => (entry.disabled === true ? [] : [index]))

  /* Opening lands focus on the first enabled entry; the open state itself is /composer.add's. */
  const focusFirstEntry = (): void => {
    if (open) return
    requestAnimationFrame(() => {
      itemRefs.current[enabledEntries[0] ?? -1]?.focus()
    })
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowDown" && !open) {
      event.preventDefault()
      controller.runCommand("composer.add")
      focusFirstEntry()
    }
  }


  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      controller.closeAddMenu()
      triggerRef.current?.focus()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (enabledEntries.length === 0) return
      const current = enabledEntries.findIndex((index) => itemRefs.current[index] === document.activeElement)
      const next = event.key === "ArrowDown"
        ? (current + 1) % enabledEntries.length
        : (current - 1 + enabledEntries.length) % enabledEntries.length
      itemRefs.current[enabledEntries[next] ?? -1]?.focus()
    }
  }

  return (
    <div className="composer-menu composer-add">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        className="composer-action composer-add-trigger"
        data-flow="composer.add"
        data-testid="composer-add"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add"
        title="Add files, a connector, a flow, or an agent"
        onClick={() => {
          controller.runCommand("composer.add")
          focusFirstEntry()
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <Plus size={16} aria-hidden="true" />
      </Button>
      {open ?
        (
          <div
            className="composer-menu-list composer-add-list"
            role="menu"
            aria-label="Add"
            data-testid="composer-add-menu"
            onKeyDown={onMenuKeyDown}
          >
            {entries.map((entry, index) => (
              <button
                type="button"
                key={entry.key}
                ref={(node) => {
                  itemRefs.current[index] = node
                }}
                role="menuitem"
                className="composer-menu-item"
                data-flow={entry.flow}
                data-testid={entry.testId}
                disabled={entry.disabled}
                onClick={() => {
                  controller.closeAddMenu()
                  if (entry.onChoose !== undefined) return entry.onChoose()
                  return entry.args === undefined ? controller.runCommand(entry.flow) : controller.runCommandArgs(entry.flow, entry.args)
                }}
              >
                {entry.content}
              </button>
            ))}
          </div>
        ) :
        null}
    </div>
  )
}

/*
 * The repository selector, at the top of the composer: the selected
 * repository's name as the trigger ("Select a repo" until there is one), the
 * repository origins as its menu. Every entry is a command binding: the
 * native folder dialog through repo.open, capability-scoped local
 * repositories through connector.add, GitHub through auth.sign-in,
 * cloud import through repos.import, and full management
 * through /connect.
 */
function ComposerConnect({
  open,
  triggerRef,
  repositoriesOnly = false
}: {
  /* C-1 mirror: the open state is the session's, not this component's. */
  readonly repositoriesOnly?: boolean
  readonly open: boolean
  /* The shell closes this session menu too, so it owns the focus handle. */
  readonly triggerRef: RefObject<HTMLButtonElement | null>
}) {
  const controller = useController()
  const { collections } = controller.store
  const { data: connectorRows } = useLiveQuery(collections.connectors)
  const { data: repoRows } = useLiveQuery(collections.repos)
  const { data: operationRows } = useLiveQuery(collections.connectorOperations)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)
  const { data: repositoryRows } = useLiveQuery(collections.repositories)
  const { data: copyRows } = useLiveQuery(collections.workingCopies)
  const { data: cloudSessionRows } = useLiveQuery(collections.cloudSessions)
  /* The active repository is session state (activeRepoKey): one rule with the sidebar and the tabs. */
  const { data: activeRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      activeRepoKey: session.activeRepoKey
    }))
  )
  /*
   * The entries are built as DATA below so index-assigned refs stay aligned
   * with the DOM through every conditional entry. Arrow keys, Escape, and
   * open-and-focus-the-first-entry read these refs — never `document`, whose
   * only job here would be to find nodes this package itself rendered.
   */
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const connectors = [...connectorRows].sort((left, right) => left.name.localeCompare(right.name))
  const repos = [...repoRows].sort((left, right) => left.name.localeCompare(right.name))
  const operation = operationRows.find((candidate) => candidate.id === "connector-operation") ??
    collections.connectorOperations.get("connector-operation")
  const selecting = operation?.phase === "selecting-local-repository"
  const identity = identityRows[0]
  const signedIn = identity?.state === "signed-in"
  const activeRepo = activeRepoOf(activeRows[0] ?? { activeRepoKey: null }, repos)
  /*
   * The trigger names the selection in the piper grammar (lane piper step
   * 3/4): `org/repo` at its head, `org/repo · copy` for a working copy. The
   * local-only checkouts read through the open-repo rows.
   */
  const activeKey = activeRows[0]?.activeRepoKey ?? null
  const selection = activeKey === null ? null : parseRepoSelection(activeKey)
  const selectedCopy = selection !== null && "repoId" in selection && selection.copyId !== undefined
    ? copyRows.find((row) => row.id === selection.copyId)
    : undefined
  const selected = selection !== null && "repoId" in selection
    ? selectedCopy !== undefined ? `${selection.repoId} · ${selectedCopy.label}` : selection.repoId
    : activeRepo?.name ?? connectors[0]?.name
  const connected = selected !== undefined
  const canOpenRepo = controller.commands.find("repo.open") !== undefined
  const canAddConnector = controller.nativeRepositoriesAvailable &&
    controller.commands.find("connector.add") !== undefined
  const cloudSignedIn = cloudSessionRows[0]?.state === "signed-in"
  // One label rule for every copy row (WorkspaceViews.ts): the sidebar and this menu say the same line.
  const copyLabel = workingCopyLabel

  const cloudEntries: ReadonlyArray<MenuEntry> = [...repositoryRows]
    .sort((left, right) => left.org.localeCompare(right.org) || left.name.localeCompare(right.name))
    .flatMap((repository) => [
      {
        key: `cloud:${repository.id}`,
        flow: "repo.select",
        args: repository.id,
        active: activeKey === repository.id,
        content: (
          <>
            <Cloud size={14} aria-hidden="true" />
            <span className="composer-connect-name">{repositoriesOnly ? repository.id : repository.name}</span>
            {!repositoriesOnly && <span className="composer-connect-branch">{repository.org}/</span>}
          </>
        )
      },
      ...copyRows
        .filter((copy) => copy.repoId === repository.id)
        .map((copy) => ({
          key: `copy:${copy.id}`,
          flow: "repo.select",
          args: `${repository.id}#${copy.id}`,
          active: activeKey === `${repository.id}#${copy.id}`,
          content: (
            <>
              {copy.kind === "local" ? <Laptop size={14} aria-hidden="true" /> : <Cloud size={14} aria-hidden="true" />}
              <span className="composer-connect-name">{copyLabel(copy)}</span>
              <span className="composer-connect-branch">{repository.id}</span>
            </>
          )
        }))
    ])

  const connectionEntries: ReadonlyArray<MenuEntry> = [
    ...repos.map((repo) => ({
      key: `repo:${repo.id}`,
      // Choosing an open repository makes it the active one: the sidebar row, the origin, and where tabs start.
      flow: "repo.select",
      args: repoKeyOf(repo.path),
      active: repo.id === activeRepo?.id,
      content: (
        <>
          <FolderGit2 size={14} aria-hidden="true" />
          <span className="composer-connect-name">{repo.name}</span>
          <span className="composer-connect-branch">{repo.git?.branch ?? "detached"}</span>
        </>
      )
    })),
    ...connectors.map((connector) => ({
      key: connector.id,
      flow: "connect",
      active: true,
      content: (
        <>
          <FolderGit2 size={14} aria-hidden="true" />
          <span className="composer-connect-name">{connector.name}</span>
          <span className="composer-connect-branch">{connector.branch ?? "detached"}</span>
        </>
      )
    })),
    ...cloudEntries,
    ...(!cloudSignedIn && controller.commands.find("cloud.sign-in") !== undefined
      ? [{
        key: "cloud.sign-in",
        flow: "cloud.sign-in",
        content: (
          <>
            <Cloud size={14} aria-hidden="true" />
            Sign in to Smithers Cloud…
          </>
        )
      }]
      : []),
    ...(canOpenRepo
      ? [{
        key: "repo.open",
        flow: "repo.open",
        testId: "chrome-open-repo",
        content: (
          <>
            <Laptop size={14} aria-hidden="true" />
            Open local repository…
          </>
        )
      }]
      : []),
    ...(canAddConnector
      ? [{
        key: "connector.add",
        flow: "connector.add",
        disabled: selecting,
        content: (
          <>
            <HardDrive size={14} aria-hidden="true" />
            {selecting ? "Choosing a repository…" : "Add local repository…"}
          </>
        ),
        args: "read"
      }]
      : []),
    ...(!signedIn && controller.commands.find("auth.sign-in") !== undefined
      ? [{
        key: "auth.sign-in",
        flow: "auth.sign-in",
        content: (
          <>
            <GitPullRequest size={14} aria-hidden="true" />
            Connect GitHub…
          </>
        )
      }]
      : []),
    /*
     * §1.1: signed out, sign-in is the ONE offered next step. Both of
     * these need a session — clicking either only defers into the
     * sign-in above it — so presenting them as available work makes
     * the app look like it offers four ways in when it has one.
     */
    ...(signedIn
      ? [
        ...(controller.commands.find("repos.import") === undefined ? [] : [{
          key: "repos.import",
          flow: "repos.import",
          content: (
            <>
              <Server size={14} aria-hidden="true" />
              Import to Smithers Cloud…
            </>
          )
        }]),
        {
          key: "connect",
          flow: "connect",
          content: (
            <>
              <Plug size={14} aria-hidden="true" />
              Open connectors
            </>
          )
        }
      ]
      : [])
  ]

  const entries = repositoriesOnly
    ? connectionEntries.filter((entry) => entry.flow === "repo.select" || entry.flow === "repo.open")
    : connectionEntries

  /* The entry indices a keyboard can land on; a disabled entry is skipped. */
  const enabledEntries = entries.flatMap((entry, index) => (entry.disabled === true ? [] : [index]))

  const toggleConnectMenu = (): void => {
    controller.toggleConnectMenu()
    if (!open) {
      requestAnimationFrame(() => {
        itemRefs.current[enabledEntries[0] ?? -1]?.focus()
      })
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      controller.closeConnectMenu()
      triggerRef.current?.focus()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (enabledEntries.length === 0) return
      const current = enabledEntries.findIndex(
        (index) => itemRefs.current[index] === document.activeElement
      )
      const next = event.key === "ArrowDown"
        ? (current + 1) % enabledEntries.length
        : (current - 1 + enabledEntries.length) % enabledEntries.length
      itemRefs.current[enabledEntries[next] ?? -1]?.focus()
    }
  }

  return (
    <div className="composer-menu composer-connect" onBlur={(event) => {
      if (repositoriesOnly && !event.currentTarget.contains(event.relatedTarget as Node | null)) controller.closeConnectMenu()
    }}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        className="composer-action composer-connect-trigger"
        data-flow="connect"
        data-connected={connected}
        data-testid="composer-repo-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={connected ? `Repository: ${selected}` : SELECT_REPO_LABEL}
        title={connected ? "Repositories" : SELECT_REPO_LABEL}
        onClick={toggleConnectMenu}
      >
        <span className="composer-connect-label">{selected ?? SELECT_REPO_LABEL}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </Button>
      {open ?
        (
          <div
            className="composer-menu-list composer-connect-list"
            role="menu"
            aria-label={repositoriesOnly ? "Repositories" : "Repository connections"}
            onKeyDown={onMenuKeyDown}
          >
            {entries.length === 0 && <div className="composer-menu-item" role="status">No repositories available.</div>}
            {entries.map((entry, index) => (
              <button
                type="button"
                key={entry.key}
                ref={(node) => {
                  itemRefs.current[index] = node
                }}
                role="menuitem"
                className="composer-menu-item"
                data-flow={entry.flow}
                data-testid={entry.testId}
                data-active={entry.active === true ? "true" : undefined}
                disabled={entry.disabled}
                onClick={() => {
                  controller.closeConnectMenu()
                  triggerRef.current?.focus()
                  if (entry.args === undefined) controller.runCommand(entry.flow)
                  else controller.runCommandArgs(entry.flow, entry.args)
                }}
              >
                {entry.content}
              </button>
            ))}
          </div>
        ) :
        null}
    </div>
  )
}

/*
 * Where the selected repository lives, beside the selector (lane piper step
 * 4): a local working copy reads `~/smithers · 3 ahead of main` (the jj
 * probe's count against the default bookmark, or the checkout's branch when
 * no probe ran); a repository selected at its head reads `head @ qupxosqw`.
 * A projection of the same rows the selector reads; it never stores a choice
 * of its own.
 */
function ComposerOrigin() {
  const controller = useController()
  const { collections } = controller.store
  const { data: repoRows } = useLiveQuery(collections.repos)
  const { data: connectorRows } = useLiveQuery(collections.connectors)
  const { data: repositoryRows } = useLiveQuery(collections.repositories)
  const { data: copyRows } = useLiveQuery(collections.workingCopies)
  const { data: changeRows } = useLiveQuery(collections.changes)
  const { data: activeRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      activeRepoKey: session.activeRepoKey
    }))
  )
  const activeKey = activeRows[0]?.activeRepoKey ?? null
  const selection = activeKey === null ? null : parseRepoSelection(activeKey)
  const connector = [...connectorRows].sort((left, right) => left.name.localeCompare(right.name))[0]

  if (selection !== null && "repoId" in selection) {
    if (selection.copyId !== undefined) {
      const copy = copyRows.find((row) => row.id === selection.copyId)
      if (copy !== undefined) {
        const repository = repositoryRows.find((row) => row.id === copy.repoId)
        /*
         * Lane change step 4: the chip carries the checkout's pin (its jj
         * `readAt`), `changeId#seq` only when the changes collection knows a
         * sequence — never from a commit comparison alone (plue#450). A
         * newer revision is named only when BOTH seqs are known.
         */
        const pin = copy.readAt ?? null
        const changeRow = pin?.changeId != null
          ? changeRows.find((row) => row.repoId === copy.repoId && row.changeId === pin.changeId)
          : undefined
        const seq = changeRow?.currentSeq ?? null
        const newerSeq = seq !== null && changeRow?.revisionCount != null && changeRow.revisionCount > seq
          ? changeRow.revisionCount
          : null
        return (
          <span className="composer-origin" data-origin={copy.kind} data-testid="repo-chip" title={copy.path ?? copy.workspaceId ?? copy.id}>
            {copy.kind === "local" ? <Laptop size={14} aria-hidden="true" /> : <Cloud size={14} aria-hidden="true" />}
            <span className="composer-origin-name">
              {copy.kind === "local" && copy.path !== undefined ? abbreviateHomePath(copy.path) : copy.kind === "shared" ? workingCopyLabel(copy) : copy.label}
            </span>
            {pin?.changeId != null ?
              (
                <span className="composer-origin-branch">
                  {` · ${seq !== null ? `${pin.changeId}#${seq}` : pin.changeId}`}
                  {pin.commitId != null ? ` · ${pin.commitId.length > 12 ? pin.commitId.slice(0, 8) : pin.commitId}` : ""}
                </span>
              ) :
              null}
            {newerSeq !== null && pin?.changeId != null ?
              (
                <button
                  type="button"
                  className="composer-origin-branch"
                  data-flow="change.view"
                  onClick={() => controller.runCommandArgs("change.view", pin.changeId ?? "")}
                >
                  {` · rev ${newerSeq} exists · view`}
                </button>
              ) :
              null}
            {copy.ahead !== undefined && repository?.head !== null && repository?.head !== undefined
              ? <span className="composer-origin-branch">{` · ${copy.ahead} ahead of ${repository.head.bookmark}`}</span>
              : copy.state !== undefined
              ? <span className="composer-origin-branch">{` · ${copy.state}`}</span>
              : null}
          </span>
        )
      }
    } else {
      const repository = repositoryRows.find((row) => row.id === selection.repoId)
      const headId = repository?.head?.changeId ?? null
      if (repository !== undefined) {
        return (
          <span className="composer-origin" data-origin="cloud" data-testid="repo-chip" title={repository.id}>
            <Cloud size={14} aria-hidden="true" />
            <span className="composer-origin-name">
              {headId === null ? "head" : `head @ ${headId.length > 12 ? headId.slice(0, 8) : headId}`}
            </span>
          </span>
        )
      }
    }
  }

  /* A local-only checkout selected by its key, else a connector. */
  const localCopyId = selection !== null && !("repoId" in selection) ? selection.localCopyId : null
  const localCopy = localCopyId === null ? undefined : copyRows.find((row) => row.id === localCopyId)
  const repo = localCopy?.path !== undefined
    ? repoRows.find((row) => row.path === localCopy.path)
    : activeRepoOf(activeRows[0] ?? { activeRepoKey: null }, repoRows)
  if (repo !== undefined) {
    const ahead = localCopy?.ahead ?? repo.jj?.ahead
    const bookmark = repo.jj?.bookmark ?? null
    return (
      <span className="composer-origin" data-origin="local" data-testid="repo-chip" title={repo.path}>
        <Laptop size={14} aria-hidden="true" />
        <span className="composer-origin-name">{abbreviateHomePath(repo.path)}</span>
        {ahead !== undefined && bookmark !== null
          ? <span className="composer-origin-branch">{` · ${ahead} ahead of ${bookmark}`}</span>
          : repo.git?.branch !== undefined && repo.git?.branch !== null
          ? <span className="composer-origin-branch">{` · ${repo.git.branch}`}</span>
          : null}
      </span>
    )
  }
  if (connector !== undefined) {
    return (
      <span className="composer-origin" data-origin="local" data-testid="repo-chip" title={connector.root}>
        <Laptop size={14} aria-hidden="true" />
        <span className="composer-origin-name">{abbreviateHomePath(connector.root)}</span>
        {connector.branch !== null
          ? <span className="composer-origin-branch">{` · ${connector.branch}`}</span>
          : null}
      </span>
    )
  }
  return null
}

/*
 * The composer, and everything a keystroke touches.
 *
 * §hot path: the draft is the ONE piece of session state that changes per
 * character, and it used to be read by the shell — so every keystroke
 * re-rendered App, and App renders the entire transcript. The draft
 * subscription lives HERE instead, behind the shell's draft-less projection,
 * so typing re-renders this subtree and nothing above it. The slash menu is
 * part of the same hot path (it is a function of the draft) and moved with it.
 *
 * Layout: a header row (the repository selector, then where it lives) above
 * the box; inside the box the `+` and the surface pill bottom-left, send on
 * the right; the next-step pills render under the box, in App.tsx.
 */
export function Composer({
  minimal = false,
  typing,
  surface,
  surfacesMenuOpen,
  connectMenuOpen,
  addMenuOpen,
  surfacesTriggerRef,
  connectTriggerRef,
  addTriggerRef,
  autoFocus,
  placeholder
}: {
  readonly minimal?: boolean
  readonly typing: boolean
  readonly surface: Surface
  readonly surfacesMenuOpen: boolean
  readonly connectMenuOpen: boolean
  readonly addMenuOpen: boolean
  readonly surfacesTriggerRef: RefObject<HTMLButtonElement | null>
  readonly connectTriggerRef: RefObject<HTMLButtonElement | null>
  readonly addTriggerRef: RefObject<HTMLButtonElement | null>
  readonly autoFocus: boolean
  readonly placeholder: string
}) {
  const controller = useController()
  const { collections } = controller.store
  const { data: draftRows } = useLiveQuery((q) =>
    q
      .from({ session: collections.sessions })
      .select(({ session }) => ({
        id: session.id,
        draft: session.draft,
        paletteOpen: session.paletteOpen,
        paletteActionsRef: session.paletteActionsRef
      }))
  )
  /*
   * The overlay's highlight: presentation state keyed by the draft and the
   * actions panel, so a new query or a new level starts at the first row.
   * `dismissed` is the slash tree's own Escape (the draft stays, the menu
   * hides until the draft changes), which the palette's Escape reuses.
   */
  const [slashMenu, setSlashMenu] = useState<{ draft: string; index: number; dismissed: boolean }>({
    draft: "",
    index: 0,
    dismissed: false
  })
  const draft = draftRows[0]?.draft ?? controller.store.session().draft
  const paletteOpen = draftRows[0]?.paletteOpen ?? controller.store.session().paletteOpen ?? false
  const actionsRef = draftRows[0]?.paletteActionsRef ?? controller.store.session().paletteActionsRef ?? null

  const slashQuery = draft.startsWith("/") && !draft.slice(1).includes(" ")
    ? draft.slice(1).toLowerCase()
    : undefined
  /*
   * §5.2: the listing used to be suppressed for the whole duration of a turn,
   * which made `typing -> chat.stop` — the first clause of the recommendation
   * order — unreachable in the shipped UI, and left the composer with no way
   * to invoke any flow mid-turn (the component blocks submit while busy, so
   * Enter only reaches a flow through this menu).
   */
  /*
   * ONE palette (Search and Command Palette Spec 2026-09-07 §1): the slash
   * tree (registry.slashTree) is its `/` mode, unchanged — a bare "/" lists
   * the surface switches, the recommendations, and one row per namespace;
   * opening a namespace rewrites the draft to `/ns.` so the branch is the
   * listing and Backspace / ArrowLeft walk back up. Every other prefix, and
   * Cmd+K on any draft, reads the search seam's rows (SearchPalette.tsx).
   */
  const slashRows = slashQuery === undefined ? [] : controller.slashTree(slashQuery)
  const overlayKey = `${draft}\u0000${actionsRef ?? ""}`
  const slashMenuLive = slashMenu.draft === overlayKey ? slashMenu : { draft: overlayKey, index: 0, dismissed: false }
  const overlayWanted = paletteOpen || (slashQuery !== undefined && slashRows.length > 0)
  const answer = overlayWanted ? controller.searchPalette(draft) : undefined
  const rows = answer === undefined ? undefined : paletteRows(answer, slashRows, actionsRef)
  const slashOpen = rows !== undefined && !slashMenuLive.dismissed
  const slashHighlighted = rows === undefined ? 0 : Math.max(0, Math.min(slashMenuLive.index, rows.rows.length - 1))
  /* The branch the draft is inside (`/tab.` → "tab"), when it is exactly one. */
  const slashBranch = slashQuery !== undefined && /^[a-z0-9_-]+\.$/.test(slashQuery)
    ? slashQuery.slice(0, -1)
    : undefined

  const runSlashCommand = (name: string): void => {
    setSlashMenu({ draft: "", index: 0, dismissed: false })
    controller.changeDraft("")
    controller.closePalette(draft)
    controller.runCommand(name)
  }

  /* Opening a namespace is a draft edit, never a command: the branch is the listing. */
  const openNamespace = (id: string): void => {
    setSlashMenu({ draft: `/${id}.\u0000`, index: 0, dismissed: false })
    controller.changeDraft(`/${id}.`)
  }

  /** A palette decision (SearchPalette.paletteKey) performed through the controller. */
  const perform = (decision: PaletteDecision): boolean => {
    switch (decision.kind) {
      case "none":
        return false
      case "move":
        setSlashMenu({ draft: overlayKey, index: decision.index, dismissed: false })
        return true
      case "open-namespace":
        openNamespace(decision.id)
        return true
      case "root":
        setSlashMenu({ draft: "/\u0000", index: 0, dismissed: false })
        controller.changeDraft("/")
        return true
      case "run-flow":
        runSlashCommand(decision.name)
        return true
      case "run-action": {
        // Enter opens the item; the draft was its query, so it clears as the slash menu's does, and the overlay closes remembering it.
        setSlashMenu({ draft: "", index: 0, dismissed: false })
        controller.notePaletteItemOpened(decision.item)
        controller.changeDraft("")
        controller.closePalette(draft)
        if (decision.action.args === undefined) controller.runCommand(decision.action.flow)
        else controller.runCommandArgs(decision.action.flow, decision.action.args)
        return true
      }
      case "run-mode-flow":
        setSlashMenu({ draft: "", index: 0, dismissed: false })
        controller.changeDraft("")
        controller.closePalette(draft)
        if (decision.rest === "") controller.runCommand(decision.flow)
        else controller.runCommandArgs(decision.flow, decision.rest)
        return true
      case "actions":
      case "close-actions":
        controller.runCommandArgs("palette.actions", decision.ref)
        return true
      case "set-draft":
        setSlashMenu({ draft: `${decision.draft}\u0000`, index: 0, dismissed: false })
        controller.changeDraft(decision.draft)
        return true
      case "close":
        // Esc from the top closes and leaves the draft (§3): the draft is untouched, the menu hides until it changes.
        setSlashMenu({ draft: overlayKey, index: slashHighlighted, dismissed: true })
        controller.closePalette(draft)
        return true
    }
  }

  const chooseRow = (row: PaletteRow): void => {
    if (row.kind === "slash") {
      if (row.row.kind === "namespace") openNamespace(row.row.namespace.id)
      else runSlashCommand(row.row.flow.name)
      return
    }
    if (row.kind === "help") {
      perform({ kind: "set-draft", draft: row.row.prefix })
      return
    }
    if (row.kind === "action") {
      perform({ kind: "run-action", action: row.action, item: row.item })
      return
    }
    const action = actionForKey(row.item, "open")
    if (action !== undefined) perform({ kind: "run-action", action, item: row.item })
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape" && typing) {
      event.preventDefault()
      controller.runCommand("chat.stop")
      return
    }
    if (!slashOpen || answer === undefined || rows === undefined) return
    const performed = perform(
      paletteKey({
        key: event.key,
        meta: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        draft,
        answer,
        rows,
        highlighted: slashHighlighted,
        slashBranch
      })
    )
    if (performed) {
      event.preventDefault()
      return
    }
    if (event.key !== "Enter") return
    /*
     * A declined Enter in the `/` mode is a slash command with its arguments
     * (`/implement fix it`): the slash tree never owned it, so it reaches
     * onSubmit (chat.send) as it did before the overlay existed, and the
     * overlay closes behind it. In every other mode Enter belongs to the
     * overlay while it is open and never falls through to the send.
     */
    if (answer.parsed.mode === "flows") {
      controller.closePalette(draft)
      return
    }
    event.preventDefault()
  }

  return (
    <>
      {slashOpen && answer !== undefined && rows !== undefined ?
        (
          <PaletteOverlay
            answer={answer}
            rows={rows}
            highlighted={slashHighlighted}
            slashBranch={slashBranch}
            onHighlight={(index) => setSlashMenu({ draft: overlayKey, index, dismissed: false })}
            onChoose={chooseRow}
          />
        ) :
        null}
      {!minimal && <div className="composer-header" data-testid="composer-header">
        <ComposerConnect open={connectMenuOpen} triggerRef={connectTriggerRef} />
        <ComposerOrigin />
      </div>}
      {/* §6.1: Send and Stop run registered flows, so they carry the law's marker. */}
      <ChatComposer
        className="smithers-composer"
        value={draft}
        onValueChange={controller.changeDraft}
        onSubmit={(text) => {
          controller.runCommandArgs("chat.send", text)
        }}
        onStop={() => controller.runCommand("chat.stop")}
        placeholder={placeholder}
        lifecycleStatus={typing ? "submitted" : "ready"}
        submitProps={COMPOSER_SEND_PROPS}
        stopProps={COMPOSER_STOP_PROPS}
        textareaProps={{ autoFocus, onKeyDown: onComposerKeyDown, ...COMPOSER_INPUT_TEST_ID }}
        actions={minimal ? undefined :
          <div className="composer-actions">
            <ComposerAdd open={addMenuOpen} triggerRef={addTriggerRef} />
            <ComposerMenu
              surface={surface}
              open={surfacesMenuOpen}
              triggerRef={surfacesTriggerRef}
            />
          </div>
        }
      />
    </>
  )
}

/** The existing repository picker, projected in the workspace sidebar. */
export function SidebarRepositoryPicker() {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return <ComposerConnect repositoriesOnly open={sessions[0]?.connectMenuOpen === true} triggerRef={triggerRef} />
}
