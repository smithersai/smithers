import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import type { Role } from "../Actor.ts"
import { resetBranches } from "../test/branch.ts"
import { branchRoles, testFile } from "../test/harness.ts"
import { BranchRoles } from "./Access.ts"
import * as Conversations from "./Conversations.ts"
import { visible as visibleIn } from "./RefReads.ts"

const runtime = testFile("branch_ref_reads")
beforeEach(() => resetBranches(runtime))
const repo = "github/o/r"
const actor = (id: string, role: Role | null = "member") => Option.some({ subject: { kind: "person" as const, id }, role })

/** `visible` with `BranchRoles` as a deployment without the App gives them: the session's role. */
const visible = (repository: string, who: Parameters<typeof visibleIn>[1]) =>
  Effect.gen(function* () {
    const scratch = yield* Effect.service(TestDatabase.Scratch)
    return yield* visibleIn(repository, who).pipe(Effect.provide(branchRoles(scratch.database)))
  })

test("only an owner or current share can discover an ephemeral ref; existing refs remain public", async () => {
  const make = (name: string, namespace: "default" | "ephemeral") =>
    runtime.runPromise(Conversations.track(repo, name, "open", "a".repeat(40), "owner", undefined, namespace))
  const { branch } = await make("private", "ephemeral")
  await make("ordinary", "default")
  expect(await runtime.runPromise(visible(repo, actor("owner")))).toEqual(["private"])
  expect(await runtime.runPromise(visible(repo, actor("other")))).toEqual([])
  expect(await runtime.runPromise(visible(repo, Option.none()))).toEqual([])
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`INSERT INTO branch_shares (branch_id, grantee, login, access) VALUES (${branch.branchId}, 'other', 'other', 'view')`))
  expect(await runtime.runPromise(visible(repo, actor("other")))).toEqual(["private"])
  expect(await runtime.runPromise(visible("github/o/elsewhere", actor("owner")))).toEqual([])
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE branches SET deleted_at = now() WHERE id = ${branch.branchId}`))
  expect(await runtime.runPromise(visible(repo, actor("owner")))).toEqual([])
})

test("on a repository the App is installed on, the role there decides what a person discovers (decision 0079)", async () => {
  const sql = (statement: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement)))
  const { branch } = await runtime.runPromise(Conversations.track(repo, "linked", "open", "b".repeat(40), "owner", undefined, "ephemeral"))
  await sql(`INSERT INTO branch_shares (branch_id, grantee, login, access) VALUES ('${branch.branchId}', 'repository', NULL, 'view')`)
  await sql(`INSERT INTO github_repositories (repo_id, installation_id) VALUES ('${repo}', 7)`)
  try {
    const rolesThere = (role: Role | null) =>
      Layer.succeed(BranchRoles, BranchRoles.of({ roleOn: () => Effect.succeed(role) }))
    // The deployment's Admin, a Guest on the repository: the link doesn't reach a Guest.
    expect(await runtime.runPromise(visibleIn(repo, actor("other", "admin")).pipe(Effect.provide(rolesThere("guest"))))).toEqual([])
    // The deployment's Guest, a Member there: the link reaches them.
    expect(await runtime.runPromise(visibleIn(repo, actor("other", "guest")).pipe(Effect.provide(rolesThere("member"))))).toEqual(["linked"])
  } finally {
    await sql(`TRUNCATE github_repositories`)
  }
})
