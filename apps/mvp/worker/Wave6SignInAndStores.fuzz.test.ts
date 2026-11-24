// Generated scenarios against the real routes and stores on this file's schema of the compose Postgres: GitHub's
// callback (worker/SignIn.ts), a branch's conversation (worker/branch/Conversations.ts), the git loop's sync and
// installation rows (worker/github/Store.ts), a person's saved connections (worker/personal/Store.ts), protected
// write authority (worker/ProtectedAuthority.ts) and the read token (worker/github/ReadToken.ts). Each property
// computes what must happen from the scenario alone, then reads the answer and the rows back.
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Logger, Option, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { REPOSITORY_GRANTEE } from "../src/features/branch/contract.ts"
import type { Role } from "./Actor.ts"
import * as ProtectedAuthority from "./ProtectedAuthority.ts"
import type * as WriteAuthority from "./WriteAuthority.ts"
import * as Conversations from "./branch/Conversations.ts"
import * as ReadToken from "./github/ReadToken.ts"
import * as GitHubStore from "./github/Store.ts"
import { appKey, scriptedApp, scriptedGitHub } from "./github/test/scriptedGitHub.ts"
import * as PersonalStore from "./personal/Store.ts"
import { testFile } from "./test/harness.ts"
import { cookie, setCookies, signInHarness } from "./test/signIn.ts"

const runtime = testFile("wave6_sign_in_stores")

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? 20261131)
const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? 100)
/** A whole sign-in is several requests and transactions: fewer of them keep the file inside its time budget. */
const roundTrips = Math.min(executions, 40)

const query = <A extends object>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  Effect.flatMap(SqlClient.SqlClient, statement)

const bool = Schema.Boolean

const PERMISSIONS = ["admin", "maintain", "write", "triage", "read", "none"] as const
/** Decision 0007: a person's role is GitHub's permission on the repository, never more. */
const ROLE_OF: Readonly<Record<(typeof PERMISSIONS)[number], Role | null>> = {
  admin: "admin",
  maintain: "maintainer",
  write: "member",
  triage: "guest",
  read: "guest",
  none: null,
}

/** Where a sign-in started, where the browser lands signed in, and where it lands told sign-in failed. */
const RETURNS = [
  { to: "/app", signedIn: "/app", failed: "/app?sign_in=failed" },
  { to: "/board?tab=2#top", signedIn: "/board?tab=2#top", failed: "/board?tab=2&sign_in=failed#top" },
  // Another site's URL is never a return path.
  { to: "//evil.test/x", signedIn: "/", failed: "/?sign_in=failed" },
] as const

const CALLBACK_MODES = [
  "good",
  "wrong_state",
  "no_cookie",
  "other_browser",
  "post",
  "denied",
  "no_code",
  "exchange_refused",
  "user_refused",
  "permission_unavailable",
] as const
/** Refused before the attempt is read: the attempt is still the browser's to finish. */
const KEEPS_ATTEMPT: ReadonlyArray<(typeof CALLBACK_MODES)[number]> = ["wrong_state", "no_cookie", "other_browser", "post"]
/** GitHub's steps a callback reaches, in order. */
const GITHUB_STEPS: Readonly<Record<(typeof CALLBACK_MODES)[number], ReadonlyArray<string>>> = {
  good: ["exchange", "user", "permission"],
  wrong_state: [],
  no_cookie: [],
  other_browser: [],
  post: [],
  denied: [],
  no_code: [],
  exchange_refused: ["exchange"],
  user_refused: ["exchange", "user"],
  permission_unavailable: ["exchange", "user", "permission"],
}

test("GitHub's callback signs in exactly the browser that started, once, with the role GitHub gives", async () => {
  const auth = await signInHarness(runtime)
  let people = 0
  const sessionCookies = (response: Response) =>
    Object.fromEntries(
      Object.entries(setCookies(response))
        .filter(([name, set]) => name.endsWith("smithers_session") && set.value !== "")
        .map(([name, set]) => [name, set.value]),
    )
  const held = (githubId: number) =>
    runtime.runPromise(query<{ people: number; sessions: number; personId: string | null }>((sql) => sql`
      SELECT (SELECT count(*)::int FROM people WHERE github_id = ${githubId}) AS people,
        (SELECT count(*)::int FROM sessions s JOIN people p ON p.id = s.person_id WHERE p.github_id = ${githubId}) AS sessions,
        (SELECT id::text FROM people WHERE github_id = ${githubId}) AS "personId"`)).then((found) => found[0]!)

  const scenarios = Arbitrary.schema(Schema.Struct({
    mode: Schema.Literals(CALLBACK_MODES),
    permission: Schema.Literals(PERMISSIONS),
    returnTo: Schema.Literals([0, 1, 2]),
  }))
  const report = await Effect.runPromise(Fuzz.run(scenarios, (scenario) => Effect.promise(async () => {
    people += 1
    const person = { id: 7_000_000 + people, login: `fuzzer-${people}` }
    auth.github.person = person
    auth.github.permission = scenario.permission
    const target = RETURNS[scenario.returnTo]
    const started = await auth.start(target.to)
    expect(started.response.status).toBe(302)
    const { code, state } = auth.github.approve(started.location)
    const stateCookies = Object.fromEntries(Object.entries(started.cookies).map(([name, set]) => [name, set.value]))
    const calls = auth.github.calls.length
    const cleanups = auth.cleanupStarts.length

    if (scenario.mode === "exchange_refused") auth.github.failOnce.exchange = "rejected"
    if (scenario.mode === "user_refused") auth.github.failOnce.user = "rejected"
    if (scenario.mode === "permission_unavailable") auth.github.failOnce.permission = "unavailable"
    const answer: Record<string, string> = scenario.mode === "wrong_state" ? { code, state: `${state}x` }
      : scenario.mode === "denied" ? { state, error: "access_denied" }
      : scenario.mode === "no_code" ? { state }
      : { code, state }
    const presented = scenario.mode === "no_cookie" ? {}
      // Another browser's sign-in, started for the same person: its state cookie names another state.
      : scenario.mode === "other_browser"
      ? Object.fromEntries(Object.entries((await auth.start(target.to)).cookies).map(([name, set]) => [name, set.value]))
      : stateCookies
    const response = scenario.mode === "post"
      ? await auth.fetch(`/api/auth/callback?${new URLSearchParams(answer)}`, { method: "POST", headers: { cookie: cookie(presented) } })
      : await auth.callback(answer, presented)

    const admitted = scenario.mode === "good"
    const keepsAttempt = KEEPS_ATTEMPT.includes(scenario.mode)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(admitted ? target.signedIn : keepsAttempt ? "/?sign_in=failed" : target.failed)
    expect(auth.github.calls.slice(calls)).toEqual(GITHUB_STEPS[scenario.mode])
    // Tokens GitHub issued to a sign-in that then failed are handed to durable cleanup, never dropped.
    expect(auth.cleanupStarts.length - cleanups)
      .toBe(scenario.mode === "user_refused" || scenario.mode === "permission_unavailable" ? 1 : 0)
    const cookies = sessionCookies(response)
    expect(Object.keys(cookies)).toHaveLength(admitted ? 1 : 0)
    const after = await held(person.id)
    expect({ people: after.people, sessions: after.sessions }).toEqual(admitted ? { people: 1, sessions: 1 } : { people: 0, sessions: 0 })

    if (admitted) {
      expect(await auth.session(cookies)).toMatchObject({
        signedIn: true,
        personId: after.personId,
        login: person.login,
        role: ROLE_OF[scenario.permission],
      })
    }
    // The same answer again, from the same browser: the attempt is gone once read, and nobody is signed in twice.
    const again = await auth.callback({ code, state }, stateCookies)
    expect(again.status).toBe(303)
    if (keepsAttempt) {
      // The refusal read no attempt, so the browser that started it still finishes it.
      expect(again.headers.get("location")).toBe(target.signedIn)
      const finished = sessionCookies(again)
      expect(Object.keys(finished)).toHaveLength(1)
      expect(await auth.session(finished)).toMatchObject({ signedIn: true, login: person.login, role: ROLE_OF[scenario.permission] })
      expect((await held(person.id)).sessions).toBe(1)
    } else {
      expect(again.headers.get("location")).toBe("/?sign_in=failed")
      expect(sessionCookies(again)).toEqual({})
      expect((await held(person.id)).sessions).toBe(admitted ? 1 : 0)
    }
    expect(await auth.session({})).toMatchObject({ signedIn: false })
    return true
  }), { seed, executions: roundTrips }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

test("a branch is tracked once with one conversation, owned or shared as its mode and creator say", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    name: Schema.Literals(["main", "Feat/Login", "fix-42"]),
    mode: Schema.Literals(["locked", "open", "restricted"]),
    creator: bool,
    againMode: Schema.Literals(["locked", "open", "restricted"]),
    againCreator: bool,
  }))
  const report = await runtime.runPromise(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    const repo = `github/acme/${crypto.randomUUID()}`
    const creator = scenario.creator ? `person-${crypto.randomUUID()}` : undefined
    const owner = scenario.mode === "locked" ? null : creator ?? null
    const request = crypto.randomUUID()
    const rows = query<{ branches: number; conversations: number; createdBy: string | null; shares: ReadonlyArray<string> }>((sql) => sql`
      SELECT (SELECT count(*)::int FROM branches WHERE repo_id = ${repo}) AS branches,
        (SELECT count(*)::int FROM conversations WHERE repo_id = ${repo}) AS conversations,
        (SELECT created_by FROM branches WHERE repo_id = ${repo} AND name = ${scenario.name}) AS "createdBy",
        (SELECT coalesce(json_agg(s.grantee || ':' || s.access ORDER BY s.grantee), '[]'::json)
          FROM branch_shares s JOIN branches b ON b.id = s.branch_id WHERE b.repo_id = ${repo}) AS shares`)

    expect(yield* Conversations.find(repo, scenario.name)).toBeUndefined()
    const first = yield* Conversations.track(repo, scenario.name, scenario.mode, "a".repeat(40), creator, request)
    expect(first.created).toBe(true)
    expect(first.branch).toEqual({
      branchId: first.branch.branchId,
      conversationId: yield* Conversations.conversationIdOf(first.branch.branchId),
      repoId: repo,
      name: scenario.name,
      mode: scenario.mode,
    })
    // The id is the branch id's, whatever its case, and no other branch id's.
    expect(yield* Conversations.conversationIdOf(first.branch.branchId.toUpperCase())).toBe(first.branch.conversationId)
    expect(yield* Conversations.conversationIdOf(`${first.branch.branchId}0`)).not.toBe(first.branch.conversationId)
    const expected = {
      branches: 1,
      conversations: 1,
      createdBy: owner,
      // A branch nobody owns is the team's: anyone in the repository may edit it. An owned one starts private.
      shares: owner === null ? [`${REPOSITORY_GRANTEE}:edit`] : [],
    }
    expect((yield* rows)[0]).toEqual(expected)

    // Tracked again, by anyone, in any mode: the branch as it is, and nothing written.
    const second = yield* Conversations.track(repo, scenario.name, scenario.againMode, "b".repeat(40),
      scenario.againCreator ? "person-late" : undefined, crypto.randomUUID())
    expect(second).toEqual({ created: false, branch: first.branch })
    expect(yield* Conversations.find(repo, scenario.name)).toEqual(first.branch)
    expect((yield* rows)[0]).toEqual(expected)
    expect(yield* Conversations.createRequestOf(first.branch.branchId)).toBe(request)
    // Names are exact: another case is another branch, absent here.
    expect(yield* Conversations.find(repo, `${scenario.name}-other`)).toBeUndefined()
    expect(yield* Conversations.find(`${repo}-other`, scenario.name)).toBeUndefined()
    return true
  }), { seed, executions }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

const SYNC_OPS = ["cursor", "clear_cursor", "finish_complete", "finish_partial", "remember", "forget", "private", "public", "absent", "present"] as const
type SyncOp = (typeof SYNC_OPS)[number]

test("a repository's sync state, installation, visibility and App absence read back what the steps wrote, in any order", async () => {
  const op = Schema.Literals(SYNC_OPS)
  const scenarios = Arbitrary.schema(Schema.Struct({
    a: op, b: op, c: op, d: op, e: op, f: op,
    installation: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_000_000_000 })),
  }))
  const report = await runtime.runPromise(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    const repo = `github/acme/${crypto.randomUUID()}`
    const other = `${repo}-other`
    const model = {
      cursor: null as string | null,
      synced: false,
      complete: false,
      installation: Option.none<number>(),
      visibility: Option.none<boolean>(),
      row: false,
      absentWindow: false,
    }
    let syncedAt: number | null = null
    const steps: ReadonlyArray<SyncOp> = [scenario.a, scenario.b, scenario.c, scenario.d, scenario.e, scenario.f]
    for (const [index, step] of steps.entries()) {
      switch (step) {
        case "cursor":
          model.cursor = `cursor-${index}`
          yield* GitHubStore.commitCursor(repo, "issues", model.cursor)
          break
        case "clear_cursor":
          model.cursor = null
          yield* GitHubStore.commitCursor(repo, "issues", null)
          break
        case "finish_complete":
        case "finish_partial":
          model.synced = true
          model.complete = step === "finish_complete"
          yield* GitHubStore.finishSync(repo, "issues", { complete: model.complete, failure: model.complete ? null : "rate_limited" })
          break
        case "remember":
          model.installation = Option.some(scenario.installation + index)
          model.row = true
          yield* GitHubStore.rememberInstallation(repo, scenario.installation + index)
          break
        case "forget":
          model.installation = Option.none()
          yield* GitHubStore.forgetInstallation(repo)
          break
        case "private":
        case "public": {
          // What a step's read of the repository records (worker/github/VisibilityReceipt.ts), as a fixture row.
          const isPrivate = step === "private"
          model.visibility = Option.some(!isPrivate)
          model.row = true
          yield* query((sql) => sql`
            INSERT INTO github_repositories (repo_id, private) VALUES (${repo}, ${isPrivate})
            ON CONFLICT (repo_id) DO UPDATE SET private = EXCLUDED.private`)
          break
        }
        case "absent":
        case "present": {
          // An About read's finding (worker/RepoAbout.ts): the App is absent until its recheck window ends.
          model.absentWindow = step === "absent"
          const until = model.absentWindow ? "1 hour" : "-1 hour"
          yield* query((sql) => sql`
            INSERT INTO repo_about (repo_id, app_absent_until) VALUES (${repo}, clock_timestamp() + ${until}::interval)
            ON CONFLICT (repo_id) DO UPDATE SET app_absent_until = EXCLUDED.app_absent_until`)
          break
        }
      }
      const state = yield* GitHubStore.syncState(repo, "issues")
      expect({ cursor: state.cursor, complete: state.complete, synced: state.syncedAt !== null })
        .toEqual({ cursor: model.cursor, complete: model.complete, synced: model.synced })
      // A walk's end never moves back.
      if (state.syncedAt !== null && syncedAt !== null) expect(state.syncedAt).toBeGreaterThanOrEqual(syncedAt)
      syncedAt = state.syncedAt
      expect(yield* GitHubStore.installationOf(repo)).toEqual(model.installation)
      expect(yield* GitHubStore.isPublic(repo)).toEqual(model.visibility)
      expect(yield* GitHubStore.appAbsent(repo)).toBe(model.absentWindow && Option.isNone(model.installation))
      // Another stream and another repository hold none of it.
      expect(yield* GitHubStore.syncState(repo, "pulls")).toEqual({ cursor: null, syncedAt: null, complete: false })
      expect(yield* GitHubStore.installationOf(other)).toEqual(Option.none())
      expect(yield* GitHubStore.isPublic(other)).toEqual(Option.none())
      expect(yield* GitHubStore.appAbsent(other)).toBe(false)
      const [stored] = yield* query<{ rows: number }>((sql) => sql`
        SELECT count(*)::int AS rows FROM github_repositories WHERE repo_id = ${repo}`)
      expect(stored!.rows).toBe(model.row ? 1 : 0)
    }
    return true
  }), { seed, executions }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

const MODEL_OPS = ["put_first", "put_both", "keep_first", "keep_second", "unknown_edit", "remove", "replay"] as const
type ModelOp = (typeof MODEL_OPS)[number]

test("a person's saved connections follow each save and removal once per invocation key, and a stale save writes nothing", async () => {
  const op = Schema.Literals(MODEL_OPS)
  const scenarios = Arbitrary.schema(Schema.Struct({ a: op, b: op, c: op, d: op, e: op, f: op, g: op }))
  const sealed = { ciphertext: "c", nonce: "n", keyVersion: 1, keyLast4: "abcd" }
  const report = await runtime.runPromise(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    const personId = `person-${crypto.randomUUID()}`
    const connection = (id: string) => ({
      id,
      kind: "api_key" as const,
      active: true,
      protocol: "openai-chat" as const,
      baseUrl: "https://api.openai.test",
      models: { fast: "gpt-test" },
    })
    const first = connection(crypto.randomUUID())
    const second = connection(crypto.randomUUID())
    /** The saved connections in order, each with whether it is active. */
    let saved: ReadonlyArray<readonly [string, boolean]> = []
    let recorded: ReadonlyArray<string> = []
    let keys = 0
    type Write =
      | { readonly kind: "put"; readonly put: PersonalStore.Put }
      | { readonly kind: "remove"; readonly invocationKey: string }
    let last: { readonly write: Write; readonly recorded: boolean } | undefined
    const run = (write: Write) =>
      write.kind === "put" ? PersonalStore.put(write.put) : PersonalStore.remove({ personId, invocationKey: write.invocationKey })
    /** What `write` must answer under a key no step used, and what it leaves saved. */
    const expected = (write: Write): { readonly answer: string; readonly saved: typeof saved; readonly action?: string } => {
      if (write.kind === "remove") {
        return { answer: saved.length > 0 ? "deleted" : "missing", saved: [], action: "delete" }
      }
      const ids = saved.map(([id]) => id)
      const known = write.put.known
      if (known !== undefined && !(known.length === ids.length && ids.every((id) => known.includes(id)))) {
        return { answer: "stale", saved }
      }
      if (write.put.connections.some((kept) => kept.sealed === undefined && !ids.includes(kept.id))) return { answer: "stale", saved }
      const change = saved.length === 0 ? "set" : "replace"
      return { answer: change, saved: write.put.connections.map((kept) => [kept.id, kept.active] as const), action: change }
    }
    const steps: ReadonlyArray<ModelOp> = [scenario.a, scenario.b, scenario.c, scenario.d, scenario.e, scenario.f, scenario.g]
    for (const step of steps) {
      if (step === "replay" && last !== undefined) {
        // The same step run again: a recorded change answers `repeat`; a stale one is judged again and is still stale.
        expect(yield* run(last.write)).toBe(last.recorded ? "repeat" : "stale")
      } else {
        keys += 1
        const invocationKey = `${personId}:${keys}`
        const write: Write = step === "remove" || step === "replay" ? { kind: "remove", invocationKey }
          : {
            kind: "put",
            put: {
              personId,
              invocationKey,
              connections: step === "put_first" ? [{ ...first, sealed }]
                : step === "put_both" ? [{ ...second, sealed }, { ...first, sealed }]
                : step === "keep_first" ? [{ ...first, active: false }]
                : step === "keep_second" ? [{ ...second, active: false }]
                : [{ ...first, sealed }],
              ...(step === "unknown_edit" ? { known: [crypto.randomUUID()] } : {}),
            },
          }
        const outcome = expected(write)
        expect(yield* run(write)).toBe(outcome.answer)
        saved = outcome.saved
        if (outcome.action !== undefined) recorded = [...recorded, outcome.action]
        last = { write, recorded: outcome.action !== undefined }
      }
      expect((yield* PersonalStore.saved(personId)).map((row) => [row.id, row.active])).toEqual(saved)
      expect(yield* PersonalStore.hasModel(personId)).toBe(saved.length > 0)
      const events = yield* query<{ action: string }>((sql) => sql`
        SELECT action FROM personal_model_events WHERE person_id = ${personId} ORDER BY id`)
      expect(events.map((event) => event.action)).toEqual(recorded)
    }
    return true
  }), { seed, executions }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

const ROLES: ReadonlyArray<Role> = ["admin", "maintainer", "member", "guest"]
const AUTHORITY_STATES = ["live", "revoked", "expired", "stale_role", "other_person", "no_scope", "local"] as const

test("protected authority is held, denied or unavailable by the session's row and its latest confirmed role", async () => {
  const scenarios = Arbitrary.schema(Schema.Struct({
    state: Schema.Literals(AUTHORITY_STATES),
    role: Schema.Literals(["admin", "maintainer", "member", "guest", "none"]),
    admin: bool,
    maintainer: bool,
    member: bool,
    guest: bool,
  }))
  let people = 0
  const report = await runtime.runPromise(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    people += 1
    const personId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const role = scenario.role === "none" ? null : scenario.role
    yield* query((sql) => sql`
      INSERT INTO people (id, github_id, github_login) VALUES (${personId}, ${8_000_000 + people}, ${`holder-${people}`})`)
    yield* query((sql) => sql`
      INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
      VALUES (${sessionId}, ${sessionId}, ${personId}, ${role}, clock_timestamp(),
        clock_timestamp() - ${scenario.state === "stale_role" ? "2 hours" : "0 seconds"}::interval,
        clock_timestamp() + ${scenario.state === "expired" ? "-1 minute" : "1 day"}::interval)`)
    if (scenario.state === "revoked") {
      yield* query((sql) => sql`UPDATE sessions SET revoked_at = clock_timestamp() WHERE id = ${sessionId}`)
    }
    const signedIn: WriteAuthority.Session = {
      personId: scenario.state === "other_person" ? crypto.randomUUID() : personId,
      sessionId,
      cookieKey: "legacy",
      ...(scenario.state === "no_scope" ? {} : { scope: { _tag: "Deployment" as const } }),
    }
    const authority = scenario.state === "local" ? null : signedIn
    const required = ROLES.filter((candidate) => scenario[candidate])
    const usable = scenario.state === "live"
    const expected = scenario.state === "local" ? "held"
      : !usable ? "unavailable"
      : role !== null && required.includes(role) ? "held"
      : "denied"
    expect(yield* ProtectedAuthority.check(authority, required)).toBe(expected)
    expect(yield* ProtectedAuthority.holds(authority, required)).toBe(expected === "held")
    // At commit only the deadlines are asked: the check's row locks already serialize a revocation with the write, so
    // what can still lapse is time. A session or role past its deadline, or one the row doesn't back, rolls it back.
    const commit = yield* Effect.result(ProtectedAuthority.requireAtCommit(authority))
    expect(commit._tag === "Success" ? "held" : commit.failure._tag)
      .toBe(scenario.state === "local" || usable || scenario.state === "revoked" ? "held" : "WriteAuthorityExpired")
    return true
  }), { seed, executions }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})

test("the read token is the configured one, else the App's kept until five minutes before it expires, else none", async () => {
  const key = await appKey()
  const read = Schema.Struct({ installed: bool, minutesLeft: Schema.Literals([60, 30, 4, 2]) })
  const scenarios = Arbitrary.schema(Schema.Struct({
    reads: Schema.Literals([1, 2, 3, 4]),
    a: read, b: read, c: read, d: read,
    configured: Schema.Literals(["absent", "empty", "blank", "set"]),
  }))
  const value = (token: Option.Option<Redacted.Redacted<string>>) => Option.getOrNull(Option.map(token, Redacted.value))
  const report = await Effect.runPromise(Fuzz.run(scenarios, (scenario) => Effect.gen(function* () {
    const github = scriptedGitHub("acme", "widgets")
    const token = yield* ReadToken.fromApp(yield* scriptedApp(github, key), github)
    let minted = 0
    let held: { readonly token: string; readonly fresh: boolean } | undefined
    for (const step of [scenario.a, scenario.b, scenario.c, scenario.d].slice(0, scenario.reads)) {
      github.installed = step.installed
      // GitHub's tokens last an hour from its clock: set behind, what it mints next has `minutesLeft` on ours.
      github.now = Date.now() - (60 - step.minutesLeft) * 60_000
      let expected: string | null
      if (held?.fresh === true) {
        expected = held.token
      } else if (!step.installed) {
        expected = null
      } else {
        minted += 1
        held = { token: `ghs_scripted_${minted}`, fresh: step.minutesLeft * 60_000 > ReadToken.REFRESH_BEFORE_MS }
        expected = held.token
      }
      expect(value(yield* token)).toBe(expected)
      expect(github.minted.map((mint) => mint.token)).toEqual(Array.from({ length: minted }, (_, index) => `ghs_scripted_${index + 1}`))
    }
    for (const mint of github.minted) expect(mint.body).toEqual({ repositories: ["widgets"], permissions: { metadata: "read" } })

    // `GITHUB_TOKEN` wins when it says anything; with no App beside it, a blank one reads anonymously.
    const config: Record<string, string> = scenario.configured === "absent" ? {}
      : { GITHUB_TOKEN: scenario.configured === "empty" ? "" : scenario.configured === "blank" ? " \t " : "ghp_bot" }
    const settings = yield* ReadToken.settings.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))))
    const configured = scenario.configured === "set" ? "ghp_bot" : null
    expect({ token: value(settings.token), app: Option.isSome(settings.app) }).toEqual({ token: configured, app: false })
    const fixed = yield* ReadToken.fromSettings(settings).pipe(Effect.provide(FetchHttpClient.layer))
    expect(value(yield* fixed)).toBe(configured)
    return true
    // Each mint logs its outcome (worker/github/ReadToken.test.ts reads those lines); here they would only be noise.
  }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set())), { seed, executions }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})
