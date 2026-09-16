import { useLiveQuery } from "@tanstack/react-db"
import { BookOpen,ChevronRight,Download,FolderGit2,History,KeyRound,Moon,Pencil,Plus,RotateCcw,Sun,Timer,UserRound,Workflow,X } from "lucide-react"
import { useMemo } from "react"
import { roleMenuEntries } from "../AgentRoleMenu"
import { useController } from "../ControllerContext"
import { FirstSightHint } from "../FirstSightHint"
import { flowAction } from "../flows/FlowAction"
import { SELECT_REPO_LABEL } from "../Onboarding"
import { rovingKeyDown } from "../RovingKeyDown"
import type { Repo,RepoTreeRow,TabRow,WorkingCopy } from "../state/AppState"
import { DEFAULT_WORKSPACE_NAME,MAIN_TAB_ID,parseRepoSelection } from "../state/AppState"
import { isPracticeContext } from "../state/practice/PracticeContext"
import { knowledgeCardAvailable } from "../state/KnowledgeFeatures"
import { isReadOnlyCopy,workingCopyLabel } from "../state/WorkspaceViews"
import { StatusDetails } from "../StatusDetails"
import { copyTreesOf,RepoTree } from "./RepoTree"

/*
 * The sidebar (docs/workbench-lanes/sidebar-tree.md): the workspace heading
 * first — its name, the way back to the chat, and the pencil that renames it
 * — then one row per repository, grouped `org/ → repo → working copies`. A
 * working copy's row is a file tree: its caret expands the copy's ROOT, one
 * directory per fetch (a local checkout through the local app, a cloud
 * workspace copy through its box's files route, the shared read-only copy of
 * a public repository through the mirror's contents route), and a file click
 * renders the existing file card in the chat (files.read, or workspace.file
 * for a workspace copy). A read-only copy carries no write door: no `+`, no
 * unpin; the chrome's Sign in line is the door a signed-out reader has. The
 * SESSIONS a copy holds: terminals,
 * agents, pinned cards — nest under it after its files. Then `+`, and at the
 * bottom the chrome that must stay visible everywhere: "Sign in", then the
 * six chrome buttons the factory design session fixed in this order (mocks
 * ~/Desktop/smithers-factory/factory-mocks.html, every screen): Wiki,
 * Dispatcher, Flows, Secrets, History, Account. Each is the button door of
 * one registered flow and renders exactly where that flow registers; the
 * theme toggle and the admin reset close the column. Every affordance
 * dispatches a registered flow; the list, the tree, and the `+` menu are
 * projections of the collections and the session row. No user-visible word
 * "tab" lives here.
 */

/** One repository row of the Repos section: an inventory repository, or a local checkout it does not know. */
interface TreeRepo {
  readonly repoId: string
  readonly name: string
  readonly org: string | null
  readonly copies: ReadonlyArray<WorkingCopy>
}

export function ChromeBar({ identityInHeader = false }: { readonly identityInHeader?: boolean }) {
  const controller = useController()
  const { collections } = controller.store
  const { data: tabRows } = useLiveQuery((q) => q.from({ tab: collections.tabs }).orderBy(({ tab }) => tab.ordinal))
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: collections.sessions }).select(({ session }) => ({
      id: session.id,
      activeTabId: session.activeTabId,
      tabMenuOpen: session.tabMenuOpen,
      theme: session.theme,
      activeRepoKey: session.activeRepoKey,
      workspaceName: session.workspaceName,
      workspaceRenameOpen: session.workspaceRenameOpen
    }))
  )
  const { data: harnessRows } = useLiveQuery(collections.harnesses)
  const { data: agentRows } = useLiveQuery(collections.agents)
  const { data: identityRows } = useLiveQuery(collections.identitySessions)
  const { data: repoRows } = useLiveQuery(collections.repos)
  const { data: pinRows } = useLiveQuery((q) => q.from({ pin: collections.pinnedRepos }).orderBy(({ pin }) => pin.pinnedAt))
  const { data: repositoryRows } = useLiveQuery(collections.repositories)
  const { data: copyRows } = useLiveQuery(collections.workingCopies)
  const { data: treeRows } = useLiveQuery(collections.repoTree)
  // Every copy's tree, derived once per change of the rows: a shell render (a streamed token) re-derives none.
  const treeOf = useMemo(() => copyTreesOf(treeRows), [treeRows])
  const session = sessionRows[0]
  const identity = identityRows[0]
  const activeTabId = session?.activeTabId ?? MAIN_TAB_ID
  const dark = session?.theme === "dark"
  const menuOpen = session?.tabMenuOpen === true
  const workspaceName = session?.workspaceName && session.workspaceName !== DEFAULT_WORKSPACE_NAME ? session.workspaceName : "Chat"
  const renameOpen = session?.workspaceRenameOpen === true
  const available = harnessRows.filter((harness) => harness.status !== "unavailable")
  const unavailable = harnessRows.filter((harness) => harness.status === "unavailable")
  const roleEntries = roleMenuEntries(harnessRows, agentRows)
  const canOpenTerminal = controller.commands.find("tab.terminal") !== undefined
  const canOpenHarnesses = controller.commands.find("tab.harness") !== undefined
  const canSignIn = controller.commands.find("auth.sign-in") !== undefined
  // The web app's door to the native app (docs/web-mode/PLAN.md §3): registered on the cloud host only, and
  // rendered only while a native release exists to download (AppLinks.ts — null until one carries an asset).
  const canDownload = controller.commands.find("app.download") !== undefined && controller.downloadUrl !== null
  /*
   * The six chrome buttons, in the design session's order. Each one is the
   * button door of the registry entry its slash runs, so it renders exactly
   * where that flow registers and never invents a door.
   */
  // Wiki: the `wiki` surface switch (the Wiki pane beside the chat); registered on every host.
  const canWiki = controller.commands.find("wiki") !== undefined
  // Dispatcher: triggers.list, the dispatcher card; the Flows pane keeps its own door to the same flow.
  const canDispatcher = controller.commands.find("triggers.list") !== undefined
  // Flows: the `flows` surface switch (the Flows pane); registered on every host.
  const canFlows = controller.commands.find("flows") !== undefined
  // Secrets: secrets.list, registered on the cloud host only.
  const canSecrets = controller.commands.find("secrets.list") !== undefined
  // History: history.show, the mythical history card (design session 2026-09-07).
  const canHistory = controller.commands.find("history.show") !== undefined
  // Account (factory mock 21): account.show, registered where an identity seam exists.
  const canAccount = controller.commands.find("account.show") !== undefined
  const canOpenRepo = controller.commands.find("repo.open") !== undefined
  const canSelectRepo = controller.commands.find("repo.select") !== undefined
  const canTree = controller.commands.find("repo.tree") !== undefined
  const canRename = controller.commands.find("workspace.rename.edit") !== undefined
  // Admin chrome follows the same capability-filtered registry as every act.
  const isAdmin = controller.commands.find("admin.devtools") !== undefined
  const canAddSession = canOpenTerminal || canOpenHarnesses

  /*
   * The Repos section is the piper tree (ADR 0001, lane piper step 3): the
   * cloud inventory grouped `org/ → repo → working copies`, and local
   * checkouts the inventory does not know as standalone rows (their repoId
   * never invents an owner). Selecting a repo row names `org/repo`; selecting
   * a copy row names `org/repo#copyId`; a local-only checkout uses its local key.
   * No mirror glyph: the backend has no mirror status yet (plue#445).
   */
  const activeKey = session?.activeRepoKey ?? null
  const selection = activeKey === null ? null : parseRepoSelection(activeKey)
  const activeCopyId = selection === null ? null : "repoId" in selection ? selection.copyId ?? null : selection.localCopyId
  const pinIds = new Set(pinRows.map((pin) => pin.id))
  const openByPath = new Map<string, Repo>(repoRows.map((repo) => [repo.path, repo]))
  const copiesByRepoId = new Map<string, ReadonlyArray<WorkingCopy>>()
  const latest = new Map<string, WorkingCopy>()
  // Inventory rows share a refresh timestamp; workspace creation identifies the latest branch attempt.
  const attemptTime = (copy: WorkingCopy) => {
    const createdAt = copy.workspaceId ? collections.cloudWorkspaces.get(copy.workspaceId)?.createdAt : null
    const at = createdAt ? Date.parse(createdAt) : NaN
    return Number.isFinite(at) ? at : copy.updatedAt
  }
  for (const copy of copyRows) {
    const key = copy.kind === "workspace" ? JSON.stringify([copy.repoId, copy.bookmark ?? copy.label]) : copy.id
    const previous = latest.get(key)
    if (!previous || attemptTime(copy) > attemptTime(previous) || (attemptTime(copy) === attemptTime(previous) && copy.revision > previous.revision)) latest.set(key, copy)
  }
  for (const copy of latest.values()) {
    copiesByRepoId.set(copy.repoId, [...(copiesByRepoId.get(copy.repoId) ?? []), copy])
  }
  const tree: Array<TreeRepo> = [...repositoryRows]
    .sort((left, right) => left.org.localeCompare(right.org) || left.name.localeCompare(right.name))
    .map((repository) => ({
      repoId: repository.id,
      name: repository.name,
      org: repository.org,
      copies: copiesByRepoId.get(repository.id) ?? []
    }))
  const knownRepoIds = new Set(repositoryRows.map((repository) => repository.id))
  const standalone: Array<TreeRepo> = [...copiesByRepoId.entries()]
    .filter(([repoId]) => !knownRepoIds.has(repoId))
    .map(([repoId, copies]) => ({
      repoId,
      name: copies[0]?.label ?? repoId,
      org: null,
      copies
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const groups = isPracticeContext(controller.store) ? [] : [...tree, ...standalone].filter(repo =>
    controller.repositoryApp === null ||
    repo.repoId.toLowerCase() === controller.repositoryApp.toLowerCase() ||
    repo.copies.some(copy => copy.id === activeCopyId)
  )
  const copyIds = new Set(copyRows.map((copy) => copy.id))
  const sessionsUnder = (key: string): ReadonlyArray<TabRow> =>
    tabRows.filter((tab) => tab.kind !== "main" && tab.repoKey === key)
  const orphanSessions = tabRows.filter((tab) =>
    tab.kind !== "main" && (tab.repoKey === undefined || !copyIds.has(tab.repoKey))
  )

  /* A session row: a terminal, an agent, or a card opened in the sidebar. */
  const sessionRow = (tab: TabRow) => tab.kind === "card" &&
    !knowledgeCardAvailable(collections.cards.get(tab.cardId)?.kind ?? "", controller.features) ? null : (
    <div
      key={tab.id}
      className="tab"
      role="presentation"
      data-kind={tab.kind}
      data-active={tab.id === activeTabId}
      data-testid={`tab-${tab.id}`}
    >
      <button
        type="button"
        role="tab"
        className="tab-select"
        aria-selected={tab.id === activeTabId}
        aria-label={tab.title}
        aria-describedby={tab.kind === "harness" || tab.kind === "terminal" && tab.workspaceId === undefined ? `status-${tab.id}` : undefined}
        title={tab.title}
        data-tab-id={tab.id}
        {...flowAction(controller.runCommand, "tab.select", tab.id)}
      >
        <span className="tab-title">{tab.title}</span>
        {(tab.kind === "harness" || tab.kind === "terminal" && tab.workspaceId === undefined) &&
          <StatusDetails id={`status-${tab.id}`} status={tab.statusRollup} fallback={tab.exitCode === undefined ? "running" : tab.exitCode === 0 ? "completed" : tab.exitCode === null ? "stopped" : "failed"} />}
      </button>
      <button
        type="button"
        className="tab-close"
        aria-label={`Close ${tab.title}`}
        title="Close session"
        data-testid={`tab-close-${tab.id}`}
        {...flowAction(controller.runCommand, "tab.close", tab.id)}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  )

  /*
   * The caret on a copy's row: `repo.tree <copyId>` expands the copy's root.
   * A local checkout lists through the local app; a cloud workspace copy (a
   * box) lists through its own files route, so both rows carry the caret.
   */
  const treeToggle = (copy: WorkingCopy, root: RepoTreeRow | undefined) =>
    canTree ?
      (
        <button
          type="button"
          className="repo-caret"
          aria-expanded={root?.expanded === true}
          aria-label={root?.expanded === true ? `Collapse ${copy.label}` : `Expand ${copy.label}`}
          data-testid={`repo-tree-toggle-${copy.id}`}
          {...flowAction(controller.runCommand, "repo.tree", copy.id)}
        >
          <ChevronRight size={12} aria-hidden="true" />
        </button>
      ) :
      null

  /* The expanded tree under a copy's row (RepoTree.tsx); a local checkout reads its files through its open repository. */
  const copyTree = (copy: WorkingCopy) => (
    <RepoTree
      copy={copy}
      view={treeOf(copy.id)}
      repoId={copy.path === undefined ? undefined : openByPath.get(copy.path)?.id}
    />
  )

  /* A copy's sessions, labelled apart from its files once the tree is open. */
  const copySessions = (copy: WorkingCopy, treeOpen: boolean) => {
    const rows = sessionsUnder(copy.id)
    return (
      <>
        {treeOpen && rows.length > 0 ?
          <div className="repo-sessions-label" aria-hidden="true">sessions</div> :
          null}
        <div className="repo-tabs" role="presentation">
          {rows.map(sessionRow)}
        </div>
      </>
    )
  }

  return (
    <aside className="chrome-bar" aria-label="Sessions and chrome">
      {
        /*
         * The `+` sits BESIDE the list, not inside it. The list scrolls
         * vertically (overflow-y: auto), and an overflow container clips its
         * absolutely-positioned descendants on both axes — a menu rendered
         * inside the strip once opened into a 28px box and painted nothing
         * (the trigger read aria-expanded="true" while the human saw no
         * menu). Outside the list the menu is clipped by nothing.
         */
      }
      <div className="chrome-tabs">
        <div
          className="tab-strip"
          role="tablist"
          aria-label="Sessions"
          aria-orientation="vertical"
          data-testid="tab-strip"
          onKeyDown={(event) => {
            // A vertical tablist: ArrowUp/ArrowDown (Home/End) move between the heading and the sessions, across every repo group, and select the one reached.
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
            const current = tabs.findIndex((tab) => tab === document.activeElement)
            // The ring is the tabs' own: the inline rename input sits inside the strip, so with focus off a tab the keys belong to whatever has it.
            if (current === -1) return
            const move = rovingKeyDown(event.key, { count: tabs.length, current, ends: true })
            if (move.kind !== "move") return
            event.preventDefault()
            const target = tabs[move.index]
            if (target === undefined) return
            target.focus()
            const id = target.dataset.tabId
            if (id !== undefined && id !== activeTabId) controller.runCommand("tab.select", id)
          }}
        >
          {
            /*
             * The heading IS the workspace: its name is the way back to the
             * chat (tab.select main — a `role="tab"` so the roving focus and
             * Cmd+1 keep working), and the pencil swaps it for the inline
             * rename (Enter commits through workspace.rename, Escape closes
             * through workspace.rename.edit; the draft lives in the input).
             */
          }
          <div
            className="workspace-heading"
            role="presentation"
            data-active={activeTabId === MAIN_TAB_ID}
            data-testid="workspace-heading"
          >
            {renameOpen ?
              (
                <input
                  className="workspace-name-input"
                  type="text"
                  aria-label="Workspace name"
                  defaultValue={session?.workspaceName ?? ""}
                  placeholder={DEFAULT_WORKSPACE_NAME}
                  autoFocus
                  data-testid="workspace-name-input"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      controller.runCommand("workspace.rename", event.currentTarget.value)
                    } else if (event.key === "Escape") {
                      event.preventDefault()
                      event.stopPropagation()
                      controller.runCommand("workspace.rename.edit")
                    }
                  }}
                />
              ) :
              (
                <button
                  type="button"
                  role="tab"
                  className="workspace-name"
                  aria-selected={activeTabId === MAIN_TAB_ID}
                  data-tab-id={MAIN_TAB_ID}
                  data-testid="workspace-name"
                  {...flowAction(controller.runCommand, "tab.select", MAIN_TAB_ID)}
                >
                  {workspaceName}
                </button>
              )}
            {canRename ?
              (
                <button
                  type="button"
                  className="workspace-rename"
                  aria-label="Rename workspace"
                  aria-pressed={renameOpen}
                  data-testid="workspace-rename"
                  {...flowAction(controller.runCommand, "workspace.rename.edit")}
                >
                  <Pencil size={12} aria-hidden="true" />
                </button>
              ) :
              null}
          </div>
          <div className="repo-section" role="presentation" data-testid="repo-section">
            {groups.length === 0 && canOpenRepo ?
              (
                // No repository yet: the one step, bound exactly as the opening message binds it.
                <button
                  type="button"
                  className="repo-empty"
                  data-testid="repo-empty"
                  {...flowAction(controller.runCommand, "repo.open")}
                >
                  <FolderGit2 size={14} aria-hidden="true" />
                  <span>{SELECT_REPO_LABEL}</span>
                </button>
              ) :
              null}
            {groups.map((group, groupIndex) => {
              /*
               * A local checkout the inventory does not know renders as the
               * flat row it always was (its copy id is the select token);
               * a cloud repository renders as the org/repo tree with its
               * working copies nested.
               */
              const single = group.org === null && group.copies.length === 1 ? group.copies[0] : undefined
              const groupKey = single?.id ?? group.repoId
              const selectToken = single?.id ?? group.repoId
              const active = single !== undefined
                ? activeCopyId === single.id
                : activeKey === group.repoId || (selection !== null && "repoId" in selection && selection.repoId === group.repoId)
              const open = single !== undefined && single.path !== undefined && openByPath.has(single.path)
              const orgHeader = group.org !== null && groups[groupIndex - 1]?.org !== group.org
              const singleTree = single === undefined ? undefined : treeOf(single.id)
              return (
                <div key={groupKey} role="presentation">
                  {orgHeader ?
                    <div className="repo-org" aria-hidden="true" data-testid={`repo-org-${group.org ?? ""}`}>{group.org}/</div> :
                    null}
                  <div
                    className="repo-group"
                    role="presentation"
                    data-active={active}
                    data-open={open}
                    data-testid={`repo-${groupKey}`}
                  >
                    <div className="repo" role="presentation">
                      {single !== undefined ? treeToggle(single, singleTree?.root) : null}
                      <button
                        type="button"
                        className="repo-select"
                        aria-current={active ? "true" : undefined}
                        title={group.repoId}
                        data-testid={`repo-select-${groupKey}`}
                        disabled={!canSelectRepo}
                        {...flowAction(controller.runCommand, "repo.select", selectToken)}
                      >
                        <FolderGit2 size={14} aria-hidden="true" />
                        <span className="repo-name">{group.name}</span>
                      </button>
                      {single !== undefined && canAddSession && !isReadOnlyCopy(single) ?
                        (
                          <button
                            type="button"
                            className="repo-add"
                            aria-label={`New session in ${single.label}`}
                            title={`New session in ${single.label}`}
                            data-testid={`repo-add-${single.id}`}
                            {...flowAction(controller.runCommand, "tab.menu", single.id)}
                          >
                            <Plus size={12} aria-hidden="true" />
                          </button>
                        ) :
                        null}
                      {single !== undefined && canSelectRepo && pinIds.has(single.id) ?
                        (
                          <button
                            type="button"
                            className="repo-unpin"
                            aria-label={`Unpin ${single.label}`}
                            title="Unpin repository"
                            data-testid={`repo-unpin-${single.id}`}
                            {...flowAction(controller.runCommand, "repo.unpin", single.id)}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        ) :
                        null}
                    </div>
                    {single !== undefined && singleTree !== undefined ?
                      (
                        <>
                          {copyTree(single)}
                          {copySessions(single, singleTree.root?.expanded === true)}
                        </>
                      ) :
                      (
                        <div className="repo-copies" role="presentation">
                          {group.copies.map((copy) => {
                            const copyActive = activeCopyId === copy.id
                            const copyLabel = workingCopyLabel(copy)
                            const view = treeOf(copy.id)
                            return (
                              <div key={copy.id} className="repo-copy" role="presentation" data-testid={`copy-${copy.id}`}>
                                <div className="repo" role="presentation">
                                  {treeToggle(copy, view.root)}
                                  <button
                                    type="button"
                                    className="repo-select"
                                    aria-current={copyActive ? "true" : undefined}
                                    title={copy.path ?? copy.workspaceId ?? copy.id}
                                    data-testid={`copy-select-${copy.id}`}
                                    disabled={!canSelectRepo}
                                    {...flowAction(controller.runCommand, "repo.select", `${group.repoId}#${copy.id}`)}
                                  >
                                    <FolderGit2 size={12} aria-hidden="true" />
                                    <span className="repo-name">{copyLabel}</span>
                                  </button>
                                  {/* The `+` is a write door: never on a read-only copy (the shared copy of a public repository). */}
                                  {copy.kind === "local" && canAddSession && !isReadOnlyCopy(copy) ?
                                    (
                                      <button
                                        type="button"
                                        className="repo-add"
                                        aria-label={`New session in ${copy.label}`}
                                        title={`New session in ${copy.label}`}
                                        data-testid={`repo-add-${copy.id}`}
                                        {...flowAction(controller.runCommand, "tab.menu", copy.id)}
                                      >
                                        <Plus size={12} aria-hidden="true" />
                                      </button>
                                    ) :
                                    null}
                                  {copy.kind === "local" && canSelectRepo && pinIds.has(copy.id) ?
                                    (
                                      <button
                                        type="button"
                                        className="repo-unpin"
                                        aria-label={`Unpin ${copy.label}`}
                                        title="Unpin repository"
                                        data-testid={`repo-unpin-${copy.id}`}
                                        {...flowAction(controller.runCommand, "repo.unpin", copy.id)}
                                      >
                                        <X size={12} aria-hidden="true" />
                                      </button>
                                    ) :
                                    null}
                                </div>
                                {copyTree(copy)}
                                {copySessions(copy, view.root?.expanded === true)}
                              </div>
                            )
                          })}
                        </div>
                      )}
                  </div>
                </div>
              )
            })}
            {orphanSessions.length > 0 ?
              (
                <div className="repo-group" role="presentation" data-testid="repo-none">
                  <div className="repo repo-none" role="presentation">
                    <span className="repo-name">No repository</span>
                  </div>
                  <div className="repo-tabs" role="presentation">
                    {orphanSessions.map(sessionRow)}
                  </div>
                </div>
              ) :
              null}
          </div>
        </div>
        {canAddSession ? <div className="tab-add">
          <button
            type="button"
            className="tab-add-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="New session"
            title="New session"
            data-testid="tab-add"
            {...flowAction(controller.runCommand, "tab.menu")}
          >
            <Plus size={14} aria-hidden="true" />
            <span>New session</span>
          </button>
          {menuOpen ?
            (
              <>
                {/* A press anywhere else closes the menu; the backdrop is the outside. */}
                <div
                  className="tab-add-backdrop"
                  aria-hidden="true"
                  {...flowAction(controller.runCommand, "tab.menu")}
                />
                <div className="tab-add-menu" role="menu" aria-label="New session" data-testid="tab-add-menu">
                  {canOpenTerminal ? <button
                    type="button"
                    role="menuitem"
                    className="tab-add-item"
                    data-testid="tab-add-terminal"
                    {...flowAction(controller.runCommand, "tab.terminal")}
                  >
                    <span>Terminal</span>
                  </button> : null}
                  {/* Agents: each configured harness launches as a subagent of this conversation, in its own session. */}
                  {canOpenHarnesses && harnessRows.length > 0 ?
                    <div className="tab-add-group" role="presentation" data-testid="tab-add-agents">Agents</div> :
                    null}
                  {/* The named roles first (AgentRoles.ts): one model each, disabled with the reason when their harness cannot run it. */}
                  {canOpenHarnesses && harnessRows.length > 0 ? roleEntries.map((entry) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={entry.role.id}
                      className="tab-add-item"
                      disabled={!entry.available}
                      title={entry.available ? entry.role.purpose : entry.reason}
                      data-role={entry.role.id}
                      data-testid={`tab-add-role-${entry.role.id}`}
                      {...flowAction(controller.runCommand, "agent.role", entry.role.id)}
                    >
                      <span>{entry.title}</span>
                      <span className="tab-add-account">{entry.available ? entry.account : entry.reason}</span>
                    </button>
                  )) : null}
                  {canOpenHarnesses ? available.map((harness) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={harness.id}
                      className="tab-add-item"
                      data-testid={`tab-add-harness-${harness.id}`}
                      {...flowAction(controller.runCommand, "tab.harness", harness.id)}
                    >
                      <span>{harness.displayName}</span>
                      <span className="tab-add-account">{harness.account?.email ?? harness.account?.label ?? ""}</span>
                    </button>
                  )) : null}
                  {canOpenHarnesses ? unavailable.map((harness) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={harness.id}
                      className="tab-add-item"
                      disabled
                      data-testid={`tab-add-harness-${harness.id}`}
                      {...flowAction(controller.runCommand, "tab.harness", harness.id)}
                    >
                      <span>{harness.displayName}</span>
                      <span className="tab-add-account">{harness.status}</span>
                    </button>
                  )) : null}
                </div>
              </>
            ) :
            null}
        </div> : null}
      </div>
      {
        /*
         * The chrome that belongs to no session, so it stays visible in a
         * terminal or an agent exactly as in the chat. It renders LAST because
         * DOM order is focus order and these controls are chrome, not the work.
         */
      }
      <div className="chrome-actions" data-testid="chrome-actions">
        {/* The repository lives at the top of the composer (its selector and origin), not here. */}
        {/* Sign-in is an option, never a gate (docs/LOCAL-APP.md); the door closes once signed in. */}
        {identityInHeader || !canSignIn || identity?.state === "signed-in" ? null : (
          <button
            type="button"
            className="chrome-action"
            data-testid="chrome-sign-in"
            {...flowAction(controller.runCommand, "auth.sign-in")}
          >
            Sign in with GitHub
          </button>
        )}
        {/* The click is the human's gesture window.open needs; the model renders the card (app.download.prompt) instead. */}
        {canDownload ?
          (
            <button
              type="button"
              className="chrome-action chrome-action-download"
              data-testid="chrome-download"
              {...flowAction(controller.runCommand, "app.download")}
            >
              <Download size={14} aria-hidden="true" />
              Download the app
            </button>
          ) :
          null}
        {/* Wiki: the button door of the `wiki` surface switch; the pane opens beside the chat, signed in or out. */}
        {canWiki ?
          (
            <FirstSightHint id="chrome-wiki" content="Read and edit your Wiki."><button
              type="button"
              className="chrome-action chrome-action-wiki"
              data-testid="chrome-wiki"
              {...flowAction(controller.runCommand, "wiki")}
            >
              <BookOpen size={14} aria-hidden="true" />
              Wiki
            </button></FirstSightHint>
          ) :
          null}
        {/* Dispatcher: the button door of triggers.list; readable signed out from the declaration on the public mirror. */}
        {canDispatcher ?
          (
            <FirstSightHint id="chrome-dispatcher" content="Manage scheduled and triggered work."><button
              type="button"
              className="chrome-action chrome-action-dispatcher"
              data-testid="chrome-dispatcher"
              {...flowAction(controller.runCommand, "triggers.list")}
            >
              <Timer size={14} aria-hidden="true" />
              Dispatcher
            </button></FirstSightHint>
          ) :
          null}
        {/* Flows: the button door of the `flows` surface switch; signed out the pane states that flows run on your own workspace. */}
        {canFlows ?
          (
            <FirstSightHint id="chrome-flows" content="Browse and run flows."><button
              type="button"
              className="chrome-action chrome-action-flows"
              data-testid="chrome-flows"
              {...flowAction(controller.runCommand, "flows")}
            >
              <Workflow size={14} aria-hidden="true" />
              Flows
            </button></FirstSightHint>
          ) :
          null}
        {/* Secrets: the button door of secrets.list; signed out, the run path defers it behind the sign-in step. */}
        {canSecrets ?
          (
            <FirstSightHint id="chrome-secrets" content="Manage credentials for your flows."><button
              type="button"
              className="chrome-action chrome-action-secrets"
              data-testid="chrome-secrets"
              {...flowAction(controller.runCommand, "secrets.list")}
            >
              <KeyRound size={14} aria-hidden="true" />
              Secrets
            </button></FirstSightHint>
          ) :
          null}
        {/* History: the button door of history.show; readable signed out through the public mirror. */}
        {canHistory ?
          (
            <FirstSightHint id="chrome-history" content="Browse previous work."><button
              type="button"
              className="chrome-action chrome-action-history"
              data-testid="chrome-history"
              {...flowAction(controller.runCommand, "history.show")}
            >
              <History size={14} aria-hidden="true" />
              History
            </button></FirstSightHint>
          ) :
          null}
        {/* Account: the button door of account.show; signed out, the same flow renders the sign-in step. */}
        {canAccount ?
          (
            <FirstSightHint id="chrome-account" content="Manage your account."><button
              type="button"
              className="chrome-action chrome-action-account"
              data-testid={identityInHeader ? "sidebar-account" : "chrome-account"}
              {...flowAction(controller.runCommand, "account.show")}
            >
              <UserRound size={14} aria-hidden="true" />
              Account
            </button></FirstSightHint>
          ) :
          null}
        <div className="chrome-corner">
      {/* The bare reset is admin-only dev tooling (§2); users get /clear. */}
      {isAdmin ?
        (
          <button
            type="button"
            className="chrome-icon-action corner-reset-btn"
            aria-label="Reset conversation"
            title="Reset conversation"
            {...flowAction(controller.runCommand, "admin.reset.ask")}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      <button
        type="button"
        className="chrome-icon-action corner-theme-btn"
        aria-label="Toggle light and dark mode"
        title="Toggle light and dark mode"
        {...flowAction(controller.runCommand, "appearance.dark-mode")}
      >
        {dark ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
      </button>
      </div>
      </div>
    </aside>
  )
}
