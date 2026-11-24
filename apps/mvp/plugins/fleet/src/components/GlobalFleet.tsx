import {
  Badge,
  type BadgeProps,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  RelativeTime,
  SectionHeader,
  SegmentedControl,
  type SegmentedControlOption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useClock,
} from "@smthrs/ui"
import { type KeyboardEvent, type MouseEvent, useSyncExternalStore } from "react"
import {
  accountRowsOf,
  ACTIVE_STATUS,
  ALL,
  type AttentionItem,
  attentionItemsOf,
  filterSessions,
  formatCpuSeconds,
  formatTokensAndTime,
  harnessesOf,
  hostRowsOf,
  type ProjectSummary,
  projectsOf,
  type RepoSlug,
  rowsOf,
  sectionOf,
  selectedSessionOf,
  type SessionRow,
  sessionRowsOf,
  type SessionStatusFilter,
  statusCountsOf,
  summaryOfGlobal,
  type TranscriptRole,
} from "../GlobalFleetModel"
import type { FleetTab, Watched } from "../tab"
import "./fleet.css"
import { Pill } from "./parts"

function useWatched<A>(watched: Watched<A>): A {
  return useSyncExternalStore(watched.subscribe, watched.current, watched.current)
}

export function GlobalFleet({ tab }: { readonly tab?: FleetTab }) {
  if (tab === undefined) return <EmptyState title="Fleet unavailable" />
  return <Shown tab={tab} />
}

const HOST_WORDS = { loading: "Loading hosts", unavailable: "Hosts unavailable", empty: "No hosts connected" }
const ACCOUNT_WORDS = { loading: "Loading accounts", unavailable: "Accounts unavailable", empty: "No accounts reported" }
const SESSION_WORDS = { loading: "Loading sessions", unavailable: "Sessions unavailable", empty: "No active sessions" }

const ROLE_BADGE: Readonly<Record<TranscriptRole, { readonly label: string; readonly variant: NonNullable<BadgeProps["variant"]> }>> = {
  user: { label: "User", variant: "default" },
  assistant: { label: "Assistant", variant: "secondary" },
  tool: { label: "Tool", variant: "outline" },
  system: { label: "System", variant: "muted" },
}

const stopEvent = (event: MouseEvent | KeyboardEvent) => {
  event.stopPropagation()
}

function RepoQuickLinks({ slug, className }: { readonly slug: RepoSlug; readonly className?: string }) {
  return (
    <nav
      className={className ? `fleet-repo-links ${className}` : "fleet-repo-links"}
      aria-label={`${slug.owner}/${slug.repo} links`}
      onClick={stopEvent}
      onKeyDown={stopEvent}
    >
      <a href={slug.basePath}>Repo</a>
      <a href={`${slug.basePath}/pulls`}>PRs</a>
      <a href={`${slug.basePath}/branches`}>Branches</a>
      <a href={`${slug.basePath}/actions`}>Actions</a>
    </nav>
  )
}

function ProjectCard({
  project,
  selected,
  onToggle,
}: {
  readonly project: ProjectSummary
  readonly selected: boolean
  readonly onToggle: () => void
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onToggle()
    }
  }

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-project-card={project.project}
      data-selected={selected ? "" : undefined}
      className="fleet-project-card"
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <CardHeader className="fleet-project-header">
        <div className="fleet-project-heading">
          <CardTitle className="fleet-project-name">{project.project}</CardTitle>
          {project.lastMs === null ? null : (
            <span className="fleet-project-seen">
              <RelativeTime ts={project.lastMs} />
            </span>
          )}
        </div>
        <div className="fleet-project-counts" aria-label="Project session counts">
          {project.workingCount > 0 ? <Badge variant="default">{project.workingCount} working</Badge> : null}
          {project.waitingCount > 0 ? <Badge variant="warning">{project.waitingCount} waiting</Badge> : null}
          {project.errorCount > 0 ? <Badge variant="destructive">{project.errorCount} issue{project.errorCount === 1 ? "" : "s"}</Badge> : null}
          {project.idleCount > 0 ? <Badge variant="muted">{project.idleCount} idle</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="fleet-project-body">
        <p className="fleet-project-summary" title={project.topSummary !== "-" ? project.topSummary : undefined}>
          {project.topSummary !== "-" ? project.topSummary : "No live summary reported yet"}
        </p>
        <div className="fleet-project-footer">
          <span className="fleet-project-harnesses">
            {project.harnesses.map((h) => `${h.harness}${h.sessions > 1 ? ` (${h.sessions})` : ""}`).join(" · ")}
          </span>
          {project.repoSlug === null ? null : <RepoQuickLinks slug={project.repoSlug} />}
        </div>
      </CardContent>
    </Card>
  )
}

function SessionDrawer({
  session,
  hostName,
  onClose,
}: {
  readonly session: SessionRow
  readonly hostName: string
  readonly onClose: () => void
}) {
  return (
    <aside
      className="fleet-inspector"
      aria-label={`Session inspector: ${session.project}`}
      data-session-inspector={session.sessionKey}
      ref={(node) => {
        if (node === null) return
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
          if (event.key === "Escape") onClose()
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
      }}
    >
      <Card className="fleet-inspector-card">
        <CardHeader className="fleet-inspector-header">
          <div className="fleet-inspector-title-block">
            <div className="fleet-inspector-badges">
              <Pill tone={session.tone}>{session.statusWord}</Pill>
              <Badge variant={session.managed ? "default" : "outline"}>
                {session.managed ? "Managed" : "Observed"}
              </Badge>
              <Badge variant="secondary">{session.harness}</Badge>
            </div>
            <CardTitle className="fleet-inspector-project">{session.project}</CardTitle>
            {session.title !== "-" && session.title !== session.summary ? (
              <p className="fleet-inspector-subtitle">{session.title}</p>
            ) : null}
            {session.repoSlug === null ? null : <RepoQuickLinks slug={session.repoSlug} className="fleet-inspector-repo-links" />}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="fleet-inspector-close"
            onClick={onClose}
            aria-label="Close session inspector"
          >
            ×
          </Button>
        </CardHeader>

        <CardContent className="fleet-inspector-content">
          <section className="fleet-inspector-section" aria-label="Current activity">
            <h3 className="fleet-inspector-eyebrow">What it&apos;s doing</h3>
            <p className="fleet-inspector-summary">
              {session.summary !== "-" ? session.summary : "No summary captured for this session yet."}
            </p>
          </section>

          <section className="fleet-inspector-section" aria-label="Session telemetry">
            <h3 className="fleet-inspector-eyebrow">Telemetry</h3>
            <dl className="fleet-telemetry-grid">
              <div>
                <dt>Host</dt>
                <dd>{hostName === session.nodeId ? session.nodeId : `${hostName} (${session.nodeId})`}</dd>
              </div>
              <div>
                <dt>Harness</dt>
                <dd>{session.harness}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{session.model}</dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{session.account}</dd>
              </div>
              <div>
                <dt>Lane</dt>
                <dd>{session.lane ?? "-"}</dd>
              </div>
              <div>
                <dt>PID</dt>
                <dd className="fleet-number">{session.pid === null ? "-" : String(session.pid)}</dd>
              </div>
              <div>
                <dt>CPU</dt>
                <dd className="fleet-number">{formatCpuSeconds(session.cpuSeconds)}</dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd className="fleet-number">
                  {session.tokensUsed === null
                    ? "-"
                    : `${session.tokensCompact} (${session.tokensUsed.toLocaleString()})`}
                </dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd className="fleet-number">
                  {session.startedMs === null ? "-" : <RelativeTime ts={session.startedMs} />}
                </dd>
              </div>
              <div>
                <dt>Last activity</dt>
                <dd className="fleet-number">
                  {session.lastMs === null ? "-" : <RelativeTime ts={session.lastMs} />}
                </dd>
              </div>
              <div className="fleet-telemetry-wide">
                <dt>Working directory</dt>
                <dd className="fleet-mono">{session.cwd ?? "-"}</dd>
              </div>
            </dl>
          </section>

          <section className="fleet-inspector-section fleet-transcript-section" aria-label="Live transcript">
            <div className="fleet-transcript-head">
              <h3 className="fleet-inspector-eyebrow">Live transcript</h3>
              {session.transcript.length > 0 ? (
                <Badge variant="muted">
                  {session.transcript.length} {session.transcript.length === 1 ? "turn" : "turns"}
                </Badge>
              ) : null}
            </div>
            {session.transcript.length === 0 ? (
              <div className="fleet-transcript-empty">
                No transcript captured for this harness — live process/container telemetry is shown above.
              </div>
            ) : (
              <ol className="fleet-transcript-list">
                {session.transcript.map((entry, idx) => {
                  const role = ROLE_BADGE[entry.role]
                  return (
                    <li key={`${entry.ts ?? "t"}-${idx}`} className="fleet-transcript-entry" data-role={entry.role}>
                      <div className="fleet-transcript-meta">
                        <Badge variant={role.variant}>{role.label}</Badge>
                        {entry.label === null ? null : <code className="fleet-transcript-label">{entry.label}</code>}
                        {entry.tsMs !== null ? (
                          <span className="fleet-transcript-ts">
                            <RelativeTime ts={entry.tsMs} />
                          </span>
                        ) : entry.ts !== null ? (
                          <span className="fleet-transcript-ts">{entry.ts}</span>
                        ) : null}
                      </div>
                      {entry.text.trim().length === 0 ? null : (
                        <div className={entry.role === "tool" ? "fleet-transcript-text fleet-mono" : "fleet-transcript-text"}>
                          {entry.text}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
        </CardContent>
      </Card>
    </aside>
  )
}

function Shown({ tab }: { readonly tab: FleetTab }) {
  const nodes = useWatched(tab.queries.globalNodes())
  const sessions = useWatched(tab.queries.globalSessions())
  const accounts = useWatched(tab.queries.globalAccounts())
  const filters = useWatched(tab.queries.filters)
  const now = useClock(true, 10_000)

  // Each part draws counts and "none" only from a delivered snapshot: loading or withheld rows are not an empty fleet.
  const hosts = sectionOf(nodes, HOST_WORDS, (rows) => hostRowsOf(rows, now))
  const active = sectionOf(sessions, SESSION_WORDS, (rows) => sessionRowsOf(rows, now, false))
  const accountsShown = sectionOf(accounts, ACCOUNT_WORDS, accountRowsOf)
  const summary = summaryOfGlobal(hosts, active, accountsShown)
  const hostRows = rowsOf(hosts)
  const accountRows = rowsOf(accountsShown)
  const allSessions = rowsOf(active)

  const hostNames = new Map(hostRows.map((h) => [h.nodeId, h.name]))
  const projects = projectsOf(allSessions)
  const statusCounts = statusCountsOf(allSessions)
  const filteredSessions = filterSessions(allSessions, filters, hostNames)
  const selectedSession = selectedSessionOf(allSessions, filters.selectedSessionKey)
  const attention = attentionItemsOf(hostRows, allSessions, accountRows)

  const hasNonDefaultFilters =
    filters.host !== ALL ||
    filters.harness !== ALL ||
    filters.project !== ALL ||
    filters.status !== ACTIVE_STATUS ||
    filters.query.trim().length > 0

  const statusOptions: ReadonlyArray<SegmentedControlOption> = [
    { value: "active", label: `Active (${statusCounts.active})` },
    { value: "working", label: `Working (${statusCounts.working})` },
    { value: "waiting", label: `Waiting (${statusCounts.waiting})` },
    ...(statusCounts.error > 0 || filters.status === "error"
      ? [{ value: "error", label: `Issues (${statusCounts.error})` }]
      : []),
    { value: "idle", label: `Idle (${statusCounts.idle})` },
    { value: "all", label: `All (${statusCounts.all})` },
  ]

  const toggleProject = (project: ProjectSummary) => {
    if (filters.project === project.project) {
      tab.actions.filterProject(ALL)
      return
    }
    tab.actions.filterProject(project.project)
    // If the clicked project only has idle sessions while viewing active-only, widen to all so rows show immediately.
    if (project.activeCount === 0 && project.idleCount > 0 && filters.status === ACTIVE_STATUS) {
      tab.actions.filterStatus("all")
    }
  }

  const toggleHost = (nodeId: string) => {
    tab.actions.filterHost(filters.host === nodeId ? ALL : nodeId)
  }

  const handleAttentionClick = (item: AttentionItem) => {
    if (item.action._tag === "FilterHost") {
      tab.actions.filterHost(item.action.nodeId)
      tab.actions.filterStatus("all")
      document.getElementById("fleet-sessions")?.scrollIntoView({ behavior: "smooth", block: "start" })
      return
    }
    if (item.action._tag === "SelectSession") {
      tab.actions.filterHost(ALL)
      tab.actions.filterHarness(ALL)
      tab.actions.filterProject(ALL)
      tab.actions.filterQuery("")
      tab.actions.filterStatus(item.action.status)
      tab.actions.selectSession(item.action.sessionKey)
      document.getElementById("fleet-sessions")?.scrollIntoView({ behavior: "smooth", block: "start" })
      return
    }
    document.getElementById("fleet-accounts")?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const onSessionRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, sessionKey: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      tab.actions.selectSession(filters.selectedSessionKey === sessionKey ? null : sessionKey)
    }
  }

  const onHostRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, nodeId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      toggleHost(nodeId)
    }
  }

  return (
    <div className="fleet" data-global-fleet="">
      <header className="fleet-header">
        <div className="fleet-header-main">
          {summary === undefined ? (
            <p className="fleet-summary" aria-label="Fleet summary" data-pending="">Fleet counts unavailable</p>
          ) : (
            <p className="fleet-summary" aria-label="Fleet summary">
              <span>hosts {summary.onlineHosts}/{summary.totalHosts}</span>
              <span>{statusCounts.active} active / {summary.activeSessions} sessions</span>
              {summary.harnesses.map((each) => (
                <span key={each.harness} data-harness={each.harness}>{each.harness} {each.sessions}</span>
              ))}
              <span>accounts {summary.readyAccounts}/{summary.totalAccounts} ready</span>
              {summary.alertsCount > 0 ? <Pill tone="bad">{summary.alertsCount} alerts</Pill> : null}
            </p>
          )}
        </div>
        <nav className="fleet-header-links" aria-label="Fleet quick links">
          <Button asChild variant="outline" size="sm">
            <a href="/app/queue">Work Queue</a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href="/app/settings">Connect Agent / MCP</a>
          </Button>
        </nav>
      </header>

      {attention.length === 0 ? null : (
        <section className="fleet-attention" aria-label="Needs attention" data-attention="">
          <span className="fleet-attention-title">Needs attention ({attention.length})</span>
          <div className="fleet-attention-list">
            {attention.map((item) => (
              <button
                key={item.id}
                type="button"
                className="fleet-attention-chip"
                data-tone={item.tone}
                onClick={() => handleAttentionClick(item)}
                title={`${item.label} — ${item.detail}`}
              >
                <span className="fleet-attention-label">{item.label}</span>
                <span className="fleet-attention-detail">{item.detail}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="fleet-section" aria-label="Projects at a Glance">
        <SectionHeader
          title="Projects at a Glance"
          actions={
            filters.project !== ALL ? (
              <Button variant="ghost" size="sm" onClick={() => tab.actions.filterProject(ALL)}>
                Showing {filters.project} · Clear
              </Button>
            ) : null
          }
        />
        {active._tag === "Pending" ? (
          <EmptyState title={active.title} />
        ) : projects.length === 0 ? (
          <EmptyState title="No active projects" />
        ) : (
          <div className="fleet-projects-grid">
            {projects.map((project) => (
              <ProjectCard
                key={project.project}
                project={project}
                selected={filters.project === project.project}
                onToggle={() => toggleProject(project)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="fleet-section" id="fleet-sessions" aria-label="Sessions">
        <SectionHeader
          title="Sessions"
          actions={
            <div className="fleet-section-actions">
              {active._tag === "Rows" ? (
                <span className="fleet-count-caption">
                  Showing {filteredSessions.length} of {allSessions.length}
                </span>
              ) : null}
              {hasNonDefaultFilters ? (
                <Button variant="ghost" size="sm" onClick={() => tab.actions.resetFilters()}>
                  Reset filters
                </Button>
              ) : null}
            </div>
          }
        />

        <div className="fleet-toolbar" role="group" aria-label="Session filters">
          <SegmentedControl
            aria-label="Session state filter"
            size="sm"
            value={filters.status}
            options={statusOptions}
            onValueChange={(value) => tab.actions.filterStatus(value as SessionStatusFilter)}
          />
          <div className="fleet-toolbar-controls">
            <Input
              type="search"
              className="fleet-search"
              aria-label="Search sessions"
              placeholder="Search project, summary, model, account, host, transcript..."
              value={filters.query}
              onChange={(e) => tab.actions.filterQuery(e.target.value)}
            />
            <label className="fleet-select-field">
              <span>Project</span>
              <select
                className="fleet-select"
                aria-label="Project filter"
                value={filters.project}
                onChange={(e) => tab.actions.filterProject(e.target.value)}
              >
                <option value={ALL}>All projects</option>
                {projects.map((p) => (
                  <option key={p.project} value={p.project}>{p.project}</option>
                ))}
              </select>
            </label>
            <label className="fleet-select-field">
              <span>Host</span>
              <select
                className="fleet-select"
                aria-label="Host filter"
                value={filters.host}
                onChange={(e) => tab.actions.filterHost(e.target.value)}
              >
                <option value={ALL}>All hosts</option>
                {hostRows.map((h) => (
                  <option key={h.nodeId} value={h.nodeId}>{h.name}</option>
                ))}
              </select>
            </label>
            <label className="fleet-select-field">
              <span>Harness</span>
              <select
                className="fleet-select"
                aria-label="Harness filter"
                value={filters.harness}
                onChange={(e) => tab.actions.filterHarness(e.target.value)}
              >
                <option value={ALL}>All harnesses</option>
                {harnessesOf(allSessions).map((each) => (
                  <option key={each.harness} value={each.harness}>{each.harness}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="fleet-sessions-layout" data-inspector-open={selectedSession !== undefined ? "" : undefined}>
          <div className="fleet-sessions-main">
            {active._tag === "Pending" ? (
              <EmptyState title={active.title} />
            ) : filteredSessions.length === 0 ? (
              <EmptyState
                title={allSessions.length === 0 ? SESSION_WORDS.empty : "No sessions match the current filters"}
              />
            ) : (
              <Table className="fleet-runs fleet-sessions-table" aria-label="Active sessions">
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead>Harness / Model</TableHead>
                    <TableHead className="fleet-wide">Account</TableHead>
                    <TableHead className="fleet-wide">Host</TableHead>
                    <TableHead className="fleet-wide">Tokens / Time</TableHead>
                    <TableHead className="fleet-wide">Activity</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSessions.map((s) => {
                    const isSelected = filters.selectedSessionKey === s.sessionKey
                    const hostLabel = hostNames.get(s.nodeId) ?? s.nodeId
                    return (
                      <TableRow
                        key={s.sessionKey}
                        data-session={s.sessionKey}
                        data-selected={isSelected ? "" : undefined}
                        aria-selected={isSelected}
                        tabIndex={0}
                        className="fleet-clickable-row"
                        onClick={() => tab.actions.selectSession(isSelected ? null : s.sessionKey)}
                        onKeyDown={(event) => onSessionRowKeyDown(event, s.sessionKey)}
                      >
                        <TableCell>
                          <div className="fleet-cell-stack">
                            <span className="fleet-cell-primary">{s.project}</span>
                            {s.lane !== null && s.lane !== s.project ? (
                              <span className="fleet-cell-secondary">{s.lane}</span>
                            ) : null}
                            {s.managed ? (
                              <span className="fleet-cell-tag">Managed</span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="fleet-label fleet-summary-cell">
                          <div className="fleet-cell-stack">
                            <span className="fleet-cell-primary fleet-summary-text">{s.summary}</span>
                            {s.transcript.length > 0 ? (
                              <span className="fleet-transcript-pill">
                                {s.transcript.length} {s.transcript.length === 1 ? "turn" : "turns"}
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="fleet-cell-stack">
                            <span className="fleet-cell-primary">{s.harness}</span>
                            {s.model !== "-" ? <span className="fleet-cell-secondary">{s.model}</span> : null}
                          </div>
                        </TableCell>
                        <TableCell className="fleet-wide">{s.account}</TableCell>
                        <TableCell className="fleet-wide">{hostLabel}</TableCell>
                        <TableCell className="fleet-wide fleet-number">{formatTokensAndTime(s)}</TableCell>
                        <TableCell className="fleet-wide fleet-number">
                          {s.lastMs === null ? "-" : <RelativeTime ts={s.lastMs} />}
                        </TableCell>
                        <TableCell>
                          <Pill tone={s.tone}>{s.statusWord}</Pill>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          {selectedSession === undefined ? null : (
            <SessionDrawer
              session={selectedSession}
              hostName={hostNames.get(selectedSession.nodeId) ?? selectedSession.nodeId}
              onClose={() => tab.actions.selectSession(null)}
            />
          )}
        </div>
      </section>

      <section className="fleet-section" id="fleet-hosts" aria-label="Hosts">
        <SectionHeader
          title="Hosts"
          actions={
            filters.host !== ALL ? (
              <Button variant="ghost" size="sm" onClick={() => tab.actions.filterHost(ALL)}>
                Filtered: {hostNames.get(filters.host) ?? filters.host} · Clear
              </Button>
            ) : null
          }
        />
        {hosts._tag !== "Rows" ? <EmptyState title={hosts.title} /> : (
          <Table className="fleet-machines" aria-label="Hosts">
            <TableHeader>
              <TableRow>
                <TableHead>Host</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead className="fleet-wide">Load</TableHead>
                <TableHead className="fleet-wide">Memory</TableHead>
                <TableHead className="fleet-wide">Disk</TableHead>
                <TableHead className="fleet-wide">Seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hostRows.map((h) => {
                const isSelected = filters.host === h.nodeId
                return (
                  <TableRow
                    key={h.nodeId}
                    data-node={h.nodeId}
                    data-selected={isSelected ? "" : undefined}
                    aria-selected={isSelected}
                    tabIndex={0}
                    className="fleet-clickable-row"
                    onClick={() => toggleHost(h.nodeId)}
                    onKeyDown={(event) => onHostRowKeyDown(event, h.nodeId)}
                  >
                    <TableCell className="fleet-cell-primary">{h.name}</TableCell>
                    <TableCell>{h.kind}</TableCell>
                    <TableCell><Pill tone={h.tone}>{h.stateWord}</Pill></TableCell>
                    <TableCell className="fleet-number">{h.activeSessions}</TableCell>
                    <TableCell className="fleet-wide fleet-number">{h.load}</TableCell>
                    <TableCell className="fleet-wide fleet-number">{h.memory}</TableCell>
                    <TableCell className="fleet-wide fleet-number">{h.disk}</TableCell>
                    <TableCell className="fleet-wide fleet-number">
                      {h.seenMs === null ? "-" : <RelativeTime ts={h.seenMs} />}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="fleet-section" id="fleet-accounts" aria-label="Accounts">
        <SectionHeader title="Accounts" />
        {accountsShown._tag !== "Rows" ? <EmptyState title={accountsShown.title} /> : (
          <Table className="fleet-accounts" aria-label="Accounts">
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>5h</TableHead>
                <TableHead>Weekly</TableHead>
                <TableHead className="fleet-wide">Scoped</TableHead>
                <TableHead className="fleet-wide">Resets</TableHead>
                <TableHead className="fleet-wide">Credits</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accountRows.map((a) => (
                <TableRow key={a.accountKey} data-account={a.accountKey}>
                  <TableCell>{a.provider}</TableCell>
                  <TableCell className="fleet-cell-primary">{a.label}</TableCell>
                  <TableCell>{a.plan}</TableCell>
                  <TableCell className="fleet-number">{a.fiveHour}</TableCell>
                  <TableCell className="fleet-number">{a.weekly}</TableCell>
                  <TableCell className="fleet-wide fleet-number">{a.scoped}</TableCell>
                  <TableCell className="fleet-wide fleet-number">
                    {a.resetsMs === null ? "-" : <RelativeTime ts={a.resetsMs} />}
                  </TableCell>
                  <TableCell className="fleet-wide fleet-number">{a.credits}</TableCell>
                  <TableCell className="fleet-number">{a.activeSessions}</TableCell>
                  <TableCell><Pill tone={a.tone}>{a.statusWord}</Pill></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  )
}
