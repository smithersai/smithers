import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { testFile } from "./harness.ts"
import { resetRepos } from "./repos.ts"

const runtime = testFile("repo_reset")

test("repository reset preserves Electric's snapshot and replicates deletes before returning", async () => {
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`INSERT INTO repositories
    (id, owner, name, status) VALUES ('github/reset/old', 'reset', 'old', 'cloning')`))
  const { name } = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const url = `${await runtime.runPromise(TestDatabase.electricUrl)}/v1/shape?table=${name}.repositories`
  let cursor = "offset=-1"
  for (;;) {
    const response = await fetch(`${url}&${cursor}`)
    expect(response.status).toBe(200)
    const body = await response.json() as Array<{ headers?: { control?: string } }>
    cursor = new URLSearchParams({ offset: response.headers.get("electric-offset")!, handle: response.headers.get("electric-handle")! }).toString()
    if (body.some(row => row.headers?.control === "up-to-date")) break
  }
  await resetRepos(runtime)
  const next = await fetch(`${url}&${cursor}`)
  expect(next.status).toBe(200)
  const body = await next.json() as Array<{ headers?: { operation?: string } }>
  expect(body.filter(row => row.headers?.operation === "delete")).toHaveLength(1)
  expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT id FROM repositories`))).toEqual([])
  await resetRepos(runtime)
  expect((await fetch(`${url}&${cursor}`)).status).toBe(200)
})
