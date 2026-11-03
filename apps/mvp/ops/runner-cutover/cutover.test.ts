// The runner cutover (ops/runner-cutover/cutover.ts), run once before the git-credential route is turned on: it refuses
// while a Worker of another version serves or anything a release before could have decided is still in flight, and then
// nothing written before it counts until an Admin writes it again through the fenced route.
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest"
import * as TodoSession from "../../worker/flows/TodoSession.ts"
import { testFile } from "../../worker/test/harness.ts"
import * as Jobs from "../../worker/runners/Jobs.ts"
import * as Overflow from "../../worker/runners/Overflow.ts"
import * as Store from "../../worker/runners/Store.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { ENGINE_SCHEMA as ENGINE_HOST_SCHEMA } from "../../worker/ExecutionHost.ts"
import { blockers, cutover, ENGINE_SCHEMA, run, servingOneVersion } from "./cutover.ts"

const runtime = testFile("runner_cutover")
const ENGINE = `cutover_engine_${crypto.randomUUID().replaceAll("-", "")}`
const REPO = "github/acme/widgets"
const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))
const sql = <A extends object>(statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(statement)))
const by = (): Store.By => ({ actorId: "person-admin", invocationKey: crypto.randomUUID() })
const agent = { name: "coder", labels: ["linux"], profile: "coder-profile", maxHours: 4, restarts: 1 }
const task = { agent, repository: REPO, base: "0".repeat(40), system: [], prompt: "p", limits: { files: 1, bytes: 1 } }
const overflow = {
  connectionId: "c",
  profile: "p",
  argv: ["a"],
  labels: [],
  minQueuedSeconds: 0,
  capacity: 1,
  repoId: REPO,
  personId: "person-admin",
  origin: "https://smithers.example",
  token: { ciphertext: "sealed", nonce: "n", keyVersion: 1 },
  tokenSha256: "a".repeat(64),
  repoAuthorized: true,
}

beforeAll(() => sql(`CREATE SCHEMA ${ENGINE}`).then(() => sql(`CREATE TABLE ${ENGINE}.flows_runs (run_id text PRIMARY KEY, status text NOT NULL)`)))
afterAll(() => sql(`DROP SCHEMA ${ENGINE} CASCADE`))
beforeEach(async () => {
  await sql(`TRUNCATE agent_jobs, runners, runner_changes, agents, agent_changes, repo_overflow RESTART IDENTITY CASCADE`)
  await sql(`TRUNCATE ${ENGINE}.flows_runs`)
})

const settings = async () => {
  await runtime.runPromise(Store.addRunner({ repoId: REPO, name: "nyc-01", tokenSha256: "b".repeat(64), labels: [], capacity: 1, repoAuthorized: true }, by()))
  await runtime.runPromise(Store.setAgent({ repoId: REPO, agent, coding: true }, by()))
  await runtime.runPromise(Overflow.set(overflow, by()))
}

test("refuses, changing nothing, while a job or a flow that could have read the old settings is in flight", async () => {
  await settings()
  await Effect.runPromise(Jobs.make(await database()).start(task, "todo:held#g1"))
  await sql(`INSERT INTO ${ENGINE}.flows_runs VALUES ('todo:one', 'waiting-timer'), ('agents-put:two', 'running'), ('todo:done', 'completed'), ('chat:other', 'running')`)
  expect(await runtime.runPromise(blockers(ENGINE))).toEqual({ jobs: ["todo:held#g1"], runs: ["agents-put:two", "todo:one"] })
  expect(await runtime.runPromise(cutover(ENGINE))).toMatchObject({ outcome: "blocked" })
  expect(await sql(`SELECT count(*)::int AS n FROM runners WHERE repo_authorized_at IS NOT NULL`)).toEqual([{ n: 2 }])
  expect(Option.isSome(await runtime.runPromise(Store.codingAgent(REPO)))).toBe(true)
})

test("clears every runner and marks every setting, and each counts again once an Admin writes it", async () => {
  await settings()
  expect(await runtime.runPromise(cutover(ENGINE))).toEqual({ outcome: "cut", runners: 2, agents: 1, overflow: 1 })
  // A runner claims nothing; an overflow reads as off.
  expect(await sql(`SELECT count(*)::int AS n FROM runners WHERE repo_authorized_at IS NOT NULL`)).toEqual([{ n: 0 }])
  expect(await runtime.runPromise(Overflow.read(REPO))).toEqual(Option.none())
  expect(await runtime.runPromise(Store.agent(REPO, "coder"))).toEqual(Option.none())
  // A TODO fails as unavailable rather than quietly coding with something other than the agent the Admin chose.
  const step = TodoSession.agentStep(await database())
  expect(await Effect.runPromise(Effect.exit(step({ attemptId: "a", repoId: REPO })))).toMatchObject({ _tag: "Failure" })
  // Written again through the store the fenced route writes with.
  await settings()
  expect(await sql(`SELECT count(*)::int AS n FROM runners WHERE repo_authorized_at IS NOT NULL`)).toEqual([{ n: 2 }])
  expect(Option.map(await runtime.runPromise(Store.codingAgent(REPO)), (each) => each.name)).toEqual(Option.some("coder"))
  expect(Option.isSome(await runtime.runPromise(Overflow.read(REPO)))).toBe(true)
  // A second run with nothing new to clear is safe to repeat.
  expect(await sql(`SELECT count(*)::int AS n FROM agents WHERE reconfirm_at IS NOT NULL`)).toEqual([{ n: 0 }])
})

const cloudflare = (versions: ReadonlyArray<{ readonly version_id: string; readonly percentage: number }>) =>
  (async () => new Response(JSON.stringify({ result: { deployments: [{ versions }, { versions: [{ version_id: "old", percentage: 100 }] }] } }), { status: 200 })) as unknown as typeof globalThis.fetch

test("a Worker serving more than one version is refused", async () => {
  const options = { token: "cf-secret", account: "acct", workers: ["ChatApi"] }
  await expect(servingOneVersion(options, cloudflare([{ version_id: "a", percentage: 100 }]))).resolves.toEqual({ ChatApi: "a" })
  await expect(servingOneVersion(options, cloudflare([{ version_id: "a", percentage: 90 }, { version_id: "b", percentage: 10 }])))
    .rejects.toThrow(/ChatApi serves 2 versions/)
})

test("the command refuses before it touches the database when the deployment isn't the release it was told, and prints no secret", async () => {
  const lines: Array<string> = []
  const fetch = (async (input: string) =>
    input.endsWith("/version.json")
      ? new Response(JSON.stringify({ build: "aaaaaaaaaaaa" }), { status: 200 })
      : new Response(JSON.stringify({ result: { deployments: [{ versions: [{ version_id: "a", percentage: 100 }] }] } }), { status: 200 })) as unknown as typeof globalThis.fetch
  const code = await run(
    ["--release", "bbbbbbbbbbbb", "--worker", "ChatApi", "--by", "smithers-bc"],
    { APP_DOMAIN: "smithers.example", CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "acct", DATABASE_URL: "postgres://u:sekret-pass@nowhere.invalid/db" },
    { out: (line) => lines.push(line), err: (line) => lines.push(line) },
    fetch,
  )
  expect(code).toBe(1)
  expect(lines.join("\n")).toMatch(/serves aaaaaaaaaaaa, not bbbbbbbbbbbb/)
  expect(lines.join("\n")).not.toMatch(/cf-secret|sekret-pass/)
})

test("names the engine's schema, and the real command loads under node and refuses with one line", async () => {
  expect(ENGINE_SCHEMA).toBe(ENGINE_HOST_SCHEMA)
  const { execFile } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  const answer = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = execFile(process.execPath, [fileURLToPath(new URL("./cutover.ts", import.meta.url))], (_e, out, err) => done({ code: child.exitCode, out, err }))
  })
  expect(answer.code).toBe(1)
  expect(answer.out).toBe("")
  expect(answer.err.trim()).toBe("runner cutover not done: --by is required")
})
