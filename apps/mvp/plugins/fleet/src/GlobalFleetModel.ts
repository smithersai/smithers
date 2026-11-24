/**
 * Pure view-model projections for `/app/fleet` (Hosts, Observed Sessions,
 * Provider Accounts) synced via ElectricSQL into TanStack DB.
 */

import type { HostNode, ObservedSession, ProviderAccount } from "../../../src/features/fleet/globalSchema"
import { durationOf, tokensOf, type Tone, UNREACHABLE_MS } from "./model"
import type { Rows } from "./tab"

export interface HostRow {
  readonly nodeId: string
  readonly name: string
  readonly kind: string
  readonly stateWord: string
  readonly tone: Tone
  readonly load: string
  readonly memory: string
  readonly disk: string
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
  readonly repoOrLane: string
  readonly title: string
  readonly statusWord: string
  readonly tone: Tone
  readonly duration: string
  readonly lastMs: number | null
  readonly tokens: string
}

export interface AccountRow {
  readonly accountKey: string
  readonly provider: string
  readonly label: string
  readonly plan: string
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

/** Which sessions the table shows: one host's, one harness's, or `ALL` of either. */
export interface SessionFilters {
  readonly host: string
  readonly harness: string
}

/** The filter value that keeps every row. */
export const ALL = "all"

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

/** The harnesses the sessions reported, each once, by name. */
export function harnessesOf(sessions: ReadonlyArray<SessionRow>): ReadonlyArray<HarnessCount> {
  const counts = new Map<string, number>()
  for (const session of sessions) counts.set(session.harness, (counts.get(session.harness) ?? 0) + 1)
  return [...counts].map(([harness, count]) => ({ harness, sessions: count })).sort((a, b) => a.harness.localeCompare(b.harness))
}

/** The sessions `filters` keeps. */
export function filterSessions(sessions: ReadonlyArray<SessionRow>, filters: SessionFilters): ReadonlyArray<SessionRow> {
  return sessions.filter((s) =>
    (filters.host === ALL || s.nodeId === filters.host) && (filters.harness === ALL || s.harness === filters.harness)
  )
}

function parseMs(iso: string | null | undefined): number | null {
  if (iso === undefined || iso === null) return null
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : null
}

export function hostRowsOf(nodes: ReadonlyArray<HostNode>, nowMs: number): ReadonlyArray<HostRow> {
  return nodes.map((n) => {
    const seenMs = parseMs(n.seenAt)
    const reachable = n.online && seenMs !== null && nowMs - seenMs <= UNREACHABLE_MS * 3
    const diskLow = n.diskFreeGb !== null && n.diskFreeGb < 25
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
      load: n.load1 === null ? "-" : n.cpuCores === null ? n.load1.toFixed(1) : `${n.load1.toFixed(1)}/${n.cpuCores}c`,
      memory: n.memUsedGb !== null && n.memTotalGb !== null ? `${n.memUsedGb.toFixed(0)}/${n.memTotalGb.toFixed(0)}G` : "-",
      disk: n.diskFreeGb === null ? "-" : `${Math.round(n.diskFreeGb)}G free`,
      diskLow,
      activeSessions: n.activeSessions,
      runnerCapacity: n.runnerCapacity,
      version: n.version ?? "-",
      seenMs,
    }
  })
}

const SESSION_TONE: Readonly<Record<string, { readonly word: string; readonly tone: Tone }>> = {
  working: { word: "Working", tone: "run" },
  idle: { word: "Idle", tone: "muted" },
  stalled: { word: "Stalled", tone: "bad" },
  waiting: { word: "Waiting", tone: "warn" },
  error: { word: "Error", tone: "bad" },
  ended: { word: "Ended", tone: "muted" },
}

export function sessionRowsOf(
  sessions: ReadonlyArray<ObservedSession>,
  nowMs: number,
  includeEnded: boolean = false
): ReadonlyArray<SessionRow> {
  return sessions
    .filter((s) => includeEnded || s.status !== "ended")
    .map((s) => {
      const meta = SESSION_TONE[s.status] ?? { word: s.status, tone: "muted" as const }
      const startMs = parseMs(s.startedAt)
      const endMs = parseMs(s.endedAt)
      const lastMs = parseMs(s.lastActivityAt)
      const duration = startMs === null ? "-" : durationOf((endMs ?? nowMs) - startMs)
      return {
        sessionKey: s.sessionKey,
        nodeId: s.nodeId,
        harness: s.harness,
        managed: s.managed,
        model: s.model ?? "-",
        account: s.accountLabel ?? "-",
        repoOrLane: s.lane ?? s.repo ?? "-",
        title: s.title ?? "-",
        statusWord: meta.word,
        tone: meta.tone,
        duration,
        lastMs,
        tokens: s.tokensUsed === null ? "-" : `${tokensOf(s.tokensUsed)} tok`,
      }
    })
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
  accounts: ReadonlyArray<AccountRow>
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
