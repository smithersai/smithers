import { PINS_TELEMETRY } from "./features/pins/contract"
// The browser's telemetry contract (docs/observability.md#relayed-browser-records): every record the tab and its
// engine worker export, by name, and every attribute those records carry, merged from each feature's contract. ChatApi's
// relay (worker/Chat.ts) keeps exactly these and drops the rest, and the engine worker exports only these spans
// (src/flows/engine.ts), so the browser and the Worker share one list; src/telemetry.test.ts fails when they drift.
// Nothing here imports a library, so every side can.
import { AGENT_TELEMETRY } from "./features/agent/contract"
import { ATTENTION_TELEMETRY } from "./features/attention/contract"
import { AUTH_TELEMETRY } from "./features/auth/contract"
import { BRANCH_TELEMETRY } from "./features/branch/contract"
import { CONVERSATIONS_TELEMETRY } from "./features/conversations/contract"
import { CHAT_TELEMETRY } from "./features/chat/contract"
import { CODE_INTEL_TELEMETRY } from "./features/code-intel/contract"
import { ISSUES_TELEMETRY } from "./features/issues/contract"
import { PULLS_TELEMETRY } from "./features/pulls/contract"
import { TODOS_TELEMETRY } from "./features/todos/contract"
import { JEV_TELEMETRY } from "./features/jev/contract"
import { COMMANDS_TELEMETRY } from "./features/commands/contract"
import { FILES_TELEMETRY } from "./features/files/contract"
import { NAVIGATION_TELEMETRY } from "./features/navigation/contract"
import { REPO_TELEMETRY } from "./features/repo/contract"
import { THEME_TELEMETRY } from "./features/theme/contract"
import { TIMELINE_TELEMETRY } from "./features/timeline/contract"
import { VIEWS_TELEMETRY } from "./features/views/contract"
import { WEB_TELEMETRY } from "./features/web/contract"
import { FLOWS_TELEMETRY } from "./flows/contract"
import { FLOWS_UI_TELEMETRY } from "./features/flows-ui/contract"
import { DOCS_TELEMETRY } from "./features/docs/contract"
import { HOME_TELEMETRY } from "./features/home/contract"
import { RUNS_TELEMETRY } from "./features/runs/contract"
import { SECRETS_TELEMETRY } from "./features/secrets/contract"
import { SPEND_TELEMETRY } from "./features/spend/contract"
import { BUGS_TELEMETRY } from "./features/bugs/contract"
import { PLUGINS_TELEMETRY } from "./plugins/contract"
import { DOMAINS_TELEMETRY } from "./features/domains/contract"
import { PERSONAL_MODEL_TELEMETRY } from "./features/personal-model/contract"
import { STATUS_TELEMETRY } from "./features/status/contract"
import { TERMINAL_TELEMETRY } from "./features/terminal/contract"
import { PRESENCE_TELEMETRY } from "./features/presence/contract"
import { COEDIT_TELEMETRY } from "./features/coedit/contract"
import { SHARING_TELEMETRY } from "./features/sharing/contract"
import { SANDBOX_TELEMETRY } from "./features/sandbox/contract"

/** Records by name (log messages, span names, metric names) and the fields a relayed line keeps. */
export interface Telemetry {
  readonly records: ReadonlyArray<string>
  readonly fields: ReadonlyArray<string>
}

/**
 * What one browser telemetry export may carry, which ChatApi's relay reads (worker/Chat.ts) and the tab's and engine's
 * exporters split their batches under (src/boot.ts, src/flows/engine.ts): 128 KiB and 200 records. A larger request
 * would be answered 413 and lost whole; records past the count would be dropped.
 */
export const TELEMETRY_LIMITS = { maxRequestBytes: 128 * 1024, maxRecords: 200 } as const

/** The tab's `service.name` on every record it exports. */
export const WEB_SERVICE = "smithers-mvp-web"

/** The engine worker's `service.name` on every record it exports. */
export const ENGINE_SERVICE = "smithers-mvp-engine"

/**
 * The app's own records: boot and the page (src/boot.ts, src/page.ts), the HTTP client every feature reaches ChatApi
 * and Electric through (Effect's `HttpClient` names a client span by its method), and the exporter's own losses
 * (`@smthrs/observability`). A log line's failure keeps its type, never its message.
 */
export const APP_TELEMETRY = {
  records: [
    "chat ready",
    "chat couldn't restore",
    "persistent storage requested",
    "page error",
    "unhandled rejection",
    "page reloaded",
    "smithers_web_boot_ms",
    "smithers_web_storage_persisted",
    "smithers_web_page_reloads",
    "GET",
    "POST",
    "flows_observability_otlp_dropped",
    // What went wrong, wherever it was logged (docs/observability.md#errors): every line at Warn or above counted
    // (`LogFailures`), every failed /api/ request (`FetchFailures`), React's render errors and the service worker's
    // (src/hostRecords.ts), and what a view's or the program's Effect left unhandled (src/boundary.ts).
    "flows_observability_log_failures",
    "http.request.failed",
    "http.request.recovered",
    "flows_observability_http_failures",
    "render error",
    "pwa.register",
    "pwa.install",
    "pwa.update.check",
    "pwa.update",
    "app.unhandled",
    "browser.language_server.failed",
  ],
  fields: [
    "feature",
    "granted",
    "name",
    "source",
    "level",
    "record",
    "code",
    "area",
    "route",
    "method",
    "status",
    "statusClass",
    "retried",
    "failures",
    "boundary",
    "outcome",
    "trigger",
    "kind",
    "errorCode",
    "http.request.method",
    "http.response.status_code",
    "url.path",
    "url.scheme",
    "server.address",
    "server.port",
    "error.type",
    "exception.type",
  ],
} as const

/** The fields `OtlpRelay.serve` adds to every relayed line: the signal, the service, ids, timing and a metric's value. */
export const RELAY_FIELDS = [
  "otlp.signal",
  "service.name",
  "otlp.severity",
  "trace_id",
  "span_id",
  "otlp.parent_span_id",
  "otlp.duration_ms",
  "otlp.metric_type",
  "otlp.unit",
  "otlp.value",
  "otlp.count",
  "otlp.sum",
] as const

/**
 * What the browser records and the server never gets:
 * - `spans`: one span per request a tab sends the leader, each poll for a result included, so hundreds per answer, on
 *   both sides: the tab's `browser.engine.request` and the leader's `browser.runtime.request`. Their counts
 *   (`smithers_browser_engine_requests`, `smithers_browser_runtime_requests`) and the leader's line for a request that
 *   failed are relayed. An exporter given {@link EXPORTED_SPANS} doesn't send them, and the relay drops the tab's;
 * - `fields`: a failure's message (`exception.message`, `exception.stacktrace`, `otlp.status_message`) can quote what
 *   someone wrote, so a failure is relayed by its type alone; and `effect.fiberId`, Effect's number for the fiber that
 *   logged, means nothing outside the tab. Full URLs and query strings can carry credentials or private content.
 */
export const WITHHELD = {
  spans: ["browser.engine.request", "browser.runtime.request"],
  fields: ["exception.message", "exception.stacktrace", "otlp.status_message", "effect.fiberId", "url.full", "url.query"],
} as const

const features: ReadonlyArray<Telemetry> = [
  APP_TELEMETRY,
  CHAT_TELEMETRY,
  PINS_TELEMETRY,
  COMMANDS_TELEMETRY,
  AUTH_TELEMETRY,
  FLOWS_TELEMETRY,
  AGENT_TELEMETRY,
  { records: ["smithers_memory_operations", "memory.recall", "smithers_memory_recall_ms", "memory.remember", "smithers_memory_remembered", "memory.opening", "smithers_memory_recalled", "smithers_memory_inserted", "smithers_memory_filtered", "smithers_memory_ms", "chat.opening.skipped", "smithers_chat_opening_skipped"], fields: ["method", "outcome", "recalled", "inserted", "filtered", "skillsRecalled", "skillsInserted", "durationMs", "reason"] },
  THEME_TELEMETRY,
  NAVIGATION_TELEMETRY,
  FILES_TELEMETRY,
  REPO_TELEMETRY,
  CODE_INTEL_TELEMETRY,
  WEB_TELEMETRY,
  VIEWS_TELEMETRY,
  JEV_TELEMETRY,
  ISSUES_TELEMETRY,
  PULLS_TELEMETRY,
  SECRETS_TELEMETRY,
  TODOS_TELEMETRY,
  FLOWS_UI_TELEMETRY,
  RUNS_TELEMETRY,
  STATUS_TELEMETRY,
  BRANCH_TELEMETRY,
  CONVERSATIONS_TELEMETRY,
  SHARING_TELEMETRY,
  PRESENCE_TELEMETRY,
  COEDIT_TELEMETRY,
  TERMINAL_TELEMETRY,
  SANDBOX_TELEMETRY,
  SPEND_TELEMETRY,
  BUGS_TELEMETRY,
  PLUGINS_TELEMETRY,
  DOMAINS_TELEMETRY,
  PERSONAL_MODEL_TELEMETRY,
  HOME_TELEMETRY,
  DOCS_TELEMETRY,
  ATTENTION_TELEMETRY,
  TIMELINE_TELEMETRY,
]

/**
 * Everything the relay keeps: every feature's records, and its fields beside the relay's own. `worker/Chat.ts` relays
 * with it as `allow`; the engine worker exports only its records' spans.
 */
export const BROWSER_TELEMETRY: Telemetry = {
  records: [...new Set(features.flatMap((feature) => feature.records))],
  fields: [...new Set([...RELAY_FIELDS, ...features.flatMap((feature) => feature.fields)])],
}

/**
 * The span names an exporter sends: every record the relay keeps but the {@link WITHHELD} spans. A log line or metric
 * of the same name is still sent; only spans are left out. The engine worker's exporter takes it as `spans`.
 */
export const EXPORTED_SPANS: ReadonlyArray<string> = BROWSER_TELEMETRY.records.filter(
  (name) => !(WITHHELD.spans as ReadonlyArray<string>).includes(name),
)
