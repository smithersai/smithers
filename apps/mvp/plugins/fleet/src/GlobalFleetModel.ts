/**
 * Pure view-model projections for `/app/fleet` (Projects, Needs Attention,
 * Observed Sessions + Live Transcripts, Hosts, Provider Accounts) synced via
 * ElectricSQL into TanStack DB.
 */

import type { HostNode, ObservedSession, ProviderAccount } from "../../../src/features/fleet/globalSchema"
import { redactSecrets } from "../../../src/features/fleet/scrub"
import { durationOf, tokensOf, type Tone, UNREACHABLE_MS } from "./model"
import type { Rows } from "./tab"

/**
 * `ObservedSession` extended with the optional rich-telemetry columns synced from
 * `observed_sessions` (`project`, `summary`, `cwd`, `transcriptJson`) so the
 * projection remains type-safe across schema versions.
 */
export type ObservedSessionInput = Omit<ObservedSession, "project" | "summary" | "cwd" | "transcriptJson"> & {
  readonly project?: string | null
  readonly summary?: string | null
  readonly cwd?: string | null
  readonly transcriptJson?: unknown
}

export type TranscriptRole = "user" | "assistant" | "tool" | "system"

export interface TranscriptEntry {
  readonly ts: string | null
  readonly tsMs: number | null
  readonly role: TranscriptRole
  readonly label: string | null
  readonly text: string
}

export interface RepoSlug {
  readonly owner: string
  readonly repo: string
  readonly basePath: string
}

export interface HostRow {
  readonly nodeId: string
  readonly name: string
  readonly kind: string
  readonly stateWord: string
  readonly tone: Tone
  readonly online: boolean
  readonly load: string
  readonly memory: string
  readonly disk: string
  readonly diskFreeGb: number | null
  readonly diskLow: boolean
  readonly activeSessions: number
  readonly runnerCapacity: number
  readonly version: string
  readonly seenMs: number | null
}

export interface SessionRow {
  readonly sessionKey: string
  readonly nodeId: string
  readonly harness: string
  readonly managed: boolean
  readonly model: string
  readonly account: string
  readonly project: string
  readonly repoSlug: RepoSlug | null
  readonly lane: string | null
  readonly repoOrLane: string
  readonly title: string
  readonly summary: string
  readonly rawSummary: string | null
  readonly cwd: string | null
  readonly status: ObservedSession["status"]
  readonly statusWord: string
  readonly tone: Tone
  readonly duration: string
  readonly startedMs: number | null
  readonly lastMs: number | null
  readonly pid: number | null
  readonly cpuSeconds: number | null
  readonly tokensUsed: number | null
  readonly tokens: string
  readonly tokensCompact: string
  readonly transcript: ReadonlyArray<TranscriptEntry>
}

export interface AccountRow {
  readonly accountKey: string
  readonly provider: string
  readonly label: string
  readonly plan: string
  readonly rawStatus: ProviderAccount["status"]
  readonly creditDanger: boolean
  readonly statusWord: string
  readonly tone: Tone
  readonly fiveHour: string
  readonly weekly: string
  readonly scoped: string
  readonly resetsMs: number | null
  readonly credits: string
  readonly activeSessions: number
  readonly pools: string
  readonly note: string
}

export interface GlobalSummary {
  readonly onlineHosts: number
  readonly totalHosts: number
  readonly activeSessions: number
  /** Active sessions by the harness each row reported, by name: the labels are the data's, never the app's. */
  readonly harnesses: ReadonlyArray<HarnessCount>
  readonly readyAccounts: number
  readonly totalAccounts: number
  readonly alertsCount: number
}

export interface HarnessCount {
  readonly harness: string
  readonly sessions: number
}

export interface ProjectSummary {
  readonly project: string
  readonly repoSlug: RepoSlug | null
  readonly workingCount: number
  readonly waitingCount: number
  readonly idleCount: number
  readonly errorCount: number
  readonly activeCount: number
  readonly totalCount: number
  readonly managedCount: number
  readonly harnesses: ReadonlyArray<HarnessCount>
  readonly topSummary: string
  readonly lastMs: number | null
}

export type SessionStatusFilter = "active" | "working" | "waiting" | "idle" | "error" | "all"

/** Which sessions the table shows and which session (if any) is open in the inspector. */
export interface SessionFilters {
  readonly host: string
  readonly harness: string
  readonly project: string
  readonly status: SessionStatusFilter
  readonly query: string
  readonly selectedSessionKey: string | null
}

/** Partial filter input accepted by `filterSessions` for callers specifying a subset of facets. */
export type SessionFilterInput = Pick<SessionFilters, "host" | "harness"> & Partial<SessionFilters>

export interface StatusCounts {
  readonly active: number
  readonly working: number
  readonly waiting: number
  readonly idle: number
  readonly error: number
  readonly all: number
}

export type AttentionKind =
  | "host-offline"
  | "host-disk"
  | "account-auth"
  | "account-limit"
  | "session-error"
  | "session-waiting"

export type AttentionAction =
  | { readonly _tag: "FilterHost"; readonly nodeId: string }
  | { readonly _tag: "SelectSession"; readonly sessionKey: string; readonly status: SessionStatusFilter }
  | { readonly _tag: "FocusAccounts"; readonly accountKey: string }

export interface AttentionItem {
  readonly id: string
  readonly kind: AttentionKind
  readonly tone: "bad" | "warn"
  readonly label: string
  readonly detail: string
  readonly action: AttentionAction
}

/** The filter value that keeps every row. */
export const ALL = "all"

/** The smart default status filter: active sessions (`working`, `waiting`, `error`, `stalled`), excluding `idle`. */
export const ACTIVE_STATUS: SessionStatusFilter = "active"

/** Fallback canonical project when neither `project` nor `repo` was reported. */
export const UNASSIGNED_PROJECT = "Unassigned"

/** Default filters for `/app/fleet`. */
export const DEFAULT_SESSION_FILTERS: SessionFilters = {
  host: ALL,
  harness: ALL,
  project: ALL,
  status: ACTIVE_STATUS,
  query: "",
  selectedSessionKey: null,
}

/**
 * What one part of the view draws: `Pending` while its source hasn't delivered a first snapshot or is withheld, so
 * nothing is known; `Empty` only when a delivered snapshot holds no rows; else its rows.
 */
export type Section<A> =
  | { readonly _tag: "Pending"; readonly title: string }
  | { readonly _tag: "Empty"; readonly title: string }
  | { readonly _tag: "Rows"; readonly rows: ReadonlyArray<A> }

/** The words a part shows for each state that isn't rows. */
export interface SectionWords {
  readonly loading: string
  readonly unavailable: string
  readonly empty: string
}

/** `source` as the view draws it: only a delivered snapshot may say there is nothing. */
export function sectionOf<A, B>(
  source: Rows<A>,
  words: SectionWords,
  project: (rows: ReadonlyArray<A>) => ReadonlyArray<B>,
): Section<B> {
  if (source._tag === "Loading") return { _tag: "Pending", title: words.loading }
  if (source._tag === "Refused") return { _tag: "Pending", title: words.unavailable }
  const rows = project(source.rows)
  return rows.length === 0 ? { _tag: "Empty", title: words.empty } : { _tag: "Rows", rows }
}

/** The rows of a part, none unless it has some. */
export const rowsOf = <A>(section: Section<A>): ReadonlyArray<A> => section._tag === "Rows" ? section.rows : []

function parseMs(iso: string | null | undefined): number | null {
  if (iso === undefined || iso === null) return null
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : null
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/

/** Parses a canonical `owner/repo` project string into Smithers route segments. */
export function parseRepoSlug(project: string | null | undefined): RepoSlug | null {
  const trimmed = nonEmpty(project)
  if (trimmed === null) return null
  const parts = trimmed.split("/")
  if (parts.length !== 2) return null
  const [owner, repo] = parts
  if (owner === undefined || repo === undefined) return null
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return null
  return {
    owner,
    repo,
    basePath: `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  }
}

const LOW_DISK_FREE_GB = 20

const TRANSCRIPT_ROLES: Readonly<Record<string, TranscriptRole>> = {
  user: "user",
  assistant: "assistant",
  tool: "tool",
  system: "system",
}

/**
 * Defensively parses `transcriptJson` whether ElectricSQL delivered an already-parsed
 * array, a raw JSON string, or `null` / `undefined`.
 */
export function parseTranscript(raw: unknown): ReadonlyArray<TranscriptEntry> {
  if (raw === null || raw === undefined) return []
  let value: unknown = raw
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return []
    try {
      value = JSON.parse(trimmed)
    } catch {
      // expected: malformed transcript json returns empty list
      return []
    }
  }
  if (!Array.isArray(value)) return []
  const entries: Array<TranscriptEntry> = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    // Electric delivers the column as stored: a row written before a redaction rule existed is shown through it.
    const rawText = typeof record.text === "string" ? redactSecrets(record.text) : ""
    const label = typeof record.label === "string" ? nonEmpty(redactSecrets(record.label)) : null
    if (rawText.trim().length === 0 && label === null) continue
    const rawRole = typeof record.role === "string" ? record.role.toLowerCase() : "system"
    const role: TranscriptRole = Object.hasOwn(TRANSCRIPT_ROLES, rawRole) ? TRANSCRIPT_ROLES[rawRole]! : "system"
    const ts = typeof record.ts === "string" ? nonEmpty(record.ts) : null
    entries.push({
      ts,
      tsMs: parseMs(ts),
      role,
      label,
      text: rawText,
    })
  }
  return entries
}

/** Whether a session status is considered active (excludes `idle` and `ended`). */
export function isActiveStatus(status: ObservedSession["status"]): boolean {
  return status === "working" || status === "waiting" || status === "error" || status === "stalled"
}

/** The harnesses the sessions reported, each once, by name. */
export function harnessesOf(sessions: ReadonlyArray<SessionRow>): ReadonlyArray<HarnessCount> {
  const counts = new Map<string, number>()
  for (const session of sessions) counts.set(session.harness, (counts.get(session.harness) ?? 0) + 1)
  return [...counts]
    .map(([harness, count]) => ({ harness, sessions: count }))
    .sort((a, b) => a.harness.localeCompare(b.harness))
}

/** Counts of sessions by status filter bucket. */
export function statusCountsOf(sessions: ReadonlyArray<SessionRow>): StatusCounts {
  let working = 0
  let waiting = 0
  let idle = 0
  let error = 0
  for (const s of sessions) {
    if (s.status === "working") working++
    else if (s.status === "waiting") waiting++
    else if (s.status === "idle") idle++
    else if (s.status === "error" || s.status === "stalled") error++
  }
  return {
    active: working + waiting + error,
    working,
    waiting,
    idle,
    error,
    all: sessions.length,
  }
}

function matchesStatus(session: SessionRow, status: SessionStatusFilter): boolean {
  switch (status) {
    case "all":
      return true
    case "active":
      return isActiveStatus(session.status)
    case "working":
      return session.status === "working"
    case "waiting":
      return session.status === "waiting"
    case "idle":
      return session.status === "idle"
    case "error":
      return session.status === "error" || session.status === "stalled"
  }
}

function matchesQuery(session: SessionRow, terms: ReadonlyArray<string>, hostName: string | undefined): boolean {
  if (terms.length === 0) return true
  const fields = [
    session.project,
    session.repoOrLane,
    session.lane ?? "",
    session.summary,
    session.title,
    session.model,
    session.account,
    session.nodeId,
    hostName ?? "",
    session.harness,
    session.cwd ?? "",
  ].map((f) => f.toLowerCase())

  return terms.every((term) => {
    if (fields.some((field) => field.includes(term))) return true
    return session.transcript.some(
      (entry) =>
        entry.text.toLowerCase().includes(term) ||
        (entry.label !== null && entry.label.toLowerCase().includes(term)),
    )
  })
}

/** The sessions `filters` keeps. */
export function filterSessions(
  sessions: ReadonlyArray<SessionRow>,
  filters: SessionFilterInput,
  hostNames?: ReadonlyMap<string, string>,
): ReadonlyArray<SessionRow> {
  const project = filters.project ?? ALL
  const status = filters.status ?? ACTIVE_STATUS
  const query = (filters.query ?? "").trim().toLowerCase()
  const terms = query.length === 0 ? [] : query.split(/\s+/).filter((t) => t.length > 0)

  return sessions.filter((s) =>
    (filters.host === ALL || s.nodeId === filters.host) &&
    (filters.harness === ALL || s.harness === filters.harness) &&
    (project === ALL || s.project === project) &&
    matchesStatus(s, status) &&
    matchesQuery(s, terms, hostNames?.get(s.nodeId))
  )
}

/** Looks up the currently selected session row by key. */
export function selectedSessionOf(
  sessions: ReadonlyArray<SessionRow>,
  selectedSessionKey: string | null,
): SessionRow | undefined {
  if (selectedSessionKey === null) return undefined
  return sessions.find((s) => s.sessionKey === selectedSessionKey)
}

/** Groups sessions by canonical project, sorted by working and active session count descending. */
export function projectsOf(sessions: ReadonlyArray<SessionRow>): ReadonlyArray<ProjectSummary> {
  const grouped = new Map<string, Array<SessionRow>>()
  for (const s of sessions) {
    const list = grouped.get(s.project)
    if (list === undefined) grouped.set(s.project, [s])
    else list.push(s)
  }

  const summaries: Array<ProjectSummary> = []
  for (const [project, list] of grouped) {
    let workingCount = 0
    let waitingCount = 0
    let idleCount = 0
    let errorCount = 0
    let managedCount = 0
    let lastMs: number | null = null
    const harnessCounts = new Map<string, number>()

    for (const s of list) {
      if (s.status === "working") workingCount++
      else if (s.status === "waiting") waitingCount++
      else if (s.status === "idle") idleCount++
      else if (s.status === "error" || s.status === "stalled") errorCount++
      if (s.managed) managedCount++
      if (s.lastMs !== null && (lastMs === null || s.lastMs > lastMs)) lastMs = s.lastMs
      harnessCounts.set(s.harness, (harnessCounts.get(s.harness) ?? 0) + 1)
    }

    const harnesses = [...harnessCounts]
      .map(([harness, count]) => ({ harness, sessions: count }))
      .sort((a, b) => b.sessions - a.sessions || a.harness.localeCompare(b.harness))

    const activeFirst = list.find((s) => isActiveStatus(s.status) && s.summary !== "-")
    const anySummary = list.find((s) => s.summary !== "-")
    const topSummary = activeFirst?.summary ?? anySummary?.summary ?? "-"

    summaries.push({
      project,
      repoSlug: parseRepoSlug(project),
      workingCount,
      waitingCount,
      idleCount,
      errorCount,
      activeCount: workingCount + waitingCount + errorCount,
      totalCount: list.length,
      managedCount,
      harnesses,
      topSummary,
      lastMs,
    })
  }

  return summaries.sort((a, b) =>
    b.workingCount - a.workingCount ||
    b.activeCount - a.activeCount ||
    b.totalCount - a.totalCount ||
    (b.lastMs ?? -1) - (a.lastMs ?? -1) ||
    a.project.localeCompare(b.project)
  )
}

/** Actionable attention items surfaced right under the summary bar. */
export function attentionItemsOf(
  hosts: ReadonlyArray<HostRow>,
  sessions: ReadonlyArray<SessionRow>,
  accounts: ReadonlyArray<AccountRow>,
): ReadonlyArray<AttentionItem> {
  const items: Array<AttentionItem> = []

  for (const h of hosts) {
    if (!h.online) {
      items.push({
        id: `host-offline:${h.nodeId}`,
        kind: "host-offline",
        tone: "bad",
        label: `${h.name} offline`,
        detail: h.kind,
        action: { _tag: "FilterHost", nodeId: h.nodeId },
      })
    } else if (h.diskLow) {
      items.push({
        id: `host-disk:${h.nodeId}`,
        kind: "host-disk",
        tone: "warn",
        label: `${h.name} low disk`,
        detail: h.disk,
        action: { _tag: "FilterHost", nodeId: h.nodeId },
      })
    }
  }

  for (const a of accounts) {
    if (a.rawStatus === "auth_expired") {
      items.push({
        id: `account-auth:${a.accountKey}`,
        kind: "account-auth",
        tone: "bad",
        label: `${a.label} auth expired`,
        detail: a.provider,
        action: { _tag: "FocusAccounts", accountKey: a.accountKey },
      })
    } else if (a.rawStatus === "limit_reached") {
      items.push({
        id: `account-limit:${a.accountKey}`,
        kind: "account-limit",
        tone: "bad",
        label: `${a.label} at limit`,
        detail: a.provider,
        action: { _tag: "FocusAccounts", accountKey: a.accountKey },
      })
    }
  }

  for (const s of sessions) {
    if (s.status === "error" || s.status === "stalled") {
      items.push({
        id: `session-error:${s.sessionKey}`,
        kind: "session-error",
        tone: "bad",
        label: `${s.project} · ${s.statusWord.toLowerCase()}`,
        detail: s.summary !== "-" ? s.summary : s.harness,
        action: { _tag: "SelectSession", sessionKey: s.sessionKey, status: "error" },
      })
    }
  }

  for (const s of sessions) {
    if (s.status === "waiting") {
      items.push({
        id: `session-waiting:${s.sessionKey}`,
        kind: "session-waiting",
        tone: "warn",
        label: `${s.project} · waiting`,
        detail: s.summary !== "-" ? s.summary : s.harness,
        action: { _tag: "SelectSession", sessionKey: s.sessionKey, status: "waiting" },
      })
    }
  }

  return items
}

function compactDuration(duration: string): string {
  const match = /^0h(\d{2})m$/.exec(duration)
  if (match === null) return duration
  const mins = Number(match[1])
  return mins === 0 ? "<1m" : `${mins}m`
}

/** Compact combined `tokens · duration` string for the sessions table. */
export function formatTokensAndTime(session: Pick<SessionRow, "tokensCompact" | "duration">): string {
  const time = session.duration === "-" ? "-" : compactDuration(session.duration)
  if (session.tokensCompact !== "-" && time !== "-") {
    return `${session.tokensCompact} · ${time}`
  }
  if (session.tokensCompact !== "-") return session.tokensCompact
  if (time !== "-") return time
  return "-"
}

/** Formats CPU seconds cleanly for the telemetry grid. */
export function formatCpuSeconds(cpuSeconds: number | null): string {
  if (cpuSeconds === null || !Number.isFinite(cpuSeconds)) return "-"
  if (cpuSeconds < 60) return `${cpuSeconds.toFixed(1)}s`
  return `${(cpuSeconds / 60).toFixed(1)}m`
}

export function hostRowsOf(nodes: ReadonlyArray<HostNode>, nowMs: number): ReadonlyArray<HostRow> {
  return nodes.map((n) => {
    const seenMs = parseMs(n.seenAt)
    const reachable = n.online && seenMs !== null && nowMs - seenMs <= UNREACHABLE_MS * 3
    const diskLow = n.diskFreeGb !== null && n.diskFreeGb < LOW_DISK_FREE_GB
    const stateWord = !reachable
      ? "Offline"
      : n.held !== null
      ? `Held · ${n.held}`
      : diskLow
      ? "Low disk"
      : "Online"
    const tone: Tone = !reachable ? "bad" : n.held !== null || diskLow ? "warn" : "ok"
    return {
      nodeId: n.nodeId,
      name: n.name,
      kind: n.kind,
      stateWord,
      tone,
      online: reachable,
      load: n.load1 === null ? "-" : n.cpuCores === null ? n.load1.toFixed(1) : `${n.load1.toFixed(1)}/${n.cpuCores}c`,
      memory: n.memUsedGb !== null && n.memTotalGb !== null ? `${n.memUsedGb.toFixed(0)}/${n.memTotalGb.toFixed(0)}G` : "-",
      disk: n.diskFreeGb === null ? "-" : `${Math.round(n.diskFreeGb)}G free`,
      diskFreeGb: n.diskFreeGb,
      diskLow,
      activeSessions: n.activeSessions,
      runnerCapacity: n.runnerCapacity,
      version: n.version ?? "-",
      seenMs,
    }
  })
}

const SESSION_TONE: Readonly<Record<string, { readonly word: string; readonly tone: Tone; readonly rank: number }>> = {
  working: { word: "Working", tone: "run", rank: 0 },
  waiting: { word: "Waiting", tone: "warn", rank: 1 },
  error: { word: "Error", tone: "bad", rank: 2 },
  stalled: { word: "Stalled", tone: "bad", rank: 3 },
  idle: { word: "Idle", tone: "muted", rank: 4 },
  ended: { word: "Ended", tone: "muted", rank: 5 },
}

export function sessionRowsOf(
  sessions: ReadonlyArray<ObservedSessionInput>,
  nowMs: number,
  includeEnded: boolean = false,
): ReadonlyArray<SessionRow> {
  return sessions
    .filter((s) => includeEnded || s.status !== "ended")
    .map((s, index) => {
      const meta = Object.hasOwn(SESSION_TONE, s.status) ? SESSION_TONE[s.status]! : { word: s.status, tone: "muted" as const, rank: 6 }
      const startMs = parseMs(s.startedAt)
      const endMs = parseMs(s.endedAt)
      const lastMs = parseMs(s.lastActivityAt)
      const duration = startMs === null ? "-" : durationOf((endMs ?? nowMs) - startMs)
      const project = nonEmpty(s.project) ?? nonEmpty(s.repo) ?? UNASSIGNED_PROJECT
      const lane = nonEmpty(s.lane)
      const rawSummary = nonEmpty(s.summary)
      const title = nonEmpty(s.title) ?? "-"
      const summary = rawSummary ?? title
      const tokensCompact = s.tokensUsed === null ? "-" : tokensOf(s.tokensUsed)
      return {
        index,
        rank: meta.rank,
        row: {
          sessionKey: s.sessionKey,
          nodeId: s.nodeId,
          harness: s.harness,
          managed: s.managed,
          model: nonEmpty(s.model) ?? "-",
          account: nonEmpty(s.accountLabel) ?? "-",
          project,
          repoSlug: parseRepoSlug(project),
          lane,
          repoOrLane: lane ?? nonEmpty(s.repo) ?? "-",
          title,
          summary,
          rawSummary,
          cwd: nonEmpty(s.cwd),
          status: s.status,
          statusWord: meta.word,
          tone: meta.tone,
          duration,
          startedMs: startMs,
          lastMs,
          pid: s.pid,
          cpuSeconds: s.cpuSeconds,
          tokensUsed: s.tokensUsed,
          tokens: s.tokensUsed === null ? "-" : `${tokensCompact} tok`,
          tokensCompact,
          transcript: parseTranscript(s.transcriptJson),
        } satisfies SessionRow,
      }
    })
    .sort((a, b) =>
      a.rank - b.rank ||
      (b.row.lastMs ?? -1) - (a.row.lastMs ?? -1) ||
      a.index - b.index
    )
    .map((entry) => entry.row)
}

function pctOf(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)}%`
}

export function accountRowsOf(accounts: ReadonlyArray<ProviderAccount>): ReadonlyArray<AccountRow> {
  return accounts.map((a) => {
    const creditDanger = a.provider === "codex" && a.weeklyPct !== null && a.weeklyPct >= 95
    const statusWord = creditDanger
      ? "Credit risk"
      : a.status === "ready"
      ? "Ready"
      : a.status === "cooling"
      ? "Cooling"
      : a.status === "limit_reached"
      ? "At limit"
      : a.status === "auth_expired"
      ? "Auth expired"
      : "Unknown"
    const tone: Tone =
      creditDanger || a.status === "auth_expired" || a.status === "limit_reached"
        ? "bad"
        : a.status === "cooling"
        ? "warn"
        : a.status === "ready"
        ? "ok"
        : "muted"
    return {
      accountKey: a.accountKey,
      provider: a.provider,
      label: a.label,
      plan: a.plan ?? "-",
      rawStatus: a.status,
      creditDanger,
      statusWord,
      tone,
      fiveHour: pctOf(a.fiveHourPct),
      weekly: pctOf(a.weeklyPct),
      scoped: pctOf(a.scopedPct),
      resetsMs: parseMs(a.resetsAt),
      credits: a.creditsBalance === null ? "-" : String(Math.round(a.creditsBalance)),
      activeSessions: a.activeSessions,
      pools: a.pools.length === 0 ? "-" : a.pools.join(", "),
      note: a.coolReason ?? "-",
    }
  })
}

export function summarizeGlobal(
  hosts: ReadonlyArray<HostRow>,
  sessions: ReadonlyArray<SessionRow>,
  accounts: ReadonlyArray<AccountRow>,
): GlobalSummary {
  const onlineHosts = hosts.filter((h) => h.stateWord !== "Offline").length
  const readyAccounts = accounts.filter((a) => a.tone === "ok").length
  const alertsCount =
    hosts.filter((h) => h.tone === "bad" || h.diskLow).length +
    sessions.filter((s) => s.tone === "bad").length +
    accounts.filter((a) => a.tone === "bad").length
  return {
    onlineHosts,
    totalHosts: hosts.length,
    activeSessions: sessions.length,
    harnesses: harnessesOf(sessions),
    readyAccounts,
    totalAccounts: accounts.length,
    alertsCount,
  }
}

/**
 * The counts line, only once every source delivered a snapshot: a count over rows still loading or withheld would
 * read as hosts and sessions gone (Astra-D4-031).
 */
export function summaryOfGlobal(
  hosts: Section<HostRow>,
  sessions: Section<SessionRow>,
  accounts: Section<AccountRow>,
): GlobalSummary | undefined {
  if (hosts._tag === "Pending" || sessions._tag === "Pending" || accounts._tag === "Pending") return undefined
  return summarizeGlobal(rowsOf(hosts), rowsOf(sessions), rowsOf(accounts))
}
