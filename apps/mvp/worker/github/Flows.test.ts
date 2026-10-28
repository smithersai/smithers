// The git loop's remote flows (worker/github/{Write,Apply,Reconcile}.ts, docs/features/issues.md#remote-flows) on the
// Node host (worker/test/flowHost.ts), over this file's schema of the compose Postgres (`pnpm db:up`), with the
// scripted GitHub (worker/github/test/scriptedGitHub.ts). The same flows and registrations run on the Cloudflare Durable
// Object, so passing here shows they are host-agnostic. A step's records are checked by running it alone.
import { Journal } from "@smthrs/flows"
import { GitHub } from "@smthrs/integrations"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Cause, Effect, Exit, Layer, Logger, Metric, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { reconcileExecutionId, SYNC_STALE_MS, writeExecutionId } from "../../src/features/issues/contract.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Apply from "./Apply.ts"
import * as Metrics from "./Metrics.ts"
import * as Reconcile from "./Reconcile.ts"
import * as Store from "./Store.ts"
import { admit, comments, database, items, keys, REPOSITORY, reset, services, signedIn, sql, writeRow } from "./test/fixtures.ts"
import { BOT_LOGIN, scriptedApp, scriptedGitHub, appKey } from "./test/scriptedGitHub.ts"
import * as Tokens from "./Tokens.ts"
import * as Write from "./Write.ts"

const runtime = testFile("github_flows")

beforeEach(() => reset(runtime))

const REPO = `${REPOSITORY.owner}/${REPOSITORY.name}`

/** A sentinel no record may carry: titles, bodies and logins are content. */
const SENTINEL = "sentinel-content-7f3a"

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

/** Runs `effect` keeping its log lines. */
const logged = async <A, E>(effect: Effect.Effect<A, E>) => {
  const logs: Array<StructuredLog> = []
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(Logger.layer([Logger.make((log) => void logs.push(StructuredLogger.formatStructured.log(log)))]))),
  )
  return { exit, logs }
}

/** A registration that counts its metrics in `registry`. */
const counting = <A, E, R>(registration: Layer.Layer<A, E, R>) => {
  const registry: Metric.MetricRegistry = new Map()
  const count = (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    ).count
  return { registration: registration.pipe(Layer.provide(Layer.succeed(Metric.MetricRegistry, registry))), count }
}

const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))

/** A database whose client can't even be built, as when a host's connection string fails to resolve. */
const unbuildable = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("no connection string")))

/** A person `maya` signed in with a token the scripted GitHub takes, a writer there, as her agent's writes check. */
const maya = async (github: ReturnType<typeof scriptedGitHub>, expiresInMs?: number | null) => {
  github.roles.set("maya", "write")
  const token = github.userToken("maya")
  return { token, ...(await signedIn(runtime, { login: "maya", token, ...(expiresInMs === undefined ? {} : { expiresInMs }) })) }
}

const issueWrite = (title = "Crash on empty body", body = "Steps to reproduce") =>
  ({ op: "issue/create", title, body }) as const

const runWrite = async (writeId: string, value: Awaited<ReturnType<typeof services>>["services"], executionId?: string) =>
  runFlow(Write.Write, { writeId }, Write.registration(value), {
    executionId: executionId ?? writeExecutionId(writeId),
    maxConnections: 3,
  })

describe("github/Write", () => {
  test("a person's issue: GitHub shows them, the write and its row settle together, the marker stays hidden", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    const { services: value } = await services(runtime, github)
    const ran = await runWrite(writeId, value)
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(ran.status).toBe("completed")
    const made = github.issues.get(1)!
    expect(made.login).toBe("maya")
    expect(GitHub.Issues.writeIdOf(made.body)).toBe(writeId)
    expect(github.seen("POST", /\/issues$/).map((call) => call.token)).toEqual(["user"])
    // Action.once looks for the marker before every write, a first attempt's included: a host that lost its journal
    // is still right. One read, as the person's own token.
    expect(github.seen("GET", /\/issues$/).map((call) => call.token)).toEqual(["user"])
    expect(await writeRow(runtime, writeId)).toEqual({ status: "done", failure: null, attempts: 1, itemNumber: 1 })
    expect(await items(runtime)).toEqual([
      {
        number: 1,
        kind: "issue",
        title: "Crash on empty body",
        body: "Steps to reproduce",
        state: "open",
        author: "maya",
        comments: 0,
        writeId,
        deleted: false,
      },
    ])
  })

  test("a new issue's receipts reach its person's feed with them: Working once admitted, then Done on its issue, or Failed", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const notice = async (writeId: string) => (await sql(runtime,
      `SELECT recipient, kind, state, title, href, version FROM notifications WHERE subject = 'write:${writeId}'`)) as ReadonlyArray<unknown>
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    expect(await notice(writeId)).toEqual([
      { recipient: person.personId, kind: "write", state: "working", title: "Create issue", href: `/${REPO}/issues`, version: 1 },
    ])
    const { services: value } = await services(runtime, github)
    await runWrite(writeId, value)
    expect(await notice(writeId)).toEqual([
      { recipient: person.personId, kind: "write", state: "done", title: "Create issue", href: `/${REPO}/issues/1`, version: 2 },
    ])
    const failed = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    await Effect.runPromise(Write.steps(value).giveUp({ writeId: failed }))
    expect(await notice(failed)).toEqual([expect.objectContaining({ state: "failed", href: `/${REPO}/issues`, version: 2 })])
    // A comment's receipts stay off the feed.
    const comment = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: { op: "issue/comment", number: 1, body: "x" } })
    expect(await notice(comment)).toEqual([])
  })

  test("the agent's issue is the App's, says whom it acted for, and its token can only write issues", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite() })
    const { services: value } = await services(runtime, github)
    const ran = await runWrite(writeId, value)
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    const made = github.issues.get(1)!
    expect(made.login).toBe(BOT_LOGIN)
    expect(made.body).toContain("Steps to reproduce\n\nSmithers for @maya")
    expect(github.minted.map((minted) => minted.body)).toEqual([{ repositories: ["widgets"], permissions: { issues: "write" } }])
    expect((await items(runtime))[0]).toMatchObject({ author: BOT_LOGIN, body: "Steps to reproduce\n\nSmithers for @maya" })
  })

  test("a comment lands on its issue, and the issue is read back with it", async () => {
    const github = scriptedGitHub()
    github.open("Existing", "Body", "sam")
    const person = await maya(github)
    const writeId = await admit(runtime, {
      actorId: person.personId,
      sessionId: person.sessionId,
      via: "person",
      payload: { op: "issue/comment", number: 1, body: "Looks good" },
    })
    const { services: value } = await services(runtime, github)
    const ran = await runWrite(writeId, value)
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(github.issues.get(1)!.comments.map((comment) => comment.login)).toEqual(["maya"])
    expect(await comments(runtime)).toEqual([
      expect.objectContaining({ itemId: `${REPOSITORY.id}#1`, body: "Looks good", author: "maya", writeId, deleted: false }),
    ])
    expect((await items(runtime))[0]).toMatchObject({ number: 1, title: "Existing", comments: 1, author: "sam" })
  })

  test("an answer lost after GitHub made the issue: Action.once finds it by the write's marker and makes no second one", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/issues"), lost: true })
    const { services: value } = await services(runtime, github)
    const metrics = counting(Write.registration(value))
    const ran = await runFlow(Write.Write, { writeId }, metrics.registration, { executionId: writeExecutionId(writeId), maxConnections: 3 })
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(github.issues.size).toBe(1)
    // Looked for first, posted once, then found by the marker after the lost answer, in the one attempt.
    expect(github.seen("POST", /\/issues$/)).toHaveLength(1)
    expect(github.seen("GET", /\/issues$/)).toHaveLength(2)
    expect(github.issues.get(1)!.body).toBe(GitHub.Issues.withWriteMarker("Steps to reproduce", writeId))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", attempts: 1 })
    expect(metrics.count(Metrics.writes, { op: "issue/create", outcome: "done", token: "user" })).toBe(1)
  })

  test("a comment's lost answer, then a retry: one comment", async () => {
    const github = scriptedGitHub()
    github.open("Existing", "Body")
    const person = await maya(github)
    const writeId = await admit(runtime, {
      actorId: person.personId,
      sessionId: person.sessionId,
      via: "person",
      payload: { op: "issue/comment", number: 1, body: "Once" },
    })
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/comments"), lost: true })
    const { services: value } = await services(runtime, github)
    expect((await runWrite(writeId, value)).exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(github.issues.get(1)!.comments).toHaveLength(1)
    expect(await comments(runtime)).toHaveLength(1)
  })

  test("a run that died after GitHub took the issue and before its step sealed adopts it, writing nothing again", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    // The first attempt counted itself and posted; GitHub made the issue; the process died before anything was sealed.
    await sql(runtime, `UPDATE github_writes SET attempts = 1 WHERE id = '${writeId}'`)
    github.open("Crash on empty body", GitHub.Issues.withWriteMarker("Steps to reproduce", writeId), "maya")
    const { services: value } = await services(runtime, github)
    expect((await runWrite(writeId, value)).exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(github.issues.size).toBe(1)
    expect(github.seen("POST", /\/issues$/)).toHaveLength(0)
    expect((await items(runtime))[0]).toMatchObject({ number: 1, writeId, body: "Steps to reproduce" })
  })

  test("a resumed agent write adopts its earlier issue after role revocation, but cannot post a new comment", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite() })
    github.open("Already written", GitHub.Issues.withWriteMarker("Before revocation", writeId), BOT_LOGIN)
    github.roles.set("maya", "read")
    const { services: value } = await services(runtime, github)
    expect((await runWrite(writeId, value)).exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(github.seen("POST", /\/issues$/)).toHaveLength(0)
    const commentId = await admit(runtime, {
      actorId: person.personId, sessionId: null, via: "agent", payload: { op: "issue/comment", number: 1, body: "After revocation" },
    })
    expect((await runWrite(commentId, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(github.seen("POST", /\/comments$/)).toHaveLength(0)
    expect(await writeRow(runtime, commentId)).toMatchObject({ failure: "not_allowed" })
  })

  test.each([
    [403, "not_allowed"],
    [422, "invalid"],
    [410, "not_found"],
  ] as const)("GitHub answering %i settles the write refused (%s), never tried again", async (status, failure) => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    github.faults.push({ match: (method) => method === "POST", status })
    const { services: value } = await services(runtime, github)
    const metrics = counting(Write.registration(value))
    const ran = await runFlow(Write.Write, { writeId }, metrics.registration, { maxConnections: 3 })
    expect(ran.exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure, attempts: 1 })
    expect(github.seen("POST", /\/issues$/)).toHaveLength(1)
    expect(metrics.count(Metrics.writes, { op: "issue/create", outcome: "refused", token: "user" })).toBe(1)
  })

  test("a comment on an issue GitHub no longer has is refused not_found", async () => {
    const github = scriptedGitHub()
    github.open("Gone soon", "Body")
    github.remove(1)
    const person = await maya(github)
    const writeId = await admit(runtime, {
      actorId: person.personId,
      sessionId: person.sessionId,
      via: "person",
      payload: { op: "issue/comment", number: 1, body: "Hello" },
    })
    const { services: value } = await services(runtime, github)
    expect((await runWrite(writeId, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ failure: "not_found" })
  })

  test("a person whose session ended, or whose token GitHub refuses, must sign in again; the App's 401 is unavailable", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const { services: value } = await services(runtime, github)
    // Ended: nothing reaches GitHub.
    const ended = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    await sql(runtime, `UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out'`)
    expect((await runWrite(ended, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, ended)).toMatchObject({ failure: "sign_in_required", attempts: 0 })
    expect(github.calls).toHaveLength(0)
    // Live, but GitHub no longer takes the token.
    const again = await maya(github)
    github.revoke(again.token)
    const refused = await admit(runtime, { actorId: again.personId, sessionId: again.sessionId, via: "person", payload: issueWrite() })
    expect((await runWrite(refused, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, refused)).toMatchObject({ failure: "sign_in_required", attempts: 1 })
    // The App's own token refused: a fault on our side, not the person's.
    const agent = await admit(runtime, { actorId: again.personId, sessionId: null, via: "agent", payload: issueWrite() })
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/issues"), status: 401 })
    expect((await runWrite(agent, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, agent)).toMatchObject({ failure: "unavailable" })
  })

  test("without sign-in configured, a person's write can't open their token", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    const { services: value } = await services(runtime, github, { signIn: false })
    expect((await runWrite(writeId, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ failure: "sign_in_required" })
  })

  test("a token sealed under another secret no longer opens: sign in again", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    await sql(runtime, `UPDATE sessions SET github_access = '{"ciphertext":"AAAA","nonce":"AAAA"}'::jsonb`)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    const { services: value } = await services(runtime, github)
    expect((await runWrite(writeId, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ failure: "sign_in_required" })
  })

  test("a token about to expire starts the session's role check and waits for it, then writes with the new one", async () => {
    const github = scriptedGitHub()
    const person = await maya(github, 60_000)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    const { services: value, refreshes } = await services(runtime, github)
    const first = await Effect.runPromiseExit(Write.steps(value).send({ writeId }))
    expect(Exit.isFailure(first) && Cause.squash(first.cause)).toEqual(new Write.WriteUnavailable({ retryAfterMillis: 5_000 }))
    const [checked] = (await sql(
      runtime,
      `SELECT (extract(epoch FROM role_checked_at) * 1000)::bigint::text AS at FROM sessions`,
    )) as unknown as [{ at: string }]
    expect(refreshes).toEqual([{ sessionId: person.sessionId, generation: Number(checked.at) }])
    expect(github.calls).toHaveLength(0)
    // The role check refreshed the token: the next attempt writes.
    await sql(runtime, `UPDATE sessions SET github_access_expires_at = now() + interval '8 hours'`)
    expect(await Effect.runPromise(Write.steps(value).send({ writeId }))).toEqual({ status: "done", itemNumber: 1 })
    // A token that doesn't expire never asks.
    const forever = await maya(github, null)
    const lasting = await admit(runtime, { actorId: forever.personId, sessionId: forever.sessionId, via: "person", payload: issueWrite("Two") })
    expect(await Effect.runPromise(Write.steps(value).send({ writeId: lasting }))).toEqual({ status: "done", itemNumber: 2 })
    expect(refreshes).toHaveLength(1)
  })

  test("the App not installed, or without the issues write permission: the agent's write is refused", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const { services: value } = await services(runtime, github)
    github.installed = false
    const notInstalled = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite() })
    expect((await runWrite(notInstalled, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, notInstalled)).toMatchObject({ failure: "app_not_installed" })
    github.installed = true
    github.granted = "read"
    const readOnly = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite() })
    expect((await runWrite(readOnly, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, readOnly)).toMatchObject({ failure: "not_allowed" })
  })

  test("the installation is looked up once and remembered; one GitHub says is gone is forgotten", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const { services: value } = await services(runtime, github)
    for (const title of ["One", "Two"]) {
      const writeId = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite(title) })
      expect((await runWrite(writeId, value)).exit._tag).toBe("Success")
    }
    expect(github.seen("GET", /\/installation$/)).toHaveLength(1)
    expect(github.seen("POST", /access_tokens$/)).toHaveLength(2)
    github.faults.push({ match: (_, path) => path.endsWith("/access_tokens"), status: 404 })
    const gone = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite("Three") })
    expect((await runWrite(gone, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await sql(runtime, `SELECT installation_id AS "installationId" FROM github_repositories`)).toEqual([
      { installationId: null },
    ])
  })

  test("a rate limit waits GitHub's Retry-After, then writes once, looking for its marker first", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    github.faults.push({ match: (method) => method === "POST", status: 429, headers: { "retry-after": "1" } })
    const { services: value } = await services(runtime, github)
    expect((await runWrite(writeId, value)).exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(github.issues.size).toBe(1)
    expect(github.seen("POST", /\/issues$/)).toHaveLength(2)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", attempts: 2 })
  })

  test("a run started again after its write settled answers what it settled, calling nobody", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    const { services: value } = await services(runtime, github)
    await runWrite(writeId, value)
    const calls = github.calls.length
    expect((await runWrite(writeId, value, crypto.randomUUID())).exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    await sql(runtime, `UPDATE github_writes SET status = 'refused', failure = 'invalid' WHERE id = '${writeId}'`)
    expect(await Effect.runPromise(Write.steps(value).send({ writeId }))).toEqual({ status: "refused", itemNumber: null })
    expect(github.calls).toHaveLength(calls)
  })

  test("giving up settles the write failed unavailable, once; an unknown write is missing", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    const { services: value } = await services(runtime, github)
    const steps = Write.steps(value)
    expect(await Effect.runPromise(steps.giveUp({ writeId }))).toEqual({ status: "failed", itemNumber: null })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "failed", failure: "unavailable" })
    const unknown = crypto.randomUUID()
    expect(await Effect.runPromise(steps.giveUp({ writeId: unknown }))).toEqual({ status: "missing", itemNumber: null })
    expect(await Effect.runPromise(steps.send({ writeId: unknown }))).toEqual({ status: "missing", itemNumber: null })
  })

  test("GitHub down on every attempt, or Postgres unreachable, fails the step for its retry policy", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    const { services: value } = await services(runtime, github)
    github.faults.push({ match: (method) => method === "POST", status: 502, headers: { "retry-after": "3" } })
    const down = await Effect.runPromiseExit(Write.steps(value).send({ writeId }))
    expect(Exit.isFailure(down) && Cause.squash(down.cause)).toEqual(new Write.WriteUnavailable({}))
    // The read-back failing after GitHub took it: tried again; the next attempt adopts.
    github.faults.push({ match: (method, path) => method === "GET" && /\/issues\/1$/.test(path), status: 503 })
    const readBack = await Effect.runPromiseExit(Write.steps(value).send({ writeId }))
    expect(Exit.isFailure(readBack)).toBe(true)
    expect(await Effect.runPromise(Write.steps(value).send({ writeId }))).toEqual({ status: "done", itemNumber: 1 })
    expect(github.issues.size).toBe(1)
    const { services: offline } = await services(runtime, github, { database: unreachable })
    const noDatabase = await Effect.runPromiseExit(Write.steps(offline).send({ writeId }))
    expect(Exit.isFailure(noDatabase) && Cause.squash(noDatabase.cause)).toEqual(new Write.WriteUnavailable({}))
    const noDatabaseGiveUp = await Effect.runPromiseExit(Write.steps(offline).giveUp({ writeId }))
    expect(Exit.isFailure(noDatabaseGiveUp)).toBe(true)
  })

  test("giving up on a write another run settled answers what that run settled, never failed, and records nothing", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite() })
    const { services: value } = await services(runtime, github)
    expect((await runWrite(writeId, value)).exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    const { exit, logs } = await logged(Write.steps(value).giveUp({ writeId }))
    // Before 2026-10-21 give-up answered `failed` here while the row said done (Fable review).
    expect(exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(logs.filter((log) => log.message === "github.write")).toEqual([])
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done" })
  })

  test("giving up counts the token kind send counts: none for a settings write, app for the agent's, user for a person's", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const { services: value } = await services(runtime, github)
    const kinds: Array<unknown> = []
    for (const [via, payload] of [
      ["person", { op: "triage/enable", dailyTokens: 1_000 }],
      ["person", { op: "triage/pause" }],
      ["agent", issueWrite()],
      ["person", issueWrite()],
    ] as const) {
      const writeId = await admit(runtime, {
        actorId: person.personId,
        sessionId: via === "person" ? person.sessionId : null,
        via,
        payload,
      })
      const { logs } = await logged(Write.steps(value).giveUp({ writeId }))
      kinds.push(logs.find((log) => log.message === "github.write")!.annotations["tokenKind"])
    }
    // Before 2026-10-21 the settings writes counted `user` here and `none` in send (Fable review).
    expect(kinds).toEqual(["none", "none", "app", "user"])
  })

  test("under the host's redaction a write's record still says whose token wrote: user for a person, app for the agent", async () => {
    // The live run on the real GitHub (2026-10-20) logged `token: "[REDACTED]"`: the flow host's RedactedLogger hides the
    // value of any field named `token`, so no record said whether a write went as the person or as the App.
    const github = scriptedGitHub()
    const person = await maya(github)
    const own = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    const agent = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite() })
    const failing = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    const { services: value } = await services(runtime, github)
    const records = async (writeId: string) => {
      const { logs } = await logged(Write.steps(value).send({ writeId }).pipe(Effect.provide(Journal.RedactedLogger.layer())))
      return logs.filter((log) => log.message === "github.write").map((log) => log.annotations)
    }
    expect(await records(own)).toEqual([expect.objectContaining({ via: "person", tokenKind: "user", outcome: "done" })])
    expect(await records(agent)).toEqual([expect.objectContaining({ via: "agent", tokenKind: "app", outcome: "done" })])
    github.faults.push({ match: (method) => method === "POST", status: 502 })
    expect(await records(failing)).toEqual([expect.objectContaining({ tokenKind: "user", errorCode: expect.any(String) })])
  })

  test("the agent writes only for a person who is still a Member there, as the account sign-in knows; else refused, nothing written", async () => {
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    // Nobody sign-in knows: no account to check.
    const nobody = await admit(runtime, { actorId: "local-developer", sessionId: null, via: "agent", payload: issueWrite() })
    expect((await runWrite(nobody, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, nobody)).toMatchObject({ failure: "not_allowed" })
    expect(github.seen("GET", /\/permission$/)).toEqual([])
    // Maya, now only a reader there; then a login someone else took after a rename.
    const person = await maya(github)
    for (const change of [() => github.roles.set("maya", "read"), () => github.accounts.set("maya", 1)]) {
      github.roles.set("maya", "write")
      change()
      const writeId = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite() })
      expect((await runWrite(writeId, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
      expect(await writeRow(runtime, writeId)).toMatchObject({ failure: "not_allowed" })
    }
    // Gone from the repository: GitHub knows no permission for her.
    github.accounts.delete("maya")
    github.roles.delete("maya")
    const gone = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite() })
    expect((await runWrite(gone, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(github.issues.size).toBe(0)
  })

  test("a commitment from someone with no GitHub login is no Maintainer's: refused, nothing labeled", async () => {
    const github = scriptedGitHub()
    github.open("Accepted", "Body")
    const writeId = await admit(runtime, {
      actorId: "local-developer",
      sessionId: null,
      via: "agent",
      payload: { op: "issue/commitment", number: 1, commitment: "now" },
    })
    const { services: value } = await services(runtime, github)
    expect((await runWrite(writeId, value)).exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect(github.issues.get(1)!.labels).toEqual([])
  })

  test("a write another run settles while this one is at GitHub: settling again changes nothing and counts nothing", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: issueWrite() })
    github.faults.push({
      match: (method, path) => method === "POST" && path.endsWith("/issues"),
      hold: async () => void await sql(runtime, `UPDATE github_writes SET status = 'refused', failure = 'invalid', settled_at = now() WHERE id = '${writeId}'`),
    })
    const { services: value } = await services(runtime, github)
    const { logs } = await logged(Write.steps(value).send({ writeId }))
    expect(logs.find((log) => log.message === "github.write")!.annotations).toMatchObject({ outcome: "done", settled: false })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "invalid" })
  })

  test("the App's installation or token unreachable fails the step for its retry policy", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite() })
    const { services: value } = await services(runtime, github)
    github.faults.push({ match: (_, path) => path.endsWith("/installation"), status: 502 })
    const lookup = await Effect.runPromiseExit(Write.steps(value).send({ writeId }))
    expect(Exit.isFailure(lookup) && Cause.squash(lookup.cause)).toEqual(new Write.WriteUnavailable({}))
    github.faults.push({ match: (_, path) => path.endsWith("/access_tokens"), lost: true })
    const mint = await Effect.runPromiseExit(Write.steps(value).send({ writeId }))
    expect(Exit.isFailure(mint) && Cause.squash(mint.cause)).toEqual(new Write.WriteUnavailable({}))
    expect(github.issues.size).toBe(0)
    expect(await Effect.runPromise(Write.steps(value).send({ writeId }))).toEqual({ status: "done", itemNumber: 1 })
  })

  test("a session whose tokens GitHub refused holds none: sign in again", async () => {
    const github = scriptedGitHub()
    const person = await maya(github)
    await sql(runtime, `UPDATE sessions SET github_access = NULL, github_access_expires_at = NULL`)
    const tokens = Tokens.make({
      app: await Effect.runPromise(scriptedApp(github, await appKey())),
      keys: Option.some(await keys()),
      refresh: () => Effect.void,
    })
    const exit = await Effect.runPromiseExit(tokens.forSession(person.sessionId).pipe(Effect.provide(await database(runtime))))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(new Tokens.TokenUnavailable({ reason: "sign_in_required" }))
    const offline = await Effect.runPromiseExit(tokens.forSession(person.sessionId).pipe(Effect.provide(unreachable)))
    expect(Exit.isFailure(offline) && Cause.squash(offline.cause)).toEqual(new Tokens.TokenUnavailable({ reason: "unavailable" }))
  })

  test("a host whose database can't be built fails every step for its retry policy", async () => {
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github, { database: unbuildable })
    const writeId = crypto.randomUUID()
    for (const exit of [
      await Effect.runPromiseExit(Write.steps(value).send({ writeId })),
      await Effect.runPromiseExit(Write.steps(value).giveUp({ writeId })),
    ]) expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(new Write.WriteUnavailable({}))
    const apply = await Effect.runPromiseExit(Apply.read(value)({ deliveryId: "d", repo: REPO, number: 1, event: "issues" }))
    expect(Exit.isFailure(apply) && Cause.squash(apply.cause)).toEqual(new Apply.ApplyUnavailable({}))
    const walk = await Effect.runPromiseExit(Reconcile.walk(value)({ repo: REPO, requestedAtMs: Date.now() }))
    expect(Exit.isFailure(walk) && Cause.squash(walk.cause)).toEqual(new Reconcile.ReconcileUnavailable({}))
  })

  test("no record carries a title, a body, a login or a token", async () => {
    const github = scriptedGitHub()
    const token = github.userToken(SENTINEL)
    const person = await signedIn(runtime, { login: SENTINEL, token })
    const writeId = await admit(runtime, {
      actorId: person.personId,
      sessionId: person.sessionId,
      via: "person",
      payload: issueWrite(SENTINEL, SENTINEL),
    })
    const agentId = await admit(runtime, { actorId: person.personId, sessionId: null, via: "agent", payload: issueWrite(SENTINEL, SENTINEL) })
    github.faults.push({ match: (method) => method === "POST", lost: true })
    const { services: value } = await services(runtime, github)
    const steps = Write.steps(value)
    const runs = [
      await logged(steps.send({ writeId })),
      await logged(steps.send({ writeId })),
      await logged(steps.send({ writeId: agentId })),
    ]
    const text = JSON.stringify(runs.flatMap((run) => run.logs))
    expect(text).toContain("github.write")
    expect(text).not.toContain(SENTINEL)
    expect(text).not.toContain(Redacted.value(token))
    expect(text).not.toContain("ghs_")
  })
})

describe("github/Apply", () => {
  const apply = async (value: Awaited<ReturnType<typeof services>>["services"], number: number, deliveryId = crypto.randomUUID()) =>
    runFlow(Apply.Apply, { deliveryId, repo: REPO, number, event: "issues" }, Apply.registration(value), { maxConnections: 3 })

  test("re-reads the issue a delivery names with its comments; a repeat changes nothing; a newer edit wins", async () => {
    const github = scriptedGitHub()
    github.open("Webhook issue", "Body", "sam")
    github.comment(1, "First", "maya")
    const { services: value } = await services(runtime, github)
    // The route recorded the delivery: the run measures its lag from there.
    const deliveryId = crypto.randomUUID()
    await sql(runtime, `INSERT INTO github_deliveries (delivery_id, event) VALUES ('${deliveryId}', 'issues')`)
    expect((await apply(value, 1, deliveryId)).exit).toEqual(Exit.succeed({ outcome: "applied", changed: 2 }))
    expect(await items(runtime)).toEqual([expect.objectContaining({ number: 1, title: "Webhook issue", author: "sam", comments: 1 })])
    expect(await comments(runtime)).toEqual([expect.objectContaining({ body: "First", author: "maya" })])
    expect((await apply(value, 1)).exit).toEqual(Exit.succeed({ outcome: "applied", changed: 0 }))
    github.retitle(1, "Renamed")
    expect((await apply(value, 1)).exit).toEqual(Exit.succeed({ outcome: "applied", changed: 1 }))
    expect((await items(runtime))[0]!.title).toBe("Renamed")
    expect(github.minted.map((minted) => minted.body)).toContainEqual({ repositories: ["widgets"], permissions: { issues: "read" } })
  })

  test("an issue with no description and a comment from a deleted account read as empty and nobody", async () => {
    const github = scriptedGitHub()
    github.open("No description", null, null)
    github.comment(1, "From a ghost", null)
    const { services: value } = await services(runtime, github)
    expect((await apply(value, 1)).exit).toEqual(Exit.succeed({ outcome: "applied", changed: 2 }))
    expect((await items(runtime))[0]).toMatchObject({ body: "", author: null })
    expect((await comments(runtime))[0]).toMatchObject({ body: "From a ghost", author: null })
  })

  test("an older read never overwrites a newer row", async () => {
    const github = scriptedGitHub()
    github.open("Original", "Body")
    const { services: value } = await services(runtime, github)
    await apply(value, 1)
    github.retitle(1, "Newer")
    await apply(value, 1)
    // A read GitHub answered with the old `updated_at` arrives last.
    await runtime.runPromise(
      Store.upsertIssue(REPOSITORY.id, {
        id: 1,
        node_id: "I_1",
        number: 1,
        title: "Original",
        body: "Body",
        state: "open",
        state_reason: null,
        user: null,
        comments: 0,
        created_at: "2026-10-20T12:00:01Z",
        updated_at: "2026-10-20T12:00:01Z",
        closed_at: null,
        labels: [],
      }, Date.now() + 60_000),
    )
    expect((await items(runtime))[0]!.title).toBe("Newer")
  })

  test("a deleted issue is tombstoned with its comments; a deleted comment is tombstoned", async () => {
    const github = scriptedGitHub()
    github.open("Doomed", "Body")
    const first = github.comment(1, "One")
    github.comment(1, "Two")
    const { services: value } = await services(runtime, github)
    await apply(value, 1)
    github.removeComment(first.id)
    expect((await apply(value, 1)).exit).toEqual(Exit.succeed({ outcome: "applied", changed: 2 }))
    expect((await comments(runtime)).map((comment) => [comment.body, comment.deleted])).toEqual([["One", true], ["Two", false]])
    github.remove(1)
    expect((await apply(value, 1)).exit).toEqual(Exit.succeed({ outcome: "tombstoned", changed: 1 }))
    expect((await items(runtime))[0]!.deleted).toBe(true)
    expect((await comments(runtime)).every((comment) => comment.deleted)).toBe(true)
    expect((await apply(value, 1)).exit).toEqual(Exit.succeed({ outcome: "tombstoned", changed: 0 }))
  })

  test("the App not installed reads nothing; GitHub failing once is retried", async () => {
    const github = scriptedGitHub()
    github.open("Retried", "Body")
    const { services: value } = await services(runtime, github)
    github.installed = false
    expect((await apply(value, 1)).exit).toEqual(Exit.succeed({ outcome: "not_installed", changed: 0 }))
    github.installed = true
    github.faults.push({ match: (method, path) => method === "GET" && /\/issues\/1$/.test(path), status: 502 })
    expect((await apply(value, 1)).exit).toEqual(Exit.succeed({ outcome: "applied", changed: 1 }))
  })

  test("a step that can't reach GitHub or Postgres fails for its retry policy, with GitHub's wait", async () => {
    const github = scriptedGitHub()
    github.open("Busy", "Body")
    const { services: value } = await services(runtime, github)
    const read = Apply.read(value)
    const request = { deliveryId: "d", repo: REPO, number: 1, event: "issues" }
    github.faults.push({ match: (method, path) => method === "GET" && /\/issues\/1$/.test(path), status: 429, headers: { "retry-after": "2" } })
    const limited = await Effect.runPromiseExit(read(request))
    expect(Exit.isFailure(limited) && Cause.squash(limited.cause)).toEqual(new Apply.ApplyUnavailable({ retryAfterMillis: 2_000 }))
    github.faults.push({ match: (_, path) => path.endsWith("/access_tokens"), status: 429, headers: { "retry-after": "1" } })
    const minting = await Effect.runPromiseExit(read(request))
    expect(Exit.isFailure(minting) && Cause.squash(minting.cause)).toEqual(new Apply.ApplyUnavailable({ retryAfterMillis: 1_000 }))
    github.faults.push({ match: (_, path) => path.endsWith("/access_tokens"), status: 502 })
    const mintDown = await Effect.runPromiseExit(read(request))
    expect(Exit.isFailure(mintDown) && Cause.squash(mintDown.cause)).toEqual(new Apply.ApplyUnavailable({}))
    const { services: offline } = await services(runtime, github, { database: unreachable })
    const noDatabase = await Effect.runPromiseExit(Apply.read(offline)(request))
    expect(Exit.isFailure(noDatabase) && Cause.squash(noDatabase.cause)).toEqual(new Apply.ApplyUnavailable({}))
  })
})

describe("github/Reconcile", () => {
  const reconcile = async (value: Awaited<ReturnType<typeof services>>["services"], pages?: number) => {
    const metrics = counting(Reconcile.registration(value, pages))
    const ran = await runFlow(Reconcile.Reconcile, { repo: REPO, requestedAtMs: Date.now() }, metrics.registration, {
      executionId: reconcileExecutionId(REPOSITORY.id, Date.now()) + crypto.randomUUID(),
      maxConnections: 3,
    })
    return { ...ran, count: metrics.count }
  }
  const syncRow = async () =>
    ((await sql(runtime, `SELECT complete, failure, synced_at IS NOT NULL AS synced, cursor IS NOT NULL AS cursored FROM github_sync`)) as unknown as Array<
      { complete: boolean; failure: string | null; synced: boolean; cursored: boolean }
    >)[0]

  test("walks the issues and comments into rows; the next walk counts what webhooks missed", async () => {
    const github = scriptedGitHub()
    github.open("One", "Body one")
    github.open("Two", "Body two", "sam")
    github.comment(2, "On two", "maya")
    const pull = github.open("A pull request", "Body")
    github.issues.set(pull.number, { ...pull, pull: true })
    const { services: value } = await services(runtime, github)
    const first = await reconcile(value)
    expect(first.exit).toEqual(Exit.succeed({ outcome: "complete", pages: 2, issues: 3, comments: 1, skipped: 0 }))
    expect((await items(runtime)).map((item) => [item.number, item.kind, item.title])).toEqual([
      [1, "issue", "One"],
      [2, "issue", "Two"],
      [3, "pull", "A pull request"],
    ])
    expect(await syncRow()).toEqual({ complete: true, failure: null, synced: true, cursored: true })
    expect(first.count(Metrics.reconcileChanged, { kind: "issue" })).toBe(0)
    // A delivery that never came: the next walk finds it, from the cursor.
    github.open("Missed", "Body")
    github.comment(1, "Missed too")
    const second = await reconcile(value)
    expect(second.exit).toEqual(Exit.succeed({ outcome: "complete", pages: 2, issues: 2, comments: 1, skipped: 0 }))
    expect(second.count(Metrics.reconcileChanged, { kind: "issue" })).toBe(2)
    expect(second.count(Metrics.reconcileChanged, { kind: "comment" })).toBe(1)
    expect((await items(runtime)).map((item) => item.title)).toContain("Missed")
  })

  test("records whether GitHub says the repository is private, and skips what it can't read", async () => {
    const github = scriptedGitHub()
    github.private = true
    github.open("Readable", "Body")
    const odd = github.open("Unreadable", "Body")
    odd.malformed = true
    github.comment(1, "Readable comment")
    github.comment(1, "Unreadable comment").malformed = true
    const { services: value } = await services(runtime, github)
    expect((await reconcile(value)).exit).toEqual(
      Exit.succeed({ outcome: "complete", pages: 2, issues: 1, comments: 1, skipped: 2 }),
    )
    expect(await sql(runtime, `SELECT github_id::int AS "githubId", private FROM github_repositories`)).toEqual([
      { githubId: 1_296_269, private: true },
    ])
    github.private = false
    await reconcile(value)
    expect(await sql(runtime, `SELECT private FROM github_repositories`)).toEqual([{ private: false }])
  })

  test("a walk past its page budget stops partial, never complete, and the next resumes from its cursor", async () => {
    const github = scriptedGitHub()
    github.open("One", "Body")
    github.comment(1, "Comment")
    const { services: value } = await services(runtime, github)
    expect((await reconcile(value, 1)).exit).toEqual(Exit.succeed({ outcome: "partial", pages: 1, issues: 1, comments: 0, skipped: 0 }))
    expect(await syncRow()).toMatchObject({ complete: false, cursored: true })
    expect((await reconcile(value, 1)).exit).toEqual(Exit.succeed({ outcome: "complete", pages: 1, issues: 0, comments: 1, skipped: 0 }))
    expect(await syncRow()).toMatchObject({ complete: true })
  })

  test("the App not installed, or GitHub refusing, is recorded and walks nothing more", async () => {
    const github = scriptedGitHub()
    github.open("One", "Body")
    const { services: value } = await services(runtime, github)
    github.installed = false
    expect((await reconcile(value)).exit).toEqual(Exit.succeed({ outcome: "not_installed", pages: 0, issues: 0, comments: 0, skipped: 0 }))
    expect(await syncRow()).toMatchObject({ complete: false, failure: "app_not_installed" })
    github.installed = true
    github.faults.push({ match: (method, path) => method === "GET" && path === "/repos/acme/widgets", status: 403 })
    expect((await reconcile(value)).exit).toEqual(Exit.succeed({ outcome: "refused", pages: 0, issues: 0, comments: 0, skipped: 0 }))
    expect(await syncRow()).toMatchObject({ complete: false, failure: "github_403" })
  })

  test("a walk due after the window after its read's, or asked for without a time, is superseded: no call, no sync", async () => {
    const github = scriptedGitHub()
    // Any call to GitHub would fail the walk.
    github.faults.push({ match: () => true, status: 500 })
    const { services: value } = await services(runtime, github)
    const metrics = counting(Reconcile.registration(value))
    const superseded = { outcome: "superseded", pages: 0, issues: 0, comments: 0, skipped: 0 }
    for (const request of [{ repo: REPO, requestedAtMs: Date.now() - 2 * SYNC_STALE_MS }, { repo: REPO }]) {
      const ran = await runFlow(Reconcile.Reconcile, request, metrics.registration, {
        executionId: reconcileExecutionId(REPOSITORY.id, Date.now()) + crypto.randomUUID(),
        maxConnections: 3,
      })
      expect(ran.exit).toEqual(Exit.succeed(superseded))
    }
    expect(metrics.count(Metrics.reconciles, { outcome: "superseded" })).toBe(2)
    expect(await syncRow()).toBeUndefined()
    // Within the window after its read's, it walks.
    const walking = await Effect.runPromiseExit(
      Reconcile.walk(value)({ repo: REPO, requestedAtMs: Date.now() - 2 * SYNC_STALE_MS + 60_000 }),
    )
    expect(Exit.isFailure(walking) && Cause.squash(walking.cause)).toEqual(new Reconcile.ReconcileUnavailable({}))
  })

  test("GitHub or Postgres failing fails the step for its retry policy, with GitHub's wait", async () => {
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    const walk = Reconcile.walk(value)
    github.faults.push({ match: (method, path) => method === "GET" && path === "/repos/acme/widgets", status: 429, headers: { "retry-after": "4" } })
    const limited = await Effect.runPromiseExit(walk({ repo: REPO, requestedAtMs: Date.now() }))
    expect(Exit.isFailure(limited) && Cause.squash(limited.cause)).toEqual(new Reconcile.ReconcileUnavailable({ retryAfterMillis: 4_000 }))
    github.faults.push({ match: (_, path) => path.endsWith("/access_tokens"), status: 429, headers: { "retry-after": "1" } })
    const minting = await Effect.runPromiseExit(walk({ repo: REPO, requestedAtMs: Date.now() }))
    expect(Exit.isFailure(minting) && Cause.squash(minting.cause)).toEqual(new Reconcile.ReconcileUnavailable({ retryAfterMillis: 1_000 }))
    github.faults.push({ match: (method, path) => method === "GET" && path === "/repos/acme/widgets", status: 502 })
    const down = await Effect.runPromiseExit(walk({ repo: REPO, requestedAtMs: Date.now() }))
    expect(Exit.isFailure(down) && Cause.squash(down.cause)).toEqual(new Reconcile.ReconcileUnavailable({}))
    const { services: offline } = await services(runtime, github, { database: unreachable })
    const noDatabase = await Effect.runPromiseExit(Reconcile.walk(offline)({ repo: REPO, requestedAtMs: Date.now() }))
    expect(Exit.isFailure(noDatabase) && Cause.squash(noDatabase.cause)).toEqual(new Reconcile.ReconcileUnavailable({}))
  })
})
