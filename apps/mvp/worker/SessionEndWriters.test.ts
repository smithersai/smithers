import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, relative } from "node:path"
import ts from "typescript"
import { Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import * as Store from "./SessionStore.ts"
import * as Prior from "./SessionPrior.ts"
import * as Rotation from "./SessionSigningKeys.ts"
import * as Keys from "./SessionKeys.ts"
import { testFile } from "./test/harness.ts"
import { configured, cookie, SECRET, signInHarness } from "./test/signIn.ts"
import { DEVICE_PERSON_HEADER } from "../src/features/auth/contract.ts"

const root = fileURLToPath(new URL("../", import.meta.url))
const files = (dir: string): Array<string> => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? entry.name === "test" ? [] : files(path)
    : /\.(?:ts|tsx|mts|vibe)$/.test(path) && !/\.(?:test|d)\.(?:ts|tsx|mts|vibe)$/.test(path) ? [path] : []
})
const writers = (path: string, source: string) => {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const found: Array<string> = []
  const counts = new Map<string, number>()
  const add = (node: ts.Node, sql: string, unsafe = false) => {
    const target = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|ALTER\s+TABLE|CREATE(?:\s+TEMP)?\s+TABLE)\s+(?:(?:"?\w+"?)\.)?"?(sessions|host_sessions)"?\b/i.exec(sql)
    const dynamic = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+\$\{/i.test(sql)
    if (!target && !unsafe && !dynamic) return
    const assigned = target?.[1]!.toUpperCase() === "UPDATE" ? /\bSET\b([\s\S]*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|$)/i.exec(sql)?.[1] ?? "" : sql
    if (target && /^(UPDATE|ALTER|CREATE)/i.test(target[1]!) && !/\b(revoked_at|expires_at|started_at)\b/i.test(assigned)) return
    let owner = "default"
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (ts.isVariableDeclaration(current)) owner = current.name.getText(file)
      if (ts.isFunctionDeclaration(current) && current.name) owner = current.name.text
    }
    const key = `${path}#${owner}:${target ? target[1]!.toUpperCase().replace(/\s+/g, "_") + ":" + target[2]!.toLowerCase() : "UNRESOLVED_SQL"}`
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    found.push(`${key}:${count}`)
  }
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) add(node, node.template.getText(file))
    if (ts.isCallExpression(node) && /\.unsafe$/.test(node.expression.getText(file))) add(node, node.arguments[0]?.getText(file) ?? "", true)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

// Each named SQL statement requires a reason. This detects new writers; it cannot prove an allowed writer fires correctly.
const allowed: Readonly<Record<string, string>> = {
  "db/migrations/0005_sign_in.ts#default:CREATE_TABLE:sessions:1": "The original session schema declares sliding expiry and nullable revocation.",
  "db/migrations/0074_host_sessions.ts#default:CREATE_TABLE:host_sessions:1": "The original alias schema declares nullable revocation and parent deletion cascade.",
  "db/migrations/0109_session_deadlines.ts#default:ALTER_TABLE:host_sessions:1": "Add the alias start column without changing any existing expiry.",
  "db/migrations/0109_session_deadlines.ts#default:ALTER_TABLE:host_sessions:2": "Give old Worker inserts a start default and require the backfilled value.",
  "db/migrations/0109_session_deadlines.ts#default:ALTER_TABLE:sessions:1": "Add the home start column without changing any existing expiry.",
  "db/migrations/0109_session_deadlines.ts#default:ALTER_TABLE:sessions:2": "Give old Worker inserts a start default and require the backfilled value.",
  "db/migrations/0109_session_deadlines.ts#default:UPDATE:host_sessions:1": "Backfill alias starts from their original creation time without ending a live row.",
  "db/migrations/0109_session_deadlines.ts#default:UPDATE:sessions:1": "Backfill home starts from their original creation time without ending a live row.",
  "worker/SessionEnds.ts#endAlias:UPDATE:host_sessions:1": "Record an alias end under its parent lock and commit its anonymous receipt.",
  "worker/SessionEnds.ts#endSession:UPDATE:sessions:1": "Record the home end and clear tokens only after their cleanup request is inserted.",
  "worker/SessionEnds.ts#sweep:DELETE_FROM:host_sessions:1": "Erase aliases of a home ended over thirty days ago, after their receipts exist.",
  "worker/SessionEnds.ts#sweep:DELETE_FROM:host_sessions:2": "Erase an independently ended alias only after its thirty-day row retention.",
  "worker/SessionEnds.ts#sweep:DELETE_FROM:sessions:1": "Erase an ended home after thirty days and after preserving its newest role receipt.",
  "worker/SessionStore.ts#createHostSession:INSERT_INTO:host_sessions:1": "Insert a fresh alias only under a locked live parent, with its own start and issuer.",
  "worker/SessionStore.ts#createSession:INSERT_INTO:sessions:1": "Insert a new home with bounded sliding expiry and an absolute start under its issuer.",
  "worker/SessionStore.ts#reauthenticate:UPDATE:sessions:1": "Restart the locked eligible home in place while explicitly refusing revoked or expired rows.",
  "worker/SessionStore.ts#reauthenticateHost:INSERT_INTO:host_sessions:1": "Insert a replacement alias when the locked held alias is ineligible.",
  "worker/SessionStore.ts#reauthenticateHost:UPDATE:host_sessions:1": "Restart the locked eligible alias in place while refusing revoked rows.",
  "worker/SessionStore.ts#renew:UPDATE:sessions:1": "Extend sliding expiry only after parent and alias locks and post-lock clock checks.",
}

test("every session lifetime writer in worker and migrations is explicitly allowed with a reason", () => {
  const actual = ["worker", "db/migrations"].flatMap(dir => files(join(root, dir))).flatMap(path => writers(relative(root, path), readFileSync(path, "utf8")))
  expect(actual.sort()).toEqual(Object.keys(allowed).sort())
  for (const reason of Object.values(allowed)) expect(reason.length).toBeGreaterThan(20)
})

test("a new writer, migration, raw statement or sweeper cannot evade the inventory", () => {
  for (const sql of ["UPDATE sessions SET expires_at = now()", "DELETE FROM host_sessions", "INSERT INTO sessions (id) VALUES (1)", 'UPDATE "public"."sessions" SET revoked_at = now()', "ALTER TABLE sessions ADD COLUMN started_at timestamptz"]) {
    const found = writers("db/migrations/new.ts", `export default Effect.gen(function* () { yield* sql\`${sql}\` })`)
    expect(found).toHaveLength(1)
    expect(found.every(key => !(key in allowed))).toBe(true)
  }
  expect(writers("worker/new.ts", 'export const sweep = () => sql`UPDATE ${sql(table)} SET expires_at = now()`')).toEqual(["worker/new.ts#sweep:UNRESOLVED_SQL:1"])
  expect(writers("worker/new.ts", 'export const sweep = () => sql.unsafe(statement)')).toEqual(["worker/new.ts#sweep:UNRESOLVED_SQL:1"])
})

const runtime = testFile("end_writers")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
beforeEach(async () => {
  await query(sql => sql`TRUNCATE people, sessions, sign_in_attempts CASCADE`)
  await query(sql => sql`DELETE FROM session_signing_keys`)
  await query(sql => sql`INSERT INTO session_signing_keys (key_id, state, promoted_at) VALUES ('legacy', 'issuer', now())`)
})
const fixture = async () => {
  const h = await signInHarness(runtime, { config: { ...configured, APP_DOMAIN: "smithers.test", APP_ALIASES: "alias.test=/" } })
  const signed = await h.signInAs()
  const [s] = await query(sql => sql<{ id: string; tag: string; person: string }>`SELECT id, session_tag AS tag, person_id AS person FROM sessions ORDER BY created_at DESC LIMIT 1`)
  const alias = crypto.randomUUID(), token = crypto.randomUUID()
  await runtime.runPromise(Store.createHostSession({ id: alias, tokenDigest: Keys.digest(token), parentId: s!.id, host: "alias.test" }))
  const [a] = await query(sql => sql<{ tag: string }>`SELECT session_tag AS tag FROM host_sessions WHERE id = ${alias}`)
  return { h, signed, ...s!, alias, token, aliasTag: a!.tag }
}

for (const path of ["sign_out", "alias_sign_out", "github_refused", "unreadable", "sliding_expiry", "absolute_expiry", "alias_deadline", "sweeper", "erasure", "forget_tokens", "compromised"] as const) test(`prior is ended for the allowed terminal path: ${path}`, async () => {
  const f = await fixture()
  if (path === "sign_out") {
    expect((await f.h.fetch("/api/auth/sign-out", { method: "POST", headers: { origin: "http://smithers.test", cookie: cookie(f.signed.cookies), [DEVICE_PERSON_HEADER]: f.person } })).status).toBe(204)
  } else if (path === "alias_sign_out") {
    const keys = await runtime.runPromise(Keys.make(Redacted.make(SECRET)))
    const proof = await runtime.runPromise(keys.sign("session", f.token))
    expect((await f.h.at("http://alias.test/api/auth/sign-out", { method: "POST", headers: { origin: "http://alias.test", cookie: cookie({ smithers_session: proof }), [DEVICE_PERSON_HEADER]: f.person } })).status).toBe(204)
  } else if (path === "github_refused" || path === "unreadable") await runtime.runPromise(Store.revokeIf(f.id, path, 0))
  else if (path === "alias_deadline") await query(sql => sql`UPDATE host_sessions SET started_at = now() - interval '401 days' WHERE id = ${f.alias}`)
  else if (path === "absolute_expiry") await query(sql => sql`UPDATE sessions SET started_at = now() - interval '401 days' WHERE id = ${f.id}`)
  else if (path === "compromised") {
    const secret = Redacted.make("inventory-replacement-key".padEnd(64, "2"))
    const keyId = `inventory_${f.id.replaceAll("-", "")}`
    await runtime.runPromise(Rotation.stage(keyId, secret))
    const [held] = await query(sql => sql<{ key: string }>`SELECT cookie_key AS key FROM sessions WHERE id = ${f.id}`)
    await runtime.runPromise(Rotation.promote(keyId))
    await runtime.runPromise(Rotation.cease(held!.key))
    await query(sql => sql`UPDATE session_signing_keys SET ceased_at = now() - interval '31 seconds' WHERE key_id = ${held!.key}`)
    await runtime.runPromise(Rotation.compromise(held!.key))
  } else {
    await query(sql => sql`UPDATE sessions SET expires_at = now() - make_interval(days => ${path === "erasure" ? 31 : 1}) WHERE id = ${f.id}`)
    if (path === "sweeper" || path === "erasure") await runtime.runPromise(Store.sweepEnds())
    if (path === "forget_tokens") await runtime.runPromise(Store.forgetTokens(f.id))
  }
  expect(await runtime.runPromise(Prior.read(f.aliasTag))).toBe("ended")
  expect(await runtime.runPromise(Prior.read(f.tag))).toBe(["alias_sign_out", "alias_deadline"].includes(path) ? "live" : "ended")
})

test("a raw live row stays live under missing cookies, failed signatures, missing key configuration and old starts", async () => {
  const f = await fixture()
  await query(sql => sql`UPDATE sessions SET started_at = now() - interval '100 days', expires_at = now() + interval '2 days', cookie_key = 'not-configured' WHERE id = ${f.id}`)
  expect(Option.isNone(await runtime.runPromise(Store.findLiveById(f.id)))).toBe(true)
  for (const proof of [undefined, "garbage", f.signed.cookies.smithers_session]) {
    const response = await f.h.fetch("/api/auth/session", { headers: { "x-smithers-session-tag": f.tag, ...(proof ? { cookie: cookie({ smithers_session: proof }) } : {}) } })
    const answer = await response.json()
    expect(answer).toMatchObject({ prior: "live" })
    expect(answer).not.toHaveProperty("personId")
  }
})

test("pending additive migrations preserve a pre-existing live row and backfill ended receipts without losing cleanup", async () => {
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
    const schema = `migration_session_end_${crypto.randomUUID().replaceAll("-", "")}`
    yield* sql`CREATE SCHEMA ${sql(schema)}`
    yield* sql`SET LOCAL search_path TO ${sql(schema)}`
    for (const [name, migration] of Object.entries(Database.migrations)) if (Number(name.slice(0, 4)) < 100) yield* migration
    const person = crypto.randomUUID(), live = crypto.randomUUID(), ended = crypto.randomUUID(), alias = crypto.randomUUID()
    yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${person}, 101, 'migration-fixture')`
    for (const [id, days] of [[live, 2], [ended, -1]] as const) yield* sql`INSERT INTO sessions (id, person_id, token_digest, role_checked_at, github_access, github_refresh, expires_at)
      VALUES (${id}, ${person}, ${id}, now(), '{"ciphertext":"sealed","nonce":"nonce"}'::jsonb, '{"ciphertext":"sealed-refresh","nonce":"nonce"}'::jsonb, now() + make_interval(days => ${days}))`
    yield* sql`INSERT INTO host_sessions (id, token_digest, parent_id, host) VALUES (${alias}, ${alias}, ${live}, 'alias.test')`
    for (const [name, migration] of Object.entries(Database.migrations)) if (Number(name.slice(0, 4)) >= 100) yield* migration
    const [l] = yield* sql<{ tag: string }>`SELECT session_tag AS tag FROM sessions WHERE id = ${live}`
    const [e] = yield* sql<{ tag: string }>`SELECT session_tag AS tag FROM sessions WHERE id = ${ended}`
    const [a] = yield* sql<{ tag: string }>`SELECT session_tag AS tag FROM host_sessions WHERE id = ${alias}`
    expect(Option.isSome(yield* Store.findLiveById(live))).toBe(true)
    expect(Option.isSome(yield* Store.findHostLive(alias, "alias.test"))).toBe(true)
    expect(yield* Prior.read(l!.tag)).toBe("live")
    expect(yield* Prior.read(a!.tag)).toBe("live")
    expect(yield* Prior.read(e!.tag)).toBe("ended")
    expect(yield* sql`SELECT id FROM sessions WHERE id = ${ended} AND revoked_at IS NOT NULL AND github_access IS NULL AND github_refresh IS NULL`).toHaveLength(1)
    expect(yield* sql`SELECT id FROM github_token_cleanups WHERE session_id = ${ended}`).toHaveLength(1)
    // Roll back the entire disposable schema, including every migration, without retaining another test tree.
    return yield* Effect.fail("discard migration fixture" as const)
  })).pipe(Effect.catchIf(error => error === "discard migration fixture", () => Effect.void))))
})

test("anonymous end receipts survive person deletion while their preserved role receipt cascades", async () => {
  const f = await fixture()
  await query(sql => sql`UPDATE sessions SET expires_at = now() - interval '31 days' WHERE id = ${f.id}`)
  await runtime.runPromise(Store.sweepEnds())
  expect(await query(sql => sql`SELECT person_id FROM person_role_receipts WHERE person_id = ${f.person}`)).toHaveLength(1)
  await query(sql => sql`DELETE FROM people WHERE id = ${f.person}`)
  expect(await query(sql => sql`SELECT person_id FROM person_role_receipts WHERE person_id = ${f.person}`)).toHaveLength(0)
  const columns = await query(sql => sql<{ name: string }>`SELECT column_name AS name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'session_end_receipts' ORDER BY ordinal_position`)
  expect(columns.map(row => row.name)).toEqual(["session_tag", "ended_at", "reason"])
  for (const tag of [f.tag, f.aliasTag]) expect(await runtime.runPromise(Prior.read(tag))).toBe("ended")
})
