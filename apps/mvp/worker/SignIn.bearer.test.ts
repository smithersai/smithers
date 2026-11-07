import { Duration, Effect, Option, Stream } from "effect"
import { HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { DEVICE_PERSON_HEADER, type SessionState } from "../src/features/auth/contract.ts"
import { credentialRoute } from "../src/flows/contract.ts"
import * as RecheckRole from "./flows/RecheckRole.ts"
import { repositoryOf } from "./github/Config.vibe"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as HomeApi from "./home/Api.ts"
import { harness, testFile } from "./test/harness.ts"
import { cookie, signInHarness } from "./test/signIn.ts"

const runtime = testFile("bearer_role_expiry")
test("bearer-only traffic admits the durable recheck across role expiry and recovers the still-valid credential", async () => {
  const checks: Array<{ sessionId: string; generation: number }> = []
  const auth = await signInHarness(runtime, { roleChecks: {
    start: (sessionId, generation) => Effect.sync(() => void checks.push({ sessionId, generation })),
  } })
  const { cookies } = await auth.signInAs()
  const identity = await auth.session(cookies) as SessionState
  if (!identity.signedIn) throw new Error("expected signed in")
  const app = await harness(runtime, () => Stream.empty, { sessions: auth.sessions })
  const issued = await app.fetch(credentialRoute("bearer-expiry-root"), { method: "POST",
    headers: { cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: identity.personId! }, body: JSON.stringify({ flow: "watch/set" }) })
  expect(issued.status).toBe(200)
  const { token } = await issued.json() as { token: string }
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("smithersai/smithers"), app: Option.none(),
  }))
  const readRole = HttpEffect.toWebHandler(HomeApi.make({ roles }).fetch.pipe(Effect.provide(auth.sessions)))
  const request = () => readRole(new Request("http://smithers.test/api/repos/smithersai/smithers/role", { headers: { authorization: `Bearer ${token}` } }))
  expect((await request()).status).toBe(200)
  expect(checks).toEqual([])
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    UPDATE sessions SET role_verified_at = now() - interval '61 minutes', role_checked_at = now() - interval '61 minutes'`))
  const pending = await request()
  expect([pending.status, pending.headers.get("retry-after")]).toEqual([503, "5"])
  expect(checks).toHaveLength(1)
  expect((await request()).status).toBe(503)
  expect(checks[1]).toEqual(checks[0])
  // Execute the admitted flow's real check step; no cookie request starts recovery.
  const steps = RecheckRole.steps(scratch.database, Option.getOrThrow(auth.signIn.configured))
  await Effect.runPromise(steps.check(checks[0]!.sessionId, { kind: "none" }))
  const recovered = await request()
  expect(recovered.status).toBe(200)
  expect(await recovered.json()).toMatchObject({ role: "member" })
  expect(checks).toHaveLength(2)
})

test.each(["cookie", "bearer"] as const)("an idle %s session's first expired request uses the completed durable recheck receipt", async (via) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  let steps: ReturnType<typeof RecheckRole.steps<unknown, never>>
  const checks: string[] = []
  const auth = await signInHarness(runtime, { roleChecks: {
    start: (sessionId) => Effect.sync(() => void checks.push(sessionId)),
    // This host advances the admitted flow through its real check step before it returns its bounded wait.
    wait: (sessionId: string) => Effect.asVoid(steps.check(sessionId, { kind: "none" })),
  } })
  steps = RecheckRole.steps(scratch.database, Option.getOrThrow(auth.signIn.configured))
  const { cookies } = await auth.signInAs()
  const identity = await auth.session(cookies) as SessionState
  if (!identity.signedIn) throw new Error("expected signed in")
  const app = await harness(runtime, () => Stream.empty, { sessions: auth.sessions })
  const issued = await app.fetch(credentialRoute(`idle-${via}`), { method: "POST",
    headers: { cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: identity.personId! }, body: JSON.stringify({ flow: "watch/set" }) })
  expect(issued.status).toBe(200)
  const { token } = await issued.json() as { token: string }
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("smithersai/smithers"), app: Option.none(),
  }))
  const readRole = HttpEffect.toWebHandler(HomeApi.make({ roles }).fetch.pipe(Effect.provide(auth.sessions)))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    UPDATE sessions SET role_verified_at = now() - interval '61 minutes', role_checked_at = now() - interval '61 minutes'`))
  const response = await readRole(new Request("http://smithers.test/api/repos/smithersai/smithers/role", {
    headers: via === "cookie" ? { cookie: cookie(cookies) } : { authorization: `Bearer ${token}` },
  }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ role: "member" })
  expect(checks).toHaveLength(1)
})

test("an expired session's recovery wait is bounded and keeps protected access closed", async () => {
  let starts = 0
  const auth = await signInHarness(runtime, { roleChecks: {
    start: () => Effect.sync(() => void starts++), wait: () => Effect.never, waitWithin: Duration.millis(50),
  } })
  const { cookies } = await auth.signInAs()
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, { repository: repositoryOf("smithersai/smithers"), app: Option.none() }))
  const readRole = HttpEffect.toWebHandler(HomeApi.make({ roles }).fetch.pipe(Effect.provide(auth.sessions)))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    UPDATE sessions SET role_verified_at = now() - interval '61 minutes', role_checked_at = now() - interval '61 minutes'`))
  const response = await readRole(new Request("http://smithers.test/api/repos/smithersai/smithers/role", { headers: { cookie: cookie(cookies) } }))
  expect(response.status).toBe(503)
  expect(starts).toBe(1)
  expect(await auth.session(cookies)).toMatchObject({ signedIn: true, roleConfirmed: false })
  expect(starts).toBe(2)
  expect(auth.line("auth.role_check").map((line) => line.annotations)).toContainEqual(expect.objectContaining({ outcome: "wait_expired" }))
})
