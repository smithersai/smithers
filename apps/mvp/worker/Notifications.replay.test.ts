// Real Postgres and Electric: an expired permission must not pin another subject's cursor.
import { Effect, Option, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { NOTIFICATIONS_SHAPE_ROUTE } from "../src/features/attention/contract.ts"
import { BranchRoles } from "./branch/Access.ts"
import { repositoryOf } from "./github/Config.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as Notifications from "./Notifications.ts"
import { app } from "./github/test/harness.ts"
import { accountIdOf, appKey, INSTALLATION_ID, scriptedGitHub } from "./github/test/scriptedGitHub.ts"
import { harness, recorded, testFile } from "./test/harness.ts"

const runtime = testFile("notification_replay")
const sql = (query: string, ...params: ReadonlyArray<unknown>) => runtime.runPromise(
  Effect.flatMap(SqlClient.SqlClient, client => client.unsafe(query, params as Array<never>)))

test.each([1, 3395])("expired authority settles %i subjects without refusing healthy rows or repeating settled writes", async count => {
  const id = crypto.randomUUID()
  const repoId = `github/acme/replay-${count}`
  const login = `reader-${count}`
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ($1, $2, $3)`, id, accountIdOf(login), login)
  await sql(`INSERT INTO github_repositories (repo_id, private, installation_id) VALUES ($1, true, $2)`, repoId, INSTALLATION_ID)
  await sql(`INSERT INTO notification_repository_access (recipient, repo_id, readable, checked_at)
    VALUES ($1, $2, true, clock_timestamp())`, id, repoId)
  await sql(`INSERT INTO github_repo_roles (person_id, repo_id, role, checked_at)
    VALUES ($1, $2, 'member', clock_timestamp())`, id, repoId)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, repo_id, title, href)
    SELECT $1, 'expired-' || n, 'run', 'done', true, gen_random_uuid(), $2, 'withheld payload', '/app'
    FROM generate_series(1, $3::int) n`, id, repoId, count)
  await sql(`INSERT INTO notifications (recipient, subject, kind, state, mine, run_id, title, href)
    VALUES ($1, 'healthy', 'run', 'done', true, gen_random_uuid(), 'healthy payload', '/app')`, id)
  // Expire authority at the buffered-response boundary, including after a renewal, without wall-clock sleeps.
  // This reproduces a projection outliving its underlying grant and exercises stable withholding across polls.
  const github = scriptedGitHub("acme", `replay-${count}`)
  github.roles.set(login, "write")
  github.private = true
  let withhold = true
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: github.http,
  }))
  const h = await harness(runtime, () => Stream.empty, {
    actor: { subject: { kind: "person", id }, role: "member", login },
    branchRoles: BranchRoles.layer(roles),
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      url.searchParams.set("table", `${scratch.name}.notifications`)
      const response = await fetch(url, init)
      const body = await response.arrayBuffer()
      if (withhold) await sql(`UPDATE github_repo_roles SET checked_at = clock_timestamp() - interval '301 seconds'
        WHERE person_id = $1 AND repo_id = $2`, id, repoId)
      return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers })
    },
  })
  const attempts = []
  for (let n = 0; n < 3; n++) {
    const response = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?offset=-1`)
    attempts.push({ status: response.status, reason: h.line("notifications.shape").at(-1)?.annotations["reason"] })
    console.info("replay-drain-attempt", { count, attempt: n,
      emit: h.line("notifications.access.emit").at(-1)?.annotations,
      receipt: await sql(`SELECT role, extract(epoch FROM clock_timestamp() - checked_at)::int AS age FROM github_repo_roles
        WHERE person_id = $1 AND repo_id = $2`, id, repoId),
    })
    expect(await response.text()).not.toContain("withheld payload")
  }
  console.info("replay-drain", { count, attempts })
  expect(attempts.map(attempt => attempt.status)).toEqual([200, 200, 200])
  // Polls two and three must renew the expired permission despite a fresh projection, then emit still fails closed.
  expect(github.seen("GET", /\/permission$/)).toHaveLength(2)

  type Message = { value?: { subject: string; title?: string }; headers?: { operation?: string; control?: string } }
  let cursor = new URLSearchParams({ offset: "-1" })
  let lastStatus = 0
  const page = async (live = false) => {
    const response = await h.fetch(`${NOTIFICATIONS_SHAPE_ROUTE}?${cursor}${live ? "&live=true" : ""}`)
    lastStatus = response.status
    expect([200, 204]).toContain(response.status)
    if (response.headers.has("electric-offset")) cursor = new URLSearchParams({
      handle: response.headers.get("electric-handle")!, offset: response.headers.get("electric-offset")!,
    })
    return response.status === 204 ? [] : await response.json() as Message[]
  }
  const inserts: string[] = []
  for (;;) {
    const messages = await page()
    for (const message of messages) if (message.value && message.headers?.operation !== "delete") inserts.push(message.value.subject)
    if (messages.some(message => message.headers?.control === "up-to-date")) break
  }
  expect(inserts).toEqual(["healthy"])
  expect(h.count(Notifications.emissionTransitions, { direction: "withdrawn" })).toBe(count)
  expect(h.line("notifications.access.emit")[0]?.annotations).toMatchObject({
    replaySubjects: 0, authorityUnknownSubjects: count, withheldSubjects: count, withdrawnSubjects: count, restoredSubjects: 0,
  })
  const versions = await sql(`SELECT subject, xmin::text AS version FROM notifications WHERE recipient = $1 ORDER BY subject`, id)
  await page()
  expect(await sql(`SELECT subject, xmin::text AS version FROM notifications WHERE recipient = $1 ORDER BY subject`, id)).toEqual(versions)
  // Drain withdrawal through a real idle live response (Electric may use a 200 heartbeat or bodyless 204).
  // Renewal must work using only live polls from there, without an unrelated source write or a new snapshot.
  if (count === 1) {
    let idle = false
    for (let pages = 0; pages < 5 && !idle; pages++) {
      const messages = await page(true)
      idle = messages.every(message => message.value === undefined)
      console.info("replay-drain-live", { status: lastStatus, changes: messages.filter(message => message.value).length })
    }
    expect(idle).toBe(true)
  }
  // Authority renewal alone must publish the old retained rows at a NEW cursor, without rewriting their content.
  withhold = false
  await page(count === 1) // The emit transaction must also run after an idle live response.
  expect(await sql(`SELECT count(*)::int AS count FROM notifications WHERE recipient = $1 AND emit_readable = true`, id))
    .toEqual([{ count: count + 1 }])
  const recovered: string[] = []
  // An up-to-date message describes Electric's current WAL position, not proof that the just-committed
  // restoration has replicated. Follow live protocol pages until those inserts arrive; never retry a refusal.
  for (let pages = 0; pages < 20 && recovered.length < count; pages++) {
    const messages = await page(true)
    for (const message of messages) if (message.value && message.headers?.operation !== "delete") recovered.push(message.value.subject)
  }
  expect(recovered).toHaveLength(count)
  expect(new Set(recovered).size).toBe(count)
  expect(recovered.every(subject => subject.startsWith("expired-"))).toBe(true)
  const settled = await sql(`SELECT subject, xmin::text AS version FROM notifications WHERE recipient = $1 ORDER BY subject`, id)
  expect((await page()).filter(message => message.value)).toEqual([])
  expect(await sql(`SELECT subject, xmin::text AS version FROM notifications WHERE recipient = $1 ORDER BY subject`, id)).toEqual(settled)
  expect(h.count(Notifications.emissionTransitions, { direction: "restored" })).toBe(count)
  expect(h.line("notifications.access.emit").at(-1)?.annotations).toMatchObject({
    replaySubjects: 0, withheldSubjects: 0, withdrawnSubjects: 0, restoredSubjects: 0,
  })
  expect(recorded(h)).not.toContain("withheld payload")
  expect(h.span("notifications.access.emit").some(span => span.attributes.get("notifications.withdrawn") === count)).toBe(true)
  console.info("replay-drain-recovered", { count, restored: recovered.length, repeated: 0, idleRecovery: count === 1 })
}, 90_000) // The idle case includes two real Electric long-poll timeouts, not an increased retry deadline.
