// The branch terminal's contract between the browser, ChatApi, the flows, the sandbox and the tests (decision 0013 §3,
// docs/features/branch-workspace.md#the-terminal). Nothing here imports a library, so every side can. The socket's own
// protocol (frames, control, close codes) is `TerminalProtocol` in `@smthrs/sandbox`.

/**
 * `POST <route>` `{ terminalId, branchId, cols, rows }` opens a terminal: `terminal/Open`. `GET <route>/<id>` with
 * `Upgrade: websocket` attaches to it.
 */
export const TERMINALS_ROUTE = "/api/terminals"

/** ChatApi's Electric shape proxy for one branch's `terminal_sessions`: `GET ?branch=<branch id>`. */
export const TERMINALS_SHAPE_ROUTE = "/api/shapes/terminals"

/** The Postgres table of terminals (db/migrations/0014_branch_workspace.ts). */
export const TERMINALS_TABLE = "terminal_sessions"

/** A terminal's status: being opened, open, ended (`ENDED_REASONS`) or failed to open (`FAILURES`). */
export const STATUSES = ["opening", "open", "ended", "failed"] as const
export type Status = (typeof STATUSES)[number]

/** Why an open terminal ended (`TerminalProtocol.EndReason`). */
export const ENDED_REASONS = ["closed", "slept", "lost", "revoked"] as const
export type EndedReason = (typeof ENDED_REASONS)[number]

/** Why a terminal failed to open: the machine wouldn't start, or the branch couldn't be checked out in it. */
export const FAILURES = ["unavailable", "checkout"] as const
export type Failure = (typeof FAILURES)[number]

/** The non-root user every shell runs as, and the directory it starts in (`infra/sandbox/Dockerfile`). */
export const SANDBOX_USER = "smithers"
export const WORKSPACE = "/workspace"

/**
 * The host a sandbox's git remote names. Its requests never leave the box: the branch's sandbox intercepts them and
 * the read-only forge proxy answers them with the read token added outside the box (`GitProxy.uploadPack`).
 */
export const FORGE_HOST = "forge.smithers.internal"

/** The largest `POST /api/terminals` body. */
export const MAX_OPEN_BODY_BYTES = 1024

/** The terminal's first size, before the frame measures it. */
export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24

/** A terminal's socket route. */
export const terminalSocketRoute = (terminalId: string): string => `${TERMINALS_ROUTE}/${terminalId}`

/** The execution id of the `terminal/Open` run for one terminal: the terminal's own id, so a resend starts nothing new. */
export const openExecutionId = (terminalId: string): string => `terminal-open:${terminalId}`

/**
 * How long a terminal may stay `opening`: past it, `terminal/Open` no longer records it open, and the person's next
 * Open terminal settles it `failed` and opens a new one, so a run that never finished can't lock them out.
 */
export const OPEN_DEADLINE_SECONDS = 180

/**
 * How long a terminal waits for a free machine under the sandbox limits (worker/branch/Budget.ts, decision 0103) before
 * it fails: its row says `waiting` meanwhile, and its open's deadline counts from when a machine was free.
 */
export const ADMIT_WAIT_SECONDS = 30 * 60

/**
 * What the branch terminal records in the browser (decision 0013 §7, docs/observability.md#browser): `terminal/open`'s
 * step and request, the button, the socket's span and the counts. Never a byte of the terminal: only ids, outcomes,
 * statuses, close codes, byte counts by direction and durations.
 */
export const TERMINAL_TELEMETRY = {
  records: [
    "terminal.show",
    "terminal.show.failed",
    "terminal.open",
    "terminal.open.unsettled",
    "terminal.open.post",
    "terminal.open.press",
    "terminal.connect",
    "smithers_web_terminal_opens",
    "terminal_open_ms",
    "terminal_reconnects",
    "terminal_bytes",
    "terminal_ended",
  ],
  fields: [
    "outcome",
    "status",
    "terminalId",
    "branchId",
    "durationMs",
    "preloadMs",
    "rowCount",
    "code",
    "direction",
    "reason",
    "errorCode",
  ],
} as const
