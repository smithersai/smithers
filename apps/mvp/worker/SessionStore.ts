import { Config, Context, Effect, Metric, Option, Redacted, Schema } from "effect"
import { SqlClient, type Statement } from "effect/sql"
import { SessionsUnavailable, type Actor, type Role } from "./Actor.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as Ends from "./SessionEnds.ts"
export const sweepEnds = Ends.sweep

// Sign-in's rows in Postgres (docs/features/sign-in.md#postgres): people, sign-ins in progress and sessions. Postgres'
// clock decides every expiry. Each function is one statement, or one transaction, against the `SqlClient` in context.

/** A sealed value as a row holds it (`@smthrs/control`'s `CredentialCipher.Sealed`). */
export const Sealed = Schema.Struct({ ciphertext: Schema.String, nonce: Schema.String })
export type Sealed = typeof Sealed.Type

const decodeSealed = Schema.decodeUnknownSync(Sealed)
const sealedOrNull = (value: unknown) => (value === null ? null : decodeSealed(value))
const json = (value: Sealed | null) => (value === null ? null : JSON.stringify(value))
const millis = (value: string | null) => (value === null ? null : Number(value))

/** The default maximum age of a confirmed deployment-repository role. Failed checks never extend it. */
export const ROLE_RECHECK_MINUTES = 60
export const roleFreshMs = Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), "ROLE_RECHECK_MINUTES").pipe(
  Config.withDefault(ROLE_RECHECK_MINUTES),
  Config.map((minutes) => minutes * 60_000),
)

/** The host captures roleFreshMs while building; runtime checks never reread ambient configuration. */
export const RoleFreshMs = Context.Reference<number>("@smthrs/mvp/auth/RoleFreshMs", {
  defaultValue: () => ROLE_RECHECK_MINUTES * 60_000,
})

/** A confirmation is usable only within its freshness window, on the database's clock. */
export const roleFresh = (verifiedAt: number | null, now: number, freshMs: number): boolean =>
  verifiedAt !== null && verifiedAt <= now && now - verifiedAt < freshMs

/**
 * The host's already-validated key ids travel with its verifier: every host captures `configuredKeyIds`, or sign-in's
 * keys, while building and provides them. Like `RoleFreshMs`, a runtime check never rereads ambient configuration; a
 * store used without a host has the key ids of a deployment with no `SESSION_SECRETS`.
 */
export const SigningKeyIds = Context.Reference<ReadonlyArray<string>>("@smthrs/mvp/auth/SigningKeyIds", {
  defaultValue: () => ["legacy"],
})

/** The absolute cookie bound, including the alias's own start when present. */
export const sessionDeadline = (sql: SqlClient.SqlClient, s: Statement.Fragment, h?: Statement.Fragment) =>
  h === undefined ? sql`(${s}.started_at + interval '400 days')`
    : sql`(least(${h}.started_at, ${s}.started_at) + interval '400 days')`

/** Capture at host construction; runtime authority checks receive only key IDs. */
export const configuredKeyIds = Effect.gen(function* () {
  const encoded = yield* Config.option(Config.Redacted("SESSION_SECRETS"))
  return Option.isNone(encoded) ? ["legacy"]
    : Option.match(SessionKeys.decodeSecrets(encoded.value), { onNone: () => [], onSome: keys => Object.keys(keys) })
})

/** The one liveness predicate used by every authority reader (decision 0151). */
export const sessionLive = (sql: SqlClient.SqlClient, s: Statement.Fragment, h?: Statement.Fragment, verifiedKey?: string | null) => Effect.gen(function* () {
  const configured = yield* SigningKeyIds
  // Internal authority has no cookie to present, but a removed key cannot keep any row live.
  const accepted = verifiedKey === undefined ? configured : configured.filter(key => key === verifiedKey)
  // Only the one-bit stale diagnostic passes null. It must not treat an unknown new stamp as a revoked row.
  const keyMatches = verifiedKey === null ? sql`true`
    : accepted.length === 0 ? sql`false` : sql`${h ?? s}.cookie_key IN ${sql.in(accepted)}`
  // Authority can wait on a lock inside a transaction. Its start time cannot extend a deadline.
  return sql`(
    ${s}.revoked_at IS NULL AND ${s}.expires_at > clock_timestamp() AND ${sessionDeadline(sql, s, h)} > clock_timestamp()
    ${h === undefined ? sql`` : sql`AND ${h}.revoked_at IS NULL`}
    AND ${keyMatches})`
})

/** An issuer absent from this Worker's key map cannot leave an unsigned row behind. */
export class IssuerUnconfigured extends Schema.TaggedError<IssuerUnconfigured>()("SessionIssuerUnconfigured", {}) {}
export const issues = Metric.counter("smithers_auth_issue", { incremental: true })

const configuredIssuer = (key: string | undefined, configuredKeys: ReadonlyArray<string>) =>
  key !== undefined && configuredKeys.includes(key) ? Effect.void : Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(issues, { outcome: "issuer_unconfigured" }), 1)
    yield* Effect.logWarning("auth.issue").pipe(Effect.annotateLogs({ outcome: "issuer_unconfigured" }))
    return yield* new IssuerUnconfigured()
  })

/** Server-enforced bounds cover the whole issuance transaction, including waits while acquiring its first lock. */
export const issuance = <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.flatMap(SqlClient.SqlClient, sql =>
  sql.withTransaction(Effect.gen(function* () {
    yield* sql`SET LOCAL statement_timeout = '5s'`
    yield* sql`SET LOCAL lock_timeout = '2s'`
    yield* sql`SET LOCAL idle_in_transaction_session_timeout = '10s'`
    const [version] = yield* sql<{ version: number }>`SELECT current_setting('server_version_num')::int AS version`
    if (version!.version >= 170000) yield* sql`SET LOCAL transaction_timeout = '15s'`
    return yield* body
  })))

/** Short-lived proofs use the durable issuer too, so a ceased key stops issuing every purpose. */
export const signingIssuer = (configuredKeys: ReadonlyArray<string>) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ key: string }>`SELECT key_id AS key FROM session_signing_keys WHERE state = 'issuer'`
  yield* configuredIssuer(row?.key, configuredKeys)
  return row!.key
})

/** The person's newest authority receipt, including a verified demotion from a session later signed out. */
/**
 * The role GitHub last confirmed for `person`, across all their sessions, live or ended: the newest observation
 * (`role_generation`) wins, and a check that couldn't reach GitHub only copies it (`keepRole`).
 */
export const latestRole = (sql: SqlClient.SqlClient, person: Statement.Fragment) => sql`(
  SELECT authority.role FROM (
    SELECT role, role_generation, role_checked_at, created_at, id FROM sessions WHERE person_id = ${person}
    UNION ALL SELECT role, role_generation, role_checked_at, created_at, session_id AS id FROM person_role_receipts WHERE person_id = ${person}
  ) authority ORDER BY authority.role_generation DESC, authority.role_checked_at DESC, authority.created_at DESC, authority.id DESC LIMIT 1
)`

/** The verification time of the same receipt latestRole selects, never another generation's later timestamp. */
export const latestRoleVerifiedAt = (sql: SqlClient.SqlClient, person: Statement.Fragment) => sql`(
  SELECT authority.role_verified_at FROM (
    SELECT role_verified_at, role_generation, role_checked_at, created_at, id FROM sessions WHERE person_id = ${person}
    UNION ALL SELECT role_verified_at, role_generation, role_checked_at, created_at, session_id AS id FROM person_role_receipts WHERE person_id = ${person}
  ) authority
  ORDER BY authority.role_generation DESC, authority.role_checked_at DESC, authority.created_at DESC, authority.id DESC LIMIT 1
)`

const latestGeneration = (sql: SqlClient.SqlClient, person: Statement.Fragment) => sql`(
  SELECT max(authority.role_generation) FROM (
    SELECT role_generation FROM sessions WHERE person_id = ${person}
    UNION ALL SELECT role_generation FROM person_role_receipts WHERE person_id = ${person}
  ) authority
)`

/** Issue before contacting GitHub. Sequence order survives delayed replies, clock changes and transaction rollbacks. */
export const roleObservation = Effect.flatMap(SqlClient.SqlClient, sql => Effect.map(
  sql<{ generation: string }>`SELECT nextval('role_observations')::text AS generation`, rows => rows[0]!.generation))

/** Serialize verified receipts and failed-refresh copies for the same person, across all their sessions. */
const lockRole = (sql: SqlClient.SqlClient, sessionId: string) => sql`
  SELECT id FROM people WHERE id = (SELECT person_id FROM sessions WHERE id = ${sessionId}) FOR UPDATE`

/**
 * Why a session ended early: the person signed out, GitHub refused its tokens, or its sealed tokens no longer open
 * (SESSION_SECRET changed).
 */
export type RevokedReason = "sign_out" | "github_refused" | "unreadable"

/** Records a sign-in in progress for `ttlSeconds`, after deleting every one past its expiry. */
export const beginAttempt = (attempt: {
  readonly stateDigest: string
  readonly verifier: Sealed
  readonly redirectUri: string
  readonly returnTo: string
  readonly ttlSeconds: number
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM sign_in_attempts WHERE expires_at < now()`
    yield* sql`
      INSERT INTO sign_in_attempts (state_digest, verifier, redirect_uri, return_to, expires_at)
      VALUES (${attempt.stateDigest}, ${json(attempt.verifier)}::jsonb, ${attempt.redirectUri}, ${attempt.returnTo},
        now() + make_interval(secs => ${attempt.ttlSeconds}))`
  })

/**
 * Takes the sign-in `state` started, once: the row is deleted as it is read, so a replayed callback finds nothing.
 * `live` is false when it was past its expiry.
 */
export const takeAttempt = (stateDigest: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly verifier: unknown
      readonly redirectUri: string
      readonly returnTo: string
      readonly live: boolean
    }>`
      DELETE FROM sign_in_attempts WHERE state_digest = ${stateDigest}
      RETURNING verifier, redirect_uri AS "redirectUri", return_to AS "returnTo", expires_at > now() AS live`
    return Option.map(Option.fromNullishOr(row), (found) => ({ ...found, verifier: decodeSealed(found.verifier) }))
  })

/** The person with GitHub's numeric id `githubId`, created or with their login brought up to date; returns their id. */
/** The person's numeric GitHub id, when they have a row. */
export const githubIdOf = (personId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly github_id: string | number }>`SELECT github_id FROM people WHERE id = ${personId}`
    const value = Number(rows[0]?.github_id ?? Number.NaN)
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  })

export const upsertPerson = (person: { readonly id: string; readonly githubId: number; readonly login: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly id: string }>`
      INSERT INTO people (id, github_id, github_login) VALUES (${person.id}, ${person.githubId}, ${person.login})
      ON CONFLICT (github_id) DO UPDATE SET github_login = EXCLUDED.github_login, updated_at = now()
      RETURNING id`
    return row!.id
  })

/** A new session with its pre-read observation generation; returns the person's effective role. */
export const createSession = (session: {
  readonly id: string
  readonly tokenDigest: string
  readonly personId: string
  readonly role: Role | null
  readonly roleGeneration: string
  readonly access: Sealed
  readonly accessExpiresAt: number | null
  readonly refresh: Sealed | null
  readonly refreshDigest: string | null
  readonly maxAgeSeconds: number
  readonly pairDigest?: string
}, configuredKeys: ReadonlyArray<string> = ["legacy"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* issuance(Effect.gen(function* () {
      yield* sql`SELECT id FROM people WHERE id = ${session.personId} FOR UPDATE`
      const [issued] = yield* sql<{ key: string }>`
      INSERT INTO sessions (id, token_digest, person_id, role, role_generation, role_checked_at, role_verified_at, github_access, github_access_expires_at,
        github_refresh, github_refresh_digest, expires_at, cookie_key, started_at, github_pair_digest)
      SELECT ${session.id}, ${session.tokenDigest}, ${session.personId}, ${session.role}, ${session.roleGeneration}::bigint, clock_timestamp(), clock_timestamp(),
        ${json(session.access)}::jsonb,
        ${session.accessExpiresAt === null ? null : new Date(session.accessExpiresAt).toISOString()}::timestamptz,
        ${json(session.refresh)}::jsonb, ${session.refreshDigest},
        now() + make_interval(secs => ${session.maxAgeSeconds}), k.key_id, now(), ${session.pairDigest ?? null}
      FROM session_signing_keys k WHERE k.state = 'issuer'
      RETURNING cookie_key AS key`
      yield* configuredIssuer(issued?.key, configuredKeys)
      const [row] = yield* sql<{ role: Role | null }>`SELECT ${latestRole(sql, sql`${session.personId}::uuid`)} AS role`
      return row!.role
    }))
  })

/**
 * A live session: its id, its person's id and login, its role and when the role was last checked (epoch ms). An alias
 * session (`host_sessions`, decision 0130) has its home session's role, and `home` names that session, which it acts
 * as: the one a role check checks, a run credential names and GitHub writes take the person's tokens from.
 */
export interface Live {
  readonly id: string
  readonly personId: string
  readonly login: string
  readonly role: Role | null
  readonly roleCheckedAt: number
  /** When GitHub last confirmed the home session's role (epoch ms); `null` never: a failed check never moves it. */
  readonly roleVerifiedAt: number | null
  readonly home?: string
  readonly cookieKey: string
  readonly sessionTag: string
  /**
   * The earliest known end, epoch milliseconds: sliding expiry capped by the home and alias absolute deadlines.
   */
  readonly expiresAt: number
  readonly deadline: number
  /**
   * The database's `clock_timestamp()` when this lookup read `expiresAt`, epoch milliseconds: the one clock a tab
   * counts `expiresAt` down against (decision 0151 rule 9), never the Worker's.
   */
  readonly serverNow: number
}

/** The live session `which` picks: not signed out, not revoked and not past its end. */
const findLiveBy = (which: (sql: SqlClient.SqlClient) => Statement.Fragment, verifiedKey?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<
      Omit<Live, "roleCheckedAt" | "roleVerifiedAt" | "expiresAt" | "serverNow" | "deadline"> & {
        readonly roleCheckedAt: string
        readonly roleVerifiedAt: string | null
        readonly expiresAt: string
        readonly deadline: string
        readonly serverNow: string
      }
    >`
      SELECT s.id, s.session_tag AS "sessionTag", s.cookie_key AS "cookieKey", s.person_id AS "personId", p.github_login AS login, ${latestRole(sql, sql`s.person_id`)} AS role,
        (extract(epoch FROM s.role_checked_at) * 1000)::bigint::text AS "roleCheckedAt",
        (extract(epoch FROM ${latestRoleVerifiedAt(sql, sql`s.person_id`)}) * 1000)::bigint::text AS "roleVerifiedAt",
        (extract(epoch FROM least(s.expires_at, ${sessionDeadline(sql, sql`s`)})) * 1000)::bigint::text AS "expiresAt",
        (extract(epoch FROM ${sessionDeadline(sql, sql`s`)}) * 1000)::bigint::text AS deadline,
        (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS "serverNow"
      FROM sessions s JOIN people p ON p.id = s.person_id
      WHERE ${which(sql)} AND ${yield* sessionLive(sql, sql`s`, undefined, verifiedKey)}`
    return Option.map(Option.fromNullishOr(row), (found): Live => ({
      ...found,
      roleCheckedAt: Number(found.roleCheckedAt),
      expiresAt: Number(found.expiresAt),
      deadline: Number(found.deadline),
      serverNow: Number(found.serverNow),
      roleVerifiedAt: found.roleVerifiedAt === null ? null : Number(found.roleVerifiedAt),
    }))
  })

/** What a socket's lease renews on (worker/SocketAccess.ts): the person's role, when GitHub last confirmed it, and the end. */
export interface Authority {
  readonly personId: string
  readonly role: Role | null
  /** The newest confirmation of the person's role on any session of theirs, epoch ms; `null` never. */
  readonly roleVerifiedAt: number | null
  readonly expiresAt: number
  /** The database's `clock_timestamp()` when the lookup read `expiresAt`, epoch ms: the clock `expiresAt` is on. */
  readonly serverNow: number
}

/**
 * Session `id`, and alias session `alias` under it when the socket came through one (decision 0130), both live: the
 * person, their newest role receipt, when GitHub last confirmed a role of theirs (a failed check never counts) and when
 * the session ends. One statement.
 */
export const authority = (id: string, alias: string | null, verifiedKey?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly personId: string
      readonly role: Role | null
      readonly roleVerifiedAt: string | null
      readonly expiresAt: string
      readonly serverNow: string
    }>`
      SELECT s.person_id AS "personId", ${latestRole(sql, sql`s.person_id`)} AS role,
        (extract(epoch FROM ${latestRoleVerifiedAt(sql, sql`s.person_id`)}) * 1000)::bigint::text AS "roleVerifiedAt",
        (extract(epoch FROM least(s.expires_at, ${sessionDeadline(sql, sql`s`, sql`h`)})) * 1000)::bigint::text AS "expiresAt",
        (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS "serverNow"
      FROM sessions s LEFT JOIN host_sessions h ON h.id = ${alias}::uuid AND h.parent_id = s.id
      WHERE s.id = ${id} AND ${yield* sessionLive(sql, sql`s`, undefined, alias === null ? verifiedKey : undefined)}
        AND (${alias}::uuid IS NULL OR (h.id IS NOT NULL AND ${yield* sessionLive(sql, sql`s`, sql`h`, verifiedKey)}))`
    return Option.map(Option.fromNullishOr(row), (found): Authority => ({
      personId: found.personId,
      role: found.role,
      roleVerifiedAt: found.roleVerifiedAt === null ? null : Number(found.roleVerifiedAt),
      expiresAt: Number(found.expiresAt),
      serverNow: Number(found.serverNow),
    }))
  })

/**
 * The deployment role a request may authorize with. Real sessions must still live, belong to the actor, and carry a
 * fresh confirmation of their effective receipt. An actor without a session is explicit local development.
 */
export const freshRole = (actor: Actor, freshMs?: number) => Effect.gen(function* () {
  if (actor.session === undefined) return actor.role
  const window = freshMs ?? (yield* RoleFreshMs)
  const found = yield* authority(actor.session, actor.alias ?? null, actor.cookieKey)
  if (Option.isNone(found)) {
    // A previously admitted cookie can lose authority during reauthentication. It says nothing about the
    // person's current permission: a permanent denial here would discard an otherwise valid queued write.
    yield* Effect.annotateCurrentSpan({ "auth.role.available": false, "auth.role.reason": "session_authority" })
    yield* Effect.logWarning("auth.role_unavailable").pipe(Effect.annotateLogs({ reason: "session_authority" }))
    return yield* new SessionsUnavailable({ errorCode: "session_authority" })
  }
  if (found.value.personId !== actor.subject.id) return null
  const fresh = roleFresh(found.value.roleVerifiedAt, found.value.serverNow, window)
  yield* Effect.annotateCurrentSpan({ "auth.role.fresh": fresh })
  if (!fresh) {
    yield* Effect.logWarning("auth.role_stale")
    return yield* new SessionsUnavailable()
  }
  return found.value.role
}).pipe(Effect.withSpan("auth.role"))

/** The live session whose token has `tokenDigest`: not signed out, not revoked and not past its end. */
export const findLive = (tokenDigest: string, verifiedKey?: string) => findLiveBy((sql) => sql`s.token_digest = ${tokenDigest}`, verifiedKey)

/**
 * Whether person `personId` is a Member or above of the deployment's own repository (`GITHUB_REPOSITORY`), as sign-in
 * last observed it on any session of theirs, with at least one session still live: the people whose model calls without a model of their own, and whose
 * clones, the deployment pays for (ruling AUTH-8). The latest check decides, so a demotion found on one session
 * outranks an older session's role. A person with no live session is not one.
 */
export const deploymentMember = (personId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly member: boolean | null }>`
      SELECT ${latestRole(sql, sql`p.id`)} IN ('member', 'maintainer', 'admin') AS member FROM people p
      WHERE p.id::text = ${personId} AND EXISTS (
        SELECT 1 FROM sessions live WHERE live.person_id = p.id AND ${yield* sessionLive(sql, sql`live`)}
      )`
    return row?.member === true
  })

/** A verified cookie's stable person, including an ended session whose GitHub revocation still needs delivery. */
export const ownerOf = (tokenDigest: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly personId: string }>`SELECT person_id::text AS "personId" FROM sessions WHERE token_digest = ${tokenDigest}`
  return Option.map(Option.fromNullishOr(row), (found) => found.personId)
})

/**
 * What smithers.sh did to person `personId`'s GitHub tokens before session `sessionId` signed in: whether it revoked one
 * since the person's previous sign-in started (`afterRevocation`), and how many other sign-ins, each a new token, it
 * issued them in the hour before (`hourlyTokens`). Feeds only `GitHub.Auth.Consent.observe` (decision 0165).
 */
export const tokenHistory = (personId: string, sessionId: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly afterRevocation: boolean; readonly hourlyTokens: number }>`
    SELECT EXISTS (
      SELECT 1 FROM github_token_cleanups c JOIN sessions s ON s.id = c.session_id
      WHERE s.person_id = ${personId} AND c.finished_at IS NOT NULL AND c.finished_at >= coalesce(
        (SELECT max(started_at) FROM sessions WHERE person_id = ${personId} AND id <> ${sessionId}), '-infinity'::timestamptz)
    ) AS "afterRevocation",
    (SELECT count(*)::int FROM sessions WHERE person_id = ${personId} AND id <> ${sessionId}
      AND started_at > clock_timestamp() - interval '1 hour') AS "hourlyTokens"`
  return { afterRevocation: row?.afterRevocation === true, hourlyTokens: row?.hourlyTokens ?? 0 }
})

/** The live session `id`, as a run credential minted under it names it: none once it ended. */
export const findLiveById = (id: string, verifiedKey?: string) => findLiveBy((sql) => sql`s.id = ${id}`, verifiedKey)

/** The live alias session at `host` whose token has `tokenDigest`: not signed out, and its home session live. */
export const findHostLive = (tokenDigest: string, host: string, verifiedKey?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<
      Omit<Live, "roleCheckedAt" | "roleVerifiedAt" | "expiresAt" | "serverNow" | "deadline"> & {
        readonly roleCheckedAt: string
        readonly roleVerifiedAt: string | null
        readonly home: string
        readonly expiresAt: string
        readonly deadline: string
        readonly serverNow: string
      }
    >`
      SELECT h.id, h.session_tag AS "sessionTag", h.cookie_key AS "cookieKey", s.person_id AS "personId", p.github_login AS login, ${latestRole(sql, sql`s.person_id`)} AS role,
        (extract(epoch FROM s.role_checked_at) * 1000)::bigint::text AS "roleCheckedAt",
        (extract(epoch FROM ${latestRoleVerifiedAt(sql, sql`s.person_id`)}) * 1000)::bigint::text AS "roleVerifiedAt", s.id AS home,
        (extract(epoch FROM least(s.expires_at, ${sessionDeadline(sql, sql`s`, sql`h`)})) * 1000)::bigint::text AS "expiresAt",
        (extract(epoch FROM ${sessionDeadline(sql, sql`s`, sql`h`)}) * 1000)::bigint::text AS deadline,
        (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS "serverNow"
      FROM host_sessions h JOIN sessions s ON s.id = h.parent_id JOIN people p ON p.id = s.person_id
      WHERE h.token_digest = ${tokenDigest} AND h.host = ${host}
        AND ${yield* sessionLive(sql, sql`s`)} AND ${yield* sessionLive(sql, sql`s`, sql`h`, verifiedKey)}`
    return Option.map(Option.fromNullishOr(row), (found): Live => ({
      ...found,
      roleCheckedAt: Number(found.roleCheckedAt),
      roleVerifiedAt: found.roleVerifiedAt === null ? null : Number(found.roleVerifiedAt),
      expiresAt: Number(found.expiresAt),
      deadline: Number(found.deadline),
      serverNow: Number(found.serverNow),
    }))
  })

/** Stale reveals only that a verified cookie names a live row with a different stamp, never an actor. */
export const credentialStale = (tokenDigest: string, host: string | null, verifiedKey: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ stale: boolean }>`SELECT EXISTS (
    SELECT 1 FROM sessions s WHERE s.token_digest = ${tokenDigest} AND s.cookie_key <> ${verifiedKey}
      AND ${yield* sessionLive(sql, sql`s`, undefined, null)}
    UNION ALL
    SELECT 1 FROM host_sessions h JOIN sessions s ON s.id = h.parent_id
      WHERE h.token_digest = ${tokenDigest} AND h.host = ${host} AND h.cookie_key <> ${verifiedKey}
        AND ${yield* sessionLive(sql, sql`s`, sql`h`, null)}
  ) AS stale`
  return row!.stale
})

/**
 * Records a code `APP_DOMAIN` hands to `host` for session `sessionId`, valid `ttlSeconds`, after deleting every one past
 * its expiry. Only digests are kept: the code's and the alias's nonce's.
 */
export const beginHandoff = (handoff: {
  readonly codeDigest: string
  readonly sessionId: string
  readonly host: string
  readonly nonceDigest: string
  readonly returnTo: string
  readonly ttlSeconds: number
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM sign_in_handoffs WHERE expires_at < now()`
    yield* sql`
      INSERT INTO sign_in_handoffs (code_digest, session_id, host, nonce_digest, return_to, expires_at)
      VALUES (${handoff.codeDigest}, ${handoff.sessionId}, ${handoff.host}, ${handoff.nonceDigest}, ${handoff.returnTo},
        now() + make_interval(secs => ${handoff.ttlSeconds}))`
  })

/**
 * Takes the hand-off whose code has `codeDigest`, once: the row is deleted as it is read, so every attempt spends it.
 * `live` is false when it was past its expiry.
 */
export const takeHandoff = (codeDigest: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly sessionId: string
      readonly host: string
      readonly nonceDigest: string
      readonly returnTo: string
      readonly live: boolean
    }>`
      DELETE FROM sign_in_handoffs WHERE code_digest = ${codeDigest}
      RETURNING session_id::text AS "sessionId", host, nonce_digest AS "nonceDigest", return_to AS "returnTo",
        expires_at > now() AS live`
    return Option.fromNullishOr(row)
  })

/**
 * A new alias session at `host` under home session `parentId`, only while that session is live; returns whether it was
 * created.
 */
export const createHostSession = (session: {
  readonly id: string
  readonly tokenDigest: string
  readonly parentId: string
  readonly host: string
}, configuredKeys: ReadonlyArray<string> = ["legacy"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* issuance(Effect.gen(function* () {
    yield* sql`SELECT id FROM people WHERE id = (SELECT person_id FROM sessions WHERE id = ${session.parentId}) FOR UPDATE`
    yield* sql`SELECT id FROM sessions WHERE id = ${session.parentId} FOR UPDATE`
    const rows = yield* sql<{ key: string }>`
      INSERT INTO host_sessions (id, token_digest, parent_id, host, cookie_key, started_at)
      SELECT ${session.id}, ${session.tokenDigest}, s.id, ${session.host}, k.key_id, now() FROM sessions s CROSS JOIN session_signing_keys k
      WHERE k.state = 'issuer' AND s.id = ${session.parentId} AND s.revoked_at IS NULL
        AND least(s.expires_at, s.started_at + interval '400 days') > clock_timestamp() AND ${yield* sessionLive(sql, sql`s`)}
      RETURNING cookie_key AS key`
    if (rows.length > 0) yield* configuredIssuer(rows[0]!.key, configuredKeys)
    return rows.length > 0
    }))
  })

/** Ends the alias session at `host` whose token has `tokenDigest`; returns its id when it ended now. */
export const revokeHost = (tokenDigest: string, host: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function* () {
    const [row] = yield* sql<{ id: string; parent: string }>`SELECT id, parent_id AS parent FROM host_sessions
      WHERE token_digest = ${tokenDigest} AND host = ${host}`
    if (row === undefined) return Option.none<string>()
    yield* sql`SELECT id FROM sessions WHERE id = ${row.parent} FOR UPDATE`
    return yield* Ends.endAlias(row.id, "sign_out")
  }))
})

/** The person of the alias session at `host` whose token has `tokenDigest`, ended or not. */
export const hostOwnerOf = (tokenDigest: string, host: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly personId: string }>`
      SELECT s.person_id::text AS "personId" FROM host_sessions h JOIN sessions s ON s.id = h.parent_id
      WHERE h.token_digest = ${tokenDigest} AND h.host = ${host}`
    return Option.map(Option.fromNullishOr(row), (found) => found.personId)
  })

/** Ends the row, transfers its credentials and records its aliases in one transaction. */
export const revoke = (session: { readonly id: string }, reason: RevokedReason) => Ends.endSession(session.id, reason)

/**
 * The session whose token has `tokenDigest`, when signing it out has work left: it is live, or it ended and still holds
 * GitHub tokens nothing has revoked yet. `None` otherwise.
 */
export const signingOut = (tokenDigest: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly id: string }>`
      SELECT id FROM sessions
      WHERE token_digest = ${tokenDigest}
        AND (revoked_at IS NULL OR github_access IS NOT NULL OR EXISTS (
          SELECT 1 FROM github_token_cleanups c WHERE c.session_id = sessions.id AND c.finished_at IS NULL))`
    return Option.map(Option.fromNullishOr(row), (found) => found.id)
  })

/** Forgets session `id`'s GitHub tokens, once it has ended: a live session keeps them. */
export const forgetTokens = (id: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function* () {
    yield* sql`SELECT id FROM sessions WHERE id = ${id} FOR UPDATE`
    const [row] = yield* sql<{ ended: boolean }>`SELECT revoked_at IS NOT NULL OR
      least(expires_at, started_at + interval '400 days') <= clock_timestamp() AS ended FROM sessions WHERE id = ${id}`
    if (row?.ended) yield* Ends.endSession(id, "expired")
  }))
})

/** What a role check reads of a session: whether it is live, and its sealed GitHub tokens. */
export interface Held {
  readonly live: boolean
  readonly access: Sealed | null
  readonly accessExpiresAt: number | null
  readonly refresh: Sealed | null
  readonly refreshDigest: string | null
  readonly tokenGen: number
  readonly pairDigest: string | null
}

/** Session `id`'s GitHub tokens, or `None` when there is no such session. */
export const held = (id: string, verifiedKey?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly live: boolean
      readonly access: unknown
      readonly accessExpiresAt: string | null
      readonly refresh: unknown
      readonly refreshDigest: string | null
      readonly tokenGen: number
      readonly pairDigest: string | null
    }>`
      SELECT ${yield* sessionLive(sql, sql`s`, undefined, verifiedKey)} AS live, github_access AS access,
        (extract(epoch FROM github_access_expires_at) * 1000)::bigint::text AS "accessExpiresAt",
        github_refresh AS refresh, github_refresh_digest AS "refreshDigest",
        github_token_gen AS "tokenGen", github_pair_digest AS "pairDigest"
      FROM sessions s WHERE id = ${id}`
    return Option.map(Option.fromNullishOr(row), (found): Held => ({
      live: found.live,
      access: sealedOrNull(found.access),
      accessExpiresAt: millis(found.accessExpiresAt),
      refresh: sealedOrNull(found.refresh),
      refreshDigest: found.refreshDigest,
      tokenGen: found.tokenGen,
      pairDigest: found.pairDigest,
    }))
  })

/**
 * Replaces session `id`'s GitHub tokens, only while it still holds the refresh token whose digest is `presented`.
 * Classifies the latest locked row as an install, an installed replay or an abandoned pair.
 */
export const replaceTokens = (
  id: string,
  presented: string,
  next: {
    readonly access: Sealed
    readonly accessExpiresAt: number | null
    readonly refresh: Sealed | null
    readonly refreshDigest: string | null
    readonly pairDigest: string
  },
  gen: number,
) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function* () {
    // A second statement after the lock sees the latest committed row, including a concurrent store or callback.
    yield* sql`SELECT id FROM sessions WHERE id = ${id} FOR UPDATE`
    const [held] = yield* sql<{ revoked: boolean; refresh: string | null; pair: string | null; gen: number; same: boolean }>`
      SELECT revoked_at IS NOT NULL AS revoked, github_refresh_digest AS refresh, github_pair_digest AS pair,
        github_token_gen AS gen, github_access = ${json(next.access)}::jsonb AS same FROM sessions WHERE id = ${id}`
    if (held !== undefined && !held.revoked && held.refresh === presented && held.gen === gen) {
      yield* sql`UPDATE sessions SET github_access = ${json(next.access)}::jsonb,
        github_access_expires_at = ${next.accessExpiresAt === null ? null : new Date(next.accessExpiresAt).toISOString()}::timestamptz,
        github_refresh = ${json(next.refresh)}::jsonb, github_refresh_digest = ${next.refreshDigest},
        github_pair_digest = ${next.pairDigest}
        WHERE id = ${id} AND github_token_gen = ${gen}`
      return { outcome: "stored" as const }
    }
    if (held?.pair === next.pairDigest || (held?.pair === null && held.same)) return { outcome: "installed_replay" as const }
    yield* enqueueCleanup({ sessionId: id, pairDigest: next.pairDigest, access: next.access, refresh: next.refresh })
    return { outcome: "abandoned_enqueued" as const }
  }))
})

/** Publishes a pre-read observation without replacing a newer receipt; returns the person's effective role. */
export const setRole = (id: string, role: Role | null, generation: string, gen: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* lockRole(sql, id)
      yield* sql`UPDATE sessions SET role = ${role}, role_generation = ${generation}::bigint, role_checked_at = clock_timestamp(),
        role_verified_at = clock_timestamp()
        WHERE id = ${id} AND role_generation <= ${generation}::bigint AND github_token_gen = ${gen}`
      const [row] = yield* sql<{ role: Role | null }>`SELECT ${latestRole(sql, sql`(SELECT person_id FROM sessions WHERE id = ${id})`)} AS role`
      return row!.role
    }))
  })

/**
 * A failed refresh schedules the next check while copying the person's newest role receipt. It cannot promote an
 * older session over a confirmed demotion, even if the session that learned it was later signed out.
 */
export const keepRole = (id: string, gen: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* lockRole(sql, id)
      yield* sql`UPDATE sessions s SET role = ${latestRole(sql, sql`s.person_id`)},
        role_generation = ${latestGeneration(sql, sql`s.person_id`)},
        role_verified_at = ${latestRoleVerifiedAt(sql, sql`s.person_id`)}, role_checked_at = clock_timestamp()
        WHERE id = ${id} AND revoked_at IS NULL AND github_token_gen = ${gen}`
    }))
  })

/** Renew only session discovery, after validating the presented row, and read its clock in the following lookup. */
export const renew = (tokenDigest: string, host: string | null, maxAgeSeconds: number, verifiedKey?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const [found] = yield* sql<{ id: string; alias: string | null }>`SELECT id, NULL::uuid AS alias FROM sessions WHERE token_digest = ${tokenDigest}
        UNION ALL SELECT parent_id AS id, id AS alias FROM host_sessions WHERE token_digest = ${tokenDigest} AND host = ${host}`
      if (found === undefined) return false
      yield* sql`SELECT id FROM sessions WHERE id = ${found.id} FOR UPDATE`
      if (found.alias !== null) yield* sql`SELECT id FROM host_sessions WHERE id = ${found.alias} FOR UPDATE`
    const rows = yield* sql`UPDATE sessions s SET expires_at = least(now() + make_interval(secs => ${maxAgeSeconds}), ${sessionDeadline(sql, sql`s`)})
      WHERE s.id IN (
        SELECT id FROM sessions WHERE token_digest = ${tokenDigest}
        UNION SELECT parent_id FROM host_sessions WHERE token_digest = ${tokenDigest} AND host = ${host}
      ) AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
        AND ${sessionDeadline(sql, sql`s`)} > clock_timestamp()
        AND ${yield* sessionLive(sql, sql`s`)} AND s.expires_at < ${sessionDeadline(sql, sql`s`)}
        AND s.expires_at < now() + make_interval(secs => ${maxAgeSeconds}) - interval '1 day'
        AND ((s.token_digest = ${tokenDigest} AND ${yield* sessionLive(sql, sql`s`, undefined, verifiedKey)}) OR (${host}::text IS NOT NULL AND EXISTS (
          SELECT 1 FROM host_sessions h WHERE h.parent_id = s.id AND h.token_digest = ${tokenDigest}
            AND h.host = ${host} AND h.revoked_at IS NULL AND ${sessionDeadline(sql, sql`s`, sql`h`)} > clock_timestamp() AND ${yield* sessionLive(sql, sql`s`, sql`h`, verifiedKey)})))
      RETURNING s.id`
    return rows.length > 0
    }))
  })


/** Locks the presented row before evaluating eligibility on the database clock after any lock wait. */
export const reauthCandidate = (tokenDigest: string, personId: string, verifiedKey: string, configuredKeys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!configuredKeys.includes(verifiedKey)) return Option.none<{ id: string; eligible: boolean }>()
    yield* sql`SELECT id FROM sessions WHERE token_digest = ${tokenDigest} FOR UPDATE`
    const [row] = yield* sql<{ id: string; eligible: boolean }>`SELECT s.id,
      (s.person_id = ${personId}::uuid AND ${yield* sessionLive(sql, sql`s`, undefined, null)}
        AND s.expires_at > clock_timestamp() + interval '30 seconds'
        AND ${sessionDeadline(sql, sql`s`)} > clock_timestamp() + interval '30 seconds') AS eligible
      FROM sessions s WHERE token_digest = ${tokenDigest}`
    return Option.fromNullishOr(row)
  })

/** Re-stamps the locked eligible row and its tokens in the statement that reads the durable issuer. */
export const reauthenticate = (session: Parameters<typeof createSession>[0], configuredKeys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`SELECT id FROM sessions WHERE id = ${session.id} FOR UPDATE`
    const [row] = yield* sql<{ key: string }>`UPDATE sessions s SET started_at = now(),
      expires_at = now() + make_interval(secs => ${session.maxAgeSeconds}), cookie_key = k.key_id,
      role = CASE WHEN s.role_generation <= ${session.roleGeneration}::bigint THEN ${session.role} ELSE s.role END,
      role_generation = greatest(s.role_generation, ${session.roleGeneration}::bigint),
      role_checked_at = clock_timestamp(),
      role_verified_at = CASE WHEN s.role_generation <= ${session.roleGeneration}::bigint THEN clock_timestamp() ELSE s.role_verified_at END,
      github_access = ${json(session.access)}::jsonb,
      github_access_expires_at = ${session.accessExpiresAt === null ? null : new Date(session.accessExpiresAt).toISOString()}::timestamptz,
      github_refresh = ${json(session.refresh)}::jsonb, github_refresh_digest = ${session.refreshDigest},
      github_pair_digest = ${session.pairDigest ?? null}, github_token_gen = s.github_token_gen + 1
      FROM session_signing_keys k WHERE k.state = 'issuer' AND s.id = ${session.id} AND s.revoked_at IS NULL
        AND least(s.expires_at, s.started_at + interval '400 days') > clock_timestamp()
      RETURNING s.cookie_key AS key`
    yield* configuredIssuer(row?.key, configuredKeys)
    const [effective] = yield* sql<{ role: Role | null }>`SELECT ${latestRole(sql, sql`${session.personId}::uuid`)} AS role`
    return effective!.role
  })

/** Enqueues one sealed token pair, retaining a finished receipt against later store replays. */
export const enqueueCleanup = (pair: { readonly sessionId: string; readonly pairDigest: string; readonly access: Sealed; readonly refresh: Sealed | null }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ id: string }>`INSERT INTO github_token_cleanups (id, session_id, pair_digest, sealed_access, sealed_refresh)
      VALUES (${crypto.randomUUID()}, ${pair.sessionId}, ${pair.pairDigest}, ${json(pair.access)}::jsonb, ${json(pair.refresh)}::jsonb)
      ON CONFLICT (pair_digest) DO NOTHING RETURNING id`
    return Option.map(Option.fromNullishOr(row), row => row.id)
  })

/** Ends only the generation a role check observed, so an old refusal cannot end a reauthenticated session. */
export const revokeIf = (id: string, reason: RevokedReason, gen: number) => Ends.endSession(id, reason, gen)

/** Renews an eligible held alias, or replaces it, while its parent cannot end concurrently. */
export const reauthenticateHost = (session: Parameters<typeof createHostSession>[0], previous: { readonly digest: string; readonly key: string } | null,
  configuredKeys: ReadonlyArray<string>) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* issuance(Effect.gen(function* () {
    yield* sql`SELECT id FROM people WHERE id = (SELECT person_id FROM sessions WHERE id = ${session.parentId}) FOR UPDATE`
    yield* sql`SELECT id FROM sessions WHERE id = ${session.parentId} OR id = (
      SELECT parent_id FROM host_sessions WHERE token_digest = ${previous?.digest ?? null} AND host = ${session.host}
    ) ORDER BY id FOR UPDATE`
    if (previous !== null) yield* sql`SELECT id FROM host_sessions WHERE token_digest = ${previous.digest} AND host = ${session.host} FOR UPDATE`
    const [parent] = yield* sql<{ live: boolean }>`SELECT (${yield* sessionLive(sql, sql`s`)} AND s.expires_at > clock_timestamp()
      AND ${sessionDeadline(sql, sql`s`)} > clock_timestamp()) AS live FROM sessions s WHERE id = ${session.parentId}`
    if (parent?.live !== true) return Option.none<{ id: string; renewed: boolean; key: string; deadline: number }>()
    const [held] = previous === null || !configuredKeys.includes(previous.key) ? [] : yield* sql<{ id: string; eligible: boolean }>`
      SELECT h.id, (h.parent_id = ${session.parentId}::uuid AND ${yield* sessionLive(sql, sql`s`, sql`h`, null)}
        AND s.expires_at > clock_timestamp() + interval '30 seconds'
        AND ${sessionDeadline(sql, sql`s`, sql`h`)} > clock_timestamp() + interval '30 seconds') AS eligible
      FROM host_sessions h JOIN sessions s ON s.id = h.parent_id WHERE h.token_digest = ${previous.digest} AND h.host = ${session.host}`
    const renewed = held?.eligible === true
    if (!renewed && previous !== null) yield* revokeHost(previous.digest, session.host)
    const id = renewed ? held!.id : session.id
    const [issued] = renewed ? yield* sql<{ key: string }>`UPDATE host_sessions h SET started_at = now(), cookie_key = k.key_id
      FROM session_signing_keys k WHERE h.id = ${id} AND h.revoked_at IS NULL AND k.state = 'issuer' RETURNING h.cookie_key AS key`
      : yield* sql<{ key: string }>`INSERT INTO host_sessions (id, token_digest, parent_id, host, cookie_key, started_at)
        SELECT ${id}, ${session.tokenDigest}, ${session.parentId}, ${session.host}, k.key_id, now()
        FROM session_signing_keys k WHERE k.state = 'issuer' RETURNING cookie_key AS key`
    yield* configuredIssuer(issued?.key, configuredKeys)
    const [end] = yield* sql<{ deadline: string }>`SELECT (extract(epoch FROM ${sessionDeadline(sql, sql`s`, sql`h`)})*1000)::bigint::text AS deadline
      FROM host_sessions h JOIN sessions s ON s.id = h.parent_id WHERE h.id = ${id}`
    return Option.some({ id, renewed, key: issued!.key, deadline: Number(end!.deadline) })
  }))
})
