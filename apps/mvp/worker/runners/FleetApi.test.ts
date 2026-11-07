// Audience and shape filtering through the real HTTP handler, Postgres and Electric, including typed role faults.
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import { AGENT_RUNS_SHAPE_ROUTE, MACHINES_SHAPE_ROUTE } from "../../src/features/fleet/contract.ts"
import * as Actor from "../Actor.vibe"
import { admin, agent, maintainer, member, refusingRoles } from "../feeds/test/harness.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { repositoryOf } from "../github/Config.vibe"
import { app } from "../github/test/harness.ts"
import { accountIdOf, appKey, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import { testFile } from "../test/harness.ts"
import * as FleetApi from "./FleetApi.ts"
import { fleetHarness } from "./test/fleet.ts"

const runtime = testFile("fleet_shapes")
const shape = (path: string, repo = "smithersai/vibelang") => `${path}?repo=${encodeURIComponent(repo)}&offset=-1`
const rows = async (response: Response) => {
  expect(response.status).toBe(200)
  return ((await response.json()) as Array<{ value?: Record<string, unknown> }>).flatMap((row) => row.value === undefined ? [] : [row.value])
}
const seeded = () => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.all([
  sql`INSERT INTO agent_runs (key, repo_id, agent, generation, queued_at, account_label, context_tokens, cost_usd)
    VALUES ('a', 'github/smithersai/vibelang', 'coder', 1, now(), 'account-a', 1234, 1.25),
      ('other', 'github/acme/other', 'coder', 1, now(), 'private-other', NULL, NULL)`,
  sql`INSERT INTO runners (id, repo_id, name, token_sha256, labels, capacity, added_by)
    VALUES (gen_random_uuid(), 'github/smithersai/vibelang', 'mini', repeat('a', 64), ARRAY['mac'], 2, 'private-person')`,
], { discard: true })))

describe("the fleet's shapes", () => {
  test("a Member sees the repository's runs, a Maintainer its account label and machines; never token digests", async () => {
    await seeded()
    const m = await fleetHarness(runtime, { actor: member })
    const publicRuns = await rows(await m.fetch(shape(AGENT_RUNS_SHAPE_ROUTE)))
    expect(publicRuns).toHaveLength(1)
    expect(publicRuns[0]).toMatchObject({ key: "a", context_tokens: "1234", cost_usd: "1.2500" })
    expect(publicRuns[0]).not.toHaveProperty("account_label")
    for (const actor of [maintainer, admin]) {
      const h = await fleetHarness(runtime, { actor })
      expect(await rows(await h.fetch(shape(AGENT_RUNS_SHAPE_ROUTE)))).toMatchObject([{ key: "a", account_label: "account-a" }])
      const machines = await rows(await h.fetch(shape(MACHINES_SHAPE_ROUTE)))
      expect(machines).toMatchObject([{ name: "mini", capacity: "2" }])
      expect(JSON.stringify(machines)).not.toMatch(/private-token-digest|private-person|token_sha256|added_by/)
      expect(h.count(FleetApi.runShapes, { status: "200", live: "false" })).toBe(1)
      expect(h.count(FleetApi.machineShapes, { status: "200", live: "false" })).toBe(1)
    }
    expect(m.electric[0]?.searchParams.get("where")).toBe("repo_id = $1")
  })

  test("authentication, invalid repositories and insufficient roles refuse before Electric is contacted", async () => {
    for (const path of [AGENT_RUNS_SHAPE_ROUTE, MACHINES_SHAPE_ROUTE]) {
      const out = await fleetHarness(runtime)
      expect((await out.fetch(shape(path))).status).toBe(401)
      expect(out.electric).toEqual([])
      const missing = await fleetHarness(runtime, { actor: maintainer })
      expect((await missing.fetch(`${path}?offset=-1`)).status).toBe(403)
      expect(missing.electric).toEqual([])
      for (const repo of ["", "one", "a/b/c", "a/b?bad"]) {
        const h = await fleetHarness(runtime, { actor: maintainer })
        expect((await h.fetch(shape(path, repo))).status).toBe(403)
        expect(h.electric).toEqual([])
      }
    }
    for (const actor of [member, agent, { ...member, role: "guest" as const }, { ...member, role: null }]) {
      const h = await fleetHarness(runtime, { actor })
      expect((await h.fetch(shape(MACHINES_SHAPE_ROUTE))).status).toBe(403)
      expect(h.electric).toEqual([])
    }
    const guest = await fleetHarness(runtime, { actor: { subject: { kind: "person", id: "unknown" }, role: "guest" } })
    expect((await guest.fetch(shape(AGENT_RUNS_SHAPE_ROUTE))).status).toBe(403)
  })

  test("unreadable sessions and role failures preserve unavailable versus forbidden and Retry-After", async () => {
    const unreadable = Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }))
    expect((await (await fleetHarness(runtime, { sessions: unreadable })).fetch(shape(AGENT_RUNS_SHAPE_ROUTE))).status).toBe(503)
    for (const [code, status] of [["github_unavailable", 503], ["rate_limited", 503], ["not_found", 403]] as const) {
      const fault = refusingRoles(code)
      const roles = { ...fault, resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code, retryAfterSeconds: 17 })) }
      const h = await fleetHarness(runtime, { actor: maintainer, roles })
      const response = await h.fetch(shape(AGENT_RUNS_SHAPE_ROUTE))
      expect(response.status).toBe(status)
      if (status === 503) expect(response.headers.get("retry-after")).toBe("17")
      expect(h.electric).toEqual([])
    }
    expect(FleetApi.handles(AGENT_RUNS_SHAPE_ROUTE)).toBe(true)
    expect(FleetApi.handles(MACHINES_SHAPE_ROUTE)).toBe(true)
    expect(FleetApi.handles("/other")).toBe(false)
  })
})

describe("a fleet bell row's link shows nothing private to someone whose access ended (decision 0079)", () => {
  test("a stale cached Admin row GitHub no longer backs: the runs and machines are refused before Electric", async () => {
    const github = scriptedGitHub("smithersai", "vibelang")
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
      repository: repositoryOf("smithersai/smithers"),
      app: Option.some(app({ privateKey: await appKey() })),
      http: github.http,
    }))
    const id = crypto.randomUUID()
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.all([
      sql`INSERT INTO people (id, github_id, github_login) VALUES (${id}, ${accountIdOf("revoked")}, 'revoked')`,
      sql`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
        VALUES ('github/smithersai/vibelang', ${id}, 'admin', now() - interval '1 hour')`,
    ], { discard: true })))
    for (const path of [AGENT_RUNS_SHAPE_ROUTE, MACHINES_SHAPE_ROUTE]) {
      const h = await fleetHarness(runtime, { actor: { subject: { kind: "person", id }, role: "member" }, roles })
      const response = await h.fetch(shape(path))
      expect(response.status).toBe(403)
      expect(await response.text()).not.toMatch(/account-a|mini|coder|1\.25/)
      expect(h.electric).toEqual([])
    }
  })
})
