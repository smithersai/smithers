import { Effect, Option, Schema } from "effect"
import { SqlClient, type Statement } from "effect/sql"
import type { Role } from "../src/features/auth/contract.ts"

// Sign-in's rows in Postgres (docs/features/sign-in.md#postgres): people, sign-ins in progress and sessions. Postgres'
// clock decides every expiry. Each function is one statement, or one transaction, against the `SqlClient` in context.

/** A sealed value as a row holds it (`@smthrs/control`'s `CredentialCipher.Sealed`). */
export const Sealed = Schema.Struct({ ciphertext: Schema.String, nonce: Schema.String })
export type Sealed = typeof Sealed.Type

const decodeSealed = Schema.decodeUnknownSync(Sealed)
const sealedOrNull = (value: unknown) => (value === null ? null : decodeSealed(value))
const json = (value: Sealed | null) => (value === null ? null : JSON.stringify(value))
const millis = (value: string | null) => (value === null ? null : Number(value))

/** The person's newest authority receipt, including a verified demotion from a session later signed out. */
const latestRole = (sql: SqlClient.SqlClient, person: Statement.Fragment) => sql`(
  SELECT authority.role FROM sessions authority WHERE authority.person_id = ${person}
  ORDER BY authority.role_generation DESC, authority.role_checked_at DESC, authority.created_at DESC, authority.id DESC LIMIT 1
)`

const latestGeneration = (sql: SqlClient.SqlClient, person: Statement.Fragment) => sql`(
  SELECT max(authority.role_generation) FROM sessions authority WHERE authority.person_id = ${person}
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
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`SELECT id FROM people WHERE id = ${session.personId} FOR UPDATE`
      yield* sql`
      INSERT INTO sessions (id, token_digest, person_id, role, role_generation, role_checked_at, github_access, github_access_expires_at,
        github_refresh, github_refresh_digest, expires_at)
      VALUES (${session.id}, ${session.tokenDigest}, ${session.personId}, ${session.role}, ${session.roleGeneration}::bigint, clock_timestamp(),
        ${json(session.access)}::jsonb,
        ${session.accessExpiresAt === null ? null : new Date(session.accessExpiresAt).toISOString()}::timestamptz,
        ${json(session.refresh)}::jsonb, ${session.refreshDigest},
        now() + make_interval(secs => ${session.maxAgeSeconds}))`
      const [row] = yield* sql<{ role: Role | null }>`SELECT ${latestRole(sql, sql`${session.personId}::uuid`)} AS role`
      return row!.role
    }))
  })

/** A live session: its id, its person's id and login, its role and when the role was last checked (epoch ms). */
export interface Live {
  readonly id: string
  readonly personId: string
  readonly login: string
  readonly role: Role | null
  readonly roleCheckedAt: number
}

/** The live session `which` picks: not signed out, not revoked and not past its end. */
const findLiveBy = (which: (sql: SqlClient.SqlClient) => Statement.Fragment) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<Omit<Live, "roleCheckedAt"> & { readonly roleCheckedAt: string }>`
      SELECT s.id, s.person_id AS "personId", p.github_login AS login, ${latestRole(sql, sql`s.person_id`)} AS role,
        (extract(epoch FROM s.role_checked_at) * 1000)::bigint::text AS "roleCheckedAt"
      FROM sessions s JOIN people p ON p.id = s.person_id
      WHERE ${which(sql)} AND s.revoked_at IS NULL AND s.expires_at > now()`
    return Option.map(Option.fromNullishOr(row), (found): Live => ({
      ...found,
      roleCheckedAt: Number(found.roleCheckedAt),
    }))
  })

/** The live session whose token has `tokenDigest`: not signed out, not revoked and not past its end. */
export const findLive = (tokenDigest: string) => findLiveBy((sql) => sql`s.token_digest = ${tokenDigest}`)

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
        SELECT 1 FROM sessions live WHERE live.person_id = p.id AND live.revoked_at IS NULL AND live.expires_at > now()
      )`
    return row?.member === true
  })

/** A verified cookie's stable person, including an ended session whose GitHub revocation still needs delivery. */
export const ownerOf = (tokenDigest: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly personId: string }>`SELECT person_id::text AS "personId" FROM sessions WHERE token_digest = ${tokenDigest}`
  return Option.map(Option.fromNullishOr(row), (found) => found.personId)
})

/** The live session `id`, as a run credential minted under it names it: none once it ended. */
export const findLiveById = (id: string) => findLiveBy((sql) => sql`s.id = ${id}`)

/**
 * Ends the session with this id for `reason`. Returns its id when it ended now, `None` when it had ended already. A
 * session GitHub refused, or whose tokens no longer open, forgets its GitHub tokens at once; a signed-out one keeps them
 * sealed until `auth/RevokeGitHubToken` revokes them on GitHub and calls `forgetTokens`.
 */
export const revoke = (session: { readonly id: string }, reason: RevokedReason) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* (reason === "sign_out"
      ? sql<{ readonly id: string }>`
        UPDATE sessions SET revoked_at = now(), revoked_reason = ${reason}
        WHERE id = ${session.id} AND revoked_at IS NULL
        RETURNING id`
      : sql<{ readonly id: string }>`
        UPDATE sessions SET revoked_at = now(), revoked_reason = ${reason}, github_access = NULL,
          github_access_expires_at = NULL, github_refresh = NULL, github_refresh_digest = NULL
        WHERE id = ${session.id} AND revoked_at IS NULL
        RETURNING id`)
    return Option.map(Option.fromNullishOr(rows[0]), (row) => row.id)
  })

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
        AND ((revoked_at IS NULL AND expires_at > now()) OR github_access IS NOT NULL)`
    return Option.map(Option.fromNullishOr(row), (found) => found.id)
  })

/** Forgets session `id`'s GitHub tokens, once it has ended: a live session keeps them. */
export const forgetTokens = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      UPDATE sessions SET github_access = NULL, github_access_expires_at = NULL, github_refresh = NULL,
        github_refresh_digest = NULL
      WHERE id = ${id} AND (revoked_at IS NOT NULL OR expires_at <= now())`
  })

/** What a role check reads of a session: whether it is live, and its sealed GitHub tokens. */
export interface Held {
  readonly live: boolean
  readonly access: Sealed | null
  readonly accessExpiresAt: number | null
  readonly refresh: Sealed | null
  readonly refreshDigest: string | null
}

/** Session `id`'s GitHub tokens, or `None` when there is no such session. */
export const held = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly live: boolean
      readonly access: unknown
      readonly accessExpiresAt: string | null
      readonly refresh: unknown
      readonly refreshDigest: string | null
    }>`
      SELECT revoked_at IS NULL AND expires_at > now() AS live, github_access AS access,
        (extract(epoch FROM github_access_expires_at) * 1000)::bigint::text AS "accessExpiresAt",
        github_refresh AS refresh, github_refresh_digest AS "refreshDigest"
      FROM sessions WHERE id = ${id}`
    return Option.map(Option.fromNullishOr(row), (found): Held => ({
      live: found.live,
      access: sealedOrNull(found.access),
      accessExpiresAt: millis(found.accessExpiresAt),
      refresh: sealedOrNull(found.refresh),
      refreshDigest: found.refreshDigest,
    }))
  })

/**
 * Replaces session `id`'s GitHub tokens, only while it still holds the refresh token whose digest is `presented`.
 * Returns false when another refresh replaced it first, or the session ended.
 */
export const replaceTokens = (
  id: string,
  presented: string,
  next: {
    readonly access: Sealed
    readonly accessExpiresAt: number | null
    readonly refresh: Sealed | null
    readonly refreshDigest: string | null
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`
      UPDATE sessions SET github_access = ${json(next.access)}::jsonb,
        github_access_expires_at = ${
      next.accessExpiresAt === null ? null : new Date(next.accessExpiresAt).toISOString()
    }::timestamptz,
        github_refresh = ${json(next.refresh)}::jsonb, github_refresh_digest = ${next.refreshDigest}
      WHERE id = ${id} AND revoked_at IS NULL AND github_refresh_digest = ${presented}
      RETURNING id`
    return rows.length > 0
  })

/** Publishes a pre-read observation without replacing a newer receipt; returns the person's effective role. */
export const setRole = (id: string, role: Role | null, generation: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* lockRole(sql, id)
      yield* sql`UPDATE sessions SET role = ${role}, role_generation = ${generation}::bigint, role_checked_at = clock_timestamp()
        WHERE id = ${id} AND role_generation <= ${generation}::bigint`
      const [row] = yield* sql<{ role: Role | null }>`SELECT ${latestRole(sql, sql`(SELECT person_id FROM sessions WHERE id = ${id})`)} AS role`
      return row!.role
    }))
  })

/**
 * A failed refresh schedules the next check while copying the person's newest role receipt. It cannot promote an
 * older session over a confirmed demotion, even if the session that learned it was later signed out.
 */
export const keepRole = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* lockRole(sql, id)
      yield* sql`UPDATE sessions s SET role = ${latestRole(sql, sql`s.person_id`)},
        role_generation = ${latestGeneration(sql, sql`s.person_id`)}, role_checked_at = clock_timestamp()
        WHERE id = ${id} AND revoked_at IS NULL`
    }))
  })
