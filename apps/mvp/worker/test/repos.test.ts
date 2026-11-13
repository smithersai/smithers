import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import { describe, expect, test } from "vitest"
import { cloneExecutionId } from "../../src/features/repo/contract.ts"
import { testFile } from "./harness.ts"
import { repoHarness, repositoryRow } from "./repos.ts"

const runtime = testFile("repo_host")

describe("the clone test host", { timeout: 120_000 }, () => {
  test("concurrent cold launches share one engine, start each execution once and expose every result", async () => {
    const host = await repoHarness(runtime)
    const repositories = [["octocat", "One"], ["octocat", "Two"]] as const
    const requested = await Promise.all(repositories.map(async ([owner, name]) => {
      host.scripted.publish(owner, name)
      const response = await host.request(owner, name)
      expect(response.status).toBe(202)
      return { owner, name, ...await response.json() as { id: string; cloneId: string } }
    }))
    const responses = await Promise.all(requested.flatMap(({ owner, name, cloneId }) =>
      [host.launch(owner, name, cloneId), host.launch(owner, name, cloneId)]))
    expect(responses.map(response => response.status)).toEqual([202, 202, 202, 202])
    await host.settled()
    const ids = requested.map(({ id, cloneId }) => cloneExecutionId(id, cloneId))
    expect(host.engineSchemas()).toEqual([host.engineSchema()])
    expect(host.started().sort()).toEqual(ids.sort())
    expect(await Promise.all(ids.map(id => host.status(id)))).toEqual(["completed", "completed"])
    for (const { id } of requested) expect(await repositoryRow(runtime, id)).toMatchObject({ status: "ready" })
    // Repeating a settled launch neither rebuilds its host nor starts another fiber.
    const first = requested[0]!
    expect((await host.launch(first.owner, first.name, first.cloneId)).status).toBe(200)
    expect(host.started().sort()).toEqual(ids.sort())
    expect(host.engineSchemas()).toHaveLength(1)
    const schemas = host.engineSchemas()
    await host.close()
    const remaining = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql =>
      sql<{ nspname: string }>`SELECT nspname FROM pg_namespace WHERE nspname = ANY(${schemas})`))
    expect(remaining).toEqual([])
  })

  test("concurrent preparation shares initialization and releases its permit after a database failure", async () => {
    let available = false
    const host = await repoHarness(runtime, {
      engineDatabaseGate: Effect.suspend(() => available ? Effect.void : Effect.fail(new SqlError({
        reason: new ConnectionError({ cause: "injected outage", message: "unavailable", operation: "execute" }),
      }))),
    })
    host.scripted.publish("octocat", "Recover")
    const request = await host.request("octocat", "Recover")
    const { id, cloneId } = await request.json() as { id: string; cloneId: string }
    expect((await host.launch("octocat", "Recover", cloneId)).status).toBe(503)
    expect(host.started()).toEqual([])
    expect(host.engineSchemas()).toEqual([])
    available = true
    await Promise.all([host.prepareCloneEngine(), host.prepareCloneEngine()])
    expect(host.engineSchemas()).toEqual([host.engineSchema()])
    expect((await host.launch("octocat", "Recover", cloneId)).status).toBe(202)
    await host.settled()
    expect(host.started()).toEqual([cloneExecutionId(id, cloneId)])
    expect(await host.status(cloneExecutionId(id, cloneId))).toBe("completed")
  })
})
