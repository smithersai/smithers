import { Effect, Exit } from "effect"
import { beforeEach, expect, test } from "vitest"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Write from "./Write.ts"
import { admit, REPOSITORY, reset, services, sql } from "./test/fixtures.ts"
import { livePerson } from "./test/livePerson.ts"
import { BOT_LOGIN, scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("github_live_setup")
beforeEach(() => reset(runtime))

test("the live setup records GitHub's account id so the App can seed an issue for its acting person", async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.roles.set("maya", "maintain")
  github.accounts.set("maya", 42)
  const { services: built } = await services(runtime, github)
  const personId = await runtime.runPromise(livePerson(built, REPOSITORY, "maya"))
  const writeId = await admit(runtime, {
    actorId: personId, sessionId: null, via: "agent",
    payload: { op: "issue/create", title: "Seed for triage", body: "A new issue." },
  })
  const written = await runFlow(Write.Write, { writeId }, Write.registration(built), { maxConnections: 3 })
  expect(written.exit).toEqual(Exit.succeed({ status: "done", itemNumber: expect.any(Number) }))
  expect(await sql(runtime, "SELECT author_login AS author FROM items")).toEqual([{ author: BOT_LOGIN }])
  expect(await sql(runtime, "SELECT count(*)::int AS n FROM sessions")).toEqual([{ n: 0 }])
  expect(await sql(runtime, "SELECT github_id::int AS account FROM people")).toEqual([{ account: 42 }])
})

test("the live setup refuses an account without the permission the agent write requires", async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const { services: built } = await services(runtime, github)
  const result = await runtime.runPromise(Effect.result(livePerson(built, REPOSITORY, "outsider")))
  expect(result._tag).toBe("Failure")
  expect(await sql(runtime, "SELECT id FROM people")).toEqual([])
  expect(await sql(runtime, "SELECT id FROM github_writes")).toEqual([])
})
