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
  runtime.runPromise(Store.addRunner({ repoId, name, tokenSha256: digestSync(token), labels: ["linux"], capacity: 1 }, {
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

test("lists each live runner with its registrant and its repository's installation, flags the unproven, and no token", async () => {
  await sql`INSERT INTO people (id, github_id, github_login) VALUES (${ADMIN_ID}::uuid, 1, 'octo-admin')`
  // Installed before the runner was registered: proven.
  await sql`INSERT INTO github_repositories (repo_id, installation_id, checked_at) VALUES ('github/acme/old', 7, now() - interval '1 day')`
  // Installation recorded after the runner was registered, and none recorded at all.
  await sql`INSERT INTO github_repositories (repo_id, installation_id, checked_at) VALUES ('github/acme/later', 8, now() + interval '1 day')`
  const tokens = ["token-old-secret", "token-later-secret", "token-none-secret", "token-gone-secret"]
  await register("github/acme/old", "a", tokens[0]!)
  await register("github/acme/later", "b", tokens[1]!)
  await register("github/acme/none", "c", tokens[2]!)
  await register("github/acme/old", "gone", tokens[3]!)
  await sql`UPDATE runners SET removed_at = now(), seen_at = now() WHERE name = 'gone'`
  const answer = await audit(admin)
  expect(answer.status).toBe(200)
  const body = JSON.parse(answer.text) as { installationTime: string; runners: ReadonlyArray<Audit.Row> }
  expect(body.installationTime).toBe("github_repositories.checked_at")
  expect(body.runners.map((row) => [row.repoId, row.name, row.addedBy, row.addedByLogin, row.installation.recorded, row.flags]))
    .toEqual([
      ["github/acme/later", "b", ADMIN_ID, "octo-admin", true, ["installation_recorded_after_added"]],
      ["github/acme/none", "c", ADMIN_ID, "octo-admin", false, ["no_installation"]],
      ["github/acme/old", "a", ADMIN_ID, "octo-admin", true, []],
    ])
  expect(body.runners[0]!.labels).toEqual(["linux"])
  expect(typeof body.runners[0]!.addedAt).toBe("string")
  for (const row of body.runners) expect(Object.keys(row).sort()).toEqual(
    ["addedAt", "addedBy", "addedByLogin", "flags", "installation", "labels", "name", "repoId", "seenAt"],
  )
  for (const token of tokens) {
    expect(answer.text).not.toContain(token)
    expect(answer.text).not.toContain(digestSync(token))
  }
  expect(answer.text).not.toMatch(/token/i)
})
