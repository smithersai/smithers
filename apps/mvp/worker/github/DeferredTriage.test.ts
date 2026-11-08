import { ConfigProvider, Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import { testFile } from "../test/harness.ts"
import { holdSql } from "../test/sqlWait.ts"
import * as Host from "./Host.ts"
import * as TriageStore from "./TriageStore.ts"
import * as Write from "./Write.ts"
import { rememberInstallation } from "./Store.ts"
import { admit, database, judgeSeat, judging, keys, REPOSITORY, reset, signedIn, sql, writeRow } from "./test/fixtures.ts"
import { APP_ID, appKey, INSTALLATION_ID, SCRIPTED_API, scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("deferred_triage")
beforeEach(() => reset(runtime))

const prepare = async (op: "triage/enable" | "triage/pause", state: string) => {
  const github = scriptedGitHub()
  const login = "deferred-maintainer"
  const who = await signedIn(runtime, { login, token: github.userToken(login), role: "maintainer" })
  github.accounts.set(login, login.length * 1000)
  github.roles.set(login, "maintain")
  await runtime.runPromise(TriageStore.enable(REPOSITORY.id, { actorId: who.personId, login, dailyTokens: 1000 }))
  await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
    VALUES ('${REPOSITORY.id}', '${who.personId}', 'maintainer', now())`)
  const [row] = await sql(runtime, `SELECT checked_at::text AS "checkedAt" FROM github_repo_roles WHERE person_id = '${who.personId}'`) as Array<{ checkedAt: string }>
  const authority = { personId: who.personId, sessionId: who.sessionId, scope: { _tag: "Repo" as const,
    held: { repoId: REPOSITORY.id, personId: who.personId, role: "maintainer" as const, checkedAt: row!.checkedAt } } }
  const payload = op === "triage/enable" ? { op, dailyTokens: 2345, authority } : { op, authority }
  const id = await admit(runtime, { actorId: who.personId, sessionId: who.sessionId, via: "person", payload })
  if (state === "promoted") await sql(runtime, `UPDATE github_repo_roles SET role = 'admin', checked_at = clock_timestamp() WHERE person_id = '${who.personId}'`)
  else await sql(runtime, `UPDATE github_repo_roles SET checked_at = now() - interval '6 minutes' WHERE person_id = '${who.personId}'`)
  if (state === "demoted") github.roles.set(login, "write")
  if (state === "lost") github.roles.delete(login)
  if (state === "unavailable") github.faults.push({ match: (_, path) => path.endsWith(`/collaborators/${login}/permission`), status: 503 })
  if (state === "rate_limited") github.faults.push({ match: (_, path) => path.endsWith(`/collaborators/${login}/permission`), status: 429, headers: { "retry-after": "7" } })
  if (state === "not_installed") github.installed = false
  const ready = Option.getOrThrow(await runtime.runPromise(Host.ready(await database(runtime)).pipe(
    Effect.provide(github.layer), Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
      GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: Redacted.value(await appKey()), GITHUB_API_URL: SCRIPTED_API,
    })),
  )))
  const { seat } = await judgeSeat(runtime, judging("abstain"))
  const services = Host.services(ready, { keys: Option.some(await keys()), refresh: () => Effect.void }, () => seat)
  return { github, who, id, services, send: Write.steps(services).send({ writeId: id }) }
}

const settings = () => sql(runtime, `SELECT NOT paused AS enabled, daily_tokens AS "dailyTokens" FROM triage_settings WHERE repo_id = '${REPOSITORY.id}'`)

test.each(["triage/enable", "triage/pause"].flatMap((op) => ["promoted", "stale"].map((state) => [op, state] as const)))(
  "deferred %s succeeds for a %s Maintainer", async (op, state) => {
    const h = await prepare(op as "triage/enable" | "triage/pause", state)
    expect(await runtime.runPromise(h.send)).toEqual({ status: "done", itemNumber: null })
    expect(await settings()).toEqual([{ enabled: op === "triage/enable", dailyTokens: op === "triage/enable" ? 2345 : 1000 }])
    expect(await runtime.runPromise(h.send)).toEqual({ status: "done", itemNumber: null })
    expect(h.github.calls.filter((call) => call.path.includes("/collaborators/"))).toHaveLength(state === "stale" ? 1 : 0)
  },
)

test.each(["demoted", "lost"])("deferred triage refuses an actual %s permission", async (state) => {
  const h = await prepare("triage/pause", state)
  const before = await settings()
  expect(await runtime.runPromise(h.send)).toMatchObject({ status: "refused" })
  expect(await settings()).toEqual(before)
})

test.each(["unavailable", "rate_limited", "not_installed"])("deferred triage retries a %s role read without settling refusal", async (state) => {
  const h = await prepare("triage/pause", state)
  const before = await settings()
  const result = await runtime.runPromise(Effect.result(h.send))
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
  if (state === "rate_limited" && result._tag === "Failure") expect(result.failure.retryAfterMillis).toBe(7000)
  expect(await writeRow(runtime, h.id)).toMatchObject({ status: "pending", failure: null })
  expect(await settings()).toEqual(before)
  h.github.installed = true
  await sql(runtime, `UPDATE github_repo_roles SET read_until = NULL, read_failed = false, read_refusal = NULL WHERE person_id = '${h.who.personId}'`)
  if (state === "not_installed") {
    // A provider change alone does not erase the recorded absence; the installation writer supplies the new receipt.
    expect(await runtime.runPromise(Effect.result(h.send))).toMatchObject({ _tag: "Failure" })
    expect(await writeRow(runtime, h.id)).toMatchObject({ status: "pending", failure: null })
    await runtime.runPromise(rememberInstallation(REPOSITORY.id, INSTALLATION_ID))
  }
  expect(await runtime.runPromise(h.send)).toMatchObject({ status: "done" })
})

test("a session revoked while the deferred role read is in flight cannot commit", async () => {
  const h = await prepare("triage/pause", "stale")
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  let reached!: () => void
  const reading = new Promise<void>((resolve) => { reached = resolve })
  h.github.faults.push({ match: (_, path) => {
    if (!path.includes("/collaborators/")) return false
    reached()
    return true
  }, hold: () => hold })
  const pending = runtime.runPromise(Effect.result(h.send))
  try {
    const stage = await Promise.race([reading.then(() => "reading"), pending.then(() => "settled")])
    expect(stage).toBe("reading")
    await sql(runtime, `UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = '${h.who.sessionId}'`)
  } finally { release() }
  expect(await pending).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
  expect(await writeRow(runtime, h.id)).toMatchObject({ status: "pending", failure: null })
  expect(await runtime.runPromise(Effect.result(h.send))).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
  expect(await writeRow(runtime, h.id)).toMatchObject({ status: "pending", failure: null })
  expect(await settings()).toEqual([{ enabled: true, dailyTokens: 1000 }])
})

test.each(["admin", "member"] as const)("the final transaction sees a role changed to %s after resolution", async (role) => {
  const h = await prepare("triage/pause", "stale")
  const roles = h.services.roles!
  const send = Write.steps({ ...h.services, roles: { ...roles, resolve: (actor, repository) => roles.resolve(actor, repository).pipe(
    Effect.tap(() => Effect.promise(() => sql(runtime, `UPDATE github_repo_roles SET role = '${role}', checked_at = clock_timestamp() WHERE person_id = '${h.who.personId}'`))),
  ) } }).send({ writeId: h.id })
  expect(await runtime.runPromise(send)).toMatchObject({ status: role === "admin" ? "done" : "refused" })
  expect(await settings()).toEqual([{ enabled: role !== "admin", dailyTokens: 1000 }])
})

test("an observation expiring between refresh and commit stays pending for another attempt", async () => {
  const h = await prepare("triage/pause", "stale")
  const roles = h.services.roles!
  const send = Write.steps({ ...h.services, roles: { ...roles, resolve: (actor, repository) => roles.resolve(actor, repository).pipe(
    Effect.tap(() => Effect.promise(() => sql(runtime, `UPDATE github_repo_roles SET checked_at = now() - interval '6 minutes' WHERE person_id = '${h.who.personId}'`))),
  ) } }).send({ writeId: h.id })
  expect(await runtime.runPromise(Effect.result(send))).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable", retryAfterMillis: 1000 } })
  expect(await writeRow(runtime, h.id)).toMatchObject({ status: "pending", failure: null })
  expect(await settings()).toEqual([{ enabled: true, dailyTokens: 1000 }])
  expect(await runtime.runPromise(h.send)).toMatchObject({ status: "done" })
})

test.each(["triage/enable", "triage/pause"].flatMap(op =>
  ["expired denial", "replaced denial", "expired session"].map(change => ({ op, change }))))(
  "$op revalidates a $change after waiting for the write lock", async ({ op, change }) => {
    const h = await prepare(op as "triage/enable" | "triage/pause", "demoted")
    const before = await settings()
    const held = await holdSql(runtime, client => client`SELECT 1 FROM github_writes WHERE id = ${h.id}::uuid FOR UPDATE`)
    const attempt = runtime.runPromise(Effect.result(h.send))
    try {
      await expect.poll(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, client =>
        Effect.map(client<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE ${held.pid} = ANY(pg_blocking_pids(pid))`, rows => rows[0]!.n))), { timeout: 1000, interval: 10 }).toBe(1)
      expect(await sql(runtime, `SELECT role FROM github_repo_roles WHERE person_id = '${h.who.personId}'`))
        .toEqual([{ role: "member" }])
      if (change === "expired denial") await sql(runtime,
        `UPDATE github_repo_roles SET checked_at = clock_timestamp() - interval '6 minutes' WHERE person_id = '${h.who.personId}'`)
      else if (change === "replaced denial") await sql(runtime,
        `UPDATE github_repo_roles SET role = 'maintainer', checked_at = clock_timestamp() WHERE person_id = '${h.who.personId}'`)
      else await sql(runtime, `UPDATE sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = '${h.who.sessionId}'`)
    } finally { await held.release(); await attempt }
    expect(await attempt).toMatchObject(change === "replaced denial"
      ? { _tag: "Success", success: { status: "done" } }
      : { _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
    expect(await writeRow(runtime, h.id)).toMatchObject({ status: change === "replaced denial" ? "done" : "pending", failure: null })
    if (change !== "replaced denial") expect(await settings()).toEqual(before)
    if (change === "expired denial") {
      h.github.roles.set("deferred-maintainer", "maintain")
      expect(await runtime.runPromise(h.send)).toMatchObject({ status: "done" })
    }
  },
)
