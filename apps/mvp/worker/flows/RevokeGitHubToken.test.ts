// `auth/RevokeGitHubToken` (worker/flows/RevokeGitHubToken.ts, docs/features/sign-in.md#signing-out) on the Node host
// (worker/test/flowHost.ts) and as its steps alone, over this file's schema of the compose Postgres, with sessions made
// and signed out by real sign-in against the scripted GitHub (worker/test/github.ts).
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Cause, Effect, Exit, Logger, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { DEVICE_PERSON_HEADER } from "../../src/features/auth/contract.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as SessionKeys from "../SessionKeys.ts"
import { runFlow } from "../test/flowHost.ts"
import { type ScriptedGitHub, scriptedGitHub } from "../test/github.ts"
import { testFile } from "../test/harness.ts"
import { cookie, SECRET, signInHarness } from "../test/signIn.ts"
import * as RevokeGitHubToken from "./RevokeGitHubToken.ts"

const runtime = testFile("revoke_token")

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE sessions, sign_in_attempts, people CASCADE`),
  )
)

const sql = (statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe(statement))))

/** Signs `github`'s person in for real, then out: what the flow needs, and what sign-out started. */
const signedOut = async (github: ScriptedGitHub = scriptedGitHub()) => {
  const h = await signInHarness(runtime, { github })
  const { cookies } = await h.signInAs()
  const [{ id, personId }] = (await sql(
    `SELECT id, person_id AS "personId" FROM sessions ORDER BY created_at DESC LIMIT 1`,
  )) as unknown as [{ id: string; personId: string }]
  // The device says whose session it signs out, as the app's does (decision 0023); without it sign-out is refused.
  const response = await h.fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { origin: "http://smithers.test", cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: personId },
  })
  expect(response.status).toBe(204)
  const services: RevokeGitHubToken.Services = {
    keys: await Effect.runPromise(SessionKeys.make(Redacted.make(SECRET))),
    github: github.service,
  }
  const database = await runtime.runPromise(Effect.gen(function* () {
    return (yield* TestDatabase.Scratch).database
  }))
  return { h, github, cookies, id, personId, services, database, access: github.issued[0]!.accessToken }
}

type SignedOut = Awaited<ReturnType<typeof signedOut>>

/** What Postgres holds of the session's GitHub tokens. */
const tokens = async (id: string) =>
  ((await sql(`SELECT github_access IS NULL AS "accessGone", github_refresh IS NULL AS "refreshGone",
      github_refresh_digest IS NULL AS "digestGone", github_access_expires_at IS NULL AS "expiryGone",
      revoked_reason AS "revokedReason"
    FROM sessions WHERE id = '${id}'`)) as unknown as [
    { accessGone: boolean; refreshGone: boolean; digestGone: boolean; expiryGone: boolean; revokedReason: string },
  ])[0]

const forgotten = { accessGone: true, refreshGone: true, digestGone: true, expiryGone: true }

const run = (s: SignedOut) =>
  runFlow(RevokeGitHubToken.RevokeGitHubToken, { sessionId: s.id }, RevokeGitHubToken.registration(s.database, s.services))

/** One revocation, as the step runs it, with its records. */
const once = (s: SignedOut, sessionId = s.id) =>
  Effect.runPromiseExit(RevokeGitHubToken.observed(sessionId, s.services, s.database))

/** Why a step failed: its `RevocationFailed` reason. */
const reasonOf = (exit: Exit.Exit<unknown, RevokeGitHubToken.RevocationFailed>) =>
  Exit.isFailure(exit) ? (Cause.squash(exit.cause) as RevokeGitHubToken.RevocationFailed).reason : "succeeded"

describe("auth/RevokeGitHubToken", () => {
  test("sign-out keeps the sealed tokens and starts the flow once; on the Node host it revokes the token and forgets them", async () => {
    const s = await signedOut()
    // Signed out, the session holds its sealed tokens until the flow forgets them.
    expect(await tokens(s.id)).toMatchObject({ accessGone: false, refreshGone: false, revokedReason: "sign_out" })
    expect(s.h.revocations).toEqual([s.id])
    // Signing out again before the flow ran starts the same execution again, a no-op on the host.
    const signOut = () =>
      s.h.fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { origin: "http://smithers.test", cookie: cookie(s.cookies), [DEVICE_PERSON_HEADER]: s.personId },
      })
    await signOut()
    expect(s.h.revocations).toEqual([s.id, s.id])

    const ran = await run(s)
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "revoked" }))
    expect(ran.status).toBe("completed")
    expect(s.github.calls.filter((step) => step === "revoke")).toHaveLength(1)
    expect(s.github.accepts(s.access)).toBe(false)
    expect(await tokens(s.id)).toMatchObject(forgotten)
    // Run again, it finds nothing to revoke, and signing out again finds nothing to start.
    expect((await run(s)).exit).toEqual(Exit.succeed({ outcome: "none" }))
    expect(s.github.calls.filter((step) => step === "revoke")).toHaveLength(1)
    await signOut()
    expect(s.h.revocations).toEqual([s.id, s.id])
  })

  test("the flow ends a session still live, so the revocation never waits on the request that started it", async () => {
    // Sign-out admits the flow, then ends the session; a Worker that died in between leaves the session live.
    const github = scriptedGitHub()
    const h = await signInHarness(runtime, { github })
    const { cookies } = await h.signInAs()
    const [{ id }] = (await sql(`SELECT id FROM sessions`)) as unknown as [{ id: string }]
    const services = { keys: await Effect.runPromise(SessionKeys.make(Redacted.make(SECRET))), github: github.service }
    const database = await runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))

    const ran = await runFlow(RevokeGitHubToken.RevokeGitHubToken, { sessionId: id }, RevokeGitHubToken.registration(database, services))

    expect(ran.exit).toEqual(Exit.succeed({ outcome: "revoked" }))
    expect(await tokens(id)).toMatchObject({ ...forgotten, revokedReason: "sign_out" })
    expect(github.accepts(github.issued[0]!.accessToken)).toBe(false)
    expect(await h.session(cookies)).toEqual({ signedIn: false, available: true, hostedModel: false })
  })

  test("signing in again in the same browser starts the revocation of the session it ended", async () => {
    const github = scriptedGitHub()
    const h = await signInHarness(runtime, { github })
    const first = await h.signInAs()
    const [{ id }] = (await sql(`SELECT id FROM sessions`)) as unknown as [{ id: string }]
    const started = await h.start()
    const { code, state } = github.approve(started.location)
    await h.callback({ code, state }, { smithers_sign_in: started.cookies["smithers_sign_in"]!.value, ...first.cookies })
    expect(h.revocations).toEqual([id])
    expect(await tokens(id)).toMatchObject({ accessGone: false, revokedReason: "sign_out" })
  })

  test("a token GitHub no longer has counts as revoked", async () => {
    const s = await signedOut()
    s.github.revoke(s.access)
    expect(await once(s)).toEqual(Exit.succeed({ outcome: "revoked" }))
    expect(await tokens(s.id)).toMatchObject(forgotten)
  })

  test("GitHub down once is retried by the step's retry policy", async () => {
    const s = await signedOut()
    s.github.failOnce.revoke = "unavailable"
    const ran = await run(s)
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "revoked" }))
    expect(s.github.calls.filter((step) => step === "revoke")).toHaveLength(2)
    expect(s.github.accepts(s.access)).toBe(false)
  })

  test("a revocation that fails every attempt forgets the tokens anyway", async () => {
    const s = await signedOut()
    s.github.faults.revoke = "misconfigured"
    const ran = await run(s)
    // Its step's retry policy ran out (five attempts), then the flow forgot the tokens rather than failing.
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "forgotten" }))
    expect(ran.status).toBe("completed")
    expect(s.github.calls.filter((step) => step === "revoke")).toHaveLength(5)
    expect(await tokens(s.id)).toMatchObject(forgotten)
  }, 60_000)

  test("GitHub or Postgres failing fails the step with its reason, and keeps the tokens", async () => {
    const s = await signedOut()
    for (const [reason, expected] of [["unavailable", "github_unavailable"], ["misconfigured", "github_misconfigured"]] as const) {
      s.github.failOnce.revoke = reason
      expect(reasonOf(await once(s))).toBe(expected)
    }
    const down = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    expect(reasonOf(await Effect.runPromiseExit(RevokeGitHubToken.observed(s.id, s.services, down)))).toBe("database")
    expect(reasonOf(await Effect.runPromiseExit(RevokeGitHubToken.forget(s.id, down)))).toBe("database")
    expect(reasonOf(await Effect.runPromiseExit(RevokeGitHubToken.end(s.id, down)))).toBe("database")
    expect(await tokens(s.id)).toMatchObject({ accessGone: false, refreshGone: false })
  })

  test("a sealed token that no longer opens (SESSION_SECRET changed) is forgotten without reaching GitHub", async () => {
    const s = await signedOut()
    await sql(`UPDATE sessions SET github_access = '{"ciphertext":"AAAA","nonce":"AAAAAAAAAAAAAAAA"}'`)
    expect(await once(s)).toEqual(Exit.succeed({ outcome: "unreadable" }))
    expect(s.github.calls).not.toContain("revoke")
    expect(await tokens(s.id)).toMatchObject(forgotten)
  })

  test("a live session, or none, is left alone; a session GitHub refused needs no revocation", async () => {
    const github = scriptedGitHub()
    const h = await signInHarness(runtime, { github })
    const { cookies } = await h.signInAs()
    const [{ id, personId }] = (await sql(`SELECT id, person_id AS "personId" FROM sessions`)) as unknown as [
      { id: string; personId: string },
    ]
    const s: SignedOut = {
      h,
      github,
      cookies,
      id,
      personId,
      access: github.issued[0]!.accessToken,
      services: { keys: await Effect.runPromise(SessionKeys.make(Redacted.make(SECRET))), github: github.service },
      database: await runtime.runPromise(Effect.gen(function* () {
        return (yield* TestDatabase.Scratch).database
      })),
    }
    expect(await once(s)).toEqual(Exit.succeed({ outcome: "live" }))
    expect(await Effect.runPromiseExit(RevokeGitHubToken.forget(s.id, s.database))).toEqual(
      Exit.succeed({ outcome: "forgotten" }),
    )
    expect(await tokens(s.id)).toMatchObject({ accessGone: false })
    expect(await once(s, crypto.randomUUID())).toEqual(Exit.succeed({ outcome: "none" }))
    // A role check that finds GitHub refused the session ends it and forgets its tokens at once.
    await sql(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'github_refused', github_access = NULL,
      github_refresh = NULL WHERE id = '${id}'`)
    expect(await once(s)).toEqual(Exit.succeed({ outcome: "none" }))
    expect(github.calls).not.toContain("revoke")
    expect(h.revocations).toEqual([])
  })

  test("its records carry the outcome and the session id, never a token or a login", async () => {
    const s = await signedOut()
    const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const logger = Logger.make((options) => void logs.push(StructuredLogger.formatStructured.log(options)))
    const record = (effect: Effect.Effect<unknown, unknown>) =>
      Effect.runPromise(Effect.exit(effect).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger]))))
    s.github.failOnce.revoke = "unavailable"
    await record(RevokeGitHubToken.end(s.id, s.database))
    await record(RevokeGitHubToken.observed(s.id, s.services, s.database))
    await record(RevokeGitHubToken.observed(s.id, s.services, s.database))
    expect(logs.map((log) => log.annotations)).toEqual([
      expect.objectContaining({ sessionId: s.id, step: "end", outcome: "over" }),
      expect.objectContaining({
        sessionId: s.id,
        step: "revoke",
        outcome: "failed",
        errorCode: "@smthrs/mvp/auth/GitHubRefused",
      }),
      expect.objectContaining({ sessionId: s.id, step: "revoke", outcome: "revoked" }),
    ])
    const text = JSON.stringify(logs)
    for (const issued of s.github.issued) {
      expect(text).not.toContain(Redacted.value(issued.accessToken))
      expect(text).not.toContain(Redacted.value(issued.refreshToken!))
    }
    expect(text).not.toContain("octocat")
  })
})
