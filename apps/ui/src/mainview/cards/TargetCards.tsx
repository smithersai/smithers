import { Badge, Button, Input, KpiStat, Skeleton, StatusPill } from "@smthrs/ui"
import type { TargetDetail, TargetRunState, TargetsViewMode } from "@smthrs/rpc/Cards"
import { TARGET_RUN_STATES, TARGETS_VIEW_MODES } from "@smthrs/rpc/Cards"
import type { RunRecord } from "@smthrs/rpc/TargetGraph"
import { Fragment, useMemo } from "react"
import type { KeyboardEvent, ReactNode } from "react"
import { timeLabel } from "../Timestamps"
import type { Card } from "../state/AppState"
import {
  durationLabel,
  filterRows,
  groupRows,
  groupSummary,
  kindsOf,
  patternRuns,
  pickedMembers,
  targetRows,
  viewMode,
  workspacesOf
} from "./TargetsTable"
import type { TargetRow } from "./TargetsTable"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { flowArgs } from "../flows/FlowArgs"

export const RepoCardBody = ({ card }: { readonly card: Extract<Card, { kind: "repo" }> }) => {
  const { repo } = card.payload
  return (
    <div className="repo-card">
      <p className="repo-card-path">{repo.path}</p>
      {repo.git !== null ?
        (
          <p className="repo-card-git">
            {repo.git.branch ?? "detached"}
            {repo.git.remote !== null ? ` · ${repo.git.remote}` : ""}
          </p>
        ) :
        null}
      <p className="repo-card-detection" data-detected={repo.smithers.detected}>
        {repo.smithers.reason}
      </p>
      {repo.warnings.length > 0 ?
        (
          <ul className="targets-card-warnings" role="alert">
            {repo.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
          </ul>
        ) :
        null}
    </div>
  )
}

const STATE_WORDS: Readonly<Record<TargetRunState, string>> = {
  never: "never run",
  passed: "passed",
  failed: "failed",
  running: "running"
}

const pillOf = (state: TargetRunState): string => (state === "passed" ? "done" : state)

const MODE_WORDS: Readonly<Record<TargetsViewMode, string>> = {
  featured: "Featured",
  all: "All",
  recent: "Recent"
}

/** The last-run cell: the pill and when, or the honest "never run". */
const LastRunCell = ({ row }: { readonly row: TargetRow }) => {
  if (row.lastRun === undefined) return <span className="targets-table-never">never run</span>
  return (
    <span className="targets-table-lastrun">
      <StatusPill status={pillOf(row.state)} />
      <span className="targets-table-when">{timeLabel(row.lastRun.startedAt)}</span>
    </span>
  )
}

/** The cache cell reads only facts the drawer already fetched; otherwise it says so. */
const cacheWord = (detail: TargetDetail | undefined): string => {
  if (detail === undefined || detail.status !== "done") return "unknown"
  const plan = detail.node?.plan
  if (plan?.cacheable === undefined) return "not planned"
  return plan.cacheable ? "cacheable" : "not cacheable"
}

/**
 * One target's facts, read on selection (docs/LOCAL-APP.md "Cards"): the
 * declaration site, the plan (mode, cache key, argv, sandbox, outputs, or the
 * planner's refusal), its deps and rdeps, and every recorded run rooted at
 * it. Everything here is the server's own answer; a fact it does not have
 * reads "not recorded", never a guess.
 */
const TargetDrawer = ({
  card,
  row,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "targets" }>
  readonly row: TargetRow
  readonly onRunCommand: RunCommand
}) => {
  const { repoId } = card.payload
  const { target } = row
  const detail = card.payload.details?.[target.label]
  const runs: ReadonlyArray<RunRecord> = (card.payload.runs ?? [])
    .filter((run) => run.label === target.label)
    .sort((left, right) => right.startedAt - left.startedAt)
  const node = detail?.node
  const plan = node?.plan
  const source = node?.source
  const fact = (name: string, value: ReactNode) => (
    <div className="graph-drawer-fact" key={name}>
      <span className="graph-drawer-fact-name">{name}</span>
      <span className="graph-drawer-fact-value">{value}</span>
    </div>
  )
  return (
    <aside
      className="targets-drawer"
      data-testid={`targets-drawer-${target.label}`}
      aria-label={`${target.label} details`}
    >
      <header className="graph-drawer-header">
        <span className="graph-drawer-label">{target.label}</span>
        <Button
          variant="ghost"
          size="icon"
          data-flow="target.select"
          aria-label="Close details"
          title="Close details"
          onClick={() => onRunCommand("target.select", flowArgs("target.select", { repoId }))}
        >
          ×
        </Button>
      </header>
      {fact("rule", target.target)}
      {fact("workspace", target.workspace)}
      {target.kinds.length > 0
        ? fact("kinds", target.kinds.map((kind) => <Badge key={kind} variant="outline">{kind}</Badge>))
        : null}
      {detail === undefined || detail.status === "pending"
        ? <Skeleton className="targets-drawer-skeleton" />
        : null}
      {detail?.status === "failed"
        ? (
          <p className="graph-drawer-refusal" role="alert">
            {detail.error ?? "The target's facts did not load."}
          </p>
        )
        : null}
      {source !== undefined
        ? fact(
          "source",
          <>
            <code className="graph-drawer-mono">
              {source.file}
              {source.line !== undefined ? `:${source.line}` : ""}
            </code>
            <Button
              variant="ghost"
              size="sm"
              data-flow="target.source.open"
              onClick={() =>
                onRunCommand(
                  "target.source.open",
                  `${repoId} ${source.file}${source.line !== undefined ? `:${source.line}` : ""}`
                )}
            >
              Open
            </Button>
          </>
        )
        : null}
      {plan?.mode !== undefined ? fact("mode", plan.mode) : null}
      {detail?.status === "done"
        ? fact("cache", plan?.cacheable === undefined ? "not planned" : plan.cacheable ? "cacheable" : "not cacheable")
        : null}
      {plan?.key !== undefined ? fact("key", <code className="graph-drawer-mono">{plan.key.slice(0, 16)}…</code>) : null}
      {plan?.refusal !== undefined
        ? (
          <p className="graph-drawer-refusal" role="alert">
            {plan.refusal}
          </p>
        )
        : null}
      {plan?.argv !== undefined && plan.argv.length > 0
        ? fact("argv", <code className="graph-drawer-mono graph-drawer-argv">{plan.argv.join(" ")}</code>)
        : null}
      {plan?.sandbox !== undefined ? fact("sandbox", plan.sandbox) : null}
      {plan?.outDirs !== undefined && plan.outDirs.length > 0
        ? fact("outputs", <code className="graph-drawer-mono">{[...plan.outDirs, ...plan.outFiles ?? []].join(", ")}</code>)
        : null}
      {detail?.status === "done"
        ? fact("deps", detail.deps !== undefined && detail.deps.length > 0 ? `${detail.deps.length}: ${detail.deps.join(", ")}` : "none")
        : null}
      {detail?.status === "done"
        ? fact("rdeps", detail.rdeps !== undefined && detail.rdeps.length > 0 ? `${detail.rdeps.length}: ${detail.rdeps.join(", ")}` : "none")
        : null}
      <section className="targets-drawer-runs" aria-label={`${target.label} run history`}>
        <h4 className="targets-drawer-heading">Runs</h4>
        {card.payload.runs === undefined
          ? <p className="smithers-card-note">History not read yet.</p>
          : runs.length === 0
          ? <p className="smithers-card-note">No recorded runs for this target.</p>
          : (
            <ul className="targets-drawer-run-list">
              {runs.map((run) => (
                <li key={run.runId} className="targets-drawer-run" data-run-row={run.runId}>
                  <StatusPill status={run.status} />
                  <span className="targets-table-when">{timeLabel(run.startedAt)}</span>
                  <span className="targets-table-when">
                    {run.endedAt !== undefined ? durationLabel(run.endedAt - run.startedAt) : "—"}
                    {run.exitCode !== undefined && run.exitCode !== null ? ` · exit ${run.exitCode}` : ""}
                  </span>
                  {run.summary !== undefined
                    ? <span className="targets-table-when">{run.summary.hit} hit / {run.summary.ran} ran / {run.summary.failed} failed</span>
                    : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    data-flow="target.runs.select"
                    onClick={() => onRunCommand("target.runs.select", `${repoId} ${run.runId}`)}
                  >
                    Replay
                  </Button>
                </li>
              ))}
            </ul>
          )}
      </section>
      <div className="graph-drawer-actions">
        {target.id !== undefined
          ? (
            <Button
              size="sm"
              data-flow="target.run"
              onClick={() => onRunCommand("target.run", `${repoId} ${target.workspace} ${target.label}`)}
            >
              Run
            </Button>
          )
          : null}
        <Button
          size="sm"
          variant="outline"
          data-flow="target.graph"
          onClick={() => onRunCommand("target.graph", `${repoId} ${target.label}`)}
        >
          Graph
        </Button>
        {row.state === "failed" && row.lastRun !== undefined
          ? (
            <Button
              size="sm"
              variant="ghost"
              data-flow="agent.explain"
              onClick={() =>
                onRunCommand(
                  "agent.explain",
                  `The target ${target.label} failed on its last run (${timeLabel(row.lastRun?.startedAt ?? 0)}${
                    row.lastRun?.exitCode !== undefined && row.lastRun?.exitCode !== null ? `, exit code ${row.lastRun.exitCode}` : ""
                  }). Explain what this target does and the likely reasons it fails.`
                )}
            >
              Explain
            </Button>
          )
          : null}
      </div>
    </aside>
  )
}

/**
 * The targets card (docs/LOCAL-APP.md "Cards"): the repository's targets as
 * a table that scrolls inside the card, its filters, each row's acts, and a
 * drawer with one target's facts. Filter and selection live in the card
 * payload (target.filter / target.select), so the component stays a
 * projection and the state survives a reload and an open-in-tab.
 */
export const TargetsCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "targets" }>
  readonly onRunCommand: RunCommand
}) => {
  const { repoId, repoName, status, targets, warnings, highlighted, view, runs, starred } = card.payload
  /* Copy rule (apps/DESIGN.md §9): the root workspace is the repository, never the "." path token. */
  const workspaceLabel = (workspace: string): string => (workspace === "." ? repoName : workspace)
  /*
   * The table is the expensive part of the card (a repository's targets run to
   * the hundreds), and it is a pure function of the payload — so it is derived
   * once per payload, not once per render of whatever else moved.
   */
  const flat = useMemo(() => targetRows(targets, runs, { starred }), [targets, runs, starred])
  const rows = useMemo(() => groupRows(flat, { starred }), [flat, starred])
  const mode = viewMode(view, rows)
  const strip = useMemo(() => patternRuns(targets), [targets])
  const shown = useMemo(() => filterRows(rows, view, mode), [rows, view, mode])
  const kinds = useMemo(() => kindsOf(targets), [targets])
  const workspaces = useMemo(() => workspacesOf(targets), [targets])
  const selectedRow = view?.selected === undefined ? undefined : flat.find((row) => row.target.label === view.selected)
  const expanded = new Set(view?.expanded ?? [])

  /* Arrow keys walk the rows; Enter opens the row's drawer. */
  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, label: string): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onRunCommand("target.select", flowArgs("target.select", { repoId, label }))
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    const body = event.currentTarget.parentElement
    if (body === null) return
    const rowsInDom = [...body.querySelectorAll<HTMLTableRowElement>("tr[data-target-row]")]
    const index = rowsInDom.indexOf(event.currentTarget)
    const next = event.key === "ArrowDown"
      ? rowsInDom[Math.min(index + 1, rowsInDom.length - 1)]
      : event.key === "ArrowUp"
      ? rowsInDom[Math.max(index - 1, 0)]
      : event.key === "Home"
      ? rowsInDom[0]
      : rowsInDom[rowsInDom.length - 1]
    next?.focus()
  }

  if (status === "pending") {
    return (
      <div className="targets-card" data-status="pending">
        <Skeleton className="targets-skeleton" />
        <Skeleton className="targets-skeleton" />
        <Skeleton className="targets-skeleton" />
        <p className="smithers-card-note">Loading targets…</p>
      </div>
    )
  }
  if (status === "failed") {
    return (
      <div className="targets-card" data-status="failed">
        <p className="sui-approval-error" role="alert">
          {warnings.length > 0 ? `Targets did not load: ${warnings.join("; ")}` : "Targets did not load."}
        </p>
      </div>
    )
  }
  if (targets.length === 0) {
    return (
      <div className="targets-card" data-status="empty">
        <p className="smithers-card-note">No targets declared in this repository.</p>
        {warnings.length > 0
          ? (
            <ul className="targets-card-warnings" role="alert">
              {warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
            </ul>
          )
          : null}
      </div>
    )
  }

  return (
    <div className="targets-card" data-status="done" data-testid={`targets-card-${repoId}`}>
      {warnings.length > 0
        ? (
          <ul className="targets-card-warnings" role="alert">
            {warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
          </ul>
        )
        : null}
      <div className="targets-toolbar" role="group" aria-label="Filter targets">
        <Input
          className="targets-search"
          type="search"
          placeholder="Filter by label or workspace"
          aria-label="Filter targets"
          value={view?.query ?? ""}
          data-flow="target.filter"
          data-testid="targets-filter-query"
          onChange={(event) => onRunCommand("target.filter", flowArgs("target.filter", { repoId, query: event.currentTarget.value }))}
        />
        {workspaces.length > 1
          ? (
            <select
              className="targets-workspace"
              aria-label="Workspace"
              data-flow="target.filter"
              data-testid="targets-filter-workspace"
              value={view?.workspace ?? "*"}
              onChange={(event) => onRunCommand("target.filter", flowArgs("target.filter", { repoId, workspace: event.currentTarget.value }))}
            >
              <option value="*">All workspaces</option>
              {workspaces.map((workspace) => <option key={workspace} value={workspace}>{workspaceLabel(workspace)}</option>)}
            </select>
          )
          : null}
        {/* The count is in TARGETS, so a grouped row counts every package it stands for. */}
        <span className="targets-count" data-testid="targets-count" aria-live="polite">
          {shown.reduce((sum, row) => sum + (row.group?.members.length ?? 1), 0)} of {targets.length}
        </span>
        <Button
          size="sm"
          variant="ghost"
          data-flow="target.history"
          data-testid="targets-history"
          onClick={() => onRunCommand("target.history", repoId)}
        >
          History
        </Button>
      </div>
      {/* The pattern runs the targets imply (`ci //...`): what "run everything" really is. */}
      {mode === "featured" && strip.length > 0 ?
        (
          <ul className="targets-pattern-runs" data-testid="targets-pattern-runs" aria-label="Featured runs">
            {strip.map((entry) => (
              <li key={entry.id} className="targets-pattern-run" data-pattern-run={entry.id}>
                <span className="targets-pattern-run-text">
                  <strong>{entry.title}</strong>
                  <span className="targets-card-label">{entry.verb} {entry.pattern}</span>
                  <span className="targets-card-type">{entry.summary}</span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  data-flow="target.run.pattern"
                  data-testid={`targets-run-pattern-${entry.id}`}
                  aria-label={`Run ${entry.verb} ${entry.pattern}`}
                  onClick={() => onRunCommand("target.run.pattern", `${repoId} ${entry.workspace} ${entry.verb} ${entry.pattern}`)}
                >
                  Run
                </Button>
              </li>
            ))}
          </ul>
        ) :
        null}
      <div className="targets-chips" data-testid="targets-modes" role="group" aria-label="View">
        {TARGETS_VIEW_MODES.map((candidate) => (
          <button
            type="button"
            key={candidate}
            className="targets-chip targets-mode"
            data-flow="target.filter"
            data-chip="mode"
            data-testid={`targets-mode-${candidate}`}
            aria-pressed={mode === candidate}
            onClick={() => onRunCommand("target.filter", flowArgs("target.filter", { repoId, mode: candidate }))}
          >
            {MODE_WORDS[candidate]}
          </button>
        ))}
      </div>
      <div className="targets-chips">
        {kinds.map((kind) => (
          <button
            type="button"
            key={kind}
            className="targets-chip"
            data-flow="target.filter"
            data-chip="kind"
            data-testid={`targets-chip-kind-${kind}`}
            aria-pressed={view?.kinds?.includes(kind) === true}
            onClick={() => onRunCommand("target.filter", flowArgs("target.filter", { repoId, kind }))}
          >
            {kind}
          </button>
        ))}
        <span className="targets-chips-divider" aria-hidden="true" />
        {TARGET_RUN_STATES.map((state) => (
          <button
            type="button"
            key={state}
            className="targets-chip"
            data-flow="target.filter"
            data-chip="state"
            data-testid={`targets-chip-state-${state}`}
            aria-pressed={view?.states?.includes(state) === true}
            onClick={() => onRunCommand("target.filter", flowArgs("target.filter", { repoId, state }))}
          >
            {STATE_WORDS[state]}
          </button>
        ))}
      </div>
      <div className="targets-body" data-drawer-open={selectedRow !== undefined}>
        <div className="targets-scroll" data-testid="targets-scroll">
          <table className="targets-table" aria-label="Targets">
            <thead>
              <tr>
                <th scope="col" className="targets-table-star-head">
                  <span className="sui-sr-only">Starred</span>
                </th>
                <th scope="col">Target</th>
                {workspaces.length > 1 ? <th scope="col">Workspace</th> : null}
                <th scope="col">Kinds</th>
                <th scope="col">Last run</th>
                <th scope="col">Cache</th>
                <th scope="col">
                  <span className="sui-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0
                ? (
                  <tr>
                    <td colSpan={7} className="targets-table-empty">
                      {mode === "featured"
                        ? "Nothing featured yet: star a target, or declare `featured: true` on one in PACKAGE.ts."
                        : mode === "recent"
                        ? "Nothing has run yet."
                        : "No targets match this filter."}
                    </td>
                  </tr>
                )
                : shown.flatMap((row) => {
                  const { target, group } = row
                  const selected = view?.selected === target.label
                  const isOpen = group !== undefined && expanded.has(group.label)
                  const picked = group === undefined ? [] : pickedMembers(group, view?.picked)
                  const pickedSet = new Set(picked.map((member) => member.target.label))
                  const star = (label: string, starredNow: boolean) => (
                    <button
                      type="button"
                      className="targets-star"
                      data-flow={starredNow ? "target.unstar" : "target.star"}
                      data-testid={`targets-star-${label}`}
                      aria-pressed={starredNow}
                      aria-label={starredNow ? `Unstar ${label}` : `Star ${label}`}
                      title={starredNow ? "Unstar" : "Star"}
                      onClick={() => onRunCommand(starredNow ? "target.unstar" : "target.star", `${repoId} ${label}`)}
                    >
                      {starredNow ? "★" : "☆"}
                    </button>
                  )
                  const head = (
                    <tr
                      key={`${target.workspace}:${target.label}`}
                      className="targets-table-row"
                      data-target-row={target.label}
                      data-workspace={target.workspace}
                      data-group={group === undefined ? undefined : group.name}
                      data-expanded={group === undefined ? undefined : isOpen}
                      data-highlighted={highlighted === target.label}
                      data-selected={selected}
                      data-state={row.state}
                      data-featured={row.featured}
                      data-starred={row.starred}
                      aria-selected={selected}
                      tabIndex={0}
                      onKeyDown={(event) => onRowKeyDown(event, target.label)}
                    >
                      <td className="targets-table-star">{star(target.label, row.starred)}</td>
                      <td className="targets-table-label">
                        {group === undefined
                          ? (
                            <button
                              type="button"
                              className="targets-table-select"
                              data-flow="target.select"
                              data-testid={`targets-select-${target.label}`}
                              aria-expanded={selected}
                              onClick={() => onRunCommand("target.select", flowArgs("target.select", selected ? { repoId } : { repoId, label: target.label }))}
                            >
                              <span className="targets-card-label">
                                {target.label}
                                {row.featured ? <Badge variant="outline" data-badge="featured">Featured</Badge> : null}
                              </span>
                              <span className="targets-card-type">{target.target}</span>
                              {target.summary !== undefined
                                ? <span className="targets-card-summary" data-testid={`targets-summary-${target.label}`}>{target.summary}</span>
                                : null}
                            </button>
                          )
                          : (
                            <button
                              type="button"
                              className="targets-table-select targets-group-toggle"
                              data-flow="target.expand"
                              data-testid={`targets-expand-${group.name}`}
                              aria-expanded={isOpen}
                              aria-label={`${isOpen ? "Collapse" : "Expand"} ${group.label}`}
                              onClick={() => onRunCommand("target.expand", `${repoId} ${group.label}`)}
                            >
                              <span className="targets-card-label">
                                <span className="targets-group-chevron" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                                {group.label}
                                <Badge variant="muted" data-badge="members">×{group.members.length}</Badge>
                                {row.featured ? <Badge variant="outline" data-badge="featured">Featured</Badge> : null}
                              </span>
                              <span className="targets-card-type">
                                {target.name} in {group.members.length} packages
                                {pickedSet.size !== group.members.length ? ` · ${pickedSet.size} picked` : ""}
                              </span>
                            </button>
                          )}
                      </td>
                      {workspaces.length > 1 ? <td className="targets-table-workspace">{workspaceLabel(target.workspace)}</td> : null}
                      <td>
                        <span className="targets-card-kinds">
                          {target.kinds.map((kind) => <Badge key={kind} variant="outline">{kind}</Badge>)}
                        </span>
                      </td>
                      <td>
                        {group === undefined
                          ? <LastRunCell row={row} />
                          : (
                            <span className="targets-table-lastrun" data-testid={`targets-group-summary-${group.name}`}>
                              {row.lastRun === undefined
                                ? <span className="targets-table-never">never run</span>
                                : <StatusPill status={pillOf(row.state)} />}
                              <span className="targets-table-when">{groupSummary(group.counts)}</span>
                            </span>
                          )}
                      </td>
                      <td className="targets-table-cache">
                        {group === undefined ? cacheWord(card.payload.details?.[target.label]) : "per package"}
                      </td>
                      <td className="targets-table-actions">
                        {group !== undefined
                          ? (
                            <Button
                              size="sm"
                              variant="outline"
                              data-flow="target.run.set"
                              data-testid={`targets-run-set-${group.name}`}
                              aria-label={`Run ${pickedSet.size} of ${group.members.length} ${group.name} targets`}
                              disabled={pickedSet.size === 0}
                              onClick={() => onRunCommand("target.run.set", `${repoId} ${group.label}`)}
                            >
                              Run {pickedSet.size === group.members.length ? "all" : pickedSet.size}
                            </Button>
                          )
                          : target.id === undefined ? null : (
                            <Button
                              size="sm"
                              variant="outline"
                              data-flow="target.run"
                              data-testid={`targets-run-${target.label}`}
                              aria-label={`Run ${target.label}`}
                              onClick={() => onRunCommand("target.run", `${repoId} ${target.workspace} ${target.label}`)}
                            >
                              Run
                            </Button>
                          )}
                        {group === undefined && row.lastRun !== undefined
                          ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              data-flow="target.timeline"
                              aria-label={`Timeline of the last run of ${target.label}`}
                              title="Timeline of the last run"
                              onClick={() => onRunCommand("target.timeline", `${repoId} ${row.lastRun?.runId ?? ""}`)}
                            >
                              Timeline
                            </Button>
                          )
                          : null}
                      </td>
                    </tr>
                  )
                  if (group === undefined || !isOpen) return [head]
                  /* The expanded group: a pick-all row, then one member row per package. */
                  const pickRow = (
                    <tr key={`${group.label}:pick`} className="targets-table-member targets-table-pick" data-group-pick={group.name}>
                      <td />
                      <td colSpan={5}>
                        <span className="targets-pick" role="group" aria-label={`Pick ${group.name} targets`}>
                          <button
                            type="button"
                            className="targets-chip"
                            data-flow="target.pick"
                            data-testid={`targets-pick-all-${group.name}`}
                            onClick={() => onRunCommand("target.pick", `${repoId} ${group.label} all`)}
                          >
                            all
                          </button>
                          <button
                            type="button"
                            className="targets-chip"
                            data-flow="target.pick"
                            data-testid={`targets-pick-none-${group.name}`}
                            onClick={() => onRunCommand("target.pick", `${repoId} ${group.label} none`)}
                          >
                            none
                          </button>
                          <span className="targets-count">{pickedSet.size} of {group.members.length} picked</span>
                        </span>
                      </td>
                    </tr>
                  )
                  const memberRows = group.members.map((member) => {
                    const memberSelected = view?.selected === member.target.label
                    const chosen = pickedSet.has(member.target.label)
                    return (
                      <tr
                        key={`${member.target.workspace}:${member.target.label}`}
                        className="targets-table-row targets-table-member"
                        data-target-row={member.target.label}
                        data-member-of={group.name}
                        data-workspace={member.target.workspace}
                        data-picked={chosen}
                        data-selected={memberSelected}
                        data-state={member.state}
                        data-featured={member.featured}
                        data-starred={member.starred}
                        aria-selected={memberSelected}
                        tabIndex={0}
                        onKeyDown={(event) => onRowKeyDown(event, member.target.label)}
                      >
                        <td className="targets-table-star">{star(member.target.label, member.starred)}</td>
                        <td className="targets-table-label targets-table-member-label">
                          <input
                            type="checkbox"
                            className="targets-pick-box"
                            data-flow="target.pick"
                            data-testid={`targets-pick-${member.target.label}`}
                            aria-label={`Pick ${member.target.label}`}
                            checked={chosen}
                            onChange={() => onRunCommand("target.pick", `${repoId} ${group.label} ${member.target.label}`)}
                          />
                          <button
                            type="button"
                            className="targets-table-select"
                            data-flow="target.select"
                            data-testid={`targets-select-${member.target.label}`}
                            aria-expanded={memberSelected}
                            onClick={() =>
                              onRunCommand("target.select", flowArgs("target.select", memberSelected ? { repoId } : { repoId, label: member.target.label }))}
                          >
                            <span className="targets-card-label">
                              {member.target.label}
                              {member.featured ? <Badge variant="outline" data-badge="featured">Featured</Badge> : null}
                            </span>
                            <span className="targets-card-type">{member.target.target}</span>
                            {member.target.summary !== undefined
                              ? (
                                <span className="targets-card-summary" data-testid={`targets-summary-${member.target.label}`}>
                                  {member.target.summary}
                                </span>
                              )
                              : null}
                          </button>
                        </td>
                        {workspaces.length > 1
                          ? <td className="targets-table-workspace">{workspaceLabel(member.target.workspace)}</td>
                          : null}
                        <td>
                          <span className="targets-card-kinds">
                            {member.target.kinds.map((kind) => <Badge key={kind} variant="outline">{kind}</Badge>)}
                          </span>
                        </td>
                        <td>
                          <LastRunCell row={member} />
                        </td>
                        <td className="targets-table-cache">{cacheWord(card.payload.details?.[member.target.label])}</td>
                        <td className="targets-table-actions">
                          {member.target.id === undefined ? null : (
                            <Button
                              size="sm"
                              variant="outline"
                              data-flow="target.run"
                              data-testid={`targets-run-${member.target.label}`}
                              aria-label={`Run ${member.target.label}`}
                              onClick={() =>
                                onRunCommand("target.run", `${repoId} ${member.target.workspace} ${member.target.label}`)}
                            >
                              Run
                            </Button>
                          )}
                          {member.lastRun !== undefined
                            ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                data-flow="target.timeline"
                                aria-label={`Timeline of the last run of ${member.target.label}`}
                                title="Timeline of the last run"
                                onClick={() => onRunCommand("target.timeline", `${repoId} ${member.lastRun?.runId ?? ""}`)}
                              >
                                Timeline
                              </Button>
                            )
                            : null}
                        </td>
                      </tr>
                    )
                  })
                  return [head, pickRow, ...memberRows]
                })}
            </tbody>
          </table>
        </div>
        {selectedRow !== undefined ? <TargetDrawer card={card} row={selectedRow} onRunCommand={onRunCommand} /> : null}
      </div>
    </div>
  )
}

/* The run card's per-target rows: failures first once the run settled, else executor order. */
const NODE_PILL: Readonly<Record<string, string>> = {
  pending: "pending",
  running: "running",
  hit: "done",
  ran: "done",
  failed: "failed",
  skipped: "skipped",
  refused: "failed",
  cancelled: "cancelled"
}

const NODE_WORDS: Readonly<Record<string, string>> = {
  pending: "pending",
  running: "running",
  hit: "cached",
  ran: "passed",
  failed: "failed",
  skipped: "skipped",
  refused: "refused",
  cancelled: "cancelled"
}

const isFailure = (status: string): boolean => status === "failed" || status === "refused"

const elapsedLabel = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)

export const TargetRunCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "target-run" }>
  /** Absent where the explain flow is not registered (the card then offers no Explain). */
  readonly onRunCommand?: RunCommand
}) => {
  const { label, status, exitCode, output, runId, repoId, verb, pattern, nodes = [], summary, nodeOutput = {}, startedAt, endedAt } =
    card.payload
  const settled = status !== "running"
  const rows = settled ? [...nodes].sort((left, right) => Number(isFailure(right.status)) - Number(isFailure(left.status))) : nodes
  const counts = summary ?? {
    hit: nodes.filter((node) => node.status === "hit").length,
    ran: nodes.filter((node) => node.status === "ran").length,
    failed: nodes.filter((node) => isFailure(node.status)).length,
    skipped: nodes.filter((node) => node.status === "skipped").length
  }
  const elapsed = summary?.durationMs ?? (startedAt === undefined ? undefined : (endedAt ?? Date.now()) - startedAt)
  const explainText = (target: string, detail: string): string =>
    JSON.stringify({
      kind: "target-failure",
      request: "Explain why this target failed and the most useful next step.",
      evidence: { repoId, runId, target, exitCode, output: detail.slice(-4_000) }
    })
  return (
    <div className="target-run-card" data-run-status={status}>
      <p className="target-run-meta" data-testid={`target-run-head-${card.id}`}>
        <span className="targets-card-label">{verb !== undefined && pattern !== undefined ? `${verb} ${pattern}` : label}</span>
        <Badge variant={status === "done" ? "success" : status === "failed" ? "destructive" : "outline"}>
          {status}{exitCode !== null ? ` · exit ${exitCode}` : ""}
        </Badge>
        {elapsed !== undefined ? <span className="target-run-elapsed">{elapsedLabel(elapsed)}</span> : null}
        {runId !== "" && onRunCommand !== undefined ?
          (
            <Button
              size="sm"
              variant="ghost"
              data-flow="target.timeline"
              data-testid={`target-run-timeline-${card.id}`}
              onClick={() => onRunCommand("target.timeline", `${repoId} ${runId}`)}
            >
              Timeline
            </Button>
          ) :
          null}
        {/* The Explainer (AgentRoles.ts) on a failed run: the last of the output, explained as an embedded card. */}
        {status === "failed" && onRunCommand !== undefined ?
          (
            <Button
              size="sm"
              variant="ghost"
              data-flow="agent.explain"
              data-testid={`target-run-explain-${card.id}`}
              onClick={() => onRunCommand("agent.explain", explainText(label, output))}
            >
              Explain
            </Button>
          ) :
          null}
      </p>
      {/* The totals lead: what hit the cache, what ran, what failed, what was skipped — live while the run streams. */}
      <div className="target-run-kpis" data-testid={`target-run-kpis-${card.id}`} role="group" aria-label="Run totals">
        <KpiStat label="Cached" value={counts.hit} data-kpi="hit" />
        <KpiStat label="Ran" value={counts.ran} data-kpi="ran" />
        <KpiStat label="Failed" value={counts.failed} data-kpi="failed" data-alert={counts.failed > 0} />
        <KpiStat label="Skipped" value={counts.skipped} data-kpi="skipped" />
      </div>
      {rows.length > 0 ?
        (
          <div className="target-run-scroll">
            <table className="targets-table target-run-table" aria-label="Targets of this run" data-testid={`target-run-table-${card.id}`}>
              <thead>
                <tr>
                  <th scope="col">Target</th>
                  <th scope="col">Rule</th>
                  <th scope="col">Status</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Cache</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((node) => {
                  const failed = isFailure(node.status)
                  const captured = nodeOutput[node.label] ?? ""
                  return (
                    <Fragment key={node.label}>
                      <tr
                        className="target-run-row"
                        data-run-row={node.label}
                        data-node-status={node.status}
                        data-testid={`target-run-row-${node.label}`}
                      >
                        <td className="targets-table-label">
                          {failed ?
                            (
                              <details className="target-run-failure">
                                <summary className="targets-card-label">{node.label}</summary>
                                <pre className="target-run-output target-run-failure-output">
                                  {captured !== "" ? captured : node.reason ?? "No output was attributed to this target; see Raw output."}
                                </pre>
                                {onRunCommand !== undefined ?
                                  (
                                    <span className="target-run-failure-acts">
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        data-flow="agent.explain"
                                        data-testid={`target-run-explain-node-${node.label}`}
                                        onClick={() =>
                                          onRunCommand("agent.explain", explainText(node.label, captured !== "" ? captured : output))}
                                      >
                                        Explain
                                      </Button>
                                      {runId !== "" ?
                                        (
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            data-flow="target.timeline"
                                            onClick={() => onRunCommand("target.timeline", `${repoId} ${runId}`)}
                                          >
                                            Timeline
                                          </Button>
                                        ) :
                                        null}
                                    </span>
                                  ) :
                                  null}
                              </details>
                            ) :
                            <span className="targets-card-label">{node.label}</span>}
                        </td>
                        <td className="targets-card-type">{node.rule ?? ""}</td>
                        <td>
                          <StatusPill status={NODE_PILL[node.status] ?? node.status} label={NODE_WORDS[node.status] ?? node.status} />
                        </td>
                        <td>{node.durationMs === undefined ? "" : elapsedLabel(node.durationMs)}</td>
                        <td className="targets-card-type">{node.status === "hit" ? "hit" : node.status === "ran" ? "miss" : ""}</td>
                      </tr>
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) :
        status === "running" ?
        <p className="targets-card-type">Waiting for the first target…</p> :
        null}
      {/* The stream itself stays reachable, folded away: the essentials are the rows above. */}
      <details className="target-run-raw" data-testid={`target-run-raw-${card.id}`}>
        <summary>Raw output</summary>
        <pre className="target-run-output" data-testid={`target-run-output-${card.id}`}>{output}</pre>
      </details>
    </div>
  )
}

/* Lane L3 (docs/LOCAL-APP.md "Cards"): the payload's own status leads. */
export const targetCardFamily: CardFamily<"repo" | "targets" | "target-run"> = {
  repo: { render: (card) => <RepoCardBody card={card} />, pill: settledPill },
  targets: {
    render: (card, actions) => <TargetsCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: (card) => card.payload.status
  },
  "target-run": {
    render: (card, actions) => <TargetRunCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: (card) => card.payload.status
  }
}
