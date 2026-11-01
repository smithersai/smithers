// Admission (worker/Repos.ts, docs/features/repo.md#admission) against real Postgres: the fence on the attempt's row.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as Repos from "./Repos.ts"
import { testFile } from "./test/harness.ts"

const runtime = testFile("repo_admission_fence")

const limits: Repos.Budgets = {
  maxRepositories: 100,
  clonesPerPerson: 100,
  maxStoredBytes: 1e12,
  maxReadBytes: 1e12,
  maxRepositoryBytes: 1e12,
  budgetUsd: 20,
}

test("an attempt that no longer owns the row is never admitted, and changes nothing", async () => {
  const id = "github/octocat/spoon-knife"
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO repositories (id, owner, name, status, stage) VALUES (${id}, 'octocat', 'Spoon-Knife', 'cloning', 'requested')`))
  const stale = await runtime.runPromise(Repos.admit({ id, cloneId: crypto.randomUUID() }, { bytes: 1 }, limits).pipe(
    Effect.match({ onSuccess: () => "admitted", onFailure: (error) => error._tag }),
  ))
  expect(stale).toBe("RepoAdmissionLost")
  const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{
    readonly stored_bytes: string | null
    readonly stage: string
    readonly cloneId: string
  }>`SELECT stored_bytes, stage, clone_id AS "cloneId" FROM repositories WHERE id = ${id}`))
  expect(row).toMatchObject({ stored_bytes: null, stage: "requested" })
  expect(await runtime.runPromise(Repos.admit({ id, cloneId: row!.cloneId }, { bytes: 1 }, limits)))
    .toEqual({ admitted: true, storedBytes: 1 })
})
