import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Channels } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Duration, Effect, Layer, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import * as FeedLocks from "../FeedLocks.ts"
import * as Flows from "#vibelang/emitted/worker/Flows"
import * as Fleet from "../runners/Fleet.ts"
import { AUDIENCE } from "../runners/FleetAudience.ts"
export { AUDIENCE } from "../runners/FleetAudience.ts"
import * as AlertDelivery from "./AlertDelivery.ts"

// The fleet's alerts (decision 0143, docs/features/fleet.md#alerts): durable flows, no sweeps (ruling DUR-2).
//
// - `ops/FleetAlert { alertId, kind, repoId, subject }` tells the people an incident is for: one `fleet` entry in each
//   one's bell (`ops/BellFleetAlert`), then the deployment's email and Telegram channels where an Admin set them
//   (`ops/DeliverFleetAlert`, as every alert delivers, worker/flows/AlertDelivery.ts). Its execution id is the alert's
//   id, so a second start of the same incident starts nothing. Who starts it: the job store's probe (a run stalled,
//   waited too long, cost too much, or its runner went offline; worker/runners/Jobs.ts), `todo/Fail` (a TODO's run
//   failed or was lost; worker/flows/Todo.ts), and `ops/RunnerHealth` (a runner offline with no job to probe).
// - `ops/RunnerHealth { from, until }` looks once a window for runners unseen past `RUNNER_OFFLINE_SECONDS` and starts
//   each one's Runner offline alert. Every `FlowExecution` alarm starts its window's execution once it is done
//   (`sampler`, worker/Executions.ts), as `ops/DatabaseLoad`'s; one execution per window.
//
// Who hears what (FINAL.md §4.2): a run's alerts go to the TODO's committer and the repository's Maintainers and Admins;
// Runner offline and Cost to its Admins; Waiting for a runner to its Maintainers. A repository's roles are the ones
// GitHub gave and `github_repo_roles` keeps (decision 0079); on the deployment's own repository, the sessions' roles.
// A bell row says only the incident's kind and its repository, and links to what it is about (`bellTitleOf`): the
// TODO's title, its failure, the cost and the runner's name show only on the page the link opens, whose shapes check
// the reader's current role there (worker/runners/FleetApi.ts, worker/stack/Api.ts), as a GitHub notification links to
// a private repository's page rather than quoting it. Recipients are picked from cached roles, so a row may reach
// someone whose access just ended; it tells them nothing they can open. A cached row that says no role, or less than
// the kind's, excludes the person, the committer included. The messages carry the TODO's number and title or the
// runner's name, never a prompt, a transcript, an account path or a token.

const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const positive = Schema.Int.check(Schema.isGreaterThan(0))

/** Postgres failed a step. It retries, and never gives up. */
export class FleetAlertUnavailable extends Schema.TaggedError<FleetAlertUnavailable>()(
  "@smthrs/mvp/ops/FleetAlertUnavailable",
  { reason: Schema.Literal("database") },
) {}

/** Bell entries written, by `kind`. */
export const bells = Metric.counter("smithers_fleet_alert_bells", {
  description: "Fleet alert entries written to people's bells, by kind",
  incremental: true,
})

/** Deliveries outside the app, by `channel` and `outcome`. */
export const deliveries = Metric.counter("smithers_fleet_alert_deliveries", {
  description: "Fleet alert deliveries outside the app, by channel and outcome",
  incremental: true,
})

const retryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/** What the bell did: whom it reached, `none` when the incident's subject is gone. */
export const Belled = Schema.Struct({ outcome: Schema.Literals(["written", "none"]), recipients: nonNegative })
export type Belled = typeof Belled.Type

/** Records the incident and puts it in each recipient's bell, once. */
export const Bell = Action.make("ops/BellFleetAlert", {
  payload: Fleet.Alert.fields,
  success: Belled,
  error: FleetAlertUnavailable,
  capabilities: ["db:read:agent_runs", "db:read:todos", "db:read:runners", "db:write:fleet_alerts", "db:write:notifications"],
  retryPolicy,
})

/** Sends the incident on one channel and records its receipt, at least once, as every alert's delivery does. */
export const Deliver = Action.make("ops/DeliverFleetAlert", {
  payload: { alertId: Fleet.Alert.fields.alertId, channel: Channels.Channel },
  success: AlertDelivery.Delivered,
  error: Schema.Union([Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  capabilities: ["db:read:fleet_alerts", "db:read:alert_channels", "db:write:alert_deliveries", "net:alert_channels"],
  tier: "irreversible",
  idempotencyKey: ({ alertId, channel }) => ({ alert: alertId, channel }),
  retryPolicy: AlertDelivery.retryPolicy,
})

const Outcome = Schema.Struct({ email: AlertDelivery.Delivered, telegram: AlertDelivery.Delivered })

/** `ops/FleetAlert`: one incident, to its people's bells and the deployment's channels. */
export const FleetAlert = Flow.make("ops/FleetAlert", {
  description: "Tell the people an agent run or runner incident is for: a run that failed, stalled, waited too long " +
    "for a runner or cost too much, or a runner that went offline. In their notifications, and by email and Telegram " +
    "where an Admin set them.",
  capabilities: [
    "db:read:agent_runs",
    "db:read:todos",
    "db:read:runners",
    "db:write:fleet_alerts",
    "db:write:notifications",
    "db:read:alert_channels",
    "db:write:alert_deliveries",
    "net:alert_channels",
  ],
  modelInvocable: false,
  payload: Fleet.Alert.fields,
  success: Outcome,
  error: Schema.Union([FleetAlertUnavailable, Channels.DeliveryFailed, AlertDelivery.DeliverUnavailable]),
  body: Node.capture({}, (alert: Fleet.Alert) =>
    Bell.call(alert).pipe(
      Node.andThen(Node.all({
        email: Deliver.call({ alertId: alert.alertId, channel: "email" }),
        telegram: Deliver.call({ alertId: alert.alertId, channel: "telegram" }),
      })),
    )),
})

/** The longest title a bell row and a message's subject carry. */
const MAX_TITLE = 200

const clip = (text: string) => (text.length <= MAX_TITLE ? text : `${text.slice(0, MAX_TITLE - 1).replace(/[\uD800-\uDBFF]$/, "")}…`)

/**
 * Each kind as a bell row and a shared channel name it (decision 0149): never the TODO's title, its failure, the
 * cost or the runner's name.
 */
export const KIND_WORDS: Readonly<Record<Fleet.Kind, string>> = {
  failed: "Agent run failed",
  stalled: "Agent run stalled",
  waiting: "Agent run waiting for a runner",
  cost: "Agent run cost",
  offline: "Runner offline",
}

/** A bell row's title: the kind and the repository, `Agent run failed · acme/widgets`. */
export const bellTitleOf = (kind: Fleet.Kind, repoId: string) =>
  clip(`${KIND_WORDS[kind]} · ${repoId.replace(/^github\//, "")}`)

/** A repository's page path: `github/<owner>/<name>` → `/<owner>/<name>`. */
const repoPath = (repoId: string) => `/${repoId.replace(/^github\//, "")}`

/** What an incident says, where it opens, and whose run it is: none when its subject is gone. */
interface Described {
  readonly title: string
  readonly href: string
  readonly committer: string | null
}

const WORDS: Readonly<Record<Exclude<Fleet.Kind, "offline">, string>> = {
  failed: "Failed",
  stalled: "Stalled",
  waiting: "Waiting for a runner",
  cost: "Cost",
}

/** The words for an incident, read from the run, the TODO attempt or the runner it is about. */
export const describe = (alert: Fleet.Alert) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (alert.kind === "offline") {
      const [runner] = yield* sql<{ readonly name: string; readonly repoId: string }>`
        SELECT name, repo_id AS "repoId" FROM runners WHERE id::text = ${alert.subject}`
      if (runner === undefined) return Option.none<Described>()
      return Option.some({ title: clip(`Runner ${runner.name} offline`), href: `${repoPath(runner.repoId)}/-/fleet`, committer: null })
    }
    const [row] = alert.kind === "failed"
      ? yield* sql<{ readonly number: number; readonly title: string; readonly createdBy: string; readonly detail: string | null }>`
        SELECT t.number, t.title, t.created_by AS "createdBy", t.failure AS detail
        FROM todo_attempts a JOIN todos t ON t.id = a.todo_id WHERE a.id::text = ${alert.subject}`
      : yield* sql<{ readonly number: number | null; readonly title: string | null; readonly createdBy: string | null; readonly detail: string | null }>`
        SELECT r.number, r.title, t.created_by AS "createdBy",
          CASE WHEN r.cost_usd IS NULL THEN r.agent ELSE '$' || to_char(r.cost_usd, 'FM999999990.00') END AS detail
        FROM agent_runs r LEFT JOIN todos t ON t.id = r.todo_id WHERE r.key = ${alert.subject}`
    if (row === undefined) return Option.none<Described>()
    const what = row.number === null ? "Agent run" : `T${row.number} ${row.title ?? ""}`.trim()
    const detail = alert.kind === "failed" || alert.kind === "cost" ? row.detail : null
    return Option.some({
      title: clip([what, WORDS[alert.kind], detail].filter((part) => part !== null && part !== "").join(" · ")),
      href: row.number === null ? `${repoPath(alert.repoId)}/-/fleet` : `${repoPath(alert.repoId)}/stack/${row.number}`,
      committer: AUDIENCE[alert.kind].committer ? row.createdBy : null,
    })
  })

/**
 * Records incident `alert` and puts it in the bell of everyone it is for, once each (`fleet:<alert id>`): the run's
 * committer where its kind says so, and everyone whose role on the repository is at least the kind's (`AUDIENCE`):
 * from `github_repo_roles`, or on the deployment's own repository `home`, from live sessions. Each row says only the kind
 * and the repository (`bellTitleOf`).
 */
export const bell = (alert: Fleet.Alert, home: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const described = yield* describe(alert)
    if (Option.isNone(described)) return { outcome: "none", recipients: 0 } satisfies Belled
    const { title, href, committer } = described.value
    const roles = AUDIENCE[alert.kind].role === "admin" ? ["admin"] : ["maintainer", "admin"]
    const rolesJson = JSON.stringify(roles)
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`
        INSERT INTO fleet_alerts (id, kind, repo_id, subject, title, href)
        VALUES (${alert.alertId}, ${alert.kind}, ${alert.repoId}, ${alert.subject}, ${title}, ${href})
        ON CONFLICT (id) DO NOTHING`
      // Who may hear it, read without locking anything; then their feed locks, sorted, before any notification row
      // (worker/FeedLocks.ts); then the rows, for those locked who may still hear it, in a statement of its own.
      const audience = () => sql<{ readonly recipient: string }>`
        SELECT DISTINCT recipient
        FROM (
          SELECT person_id AS recipient FROM github_repo_roles
          WHERE repo_id = ${alert.repoId} AND role IN (SELECT jsonb_array_elements_text(${rolesJson}::jsonb))
          UNION
          SELECT person_id::text FROM sessions
          WHERE ${alert.repoId === home}::boolean AND role IN (SELECT jsonb_array_elements_text(${rolesJson}::jsonb))
            AND revoked_at IS NULL AND expires_at > now()
          UNION
          -- The committer, unless a recorded read says they hold no role there, or less than Member. A row a read
          -- claimed before GitHub answered (checked_at -infinity) recorded nothing.
          SELECT ${committer}::text WHERE ${committer}::text IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM github_repo_roles
            WHERE repo_id = ${alert.repoId} AND person_id = ${committer}::text AND checked_at <> '-infinity'
              AND (role IS NULL OR role NOT IN ('member', 'maintainer', 'admin')))
        ) AS audience`
      const held = yield* FeedLocks.lock(sql, (yield* audience()).map(({ recipient }) => ({ repoId: alert.repoId, personId: recipient })))
      const recipients = (yield* audience()).map(({ recipient }) => recipient)
        .filter((recipient) => FeedLocks.holds(held, { repoId: alert.repoId, personId: recipient }))
      const rows = yield* sql<{ readonly recipient: string }>`
        INSERT INTO notifications (recipient, subject, kind, state, repo_id, title, href)
        SELECT recipient, ${`fleet:${alert.alertId}`}, 'fleet', 'update', ${alert.repoId},
          ${bellTitleOf(alert.kind, alert.repoId)}, ${href}
        FROM jsonb_array_elements_text(${JSON.stringify(recipients)}::jsonb) AS chosen(recipient)
        ON CONFLICT (recipient, subject) DO NOTHING
        RETURNING recipient`
      yield* sql`UPDATE fleet_alerts SET recipients = recipients + ${rows.length} WHERE id = ${alert.alertId}`
      return { outcome: "written", recipients: rows.length } satisfies Belled
    }))
  })

/** The bell step over `database`, with its `fleet.alert.bell` line, span and count: the alert and a count, never who. */
export const observedBell = <E, R>(alert: Fleet.Alert, home: string, database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  bell(alert, home).pipe(
    Effect.provide(database),
    Effect.tapError((error) =>
      Effect.logWarning("fleet.alert.bell").pipe(Effect.annotateLogs({ alertId: alert.alertId, errorCode: codeOf(error) }))
    ),
    Effect.mapError(() => new FleetAlertUnavailable({ reason: "database" })),
    Effect.tap((belled) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(bells, { kind: alert.kind }), belled.recipients),
        Effect.logInfo("fleet.alert.bell").pipe(
          Effect.annotateLogs({ alertId: alert.alertId, kind: alert.kind, ...belled }),
        ),
      )
    ),
    Effect.withSpan("fleet.alert.bell", { attributes: { "smithers.fleet_alert.id": alert.alertId } }),
  )

/**
 * What a shared channel says of an incident (decision 0149): its kind (`KIND_WORDS`), its repository,
 * and the link to what it is about.
 */
export const noticeOf = (incident: { readonly kind: Fleet.Kind; readonly repoId: string; readonly href: string }): AlertDelivery.Notice => ({
  kind: KIND_WORDS[incident.kind],
  repository: repoPath(incident.repoId).slice(1),
  href: incident.href,
})

/** Delivers incident `alertId` on `channel`: nothing for an incident the bell didn't record. */
export const deliver = (request: { readonly alertId: string; readonly channel: Channels.Channel }) =>
  AlertDelivery.deliver(request,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly kind: Fleet.Kind; readonly repoId: string; readonly href: string }>`
        SELECT kind, repo_id AS "repoId", href FROM fleet_alerts WHERE id = ${request.alertId}`
    ).pipe(Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), noticeOf))))

/** The delivery step over `database`, with its records (`AlertDelivery.observed`): `fleet.alert.delivery`. */
export const observedDeliver = <E, R>(
  request: { readonly alertId: string; readonly channel: Channels.Channel },
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) =>
  AlertDelivery.observed(
    { name: "fleet.alert.delivery", deliveries, idAttribute: "smithers.fleet_alert.id" },
    request,
    deliver(request),
    database,
  )

/**
 * Registers `ops/FleetAlert` with its steps, reaching Postgres through `database`, sending through `channels`, and
 * reading the deployment's own repository's roles from sessions for `home` (`github/<owner>/<name>`).
 */
export const registration = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  home: string,
  channels: Layer.Layer<Channels.Channels> = AlertDelivery.noChannels,
) =>
  Interpreter.layerWithImplementations(
    FleetAlert,
    Layer.mergeAll(
      Bell.toLayer((alert) => observedBell(alert, home, database)),
      Deliver.toLayer((request) => observedDeliver(request, database)),
    ),
  ).pipe(Layer.provide(channels), Layer.provideMerge(Action.layerImplementations))

// ─── ops/RunnerHealth ─────────────────────────────────────────────────────────────────────────────────────────────

/** How often runners are looked at for an outage no job's probe sees. */
export const HEALTH_WINDOW = Duration.minutes(1)

/** The execution for one window. */
export const healthExecutionId = (window: Flows.Window) => `runner-health-${window.until - window.from}-${window.from}`

/** What one look found: how many runners it started an alert for. */
export const Checked = Schema.Struct({ offline: nonNegative })

/** Looks for runners unseen past the threshold and starts each one's Runner offline alert. */
export const Check = Action.make("ops/CheckRunners", {
  payload: { from: nonNegative, until: positive },
  success: Checked,
  error: FleetAlertUnavailable,
  capabilities: ["db:read:runners"],
  retryPolicy,
})

/** `ops/RunnerHealth`: one window's look at the runners. */
export const RunnerHealth = Flow.make("ops/RunnerHealth", {
  description: "Look at the deployment's runner machines once a window and alert a repository's Admins about each one " +
    "that stopped answering.",
  capabilities: ["db:read:runners"],
  modelInvocable: false,
  payload: { from: nonNegative, until: positive },
  success: Checked,
  error: FleetAlertUnavailable,
  body: Node.capture({}, (window: Flows.Window) => Check.call(window)),
})

/** Runner health looks, by `outcome`: `checked`, `failed`, and `not_started` when an alarm couldn't start one. */
export const checks = Metric.counter("smithers_runner_health_checks", {
  description: "Runner health looks once a window, by outcome",
  incremental: true,
})

/**
 * The runners unseen for `offlineSeconds` (registered, not removed, seen at least once): each one's alert, keyed by its
 * last sighting, so one outage is one incident however many windows see it.
 */
export const offline = (offlineSeconds: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly id: string; readonly repoId: string; readonly seenAt: Date }>`
      SELECT id::text AS id, repo_id AS "repoId", seen_at AS "seenAt" FROM runners
      WHERE removed_at IS NULL AND seen_at < now() - ${offlineSeconds}::int * interval '1 second'`
    return rows.map((row): Fleet.Alert => ({
      alertId: Fleet.alertId.offline(row.id, new Date(row.seenAt).getTime()),
      kind: "offline",
      repoId: row.repoId,
      subject: row.id,
    }))
  })

/**
 * The check over `database`: starts each offline runner's alert through `start` (a start already made starts nothing).
 * A start that fails fails the step, which retries it.
 */
export const check = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  offlineSeconds: number,
  start: (alert: Fleet.Alert) => Effect.Effect<void, unknown>,
) =>
(_window: Flows.Window) =>
  offline(offlineSeconds).pipe(
    Effect.provide(database),
    Effect.flatMap((alerts) => Effect.as(Effect.forEach(alerts, start, { discard: true }), alerts.length)),
    Effect.tapError((error) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(checks, { outcome: "failed" }), 1),
        Effect.logWarning("runner.health").pipe(Effect.annotateLogs({ outcome: "failed", errorCode: codeOf(error) })),
      )
    ),
    Effect.mapError(() => new FleetAlertUnavailable({ reason: "database" })),
    Effect.tap((count) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(checks, { outcome: "checked" }), 1),
        Effect.logInfo("runner.health").pipe(Effect.annotateLogs({ outcome: "checked", offline: count })),
      )
    ),
    Effect.map((count) => ({ offline: count })),
    Effect.withSpan("runner.health"),
  )

/** Registers `ops/RunnerHealth` over `database`, starting alerts through `start`, with `offlineSeconds`. */
export const healthRegistration = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  offlineSeconds: number,
  start: (alert: Fleet.Alert) => Effect.Effect<void, unknown>,
) =>
  Interpreter.layerWithImplementations(RunnerHealth, Check.toLayer(check(database, offlineSeconds, start)))
    .pipe(Layer.provideMerge(Action.layerImplementations))

/** Starts one alert's `ops/FleetAlert` through `starter`: its id is the execution's; a repeat start is no conflict. */
export const startWith = (starter: Flows.FlowStarter["Service"]) => (alert: Fleet.Alert) =>
  starter.start(FleetAlert, { executionId: alert.alertId, payload: alert }).pipe(
    Effect.catchTag("@smthrs/mvp/flows/StartConflict", () => Effect.void),
  )

/** What each `FlowExecution` alarm runs once it is done: its window's `ops/RunnerHealth`, once a window per isolate. */
export const sampler = Flows.startEachWindow(
  HEALTH_WINDOW,
  (window) => ({ flow: RunnerHealth, executionId: healthExecutionId(window), payload: window }),
  (errorCode) =>
    Effect.andThen(
      Metric.update(Metric.withAttributes(checks, { outcome: "not_started" }), 1),
      Effect.logError("runner.health").pipe(Effect.annotateLogs({ outcome: "not_started", errorCode })),
    ),
)
