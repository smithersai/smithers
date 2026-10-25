// Sign-in's routes and sessions (worker/SignIn.ts, docs/features/sign-in.md) on this file's own schema of the compose
// Postgres (`pnpm db:up`), with the scripted GitHub (worker/test/github.ts) as the only stand-in. The model endpoint
// cases run ChatApi's real handler (worker/test/harness.ts) with sign-in's sessions.
import { credentialRoute } from "../src/flows/contract.ts"
import { ModelRequest } from "@smthrs/model"
import { ConfigProvider, Effect, Option, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA, type SessionState } from "../src/features/auth/contract.ts"
import * as Flows from "./Flows.ts"
import * as RevokeGitHubToken from "./flows/RevokeGitHubToken.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SignIn from "./SignIn.ts"
import { localDeveloper } from "./DevChatApi.ts"
import { scriptedGitHub } from "./test/github.ts"
import { answers, harness, recorded, testFile } from "./test/harness.ts"
import { CLIENT_SECRET, configured, cookie, SECRET, setCookies, signInHarness } from "./test/signIn.ts"

const runtime = testFile("sign_in")

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE sessions, sign_in_attempts, people CASCADE`),
  )
)

const query = <A extends object>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.orDie(statement(sql))))

const sessionRows = () =>
  query((sql) =>
    sql<{
      readonly id: string
      readonly tokenDigest: string
      readonly role: string | null
      readonly access: unknown
      readonly refresh: unknown
      readonly revokedAt: Date | null
      readonly revokedReason: string | null
      readonly personId: string
    }>`SELECT id, token_digest AS "tokenDigest", role, github_access AS access, github_refresh AS refresh,
         revoked_at AS "revokedAt", revoked_reason AS "revokedReason", person_id AS "personId"
       FROM sessions ORDER BY created_at`
  )

const attemptRows = () => query((sql) => sql<{ readonly stateDigest: string }>`SELECT state_digest AS "stateDigest" FROM sign_in_attempts`)

/** Everything Postgres holds about sign-in, as one string to search for a credential. */
const stored = async () =>
  JSON.stringify([
    await query((sql) => sql<object>`SELECT * FROM sign_in_attempts`),
    await query((sql) => sql<object>`SELECT * FROM sessions`),
    await query((sql) => sql<object>`SELECT * FROM people`),
  ], (_, value) => (typeof value === "bigint" ? String(value) : value))

const modelRequest = JSON.stringify(
  Schema.encodeSync(ModelRequest.ModelRequest)(
    ModelRequest.ModelRequest.make({
      modelId: "browser-choice",
      system: [],
      messages: [ModelRequest.Message.user("hello")],
      tools: [],
      params: ModelRequest.GenerationParams.make({}),
    }),
  ),
)

describe("starting sign-in", () => {
  test("sends the browser to GitHub with state and an S256 challenge, and binds the state to this browser", async () => {
    const h = await signInHarness(runtime)
    const { response, location, cookies } = await h.start("/app?tab=1#end")
    expect(response.status).toBe(302)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const url = new URL(location)
    expect(`${url.origin}${url.pathname}`).toBe("https://github.test/login/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("Iv1.scripted")
    expect(url.searchParams.get("redirect_uri")).toBe("http://smithers.test/api/auth/callback")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const state = url.searchParams.get("state")!
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // On plain http the cookie has no `__Host-` prefix and no Secure flag (mvp.md M-28).
    const signIn = cookies["smithers_sign_in"]!
    expect(signIn.value.startsWith(`${state}.`)).toBe(true)
    expect(signIn.line).toMatch(/HttpOnly/)
    expect(signIn.line).toMatch(/SameSite=Lax/)
    expect(signIn.line).toMatch(/Path=\//)
    expect(signIn.line).toMatch(/Max-Age=600/)
    expect(signIn.line).not.toMatch(/Secure/)
    // Postgres keeps the state's digest and a sealed verifier, never either in the clear.
    expect(await attemptRows()).toEqual([{ stateDigest: SessionKeys.digest(state) }])
    expect(await stored()).not.toContain(state)
    expect(h.count({ route: "sign_in", outcome: "redirected" })).toBe(1)
  })

  test("over https, cookies are __Host- and Secure", async () => {
    const h = await signInHarness(runtime, { origin: "https://smithers.test" })
    const { cookies, location } = await h.start()
    expect(new URL(location).searchParams.get("redirect_uri")).toBe("https://smithers.test/api/auth/callback")
    const signIn = cookies["__Host-smithers_sign_in"]!
    expect(signIn.line).toMatch(/; Secure/)
    expect(signIn.line).toMatch(/HttpOnly/)
    const { response } = await h.signInAs()
    const session = setCookies(response)["__Host-smithers_session"]!
    expect(session.line).toMatch(/; Secure/)
    expect(session.line).toMatch(/HttpOnly/)
    expect(session.line).toMatch(/SameSite=Lax/)
    expect(session.line).toMatch(/Path=\//)
    expect(session.line).toMatch(/Max-Age=2592000/)
    expect(session.line).not.toMatch(/Domain=/)
  })

  test("returns only to a path on this site", async () => {
    const h = await signInHarness(runtime)
    // A tab is dropped by URL parsing, so "/<tab>/evil.test" is "//evil.test": another site.
    for (const target of ["//evil.test/app", "https://evil.test/", "/\\evil.test", "/\t/evil.test", "app"]) {
      const { response } = await h.signInAs(target)
      expect(response.headers.get("location"), target).toBe("/")
    }
    expect((await h.signInAs("/app?tab=1")).response.headers.get("location")).toBe("/app?tab=1")
    // Trying again from the page that said sign-in failed doesn't come back saying it failed.
    expect((await h.signInAs("/app?sign_in=failed&tab=1")).response.headers.get("location")).toBe("/app?tab=1")
  })

  test("a database that fails as sign-in starts answers 503, logged by code", async () => {
    const h = await signInHarness(runtime, { database: unreachable })
    const response = await h.fetch("/api/auth/sign-in?return=/app")
    expect(response.status).toBe(503)
    expect(h.count({ route: "sign_in", outcome: "failed", reason: "error" })).toBe(1)
    expect(h.line("auth.sign_in")[0]!.annotations).toMatchObject({ outcome: "failed", errorCode: "sql:ConnectionError" })
  })

  test("answers only GET", async () => {
    const h = await signInHarness(runtime)
    expect((await h.fetch("/api/auth/sign-in", { method: "POST" })).status).toBe(405)
    expect((await h.fetch("/api/auth/session", { method: "POST" })).status).toBe(405)
    expect((await h.fetch("/api/auth/sign-out")).status).toBe(405)
    expect((await h.fetch("/api/auth/nowhere")).status).toBe(404)
    expect((await h.callback({}, {})).headers.get("location")).toBe("/?sign_in=failed")
    const post = await h.fetch("/api/auth/callback", { method: "POST" })
    expect(post.status).toBe(303)
    expect(h.count({ route: "callback", reason: "method" })).toBe(1)
  })
})

describe("the callback", () => {
  test("signs the browser in: a person keyed by GitHub id, a session behind an HttpOnly cookie", async () => {
    const h = await signInHarness(runtime)
    const { response, cookies } = await h.signInAs("/app")
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/app")
    const set = setCookies(response)
    expect(set["smithers_session"]!.line).toMatch(/HttpOnly/)
    expect(set["smithers_session"]!.line).toMatch(/SameSite=Lax/)
    // The state cookie is spent.
    expect(set["smithers_sign_in"]!.line).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
    const people = await query((sql) =>
      sql<{ readonly githubId: string; readonly login: string }>`
        SELECT github_id::text AS "githubId", github_login AS login FROM people`
    )
    expect(people).toEqual([{ githubId: "583231", login: "octocat" }])
    const [session] = await sessionRows()
    expect(session!.role).toBe("member")
    expect(session!.tokenDigest).toBe(SessionKeys.digest(cookies["smithers_session"]!.split(".")[0]!))
    expect(session!.revokedAt).toBeNull()
    // GitHub's tokens are sealed: neither is in Postgres in the clear.
    const tokens = h.github.issued[0]!
    const rows = await stored()
    expect(rows).not.toContain(Redacted.value(tokens.accessToken))
    expect(rows).not.toContain(Redacted.value(tokens.refreshToken!))
    expect(await h.session(cookies)).toEqual({ signedIn: true, personId: expect.any(String), login: "octocat", role: "member", hostedModel: false } satisfies SessionState)
    expect(h.github.repositories).toEqual(["smithersai/smithers"])
    const [line] = h.line("auth.callback")
    expect(line!.annotations).toMatchObject({ outcome: "signed_in", role: "member", personId: session!.personId })
    expect(h.count({ route: "callback", outcome: "signed_in" })).toBe(1)
  })

  test("a state that isn't this browser's signs nobody in and never reaches GitHub", async () => {
    const h = await signInHarness(runtime)
    const started = await h.start()
    const { code, state } = h.github.approve(started.location)
    const other = await h.start()
    const cases: ReadonlyArray<Record<string, string>> = [
      {}, // another browser: no state cookie
      { smithers_sign_in: other.cookies["smithers_sign_in"]!.value }, // this browser started another sign-in
      { smithers_sign_in: `${state}.${"0".repeat(64)}` }, // a forged signature
      { smithers_sign_in: state }, // no signature
    ]
    for (const cookies of cases) {
      const response = await h.callback({ code, state }, cookies)
      expect(response.headers.get("location")).toBe("/?sign_in=failed")
      expect(setCookies(response)["smithers_session"]).toBeUndefined()
    }
    expect(h.github.calls).toEqual([])
    expect(h.count({ route: "callback", reason: "state_mismatch" })).toBe(4)
    // The sign-in this browser started still works.
    const finished = await h.callback({ code, state }, { smithers_sign_in: started.cookies["smithers_sign_in"]!.value })
    expect(finished.headers.get("location")).toBe("/app")
  })

  test("a replayed callback signs nobody in, and its code reaches GitHub once", async () => {
    const h = await signInHarness(runtime)
    const first = await h.signInAs()
    const replay = await h.callback(
      { code: first.code, state: first.state },
      { smithers_sign_in: first.started.cookies["smithers_sign_in"]!.value },
    )
    expect(replay.headers.get("location")).toBe("/?sign_in=failed")
    expect(setCookies(replay)["smithers_session"]).toBeUndefined()
    expect(h.github.calls.filter((step) => step === "exchange")).toHaveLength(1)
    expect(await sessionRows()).toHaveLength(1)
    expect(h.count({ route: "callback", reason: "replayed" })).toBe(1)
  })

  test("a code GitHub already redeemed is refused by GitHub", async () => {
    const h = await signInHarness(runtime)
    const first = await h.signInAs()
    // A new sign-in in the same browser presents the first sign-in's code: GitHub refuses it (single-use and bound to
    // its own challenge).
    const started = await h.start()
    const { state } = h.github.approve(started.location)
    const response = await h.callback(
      { code: first.code, state },
      { smithers_sign_in: started.cookies["smithers_sign_in"]!.value },
    )
    expect(response.headers.get("location")).toBe("/app?sign_in=failed")
    expect(h.count({ route: "callback", reason: "exchange_rejected" })).toBe(1)
  })

  test("an expired sign-in, a denial on GitHub and a missing code sign nobody in", async () => {
    const h = await signInHarness(runtime)
    const finish = async (query: (code: string, state: string) => Record<string, string>, expire = false) => {
      const started = await h.start()
      const { code, state } = h.github.approve(started.location)
      if (expire) await query_(`UPDATE sign_in_attempts SET expires_at = now() - interval '1 second'`)
      return h.callback(query(code, state), { smithers_sign_in: started.cookies["smithers_sign_in"]!.value })
    }
    const query_ = (statement: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)))
    const expired = await finish((code, state) => ({ code, state }), true)
    const denied = await finish((_, state) => ({ state, error: "access_denied" }))
    const missing = await finish((_, state) => ({ state }))
    for (const response of [expired, denied, missing]) {
      expect(response.headers.get("location")).toBe("/app?sign_in=failed")
    }
    expect(h.count({ route: "callback", reason: "expired" })).toBe(1)
    expect(h.count({ route: "callback", reason: "denied" })).toBe(1)
    expect(h.count({ route: "callback", reason: "invalid" })).toBe(1)
    expect(h.github.calls).toEqual([])
    expect(await sessionRows()).toEqual([])
  })

  test("GitHub failing at any step signs nobody in, and says which step and why", async () => {
    for (
      const [step, reason] of [
        ["exchange", "unavailable"],
        ["exchange", "misconfigured"],
        ["user", "rejected"],
        ["permission", "unavailable"],
      ] as const
    ) {
      const github = scriptedGitHub()
      github.faults[step] = reason
      const h = await signInHarness(runtime, { github })
      const { response } = await h.signInAs()
      expect(response.headers.get("location")).toBe("/app?sign_in=failed")
      expect(h.count({ route: "callback", reason: `${step}_${reason}` })).toBe(1)
    }
    expect(await sessionRows()).toEqual([])
  })

  test("a verifier that no longer opens (SESSION_SECRET changed mid sign-in) signs nobody in", async () => {
    const before = await signInHarness(runtime)
    const started = await before.start()
    const { code, state } = before.github.approve(started.location)
    const after = await signInHarness(runtime, {
      github: before.github,
      config: { ...configured, SESSION_SECRET: "another-secret-".padEnd(64, "9") },
    })
    // The cookie was signed with the old secret too, so re-sign it as the new one would have.
    const keys = await Effect.runPromise(SessionKeys.make(Redacted.make("another-secret-".padEnd(64, "9"))))
    const response = await after.callback({ code, state }, { smithers_sign_in: await Effect.runPromise(keys.sign("sign_in", state)) })
    expect(response.headers.get("location")).toBe("/app?sign_in=failed")
    expect(after.count({ route: "callback", reason: "unreadable" })).toBe(1)
  })

  test("Postgres refusing the person or session signs nobody in", async () => {
    const h = await signInHarness(runtime)
    const alter = (statement: string) =>
      runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)))
    await alter(`ALTER TABLE people ADD CONSTRAINT refuse_octocat CHECK (github_login <> 'octocat')`)
    try {
      const { response } = await h.signInAs()
      expect(response.headers.get("location")).toBe("/app?sign_in=failed")
      expect(h.line("auth.callback")[0]!.annotations).toMatchObject({
        outcome: "failed",
        reason: "database",
        errorCode: "sql:ConstraintError",
      })
    } finally {
      await alter(`ALTER TABLE people DROP CONSTRAINT refuse_octocat`)
    }
    expect(await sessionRows()).toEqual([])
  })

  test("a bug while signing in is logged by its name, and the browser told sign-in failed", async () => {
    const h = await signInHarness(runtime)
    h.github.defects.add("exchange")
    const { response } = await h.signInAs()
    expect(response.headers.get("location")).toBe("/?sign_in=failed")
    expect(h.line("auth.callback")[0]!.annotations).toMatchObject({ reason: "error", errorCode: "unknown" })
  })

  test("a signed-in session says whether the deployment's model answers: an Admin's setting, else HOSTED_MODEL_ENABLED", async () => {
    await query((sql) => sql`DELETE FROM hosted_model`)
    const on = await signInHarness(runtime, { config: { ...configured, HOSTED_MODEL_ENABLED: "true" } })
    const { cookies } = await on.signInAs()
    expect(await on.session(cookies)).toMatchObject({ signedIn: true, hostedModel: true })
    await query((sql) => sql`INSERT INTO hosted_model (enabled, updated_by) VALUES (false, 'person-admin')`)
    try {
      expect(await on.session(cookies)).toMatchObject({ signedIn: true, hostedModel: false })
      // A setting Postgres can't read: the composer shows, and the model endpoint refuses each call itself.
      await query((sql) => sql`ALTER TABLE hosted_model RENAME TO hosted_model_away`)
      try {
        expect(await on.session(cookies)).toMatchObject({ signedIn: true, hostedModel: true })
        expect(on.line("auth.session")).toEqual([
          expect.objectContaining({ annotations: expect.objectContaining({ outcome: "failed", reason: "hosted_model" }) }),
        ])
      } finally {
        await query((sql) => sql`ALTER TABLE hosted_model_away RENAME TO hosted_model`)
      }
    } finally {
      await query((sql) => sql`DELETE FROM hosted_model`)
    }
  })

  test("tokens that never expire, from an App without expiring tokens, sign in too", async () => {
    const github = scriptedGitHub()
    github.expiring = false
    const h = await signInHarness(runtime, { github })
    const { cookies } = await h.signInAs()
    expect(await h.session(cookies)).toEqual({ signedIn: true, personId: expect.any(String), login: "octocat", role: "member", hostedModel: false })
    const [session] = await sessionRows()
    expect(session!.refresh).toBeNull()
  })

  test("signing in again in the same browser ends the session it held, and keeps the person", async () => {
    const h = await signInHarness(runtime)
    const first = await h.signInAs()
    h.github.person = { id: 583231, login: "octocat-renamed" }
    const started = await h.start()
    const { code, state } = h.github.approve(started.location)
    const again = await h.callback(
      { code, state },
      { smithers_sign_in: started.cookies["smithers_sign_in"]!.value, ...first.cookies },
    )
    expect(again.headers.get("location")).toBe("/app")
    const rows = await sessionRows()
    expect(rows.map((row) => row.revokedReason)).toEqual(["sign_out", null])
    expect(rows[0]!.personId).toBe(rows[1]!.personId)
    expect(await h.session(first.cookies)).toEqual({ signedIn: false, available: true })
    const people = await query((sql) => sql<{ readonly login: string }>`SELECT github_login AS login FROM people`)
    expect(people).toEqual([{ login: "octocat-renamed" }])
  })

  test("a database that fails while signing in signs nobody in", async () => {
    const h = await signInHarness(runtime)
    const started = await h.start()
    const { code, state } = h.github.approve(started.location)
    const down = await signInHarness(runtime, { github: h.github, database: unreachable })
    const response = await down.callback({ code, state }, { smithers_sign_in: started.cookies["smithers_sign_in"]!.value })
    expect(response.headers.get("location")).toBe("/?sign_in=failed")
    expect(down.count({ route: "callback", reason: "database" })).toBe(1)
  })
})

/** A Postgres nothing listens at. */
const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))

describe("roles", () => {
  test("each GitHub permission maps to the role with no more power over the repository (decision 0007)", async () => {
    const cases = [
      ["admin", "admin"],
      ["maintain", "maintainer"],
      ["write", "member"],
      ["triage", "guest"],
      ["read", "guest"],
      ["none", null],
    ] as const
    for (const [permission, role] of cases) {
      const github = scriptedGitHub()
      github.permission = permission
      const h = await signInHarness(runtime, { github })
      const { cookies } = await h.signInAs()
      expect(await h.session(cookies), permission).toEqual({ signedIn: true, personId: expect.any(String), login: "octocat", role, hostedModel: false })
    }
  })

  test("reads the role on the configured repository", async () => {
    const h = await signInHarness(runtime, { config: { ...configured, GITHUB_REPOSITORY: "acme/widgets" } })
    await h.signInAs()
    expect(h.github.repositories).toEqual(["acme/widgets"])
  })

  test("a role over an hour old starts a role check named after the check it replaces; a fresh one doesn't", async () => {
    const h = await signInHarness(runtime)
    const { cookies } = await h.signInAs()
    await h.session(cookies)
    expect(h.roleChecks).toEqual([])
    const stale = () =>
      runtime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly checkedAt: string }>`
          UPDATE sessions SET role_checked_at = role_checked_at - interval '61 minutes'
          RETURNING (extract(epoch FROM role_checked_at) * 1000)::bigint::text AS "checkedAt"`),
      ).then(([row]) => Number(row!.checkedAt))
    const generation = await stale()
    await h.session(cookies)
    // An hour later, in the next hour, the role is still the stale one, so the request names the same check: the host
    // runs one check of a session at a time (one execution per session and check).
    h.advance(60 * 60 * 1000)
    await h.session(cookies)
    const [session] = await sessionRows()
    expect(h.roleChecks).toEqual([
      { sessionId: session!.id, generation },
      { sessionId: session!.id, generation },
    ])
    // Once a check moves `role_checked_at`, the next stale request names a new one.
    const next = await stale()
    await h.session(cookies)
    expect(next).not.toBe(generation)
    expect(h.roleChecks.at(-1)).toEqual({ sessionId: session!.id, generation: next })
  })
})

describe("signing out", () => {
  test("revokes the session in Postgres, starts revoking its GitHub token once, and expires the cookie", async () => {
    const h = await signInHarness(runtime)
    const { cookies } = await h.signInAs()
    const response = await h.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "http://smithers.test", cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId },
    })
    expect(response.status).toBe(204)
    expect(setCookies(response)["smithers_session"]!.line).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
    const [session] = await sessionRows()
    expect(session!.revokedReason).toBe("sign_out")
    // Its sealed tokens stay until `auth/RevokeGitHubToken` revokes them on GitHub and forgets them.
    expect(session!.access).not.toBeNull()
    expect(session!.refresh).not.toBeNull()
    expect(h.revocations).toEqual([session!.id])
    // The old cookie, replayed, is nobody.
    expect(await h.session(cookies)).toEqual({ signedIn: false, available: true })
    expect(h.count({ route: "sign_out", outcome: "signed_out" })).toBe(1)
    // Signing out again while its tokens wait for the flow starts the same execution again, a no-op on the host.
    const signOut = async () =>
      h.fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId },
      })
    expect((await signOut()).status).toBe(204)
    expect(h.revocations).toEqual([session!.id, session!.id])
    // Once the flow forgot its tokens, signing out again finds nothing to do.
    await query((sql) => sql`UPDATE sessions SET github_access = NULL, github_refresh = NULL`)
    expect((await signOut()).status).toBe(204)
    expect(h.count({ route: "sign_out", outcome: "no_session" })).toBe(1)
    expect(h.revocations).toHaveLength(2)
  })

  // Sign-out is acknowledged only once its durable flow is admitted: the flow ends the session and revokes its GitHub
  // token, so a start the host refused can't leave tokens nothing will revoke (Codex review 4, P2).
  test.each([
    ["unavailable", new Flows.StartUnavailable({ errorCode: "rpc" }), "rpc"],
    ["a conflict", new Flows.StartConflict(), "conflict"],
  ])("a sign-out whose flow can't start (%s) is 503 and keeps the session; signing out again starts it", async (_, error, code) => {
    let refuse = true
    const started: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
    const h = await signInHarness(runtime, {
      starter: Flows.FlowStarter.of({
        start: (flow, { executionId, payload }) =>
          refuse ? Effect.fail(error) : Effect.sync(() => void started.push({ flow: flow._tag, executionId, payload })),
      }),
    })
    const { cookies } = await h.signInAs()
    const signOut = async () =>
      h.fetch("/api/auth/sign-out", { method: "POST", headers: { origin: "http://smithers.test", cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId } })

    const refused = await signOut()

    expect(refused.status).toBe(503)
    expect(setCookies(refused)["smithers_session"]).toBeUndefined()
    expect((await sessionRows())[0]!.revokedAt).toBeNull()
    expect(await h.session(cookies)).toMatchObject({ signedIn: true })
    expect(h.count({ route: "sign_out", outcome: "failed", reason: "not_started" })).toBe(1)
    expect(h.line("auth.sign_out").at(-1)!.annotations).toMatchObject({ errorCode: code })

    refuse = false
    const signedOut = await signOut()

    expect(signedOut.status).toBe(204)
    const [session] = await sessionRows()
    expect(session!.revokedReason).toBe("sign_out")
    expect(started).toEqual([
      {
        flow: "auth/RevokeGitHubToken",
        executionId: RevokeGitHubToken.revokeExecutionId(session!.id),
        payload: { sessionId: session!.id },
      },
    ])
  })

  test("a session signed out whose GitHub token nothing revoked is revoked by signing out again", async () => {
    const h = await signInHarness(runtime)
    const { cookies } = await h.signInAs()
    // Signed out before sign-out waited for its flow: the session ended, its tokens kept, and no flow started.
    await query((sql) => sql`UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out'`)
    const [session] = await sessionRows()

    const again = await h.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "http://smithers.test", cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId },
    })

    expect(again.status).toBe(204)
    expect(h.revocations).toEqual([session!.id])
    expect(h.count({ route: "sign_out", outcome: "signed_out" })).toBe(1)
  })

  test("signing in again whose sign-out can't start fails before GitHub, keeping the session it held", async () => {
    let refuse = true
    const h = await signInHarness(runtime, {
      starter: Flows.FlowStarter.of({
        start: () => refuse ? Effect.fail(new Flows.StartUnavailable({ errorCode: "rpc" })) : Effect.void,
      }),
    })
    const first = await h.signInAs()
    const again = async () => {
      const started = await h.start()
      const { code, state } = h.github.approve(started.location)
      return h.callback({ code, state }, { smithers_sign_in: started.cookies["smithers_sign_in"]!.value, ...first.cookies })
    }

    const failed = await again()

    expect(failed.headers.get("location")).toBe("/app?sign_in=failed")
    expect(h.github.calls.filter((step) => step === "exchange")).toHaveLength(1)
    expect((await sessionRows()).map((row) => row.revokedAt)).toEqual([null])
    expect(h.count({ route: "callback", outcome: "failed", reason: "sign_out_not_started" })).toBe(1)

    refuse = false
    expect((await again()).headers.get("location")).toBe("/app")
    expect((await sessionRows()).map((row) => row.revokedReason)).toEqual(["sign_out", null])
  })

  test("signing in again while Postgres can't read the session it held fails before GitHub", async () => {
    const h = await signInHarness(runtime)
    const first = await h.signInAs()
    const started = await h.start()
    const { code, state } = h.github.approve(started.location)
    await query((sql) => sql`ALTER TABLE sessions RENAME TO sessions_away`)
    try {
      const failed = await h.callback({ code, state }, {
        smithers_sign_in: started.cookies["smithers_sign_in"]!.value,
        ...first.cookies,
      })

      expect(failed.headers.get("location")).toBe("/app?sign_in=failed")
      expect(h.github.calls.filter((step) => step === "exchange")).toHaveLength(1)
      expect(h.count({ route: "callback", outcome: "failed", reason: "database" })).toBe(1)
      expect(h.revocations).toEqual([])
    } finally {
      await query((sql) => sql`ALTER TABLE sessions_away RENAME TO sessions`)
    }
  })

  test("refuses a sign-out another site sent", async () => {
    const h = await signInHarness(runtime)
    const { cookies } = await h.signInAs()
    const sent: ReadonlyArray<Record<string, string>> = [{ origin: "https://evil.test" }, {}, { "sec-fetch-site": "cross-site" }]
    for (const headers of sent) {
      const response = await h.fetch("/api/auth/sign-out", { method: "POST", headers: { ...headers, cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId } })
      expect(response.status).toBe(403)
    }
    expect((await sessionRows())[0]!.revokedAt).toBeNull()
    expect(h.count({ route: "sign_out", outcome: "refused", reason: "cross_site" })).toBe(3)
  })

  test("a database that fails answers 503 and logs the failure by code", async () => {
    const h = await signInHarness(runtime)
    const { cookies } = await h.signInAs()
    const down = await signInHarness(runtime, { github: h.github, database: unreachable })
    const response = await down.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "http://smithers.test", cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId },
    })
    expect(response.status).toBe(503)
    expect(down.count({ route: "sign_out", outcome: "failed" })).toBe(1)
  })
})

describe("sessions", () => {
  test("a forged, unknown or expired cookie is nobody", async () => {
    const h = await signInHarness(runtime)
    const { cookies } = await h.signInAs()
    const [token] = cookies["smithers_session"]!.split(".")
    expect(await h.session({ smithers_session: `${token}.${"0".repeat(64)}` })).toEqual({ signedIn: false, available: true })
    expect(await h.session({ smithers_session: "nothing" })).toEqual({ signedIn: false, available: true })
    // A cookie signed with the secret, for a session Postgres doesn't have.
    const keys = await Effect.runPromise(SessionKeys.make(Redacted.make(SECRET)))
    expect(await h.session({ smithers_session: await Effect.runPromise(keys.sign("session", "made-up")) }))
      .toEqual({ signedIn: false, available: true })
    // A sign-in cookie is not a session cookie.
    expect(await h.session({ smithers_session: await Effect.runPromise(keys.sign("sign_in", token!)) }))
      .toEqual({ signedIn: false, available: true })
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE sessions SET expires_at = now() - interval '1 second'`),
    )
    expect(await h.session(cookies)).toEqual({ signedIn: false, available: true })
  })

  test("Postgres down is neither signed in nor out: 503", async () => {
    const h = await signInHarness(runtime)
    const { cookies } = await h.signInAs()
    const down = await signInHarness(runtime, { github: h.github, database: unreachable })
    expect((await down.fetch("/api/auth/session", { headers: { cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId } })).status).toBe(503)
    expect(down.line("auth.session")[0]!.annotations).toMatchObject({ outcome: "error" })
  })

  test("without the GitHub App configured, nobody can sign in, and local development's fallback is signed in", async () => {
    for (
      const config of [
        {},
        { ...configured, GITHUB_APP_CLIENT_SECRET: "" },
        { GITHUB_APP_CLIENT_ID: "Iv1.scripted", GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET },
      ]
    ) {
      const off = await signInHarness(runtime, { config: config as Record<string, string> })
      const response = await off.fetch("/api/auth/sign-in")
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ code: "not_configured" })
      expect(await off.session()).toEqual({ signedIn: false, available: false })
      expect((await off.callback({ code: "c", state: "s" })).headers.get("location")).toBe("/?sign_in=failed")
      const out = await off.fetch("/api/auth/sign-out", { method: "POST", headers: { origin: "http://smithers.test" } })
      expect(out.status).toBe(204)
    }
    const dev = await signInHarness(runtime, {
      config: {},
      fallback: { actor: localDeveloper, login: "local-developer" },
    })
    expect(await dev.session()).toEqual({ signedIn: true, personId: expect.any(String), login: "local-developer", role: "admin", hostedModel: false })
  })

  test("local development's developer signs out and back in with a cookie, never reaching GitHub", async () => {
    const dev = await signInHarness(runtime, { config: {}, fallback: { actor: localDeveloper, login: "local-developer" } })
    const chat = await harness(runtime, answers("hi"), { sessions: dev.sessions })
    // Another site still can't sign the developer out.
    expect((await dev.fetch("/api/auth/sign-out", { method: "POST", headers: { origin: "https://evil.test" } })).status)
      .toBe(403)
    const out = await dev.fetch("/api/auth/sign-out", { method: "POST", headers: { origin: "http://smithers.test" } })
    expect(out.status).toBe(204)
    const mark = setCookies(out)["smithers_dev_signed_out"]!
    expect(mark.value).toBe("1")
    expect(mark.line).toMatch(/HttpOnly/)
    expect(mark.line).toMatch(/SameSite=Lax/)
    expect(mark.line).toMatch(/Path=\//)
    expect(mark.line).toMatch(/Max-Age=2592000/)
    const signedOut = { smithers_dev_signed_out: mark.value }
    expect(await dev.session(signedOut)).toEqual({ signedIn: false, available: true })
    const ask = await chat.fetch("/api/model/agent", {
      method: "POST",
      body: modelRequest,
      headers: { cookie: cookie(signedOut) },
    })
    expect(ask.status).toBe(401)
    expect(chat.requests).toHaveLength(0)
    // "Sign in with GitHub" signs the developer in again at once, back where they were.
    const back = await dev.fetch("/api/auth/sign-in?return=%2Fapp%3Ftab%3D1", { headers: { cookie: cookie(signedOut) } })
    expect(back.status).toBe(303)
    expect(back.headers.get("location")).toBe("/app?tab=1")
    expect(setCookies(back)["smithers_dev_signed_out"]!.line).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
    expect(await dev.session()).toEqual({ signedIn: true, personId: expect.any(String), login: "local-developer", role: "admin", hostedModel: false })
    expect(dev.github.calls).toEqual([])
    expect(dev.revocations).toEqual([])
    expect(dev.count({ route: "sign_out", outcome: "signed_out", reason: "local_developer" })).toBe(1)
    expect(dev.count({ route: "sign_in", outcome: "signed_in", reason: "local_developer" })).toBe(1)
    // Over https the cookie is __Host- and Secure.
    const secure = await signInHarness(runtime, {
      config: {},
      fallback: { actor: localDeveloper, login: "local-developer" },
      origin: "https://smithers.test",
    })
    const secureOut = await secure.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "https://smithers.test" },
    })
    expect(setCookies(secureOut)["__Host-smithers_dev_signed_out"]!.line).toMatch(/; Secure/)
  })

  test("local development's teammate is whoever the dev person cookie names; anyone else is the developer", async () => {
    const teammate = { actor: { subject: { kind: "person" as const, id: "local-teammate" }, role: "member" as const }, login: "local-teammate" }
    const dev = await signInHarness(runtime, {
      config: {},
      fallback: { actor: localDeveloper, login: "local-developer" },
      teammates: { teammate },
    })
    expect(await dev.session({ smithers_dev_person: "teammate" })).toEqual({
      signedIn: true,
      personId: expect.any(String),
      login: "local-teammate",
      role: "member",
      hostedModel: false,
    })
    for (const person of ["nobody", "toString"]) {
      expect(await dev.session({ smithers_dev_person: person })).toEqual({
        signedIn: true,
        personId: expect.any(String),
        login: "local-developer",
        role: "admin",
        hostedModel: false,
      })
    }
    // Signed out, the cookie names nobody; without a developer, no teammate either.
    expect(await dev.session({ smithers_dev_person: "teammate", smithers_dev_signed_out: "1" })).toEqual({
      signedIn: false,
      available: true,
    })
    const alone = await signInHarness(runtime, { config: {}, fallback: { actor: localDeveloper, login: "local-developer" } })
    expect(await alone.session({ smithers_dev_person: "teammate" })).toMatchObject({ login: "local-developer" })
    const none = await signInHarness(runtime, { config: {}, teammates: { teammate } })
    expect(await none.session({ smithers_dev_person: "teammate" })).toEqual({ signedIn: false, available: false })
  })

  test("configured with the GitHub App, sign-in builds the real App adapter unless one is injected", async () => {
    const setup = await runtime.runPromise(
      SignIn.configured().pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(configured)),
      ),
    )
    const url = new URL(
      Option.getOrThrow(setup).github.authorizeUrl({ state: "s".repeat(43), codeChallenge: "c".repeat(43), redirectUri: "x" }),
    )
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("Iv1.scripted")
    expect(Option.getOrThrow(setup)).toMatchObject({
      repository: "smithersai/smithers",
      maxAgeSeconds: 30 * 24 * 60 * 60,
      recheckAfterMs: 60 * 60 * 1000,
    })
  })

  test("a SESSION_SECRET shorter than 32 characters turns sign-in off, and says so", async () => {
    const h = await signInHarness(runtime, { config: { ...configured, SESSION_SECRET: "short" } })
    expect(await h.session()).toEqual({ signedIn: false, available: false })
    expect(h.line("auth.config")[0]!.annotations).toMatchObject({ errorCode: "session_secret_too_short" })
  })
})

describe("asking Smithers", () => {
  test("a signed-out ask is refused before any model runs; a signed-in one is answered", async () => {
    const h = await signInHarness(runtime)
    const chat = await harness(runtime, answers("hi"), { sessions: h.sessions })
    const signedOut = await chat.fetch("/api/model/agent", { method: "POST", body: modelRequest })
    expect(signedOut.status).toBe(401)
    expect(((await signedOut.json()) as { readonly code: string }).code).toBe("authentication")
    expect(chat.requests).toHaveLength(0)
    const { cookies } = await h.signInAs()
    const signedIn = await chat.fetch("/api/model/agent", {
      method: "POST",
      body: modelRequest,
      headers: { cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId },
    })
    expect(signedIn.status).toBe(200)
    expect(await signedIn.text()).toContain("hi")
    expect(chat.requests).toHaveLength(1)
    // After signing out, the same cookie is refused again.
    await h.fetch("/api/auth/sign-out", { method: "POST", headers: { origin: "http://smithers.test", cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId } })
    const after = await chat.fetch("/api/model/agent", { method: "POST", body: modelRequest, headers: { cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId } })
    expect(after.status).toBe(401)
  })

  test("an ask while sessions can't be read is 503, not a sign-in prompt", async () => {
    const h = await signInHarness(runtime)
    const { cookies } = await h.signInAs()
    const down = await signInHarness(runtime, { github: h.github, database: unreachable })
    const chat = await harness(runtime, answers("hi"), { sessions: down.sessions })
    const response = await chat.fetch("/api/model/agent", {
      method: "POST",
      body: modelRequest,
      headers: { cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId },
    })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { readonly code: string }).code).toBe("provider_internal")
    expect(chat.requests).toHaveLength(0)
  })
})

describe("telemetry", () => {
  test("ChatApi's relay keeps the browser's sign-in records, and only their allowed fields", async () => {
    const chat = await harness(runtime, answers("never"))
    const attribute = (key: string, value: { readonly stringValue: string } | { readonly boolValue: boolean }) => ({
      key,
      value,
    })
    const record = (name: string, ...attributes: ReadonlyArray<ReturnType<typeof attribute>>) => ({
      severityNumber: 9,
      body: { stringValue: name },
      attributes: [...attributes, attribute("login", { stringValue: "SENTINEL-login" })],
    })
    const names = ["session loaded", "session unreachable", "sign in pressed", "signed out", "sign out failed"]
    const response = await chat.fetch("/api/telemetry/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceLogs: [{
          resource: { attributes: [attribute("service.name", { stringValue: "smithers-mvp-web" })] },
          scopeLogs: [{
            logRecords: names.map((name) =>
              record(name, attribute("feature", { stringValue: "auth" }), attribute("signedIn", { boolValue: true }))
            ),
          }],
        }],
      }),
    })
    expect(await response.json()).toEqual({})
    const relayed = chat.logs.filter((log) => log.annotations["otlp.signal"] !== undefined)
    expect(relayed.map((log) => log.message)).toEqual(names)
    expect(relayed[0]!.annotations).toMatchObject({ feature: "auth", signedIn: true })
    expect(recorded(chat)).not.toContain("SENTINEL")
  })

  test("no log line, span or metric carries a token, a code, a state, a cookie or a secret", async () => {
    const h = await signInHarness(runtime, { origin: "https://smithers.test" })
    const { cookies, code, state } = await h.signInAs()
    await h.session(cookies)
    await h.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "https://smithers.test", cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: (await sessionRows())[0]!.personId },
    })
    await h.callback({ code, state }, {})
    const tokens = h.github.issued.flatMap((issued) => [issued.accessToken, issued.refreshToken!]).map(Redacted.value)
    const exported = recorded(h)
    for (
      const sentinel of [
        ...tokens,
        code,
        state,
        cookies["__Host-smithers_session"]!,
        cookies["__Host-smithers_session"]!.split(".")[0]!,
        SECRET,
        CLIENT_SECRET,
        "octocat",
      ]
    ) {
      expect(exported).not.toContain(sentinel)
    }
    // The records exist: this is not a test of nothing.
    expect(h.line("auth.callback").length).toBeGreaterThan(0)
    expect(h.span("auth.callback").length).toBeGreaterThan(0)
  })
})


test("an old account's bound sign-out cannot revoke a new account or clear its cookie; identity reads remain unbound", async () => {
  const h = await signInHarness(runtime)
  const alice = await h.signInAs()
  const first = await h.session(alice.cookies) as SessionState
  expect(first.signedIn).toBe(true)
  if (!first.signedIn) throw new Error("expected Alice")
  h.github.person = { id: 900002, login: "bob" }
  const bob = await h.signInAs()
  const headers = { origin: "http://smithers.test", cookie: cookie(bob.cookies), [DEVICE_PERSON_HEADER]: first.personId! }
  const refused = await h.fetch("/api/auth/sign-out", { method: "POST", headers })
  expect(refused.status).toBe(403)
  expect(refused.headers.get("set-cookie")).toBeNull()
  expect(h.revocations).toEqual([])
  expect((await sessionRows()).every((row) => row.revokedAt === null)).toBe(true)
  const read = await h.fetch("/api/auth/session", { headers })
  expect(await read.json()).toMatchObject({ signedIn: true, login: "bob" })
  const actual = await h.session(bob.cookies) as SessionState
  if (!actual.signedIn) throw new Error("expected Bob")
  expect((await h.fetch("/api/auth/sign-out", { method: "POST", headers: { ...headers, [DEVICE_PERSON_HEADER]: actual.personId! } })).status).toBe(204)
})

test("a page that opened none of the device's data signs its cookie's person out; one that names no one can't", async () => {
  const h = await signInHarness(runtime)
  const { cookies } = await h.signInAs()
  const headers = { origin: "http://smithers.test", cookie: cookie(cookies) }
  const unbound = await h.fetch("/api/auth/sign-out", { method: "POST", headers })
  expect(unbound.status).toBe(403)
  expect(h.revocations).toEqual([])
  const sealed = await h.fetch("/api/auth/sign-out", { method: "POST", headers: { ...headers, [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA } })
  expect(sealed.status).toBe(204)
  expect((await sessionRows()).every((row) => row.revokedAt !== null)).toBe(true)
})

test("local development's old bound sign-out cannot change the next person's session", async () => {
  const teammate = { actor: { subject: { kind: "person" as const, id: "local-teammate" }, role: "member" as const }, login: "local-teammate" }
  const dev = await signInHarness(runtime, { config: {}, fallback: { actor: localDeveloper, login: "local-developer" }, teammates: { teammate } })
  const refused = await dev.fetch("/api/auth/sign-out", { method: "POST", headers: { origin: "http://smithers.test", cookie: "smithers_dev_person=teammate", [DEVICE_PERSON_HEADER]: "local-developer" } })
  expect(refused.status).toBe(403)
  expect(refused.headers.get("set-cookie")).toBeNull()
  expect(await dev.session({ smithers_dev_person: "teammate" })).toMatchObject({ signedIn: true, personId: "local-teammate" })
})


test("a legacy headerless queued write cannot commit with the next person's cookie; an explicit binding and verified bearer still work", async () => {
  const auth = await signInHarness(runtime)
  auth.github.person = { id: 900003, login: "bob" }
  const bob = await auth.signInAs()
  const identity = await auth.session(bob.cookies) as SessionState
  if (!identity.signedIn) throw new Error("expected Bob")
  const legacyHeaders = { cookie: cookie(bob.cookies) }
  const app = await harness(runtime, answers("Unused"), { sessions: auth.sessions })
  const question = { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Alice private queued question" }
  expect((await app.ask(question, legacyHeaders)).status).toBe(401)
  expect(await query((sql) => sql`SELECT id FROM messages WHERE id = ${question.id}::uuid`)).toEqual([])
  const bound = { ...legacyHeaders, [DEVICE_PERSON_HEADER]: identity.personId! }
  expect((await app.ask(question, bound)).status).toBe(202)
  expect(await query((sql) => sql`SELECT asked_by AS "askedBy" FROM messages WHERE id = ${question.id}::uuid`)).toEqual([{ askedBy: identity.personId }])
  const proof = await app.fetch(credentialRoute("cookie-bound-root"), { method: "POST", headers: bound, body: JSON.stringify({ flow: "watch/set" }) })
  expect(proof.status).toBe(200)
  const { token } = await proof.json() as { token: string }
  const nested = await app.fetch(credentialRoute("cookie-bound-child"), { method: "POST", headers: { ...legacyHeaders, authorization: `Bearer ${token}` }, body: JSON.stringify({ flow: "watch/set" }) })
  expect(nested.status).toBe(200)
  const signout = await auth.fetch("/api/auth/sign-out", { method: "POST", headers: { ...legacyHeaders, origin: "http://smithers.test" } })
  expect(signout.status).toBe(403)
  expect(signout.headers.get("set-cookie")).toBeNull()
  expect(auth.revocations).toEqual([])
  expect(await auth.session(bob.cookies)).toMatchObject({ signedIn: true, personId: identity.personId })
})

test("a forged sign-out cookie revokes nobody, and a signed run without a session id is ended", async () => {
  const h = await signInHarness(runtime)
  await h.signInAs()
  const keys = await Effect.runPromise(SessionKeys.make(Redacted.make(SECRET)))
  const out = await h.fetch("/api/auth/sign-out", { method: "POST", headers: {
    origin: "http://smithers.test", cookie: "smithers_session=forged", [DEVICE_PERSON_HEADER]: "absent-person",
  } })
  expect(out.status).toBe(204)
  expect((await sessionRows())[0]!.revokedAt).toBeNull()
  const { Base64Url } = await import("effect/encoding")
  const token = await Effect.runPromise(keys.sign("run", Base64Url.encode(JSON.stringify({
    v: 1, sub: (await sessionRows())[0]!.personId, run: "orphan", root: "orphan", act: "flow", chain: ["watch/set"], ceiling: [], exp: Date.now() + 60_000,
  }))))
  const response = await h.fetch("/api/auth/session", { headers: { authorization: `Bearer ${token}` } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ signedIn: false, available: true })
  // Identity reads intentionally ignore bearer credentials; a protected app route verifies this token.
  const app = await harness(runtime, answers("Unused"), { sessions: h.sessions })
  const write = await app.fetch("/api/watches", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ conversationId: null }) })
  expect(write.status).toBe(401)
  expect(app.snapshot()).toContainEqual(expect.objectContaining({ id: "smithers_run_credentials", attributes: expect.objectContaining({ op: "verify", outcome: "ended" }) }))
})
