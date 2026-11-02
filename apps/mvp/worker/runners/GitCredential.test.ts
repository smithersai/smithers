// A runner's read credential for a private repository (decision 0148): the route that hands it out for a job the
// runner holds, and the App's token behind it, against the compose Postgres on this file's own schema and the scripted
// GitHub. The credential must read only the runner's repository, only its contents, end before GitHub's hour, and never
// reach a log.
import { AgentRunner } from "@smthrs/agent"
import { digestSync } from "@smthrs/crypto"
import { Effect, Logger, Option, Redacted } from "effect"
import { HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as TodoSession from "../flows/TodoSession.ts"
import { app } from "../github/test/harness.ts"
import { appKey, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as RunContentTest from "../test/runContent.ts"
import { testFile } from "../test/harness.ts"
import * as RunnersApi from "./Api.ts"
import * as GitCredential from "./GitCredential.ts"
import * as Jobs from "./Jobs.ts"
import * as Store from "./Store.ts"

const runtime = testFile("runner_git_credential")
const REPO = "github/acme/widgets"
const SECRET = "ghs_secret_credential_value_0001"

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`TRUNCATE agent_jobs, runners, runner_changes, github_repositories RESTART IDENTITY CASCADE`)))

const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))
const query = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => runtime.runPromise(effect)

const agent: AgentRunner.Agent = { name: "coder", labels: ["linux"], profile: "coder-profile", maxHours: 4, restarts: 1 }
const taskOf = (repository = REPO): AgentRunner.Task => ({
  agent,
  repository,
  base: "0123456789abcdef0123456789abcdef01234567",
  system: [],
  prompt: "add alpha",
  limits: { files: 2, bytes: 8 },
})

const register = async (name: string, repoId = REPO) => {
  const token = `token-${name}-${crypto.randomUUID()}`
  await query(Store.addRunner({ repoId, name, tokenSha256: digestSync(token), labels: ["linux"], capacity: 2 }, {
    actorId: "person-admin",
    invocationKey: crypto.randomUUID(),
  }))
  return token
}

/** The runner routes with `gitCredential`, recording each log line and every repository asked for. */
const routes = async (gitCredential?: RunnersApi.GitCredential | null) => {
  const asked: Array<string> = []
  const lines: Array<string> = []
  const logger = Logger.make((options) => void lines.push(JSON.stringify(Logger.formatStructured.log(options))))
  const handler = HttpEffect.toWebHandler(
    RunnersApi.make(await database(), {
      pollMillis: 50,
      runOf: TodoSession.runOf,
      ...(gitCredential === undefined ? {} : {
        gitCredential: (repoId: string) => Effect.sync(() => {
          asked.push(repoId)
          return Option.fromNullishOr(gitCredential)
        }),
      }),
    }).fetch.pipe(Effect.provide(RunContentTest.transcripts().layer), Effect.provideService(Logger.CurrentLoggers, new Set([logger]))),
  )
  const call = async <A>(route: keyof typeof AgentRunner.ROUTES, token: string | undefined, body: unknown) => {
    const response = await handler(new Request(`http://localhost${AgentRunner.ROUTES[route]}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    }))
    return { status: response.status, headers: response.headers, body: (await response.json()) as A }
  }
  return { call, asked, lines }
}

const credential: RunnersApi.GitCredential = {
  remote: "https://github.com/acme/widgets.git",
  username: "x-access-token",
  password: Redacted.make(SECRET),
  expiresAt: 1_800_000_000_000,
}

const claimed = async (call: Awaited<ReturnType<typeof routes>>["call"], token: string) =>
  (await call<{ readonly job: AgentRunner.Job }>("claim", token, { profiles: ["coder-profile"], free: 1, running: [], waitSeconds: 0 })).body.job

describe("a runner's git credential", () => {
  test("is handed out for a job the runner holds, for its own repository, never cached and never logged", async () => {
    const token = await register("nyc-01")
    const store = Jobs.make(await database())
    await Effect.runPromise(store.start(taskOf(), "todo:1#g1"))
    const { call, asked, lines } = await routes(credential)
    const job = await claimed(call, token)
    const answer = await call("gitCredential", token, { key: job.key, claim: job.claim })
    expect(answer.status).toBe(200)
    expect(answer.headers.get("cache-control")).toBe("no-store")
    expect(answer.body).toEqual({ remote: credential.remote, username: "x-access-token", password: SECRET, expiresAt: credential.expiresAt })
    expect(asked).toEqual([REPO])
    const logged = lines.join("\n")
    expect(logged).toContain("runner.gitCredential")
    expect(logged).toContain('"outcome":"issued"')
    expect(logged).not.toContain(SECRET)
  })

  test("is refused for a job the runner doesn't hold, another repository's job, no token, and where it can't be minted", async () => {
    const token = await register("nyc-01")
    const store = Jobs.make(await database())
    await Effect.runPromise(store.start(taskOf(), "todo:1#g1"))
    const { call, asked } = await routes(credential)
    const job = await claimed(call, token)
    expect((await call("gitCredential", undefined, { key: job.key, claim: job.claim })).status).toBe(401)
    expect(await call("gitCredential", token, { key: job.key, claim: crypto.randomUUID() })).toMatchObject({ status: 409, body: { code: "not_held" } })
    expect(await call("gitCredential", token, { key: job.key, claim: "not-a-uuid" })).toMatchObject({ status: 409, body: { code: "not_held" } })
    expect((await call("gitCredential", token, { key: job.key })).status).toBe(400)
    // A job of another repository, held by this runner as a row could say: never that repository's credential.
    await query(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE agent_jobs SET task = ${JSON.stringify(taskOf("github/acme/secret"))}::jsonb`))
    expect(await call("gitCredential", token, { key: job.key, claim: job.claim })).toMatchObject({ status: 403, body: { code: "other_repository" } })
    expect(asked).toEqual([])
    // Settled, the claim holds nothing.
    await query(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE agent_jobs SET task = ${JSON.stringify(taskOf())}::jsonb`))
    const outcome = { _tag: "Done", changes: { additions: [], deletions: [] }, summary: "done", usage: {} }
    expect((await call("settle", token, { key: job.key, claim: job.claim, outcome })).body).toEqual({ recorded: true })
    expect((await call("gitCredential", token, { key: job.key, claim: job.claim })).status).toBe(409)
  })

  test("answers 404 without a minter or where the App can't mint one", async () => {
    const token = await register("nyc-01")
    const store = Jobs.make(await database())
    await Effect.runPromise(store.start(taskOf(), "todo:1#g1"))
    const none = await routes(null)
    const job = await claimed(none.call, token)
    expect(await none.call("gitCredential", token, { key: job.key, claim: job.claim })).toMatchObject({ status: 404, body: { code: "app_not_installed" } })
    const unset = await routes()
    expect(await unset.call("gitCredential", token, { key: job.key, claim: job.claim })).toMatchObject({ status: 404, body: { code: "not_configured" } })
  })
})

describe("the App's token behind it", () => {
  test("reads one repository's contents and nothing else, and is spent 50 minutes after minting", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const mint = GitCredential.make(Option.some(app({ privateKey: await appKey() })), await database(), github.http)
    const before = Date.now()
    const minted = await Effect.runPromise(mint(REPO))
    expect(Option.isSome(minted)).toBe(true)
    const value = Option.getOrThrow(minted)
    expect(value.remote).toBe("https://github.com/acme/widgets.git")
    expect(value.username).toBe("x-access-token")
    expect(Redacted.value(value.password)).toBe(github.minted.at(-1)!.token)
    expect(github.minted.at(-1)!.body).toEqual({ repositories: ["widgets"], permissions: { contents: "read" } })
    expect(value.expiresAt).toBeGreaterThanOrEqual(before + GitCredential.CREDENTIAL_LIFETIME_MS)
    expect(value.expiresAt).toBeLessThan(before + 60 * 60 * 1000)
    expect(String(value.password)).not.toContain(Redacted.value(value.password))
  })

  test("is none without the App or where it isn't installed", async () => {
    expect(await Effect.runPromise(GitCredential.make(Option.none(), await database())(REPO))).toEqual(Option.none())
    const github = scriptedGitHub("acme", "widgets")
    github.installed = false
    const mint = GitCredential.make(Option.some(app({ privateKey: await appKey() })), await database(), github.http)
    expect(await Effect.runPromise(mint(REPO))).toEqual(Option.none())
  })
})
