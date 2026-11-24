// Shared contract for deployment-wide fleet visibility (`/app/fleet`): host nodes, observed sessions across all
// harnesses (Claude, Codex, AGY CLI/IDE, Cloudflare sandboxes, Smithers runners), and provider account quotas.
// Zero runtime library imports so browser, workerd, CLI, and tests share one source of truth.

export const FLEET_NODES_SHAPE_ROUTE = "/api/shapes/fleet/nodes"
export const FLEET_SESSIONS_SHAPE_ROUTE = "/api/shapes/fleet/sessions"
export const FLEET_ACCOUNTS_SHAPE_ROUTE = "/api/shapes/fleet/accounts"

/** The deployment-wide sources, as the browser names them. */
export type GlobalFleetShape = "nodes" | "sessions" | "accounts"

/**
 * What a deployment-wide source says of itself: `loading` until its first whole snapshot arrives, `unavailable` while
 * its rows are withheld (a refusal, or a session in doubt), `ready` once delivered. Only `ready` rows count: no rows
 * while `loading` or `unavailable` never mean an empty fleet.
 */
export type FleetAvailability = "loading" | "unavailable" | "ready"

/** A live source that says whether its rows were delivered. */
export interface Available {
  readonly availability: () => FleetAvailability
}

/** `source`'s availability; a source that doesn't say is `ready`, as every repository query is once it answers. */
export const availabilityOf = (source: object): FleetAvailability => {
  const read = (source as Partial<Available>).availability
  return typeof read === "function" ? read() : "ready"
}

export const HOST_KINDS = ["macbook", "mac-mini", "bare-metal", "cloudflare", "lan", "browser"] as const
export type HostKind = (typeof HOST_KINDS)[number]

export const SESSION_HARNESSES = [
  "claude",
  "codex",
  "agy-cli",
  "agy-ide",
  "cfbox",
  "cf-sandbox",
  "smithers",
  "daemon",
] as const
export type SessionHarness = (typeof SESSION_HARNESSES)[number]

export const SESSION_STATUSES = ["working", "idle", "stalled", "waiting", "error", "ended"] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

export const TRANSCRIPT_ROLES = ["user", "assistant", "tool", "system"] as const
export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number]

export interface TranscriptEntry {
  readonly ts: string | null
  readonly role: "user" | "assistant" | "tool" | "system"
  readonly label: string | null
  readonly text: string
}

export const ACCOUNT_PROVIDERS = ["claude", "codex", "google-agy"] as const
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number]

export const ACCOUNT_STATUSES = ["ready", "cooling", "limit_reached", "auth_expired", "unknown"] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

export const HOST_NODE_COLUMNS = [
  "node_id",
  "name",
  "kind",
  "labels",
  "online",
  "held",
  "load1",
  "cpu_cores",
  "mem_used_gb",
  "mem_total_gb",
  "disk_free_gb",
  "disk_total_gb",
  "active_sessions",
  "runner_capacity",
  "version",
  "seen_at",
] as const

export const OBSERVED_SESSION_COLUMNS = [
  "session_key",
  "node_id",
  "managed",
  "harness",
  "model",
  "account_label",
  "repo",
  "project",
  "lane",
  "title",
  "summary",
  "cwd",
  "transcript_json",
  "status",
  "pid",
  "cpu_seconds",
  "tokens_used",
  "started_at",
  "last_activity_at",
  "ended_at",
] as const

/** The sessions the Electric shape replicates: an ended session, and its transcript, stays on the server. */
export const ACTIVE_SESSIONS_WHERE = "status <> 'ended'"

/**
 * The provider account columns Electric replicates. `grants_json` is not one of them (R2-Astra-D4-004): a row stored
 * before the grant allowlist can hold fields the allowlist drops, and Electric serves a column as stored. Grants are
 * read through the allowlist by `fleet_overview` only.
 */

export const PROVIDER_ACCOUNT_COLUMNS = [
  "account_key",
  "provider",
  "label",
  "plan",
  "status",
  "five_hour_pct",
  "weekly_pct",
  "scoped_pct",
  "resets_at",
  "credits_balance",
  "active_sessions",
  "pools",
  "cool_reason",
  "cool_until",
  "source_node",
  "checked_at",
] as const
