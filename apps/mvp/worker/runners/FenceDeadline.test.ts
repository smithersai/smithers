import { Effect, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import { testFile } from "../test/harness.ts"
import * as Fence from "./Fence.vibe"
import * as Store from "./Store.ts"

const runtime = testFile("runner_authority_deadline")
const query = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect)
const sql = (text: string) => query(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(text)))
beforeEach(async () => {
  await sql("TRUNCATE runners, runner_changes, admin_generations, admin_receipts, sessions, people, github_repo_roles CASCADE")
  // Assert all three fixed bounds at the actual mutation, without clock waits or a client mock.
  await sql(`CREATE OR REPLACE FUNCTION check_authority_budget() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('lock_timeout')::interval <> interval '1 second'
        OR current_setting('statement_timeout')::interval <> interval '2 seconds'
        OR current_setting('transaction_timeout')::interval <> interval '5 seconds' THEN
        RAISE EXCEPTION 'write transaction is not bounded';
      END IF;
      RETURN NEW;
    END $$`)
  await sql("DROP TRIGGER IF EXISTS authority_budget ON runner_changes")
  await sql("CREATE TRIGGER authority_budget BEFORE INSERT ON runner_changes FOR EACH ROW EXECUTE FUNCTION check_authority_budget()")
})

test.each(["session", "repository role", "repository session"] as const)("a runner write uses fixed bounds even with an earlier %s deadline", async (kind) => {
  const personId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const repoId = "github/acme/deadline"
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${personId}', 1234, 'deadline-person')`)
  await sql(`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, expires_at)
    VALUES ('${sessionId}', 'digest-${sessionId}', '${personId}', 'admin', now(), clock_timestamp() + interval '30 seconds')`)
  await sql(`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
    VALUES ('${repoId}', '${personId}', 'admin', clock_timestamp() - (${kind === 'repository role' ? 270 : 0} * interval '1 second'))`)
  const authority: Fence.Fence["authority"] = kind === "session"
    ? { _tag: "Session", personId, sessionId }
    : { _tag: "Repo", held: { repoId, personId, role: "admin" },
      session: kind === "repository session" ? { personId, sessionId } : null }
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({ span(options) { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
  const change = await query(Store.addRunner({ repoId, name: "deadline", tokenSha256: "b".repeat(64), labels: [], capacity: 1, repoAuthorized: true }, {
    actorId: personId, invocationKey: crypto.randomUUID(), fenced: { kind: "runners", op: "put", fence: {
      execution: `deadline:${kind}`, generation: 0, expiresAt: Date.now() + 300_000, authority,
    } },
  }).pipe(Effect.provideService(Tracer.Tracer, tracer)))
  expect(change).toBe("set")
  // The fixed bounds are installed in one SQL round trip before locking.
  expect(spans.filter((span) => span.kind === "client" &&
    String(span.attributes.get("db.query.text") ?? span.attributes.get("db.statement") ?? "").includes("set_config('lock_timeout'"))).toHaveLength(1)
  expect(await sql("SELECT name FROM runners")).toEqual([{ name: "deadline" }])
})

test("checks admitted repository and session authority before the expiry", async () => {
  const personId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const repoId = "github/acme/authority"
  const held = { repoId, personId, role: "admin" as const }
  const session = { personId, sessionId }
  const expiresAt = Date.now() + 300_000
  const check = (authority: Fence.Fence["authority"], deadline = expiresAt) => query(
    Effect.flatMap(SqlClient.SqlClient, (client) => client.withTransaction(
      Fence.authorityHolds({ execution: "authority", generation: 0, expiresAt: deadline, authority }),
    )),
  )

  expect(await check({ _tag: "Local" })).toBe(true)
  expect(await check({ _tag: "Local" }, 0)).toBe(false)
  expect(await check({ _tag: "Session", ...session })).toBe(false)
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${personId}', 1234, 'authority-person')`)
  expect(await check({ _tag: "Session", ...session })).toBe(false)

  await sql(`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, expires_at)
    VALUES ('${sessionId}', 'authority-digest', '${personId}', 'member', now(), now() + interval '5 minutes')`)
  expect(await check({ _tag: "Session", ...session })).toBe(false)
  await sql(`UPDATE sessions SET role = 'admin' WHERE id = '${sessionId}'`)
  expect(await check({ _tag: "Session", ...session })).toBe(true)

  expect(await check({ _tag: "Repo", held, session: null })).toBe(false)
  await sql(`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
    VALUES ('${repoId}', '${personId}', 'admin', now())`)
  expect(await check({ _tag: "Repo", held })).toBe(false)
  expect(await check({ _tag: "Repo", held, session: null })).toBe(true)
  expect(await check({ _tag: "Repo", held, session: { ...session, personId: crypto.randomUUID() } })).toBe(false)
  expect(await check({ _tag: "Repo", held, session: { ...session, sessionId: crypto.randomUUID() } })).toBe(false)
  expect(await check({ _tag: "Repo", held, session })).toBe(true)
})

test("the final check for local authority uses only the fence expiry", async () => {
  const fence: Fence.Fence = { execution: "local-deadline", generation: 0, expiresAt: Date.now() + 300_000, authority: { _tag: "Local" } }
  expect(await query(Fence.stillHolds(fence))).toBe(true)
  expect(await query(Fence.stillHolds({ ...fence, expiresAt: 0 }))).toBe(false)
})

test("replays the first outcome and only exposes the receipt to its actor", async () => {
  const execution = "runner-receipt"
  const action = { repoId: "github/acme/authority", kind: "runners", name: "runner" } as const
  const actor = crypto.randomUUID()
  expect(await query(Fence.recorded(execution))).toBeUndefined()
  expect(await query(Fence.receiptOf(execution, actor))).toBeUndefined()
  await query(Fence.receipt(execution, action, "put", "set", actor))
  await query(Fence.receipt(execution, action, "delete", "superseded", actor))
  expect(await query(Fence.recorded(execution))).toBe("set")
  expect(await query(Fence.receiptOf(execution, actor))).toEqual({ kind: "runners", name: "runner", op: "put", outcome: "set" })
  expect(await query(Fence.receiptOf(execution, crypto.randomUUID()))).toBeUndefined()
})
