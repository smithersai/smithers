// Protected transport admission through the real fleet HTTP handler, Postgres and Electric.
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { AGENT_RUNS_SHAPE_ROUTE, MACHINES_SHAPE_ROUTE } from "../../src/features/fleet/contract.ts"
import { maintainer } from "../feeds/test/harness.ts"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import { testFile } from "../test/harness.ts"
import * as FleetApi from "./FleetApi.ts"
import { fleetHarness } from "./test/fleet.ts"

// Electric keeps a shape's first snapshot immutable. These initially empty shapes must not share the audience
// suite's schema, whose first snapshot asserts seeded rows. Each file owns a real, independently migrated schema.
const runtime = testFile("fleet_authorization")
const shape = (path: string) => `${path}?repo=smithersai/vibelang&offset=-1`
const rows = async (response: Response) => {
  expect(response.status).toBe(200)
  return ((await response.json()) as Array<{ value?: Record<string, unknown> }>).flatMap((row) => row.value === undefined ? [] : [row.value])
}

describe("the fleet's protected transport", () => {
  test.each([AGENT_RUNS_SHAPE_ROUTE, MACHINES_SHAPE_ROUTE].flatMap((path) =>
    ["live_sse", "experimental_live_sse"].map((flag) => ({ path, flag })),
  ))("rejects $flag on protected $path before Electric", async ({ path, flag }) => {
    const h = await fleetHarness(runtime, { actor: maintainer })
    const snapshot = await h.fetch(shape(path))
    expect(snapshot.status).toBe(200)
    await snapshot.text()
    const response = await h.fetch(`${path}?repo=smithersai/vibelang&live=true&${flag}=true` +
      `&handle=${snapshot.headers.get("electric-handle")}&offset=${snapshot.headers.get("electric-offset")}`)
    try {
      expect(response.status).toBe(400)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      expect(h.electric).toHaveLength(1)
      const metric = path === AGENT_RUNS_SHAPE_ROUTE ? FleetApi.runShapes : FleetApi.machineShapes
      expect(h.count(metric, { status: "400", live: "true" })).toBe(1)
    } finally {
      await response.body?.cancel()
    }
  })

  test("an SSE opened before removal cannot deliver a later private fleet row", async () => {
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    let removed = false
    const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
      repository: repositoryOf("smithersai/smithers"), app: Option.none(), local: true,
      localRoles: () => removed ? null : "maintainer",
    }))
    const h = await fleetHarness(runtime, { actor: maintainer, roles })
    const snapshot = await h.fetch(shape(AGENT_RUNS_SHAPE_ROUTE))
    expect(snapshot.status).toBe(200)
    await snapshot.text()
    const at = `${AGENT_RUNS_SHAPE_ROUTE}?repo=smithersai/vibelang&handle=${snapshot.headers.get("electric-handle")}` +
      `&offset=${snapshot.headers.get("electric-offset")}&live=true`
    const response = await h.fetch(`${at}&live_sse=true`)
    try {
      if (response.status === 200) {
        // Baseline evidence through real Electric: revoke, then commit a row that did not exist at admission.
        expect(response.headers.get("content-type")).toContain("text/event-stream")
        removed = true
        expect((await h.fetch(at)).status).toBe(403)
        await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`INSERT INTO agent_runs (key, repo_id, agent, generation, queued_at, account_label)
            VALUES ('after-removal', 'github/smithersai/vibelang', 'coder', 1, now(), 'private-after-removal')`))
        const reader = response.body!.getReader()
        let received = ""
        try {
          while (!received.includes("private-after-removal")) {
            const chunk = await reader.read()
            if (chunk.done) break
            received += new TextDecoder().decode(chunk.value)
          }
        } finally {
          await reader.cancel()
        }
        expect(received, "SSE delivered a new private row after removal").not.toContain("private-after-removal")
      }
      expect(response.status).toBe(400)
      expect(h.electric).toHaveLength(1) // Only the finite snapshot may reach Electric.
    } finally {
      if (!response.body?.locked) await response.body?.cancel()
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`DELETE FROM agent_runs WHERE key = 'after-removal'`))
    }
  })

  test("long polling reauthorizes the next request after removal", async () => {
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    let removed = false
    const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
      repository: repositoryOf("smithersai/smithers"), app: Option.none(), local: true,
      localRoles: () => removed ? null : "maintainer",
    }))
    const admitted = Promise.withResolvers<void>()
    const h = await fleetHarness(runtime, { actor: maintainer, roles,
      onElectric: (url) => { if (url.searchParams.get("live") === "true") admitted.resolve() },
    })
    const first = await h.fetch(shape(MACHINES_SHAPE_ROUTE))
    expect(first.status).toBe(200)
    await first.text()
    const at = `${MACHINES_SHAPE_ROUTE}?repo=smithersai/vibelang&live=true` +
      `&handle=${first.headers.get("electric-handle")}&offset=${first.headers.get("electric-offset")}`
    const pending = h.fetch(at)
    await admitted.promise
    removed = true
    const id = crypto.randomUUID()
    try {
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`INSERT INTO runners (id, repo_id, name, token_sha256, labels, capacity, added_by)
          VALUES (${id}, 'github/smithersai/vibelang', 'after-removal', repeat('e', 64), ARRAY['linux'], 1, 'fixture')`))
      // An admitted long poll may still deliver its batch; it ends, and the next request checks access again.
      expect(await rows(await pending)).toMatchObject([{ name: "after-removal" }])
      const next = await h.fetch(at)
      expect(next.status).toBe(403)
      expect(h.electric).toHaveLength(2)
    } finally {
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM runners WHERE id = ${id}`))
    }
  })

})
