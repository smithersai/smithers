import { digestSync } from "@smthrs/crypto"
import { Action, Flow, Interpreter, RetryPolicy, Sleep } from "@smthrs/flow"
import { Core, GitHub } from "@smthrs/integrations"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"
import { bearerOf } from "../RunCredentials.ts"
import type { Services } from "./Apply.ts"
import { withToken } from "./Calls.ts"
import { repositoryOf } from "./Config.ts"
import { fetchIssue, project } from "./Project.ts"

// Machine writes (docs/features/machine-tokens.md): an agent, with a machine token and no person, opens or updates an
// issue, comments or files a sub-issue. The route records the write in `machine_writes` and starts the owner's one
// `github/MachineDispatch`, which writes as the App with an installation token (`issues: write`), so the bot is the
// author. It shares nothing with `github/Write`: a person's write, and any `github/Write` in flight, is untouched.
//
// `machine_writes` is the queue. One dispatcher per owner loops: a durable sleep, one tick, the next round. A tick looks
// at the hold first, takes the oldest pending write, checks its authority again, and makes at most one mutation, so one
// send runs at a time and the next waits 7.5 s from its end (under 480 an hour and 8 a minute; GitHub's limits are 500
// and 80, checked 2026-11-02). A rate limit on any call, read or write, holds every call until the server's full wait or
// the penalty, 60 s doubling to 30 minutes and back after a success; a limit on minting a token does too. A 403 is a rate limit only with
// `x-ratelimit-remaining: 0`, `retry-after` or GitHub's message; any other is a refusal, never retried. A write that
// can't finish settles `failed`, and `POST .../writes/<id>/retry` puts it back in the queue, its marker keeping it one
// issue.

/** What a machine token's prefix says: only such a bearer ever costs a lookup. */
export const TOKEN_PREFIX = "smm_"

/** The acts a machine token may be scoped to. Everything else on smithers.sh never reads one: no session, 401. */
export const MACHINE_SCOPES = ["issue/create", "issue/update", "issue/comment", "issue/relate", "work/link"] as const
export type MachineScope = (typeof MACHINE_SCOPES)[number]

const SPACING_MS = 7_500
const MAX_PENALTY_MS = 30 * 60_000
/** A read that failed for no named reason tries again after this. */
const READ_RETRY_MS = 30_000
/** Real tries a write gets, rate limits aside, before it settles `failed`. Waiting in the queue spends none. */
export const MAX_TRIES = 20
/** How many pending writes one token may have, however they became pending. */
export const MAX_BACKLOG = 20
/** A dispatcher this far past when it said it would wake is gone: the next request starts another epoch. */
const LEASE_MINUTES = 10

/** The agent a request's bearer names on `repoId`: a live token, unexpired and unrevoked, with its scope. */
export interface Machine {
  readonly agent: string
  readonly lane: string
  readonly scope: ReadonlyArray<string>
  readonly tokenSha256: string
}

export const machineOf = (request: HttpServerRequest.HttpServerRequest, repoId: string) =>
  Effect.gen(function* () {
    const token = bearerOf(request)
    if (Option.isNone(token) || !token.value.startsWith(TOKEN_PREFIX)) return Option.none<Machine>()
    const sql = yield* SqlClient.SqlClient
    const digest = digestSync(token.value)
    const [row] = yield* sql<Omit<Machine, "tokenSha256">>`
      SELECT agent, lane, scope FROM machine_tokens
      WHERE token_sha256 = ${digest} AND repo_id = ${repoId} AND revoked_at IS NULL AND expires_at > now()`
    return Option.map(Option.fromNullishOr(row), (found): Machine => ({ ...found, tokenSha256: digest }))
  })

/** Whether a request carries a machine token at all, for a route that must not read it as anything else. */
export const carriesMachineToken = (request: HttpServerRequest.HttpServerRequest) =>
  Option.exists(bearerOf(request), (token) => token.startsWith(TOKEN_PREFIX))

const Title = Schema.String.check(Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= 256))
const Text = Schema.String.check(Schema.isMaxLength(65_000))
const Number_ = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }))
const WriteId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))
const Label = Schema.String.check(Schema.makeFilter((value: string) => value.length >= 1 && value.length <= 50))

/** What a machine may ask. */
export const MachineBody = Schema.Union([
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("issue/create"), title: Title, body: Text, labels: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(20))) }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("issue/update"), number: Number_, title: Schema.optional(Title), body: Schema.optional(Text), state: Schema.optional(Schema.Literals(["open", "closed"])) }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("issue/comment"), number: Number_, body: Text.check(Schema.isMinLength(1)) }),
  Schema.Struct({
    writeId: WriteId,
    op: Schema.Literal("issue/relate"),
    number: Number_,
    parent: Schema.Struct({ repo: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)), number: Number_ }),
  }),
])
export type MachineBody = typeof MachineBody.Type
const decodeRaw = Schema.decodeUnknownOption(Schema.fromJsonString(MachineBody))
/** The body, with its write id in canonical lower case: casing never makes a second write, execution or marker. */
export const decodeBody = (text: string) => Option.map(decodeRaw(text), (body): MachineBody => ({ ...body, writeId: body.writeId.toLowerCase() }))

/**
 * A label a person's act or a flow owns: triage and commitment state are read from `smithers:` labels
 * (`triageOf`, `commitmentOf`), and a machine setting one would be deciding what decision 0016 keeps a person's.
 */
export const isReservedLabel = (label: string) => label.trim().toLowerCase().startsWith("smithers:")

// No leading `\\b`: Markdown's `_smm_…_` puts a word character right before a token.
const CREDENTIAL_SHAPES: ReadonlyArray<RegExp> = [
  /smm_[A-Za-z0-9_-]{8,}/i,
  /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/,
  /sk-[A-Za-z0-9_-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /(?:xox[abpr]-|glpat-)[A-Za-z0-9-]{10,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /(?:authorization|bearer|token|secret|password|api[_-]?key)(?:\s*[:=]\s*|\s+)["']?[A-Za-z0-9_./+=-]{12,}/i,
]
const HOME_PATH = /(?<![\w.~/-])(?:\/(?:Users|home)\/[A-Za-z0-9._-]+|~\/[A-Za-z0-9._-])/

/** `text` with percent escapes and numeric HTML entities decoded, as a link or a page renders it. Never throws. */
export const renderedForms = (text: string): ReadonlyArray<string> => {
  const forms = [text]
  let current = text
  for (let round = 0; round < 3; round++) {
    const next = current
      .replace(/%[0-9a-f]{2}/gi, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))
      .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, code: string) => {
        const point = code[0]!.toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number(code)
        return point <= 0x10ffff ? String.fromCodePoint(point) : ""
      })
    if (next === current) break
    forms.push(next)
    current = next
  }
  return forms
}

/**
 * The public-content rule at the server: what a machine posts is public, so credential-shaped text and home paths are
 * refused, as written and as rendered, whatever client sent them. Names the kind, never the text.
 */
export const publicContentProblem = (texts: ReadonlyArray<string | null | undefined>): "credential" | "home_path" | undefined => {
  for (const text of texts) {
    if (text === null || text === undefined) continue
    for (const form of renderedForms(text)) {
      if (CREDENTIAL_SHAPES.some((shape) => shape.test(form))) return "credential"
      if (HOME_PATH.test(form)) return "home_path"
    }
  }
  return undefined
}

/** The refusal a body earns before it reaches the database, or nothing. */
export const refusalOf = (body: MachineBody): "reserved_label" | "credential" | "home_path" | undefined => {
  if (body.op === "issue/create" && (body.labels ?? []).some(isReservedLabel)) return "reserved_label"
  return publicContentProblem([
    "title" in body ? body.title : undefined,
    "body" in body ? body.body : undefined,
    ...(body.op === "issue/create" ? body.labels ?? [] : []),
  ])
}

/** Whether `token` is live on `repoId`, in scope for `op`, with a lock on its row that serializes its backlog. */
const tokenHeld = (tokenSha256: string, repoId: string, op: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(sql`
      SELECT 1 FROM machine_tokens
      WHERE token_sha256 = ${tokenSha256} AND repo_id = ${repoId} AND revoked_at IS NULL AND expires_at > now() AND ${op} = ANY(scope)
      FOR UPDATE`, (rows) => rows.length > 0))

/** Whether this agent and lane hold a live `issue/relate` token on the parent's repository. Its own repository needs none. */
const parentHeld = (agent: string, lane: string, repoId: string, parentRepo: string | undefined) =>
  parentRepo === undefined || repositoryOf(parentRepo).id === repoId
    ? Effect.succeed(true)
    : Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.map(sql`
        SELECT 1 FROM machine_tokens
        WHERE repo_id = ${repositoryOf(parentRepo).id} AND agent = ${agent} AND lane = ${lane} AND revoked_at IS NULL AND expires_at > now()
          AND 'issue/relate' = ANY(scope)
        LIMIT 1 FOR SHARE`, (rows) => rows.length > 0))

/** The one test before any transition into `pending`, with `tokenHeld`'s lock taken. */
const hasRoom = (tokenSha256: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(sql<{ readonly pending: number }>`
      SELECT count(*)::int AS pending FROM machine_writes WHERE token_sha256 = ${tokenSha256} AND status = 'pending'`,
      (rows) => rows[0]!.pending < MAX_BACKLOG))

/**
 * Records the write in one transaction that first holds the token live, in scope, after the request's body has arrived:
 * an already-open request can't outlive a revocation. Answers the one already there when its repository, agent, lane and
 * payload match; any other is `conflict`.
 */
export const admit = (write: { readonly repoId: string; readonly owner: string; readonly machine: Machine; readonly body: MachineBody }) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      const { writeId, ...payload } = write.body
      const { agent, lane, tokenSha256 } = write.machine
      if (!(yield* tokenHeld(tokenSha256, write.repoId, write.body.op))) return { kind: "token" } as const
      const parentRepo = write.body.op === "issue/relate" ? write.body.parent.repo : undefined
      if (!(yield* parentHeld(agent, lane, write.repoId, parentRepo))) return { kind: "parent" } as const
      const hash = digestSync(JSON.stringify(payload))
      const [found] = yield* sql<{ readonly repoId: string; readonly agent: string; readonly lane: string; readonly hash: string; readonly status: string }>`
        SELECT repo_id AS "repoId", agent, lane, payload_hash AS hash, status FROM machine_writes WHERE id = ${writeId}::uuid`
      if (found !== undefined) {
        return found.repoId !== write.repoId || found.agent !== agent || found.lane !== lane || found.hash !== hash
          ? ({ kind: "conflict" } as const)
          : ({ kind: "existing", status: found.status } as const)
      }
      if (!(yield* hasRoom(tokenSha256))) return { kind: "backlog" } as const
      const [inserted] = yield* sql<{ readonly id: string }>`
        INSERT INTO machine_writes (id, repo_id, owner, token_sha256, agent, lane, op, payload, payload_hash)
        VALUES (${writeId}::uuid, ${write.repoId}, ${write.owner}, ${tokenSha256}, ${agent}, ${lane}, ${write.body.op}, ${JSON.stringify(payload)}::jsonb, ${hash})
        ON CONFLICT (id) DO NOTHING RETURNING id::text`
      return inserted === undefined ? ({ kind: "conflict" } as const) : ({ kind: "inserted" } as const)
    })))

/** A write as the agent and lane that made it may read it: its status and the issue number. */
export const statusOf = (id: string, repoId: string, machine: Machine) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly status: string; readonly failure: string | null; readonly number: number | null }>`
      SELECT status, failure, item_number AS number FROM machine_writes
      WHERE id = ${id}::uuid AND repo_id = ${repoId} AND agent = ${machine.agent} AND lane = ${machine.lane}`
    return Option.fromNullishOr(row)
  })

/**
 * The deliberate way back from `failed`: the agent and lane that made the write put it at the back of the queue, under
 * the requesting token, which must be live, in scope for the write's op and hold room, as must its parent's repository,
 * which the deployment must still act on (`mayAct`).
 * It is still one issue: a tick finds its marker before it POSTs. A write already pending answers `pending`, so a request
 * whose start was lost can be made again.
 */
export const retry = (id: string, repoId: string, machine: Machine, mayAct: (id: string) => boolean) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.gen(function* () {
      const [write] = yield* sql<{ readonly op: string; readonly status: string; readonly payload: { readonly parent?: { readonly repo: string } } }>`
        SELECT op, status, payload FROM machine_writes
        WHERE id = ${id}::uuid AND repo_id = ${repoId} AND agent = ${machine.agent} AND lane = ${machine.lane}
        FOR UPDATE`
      if (write === undefined || (write.status !== "failed" && write.status !== "pending")) return "conflict" as const
      if (!(yield* tokenHeld(machine.tokenSha256, repoId, write.op))) return "forbidden" as const
      if (!(yield* parentHeld(machine.agent, machine.lane, repoId, write.payload.parent?.repo))) return "forbidden" as const
      if (write.payload.parent !== undefined && !mayAct(repositoryOf(write.payload.parent.repo).id)) return "forbidden" as const
      if (write.status === "pending") return "pending" as const
      if (!(yield* hasRoom(machine.tokenSha256))) return "backlog" as const
      yield* sql`
        UPDATE machine_writes SET status = 'pending', failure = NULL, settled_at = NULL, tries = 0, queued_at = clock_timestamp(),
          token_sha256 = ${machine.tokenSha256}
        WHERE id = ${id}::uuid`
      return "pending" as const
    })))

// ── The owner's dispatcher ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The epoch of the dispatcher `owner` should have running: the current one, or a new one when none runs or the one that
 * does is long past when it said it would wake. Starting that epoch's execution id twice starts one run, so any request
 * can make good a start that was lost.
 */
export const launch = (owner: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO machine_dispatch (owner) VALUES (${owner}) ON CONFLICT (owner) DO NOTHING`
    const [row] = yield* sql<{ readonly epoch: number }>`
      UPDATE machine_dispatch SET
        epoch = CASE WHEN running AND due_at > clock_timestamp() - make_interval(mins => ${LEASE_MINUTES}) THEN epoch ELSE epoch + 1 END,
        due_at = CASE WHEN running AND due_at > clock_timestamp() - make_interval(mins => ${LEASE_MINUTES}) THEN due_at ELSE clock_timestamp() END,
        running = true
      WHERE owner = ${owner}
      RETURNING epoch`
    return row!.epoch
  })

/** The dispatcher's execution id for an epoch. */
export const dispatchExecutionId = (owner: string, epoch: number) => `github-machine-dispatch:${owner}:${epoch}`

/** The first round's payload. */
export const dispatchPayload = (owner: string, epoch: number) => ({ owner, epoch, round: 0, waitMs: 0 })

/** Notes a rate limit: every call waits until the server's full wait or the penalty, and the penalty doubles. */
const noteLimited = (owner: string, hintMs: number | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      UPDATE machine_dispatch
      SET next_at = GREATEST(next_at, clock_timestamp() + make_interval(secs => GREATEST(${hintMs ?? 0}::double precision, penalty_ms) / 1000)),
        penalty_ms = LEAST(penalty_ms * 2, ${MAX_PENALTY_MS})
      WHERE owner = ${owner}`
  })

/** Holds the next call for at least `ms` from now. */
const holdFor = (owner: string, ms: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE machine_dispatch SET next_at = GREATEST(next_at, clock_timestamp() + make_interval(secs => ${ms / 1000})) WHERE owner = ${owner}`
  })

// ── One GitHub mutation ─────────────────────────────────────────────────────────────────────────────────────────

/** What a GitHub answer means: done, a limit to wait out, an outage to try again, or a refusal for good. */
export const readAnswer = (status: number, headers: Headers, body: unknown, nowMs: number):
  | { readonly kind: "ok" }
  | { readonly kind: "limited"; readonly hintMs: number | null }
  | { readonly kind: "outage" }
  | { readonly kind: "refused"; readonly failure: string } => {
  if (status >= 200 && status < 300) return { kind: "ok" }
  const message = typeof body === "object" && body !== null && "message" in body ? String((body as { message: unknown }).message).toLowerCase() : ""
  const remaining = headers.get("x-ratelimit-remaining")
  const limited = status === 429 ||
    (status === 403 && (headers.has("retry-after") || remaining === "0" || message.includes("rate limit") || message.includes("abuse")))
  if (limited) {
    const retryAfter = headers.get("retry-after")
    if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) return { kind: "limited", hintMs: Number(retryAfter) * 1000 }
    const reset = headers.get("x-ratelimit-reset")
    const wait = remaining === "0" && reset !== null && /^\d+$/.test(reset.trim()) ? Number(reset) * 1000 - nowMs : 0
    return { kind: "limited", hintMs: wait > 0 ? wait : null }
  }
  if (status >= 500 || status === 401) return { kind: "outage" }
  return { kind: "refused", failure: status === 404 || status === 410 ? "not_found" : status === 422 ? "invalid" : "not_allowed" }
}

/** One call to GitHub with `token`, answering its status, headers and JSON: never retried, nothing capped. */
const call = <E, R>(services: Services<E, R>, http: HttpClient.HttpClient, token: Redacted.Redacted<string>, method: "GET" | "POST" | "PATCH", path: string, body?: unknown) =>
  Effect.gen(function* () {
    const base = HttpClientRequest.make(method)(`${services.apiBaseUrl}${path}`).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${Redacted.value(token)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      }),
    )
    const request = body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body)
    const response = yield* HttpClient.execute(request)
    const json: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => undefined))
    return { status: response.status, headers: new Headers(response.headers as Record<string, string>), json }
  }).pipe(Effect.provideService(HttpClient.HttpClient, http))

// ── The flow ────────────────────────────────────────────────────────────────────────────────────────────────────

export class MachineUnavailable extends Schema.TaggedError<MachineUnavailable>()("@smthrs/mvp/github/MachineUnavailable", {}) {}

const Cursor = Schema.Struct({ owner: Schema.String, epoch: Schema.Number, round: Schema.Number, waitMs: Schema.Number })
const Outcome = Schema.Struct({
  /** The queue is empty, or another epoch took over. */
  stop: Schema.Boolean,
  /** How long the next round sleeps. */
  waitMs: Schema.Number,
})

const implementationVersion = "github-machine-dispatch/v1"

/** One tick: at most one mutation. Cut off, it runs again, and finds its own write first. Postgres failing retries for good. */
export const Tick = Action.make("github/MachineDispatch/tick", {
  payload: Cursor,
  success: Outcome,
  error: MachineUnavailable,
  implementationVersion,
  tier: "irreversible",
  idempotencyKey: ({ owner, epoch, round }) => ({ owner, epoch, round }),
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})

const Stopped = Schema.Struct({ rounds: Schema.Number })
const DispatchError = Schema.Union([MachineUnavailable, Sleep.SleepRequestInvalid])

type DispatchFlow = Flow.Flow<
  "github/MachineDispatch",
  typeof Cursor,
  typeof Stopped,
  typeof DispatchError,
  Action.Requirement<(typeof Tick)["name"]>
>

/** `github/MachineDispatch`: a durable sleep, one tick; the next round, until the queue is empty. */
export const MachineDispatch: DispatchFlow = Flow.make("github/MachineDispatch", {
  description: "Make one owner's admitted machine writes on GitHub as the App, one tick at a time.",
  capabilities: ["db:write:machine_writes", "db:write:machine_dispatch", "db:write:items", "db:write:comments"],
  modelInvocable: false,
  payload: Cursor,
  success: Stopped,
  error: DispatchError,
  body: Node.capture({ tick: Tick.name, implementationVersion }, (cursor: typeof Cursor.Type) =>
    Sleep.action.call({ millis: cursor.waitMs }).pipe(
      Node.andThen(Tick.call(cursor)),
      Node.branch({
        if: Node.capture({ implementationVersion }, (outcome: typeof Outcome.Type) => outcome.stop),
        then: Node.capture({ implementationVersion }, () => Flow.done({ rounds: cursor.round + 1 })),
        else: Node.capture({ implementationVersion }, (outcome) => MachineDispatch.to({ ...cursor, round: cursor.round + 1, waitMs: outcome.waitMs })),
      }),
    )),
})

interface Row {
  readonly id: string
  /** The marker this write leaves on GitHub, which only the server knows before it is written. */
  readonly recoveryId: string
  /** Admission order. */
  readonly seq: string
  readonly repoId: string
  readonly tokenSha256: string
  readonly agent: string
  readonly lane: string
  readonly op: MachineBody["op"]
  readonly payload: Record<string, unknown>
  readonly itemNumber: number | null
  readonly tries: number
  readonly createdAt: string
}

/** What a create or comment's send came to: made, with its number and GitHub's answer, or not made this time. */
type Sent = { readonly made: true; readonly number: number; readonly json: unknown } | { readonly made: false }

/** What an `issue/update` may set, each on its own: a newer update takes over only the fields it set. */
const UPDATE_FIELDS = ["title", "body", "state"] as const

/** GitHub's client failing a call: no verdict on the write, unlike Postgres failing. */
const integrationFailure = (error: unknown) =>
  (error instanceof Error && error.name === "IntegrationError") || Core.IntegrationError.isIntegrationError(error)

/** The steps over `services`. They record ids and outcomes: never a title, a body, or a token. */
export const steps = <E, R>(services: Services<E, R>) => {
  /** This App's login on GitHub, which the host read once at start. */
  const appLogin = services.appLogin
  /** Whether GitHub names this App as the author. */
  const byThisApp = (user: { readonly login?: string | null | undefined } | null | undefined) => user?.login === appLogin

  const settle = (id: string, status: "done" | "refused" | "failed", failure: string | null, number: number | null) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      UPDATE machine_writes SET status = ${status}, failure = ${failure}, item_number = COALESCE(${number}, item_number), settled_at = now()
      WHERE id = ${id}::uuid AND status = 'pending'`)

  /** The one write this tick handles. Every GitHub answer passes `observed`, so a limit on any call is heard. */
  const work = (write: Row, owner: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      let limit: { readonly hintMs: number | null } | undefined
      const observed = HttpClient.tap(services.http, (response) =>
        Effect.gen(function* () {
          const body: unknown = response.status === 403 || response.status === 429 ? yield* response.json.pipe(Effect.orElseSucceed(() => undefined)) : undefined
          const answer = readAnswer(response.status, new Headers(response.headers as Record<string, string>), body, Date.now())
          if (answer.kind === "limited") limit = { hintMs: answer.hintMs }
        }))
      const repository = repositoryOf(write.repoId.replace(/^github\//, ""))
      const onGitHub = <A, EE, RR>(effect: Effect.Effect<A, EE, RR>) =>
        effect.pipe(withToken(token, services.apiBaseUrl), Effect.provideService(HttpClient.HttpClient, observed))

      /** A rate limit, wherever it was heard: every call waits, and this write's try isn't spent. */
      const limited = (hintMs: number | null) =>
        Effect.andThen(noteLimited(owner, hintMs), sql`UPDATE machine_writes SET tries = GREATEST(tries - 1, 0) WHERE id = ${write.id}::uuid`)
      /** A token GitHub wouldn't give: a refusal only when it says so, else this write waits. */
      const notMinted = (failure: {
        readonly reason: string
        readonly retryAfterMillis?: number | undefined
        readonly rateLimited?: boolean | undefined
        readonly headerLimited?: boolean | undefined
        readonly fullWaitMillis?: number | undefined
      }) =>
        // A wait in GitHub's headers is a limit here, message or not, as `readAnswer` reads any other call.
        failure.rateLimited === true || failure.headerLimited === true
          ? limited(failure.fullWaitMillis ?? failure.retryAfterMillis ?? null)
          : failure.reason === "app_not_installed" || failure.reason === "not_allowed"
          ? settle(write.id, "refused", failure.reason, null)
          : failure.retryAfterMillis !== undefined
          ? noteLimited(owner, failure.retryAfterMillis)
          : holdFor(owner, READ_RETRY_MS)
      const minted = yield* services.tokens.forInstallation(repository, "write").pipe(Effect.result)
      if (minted._tag === "Failure") return yield* notMinted(minted.failure)
      const token = minted.success
      const path = `/repos/${repository.owner}/${repository.name}`
      const payload = write.payload
      const attributed = (text: string) => `${text}\n\nFiled by the agent ${write.agent}, lane ${write.lane}.`
      const get = (url: string, as = token) => call(services, observed, as, "GET", url)
      /** A read that didn't answer. A limit `observed` heard holds on its own; this goes to the back of the line. */
      const notNow = Effect.gen(function* () {
        yield* sql`UPDATE machine_writes SET queued_at = clock_timestamp() WHERE id = ${write.id}::uuid`
        yield* holdFor(owner, READ_RETRY_MS)
      })
      /** The tick's one mutation. The hold goes on before it and again after its answer, so spacing runs from the end of a send. */
      const send = <A>(
        method: "POST" | "PATCH",
        url: string,
        body: unknown,
        onOk: (json: unknown) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
        as = token,
      ) =>
        Effect.gen(function* () {
          yield* holdFor(owner, SPACING_MS)
          const sent = yield* call(services, observed, as, method, url, body).pipe(Effect.result)
          yield* holdFor(owner, SPACING_MS)
          // The answer was lost, so GitHub may have done it: the next tick looks first.
          if (sent._tag === "Failure") return yield* noteLimited(owner, null)
          const answer = readAnswer(sent.success.status, sent.success.headers, sent.success.json, Date.now())
          if (answer.kind === "limited") return undefined
          if (answer.kind === "outage") return yield* noteLimited(owner, null)
          if (answer.kind === "refused") return yield* settle(write.id, "refused", answer.failure, null)
          yield* sql`UPDATE machine_dispatch SET penalty_ms = 60000 WHERE owner = ${owner}`
          return yield* onOk(sent.success.json)
        })
      /**
       * A create or comment through `Action.once`, keyed by the write's recovery id: it looks for its own marker first,
       * and sends only when that lookup proves nothing was made. A send that didn't make it answers `made: false`, having
       * already held, refused or put the write back, so `once` never reads again during a hold.
       */
      const once = (name: string, keyed: Action.Keyed<Sent, unknown, SqlClient.SqlClient>) =>
        Action.once(`machine-${name}`, keyed, { key: write.recoveryId })
      const made = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.map(effect, (result): Sent =>
          typeof result === "object" && result !== null && "made" in result ? (result as Sent) : { made: false })
      const refresh = (number: number) =>
        Effect.gen(function* () {
          const fetched = yield* onGitHub(fetchIssue(repository, number))
          yield* project(repository, number, fetched)
        })

      const finish = Effect.gen(function* () {
        if (write.op === "issue/relate") {
          const number = payload.number as number
          const parent = payload.parent as { readonly repo: string; readonly number: number }
          const target = repositoryOf(parent.repo)
          if (target.owner.toLowerCase() !== repository.owner.toLowerCase()) return yield* settle(write.id, "refused", "invalid", null)
          const now = yield* get(`${path}/issues/${number}/parent`)
          if (now.status === 200) {
            const url = String((now.json as { url?: unknown } | undefined)?.url ?? "")
            const same = url.toLowerCase().endsWith(`/repos/${parent.repo}/issues/${parent.number}`.toLowerCase())
            return yield* settle(write.id, same ? "done" : "refused", same ? null : "has_parent", same ? number : null)
          }
          if (now.status !== 404) return yield* notNow
          const child = yield* get(`${path}/issues/${number}`)
          const id = (child.json as { id?: unknown } | undefined)?.id
          if (child.status === 404 || child.status === 410) return yield* settle(write.id, "refused", "not_found", null)
          if (child.status !== 200 || typeof id !== "number") return yield* notNow
          const parentToken = yield* services.tokens.forInstallation(target, "write").pipe(Effect.result)
          if (parentToken._tag === "Failure") return yield* notMinted(parentToken.failure)
          return yield* send("POST", `/repos/${target.owner}/${target.name}/issues/${parent.number}/sub_issues`, { sub_issue_id: id }, () =>
            settle(write.id, "done", null, number), parentToken.success)
        }

        if (write.op === "issue/comment") {
          const number = payload.number as number
          const text = attributed(String(payload.body))
          const marked = GitHub.Once.comment(repository.owner, repository.name, number, text, { author: appLogin })
          const sent = yield* once("comment", {
            find: (key) => Effect.map(onGitHub(marked.find(key)), Option.map((): Sent => ({ made: true, number, json: undefined }))),
            perform: (key) => made(send("POST", `${path}/issues/${number}/comments`, { body: GitHub.Issues.withWriteMarker(text, key) }, () =>
              Effect.succeed<Sent>({ made: true, number, json: undefined }))),
          })
          if (sent.made) return yield* settle(write.id, "done", null, number)
          return
        }

        if (write.op === "issue/update") {
          const number = payload.number as number
          // This lane filed it: a `done` create of its own names the number. Any other lane's issue, an unrelated App's
          // or a person's is refused, whoever GitHub says wrote it.
          const [own] = yield* sql`
            SELECT 1 FROM machine_writes
            WHERE repo_id = ${write.repoId} AND op = 'issue/create' AND status = 'done' AND item_number = ${number}
              AND agent = ${write.agent} AND lane = ${write.lane} LIMIT 1`
          if (own === undefined) return yield* settle(write.id, "refused", "not_allowed", null)
          // Updates to one issue land in admission order, field by field: a field a newer done update set is that
          // update's, and the rest of this one still goes. With nothing left, it is superseded and sends nothing.
          const newer = yield* sql<{ readonly payload: Record<string, unknown> }>`
            SELECT payload FROM machine_writes
            WHERE repo_id = ${write.repoId} AND op = 'issue/update' AND status = 'done' AND item_number = ${number} AND seq > ${write.seq}::bigint`
          const taken = new Set(newer.flatMap((row) => UPDATE_FIELDS.filter((field) => row.payload[field] !== undefined)))
          const wanted = UPDATE_FIELDS.filter((field) => payload[field] !== undefined && !taken.has(field))
          if (wanted.length === 0) return yield* settle(write.id, "refused", "superseded", null)
          const asked = (field: (typeof UPDATE_FIELDS)[number]) => wanted.includes(field) ? payload[field] : undefined
          const issue = yield* get(`${path}/issues/${number}`)
          if (issue.status === 404 || issue.status === 410) return yield* settle(write.id, "refused", "not_found", null)
          if (issue.status !== 200) return yield* notNow
          const found = issue.json as { readonly body?: string | null; readonly user?: { readonly login?: string } | null }
          if (!byThisApp(found.user)) return yield* settle(write.id, "refused", "not_allowed", null)
          const marker = GitHub.Issues.writeIdOf(found.body ?? "")
          const fields = {
            ...(asked("title") === undefined ? {} : { title: payload.title }),
            ...(asked("state") === undefined ? {} : { state: payload.state }),
            ...(asked("body") === undefined ? {} : { body: marker === null || marker === undefined ? attributed(String(payload.body)) : GitHub.Issues.withWriteMarker(attributed(String(payload.body)), marker) }),
          }
          return yield* send("PATCH", `${path}/issues/${number}`, fields, () =>
            Effect.gen(function* () {
              // Done the moment GitHub says so: a read-back that fails can't send the PATCH again over a newer update.
              yield* settle(write.id, "done", null, number)
              yield* refresh(number).pipe(Effect.catch((error) => integrationFailure(error)
                ? Effect.logWarning("github.machine_write").pipe(Effect.annotateLogs({ writeId: write.id, outcome: "refresh_failed" }))
                : Effect.fail(error)))
            }))
        }

        // issue/create. The number goes on the row the moment GitHub gives it, so a later tick goes on to the labels.
        const labels = (payload.labels ?? []) as ReadonlyArray<string>
        const settleOrLabels = (made: number, issue: unknown) =>
          Effect.gen(function* () {
            const has = new Set(((issue as { labels?: ReadonlyArray<{ name: string }> }).labels ?? []).map((label) => label.name.toLowerCase()))
            const missing = labels.filter((label) => !has.has(label.toLowerCase()))
            if (missing.length > 0) return missing
            yield* refresh(made)
            yield* settle(write.id, "done", null, made)
            return []
          })
        let number = write.itemNumber
        if (number === null) {
          const since = new Date(Date.parse(write.createdAt) - 60_000).toISOString()
          const text = attributed(String(payload.body))
          // Only an issue this App wrote is adopted: a marker someone copied into theirs is never the match.
          const marked = GitHub.Once.issue(repository.owner, repository.name, { title: String(payload.title), body: text, since, author: appLogin })
          const sent = yield* once("issue", {
            find: (key) => Effect.map(onGitHub(marked.find(key)), Option.map((issue): Sent => ({ made: true, number: issue.number, json: issue }))),
            perform: (key) => made(send("POST", `${path}/issues`, { title: payload.title, body: GitHub.Issues.withWriteMarker(text, key), ...(labels.length === 0 ? {} : { labels }) }, (json) =>
              Effect.gen(function* () {
                const number = (json as { number?: unknown } | undefined)?.number
                // Done but unreadable: the next tick finds it by its marker.
                if (typeof number !== "number") return yield* Effect.as(notNow, { made: false } as Sent)
                return { made: true, number, json } as Sent
              }))),
          })
          if (!sent.made) return
          yield* sql`UPDATE machine_writes SET item_number = ${sent.number} WHERE id = ${write.id}::uuid`
          yield* settleOrLabels(sent.number, sent.json)
          return
        }
        yield* sql`UPDATE machine_writes SET item_number = ${number} WHERE id = ${write.id}::uuid`
        const issue = yield* get(`${path}/issues/${number}`)
        if (issue.status !== 200) return yield* notNow
        const missing = yield* settleOrLabels(number, issue.json)
        if (missing.length > 0) yield* send("POST", `${path}/issues/${number}/labels`, { labels: missing }, () => Effect.void)
      })

      const done = yield* finish.pipe(
        // GitHub's client failing a read is no verdict on the write; Postgres failing goes up, to retry the tick.
        Effect.catch((error) => integrationFailure(error) ? notNow : Effect.fail(error)),
      )
      if (limit !== undefined) yield* limited(limit.hintMs)
      return done
    })

  const tick = ({ owner, epoch }: typeof Tick.payloadSchema.Type) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const remaining = Effect.map(sql<{ readonly ms: string }>`
        SELECT GREATEST(0, ceil(extract(epoch FROM next_at - clock_timestamp()) * 1000))::bigint::text AS ms
        FROM machine_dispatch WHERE owner = ${owner} AND epoch = ${epoch}`, (rows) => (rows[0] === undefined ? undefined : Number(rows[0].ms)))
      /** Says when this dispatcher will wake, which is its lease. */
      const wake = (waitMs: number) =>
        Effect.as(sql`UPDATE machine_dispatch SET due_at = clock_timestamp() + make_interval(secs => ${waitMs / 1000}) WHERE owner = ${owner} AND epoch = ${epoch}`, { stop: false, waitMs })
      // The epoch fence: another took over. The hold comes before any read or token.
      const held = yield* remaining
      if (held === undefined) return { stop: true, waitMs: 0 }
      if (held > 0) return yield* wake(held)
      const [write] = yield* sql<Row>`
        UPDATE machine_writes SET tries = tries + 1
        WHERE id = (SELECT id FROM machine_writes WHERE owner = ${owner} AND status = 'pending' ORDER BY queued_at, id LIMIT 1)
        RETURNING id::text, recovery_id::text AS "recoveryId", seq::text, repo_id AS "repoId", token_sha256 AS "tokenSha256", agent, lane, op, payload, item_number AS "itemNumber", tries, created_at::text AS "createdAt"`
      if (write === undefined) {
        // Stops only with the owner's row held and the queue read empty after that, in a fresh snapshot: a launch holds the
        // same row, so a write it answered for is seen here, and one admitted after this sees `running` false and starts another.
        const stopped = yield* sql.withTransaction(Effect.gen(function* () {
          const [held] = yield* sql`SELECT 1 FROM machine_dispatch WHERE owner = ${owner} AND epoch = ${epoch} FOR UPDATE`
          if (held === undefined) return true
          const [waiting] = yield* sql`SELECT 1 FROM machine_writes WHERE owner = ${owner} AND status = 'pending' LIMIT 1`
          if (waiting !== undefined) return false
          yield* sql`UPDATE machine_dispatch SET running = false WHERE owner = ${owner} AND epoch = ${epoch}`
          return true
        }))
        return stopped ? { stop: true, waitMs: 0 } : yield* wake(0)
      }
      if (write.tries > MAX_TRIES) {
        yield* settle(write.id, "failed", "exhausted", null)
        return yield* wake(0)
      }
      // The write's authority holds at the moment of work too: a token revoked since admission stops here.
      const parent = write.op === "issue/relate" ? (write.payload.parent as { readonly repo: string }).repo : undefined
      const authorized = (yield* tokenHeld(write.tokenSha256, write.repoId, write.op)) && (yield* parentHeld(write.agent, write.lane, write.repoId, parent))
      if (!authorized) {
        yield* settle(write.id, "refused", "revoked", null)
        return yield* wake(0)
      }
      // So does the deployment's list, which may have changed since: this repository and the parent's.
      if (!services.mayAct(write.repoId) || (parent !== undefined && !services.mayAct(repositoryOf(parent).id))) {
        yield* settle(write.id, "refused", "not_allowed", null)
        return yield* wake(0)
      }
      yield* work(write, owner).pipe(
        // A defect is this write's, not the queue's: it settles `failed`, and the dispatcher goes on.
        Effect.catchCause((cause) =>
          Cause.hasDies(cause) && !Cause.hasInterrupts(cause)
            ? Effect.logWarning("github.machine_write").pipe(
              Effect.annotateLogs({ writeId: write.id, outcome: "defect" }),
              Effect.andThen(settle(write.id, "failed", "defect", null)),
            )
            : Effect.failCause(cause)
        ),
      )
      return yield* wake((yield* remaining) ?? 0)
    }).pipe(
      Effect.provide(services.database),
      Effect.catch((error) =>
        Effect.logWarning("github.machine_write").pipe(
          Effect.annotateLogs({ owner, outcome: "failed", errorCode: codeOf(error) }),
          Effect.andThen(Effect.fail(new MachineUnavailable())),
        )),
      Effect.withSpan("github.machine_dispatch", { attributes: { "smithers.github.owner": owner } }),
    ) as Effect.Effect<typeof Outcome.Type, MachineUnavailable>

  return { tick }
}

/** Registers `github/MachineDispatch` beside `github/Write`, whose plans it leaves as they are. */
export const registration = <E, R>(services: Services<E, R>) =>
  Interpreter.layerWithImplementations(
    MachineDispatch,
    Tick.toLayer(steps(services).tick, { implementationVersion }),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
