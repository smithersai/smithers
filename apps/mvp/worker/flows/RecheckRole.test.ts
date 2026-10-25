// `auth/RecheckRole` (worker/flows/RecheckRole.ts, docs/features/sign-in.md#role-checks) on the Node host
// (worker/test/flowHost.ts) and as its step alone, over this file's schema of the compose Postgres, with sessions made
// by real sign-in against the scripted GitHub (worker/test/github.ts).
import { FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/flows"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Logger, Redacted, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { GitHubRefused } from "../GitHubAuth.ts"
import * as SessionKeys from "../SessionKeys.ts"
import * as SessionStore from "../SessionStore.ts"
import * as SignIn from "../SignIn.ts"
import { build, runFlow } from "../test/flowHost.ts"
import { type ScriptedGitHub, scriptedGitHub } from "../test/github.ts"
import { testFile } from "../test/harness.ts"
import { SECRET, signInHarness } from "../test/signIn.ts"
import * as RecheckRole from "./RecheckRole.ts"

const runtime = testFile("recheck_role")

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE sessions, sign_in_attempts, people CASCADE`),
  )
)

const sql = (statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe(statement))))

const keys = () => Effect.runPromise(SessionKeys.make(Redacted.make(SECRET)))

/** Signs `github`'s person in for real, and returns what the check needs and the browser's cookies. */
const signedIn = async (github: ScriptedGitHub = scriptedGitHub()) => {
  const h = await signInHarness(runtime, { github })
  const { cookies } = await h.signInAs()
  const [{ id, personId }] = (await sql(`SELECT id, person_id::text AS "personId" FROM sessions ORDER BY created_at DESC LIMIT 1`)) as unknown as [
    { id: string; personId: string },
  ]
  const services: RecheckRole.Services = { keys: await keys(), github: github.service, repository: "smithersai/smithers" }
  const database = await runtime.runPromise(Effect.gen(function* () {
    return (yield* TestDatabase.Scratch).database
  }))
  return { h, github, cookies, id, personId, services, database }
}

const session = async (id: string) =>
  ((await sql(`SELECT role, revoked_reason AS "revokedReason", github_refresh_digest AS "refreshDigest",
      github_access IS NULL AS "forgotten", extract(epoch FROM now() - role_checked_at)::float8 AS age
    FROM sessions WHERE id = '${id}'`)) as unknown as [
    { role: string | null; revokedReason: string | null; refreshDigest: string | null; forgotten: boolean; age: number },
  ])[0]

/** Makes the session's GitHub token expire within a minute, so the check refreshes it. */
const expiring = (id: string) =>
  sql(`UPDATE sessions SET github_access_expires_at = now() + interval '1 minute' WHERE id = '${id}'`)

/** Why a check failed: its `RoleCheckFailed` reason. */
const reasonOf = (exit: Exit.Exit<unknown, RecheckRole.RoleCheckFailed>) =>
  Exit.isFailure(exit) ? (Cause.squash(exit.cause) as RecheckRole.RoleCheckFailed).reason : "succeeded"

/** One check's steps in order, as the flow runs them once each, with their records. */
const checking = (s: Awaited<ReturnType<typeof signedIn>>, sessionId = s.id, database = s.database) => {
  const steps = RecheckRole.steps(database, s.services)
  return Effect.flatMap(steps.redeem(sessionId), (redemption) =>
    Effect.andThen(steps.store(sessionId, redemption), steps.check(sessionId, redemption)))
}

/** One check, as the flow's steps run it, with its records. */
const checkOnce = (s: Awaited<ReturnType<typeof signedIn>>) => Effect.runPromiseExit(checking(s))

describe("auth/RecheckRole", () => {
  test("runs on the Node host: reads the role again and records when", async () => {
    const s = await signedIn()
    await sql(`UPDATE sessions SET role_checked_at = now() - interval '2 hours'`)
    s.github.permission = "admin"
    const ran = await runFlow(RecheckRole.RecheckRole, { sessionId: s.id }, RecheckRole.registration(s.database, s.services))
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "checked", role: "admin" }))
    expect(ran.status).toBe("completed")
    const after = await session(s.id)
    expect(after.role).toBe("admin")
    expect(after.age).toBeLessThan(60)
    expect(await s.h.session(s.cookies)).toEqual({ signedIn: true, personId: s.personId, login: "octocat", role: "admin", hostedModel: false })
  })

  test("a GitHub that fails once is retried by the step's retry policy", async () => {
    const s = await signedIn()
    s.github.failOnce.permission = "unavailable"
    const ran = await runFlow(RecheckRole.RecheckRole, { sessionId: s.id }, RecheckRole.registration(s.database, s.services))
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "checked", role: "member" }))
    // Sign-in read it once; the check read it twice.
    expect(s.github.calls.filter((step) => step === "permission")).toHaveLength(3)
  })

  test("a person who lost access keeps no role", async () => {
    const s = await signedIn()
    s.github.permission = "none"
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "checked", role: null }))
    expect((await session(s.id)).role).toBeNull()
  })

  test("refreshes a GitHub token about to expire, keeps the rotated refresh token, and uses the new token", async () => {
    const s = await signedIn()
    await expiring(s.id)
    const [first] = s.github.issued
    // The old access token stops working, so the role can only be read with the new one.
    s.github.revoke(first!.accessToken)
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "checked", role: "member" }))
    const second = s.github.issued[1]!
    const after = await session(s.id)
    expect(after.refreshDigest).toBe(SessionKeys.digest(Redacted.value(second.refreshToken!)))
    expect(after.revokedReason).toBeNull()
    // The old refresh token is spent: a second refresh with it would be refused.
    expect(s.github.calls).toContain("refresh")
  })

  test("a token that never expires is checked without a refresh", async () => {
    const github = scriptedGitHub()
    github.expiring = false
    const s = await signedIn(github)
    s.github.permission = "maintain"
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "checked", role: "maintainer" }))
    expect(s.github.calls).not.toContain("refresh")
  })

  test("a refresh that answers tokens that never expire stores them", async () => {
    const s = await signedIn()
    await expiring(s.id)
    s.github.expiring = false
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "checked", role: "member" }))
    expect((await session(s.id)).refreshDigest).toBeNull()
    // Nothing is about to expire now, so the next check doesn't refresh.
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "checked", role: "member" }))
    expect(s.github.calls.filter((step) => step === "refresh")).toHaveLength(1)
  })

  test("a session signed out while its check refreshed stays signed out", async () => {
    const s = await signedIn()
    await expiring(s.id)
    s.github.beforeRefresh = Effect.suspend(() => {
      s.github.beforeRefresh = undefined
      return SessionStore.revoke({ id: s.id }, "sign_out").pipe(Effect.provide(s.database), Effect.orDie, Effect.asVoid)
    })
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "ended", role: null }))
    expect((await session(s.id)).revokedReason).toBe("sign_out")
  })

  test("an expired refresh token ends the session", async () => {
    const s = await signedIn()
    await expiring(s.id)
    s.github.expire(s.github.issued[0]!.refreshToken!)
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "revoked", role: null }))
    const after = await session(s.id)
    expect(after.revokedReason).toBe("github_refused")
    expect(after.forgotten).toBe(true)
    expect(await s.h.session(s.cookies)).toEqual({ signedIn: false, available: true })
  })

  test("a refresh refused because another check rotated the token first doesn't end the session", async () => {
    const s = await signedIn()
    await expiring(s.id)
    const [first] = s.github.issued
    // Another check finishes first: it redeems the refresh token and stores the new tokens.
    s.github.beforeRefresh = Effect.gen(function* () {
      s.github.beforeRefresh = undefined
      const next = yield* s.github.service.refresh(first!.refreshToken!).pipe(Effect.orDie)
      yield* storeTokens(s, first!.refreshToken!, next)
    })
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "checked", role: "member" }))
    const after = await session(s.id)
    expect(after.revokedReason).toBeNull()
    expect(after.refreshDigest).toBe(SessionKeys.digest(Redacted.value(s.github.issued[1]!.refreshToken!)))
  })

  test("a refresh that lost the race to store its tokens uses the tokens the winner stored", async () => {
    const s = await signedIn()
    await expiring(s.id)
    const [first] = s.github.issued
    // Another check stores tokens of its own while this one's refresh is in flight; GitHub still redeems this one's.
    s.github.beforeRefresh = Effect.gen(function* () {
      s.github.beforeRefresh = undefined
      yield* storeTokens(s, first!.refreshToken!, {
        accessToken: first!.accessToken,
        expiresAt: Date.now() + 3_600_000,
        refreshToken: Redacted.make("ghr_winner"),
      })
    })
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "checked", role: "member" }))
    expect((await session(s.id)).refreshDigest).toBe(SessionKeys.digest("ghr_winner"))
  })

  test("a session GitHub no longer accepts is ended", async () => {
    const s = await signedIn()
    s.github.revoke(s.github.issued[0]!.accessToken)
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "revoked", role: null }))
    expect((await session(s.id)).revokedReason).toBe("github_refused")
  })

  test("an expiring token with no refresh token, or one that won't open, ends the session", async () => {
    const s = await signedIn()
    await expiring(s.id)
    await sql(`UPDATE sessions SET github_refresh = NULL`)
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "revoked", role: null }))
    const t = await signedIn()
    await expiring(t.id)
    await sql(`UPDATE sessions SET github_refresh = '{"ciphertext":"AAAA","nonce":"AAAAAAAAAAAAAAAA"}' WHERE id = '${t.id}'`)
    expect(await checkOnce(t)).toEqual(Exit.succeed({ outcome: "revoked", role: null }))
    expect((await session(t.id)).revokedReason).toBe("github_refused")
  })

  test("sealed tokens that no longer open (SESSION_SECRET changed) end the session", async () => {
    const s = await signedIn()
    await sql(`UPDATE sessions SET github_access = '{"ciphertext":"AAAA","nonce":"AAAAAAAAAAAAAAAA"}'`)
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "revoked", role: null }))
    expect((await session(s.id)).revokedReason).toBe("unreadable")
  })

  test("a session that is gone, signed out or past its end is left alone", async () => {
    const s = await signedIn()
    expect(await Effect.runPromiseExit(checking(s, crypto.randomUUID()))).toEqual(
      Exit.succeed({ outcome: "ended", role: null }),
    )
    await sql(`UPDATE sessions SET expires_at = now() - interval '1 second'`)
    expect(await checkOnce(s)).toEqual(Exit.succeed({ outcome: "ended", role: null }))
    expect(s.github.calls.filter((step) => step === "permission")).toHaveLength(1)
  })

  test("GitHub or Postgres failing fails the step with its reason, for the retry policy", async () => {
    const s = await signedIn()
    for (const [reason, expected] of [["unavailable", "github_unavailable"], ["misconfigured", "github_misconfigured"]] as const) {
      s.github.failOnce.permission = reason
      expect(reasonOf(await checkOnce(s))).toBe(expected)
    }
    await expiring(s.id)
    s.github.failOnce.refresh = "unavailable"
    expect(reasonOf(await checkOnce(s))).toBe("github_unavailable")
    const down = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    expect(reasonOf(await Effect.runPromiseExit(checking(s, s.id, down)))).toBe("database")
  })

  test("its records carry the outcome and the session id, never a token or a login", async () => {
    const s = await signedIn()
    await expiring(s.id)
    const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const logger = Logger.make((options) => void logs.push(StructuredLogger.formatStructured.log(options)))
    const run = (sessionId: string) =>
      Effect.runPromise(
        Effect.exit(checking(s, sessionId)).pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        ),
      )
    await run(s.id)
    s.github.failOnce.permission = "unavailable"
    await run(s.id)
    expect(logs.map((log) => log.annotations)).toEqual([
      expect.objectContaining({ sessionId: s.id, step: "redeem", outcome: "redeemed" }),
      expect.objectContaining({ sessionId: s.id, step: "store", outcome: "stored" }),
      expect.objectContaining({ sessionId: s.id, step: "check", outcome: "checked", role: "member" }),
      expect.objectContaining({ sessionId: s.id, step: "redeem", outcome: "none" }),
      expect.objectContaining({ sessionId: s.id, step: "store", outcome: "none" }),
      expect.objectContaining({
        sessionId: s.id,
        step: "check",
        outcome: "failed",
        errorCode: "@smthrs/mvp/auth/GitHubRefused",
      }),
    ])
    const text = JSON.stringify(logs)
    for (const issued of s.github.issued) {
      expect(text).not.toContain(Redacted.value(issued.accessToken))
      expect(text).not.toContain(Redacted.value(issued.refreshToken!))
    }
    expect(text).not.toContain("octocat")
  })
})

describe("one check of a session at a time", () => {
  test("requests an hour apart that find one stale role start one check, which redeems the refresh token once", async () => {
    const github = scriptedGitHub()
    const services: RecheckRole.Services = { keys: await keys(), github: github.service, repository: "smithersai/smithers" }
    const database = await runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))
    const scope = Effect.runSync(Scope.make())
    try {
      // One Node-host engine per execution, over one engine schema, as each Durable Object drives its own execution
      // (worker/Executions.ts). The host starts each check there without waiting for it, as ChatApi does; a check
      // whose execution already started is the same execution.
      const hosts = new Map<string, FlowRuntime.FlowRuntime["Service"]>()
      let schema: string | undefined
      const host = async (executionId: string) => {
        const { context, engine } = await Effect.runPromise(
          build(RecheckRole.registration(database, services), {
            hostId: executionId,
            ...(schema === undefined ? {} : { schema }),
          }).pipe(Effect.provideService(Scope.Scope, scope)),
        )
        schema ??= engine.schema
        return Context.get(context, FlowRuntime.FlowRuntime)
      }
      const started: Array<string> = []
      const runs: Array<Promise<Exit.Exit<unknown, unknown>>> = []
      const roleChecks = SignIn.RoleChecks.of({
        start: (sessionId, generation) =>
          Effect.sync(() => {
            const executionId = `auth-recheck-${sessionId}-${generation}`
            started.push(executionId)
            runs.push((async () => {
              const flows = hosts.get(executionId) ?? (await host(executionId))
              hosts.set(executionId, flows)
              return Effect.runPromiseExit(flows.execute(RecheckRole.RecheckRole, { executionId, payload: { sessionId } }))
            })())
          }),
      })
      const h = await signInHarness(runtime, { github, roleChecks })
      const { cookies } = await h.signInAs()
      const [{ id, personId }] = (await sql(`SELECT id, person_id::text AS "personId" FROM sessions`)) as unknown as [{ id: string; personId: string }]
      await sql(`UPDATE sessions SET role_checked_at = now() - interval '2 hours'`)
      await expiring(id)
      // Check A pauses once GitHub has redeemed the refresh token and issued its replacement, before A stores it.
      const redeemed = Effect.runSync(Deferred.make<void>())
      const release = Effect.runSync(Deferred.make<void>())
      github.afterRefresh = Effect.suspend(() => {
        github.afterRefresh = undefined
        return Effect.andThen(Deferred.succeed(redeemed, undefined), Deferred.await(release))
      })

      await h.session(cookies)
      await Effect.runPromise(Deferred.await(redeemed))
      // The next request comes an hour later, in the next hour, while A still holds the replacement.
      h.advance(60 * 60 * 1000)
      expect(await h.session(cookies)).toEqual({ signedIn: true, personId, login: "octocat", role: "member", hostedModel: false })
      h.advance(-60 * 60 * 1000)
      // B runs before A goes on: a check of its own runs to its end first; the same check is A, still paused.
      if (started[1] !== started[0]) await runs[1]
      Effect.runSync(Deferred.succeed(release, undefined))
      const exits = await Promise.all(runs)

      // The session stays signed in and keeps A's replacement: both requests named one check, so the engine ran it
      // once, and GitHub redeemed the refresh token once.
      const after = await session(id)
      expect(after.revokedReason).toBeNull()
      expect(after.refreshDigest).toBe(SessionKeys.digest(Redacted.value(github.issued[1]!.refreshToken!)))
      expect(github.calls.filter((step) => step === "refresh")).toHaveLength(1)
      expect(started).toHaveLength(2)
      expect(started[1]).toBe(started[0])
      expect(exits).toEqual([
        Exit.succeed({ outcome: "checked", role: "member" }),
        Exit.succeed({ outcome: "checked", role: "member" }),
      ])
      expect(await h.session(cookies)).toEqual({ signedIn: true, personId, login: "octocat", role: "member", hostedModel: false })
      // The check recorded the role, so the next stale request names a new check.
      await sql(`UPDATE sessions SET role_checked_at = role_checked_at - interval '2 hours'`)
      await h.session(cookies)
      expect(started).toHaveLength(3)
      expect(started[2]).not.toBe(started[0])
      await Promise.all(runs)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })

  test("tokens GitHub issued but Postgres refused to store are stored by the resumed run, never redeemed again", async () => {
    // Codex review 4, P2: one retried step redeemed the single-use refresh token and stored its replacement, so a failed
    // store made the retry present the spent token, and GitHub's refusal ended a valid session.
    const s = await signedIn()
    await expiring(s.id)
    const executionId = RecheckRole.recheckExecutionId(s.id, 1)
    // Postgres refuses to store a new refresh token. Each refusal draws from a sequence, which a rollback doesn't undo.
    await sql(`CREATE SEQUENCE refused_stores`)
    await sql(`CREATE FUNCTION refuse_store() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('refused_stores'); RAISE EXCEPTION 'refused'; END $$`)
    await sql(`CREATE TRIGGER refuse_store BEFORE UPDATE ON sessions FOR EACH ROW
      WHEN (OLD.github_refresh_digest IS DISTINCT FROM NEW.github_refresh_digest) EXECUTE FUNCTION refuse_store()`)
    const removeFault = async () => {
      await sql(`DROP TRIGGER IF EXISTS refuse_store ON sessions`)
      await sql(`DROP FUNCTION IF EXISTS refuse_store()`)
      await sql(`DROP SEQUENCE IF EXISTS refused_stores`)
    }
    // One Durable Object's engine, as on Cloudflare: it dies, and the next one resumes the run from its journal.
    const engine = async (schema?: string) => {
      const scope = Effect.runSync(Scope.make())
      const built = await Effect.runPromise(
        Scope.provide(scope)(
          build(RecheckRole.registration(s.database, s.services), {
            hostId: "durable-object",
            isAlive: RunStore.Ownership.singleIncarnationLiveness,
            maxConnections: 3,
            ...(schema === undefined ? {} : { schema }),
          }),
        ),
      )
      const flows = Context.get(built.context, FlowRuntime.FlowRuntime)
      return {
        schema: built.engine.schema,
        execute: () => flows.execute(RecheckRole.RecheckRole, { executionId, payload: { sessionId: s.id } }),
        close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
      }
    }
    try {
      const first = await engine()
      const running = Effect.runFork(Effect.exit(first.execute()))
      const refusals = async () =>
        ((await sql(`SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS n FROM refused_stores`)) as unknown as [
          { n: number },
        ])[0].n
      await expect.poll(refusals, { interval: 10, timeout: 20_000 }).toBeGreaterThan(0)
      // The object dies after the failed store: Postgres ends its engine's connections, so it records nothing more.
      await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND query LIKE '%${first.schema}%'`)
      await Effect.runPromise(Fiber.interrupt(running))
      await removeFault()

      const second = await engine(first.schema)
      const resumed = await Effect.runPromise(Effect.exit(second.execute()))
      await second.close()
      await first.close()

      expect(resumed).toEqual(Exit.succeed({ outcome: "checked", role: "member" }))
      expect(s.github.calls.filter((step) => step === "refresh")).toHaveLength(1)
      const after = await session(s.id)
      expect(after.revokedReason).toBeNull()
      expect(after.refreshDigest).toBe(SessionKeys.digest(Redacted.value(s.github.issued[1]!.refreshToken!)))
      expect(await s.h.session(s.cookies)).toEqual({ signedIn: true, personId: s.personId, login: "octocat", role: "member", hostedModel: false })
    } finally {
      await removeFault()
    }
  }, 60_000)

  test("a refresh whose answer was lost after GitHub redeemed it ends the session: the person signs in again", async () => {
    // The one window no journal closes: GitHub spent the refresh token, but its answer never arrived, so nothing holds
    // the replacement. The retry presents the spent token, GitHub refuses it, and the session ends
    // (docs/features/sign-in.md#roles-and-role-checks).
    const s = await signedIn()
    await expiring(s.id)
    // GitHub redeems the first refresh, and its answer is lost on the way back.
    let answers = 0
    const github = {
      ...s.github.service,
      refresh: (token: Redacted.Redacted<string>) =>
        s.github.service.refresh(token).pipe(
          Effect.flatMap((tokens) =>
            answers++ === 0
              ? Effect.fail(new GitHubRefused({ step: "refresh", reason: "unavailable" }))
              : Effect.succeed(tokens)
          ),
        ),
    }

    const ran = await runFlow(
      RecheckRole.RecheckRole,
      { sessionId: s.id },
      RecheckRole.registration(s.database, { ...s.services, github }),
    )

    expect(ran.exit).toEqual(Exit.succeed({ outcome: "revoked", role: null }))
    expect(s.github.calls.filter((step) => step === "refresh")).toHaveLength(2)
    expect(await session(s.id)).toMatchObject({ revokedReason: "github_refused", forgotten: true })
  })

  test("a check that fails every attempt keeps the role and records the check, so the next one is new", async () => {
    const s = await signedIn()
    await sql(`UPDATE sessions SET role_checked_at = now() - interval '2 hours'`)
    s.github.faults.permission = "unavailable"

    const ran = await runFlow(RecheckRole.RecheckRole, { sessionId: s.id }, RecheckRole.registration(s.database, s.services))

    // Its step's retry policy ran out (five attempts), then the flow kept the role rather than failing.
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "kept", role: null }))
    expect(ran.status).toBe("completed")
    expect(s.github.calls.filter((step) => step === "permission")).toHaveLength(1 + 5)
    const after = await session(s.id)
    expect(after.role).toBe("member")
    expect(after.revokedReason).toBeNull()
    expect(after.age).toBeLessThan(60)
  }, 60_000)

  test("keeping the role records it, leaves a session that ended alone, and fails with the database's reason", async () => {
    const s = await signedIn()
    await sql(`UPDATE sessions SET role_checked_at = now() - interval '2 hours'`)
    const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const logger = Logger.make((options) => void logs.push(StructuredLogger.formatStructured.log(options)))
    const keep = (database: typeof s.database) =>
      Effect.runPromiseExit(
        RecheckRole.steps(database, s.services).keep(s.id).pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        ),
      )

    expect(await keep(s.database)).toEqual(Exit.succeed({ outcome: "kept", role: null }))
    expect((await session(s.id)).age).toBeLessThan(60)
    expect(logs.map((log) => log.annotations)).toEqual([
      expect.objectContaining({ sessionId: s.id, step: "keep", outcome: "kept", role: "none" }),
    ])
    await SessionStore.revoke({ id: s.id }, "sign_out").pipe(Effect.provide(s.database), Effect.runPromise)
    await sql(`UPDATE sessions SET role_checked_at = now() - interval '2 hours'`)
    await keep(s.database)
    expect((await session(s.id)).age).toBeGreaterThan(3600)
    const down = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    expect(reasonOf(await keep(down))).toBe("database")
  })
})

/** Stores `next` over the session's tokens, as a concurrent check would, replacing `presented`. */
const storeTokens = (
  s: Awaited<ReturnType<typeof signedIn>>,
  presented: Redacted.Redacted<string>,
  next: { readonly accessToken: Redacted.Redacted<string>; readonly expiresAt: number | null; readonly refreshToken: Redacted.Redacted<string> | null },
) =>
  Effect.gen(function* () {
    const context = (name: "github_access" | "github_refresh") => ({ id: s.id, name, version: 1 })
    yield* SessionStore.replaceTokens(s.id, SessionKeys.digest(Redacted.value(presented)), {
      access: yield* s.services.keys.seal(next.accessToken, context("github_access")),
      accessExpiresAt: next.expiresAt,
      refresh: next.refreshToken === null ? null : yield* s.services.keys.seal(next.refreshToken, context("github_refresh")),
      refreshDigest: next.refreshToken === null ? null : SessionKeys.digest(Redacted.value(next.refreshToken)),
    }).pipe(Effect.provide(s.database), Effect.orDie)
  })
