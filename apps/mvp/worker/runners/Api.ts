import { AgentRunner, Transcript } from "@smthrs/agent"
import { digestSync, WebCrypto } from "@smthrs/crypto"
import { Cause, Clock, Effect, type Layer, Metric, Option, Redacted, Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { base64Bytes, LEASE_SECONDS, MAX_RUNNER_BODY_BYTES } from "../../src/features/runners/contract.ts"
import { SUMMARY_EVERY_SECONDS } from "../../src/features/transcript/contract.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import { bearerOf } from "../RunCredentials.ts"
import * as Fleet from "./Fleet.ts"
import { SETTLE_GRACE_SECONDS } from "./Jobs.ts"
import { Transcripts } from "./RunContent.ts"

// The runner routes (decision 0136, docs/features/agent-runners.md#the-runner-protocol): a runner machine pulls its
// jobs over HTTPS, so nothing calls into it. Each request carries the runner's own token as `Authorization: Bearer`; the
// route finds the registered, unremoved runner whose token has that SHA-256. Each route is one short transaction on
// `agent_jobs`, the external system the host's `ExternalAgent` step waits on durably: the routes start nothing and retry
// nothing.
//
// - `POST /api/runners/claim { profiles, free, running, waitSeconds }`: `403 not_authorized` for a runner no
//   registration through the repository's Admin role authorized (decision 0148): it needs registering again. Else first a
//   job the runner holds but didn't list (it restarted), handed back with its claim, `reclaimed`; else, while it has room under its capacity, its
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
// Every route that acts for a job (claim, reclaim, heartbeat, settle, events, git-credential) does so only while the
// runner is current: its token still names it, it is unremoved, a registration through its repository's Admin role
// authorized it, and Smithers records the App's installation there (decision 0148). Each holds that in its transaction
// (`lockCurrent`: the runner's row, then the installation's, `FOR SHARE`, before the job's), so a revocation that
// commits first is seen and one that comes later waits for the operation. Else `403 not_authorized`.
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
  boundaries: [100, 250, 500, 1000, 2000, 3000, 5000, 10_000, 30_000, 60_000, 300_000]
})

/** Runner route requests, by `route` (`claim`, `heartbeat`, `settle`, `events`) and `outcome`. */
export const requests = Metric.counter("smithers_runner_requests", {
  description: "Requests to the runner routes, by route and outcome",
  incremental: true
})

type Route = keyof typeof AgentRunner.ROUTES
type Fields = Record<string, string | number | boolean>

const ROUTE_OF: Readonly<Record<string, Route>> = {
  [AgentRunner.ROUTES.claim]: "claim",
  [AgentRunner.ROUTES.heartbeat]: "heartbeat",
  [AgentRunner.ROUTES.settle]: "settle",
  [AgentRunner.ROUTES.events]: "events",
  [AgentRunner.ROUTES.gitCredential]: "gitCredential"
}

/** The most often a runner's `seen_at` is written: the fleet reads Offline after 45 s unseen. */
export const SEEN_EVERY_SECONDS = 10

/** Whether a path is one of the runner routes. */
export const handles = (path: string): boolean => Object.hasOwn(ROUTE_OF, path)

const noStore = { "cache-control": "no-store" }

/**
 * Whether ChatApi wires the git-credential route to the App (decision 0148). Off until the security review of its
 * fixes passes; off, the route answers `404 not_configured` and the runner fetches without a credential.
 */
export const GIT_CREDENTIAL_ON = false

/**
 * The least time between two mints for one job, issued or failed: a runner reuses a credential until it nears its end
 * (decision 0148), and a failed mint waits at least this long, or GitHub's own wait when longer.
 */
export const CREDENTIAL_GAP_SECONDS = 30

/** The longest the route waits for GitHub to mint one; then the mint is given up and its reservation released. */
export const MINT_TIMEOUT_SECONDS = 20

/**
 * How long a job's mint in flight keeps another from starting. A reservation older than this belongs to a request
 * that died; another may take it over, and the old one's late answer is revoked, never delivered.
 */
export const RESERVATION_SECONDS = 60

const TIMEOUT: AgentRunner.Outcome = { _tag: "Failed", reason: "timeout" }

/** A job the host stopped for a runner it no longer takes: whether its processes are gone, the runner hasn't said. */
const STOPPED: AgentRunner.Outcome = { _tag: "Cancelled", processTreeGone: false }

/** The most credentials one job's runner is handed in an hour (decision 0148). */
export const CREDENTIALS_PER_HOUR = 3

const decodeClaim = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.ClaimRequest))
const decodeHeartbeat = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.HeartbeatRequest))
const decodeSettle = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.SettleRequest))
const decodeEvents = Schema.decodeUnknownEffect(Schema.fromJsonString(Transcript.EventsRequest))
const decodeGitCredential = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunner.GitCredentialRequest))
const decodeTask = Schema.decodeUnknownEffect(AgentRunner.Task)
const scrubShapes = Transcript.scrubber()
const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

/** A fresh claim id. */
const newClaim = SecureRandom.SecureRandom.use((random) => random.uuidV4()).pipe(
  Effect.provide(WebCrypto.layer),
  Effect.orDie
)

/**
 * The messages people send a job's agent, as the host keeps them: `pending` reads those the agent hasn't read yet,
 * oldest first, and `delivered` records the ones the runner says it read. Both are keyed by the job's task and key.
 */
export interface Steering<R> {
  readonly pending: (task: AgentRunner.Task) => Effect.Effect<ReadonlyArray<AgentRunner.Steer>, unknown, R>
  readonly delivered: (
    task: AgentRunner.Task,
    key: string,
    ids: ReadonlyArray<string>
  ) => Effect.Effect<void, unknown, R>
}

/** A runner as its request authenticated it. */
interface Runner {
  readonly id: string
  readonly name: string
  readonly repoId: string
  readonly tokenSha256: string
  /** Whether an Admin of its repository, by the role GitHub gives there, registered it (decision 0148). */
  readonly authorized: boolean
}

/** A credential for git over HTTPS to one repository, and when it stops working (epoch ms). */
export interface GitCredential {
  readonly remote: string
  readonly username: string
  readonly password: Redacted.Redacted<string>
  readonly expiresAt: number
}

/**
 * The App's read credentials (decision 0148): `mint` makes one for a repository's contents alone, `none` where the App
 * isn't configured or installed there; `revoke` ends one the route won't deliver, and never fails.
 */
export interface GitCredentials<R> {
  readonly mint: (repoId: string) => Effect.Effect<Option.Option<GitCredential>, unknown, R>
  readonly revoke: (credential: GitCredential) => Effect.Effect<void, never, R>
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
  Effect.gen(function*() {
    const body = yield* readBounded(request, MAX_RUNNER_BODY_BYTES).pipe(Effect.result)
    if (body._tag === "Failure") {
      return { _tag: "Refused", status: body.failure.reason === "too_large" ? 413 : 400 } as const
    }
    const decoded = yield* decode(body.success).pipe(Effect.option)
    return Option.isNone(decoded)
      ? ({ _tag: "Refused", status: 400 } as const)
      : ({ _tag: "Read", value: decoded.value } as const)
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
    readonly gitCredential?: GitCredentials<R>
  }
) => {
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS
  const pollMillis = options.pollMillis ?? 1_000

  /** One request's records: a log line `runner.<route>`, its span's status, and a count. */
  const recorded = <RR>(
    route: Route,
    run: (fields: Fields) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, RR>
  ) =>
    Effect.gen(function*() {
      const startedAt = yield* Clock.currentTimeMillis
      const fields: Fields = {}
      const response = yield* run(fields)
      fields.status = response.status
      fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
      const outcome = String(fields.outcome ?? fields.code)
      yield* Metric.update(Metric.withAttributes(requests, { route, outcome }), 1)
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        `runner.${route}`
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
    Effect.gen(function*() {
      const token = bearerOf(request)
      if (Option.isNone(token)) return Option.none<Runner>()
      const tokenSha256 = digestSync(token.value)
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{
        readonly id: string
        readonly name: string
        readonly repoId: string
        readonly away: boolean
        readonly authorized: boolean
      }>`
        WITH found AS (
          SELECT id, name, repo_id, seen_at, repo_authorized_at FROM runners
          WHERE token_sha256 = ${tokenSha256} AND removed_at IS NULL),
        touched AS (
          UPDATE runners r SET seen_at = now() FROM found
          WHERE r.id = found.id
            AND (found.seen_at IS NULL OR found.seen_at < now() - ${SEEN_EVERY_SECONDS}::int * interval '1 second')
          RETURNING r.id)
        SELECT id::text AS id, name, repo_id AS "repoId", repo_authorized_at IS NOT NULL AS authorized,
          coalesce(seen_at < now() - ${Fleet.UNREACHABLE_SECONDS}::int * interval '1 second', false) AS away
        FROM found`
      if (row === undefined) return Option.none<Runner>()
      // Back after an outage: its incident recovered.
      if (row.away) {
        yield* sql`UPDATE fleet_alerts SET closed_at = now() WHERE kind = 'offline' AND subject = ${row.id} AND closed_at IS NULL`
      }
      return Option.some({ id: row.id, name: row.name, repoId: row.repoId, tokenSha256, authorized: row.authorized })
    })

  /**
   * Whether `runner` is current, as a claim requires (decision 0148), held so until the transaction ends: its row is
   * locked `FOR SHARE` where its token still names it, it is unremoved and authorized, then its repository's
   * installation row where Smithers records one, in that order in every route. A rotation, retirement, clearing or
   * forgotten installation that committed while this waited is seen (Postgres checks a locked row again), and one that
   * comes after waits until the operation commits. Must run inside a transaction, before the operation's own locks.
   */
  const lockCurrent = (runner: Runner, lock: "share" | "write" = "share") =>
    Effect.map(standing(runner, lock), (held) => held === "current")

  /** `lockCurrent`, saying what failed: the runner itself (rotated, retired, cleared) or its repository's installation. */
  const standing = (runner: Runner, lock: "share" | "write" = "share") =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.gen(function*() {
        // A transaction that goes on to update the row takes the write lock now: two that upgraded a shared one would
        // each wait on the other.
        const [held] = yield* sql`
          SELECT 1 FROM runners
          WHERE id = ${runner.id}::uuid AND token_sha256 = ${runner.tokenSha256} AND removed_at IS NULL
            AND repo_authorized_at IS NOT NULL
          ${sql.literal(lock === "write" ? "FOR NO KEY UPDATE" : "FOR SHARE")}`
        if (held === undefined) return "runner" as const
        const [installed] = yield* sql`
          SELECT 1 FROM github_repositories WHERE repo_id = ${runner.repoId} AND installation_id IS NOT NULL FOR SHARE`
        return installed === undefined ? "installation" as const : "current" as const
      }))

  /**
   * Ends the runner's claimed jobs past their deadline and the host's grace to settle them (`SETTLE_GRACE_SECONDS`)
   * as `timeout`, as the job store's probe does: a claim or reclaim never hands one back, and none counts against the
   * runner's capacity, whether or not the probe ran (decision 0148). Inside the claim's transaction.
   */
  const expireOverdue = (runner: Runner) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.gen(function*() {
        const expired = yield* sql<{ readonly key: string }>`
          UPDATE agent_jobs SET status = 'failed', outcome = ${JSON.stringify(TIMEOUT)}::jsonb,
            claim = NULL, lease_until = NULL, cancel_requested = true, settled_at = now(), updated_at = now()
          WHERE runner_id = ${runner.id}::uuid AND status = 'claimed'
            AND deadline_at + ${SETTLE_GRACE_SECONDS}::int * interval '1 second' <= now()
          RETURNING key`
        for (const { key } of expired) yield* Fleet.settled(key, TIMEOUT)
      }))

  const claimed = `key, claim::text AS claim, generation, task,
    (extract(epoch FROM deadline_at) * 1000)::bigint::text AS deadline`

  /**
   * A job the runner holds but didn't list as running: it restarted. Its lease is renewed. The same statement checks
   * what a claim does (`claimOnce`): the runner's token still names it, it is unremoved and authorized, and Smithers
   * recorded the App's installation on its repository (decision 0148).
   */
  const reclaim = (runner: Runner, running: ReadonlyArray<string>) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.gen(function*() {
        if (!(yield* lockCurrent(runner))) return undefined
        yield* expireOverdue(runner)
        return yield* sql<Claimed>`
        UPDATE agent_jobs SET lease_until = now() + ${leaseSeconds}::int * interval '1 second', updated_at = now(),
          claimed_token_sha256 = ${runner.tokenSha256}
        WHERE key = (
          SELECT j.key FROM agent_jobs j, runners r
          WHERE r.id = ${runner.id}::uuid AND r.token_sha256 = ${runner.tokenSha256} AND r.removed_at IS NULL
            AND r.repo_authorized_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM github_repositories g WHERE g.repo_id = r.repo_id AND g.installation_id IS NOT NULL)
            AND j.runner_id = r.id AND j.status = 'claimed'
            AND j.key <> ALL(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(running)}::jsonb)))
          ORDER BY j.claimed_at, j.key FOR UPDATE OF j SKIP LOCKED LIMIT 1)
        RETURNING ${sql.literal(claimed)}`.pipe(Effect.map((rows) => rows[0]))
      })))

  /**
   * Claims the oldest job the runner may take, now, among those claimable for at least `minQueuedSeconds`. The same
   * statement checks the runner's token still names it, that it has room under its registered capacity, that an Admin
   * of its repository registered it by GitHub's role, and that Smithers recorded the App's installation on its
   * repository (decision 0148). It holds the runner's row's write lock, so the runner's claims count its claimed jobs
   * one at a time, each after the last committed: two at once never take more than its capacity.
   */
  const claimOnce = (runner: Runner, claim: string, profiles: ReadonlyArray<string>, minQueuedSeconds: number) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.gen(function*() {
        if (!(yield* lockCurrent(runner, "write"))) return undefined
        yield* expireOverdue(runner)
        return yield* sql<Claimed>`
        UPDATE agent_jobs SET status = 'claimed', claim = ${claim}::uuid, runner_id = ${runner.id}::uuid,
          claimed_token_sha256 = ${runner.tokenSha256},
          lease_until = now() + ${leaseSeconds}::int * interval '1 second', claimed_at = now(), updated_at = now()
        WHERE key = (
          SELECT j.key FROM agent_jobs j, runners r
          WHERE r.id = ${runner.id}::uuid AND r.token_sha256 = ${runner.tokenSha256} AND r.removed_at IS NULL
            AND r.repo_authorized_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM github_repositories g WHERE g.repo_id = r.repo_id AND g.installation_id IS NOT NULL)
            AND j.repo_id = r.repo_id AND j.status = 'queued' AND NOT j.cancel_requested
            AND j.profile = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(profiles)}::jsonb)))
            AND j.labels <@ r.labels
            AND (j.pinned_runner IS NULL OR j.pinned_runner = r.id)
            AND (j.not_before IS NULL OR j.not_before <= now()) AND j.deadline_at > now()
            AND greatest(j.created_at, coalesce(j.not_before, j.created_at))
              <= now() - ${minQueuedSeconds}::int * interval '1 second'
            AND (SELECT count(*) FROM agent_jobs h WHERE h.runner_id = r.id AND h.status = 'claimed') < r.capacity
          ORDER BY j.created_at, j.key FOR UPDATE OF j SKIP LOCKED LIMIT 1)
        RETURNING ${sql.literal(claimed)}`.pipe(Effect.map((rows) => rows[0]))
      })))

  /** `POST /api/runners/claim`. */
  const claim = (request: HttpServerRequest.HttpServerRequest, runner: Runner, fields: Fields) =>
    Effect.gen(function*() {
      const wants = yield* bodyOf(request, decodeClaim)
      if (wants._tag === "Refused") return refuse(fields, wants.status, "invalid")
      // No registration through the repository's Admin role authorized it: it needs registering again (decision 0148).
      if (!runner.authorized) return refuse(fields, 403, "not_authorized")
      const job = (row: Claimed, reclaimed: boolean) =>
        Effect.gen(function*() {
          const task = yield* decodeTask(row.task).pipe(Effect.orDie)
          fields.key = row.key
          fields.generation = row.generation
          fields.agent = task.agent.name
          // The run reads Working at once; a failure here leaves that to the job's next probe, never refuses the claim.
          yield* Fleet.claimed(row.key, runner.name).pipe(
            Effect.provide(database),
            Effect.catchCause((cause) => Effect.sync(() => void (fields.fleet = codeOf(Cause.squash(cause)))))
          )
          const job: AgentRunner.Job = {
            key: row.key,
            claim: row.claim,
            generation: row.generation,
            task,
            deadline: Number(row.deadline),
            leaseSeconds,
            reclaimed
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
      // A runner no longer current, its repository's installation forgotten included, hears why rather than an empty
      // answer, and records nothing: the check and its machine facts are one transaction, holding it current.
      const current = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(Effect.gen(function*() {
          if (!(yield* lockCurrent(runner, machine === undefined ? "share" : "write"))) return false
          if (machine === undefined) return true
          // Rounded, so a claim that changes nothing a person reads doesn't rewrite the synced row.
          const load1 = machine.load1 === undefined ? null : Math.round(machine.load1 * 10) / 10
          const disk = machine.diskFreeGb === undefined ? null : Math.round(machine.diskFreeGb)
          yield* sql`
            UPDATE runners SET version = ${machine.version ?? null}, load1 = ${load1}, disk_free_gb = ${disk},
              held = ${machine.held ?? null}
            WHERE id = ${runner.id}::uuid
              AND (version, load1, disk_free_gb, held) IS DISTINCT FROM
                (${machine.version ?? null}::text, ${load1}::float8, ${disk}::float8, ${machine.held ?? null}::text)`
          return true
        }))).pipe(Effect.provide(database))
      if (!current) return refuse(fields, 403, "not_authorized")
      const held = yield* reclaim(runner, wants.value.running).pipe(Effect.provide(database))
      if (held !== undefined) return yield* job(held, true)
      const deadline = (yield* Clock.currentTimeMillis) + wants.value.waitSeconds * 1000
      while (wants.value.free > 0) {
        const row = yield* claimOnce(runner, yield* newClaim, wants.value.profiles, wants.value.minQueuedSeconds ?? 0)
          .pipe(Effect.provide(database))
        if (row !== undefined) return yield* job(row, false)
        const left = deadline - (yield* Clock.currentTimeMillis)
        if (left <= 0) break
        yield* Effect.sleep(Math.min(pollMillis, left))
      }
      // Its authorization may have ended while it waited: a claim that found nothing says so, never an empty answer.
      const still = yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(lockCurrent(runner))).pipe(
        Effect.provide(database)
      )
      if (!still) return refuse(fields, 403, "not_authorized")
      return answer(fields, "empty", { job: null })
    })

  /** `POST /api/runners/heartbeat`. */
  const heartbeat = (request: HttpServerRequest.HttpServerRequest, runner: Runner, fields: Fields) =>
    Effect.gen(function*() {
      const beat = yield* bodyOf(request, decodeHeartbeat)
      if (beat._tag === "Refused") return refuse(fields, beat.status, "invalid")
      fields.key = beat.value.key
      const sql = yield* SqlClient.SqlClient
      // One transaction, the runner held current through it (decision 0148): the lease, and the steers handed out.
      return yield* sql.withTransaction(Effect.gen(function*() {
        if (!(yield* lockCurrent(runner))) {
          // Not current: no lease and no steers. One thing only reaches the runner, for its own claim: a Stop. The host
          // ends that job cancelled itself and says `cancel`, so the runner stops it and frees its slot (decision 0148).
          // The claim is kept as `stopped_claim`, so a heartbeat whose answer was lost hears `cancel` again.
          if (!isUuid(beat.value.claim)) return refuse(fields, 403, "not_authorized")
          const [stopped] = yield* sql<{ readonly key: string }>`
            UPDATE agent_jobs SET status = 'cancelled', outcome = ${JSON.stringify(STOPPED)}::jsonb, claim = NULL,
              stopped_claim = claim, lease_until = NULL, settled_at = now(), updated_at = now()
            WHERE key = ${beat.value.key} AND claim = ${beat.value.claim}::uuid AND runner_id = ${runner.id}::uuid
              AND status = 'claimed' AND cancel_requested
            RETURNING key`
          if (stopped !== undefined) yield* Fleet.settled(stopped.key, STOPPED)
          const [told] = stopped !== undefined ? [stopped] : yield* sql`
            SELECT key FROM agent_jobs
            WHERE key = ${beat.value.key} AND stopped_claim = ${beat.value.claim}::uuid
              AND runner_id = ${runner.id}::uuid AND status = 'cancelled'`
          if (told === undefined) return refuse(fields, 403, "not_authorized")
          fields.code = "not_authorized"
          fields.outcome = "cancelled"
          return HttpServerResponse.jsonUnsafe({ code: "not_authorized", cancel: true }, {
            status: 403,
            headers: noStore
          })
        }
        // A lease that ran out still holds the job: the runner came back.
        const [row] = isUuid(beat.value.claim)
          ? yield* sql<{ readonly cancel: boolean; readonly task: unknown }>`
            UPDATE agent_jobs SET lease_until = now() + ${leaseSeconds}::int * interval '1 second', updated_at = now(),
              account_label = coalesce(${beat.value.account ?? null}, account_label),
              cpu_seconds = coalesce(${beat.value.cpuSeconds ?? null}::float8, cpu_seconds),
              usage = coalesce(${
            beat.value.usage === undefined ? null : JSON.stringify(beat.value.usage)
          }::jsonb, usage),
              claimed_token_sha256 = coalesce(claimed_token_sha256, ${runner.tokenSha256})
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
          ...(steers.length === 0 ? {} : { steers })
        })
      }))
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
    fields: Fields
  ) =>
    Effect.gen(function*() {
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
      )
    )

  /** `POST /api/runners/settle`. */
  const settle = (request: HttpServerRequest.HttpServerRequest, runner: Runner, fields: Fields) =>
    Effect.gen(function*() {
      const settled = yield* bodyOf(request, decodeSettle)
      if (settled._tag === "Refused") return refuse(fields, settled.status, "invalid")
      const { key, claim } = settled.value
      fields.key = key
      if (!isUuid(claim)) return answer(fields, "not_held", { recorded: false })
      const sql = yield* SqlClient.SqlClient
      return yield* sql.withTransaction(Effect.gen(function*() {
        // Recorded only while the runner is current, as a claim requires, held so until it commits (decision 0148).
        if (!(yield* lockCurrent(runner))) return refuse(fields, 403, "not_authorized")
        const [row] = yield* sql<{ readonly task: unknown; readonly cancelRequested: boolean }>`
          SELECT task, cancel_requested AS "cancelRequested" FROM agent_jobs
          WHERE key = ${key} AND claim = ${claim}::uuid AND runner_id = ${runner.id}::uuid AND status = 'claimed'
          FOR UPDATE`
        if (row === undefined) return answer(fields, "not_held", { recorded: false })
        const task = yield* decodeTask(row.task).pipe(Effect.orDie)
        let outcome = settled.value.outcome
        if (outcome._tag === "Done" && !fits(outcome.changes, task.limits)) {
          outcome = { _tag: "Failed", reason: "too_large" }
        }
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
            Effect.catchCause((cause) => Effect.sync(() => (fields.steering = codeOf(Cause.squash(cause)))))
          )
        }
        return answer(fields, "recorded", { recorded: true })
      }))
    }).pipe(Effect.provide(database))

  /** `POST /api/runners/events`. */
  const events = (request: HttpServerRequest.HttpServerRequest, runner: Runner, fields: Fields) =>
    Effect.gen(function*() {
      const sent = yield* bodyOf(request, decodeEvents)
      if (sent._tag === "Refused") return refuse(fields, sent.status, "invalid")
      const { key } = sent.value
      fields.key = key
      fields.events = sent.value.events.length
      const sql = yield* SqlClient.SqlClient
      // One transaction, the runner held current through it, the transcript's append included (decision 0148).
      return yield* sql.withTransaction(Effect.gen(function*() {
        if (!(yield* lockCurrent(runner))) return refuse(fields, 403, "not_authorized")
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
      }))
    }).pipe(Effect.provide(database))

  /**
   * `POST /api/runners/git-credential { key, claim }` (decision 0148): for a job this runner holds now, a read-only
   * credential for its repository, which must be the one the runner is registered on.
   *
   * Issuance is bounded per job on its row. A mint starts only with no other in flight (`RESERVATION_SECONDS`), at least
   * `CREDENTIAL_GAP_SECONDS` after the last one started, after the wait a failed one set (GitHub's, when longer), and
   * under `CREDENTIALS_PER_HOUR` issued in the hour; else `429` with `retry-after`. The request reserves the mint under its
   * own id, and only that id finalizes or releases it: a success counts in the same statement that checks the hold again
   * (a job settled, a runner retired, unauthorized or uninstalled, or a deadline passed meanwhile gets no credential, and
   * the minted one is revoked); a failure releases the reservation and sets the wait, touching no other mint's record.
   * Never logged: the record names the job and the outcome only.
   */
  const gitCredential = (request: HttpServerRequest.HttpServerRequest, runner: Runner, fields: Fields) =>
    Effect.gen(function*() {
      const asked = yield* bodyOf(request, decodeGitCredential)
      if (asked._tag === "Refused") return refuse(fields, asked.status, "invalid")
      fields.key = asked.value.key
      const credentials = options.gitCredential
      if (credentials === undefined) return refuse(fields, 404, "not_configured")
      if (!isUuid(asked.value.claim)) return refuse(fields, 409, "not_held")
      const sql = yield* SqlClient.SqlClient
      const { key, claim } = asked.value
      const reservation = yield* newClaim
      const busy = (retryAfter: number, code = "busy", status = 429) => {
        const wait = Math.min(3600, Math.max(1, Math.ceil(retryAfter)))
        fields.code = code
        fields.retryAfter = wait
        return HttpServerResponse.jsonUnsafe({ code }, { status, headers: { ...noStore, "retry-after": String(wait) } })
      }
      // One transaction on the job's row, the runner held current through it: the hold, and the reservation of its one
      // mint.
      const reserved = yield* sql.withTransaction(Effect.gen(function*() {
        const held = yield* standing(runner)
        // Rotated, retired or cleared since the request authenticated: refused as such, never `not_held`.
        if (held === "runner") return { _tag: "NotAuthorized" } as const
        const [row] = yield* sql<{
          readonly task: unknown
          readonly tokenSha256: string
          readonly authorized: boolean
          readonly installed: boolean
          readonly count: number
          readonly sinceSeconds: number | null
          readonly lastSeconds: number | null
          readonly retrySeconds: number | null
          readonly reservedSeconds: number | null
        }>`
          SELECT j.task, r.token_sha256 AS "tokenSha256", r.repo_authorized_at IS NOT NULL AS authorized,
            EXISTS (SELECT 1 FROM github_repositories g WHERE g.repo_id = r.repo_id AND g.installation_id IS NOT NULL)
              AS installed,
            j.git_credentials AS count,
            extract(epoch FROM clock_timestamp() - j.git_credentials_since)::float8 AS "sinceSeconds",
            extract(epoch FROM clock_timestamp() - j.git_credential_at)::float8 AS "lastSeconds",
            extract(epoch FROM j.git_credential_retry_at - clock_timestamp())::float8 AS "retrySeconds",
            CASE WHEN j.git_credential_reservation IS NOT NULL
              THEN extract(epoch FROM clock_timestamp() - j.git_credential_reserved_at)::float8 END AS "reservedSeconds"
          FROM agent_jobs j JOIN runners r ON r.id = j.runner_id
          WHERE j.key = ${key} AND j.claim = ${claim}::uuid AND r.id = ${runner.id}::uuid AND j.status = 'claimed'
            AND j.deadline_at > now() AND r.removed_at IS NULL
          FOR UPDATE OF j`
        if (row === undefined || row.tokenSha256 !== runner.tokenSha256) return { _tag: "NotHeld" } as const
        const task = yield* decodeTask(row.task).pipe(Effect.option)
        // A runner reads only the repository it is registered on, whatever a task names.
        if (Option.isNone(task) || task.value.repository !== runner.repoId) return { _tag: "OtherRepository" } as const
        // Not registered by an Admin of the repository through the route that proves it: registered again first.
        if (!row.authorized) return { _tag: "NotAuthorized" } as const
        // Asked before the installation is recorded, minting would discover and record it: never here.
        if (!row.installed) return { _tag: "NotInstalled" } as const
        const count = row.sinceSeconds === null || row.sinceSeconds >= 3600 ? 0 : row.count
        if (count >= CREDENTIALS_PER_HOUR) return { _tag: "Busy", retryAfter: 3600 - row.sinceSeconds! } as const
        // A mint started under the gap ago, in flight or not; then one in flight longer, until it goes stale.
        if (row.lastSeconds !== null && row.lastSeconds < CREDENTIAL_GAP_SECONDS) {
          return { _tag: "Busy", retryAfter: CREDENTIAL_GAP_SECONDS - row.lastSeconds } as const
        }
        if (row.reservedSeconds !== null && row.reservedSeconds < RESERVATION_SECONDS) {
          return { _tag: "Busy", retryAfter: RESERVATION_SECONDS - row.reservedSeconds } as const
        }
        if (row.retrySeconds !== null && row.retrySeconds > 0) {
          return { _tag: "Busy", retryAfter: row.retrySeconds } as const
        }
        yield* sql`
          UPDATE agent_jobs SET git_credential_reservation = ${reservation}::uuid,
            git_credential_reserved_at = clock_timestamp(), git_credential_at = clock_timestamp()
          WHERE key = ${key}`
        return { _tag: "Reserved" } as const
      }))
      switch (reserved._tag) {
        case "NotHeld":
          return refuse(fields, 409, "not_held")
        case "OtherRepository":
          return refuse(fields, 403, "other_repository")
        case "NotAuthorized":
          return refuse(fields, 403, "not_authorized")
        case "NotInstalled":
          return refuse(fields, 404, "app_not_installed")
        case "Busy":
          return busy(reserved.retryAfter)
      }
      /** This request's reservation released, with the next mint not before `waitSeconds` from now. */
      const release = (waitSeconds: number) =>
        sql`
          UPDATE agent_jobs SET git_credential_reservation = NULL, git_credential_reserved_at = NULL,
            git_credential_retry_at = clock_timestamp() + ${waitSeconds}::float8 * interval '1 second'
          WHERE key = ${key} AND git_credential_reservation = ${reservation}::uuid`
      // A request that dies here leaves its reservation, which goes stale after `RESERVATION_SECONDS`. A mint that
      // succeeds at GitHub after the timeout is never read, so it can't be revoked; GitHub ends it within the hour
      // (decision 0148).
      const minted = yield* Effect.exit(
        credentials.mint(runner.repoId).pipe(Effect.timeout(MINT_TIMEOUT_SECONDS * 1000))
      )
      if (minted._tag === "Failure") {
        // GitHub's wait when it said one, never less than the gap: a failing GitHub is asked at most that often.
        const error = Cause.findErrorOption(minted.cause)
        const said = Option.isSome(error) && typeof error.value === "object" && error.value !== null &&
            typeof (error.value as { readonly retryAfterMillis?: unknown }).retryAfterMillis === "number"
          ? (error.value as { readonly retryAfterMillis: number }).retryAfterMillis / 1000
          : 0
        const wait = Math.min(3600, Math.ceil(Math.max(CREDENTIAL_GAP_SECONDS, said)))
        yield* release(wait)
        fields.errorCode = codeOf(Cause.squash(minted.cause))
        return busy(wait, "unavailable", 503)
      }
      if (Option.isNone(minted.value)) {
        yield* release(0)
        return refuse(fields, 404, "app_not_installed")
      }
      const credential = minted.value.value
      // Counted in the statement that checks the hold again, with the runner held current until it commits (decision
      // 0148): settled, retired, unauthorized, uninstalled or past its deadline while GitHub minted, or this
      // reservation taken over, and the credential is never delivered.
      const finalized = yield* sql.withTransaction(Effect.gen(function*() {
        if (!(yield* lockCurrent(runner))) return { current: false, issued: false }
        // The job's row too, then the time read now (`clock_timestamp()`, not the transaction's start): a lock waited on
        // across the deadline issues nothing.
        yield* sql`SELECT 1 FROM agent_jobs WHERE key = ${key} FOR UPDATE`
        const rows = yield* sql`
        UPDATE agent_jobs j SET
          git_credentials = CASE WHEN j.git_credentials_since IS NULL
            OR j.git_credentials_since <= clock_timestamp() - interval '1 hour' THEN 1 ELSE j.git_credentials + 1 END,
          git_credentials_since = CASE WHEN j.git_credentials_since IS NULL
            OR j.git_credentials_since <= clock_timestamp() - interval '1 hour' THEN clock_timestamp()
            ELSE j.git_credentials_since END,
          git_credential_reservation = NULL, git_credential_reserved_at = NULL
        FROM runners r
        WHERE j.key = ${key} AND j.claim = ${claim}::uuid AND j.git_credential_reservation = ${reservation}::uuid
          AND r.id = j.runner_id AND r.id = ${runner.id}::uuid AND r.token_sha256 = ${runner.tokenSha256}
          AND r.removed_at IS NULL AND r.repo_authorized_at IS NOT NULL
          AND j.status = 'claimed' AND j.deadline_at > clock_timestamp()
          AND EXISTS (SELECT 1 FROM github_repositories g WHERE g.repo_id = r.repo_id AND g.installation_id IS NOT NULL)
        RETURNING 1`
        return { current: true, issued: rows.length > 0 }
      }))
      if (!finalized.issued) {
        yield* credentials.revoke(credential)
        fields.revoked = true
        // The runner lost its authorization while GitHub minted: refused as such, so it waits to be registered again
        // rather than taking its job for lost.
        if (!finalized.current) {
          yield* release(CREDENTIAL_GAP_SECONDS)
          return refuse(fields, 403, "not_authorized")
        }
        yield* release(CREDENTIAL_GAP_SECONDS)
        // Which refusal, decided again under the runner's locks, since the revoke took time: no longer current is
        // `not_authorized`; still held is another request's reservation (this one waits its turn); else `not_held`.
        const after = yield* sql.withTransaction(Effect.gen(function*() {
          if (!(yield* lockCurrent(runner))) return "not_authorized" as const
          const [mine] = yield* sql`
            SELECT 1 FROM agent_jobs
            WHERE key = ${key} AND claim = ${claim}::uuid AND runner_id = ${runner.id}::uuid AND status = 'claimed'
              AND deadline_at > clock_timestamp()`
          return mine === undefined ? "not_held" as const : "busy" as const
        }))
        if (after === "not_authorized") return refuse(fields, 403, "not_authorized")
        return after === "not_held" ? refuse(fields, 409, "not_held") : busy(CREDENTIAL_GAP_SECONDS)
      }
      return answer(fields, "issued", {
        remote: credential.remote,
        username: credential.username,
        password: Redacted.value(credential.password),
        expiresAt: credential.expiresAt
      })
    }).pipe(Effect.provide(database))

  /**
   * A heartbeat whose token names no runner now, but claimed the job it names (`claimed_token_sha256`): its token was
   * rotated or its runner retired since. If a Stop was asked for that job, the host ends it `Cancelled` (keeping the
   * claim as `stopped_claim`, so a lost answer is said again) and answers `401 { cancel: true }`, so the runner stops it
   * and frees its slot. Anything else is `401 authentication`: no lease, steers or other work (decision 0148).
   */
  const stopForPastToken = (request: HttpServerRequest.HttpServerRequest, fields: Fields) =>
    Effect.gen(function*() {
      const token = bearerOf(request)
      const beat = Option.isNone(token) ? undefined : yield* bodyOf(request, decodeHeartbeat)
      if (Option.isNone(token) || beat === undefined || beat._tag === "Refused" || !isUuid(beat.value.claim)) {
        return refuse(fields, 401, "authentication")
      }
      const digest = digestSync(token.value)
      const sql = yield* SqlClient.SqlClient
      const told = yield* sql.withTransaction(Effect.gen(function*() {
        const [stopped] = yield* sql<{ readonly key: string }>`
          UPDATE agent_jobs SET status = 'cancelled', outcome = ${JSON.stringify(STOPPED)}::jsonb, claim = NULL,
            stopped_claim = claim, lease_until = NULL, settled_at = now(), updated_at = now()
          WHERE key = ${beat.value.key} AND claim = ${beat.value.claim}::uuid AND claimed_token_sha256 = ${digest}
            AND status = 'claimed' AND cancel_requested
          RETURNING key`
        if (stopped !== undefined) {
          yield* Fleet.settled(stopped.key, STOPPED)
          return true
        }
        const [again] = yield* sql`
          SELECT 1 FROM agent_jobs
          WHERE key = ${beat.value.key} AND stopped_claim = ${beat.value.claim}::uuid AND claimed_token_sha256 = ${digest}
            AND status = 'cancelled'`
        return again !== undefined
      }))
      if (!told) return refuse(fields, 401, "authentication")
      fields.key = beat.value.key
      fields.code = "authentication"
      fields.outcome = "cancelled"
      return HttpServerResponse.jsonUnsafe({ code: "authentication", cancel: true }, { status: 401, headers: noStore })
    }).pipe(Effect.provide(database))

  const fetch = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const route = ROUTE_OF[request.url.split("?")[0]!]!
    return yield* recorded(route, (fields) =>
      Effect.gen(function*() {
        if (request.method !== "POST") {
          fields.code = "method"
          return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        }
        const runner = yield* runnerOf(request).pipe(Effect.provide(database))
        if (Option.isNone(runner)) {
          // A token rotated or retired since it claimed a job still hears a Stop on that job's heartbeat, and nothing
          // else (decision 0148).
          if (route === "heartbeat") return yield* stopForPastToken(request, fields)
          return refuse(fields, 401, "authentication")
        }
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
        )
      ))
  })

  return { fetch }
}
