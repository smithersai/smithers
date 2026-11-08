import { Effect, Metric, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Core } from "@smthrs/integrations"
import * as SessionKeys from "./SessionKeys.ts"
import * as Ends from "./SessionEnds.ts"

/** Rotation failures contain a fixed code, never configuration values or a database error. */
export class RotationRefused extends Schema.TaggedError<RotationRefused>()("SessionKeyRotationRefused", {
  reason: Schema.Literals(["unknown_key", "already_issued", "no_issuer", "cessation_missing", "too_early", "issuer_omitted", "key_omitted", "fingerprint", "seal_fingerprint"]),
}) {}

export const rotations = Metric.counter("smithers_auth_key_rotations", { incremental: true })
const recorded = <A, E, R>(step: string, effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.tap(() => Effect.andThen(
    Metric.update(Metric.withAttributes(rotations, { step, outcome: "completed" }), 1),
    Effect.logInfo("auth.key_rotation").pipe(Effect.annotateLogs({ step, outcome: "completed" })),
  )),
  Effect.tapError(() => Effect.andThen(
    Metric.update(Metric.withAttributes(rotations, { step, outcome: "failed" }), 1),
    Effect.logWarning("auth.key_rotation").pipe(Effect.annotateLogs({ step, outcome: "failed" })),
  )),
  Effect.withSpan("auth.key_rotation", { attributes: { step } }),
)

export type Secrets = Readonly<Record<string, Redacted.Redacted<string>>>
export const fingerprint = (secret: Redacted.Redacted<string>) =>
  Core.Signature.computeHmacSha256Hex("smithers session key check v1", Redacted.value(secret))
export const sealFingerprint = (secret: Redacted.Redacted<string>) =>
  Core.Signature.computeHmacSha256Hex("smithers session seal check v1", Redacted.value(secret))

/** Explicit operator recovery; the next publication pins its configured seal and old ciphertext may no longer open. */
export const resetSeal = () => recorded("reset_seal", Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE session_seal_key SET fingerprint = NULL WHERE id AND fingerprint IS NOT NULL`
}))

/** Key ids are never reused after issuance, because cessation bounds every cookie that key could have signed. */
export const stage = (keyId: string, secret: Redacted.Redacted<string>) => recorded("stage", Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const expected = yield* fingerprint(secret)
  yield* sql`INSERT INTO session_signing_keys (key_id, state, fingerprint) VALUES (${keyId}, 'verifier', ${expected}) ON CONFLICT DO NOTHING`
  const [row] = yield* sql<{ fingerprint: string | null }>`SELECT fingerprint FROM session_signing_keys WHERE key_id = ${keyId}`
  if (row?.fingerprint !== expected) return yield* new RotationRefused({ reason: "fingerprint" })
}))

/** Promote without waiting for issuers: their inserts read the key with an ordinary MVCC SELECT. */
export const promote = (keyId: string) => recorded("promote", Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function* () {
    yield* sql`SET LOCAL lock_timeout = '2s'`
    const [issuer] = yield* sql<{ id: string }>`SELECT key_id AS id FROM session_signing_keys WHERE state = 'issuer' FOR UPDATE`
    if (issuer === undefined) return yield* new RotationRefused({ reason: "no_issuer" })
    const [target] = yield* sql<{ state: string; used: boolean }>`
      SELECT state, promoted_at IS NOT NULL OR ceased_at IS NOT NULL AS used FROM session_signing_keys WHERE key_id = ${keyId} FOR UPDATE`
    if (target === undefined) return yield* new RotationRefused({ reason: "unknown_key" })
    if (target.state !== "issuer") {
      if (target.state !== "verifier" || target.used) return yield* new RotationRefused({ reason: "already_issued" })
      yield* sql`UPDATE session_signing_keys SET state = 'verifier' WHERE key_id = ${issuer.id}`
      yield* sql`UPDATE session_signing_keys SET state = 'issuer', promoted_at = clock_timestamp() WHERE key_id = ${keyId}`
    }
    // A replay after commit still finds every outstanding cessation. Delaying it only lengthens retention.
    const pending = yield* sql<{ id: string }>`SELECT key_id AS id FROM session_signing_keys WHERE state = 'verifier' AND promoted_at IS NOT NULL AND ceased_at IS NULL`
    return pending.map(row => row.id)
  }))
}))

/** This statement must run after promotion commits, so a stalled promotion can never backdate cessation. */
export const cease = (keyId: string) => recorded("cease", Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE session_signing_keys SET ceased_at = clock_timestamp() WHERE key_id = ${keyId} AND state = 'verifier' AND ceased_at IS NULL`
  const [row] = yield* sql<{ ceased: boolean }>`SELECT ceased_at IS NOT NULL AS ceased FROM session_signing_keys WHERE key_id = ${keyId}`
  if (row?.ceased !== true) return yield* new RotationRefused({ reason: "cessation_missing" })
}))

/** Retirement never trusts the state label or the operator's clock. */
export const retire = (keyId: string) => recorded("retire", Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`UPDATE session_signing_keys SET state = 'retired'
    WHERE key_id = ${keyId} AND state <> 'issuer' AND ceased_at IS NOT NULL
      AND now() > ceased_at + interval '401 days' RETURNING key_id`
  if (rows.length === 0) return yield* new RotationRefused({ reason: "too_early" })
}))

/** A deploy reads every row again, including prematurely retired rows, using only database time. */
export const gate = (configured: Secrets, sealSecret: Redacted.Redacted<string>) => recorded("gate", Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const initialized = yield* sql.withTransaction(Effect.gen(function* () {
    const pins: Array<string> = []
    yield* sql`SET LOCAL lock_timeout = '2s'`
    const configuredIds = Object.keys(configured)
    const rows = yield* sql<{ fingerprint: string | null; keyId: string; state: string; ceasedAt: string | null; dbNow: string; droppable: boolean | null }>`
      SELECT fingerprint, key_id AS "keyId", state, ceased_at::text AS "ceasedAt", now()::text AS "dbNow",
        ((ceased_at IS NOT NULL AND now() > ceased_at + interval '401 days') OR
          (state = 'compromised' AND NOT EXISTS (
            SELECT 1 FROM sessions s WHERE s.cookie_key = k.key_id AND s.revoked_at IS NULL
              AND s.expires_at > clock_timestamp() AND s.started_at + interval '400 days' > clock_timestamp()
            UNION ALL SELECT 1 FROM host_sessions h JOIN sessions s ON s.id = h.parent_id
              WHERE h.cookie_key = k.key_id AND h.revoked_at IS NULL AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
                AND least(h.started_at, s.started_at) + interval '400 days' > clock_timestamp()
          ))) AS droppable FROM session_signing_keys k FOR UPDATE`
    for (const id of configuredIds) {
      const row = rows.find(row => row.keyId === id)
      if (row === undefined) return yield* new RotationRefused({ reason: "unknown_key" })
      const expected = yield* fingerprint(configured[id]!)
      if (row.fingerprint === null && id === "legacy" && rows.length === 1 && row.state === "issuer") {
        yield* sql`UPDATE session_signing_keys SET fingerprint = ${expected} WHERE key_id = 'legacy' AND fingerprint IS NULL`
        row.fingerprint = expected
        pins.push("pin_legacy")
      }
      if (row.fingerprint === null || row.fingerprint !== expected) {
        return yield* new RotationRefused({ reason: "fingerprint" })
      }
    }
    const issuers = rows.filter(row => row.state === "issuer")
    if (issuers.length !== 1) return yield* new RotationRefused({ reason: "no_issuer" })
    if (!configuredIds.includes(issuers[0]!.keyId)) return yield* new RotationRefused({ reason: "issuer_omitted" })
    if (rows.some(row => !configuredIds.includes(row.keyId) && row.droppable !== true)) {
      return yield* new RotationRefused({ reason: "key_omitted" })
    }
    if (Redacted.value(sealSecret).length < SessionKeys.MIN_SECRET_LENGTH) {
      return yield* new RotationRefused({ reason: "seal_fingerprint" })
    }
    const expectedSeal = yield* sealFingerprint(sealSecret)
    const [seal] = yield* sql<{ fingerprint: string | null }>`SELECT fingerprint FROM session_seal_key WHERE id FOR UPDATE`
    if (seal?.fingerprint === null) {
      yield* sql`UPDATE session_seal_key SET fingerprint = ${expectedSeal} WHERE id AND fingerprint IS NULL`
      seal.fingerprint = expectedSeal
      pins.push("pin_seal")
    }
    if (seal?.fingerprint !== expectedSeal) return yield* new RotationRefused({ reason: "seal_fingerprint" })
    return pins
  }))
  for (const step of initialized) yield* recorded(step, Effect.void)
}))

/** Configuration rollout precedes this command. Promotion and cessation are separate durable steps. */
export const prepareEmergency = (keyId: string, replacementId: string, secret: Redacted.Redacted<string>) => recorded("emergency_prepare", Effect.gen(function* () {
  if (keyId === replacementId) return yield* new RotationRefused({ reason: "already_issued" })
  const sql = yield* SqlClient.SqlClient
  const [key] = yield* sql<{ state: string; ceased: boolean }>`SELECT state, ceased_at IS NOT NULL AS ceased FROM session_signing_keys WHERE key_id = ${keyId}`
  if (key === undefined) return yield* new RotationRefused({ reason: "unknown_key" })
  yield* stage(replacementId, secret)
  if (key.state === "issuer") return yield* promote(replacementId)
  return key.ceased ? [] : [keyId]
}))

/** The fence outlasts every bounded issuer, including one paused after its MVCC read and before its insert. */
export const compromise = (keyId: string) => recorded("compromise", Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function* () {
    yield* sql`SELECT key_id FROM session_signing_keys WHERE key_id = ${keyId} FOR UPDATE`
    const [key] = yield* sql<{ ready: boolean }>`SELECT (state <> 'issuer' AND ceased_at IS NOT NULL
      AND clock_timestamp() > ceased_at + interval '30 seconds') AS ready FROM session_signing_keys WHERE key_id = ${keyId}`
    if (key === undefined) return yield* new RotationRefused({ reason: "unknown_key" })
    if (!key.ready) return yield* new RotationRefused({ reason: "too_early" })
    // Parent locks precede every alias lock, including a K alias under a parent reauthenticated with J.
    yield* sql`SELECT s.id FROM sessions s WHERE s.cookie_key = ${keyId} OR EXISTS (
      SELECT 1 FROM host_sessions h WHERE h.parent_id = s.id AND h.cookie_key = ${keyId}) ORDER BY s.id FOR UPDATE`
    const homes = yield* sql<{ id: string }>`SELECT id FROM sessions WHERE cookie_key = ${keyId} ORDER BY id`
    for (const row of homes) yield* Ends.endSession(row.id, "compromised")
    const aliases = yield* sql<{ id: string }>`SELECT id FROM host_sessions WHERE cookie_key = ${keyId} ORDER BY parent_id, id`
    for (const row of aliases) yield* Ends.endAlias(row.id, "compromised")
    yield* sql`UPDATE session_signing_keys SET state = 'compromised' WHERE key_id = ${keyId}`
  }))
}))
