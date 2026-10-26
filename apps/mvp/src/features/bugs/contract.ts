// Bug reports' contract between the browser and ChatApi (docs/features/bugs.md): the routes, the table, the
// limits and the records the feature makes. Nothing here imports a library, so every side can.

/**
 * `POST`: a signed-in person, or the agent for them, files a report (`ReportRequest`), answered `Filed`. `GET`: the
 * reports, newest first (`Listed`), for an Admin or a bearer of the deployment's read token (`BUG_REPORTS_READ_TOKEN`).
 */
export const BUG_REPORTS_ROUTE = "/api/bugs"

/** `GET`: Electric's `bug_reports`: every report for an Admin in person, a person's own for anyone else signed in. */
export const BUG_REPORTS_SHAPE_ROUTE = "/api/shapes/bug-reports"

/** The Postgres table: one row per report. */
export const BUG_REPORTS_TABLE = "bug_reports"

/** The columns a device syncs, and the read route answers: all of them. */
export const BUG_REPORT_COLUMNS = [
  "id",
  "reporter_id",
  "reporter_login",
  "reporter_role",
  "acted_by",
  "what",
  "route",
  "repo",
  "build",
  "traces",
  "runs",
  "failures",
  "browser",
  "viewport",
  "created_at",
] as const

/** The environment variable holding the deployment's read token: a bearer of it lists reports, nothing else. */
export const BUG_READ_TOKEN_VARIABLE = "BUG_REPORTS_READ_TOKEN"

/** The most a person writes in "What happened?". */
export const MAX_WHAT_LENGTH = 4_000

/** The most trace ids, run ids or failures one report carries: the tab's latest. */
export const MAX_RECENT = 20

/** The largest `POST /api/bugs` body, in bytes. */
export const MAX_REPORT_BODY_BYTES = 32 * 1_024

/** How many reports one read answers by default, and at most. */
export const LIST_DEFAULT = 50
export const LIST_MAX = 200

/** Where a report opens in the app: the bug inbox. */
export const BUG_INBOX_PATH = "/app/bugs"

/** Where "Report a bug" opens: the form. */
export const BUG_FORM_PATH = "/app/bugs/report"

/** The repository "Open on GitHub" files on when the page shows none. */
export const DEFAULT_ISSUE_REPOSITORY = "smithersai/smithers"

/** The remote execution that tells the Admins about report `id`, and its alert's id in `alert_deliveries`. */
export const bugAlertId = (id: string) => `bug-report-${id}`

/** The notification's subject in each Admin's feed. */
export const bugSubject = (id: string) => `bug:${id}`

/** The engine's channel the report's step asks its tab on: `<engine>/bug-context`. */
export const bugContextChannel = (engine: string) => `${engine}/bug-context`

/** How long the step waits for the tab that asked to say what it shows. */
export const CONTEXT_WITHIN = "3 seconds"

/** How long one ChatApi exchange may take, the whole of it. */
export const BUGS_WITHIN = "15 seconds"

/** Why ChatApi refused a report or a read: its body's `code`. */
export type Refusal = "authentication" | "forbidden" | "invalid" | "too_large" | "conflict" | "unavailable"

/**
 * What bug reports record in the browser, by name, and the fields they carry (docs/observability.md#bug-reports). None
 * carries what a person wrote, a route, a login or an id of theirs.
 */
export const BUGS_TELEMETRY = {
  records: [
    "bug.report",
    "smithers_web_bug_reports",
    "bug.context",
    "smithers_web_bug_contexts",
    "bug.list",
    "smithers_web_bug_lists",
    "bug.file",
    "bug.read",
  ],
  fields: ["outcome", "door", "status", "code", "traces", "runs", "failures", "count"],
} as const

/**
 * A row of the core's `core/bug-reports`, as a plugin reads it (src/plugins/facts.ts): a report, and `github`, GitHub's
 * prefilled new-issue form for it.
 */
export const BUG_REPORT_ROW = {
  type: "object",
  properties: {
    id: { type: "string" },
    reporterId: { type: "string" },
    reporterLogin: { type: ["string", "null"] },
    reporterRole: { type: ["string", "null"] },
    actedBy: { type: ["string", "null"] },
    what: { type: "string" },
    route: { type: ["string", "null"] },
    repo: { type: ["string", "null"] },
    build: { type: "string" },
    traces: { type: "array", items: { type: "string" } },
    runs: { type: "array", items: { type: "string" } },
    failures: {
      type: "array",
      items: {
        type: "object",
        properties: { flow: { type: "string" }, code: { type: "string" } },
        required: ["flow", "code"],
        additionalProperties: false,
      },
    },
    browser: { type: "string" },
    viewport: { type: "string" },
    createdAt: { type: "string" },
    github: { type: "string" },
  },
  required: [
    "id",
    "reporterId",
    "reporterLogin",
    "reporterRole",
    "actedBy",
    "what",
    "route",
    "repo",
    "build",
    "traces",
    "runs",
    "failures",
    "browser",
    "viewport",
    "createdAt",
    "github",
  ],
  additionalProperties: false,
} as const
