import { AgentRunner, Transcript } from "@smthrs/agent"
import { digestSync, WebCrypto } from "@smthrs/crypto"
import { Cause, Clock, Crypto, Effect, type Layer, Metric, Option, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { SUMMARY_EVERY_SECONDS } from "../../src/features/transcript/contract.ts"
import { base64Bytes, LEASE_SECONDS, MAX_RUNNER_BODY_BYTES } from "../../src/features/runners/contract.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import { bearerOf } from "../RunCredentials.ts"
import * as Fleet from "./Fleet.ts"
import { Transcripts } from "./RunContent.ts"

// The runner routes (decision 0136, docs/features/agent-runners.md#the-runner-protocol): a runner machine pulls its
// jobs over HTTPS, so nothing calls into it. Each request carries the runner's own token as `Authorization: Bearer`; the
// route finds the registered, unremoved runner whose token has that SHA-256. Each route is one short transaction on
// `agent_jobs`, the external system the host's `ExternalAgent` step waits on durably: the routes start nothing and retry
// nothing.
//
// - `POST /api/runners/claim { profiles, free, running, waitSeconds }`: first a job the runner holds but didn't list
//   (it restarted), handed back with its claim, `reclaimed`; else, while it has room under its capacity, its
//   repository's oldest queued job for a profile it has, whose labels it carries, and pinned to no other runner,
//   claimed with a new claim id and a lease. With `minQueuedSeconds` (an overflow runner, decision 0144), only a job
//   claimable for that long: the route never asks which runners are held or full, so it stays the same for every
//   machine and vendor. With nothing queued it waits up to `waitSeconds`, asking again each second.
// - `POST /api/runners/heartbeat { key, claim, delivered? }`: renews the lease while the claim holds the job; `cancel`
//   when the host asked to stop it or its hours are up, `held: false` when the claim no longer holds it. While it holds,
//   the host's `steering` records the steers the runner says the agent read, then hands out those it hasn't yet
//   (docs/features/agent-runners.md#steering).
// - `POST /api/runners/settle { key, claim, outcome, delivered? }`: records how the job ended while the claim holds it,
//   and the steers the agent read since the last heartbeat that reported them. A change over the job's limits is
//   recorded `too_large`.
// - `POST /api/runners/events { key, claim, events }`: a job's transcript events (decision 0141), from the runner that
//   holds or held its claim, so the end of a settled job's transcript still arrives. Scrubbed again, they go to the
//   job's run's `RunContent` (`Transcripts`); the answer is the next `seq` that run lacks of the job's generation. The
//   job's row keeps when its first event arrived, and, at most every 30 seconds, its last and the run's totals.
//
// A lease that runs out doesn't free the job: a runner that stops answering may still be running its agent, so its job
// waits for it (docs/features/agent-runners.md#a-runner-that-stops-answering). Nothing here logs a token, the
// Authorization header, a prompt, a summary or a file: runner names, job keys and outcomes only.
//
// The fleet (docs/features/fleet.md): a request marks its runner seen, at most every `SEEN_EVERY_SECONDS` so a busy
// runner doesn't rewrite its synced row with each heartbeat, and closes its open Runner offline incident when it was
// away; a claim keeps the machine's facts, with why the runner holds back by its own admission rule (decision 0144), and
// marks the run Working; a heartbeat keeps the account label, the process
// tree's CPU seconds and the usage on the job, for the job store's probe to project; a settle ends the run.

/**
 * How long an agent's event took from the runner receiving it to the host storing it, in milliseconds: the
 * transcript's lag before any watcher's own network.
 */
export const eventLag = Metric.histogram("smithers_agent_event_lag_ms", {
  description: "Milliseconds from a runner receiving an agent's event to its run's transcript storing it",
  boundaries: [100, 250, 500, 1000, 2000, 3000, 5000, 10_000, 30_000, 60_000, 300_000],
})

/** Runner route requests, by `route` (`claim`, `heartbeat`, `settle`, `events`) and `outcome`. */
export const requests = Metric.counter("smithers_runner_requests", {
  description: "Requests to the runner routes, by route and outcome",
  incremental: true,
})

type Route = keyof typeof AgentRunner.ROUTES
type Fields = Record<string, string | number | boolean>

const ROUTE_OF: Readonly<Record<string, Route>> = {
  [AgentRunner.ROUTES.claim]: "claim",
  [AgentRunner.ROUTES.heartbeat]: "heartbeat",
  [AgentRunner.ROUTES.settle]: "settle",
  [AgentRunner.ROUTES.events]: "events",
  [AgentRunner.ROUTES.gitCredential]: "gitCredential",
}

/** The most often a runner's `seen_at` is written: the fleet reads Offline after 45 s unseen. */
export const SEEN_EVERY_SECONDS = 10

/** Whether a path is one of the runner routes. */
export const handles = (path: string): boolean => Object.hasOwn(ROUTE_OF, path)

const noStore = { "cache-control": "no-store" }

const decodeClaim = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.ClaimRequest))
const decodeHeartbeat = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.HeartbeatRequest))
const decodeSettle = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.SettleRequest))
const decodeEvents = Schema.decodeUnknownEffect(Schema.fromJsonString(Transcript.EventsRequest))
const decodeGitCredential = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.GitCredentialRequest))
const decodeTask = Schema.decodeUnknownEffect(AgentRunner.Task)
const scrubShapes = Transcript.scrubber()
const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

/** A fresh claim id. */
const newClaim = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4()).pipe(
  Effect.provide(WebCrypto.layer),
  Effect.orDie,
)

/**
 * The messages people send a job's agent, as the host keeps them: `pending` reads those the agent hasn't read yet,
 * oldest first, and `delivered` records the ones the runner says it read. Both are keyed by the job's task and key.
 */
export interface Steering<R> {
  readonly pending: (task: AgentRunner.Task) => Effect.Effect<ReadonlyArray<AgentRunner.Steer>, unknown, R>
  readonly delivered: (task: AgentRunner.Task, key: string, ids: ReadonlyArray<string>) => Effect.Effect<void, unknown, R>
}

/** A runner as its request authenticated it. */
interface Runner {
  readonly id: string
  readonly name: string
  readonly repoId: string
  readonly tokenSha256: string
}

/** A credential for git over HTTPS to one repository, and when it stops working (epoch ms). */
export interface GitCredential {
  readonly remote: string
  readonly username: string
  readonly password: Redacted.Redacted<string>
  readonly expiresAt: number
}

/** A claimed row, as the claim returns it. */
interface Claimed {
  readonly key: string
  readonly claim: string
  readonly generation: number
  readonly task: unknown
  readonly deadline: string
}

/** Whether a settled change fits its job's limits: its paths, and its added bytes. */
export const fits = (changes: AgentRunner.Changes, limits: AgentRunner.Limits): boolean =>
  changes.additions.length + changes.deletions.length <= limits.files &&
  changes.additions.reduce((sum, file) => sum + base64Bytes(file.contents), 0) <= limits.bytes

/** `request`'s body decoded by `decode`: the status to refuse with, else the value. */
const bodyOf = <A>(request: HttpServerRequest.HttpServerRequest, decode: (text: string) => Effect.Effect<A, unknown>) =>
  Effect.gen(function* () {
    const body = yield* readBounded(request, MAX_RUNNER_BODY_BYTES).pipe(Effect.result)
    if (body._tag === "Failure") {
      return { _tag: "Refused", status: body.failure.reason === "too_large" ? 413 : 400 } as const
    }
    const decoded = yield* decode(body.success).pipe(Effect.option)
    return Option.isNone(decoded) ? ({ _tag: "Refused", status: 400 } as const) : ({ _tag: "Read", value: decoded.value } as const)
  })

/**
 * The runner routes over `database`, which opens a Postgres client for each request's scope. A claim holds its job for
 * `leaseSeconds` past each heartbeat (`LEASE_SECONDS` unless set), and a claim asks again every `pollMillis` while it
 * waits (a second unless set). `onClaimed` runs once a runner holds a job, claimed or reclaimed, with its task: what the
 * host tells the job's own work item, such as a TODO that no longer waits for a runner. Its failure is logged by code
 * and never refuses the claim, whose job the runner already holds.
 */
export const make = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  options: {
    readonly leaseSeconds?: number
    readonly pollMillis?: number
    readonly onClaimed?: (task: AgentRunner.Task) => Effect.Effect<void, unknown, R>
    /** The run whose transcript a job's events belong to, from its task; none keeps no transcript. */
    readonly runOf: (task: AgentRunner.Task) => string | undefined
    readonly steering?: Steering<R>
    /**
     * A read-only credential for git over HTTPS to `repoId`, as the App mints it for that repository's contents alone
     * (decision 0148); `none` where the App isn't configured or installed there. Absent: the route answers `404`.
     */
    readonly gitCredential?: (repoId: string) => Effect.Effect<Option.Option<GitCredential>, unknown, R>
  },
) => {
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS
  const pollMillis = options.pollMillis ?? 1_000

  /** One request's records: a log line `runner.<route>`, its span's status, and a count. */
  const recorded = <RR>(route: Route, run: (fields: Fields) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, RR>) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const fields: Fields = {}
      const response = yield* run(fields)
      fields.status = response.status
      fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
      const outcome = String(fields.outcome ?? fields.code)
      yield* Metric.update(Metric.withAttributes(requests, { route, outcome }), 1)
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        `runner.${route}`,
      ).pipe(Effect.annotateLogs({ ...fields, outcome }))
      return response
    }).pipe(Effect.withSpan(`runner.${route}`, { kind: "server" }))

  const refuse = (fields: Fields, status: number, code: string) => {
    fields.code = code
    return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
  }

  const answer = (fields: Fields, outcome: string, body: unknown) => {
    fields.outcome = outcome
    return HttpServerResponse.jsonUnsafe(body, { headers: noStore })
  }

  /** The registered, unremoved runner whose token `request` carries, seen now. */
  const runnerOf = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const token = bearerOf(request)
      if (Option.isNone(token)) return Option.none<Runner>()
      const tokenSha256 = digestSync(token.value)
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ readonly id: string; readonly name: string; readonly repoId: string; readonly away: boolean }>`
        WITH found AS (
          SELECT id, name, repo_id, seen_at FROM runners WHERE token_sha256 = ${tokenSha256} AND removed_at IS NULL),
        touched AS (
          UPDATE runners r SET seen_at = now() FROM found
          WHERE r.id = found.id
            AND (found.seen_at IS NULL OR found.seen_at < now() - ${SEEN_EVERY_SECONDS}::int * interval '1 second')
          RETURNING r.id)
        SELECT id::text AS id, name, repo_id AS "repoId",
          coalesce(seen_at < now() - ${Fleet.UNREACHABLE_SECONDS}::int * interval '1 second', false) AS away
        FROM found`
      if (row === undefined) return Option.none<Runner>()
      // Back after an outage: its incident recovered.
      if (row.away) {
        yield* sql`UPDATE fleet_alerts SET closed_at = now() WHERE kind = 'offline' AND subject = ${row.id} AND closed_at IS NULL`
      }
      return Option.some({ id: row.id, name: row.name, repoId: row.repoId, tokenSha256 })
    })

  const claimed = `key, claim::text AS claim, generation, task,
    (extract(epoch FROM deadline_at) * 1000)::bigint::text AS deadline`

  /** A job the runner holds but didn't list as running: it restarted. Its lease is renewed. */
  const reclaim = (runner: Runner, running: ReadonlyArray<string>) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<Claimed>`
        UPDATE agent_jobs SET lease_until = now() + ${leaseSeconds}::int * interval '1 second', updated_at = now()
        WHERE key = (
          SELECT key FROM agent_jobs
          WHERE runner_id = ${runner.id}::uuid AND status = 'claimed'
            AND key <> ALL(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(running)}::jsonb)))
          ORDER BY claimed_at, key FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING ${sql.literal(claimed)}`).pipe(Effect.map((rows) => rows[0]))

  /**
   * Claims the oldest job the runner may take, now, among those claimable for at least `minQueuedSeconds`. The same
   * statement checks the runner's token still names it and that it has room under its registered capacity.
   */
  const claimOnce = (runner: Runner, claim: string, profiles: ReadonlyArray<string>, minQueuedSeconds: number) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<Claimed>`
        UPDATE agent_jobs SET status = 'claimed', claim = ${claim}::uuid, runner_id = ${runner.id}::uuid,
          lease_until = now() + ${leaseSeconds}::int * interval '1 second', claimed_at = now(), updated_at = now()
        WHERE key = (
          SELECT j.key FROM agent_jobs j, runners r
          WHERE r.id = ${runner.id}::uuid AND r.token_sha256 = ${runner.tokenSha256} AND r.removed_at IS NULL
            AND j.repo_id = r.repo_id AND j.status = 'queued' AND NOT j.cancel_requested
            AND j.profile = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(profiles)}::jsonb)))
            AND j.labels <@ r.labels
            AND (j.pinned_runner IS NULL OR j.pinned_runner = r.id)
            AND (j.not_before IS NULL OR j.not_before <= now()) AND j.deadline_at > now()
            AND greatest(j.created_at, coalesce(j.not_before, j.created_at))
              <= now() - ${minQueuedSeconds}::int * interval '1 second'
            AND (SELECT count(*) FROM agent_jobs h WHERE h.runner_id = r.id AND h.status = 'claimed') < r.capacity
          ORDER BY j.created_at, j.key FOR UPDATE OF j SKIP LOCKED LIMIT 1)
        RETURNING ${sql.literal(claimed)}`).pipe(Effect.map((rows) => rows[0]))

  /** `POST /api/runners/claim`. */
  const claim = (request: HttpServerRequest.HttpServerRequest, runner: Runner, fields: Fields) =>
    Effect.gen(function* () {
      const wants = yield* bodyOf(request, decodeClaim)
      if (wants._tag === "Refused") return refuse(fields, wants.status, "invalid")
      const job = (row: Claimed, reclaimed: boolean) =>
        Effect.gen(function* () {
          const task = yield* decodeTask(row.task).pipe(Effect.orDie)
          fields.key = row.key
          fields.generation = row.generation
          fields.agent = task.agent.name
          // The run reads Working at once; a failure here leaves that to the job's next probe, never refuses the claim.
          yield* Fleet.claimed(row.key, runner.name).pipe(
            Effect.provide(database),
            Effect.catchCause((cause) => Effect.sync(() => void (fields.fleet = codeOf(Cause.squash(cause))))),
          )
          const job: AgentRunner.Job = {
            key: row.key,
            claim: row.claim,
            generation: row.generation,
            task,
            deadline: Number(row.deadline),
            leaseSeconds,
            reclaimed,
          }
          if (options.onClaimed !== undefined) {
            const failed = (error: unknown) =>
              Effect.sync(() => {
                fields.onClaimed = codeOf(error)
              })
            yield* options.onClaimed(task).pipe(Effect.catch(failed), Effect.catchDefect(failed))
          }
          return answer(fields, reclaimed ? "reclaimed" : "claimed", { job })
        })
      const machine = wants.value.machine
      if (machine !== undefined) {
        // Rounded, so a claim that changes nothing a person reads doesn't rewrite the synced row.
        const load1 = machine.load1 === undefined ? null : Math.round(machine.load1 * 10) / 10
        const disk = machine.diskFreeGb === undefined ? null : Math.round(machine.diskFreeGb)
        yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`
            UPDATE runners SET version = ${machine.version ?? null}, load1 = ${load1}, disk_free_gb = ${disk},
              held = ${machine.held ?? null}
            WHERE id = ${runner.id}::uuid
              AND (version, load1, disk_free_gb, held) IS DISTINCT FROM
                (${machine.version ?? null}::text, ${load1}::float8, ${disk}::float8, ${machine.held ?? null}::text)`
        ).pipe(Effect.provide(database))
      }
      const held = yield* reclaim(runner, wants.value.running).pipe(Effect.provide(database))
      if (held !== undefined) return yield* job(held, true)
      const deadline = (yield* Clock.currentTimeMillis) + wants.value.waitSeconds * 1000
      while (wants.value.free > 0) {
        const row = yield* claimOnce(runner, yield* newClaim, wants.value.profiles, wants.value.minQueuedSeconds ?? 0).pipe(Effect.provide(database))
        if (row !== undefined) return yield* job(row, false)
        const left = deadline - (yield* Clock.currentTimeMillis)
        if (left <= 0) break
        yield* Effect.sleep(Math.min(pollMillis, left))
      }
      return answer(fields, "empty", { job: null })
    })

  /** `POST /api/runners/heartbeat`. */
  const heartbeat = (request: HttpServerRequest.HttpServerRequest, runner: Runner, fields: Fields) =>
    Effect.gen(function* () {
      const beat = yield* bodyOf(request, decodeHeartbeat)
      if (beat._tag === "Refused") return refuse(fields, beat.status, "invalid")
      fields.key = beat.value.key
      const sql = yield* SqlClient.SqlClient
      // A lease that ran out still holds the job: the runner came back.
      const [row] = isUuid(beat.value.claim)
        ? yield* sql<{ readonly cancel: boolean; readonly task: unknown }>`
          UPDATE agent_jobs SET lease_until = now() + ${leaseSeconds}::int * interval '1 second', updated_at = now(),
            account_label = coalesce(${beat.value.account ?? null}, account_label),
            cpu_seconds = coalesce(${beat.value.cpuSeconds ?? null}::float8, cpu_seconds),
            usage = coalesce(${beat.value.usage === undefined ? null : JSON.stringify(beat.value.usage)}::jsonb, usage)
          WHERE key = ${beat.value.key} AND claim = ${beat.value.claim}::uuid AND runner_id = ${runner.id}::uuid
            AND status = 'claimed'
          RETURNING (cancel_requested OR deadline_at <= now()) AS cancel, task`
        : []
      const outcome = row === undefined ? "not_held" : row.cancel ? "cancel" : "held"
      if (row === undefined) return answer(fields, outcome, { held: false, cancel: false, leaseSeconds })
      const steers = row.cancel || options.steering === undefined
        ? []
        : yield* exchange(options.steering, row.task, beat.value.key, beat.value.delivered ?? [], fields)
      return answer(fields, outcome, {
        held: true,
        cancel: row.cancel,
        leaseSeconds,
        ...(steers.length === 0 ? {} : { steers }),
      })
    }).pipe(Effect.provide(database))

  /**
   * Records the steers the runner says its agent read, then reads those it hasn't. A failure is logged by code and
   * hands out nothing: the lease is renewed all the same, and the runner says the same again at its next heartbeat.
   */
  const exchange = (
    steering: Steering<R>,
    stored: unknown,
    key: string,
    delivered: ReadonlyArray<string>,
    fields: Fields,
  ) =>
    Effect.gen(function* () {
      const task = yield* decodeTask(stored).pipe(Effect.orDie)
      if (delivered.length > 0) {
        yield* steering.delivered(task, key, delivered)
        fields.delivered = delivered.length
      }
      const pending = yield* steering.pending(task)
      if (pending.length > 0) fields.steers = pending.length
      return pending
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          fields.steering = codeOf(Cause.squash(cause))
          return [] as ReadonlyArray<AgentRunner.Steer>
        })
      ),
    )

  /** `POST /api/runners/settle`. */
  const settle = (request: HttpServerRequest.HttpServerRequest, runner: Runner, fields: Fields) =>
    Effect.gen(function* () {
      const settled = yield* bodyOf(request, decodeSettle)
      if (settled._tag === "Refused") return refuse(fields, settled.status, "invalid")
      const { key, claim } = settled.value
      fields.key = key
      if (!isUuid(claim)) return answer(fields, "not_held", { recorded: false })
      const sql = yield* SqlClient.SqlClient
      return yield* sql.withTransaction(Effect.gen(function* () {
        const [row] = yield* sql<{ readonly task: unknown; readonly cancelRequested: boolean }>`
          SELECT task, cancel_requested AS "cancelRequested" FROM agent_jobs
          WHERE key = ${key} AND claim = ${claim}::uuid AND runner_id = ${runner.id}::uuid AND status = 'claimed'
          FOR UPDATE`
        if (row === undefined) return answer(fields, "not_held", { recorded: false })
        const task = yield* decodeTask(row.task).pipe(Effect.orDie)
        let outcome = settled.value.outcome
        if (outcome._tag === "Done" && !fits(outcome.changes, task.limits)) outcome = { _tag: "Failed", reason: "too_large" }
        // A retryable end of a job the host asked to stop ends it cancelled.
        if (outcome._tag === "Retryable" && row.cancelRequested) outcome = { _tag: "Cancelled", processTreeGone: true }
        const status = outcome._tag === "Retryable" ? "retryable" : outcome._tag.toLowerCase()
        fields.result = outcome._tag === "Failed" ? `failed:${outcome.reason}` : status
        yield* sql`
          UPDATE agent_jobs SET status = ${status}, outcome = ${JSON.stringify(outcome)}::jsonb, claim = NULL,
            lease_until = NULL, settled_at = now(), updated_at = now()
          WHERE key = ${key}`
        yield* Fleet.settled(key, outcome)
        const delivered = settled.value.delivered ?? []
        if (delivered.length > 0 && options.steering !== undefined) {
          // Recorded with the settlement's claim still checked; a failure is logged and never refuses the settlement.
          yield* options.steering.delivered(task, key, delivered).pipe(
            Effect.tap(() => Effect.sync(() => (fields.delivered = delivered.length))),
            Effect.catchCause((cause) => Effect.sync(() => (fields.steering = codeOf(Cause.squash(cause))))),
          )
        }
        return answer(fields, "recorded", { recorded: true })
      }))
    }).pipe(Effect.provide(database))

  /** `POST /api/runners/events`. */
  const events = (request: HttpServerRequest.HttpServerRequest, runner: Runner, fields: Fields) =>
    Effect.gen(function* () {
      const sent = yield* bodyOf(request, decodeEvents)
      if (sent._tag === "Refused") return refuse(fields, sent.status, "invalid")
      const { key } = sent.value
      fields.key = key
      fields.events = sent.value.events.length
      const sql = yield* SqlClient.SqlClient
      // The runner that holds or held the job's claim: its settlement may come before its last events.
      const [row] = yield* sql<{ readonly task: unknown; readonly generation: number }>`
        SELECT task, generation FROM agent_jobs WHERE key = ${key} AND runner_id = ${runner.id}::uuid`
      if (row === undefined) return refuse(fields, 409, "not_held")
      const task = yield* decodeTask(row.task).pipe(Effect.orDie)
      const runId = options.runOf(task)
      if (runId === undefined) return refuse(fields, 409, "no_transcript")
      // Scrubbed again (OBS-5). An event the runner should have dropped or split is refused, not kept.
      const scrubbed: Array<Transcript.Event> = []
      for (const event of sent.value.events) {
        const pieces = Transcript.prepare(event.kind, event.update, scrubShapes)
        if (pieces.length !== 1) return refuse(fields, 400, "invalid")
        scrubbed.push({ ...event, update: pieces[0]!.update })
      }
      const transcripts = yield* Transcripts
      const appended = yield* transcripts.append(runId, row.generation, scrubbed)
      const now = yield* Clock.currentTimeMillis
      for (const event of scrubbed) yield* Metric.update(eventLag, Math.max(0, now - event.at))
      if (scrubbed.length > 0) {
        yield* sql`
          UPDATE agent_jobs SET
            first_event_at = COALESCE(first_event_at, now()),
            last_event_at = now(), transcript_events = ${appended.summary.events},
            transcript_bytes = ${appended.summary.bytes}
          WHERE key = ${key} AND (last_event_at IS NULL
            OR last_event_at <= now() - ${SUMMARY_EVERY_SECONDS}::int * interval '1 second')`
      }
      fields.next = appended.next
      return answer(fields, "stored", { next: appended.next })
    }).pipe(Effect.provide(database))

  /**
   * `POST /api/runners/git-credential { key, claim }` (decision 0148): for a job this runner holds now, a read-only
   * credential for its repository, which must be the one the runner is registered on. Never logged: the record names
   * the job and the outcome only.
   */
  const gitCredential = (request: HttpServerRequest.HttpServerRequest, runner: Runner, fields: Fields) =>
    Effect.gen(function* () {
      const asked = yield* bodyOf(request, decodeGitCredential)
      if (asked._tag === "Refused") return refuse(fields, asked.status, "invalid")
      fields.key = asked.value.key
      if (options.gitCredential === undefined) return refuse(fields, 404, "not_configured")
      const sql = yield* SqlClient.SqlClient
      const [row] = isUuid(asked.value.claim)
        ? yield* sql<{ readonly task: unknown }>`
          SELECT task FROM agent_jobs
          WHERE key = ${asked.value.key} AND claim = ${asked.value.claim}::uuid AND runner_id = ${runner.id}::uuid
            AND status = 'claimed' AND deadline_at > now()`
        : []
      if (row === undefined) return refuse(fields, 409, "not_held")
      const task = yield* decodeTask(row.task).pipe(Effect.option)
      // A runner reads only the repository it is registered on, whatever a task names.
      if (Option.isNone(task) || task.value.repository !== runner.repoId) return refuse(fields, 403, "other_repository")
      const credential = yield* options.gitCredential(runner.repoId)
      if (Option.isNone(credential)) return refuse(fields, 404, "app_not_installed")
      return answer(fields, "issued", {
        remote: credential.value.remote,
        username: credential.value.username,
        password: Redacted.value(credential.value.password),
        expiresAt: credential.value.expiresAt,
      })
    }).pipe(Effect.provide(database))

  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const route = ROUTE_OF[request.url.split("?")[0]!]!
    return yield* recorded(route, (fields) =>
      Effect.gen(function* () {
        if (request.method !== "POST") {
          fields.code = "method"
          return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        }
        const runner = yield* runnerOf(request).pipe(Effect.provide(database))
        if (Option.isNone(runner)) return refuse(fields, 401, "authentication")
        fields.runner = runner.value.name
        return yield* (route === "claim"
          ? claim(request, runner.value, fields)
          : route === "heartbeat"
          ? heartbeat(request, runner.value, fields)
          : route === "settle"
          ? settle(request, runner.value, fields)
          : route === "gitCredential"
          ? gitCredential(request, runner.value, fields)
          : events(request, runner.value, fields))
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            fields.errorCode = codeOf(error)
            return refuse(fields, 503, "unavailable")
          })
        ),
      ))
  })

  return { fetch }
}
