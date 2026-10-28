// AUTH-8 resource admission through RepoApi and the real Postgres admission lock.
import { ConfigProvider, Effect } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import type * as Actor from "./Actor.ts"
import * as RepoMetrics from "./RepoMetrics.ts"
import * as Repos from "./Repos.ts"
import { testFile } from "./test/harness.ts"
import { repoHarness, repositoryRow, resetRepos } from "./test/repos.ts"

const runtime = testFile("clone_caps")
const MAYA = "7e1f4b3c-0a5e-4c7d-9f2b-3a4c5d6e7f80"
const actor: Actor.Actor = { subject: { kind: "person", id: MAYA }, role: "member", login: "maya" }
const sql = (statement: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement)))

beforeEach(async () => {
  await resetRepos(runtime)
  await sql("TRUNCATE sessions, people CASCADE")
})

const session = async (role: "guest" | "member", ageSeconds = 0) => {
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${MAYA}', 12345, 'maya') ON CONFLICT DO NOTHING`)
  await sql(`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, expires_at)
    VALUES (gen_random_uuid(), '${crypto.randomUUID()}', '${MAYA}', '${role}', now() - interval '${ageSeconds} seconds', now() + interval '1 day')`)
}

const reserveThree = async (h: Awaited<ReturnType<typeof repoHarness>>) => {
  for (const name of ["one", "two", "three"]) expect((await h.request("maya", name)).status).toBe(202)
}

describe("a person's clone reservations", () => {
  test("a stranger's fourth clone is refused before launch, counted and logged without a person's id", async () => {
    // A Member on this repository, with no deployment membership: its repository role grants no cap exemption.
    const h = await repoHarness(runtime, { actor })
    await reserveThree(h)
    const fourth = await h.request("maya", "four")
    expect([fourth.status, await fourth.json()]).toEqual([429, { code: "repository_limit" }])
    expect(fourth.headers.get("retry-after")).toBeNull()
    expect(await repositoryRow(runtime, "github/maya/four")).toBeUndefined()
    expect(await sql("SELECT count(*)::int AS n FROM clone_requests")).toEqual([{ n: 3 }])
    expect(h.started()).toEqual([])
    expect(h.scripted.calls).toEqual([])
    expect(h.count(RepoMetrics.cloneRequests, { outcome: "repository_limit" })).toBe(1)
    expect(h.count(RepoMetrics.capacity, { reason: "person_repositories" })).toBe(1)
    const line = h.line("repo.clone.request").at(-1)!
    expect(line).toMatchObject({ level: "WARN", annotations: { scope: "person", used: 3, limit: 3, status: 429 } })
    expect(JSON.stringify(line)).not.toContain(MAYA)
    // Sharing a ready or running copy takes no extra place and never changes the person charged for it.
    expect((await h.request("maya", "one")).status).toBe(200)
  })

  test("a deployment Member's fourth clone is allowed; a newer demotion removes that exemption", async () => {
    await session("member", 60)
    const h = await repoHarness(runtime, { actor })
    await reserveThree(h)
    expect((await h.request("maya", "four")).status).toBe(202)
    await session("guest")
    expect((await h.request("maya", "five")).status).toBe(429)
  })

  test("serializes simultaneous reservations at a configured cap, and counts people independently", async () => {
    const h = await repoHarness(runtime, { actor, config: { CLONES_PER_PERSON: "1" } })
    const answers = await Promise.all([h.request("maya", "one"), h.request("maya", "two")])
    expect(answers.map((r) => r.status).sort()).toEqual([202, 429])
    const other = await repoHarness(runtime, { actor: { ...actor, subject: { kind: "person", id: "other" } }, config: { CLONES_PER_PERSON: "1" } })
    expect((await other.request("other", "one")).status).toBe(202)
  })

  test("failed reservations still count, but retrying the same repository consumes no additional place", async () => {
    const h = await repoHarness(runtime, { actor })
    await reserveThree(h)
    await sql("UPDATE repositories SET status = 'failed', stage = NULL, failure = 'unavailable'")
    expect((await h.request("maya", "four")).status).toBe(429)
    expect((await h.request("maya", "one")).status).toBe(202)
    expect(await sql("SELECT count(*)::int AS n FROM clone_requests")).toEqual([{ n: 3 }])
  })

  test("retaining a reservation stays retryable after a lower cap or demotion, but taking another person's does not", async () => {
    await session("member", 60)
    const h = await repoHarness(runtime, { actor })
    await reserveThree(h)
    expect((await h.request("maya", "four")).status).toBe(202)
    await sql("UPDATE repositories SET status = 'failed', stage = NULL, failure = 'unavailable'")
    await session("guest")
    const reduced = await repoHarness(runtime, { actor, config: { CLONES_PER_PERSON: "1" } })
    expect((await reduced.request("maya", "one")).status).toBe(202)
    expect((await reduced.request("maya", "five")).status).toBe(429)
    const other = await repoHarness(runtime, { actor: { ...actor, subject: { kind: "person", id: "other" } }, config: { CLONES_PER_PERSON: "1" } })
    expect((await other.request("other", "one")).status).toBe(202)
    expect((await other.request("maya", "two")).status).toBe(429)
    expect(await sql("SELECT requested_by FROM clone_requests WHERE repo_id = 'github/maya/two'"))
      .toEqual([{ requested_by: MAYA }])
  })

  test("another person's retry cannot free the original person's clone count", async () => {
    const h = await repoHarness(runtime, { actor, config: { CLONES_PER_PERSON: "1" } })
    expect((await h.request("maya", "one")).status).toBe(202)
    await sql("UPDATE repositories SET status = 'failed', stage = NULL, failure = 'unavailable'")
    const other = await repoHarness(runtime, { actor: { ...actor, subject: { kind: "person", id: "other" } }, config: { CLONES_PER_PERSON: "1" } })
    expect((await other.request("maya", "one")).status).toBe(202)
    expect((await h.request("maya", "two")).status).toBe(429)
    expect((await other.request("other", "two")).status).toBe(429)
    await sql("UPDATE repositories SET status = 'failed', stage = NULL, failure = 'unavailable'")
    expect((await h.request("maya", "one")).status).toBe(202)
    expect((await h.request("maya", "two")).status).toBe(429)
    // Removing the actual repository removes it from the count; old feed rows alone consume no capacity.
    await sql("DELETE FROM repositories WHERE id = 'github/maya/one'")
    expect((await h.request("maya", "two")).status).toBe(202)
  })

  test("CLONES_PER_PERSON defaults to three and accepts only positive integers", async () => {
    const read = (values: Record<string, string>) => Effect.runPromiseExit(Repos.budgets.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
    ))
    expect(await read({})).toMatchObject({ _tag: "Success", value: { clonesPerPerson: 3 } })
    expect(await read({ CLONES_PER_PERSON: "5" })).toMatchObject({ _tag: "Success", value: { clonesPerPerson: 5 } })
    for (const value of ["0", "-1", "0.5", "many"]) expect((await read({ CLONES_PER_PERSON: value }))._tag).toBe("Failure")
  })
})
