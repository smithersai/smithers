import { Effect, Option, Redacted } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { PullsClient } from "#vibelang/emitted/src/features/pulls/api"
import { ACCEPTS_HEADER, ACCEPTS_CREDENTIAL_STALE } from "../src/features/auth/contract.ts"
import * as Api from "./github/Api.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { repositoryOf } from "#vibelang/emitted/worker/github/Config"
import { BranchRoles } from "./branch/Access.ts"
import { FlowStarter, StartUnavailable } from "#vibelang/emitted/worker/Flows"
import * as Rotation from "./SessionSigningKeys.ts"
import * as SignIn from "./SignIn.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import { testFile } from "./test/harness.ts"
import { configured, cookie, SECRET, signInHarness } from "./test/signIn.ts"

const runtime = testFile("stale_client_compatibility")

test("today's pulls client keeps the pre-stack 401 unless the request explicitly accepts credential-stale", async () => {
  const next = "next-signing-secret-".padEnd(64, "9")
  const h = await signInHarness(runtime, { config: {
    ...configured, SESSION_SECRETS: JSON.stringify({ legacy: SECRET, next }), SESSION_SEAL_SECRET: SECRET,
  } })
  const signed = await h.signInAs()
  const scratch = await runtime.runPromise(TestDatabase.Scratch)
  const repository = repositoryOf("smithersai/smithers")
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, { repository, app: Option.none() }))
  const api = await runtime.runPromise(Api.make(scratch.database, { repository, app: Option.none(), roles }))
  const handler = HttpEffect.toWebHandler(h.signIn.guard(api.fetch.pipe(
    Effect.provide(h.signIn.sessions),
    Effect.provideService(SignIn.RoleChecks, { start: () => Effect.void }),
    Effect.provide(BranchRoles.layer(roles)),
    Effect.provideService(FlowStarter, { start: () => Effect.fail(new StartUnavailable({ errorCode: "not_started" })) }),
    Effect.provide(FetchHttpClient.layer),
  )).pipe(Effect.provide(h.services)))
  const merge = { writeId: crypto.randomUUID(), number: 2, headSha: "a".repeat(40), baseSha: "b".repeat(40), method: "squash" as const }
  let accepts: string | undefined
  const responses: Response[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    request.headers.set("cookie", cookie(signed.cookies))
    if (accepts !== undefined) request.headers.set(ACCEPTS_HEADER, accepts)
    const response = await handler(request)
    responses.push(response.clone())
    return response
  }
  const send = () => runtime.runPromise(Effect.result(Effect.flatMap(PullsClient, client => client.merge("smithersai", "smithers", merge))).pipe(
    Effect.provide(PullsClient.layer({ origin: "http://smithers.test", within: "5 seconds" })),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  ))
  await runtime.runPromise(Rotation.stage("next", Redacted.make(next)))
  await runtime.runPromise(Rotation.promote("next"))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`UPDATE sessions SET cookie_key = 'next'`))
  for (accepts of [undefined, "unknown", "credential-stale-later"]) {
    const result = await send()
    expect(result._tag === "Failure" && { ...result.failure }).toMatchObject({ status: 401 })
    expect(result._tag === "Failure" && result.failure.code).toBeUndefined()
    const response = responses.at(-1)!
    expect(response.status).toBe(401)
    expect(await response.text()).toBe("")
    expect(response.headers.get("x-smithers-credential")).toBe("stale")
    expect(response.headers.get("retry-after")).toBeNull()
    expect(response.headers.get("cache-control")).toContain("no-store")
  }
  expect(ACCEPTS_HEADER).toBe("x-smithers-accepts")
  expect(ACCEPTS_CREDENTIAL_STALE).toBe("credential-stale")
  accepts = ACCEPTS_CREDENTIAL_STALE
  await send()
  const response = responses.at(-1)!
  expect(response.status).toBe(503)
  expect(response.headers.get("x-smithers-credential")).toBe("stale")
  expect(response.headers.get("retry-after")).toBe("1")
  expect(response.headers.get("cache-control")).toContain("no-store")
  expect(await response.text()).toBe("")
  expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT id FROM github_writes`))).toEqual([])
})
