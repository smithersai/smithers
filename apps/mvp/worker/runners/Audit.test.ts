// The runner audit (decision 0148): every live runner with its registrant and its repository's recorded installation,
// for an Admin of the deployment's own repository in person, against the compose Postgres on this file's own schema.
import { digestSync } from "@smthrs/crypto"
import { Effect } from "effect"
import { HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import type * as Actor from "../Actor.ts"
import { signedIn, signedOut, testFile } from "../test/harness.ts"
import * as Audit from "./Audit.ts"
import * as Store from "./Store.ts"

const runtime = testFile("runner_audit")

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`TRUNCATE runners, runner_changes, github_repositories, people RESTART IDENTITY CASCADE`)))

const sql = <A extends object>(strings: TemplateStringsArray, ...values: Array<unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client<A>(strings, ...(values as Array<never>))))
const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))

const ADMIN_ID = "00000000-0000-4000-8000-000000000001"
const admin: Actor.Actor = { subject: { kind: "person", id: ADMIN_ID }, role: "admin" }
// An Admin of another repository by GitHub's role works as a Member on the deployment's own (the session's role).
const repoAdmin: Actor.Actor = { subject: { kind: "person", id: "person-repo-admin" }, role: "member" }

const register = (repoId: string, name: string, token: string) =>
  runtime.runPromise(Store.addRunner({ repoId, name, tokenSha256: digestSync(token), labels: ["linux"], capacity: 1, repoAuthorized: true }, {
    actorId: ADMIN_ID,
    invocationKey: crypto.randomUUID(),
  }))

const audit = async (actor: Actor.Actor | null) => {
  const handler = HttpEffect.toWebHandler(
    Audit.make(await database()).fetch.pipe(Effect.provide(actor === null ? signedOut : signedIn(actor))),
  )
  const response = await handler(new Request(`http://localhost${Audit.ROUTE}`))
  return { status: response.status, text: await response.text() }
}

test("only an Admin of the deployment's own repository, in person, reads it", async () => {
  expect((await audit(null)).status).toBe(401)
  expect((await audit(repoAdmin)).status).toBe(403)
  expect((await audit({ ...admin, act: { kind: "agent", id: "agent-1" } })).status).toBe(403)
  expect((await audit(admin)).status).toBe(200)
})

// Migration `0095_runner_reauthorization` cleared every runner's authorization: the audit names each one that needs registering again.
test("lists each live runner with its registrant, its authorization and installation, flags what needs acting on, and no token", async () => {
  await sql`INSERT INTO people (id, github_id, github_login) VALUES (${ADMIN_ID}::uuid, 1, 'octo-admin')`
  await sql`INSERT INTO github_repositories (repo_id, installation_id) VALUES ('github/acme/ok', 7)`
  await sql`INSERT INTO github_repositories (repo_id, installation_id) VALUES ('github/acme/legacy', 8)`
  const tokens = ["token-ok-secret", "token-legacy-secret", "token-none-secret", "token-gone-secret"]
  await register("github/acme/ok", "a", tokens[0]!)
  // Registered before the route proved the repository's Admin role: cleared by migration `0095_runner_reauthorization`.
  await register("github/acme/legacy", "b", tokens[1]!)
  await sql`UPDATE runners SET repo_authorized_at = NULL WHERE name = 'b'`
  await register("github/acme/none", "c", tokens[2]!)
  await register("github/acme/ok", "gone", tokens[3]!)
  await sql`UPDATE runners SET removed_at = now(), seen_at = now() WHERE name = 'gone'`
  const answer = await audit(admin)
  expect(answer.status).toBe(200)
  const body = JSON.parse(answer.text) as { runners: ReadonlyArray<Audit.Row> }
  expect(Object.keys(body)).toEqual(["runners"])
  expect(body.runners.map((row) => [row.repoId, row.name, row.addedBy, row.addedByLogin, row.installation.recorded, row.flags]))
    .toEqual([
      ["github/acme/legacy", "b", ADMIN_ID, "octo-admin", true, ["needs_registration"]],
      ["github/acme/none", "c", ADMIN_ID, "octo-admin", false, ["no_installation"]],
      ["github/acme/ok", "a", ADMIN_ID, "octo-admin", true, []],
    ])
  expect(body.runners[0]!.authorizedAt).toBeNull()
  expect(typeof body.runners[2]!.authorizedAt).toBe("string")
  expect(body.runners[0]!.labels).toEqual(["linux"])
  expect(typeof body.runners[0]!.addedAt).toBe("string")
  for (const row of body.runners) expect(Object.keys(row).sort()).toEqual(
    ["addedAt", "addedBy", "addedByLogin", "authorizedAt", "flags", "installation", "labels", "name", "repoId", "seenAt"],
  )
  for (const token of tokens) {
    expect(answer.text).not.toContain(token)
    expect(answer.text).not.toContain(digestSync(token))
  }
  expect(answer.text).not.toMatch(/token/i)
})
