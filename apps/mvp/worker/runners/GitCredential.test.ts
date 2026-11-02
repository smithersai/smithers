// A runner's read credential for a private repository (decision 0148): the route that hands it out for a job the
// runner holds, and the App's token behind it, against the compose Postgres on this file's own schema and the scripted
// GitHub. The credential must read only the runner's repository, only its contents, end before GitHub's hour, and never
// reach a log.
import { AgentRunner } from "@smthrs/agent"
import { digestSync } from "@smthrs/crypto"
import { Effect, Logger, Option, Redacted } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
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

/** Records the App's installation on `repoId`, as installation discovery does (worker/github/Store.ts). */
const recordInstallation = (repoId = REPO) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO github_repositories (repo_id, installation_id) VALUES (${repoId}, 42)
    ON CONFLICT (repo_id) DO UPDATE SET installation_id = 42`))

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
  await recordInstallation(repoId)
  await query(Store.addRunner({ repoId, name, tokenSha256: digestSync(token), labels: ["linux"], capacity: 2, repoAuthorized: true }, {
    actorId: "person-admin",
    invocationKey: crypto.randomUUID(),
  }))
  return token
}

/**
 * What a test's minter does: hand out `credential`, none, fail (with GitHub's wait in `retryAfterMillis`), or run
 * `during` first (another request racing it). `calls`, when set, decides each call in turn by its number from 0.
 */
interface Minter {
  readonly credential?: RunnersApi.GitCredential | null
  readonly fails?: boolean | { readonly retryAfterMillis: number }
  readonly during?: () => Promise<void>
  readonly calls?: (call: number) => Minter
  /** Runs while the route revokes a credential: another request racing the revoke. */
  readonly onRevoke?: () => Promise<void>
}

/**
 * The runner routes with `minter` (none: no `gitCredential`), recording each log line, every repository a credential
 * was minted for, and every credential revoked.
 */
const routes = async (minter?: Minter) => {
  const asked: Array<string> = []
  const revoked: Array<string> = []
  const lines: Array<string> = []
  const logger = Logger.make((options) => void lines.push(JSON.stringify(Logger.formatStructured.log(options))))
  const handler = HttpEffect.toWebHandler(
    RunnersApi.make(await database(), {
      pollMillis: 50,
      runOf: TodoSession.runOf,
      ...(minter === undefined ? {} : {
        gitCredential: {
          mint: (repoId: string) => Effect.gen(function* () {
            const call = minter.calls === undefined ? minter : minter.calls(asked.length)
            asked.push(repoId)
            if (call.during !== undefined) yield* Effect.promise(call.during)
            if (call.fails === true) return yield* Effect.fail(new Error("GitHub unavailable"))
            if (typeof call.fails === "object") return yield* Effect.fail({ reason: "unavailable", ...call.fails })
            return Option.fromNullishOr(call.credential ?? null)
          }),
          revoke: (each: RunnersApi.GitCredential) =>
            Effect.promise(async () => {
              revoked.push(Redacted.value(each.password))
              await minter.onRevoke?.()
            }),
        },
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
  return { call, asked, revoked, lines }
}

const credential: RunnersApi.GitCredential = {
  remote: "https://github.com/acme/widgets.git",
  username: "x-access-token",
  password: Redacted.make(SECRET),
  expiresAt: 1_800_000_000_000,
}

const claimed = async (call: Awaited<ReturnType<typeof routes>>["call"], token: string) =>
  (await call<{ readonly job: AgentRunner.Job }>("claim", token, { profiles: ["coder-profile"], free: 1, running: [], waitSeconds: 0 })).body.job

const exec = (statement: string) => query(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)))

/** A runner `name` holding a job of its repository, and the routes over `minter`. */
const holding = async (minter: Minter = { credential }, name = "nyc-01") => {
  const token = await register(name)
  await Effect.runPromise(Jobs.make(await database()).start(taskOf(), `todo:${name}#g1`))
  const api = await routes(minter)
  const job = await claimed(api.call, token)
  const ask = (as = token, body: unknown = { key: job.key, claim: job.claim }) => api.call("gitCredential", as, body)
  return { ...api, token, job, ask }
}

describe("a runner's git credential", () => {
  test("is handed out for a job the runner holds, for its own repository, never cached and never logged", async () => {
    const { ask, asked, lines } = await holding()
    const answer = await ask()
    expect(answer.status).toBe(200)
    expect(answer.headers.get("cache-control")).toBe("no-store")
    expect(answer.body).toEqual({ remote: credential.remote, username: "x-access-token", password: SECRET, expiresAt: credential.expiresAt })
    expect(asked).toEqual([REPO])
    const logged = lines.join("\n")
    expect(logged).toContain('"outcome":"issued"')
    expect(logged).not.toContain(SECRET)
  })

  test("is refused without a token, for another claim, a malformed one, or a task naming another repository", async () => {
    const { ask, asked, job, call } = await holding()
    expect((await call("gitCredential", undefined, { key: job.key, claim: job.claim })).status).toBe(401)
    expect(await ask(undefined, { key: job.key, claim: crypto.randomUUID() })).toMatchObject({ status: 409, body: { code: "not_held" } })
    expect(await ask(undefined, { key: job.key, claim: "not-a-uuid" })).toMatchObject({ status: 409, body: { code: "not_held" } })
    expect((await ask(undefined, { key: job.key })).status).toBe(400)
    await exec(`UPDATE agent_jobs SET task = '{}'::jsonb`)
    expect(await ask()).toMatchObject({ status: 403, body: { code: "other_repository" } })
    await exec(`UPDATE agent_jobs SET task = '${JSON.stringify(taskOf("github/acme/secret"))}'::jsonb`)
    expect(await ask()).toMatchObject({ status: 403, body: { code: "other_repository" } })
    expect(asked).toEqual([])
  })

  test("another runner of the same repository is refused the job's credential with its valid key and claim", async () => {
    const { ask, asked } = await holding()
    const other = await register("nyc-02")
    expect(await ask(other)).toMatchObject({ status: 409, body: { code: "not_held" } })
    expect(asked).toEqual([])
  })

  test("is refused once the deadline passed, the job settled, or the runner was retired", async () => {
    const outcome = { _tag: "Done", changes: { additions: [], deletions: [] }, summary: "done", usage: {} }
    const ends: Array<(held: Awaited<ReturnType<typeof holding>>) => Promise<unknown>> = [
      () => exec(`UPDATE agent_jobs SET deadline_at = now() - interval '1 second'`),
      ({ call, token, job }) => call("settle", token, { key: job.key, claim: job.claim, outcome }),
      () => exec(`UPDATE runners SET removed_at = now()`),
    ]
    for (const end of ends) {
      await exec(`TRUNCATE agent_jobs, runners, runner_changes RESTART IDENTITY CASCADE`)
      const held = await holding()
      await end(held)
      expect((await held.ask()).status).toBeOneOf([401, 409])
      expect(held.asked).toEqual([])
    }
  })

  // Production b9dca623: a deployment Admin could register a runner on a repository where Smithers had recorded no
  // installation, by the deployment's role. Such a runner, and any registered before registration proved access, gets
  // no credential; nor does any runner of a repository whose installation isn't recorded, since minting would record it.
  test("a runner registered before registration proved access, or on a repository without a recorded installation, gets none", async () => {
    const legacy = await holding()
    await exec(`UPDATE runners SET repo_authorized_at = NULL`)
    expect(await legacy.ask()).toMatchObject({ status: 403, body: { code: "not_authorized" } })
    await exec(`UPDATE runners SET repo_authorized_at = now()`)
    await exec(`UPDATE github_repositories SET installation_id = NULL`)
    expect(await legacy.ask()).toMatchObject({ status: 404, body: { code: "app_not_installed" } })
    expect(legacy.asked).toEqual([])
  })

  test("one job's runner is handed one at most every 30 seconds and 3 an hour; at once, only one request mints", async () => {
    const { ask, asked } = await holding()
    const together = await Promise.all(Array.from({ length: 5 }, () => ask()))
    expect(together.map((answer) => answer.status).sort()).toEqual([200, 429, 429, 429, 429])
    expect(asked).toHaveLength(1)
    const busy = together.find((answer) => answer.status === 429)!
    expect(busy.body).toEqual({ code: "busy" })
    expect(Number(busy.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(Number(busy.headers.get("retry-after"))).toBeLessThanOrEqual(RunnersApi.CREDENTIAL_GAP_SECONDS)
    // Past the gap, twice more; then the hour's cap, with its wait.
    for (let n = 0; n < 2; n++) {
      await exec(`UPDATE agent_jobs SET git_credential_at = now() - interval '31 seconds'`)
      expect((await ask()).status).toBe(200)
    }
    await exec(`UPDATE agent_jobs SET git_credential_at = now() - interval '31 seconds'`)
    const capped = await ask()
    expect(capped.status).toBe(429)
    expect(Number(capped.headers.get("retry-after"))).toBeGreaterThan(3000)
    expect(asked).toHaveLength(RunnersApi.CREDENTIALS_PER_HOUR)
    // An hour on, the job's runner may have another.
    await exec(`UPDATE agent_jobs SET git_credentials_since = now() - interval '61 minutes'`)
    expect((await ask()).status).toBe(200)
  })

  // Astra's review of 5fc33348: a failed mint gave its reservation back, so a failing GitHub was asked again at once.
  test("a failed mint answers 503 with its wait, spends nothing of the hour, and keeps the job's cooldown", async () => {
    const { ask, asked } = await holding({ fails: true })
    const failed = await ask()
    expect(failed).toMatchObject({ status: 503, body: { code: "unavailable" } })
    expect(Number(failed.headers.get("retry-after"))).toBe(RunnersApi.CREDENTIAL_GAP_SECONDS)
    const again = await ask()
    expect(again).toMatchObject({ status: 429, body: { code: "busy" } })
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(asked).toHaveLength(1)
    // Past the wait, GitHub is asked again; the hour's allowance is untouched by failures.
    for (let n = 0; n < RunnersApi.CREDENTIALS_PER_HOUR + 1; n++) {
      await exec(`UPDATE agent_jobs SET git_credential_at = now() - interval '31 seconds', git_credential_retry_at = now()`)
      expect((await ask()).status).toBe(503)
    }
    expect(asked).toHaveLength(RunnersApi.CREDENTIALS_PER_HOUR + 2)
    expect(await query(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT git_credentials AS n FROM agent_jobs`)))
      .toEqual([{ n: 0 }])
  })

  test("a mint GitHub asked to wait for keeps GitHub's wait, past the gap", async () => {
    const { ask, asked } = await holding({ fails: { retryAfterMillis: 120_000 } })
    const failed = await ask()
    expect(failed.status).toBe(503)
    expect(Number(failed.headers.get("retry-after"))).toBe(120)
    await exec(`UPDATE agent_jobs SET git_credential_at = now() - interval '31 seconds'`)
    const busy = await ask()
    expect(busy.status).toBe(429)
    expect(Number(busy.headers.get("retry-after"))).toBeGreaterThan(RunnersApi.CREDENTIAL_GAP_SECONDS)
    expect(asked).toHaveLength(1)
  })

  // Astra's review of 5fc33348: request A reserved and stalled; past the gap B reserved and was issued one; A then failed
  // and put back the counters from before A, erasing B, so another could mint at once.
  test("a mint held across the cooldown, while another succeeds, finalizes or releases only its own reservation", async () => {
    for (const late of ["fails", "issued"] as const) {
      await exec(`TRUNCATE agent_jobs, runners, runner_changes RESTART IDENTITY CASCADE`)
      let finish = () => {}
      const stalled = new Promise<void>((done) => (finish = done))
      let started = () => {}
      const minting = new Promise<void>((done) => (started = done))
      const { ask, asked, revoked } = await holding({
        calls: (call) =>
          call === 0
            ? { during: () => (started(), stalled), ...(late === "fails" ? { fails: true } : { credential }) }
            : { credential },
      })
      const a = ask()
      await minting
      // While A mints, another request waits its turn: the gap, then A's reservation until it goes stale.
      expect((await ask()).status).toBe(429)
      await exec(`UPDATE agent_jobs SET git_credential_at = now() - interval '45 seconds',
        git_credential_reserved_at = now() - interval '45 seconds'`)
      const inFlight = await ask()
      expect(inFlight.status).toBe(429)
      expect(Number(inFlight.headers.get("retry-after"))).toBeLessThanOrEqual(RunnersApi.RESERVATION_SECONDS - 44)
      // A stalls past its reservation: B takes it over and is issued one.
      await exec(`UPDATE agent_jobs SET git_credential_at = now() - interval '61 seconds',
        git_credential_reserved_at = now() - interval '61 seconds'`)
      expect((await ask()).status).toBe(200)
      finish()
      const answer = await a
      if (late === "fails") expect(answer.status).toBe(503)
      else {
        // A's late credential is revoked, never delivered; the job is still held, so A waits its turn.
        expect(answer).toMatchObject({ status: 429, body: { code: "busy" } })
        expect(revoked).toEqual([SECRET])
      }
      expect(asked).toHaveLength(2)
      // B's issuance stands: counted once, its cooldown kept.
      expect(await query(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        SELECT git_credentials AS n, git_credential_reservation IS NULL AS free,
          git_credential_at > now() - interval '10 seconds' AS recent FROM agent_jobs`)))
        .toEqual([{ n: 1, free: true, recent: true }])
      expect((await ask()).status).toBe(429)
      expect(asked).toHaveLength(2)
    }
  })

  // Astra's review of f42f8b6b: the issuance's statement locked no runner row, so authorization cleared while it
  // waited went unseen and the credential was delivered.
  test("authorization cleared while the issuance waits on it gets no credential, and the minted one is revoked", async () => {
    let commit = () => {}
    const committed = new Promise<void>((done) => (commit = done))
    let revoker: Promise<unknown> = Promise.resolve()
    const during = async () => {
      let held = () => {}
      const holding = new Promise<void>((done) => (held = done))
      revoker = query(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(Effect.gen(function* () {
          yield* sql`UPDATE runners SET repo_authorized_at = NULL`
          yield* Effect.sync(held)
          yield* Effect.promise(() => committed)
        }))))
      await holding
      setTimeout(commit, 500)
    }
    const { ask, revoked } = await holding({ credential, during })
    const answer = await ask()
    await revoker
    // The job is still held: refused for want of authorization, never `not_held`, so the runner waits to be registered
    // again rather than failing its workspace.
    expect(answer).toMatchObject({ status: 403, body: { code: "not_authorized" } })
    expect(await query(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT status FROM agent_jobs`))).toEqual([{ status: "claimed" }])
    expect(revoked).toEqual([SECRET])
    expect(JSON.stringify(answer.body)).not.toContain(SECRET)
  })

  // Astra's review of 99f0dc17: the reservation ignored that the runner was no longer current, so a token rotated or a
  // runner retired while the request waited answered `not_held`, which the runner takes for a lost job.
  test("a token rotated, or a runner retired, while the reservation waits on it is refused 403, the job still held", async () => {
    for (const revoke of [`UPDATE runners SET token_sha256 = '${"f".repeat(64)}'`, `UPDATE runners SET removed_at = now()`]) {
      await exec(`TRUNCATE agent_jobs, runners, runner_changes RESTART IDENTITY CASCADE`)
      const { ask, asked } = await holding()
      let commit = () => {}
      const committed = new Promise<void>((done) => (commit = done))
      let held = () => {}
      const holdingRow = new Promise<void>((done) => (held = done))
      const revoker = query(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(Effect.gen(function* () {
          yield* sql.unsafe(revoke)
          yield* Effect.sync(held)
          yield* Effect.promise(() => committed)
        }))))
      await holdingRow
      const asking = ask()
      await new Promise((done) => setTimeout(done, 500))
      commit()
      await revoker
      expect(await asking).toMatchObject({ status: 403, body: { code: "not_authorized" } })
      expect(asked).toEqual([])
      expect(await query(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT status FROM agent_jobs`))).toEqual([{ status: "claimed" }])
    }
  })

  // Astra's review of 40f86793: after a takeover, authorization cleared while the late credential was revoked fell to
  // an unlocked read, which answered `not_held` for a job still held.
  test("a late credential revoked after a takeover, while authorization is cleared, answers 403, the job still held", async () => {
    let finish = () => {}
    const stalled = new Promise<void>((done) => (finish = done))
    let started = () => {}
    const minting = new Promise<void>((done) => (started = done))
    const { ask, revoked } = await holding({
      calls: (call) => call === 0 ? { during: () => (started(), stalled), credential } : { credential },
      onRevoke: () => exec(`UPDATE runners SET repo_authorized_at = NULL`).then(() => {}),
    })
    const a = ask()
    await minting
    await exec(`UPDATE agent_jobs SET git_credential_at = now() - interval '61 seconds',
      git_credential_reserved_at = now() - interval '61 seconds'`)
    expect((await ask()).status).toBe(200)
    finish()
    expect(await a).toMatchObject({ status: 403, body: { code: "not_authorized" } })
    expect(revoked).toEqual([SECRET])
    expect(await query(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT status FROM agent_jobs`))).toEqual([{ status: "claimed" }])
  })

  // Astra's review of 40f86793: the issuance compared the deadline with its transaction's start, so a job lock waited on
  // across the deadline still issued a credential.
  test("a job lock held across the deadline while the issuance waits on it issues nothing, and the credential is revoked", async () => {
    let release = () => {}
    const released = new Promise<void>((done) => (release = done))
    let locker: Promise<unknown> = Promise.resolve()
    const during = async () => {
      await exec(`UPDATE agent_jobs SET deadline_at = now() + interval '1 second'`)
      let locked = () => {}
      const locking = new Promise<void>((done) => (locked = done))
      locker = query(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(Effect.gen(function* () {
          yield* sql`SELECT 1 FROM agent_jobs FOR UPDATE`
          yield* Effect.sync(locked)
          yield* Effect.promise(() => released)
        }))))
      await locking
      setTimeout(release, 1500)
    }
    const { ask, revoked } = await holding({ credential, during })
    const answer = await ask()
    await locker
    expect(answer.status).not.toBe(200)
    expect(JSON.stringify(answer.body)).not.toContain(SECRET)
    expect(revoked).toEqual([SECRET])
  })

  test("a job settled while GitHub minted gets no credential, and the minted one is revoked", async () => {
    let settle: () => Promise<void> = async () => {}
    const { ask, revoked, lines, job, call, token } = await holding({ credential, during: () => settle() })
    const outcome = { _tag: "Done", changes: { additions: [], deletions: [] }, summary: "done", usage: {} }
    settle = async () => void expect((await call("settle", token, { key: job.key, claim: job.claim, outcome })).body).toEqual({ recorded: true })
    expect(await ask()).toMatchObject({ status: 409, body: { code: "not_held" } })
    expect(revoked).toEqual([SECRET])
    expect(lines.join("\n")).not.toContain(SECRET)
  })

  test("a runner retired while GitHub minted gets no credential, and the minted one is revoked", async () => {
    const { ask, revoked } = await holding({ credential, during: () => exec(`UPDATE runners SET removed_at = now()`).then(() => {}) })
    // Retired: no longer current, which the runner's next request (401) says too.
    expect(await ask()).toMatchObject({ status: 403, body: { code: "not_authorized" } })
    expect(revoked).toEqual([SECRET])
  })

  test("answers 404 without a minter or where the App can't mint one", async () => {
    const none = await holding({ credential: null })
    expect(await none.ask()).toMatchObject({ status: 404, body: { code: "app_not_installed" } })
    const unset = await routes()
    expect(await unset.call("gitCredential", none.token, { key: none.job.key, claim: none.job.claim }))
      .toMatchObject({ status: 404, body: { code: "not_configured" } })
  })
})

describe("the App's token behind it", () => {
  test("reads one repository's contents and nothing else, and is spent 50 minutes after minting", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const mint = GitCredential.make(Option.some(app({ privateKey: await appKey() })), await database(), github.http).mint
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

  test("missing contents permission refuses a credential; a provider outage remains unavailable", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const mint = GitCredential.make(Option.some(app({ privateKey: await appKey() })), await database(), github.http).mint
    github.contentsGranted = false
    expect(await Effect.runPromise(mint(REPO))).toEqual(Option.none())
    expect(github.minted).toEqual([])
    github.contentsGranted = true
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), status: 503 })
    expect(await Effect.runPromise(Effect.result(mint(REPO)))).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
    expect(github.minted).toEqual([])
    // A later request can recover with the same persisted installation and still mints only contents: read.
    expect(Option.isSome(await Effect.runPromise(mint(REPO)))).toBe(true)
    expect(github.minted.at(-1)!.body).toEqual({ repositories: ["widgets"], permissions: { contents: "read" } })
  })

  test("the default HTTP transport refuses an invalid signing key before making a request", async () => {
    let calls = 0
    const mint = GitCredential.make(Option.some(app({ privateKey: Redacted.make("not a signing key") })), await database()).mint
    const result = await Effect.runPromise(Effect.result(mint(REPO).pipe(Effect.provideService(FetchHttpClient.Fetch, () => {
      calls++
      return Promise.reject(new Error("a bad signing key must never reach transport"))
    }))))
    expect(result).toMatchObject({ _tag: "Failure" })
    expect(calls).toBe(0)
  })

  test("revoking a credential ends it at GitHub", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const credentials = GitCredential.make(Option.some(app({ privateKey: await appKey() })), await database(), github.http)
    const minted = Option.getOrThrow(await Effect.runPromise(credentials.mint(REPO)))
    await Effect.runPromise(credentials.revoke(minted))
    expect(github.revoked).toEqual([Redacted.value(minted.password)])
    // Revoking again is refused by GitHub, and still never fails.
    await Effect.runPromise(credentials.revoke(minted))
    expect(github.revoked).toHaveLength(1)
  })

  test("is none without the App or where it isn't installed", async () => {
    expect(await Effect.runPromise(GitCredential.make(Option.none(), await database()).mint(REPO))).toEqual(Option.none())
    const github = scriptedGitHub("acme", "widgets")
    github.installed = false
    const mint = GitCredential.make(Option.some(app({ privateKey: await appKey() })), await database(), github.http).mint
    expect(await Effect.runPromise(mint(REPO))).toEqual(Option.none())
  })
})
