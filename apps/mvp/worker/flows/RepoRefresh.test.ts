import { FlowRuntime } from "@smthrs/flow"
import { GitRemote } from "@smthrs/effect-code-storage"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { blobRoute, treeRoute } from "../../src/features/repo/contract.ts"
import { FlowStarter, StartUnavailable } from "../Flows.ts"
import * as MirrorRefresh from "../MirrorRefresh.ts"
import { fixture, shaOf } from "../test/codeStorage.ts"
import { build, runFlow } from "../test/flowHost.ts"
import { recorded, testFile } from "../test/harness.ts"
import { repoHarness, repositoryRow, resetRepos } from "../test/repos.ts"
import * as Refresh from "./RepoRefresh.ts"

const runtime = testFile("repo_refresh")
beforeEach(() => resetRepos(runtime))
const repo = { owner: "octocat", name: "spoon-knife" }
const id = "github/octocat/spoon-knife"
const newer = fixture({ commit: { ...fixture().commit, sha: shaOf("newer"), message: "New commit" } })
const setup = async () => {
  const h = await repoHarness(runtime)
  await h.seed(repo.owner, repo.name)
  const { database } = await runtime.runPromise(TestDatabase.Scratch)
  const services = { database, codeStorage: h.scripted.client, upstream: h.scripted.upstream }
  return { h, services, steps: Refresh.steps(services) }
}
const sql = (statement: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (db) => db.unsafe(statement)))

test("a stale mirror's missing SHA is not synced, starts one durable refresh, then serves the new tree and file", async () => {
  const { h } = await setup()
  h.scripted.publish(repo.owner, repo.name, newer)
  const tree = treeRoute(repo.owner, repo.name, newer.commit.sha)
  const file = blobRoute(repo.owner, repo.name, newer.commit.sha, "README.md")
  const first = await h.fetch(tree)
  expect([first.status, await first.json()]).toEqual([503, { code: "not_synced" }])
  expect(first.headers.get("cache-control")).toBe("no-store")
  expect(first.headers.get("retry-after")).toBe("2")
  await h.settled()
  expect((await h.fetch(tree)).status).toBe(200)
  expect(await (await h.fetch(file)).text()).toContain("# Fixture")
  expect(await repositoryRow(runtime, id)).toMatchObject({ headSha: newer.commit.sha })
  expect(h.line("repo.refresh").some((line) => line.annotations.stage === "settle" && line.annotations.outcome === "ready")).toBe(true)
  expect(recorded(h)).not.toContain(newer.commit.message)
  expect(recorded(h)).not.toContain("# Fixture")
  expect(h.scripted.calls.filter((call) => call.startsWith("pullUpstream:"))).toHaveLength(2)
  // Absence at a commit we have is still a real 404, not another import.
  expect((await h.fetch(blobRoute(repo.owner, repo.name, newer.commit.sha, "absent"))).status).toBe(404)
})

test("a missing file at an unsynced commit stays refreshable even when the execution host is down", async () => {
  const { h } = await setup()
  const unavailable = await repoHarness(runtime, {
    scripted: h.scripted,
    starter: FlowStarter.of({ start: () => Effect.fail(new StartUnavailable({ errorCode: "offline" })) }),
  })
  const response = await unavailable.fetch(blobRoute(repo.owner, repo.name, newer.commit.sha, "README.md"))
  expect([response.status, await response.json()]).toEqual([503, { code: "not_synced" }])
})

test("refresh runs through the durable engine; pulls once, and absent repositories aren't imported", async () => {
  const { h, services } = await setup()
  h.scripted.publish(repo.owner, repo.name, newer)
  const result = await runFlow(Refresh.Refresh, repo, Refresh.registration(services), { maxConnections: 3 })
  expect(result.exit._tag).toBe("Success")
  expect(await repositoryRow(runtime, id)).toMatchObject({ headSha: newer.commit.sha })
  expect(h.scripted.calls.filter((call) => call.startsWith("pullUpstream:"))).toHaveLength(2)
  const skipped = await runFlow(Refresh.Refresh, { owner: "absent", name: "repo" }, Refresh.registration(services), { maxConnections: 3 })
  expect(skipped.exit._tag).toBe("Success")
  expect(h.scripted.calls.filter((call) => call.startsWith("pullUpstream:"))).toHaveLength(2)
})

test("waiting for a sync cannot publish the old head; GitHub and Code Storage faults stay retryable", async () => {
  const { h, steps, services } = await setup()
  h.scripted.publish(repo.owner, repo.name, newer)
  const target = await Effect.runPromise(steps.inspect(repo))
  expect(target).toMatchObject({ ready: true, sha: newer.commit.sha })
  const pending = await Effect.runPromise(steps.settle(target).pipe(Effect.result))
  expect(pending._tag).toBe("Failure")
  expect(await repositoryRow(runtime, id)).toMatchObject({ headSha: fixture().commit.sha })
  h.scripted.fail("pullUpstream", h.scripted.error("pullUpstream", "sync_in_progress", 409, { retryAfterMillis: 8 }))
  expect(await Effect.runPromise(steps.pull(target).pipe(Effect.flip))).toMatchObject({ retryAfterMillis: 8 })
  await Effect.runPromise(steps.pull(target))
  h.scripted.fail("listCommits", h.scripted.error("listCommits", "unavailable", 503, { retryAfterMillis: 9 }))
  expect(await Effect.runPromise(steps.settle(target).pipe(Effect.flip))).toMatchObject({ retryAfterMillis: 9 })
  h.scripted.failGitHub("head", new GitRemote.GitRemoteError({ code: "unavailable" }))
  expect((await Effect.runPromise(steps.inspect(repo).pipe(Effect.result)))._tag).toBe("Failure")
  h.scripted.publish(repo.owner, repo.name, fixture({ branch: undefined }))
  expect((await Effect.runPromise(steps.inspect(repo).pipe(Effect.result)))._tag).toBe("Failure")
  expect((await Effect.runPromise(steps.settle(target).pipe(Effect.result)))._tag).toBe("Failure")
  // The flow rechecks GitHub when settling: an older execution can observe a newer push, never roll it back.
  h.scripted.publish(repo.owner, repo.name, newer)
  h.scripted.syncPolls = 0
  await Effect.runPromise(steps.pull(target))
  await Effect.runPromise(steps.settle(target))
  expect(await repositoryRow(runtime, id)).toMatchObject({ headSha: newer.commit.sha })
  await sql(`DELETE FROM repositories WHERE id = '${id}'`)
  expect(await Effect.runPromise(steps.settle(target))).toEqual({})
  expect(await Effect.runPromise(Refresh.steps(services).inspect(repo))).toMatchObject({ ready: false })
})

test("only verified installed repository pushes name a mirror, including deleted refs; starts deduplicate", async () => {
  const payload = { repository: { full_name: "Octo/Other" }, installation: { id: 42 }, ref: "refs/heads/main", deleted: true }
  expect(MirrorRefresh.pushRepository("push", payload)).toEqual(Option.some({ owner: "octo", name: "other" }))
  for (const [event, body] of [["issues", payload], ["push", {}], ["push", { ...payload, installation: { id: 0 } }],
    ["push", { ...payload, ref: "oops" }], ["push", { ...payload, repository: { full_name: "o/n/extra" } }],
    ["push", { ...payload, repository: { full_name: "app/no" } }], ["push", { ...payload, repository: { full_name: "" } }]] as const) {
    expect(Option.isNone(MirrorRefresh.pushRepository(event, body))).toBe(true)
  }
  const starts: Array<{ executionId: string; payload: unknown }> = []
  const starter = Layer.succeed(FlowStarter, FlowStarter.of({ start: (_, request) => Effect.sync(() => { starts.push(request) }) }))
  await Effect.runPromise(Effect.all([
    MirrorRefresh.request("Octo", "Other", "delivery"), MirrorRefresh.request("octo", "other", "delivery"),
    MirrorRefresh.request("octo", "other"), MirrorRefresh.request("octo", "other"),
  ]).pipe(Effect.provide(starter)))
  expect(starts[0]).toEqual(starts[1])
  expect(starts[2]).toEqual(starts[3])
  expect(starts[0]?.payload).toEqual({ owner: "octo", name: "other" })
})

test("settlement follows current GitHub after a newer push, rejects an empty mirror, and fences a racing publication", async () => {
  const { h, services, steps } = await setup()
  const target = await Effect.runPromise(steps.inspect(repo))
  h.scripted.publish(repo.owner, repo.name, newer)
  h.scripted.syncPolls = 0
  await Effect.runPromise(steps.pull(target))
  // An execution inspected the old HEAD, but settling verifies the current upstream instead of publishing that old snapshot.
  await Effect.runPromise(steps.settle(target))
  expect(await repositoryRow(runtime, id)).toMatchObject({ headSha: newer.commit.sha })
  const empty = Refresh.steps({ ...services, codeStorage: { ...services.codeStorage,
    listCommits: (id, options) => services.codeStorage.listCommits(id, options).pipe(Effect.map((page) => ({ ...page, commits: [] }))),
  } })
  expect((await Effect.runPromise(empty.settle(target).pipe(Effect.result)))._tag).toBe("Failure")
  h.scripted.failGitHub("head", new GitRemote.GitRemoteError({ code: "transport" }))
  expect((await Effect.runPromise(steps.settle(target).pipe(Effect.result)))._tag).toBe("Failure")
  h.scripted.fail("listCommits", h.scripted.error("listCommits", "internal_error", 500))
  expect((await Effect.runPromise(steps.settle(target).pipe(Effect.result)))._tag).toBe("Failure")
  h.scripted.fail("pullUpstream", h.scripted.error("pullUpstream", "internal_error", 500))
  expect((await Effect.runPromise(steps.pull(target).pipe(Effect.result)))._tag).toBe("Failure")
  const raceSha = shaOf("race")
  const racing = Refresh.steps({ ...services, codeStorage: { ...services.codeStorage,
    listCommits: (id, options) => services.codeStorage.listCommits(id, options).pipe(Effect.tap(() =>
      Effect.flatMap(SqlClient.SqlClient, (db) => db`UPDATE repositories SET head_sha = ${raceSha} WHERE id = ${id}`).pipe(Effect.provide(services.database), Effect.orDie),
    )),
  } })
  expect((await Effect.runPromise(racing.settle(target).pipe(Effect.result)))._tag).toBe("Failure")
  expect(await repositoryRow(runtime, id)).toMatchObject({ headSha: raceSha })
})


test("database failures cannot publish a refresh, and read classification fails closed", async () => {
  const { h, services, steps } = await setup()
  const target = await Effect.runPromise(steps.inspect(repo))
  const down = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
  const unavailable = Refresh.steps({ ...services, database: down })
  expect((await Effect.runPromise(unavailable.inspect(repo).pipe(Effect.result)))._tag).toBe("Failure")
  expect((await Effect.runPromise(unavailable.settle(target).pipe(Effect.result)))._tag).toBe("Failure")
  let opened = 0
  const flaky = Layer.unwrap(Effect.sync(() => (++opened % 2 === 1 ? services.database : down)))
  const missing = await repoHarness(runtime, { scripted: h.scripted, database: flaky })
  const response = await missing.fetch(treeRoute(repo.owner, repo.name, newer.commit.sha))
  expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
})

test("missing-commit probes distinguish unavailable, empty and absent results without caching a failure", async () => {
  const { h, services } = await setup()
  h.scripted.fail("listCommits", h.scripted.error("listCommits", "internal_error", 500))
  const failed = await h.fetch(treeRoute(repo.owner, repo.name, newer.commit.sha))
  expect([failed.status, await failed.json()]).toEqual([503, { code: "unavailable" }])
  const empty = await repoHarness(runtime, { scripted: h.scripted, codeStorage: { ...services.codeStorage,
    listCommits: () => Effect.succeed({ commits: [], nextCursor: undefined, bytesRead: 0 }),
  }, starter: FlowStarter.of({ start: () => Effect.fail(new StartUnavailable({ errorCode: "offline" })) }) })
  const pending = await empty.fetch(treeRoute(repo.owner, repo.name, newer.commit.sha))
  expect([pending.status, await pending.json()]).toEqual([503, { code: "not_synced" }])
  // A refresh launch failing must not suppress the refs we already have.
  const refs = await empty.fetch(`/api/repos/${repo.owner}/${repo.name}/refs`)
  expect(refs.status).toBe(200)
})


test("replaying a completed refresh retains its pull receipt", async () => {
  const { h, services } = await setup()
  h.scripted.syncPolls = 0
  h.scripted.publish(repo.owner, repo.name, newer)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { context } = yield* build(Refresh.registration(services), { maxConnections: 3 })
    const flows = Context.get(context, FlowRuntime.FlowRuntime)
    const executionId = crypto.randomUUID()
    const execute = flows.execute(Refresh.Refresh, { executionId, payload: repo }).pipe(Effect.provide(context))
    expect(yield* execute).toEqual({})
    expect(yield* execute).toEqual({})
  })))
  expect(h.scripted.calls.filter((call) => call.startsWith("pullUpstream:"))).toHaveLength(2)
})


test("an unimported repository is genuinely absent, and a lost refs listing remains a typed refusal", async () => {
  const { h } = await setup()
  const absent = await h.fetch(treeRoute("absent", "repo", newer.commit.sha))
  expect([absent.status, await absent.json()]).toEqual([404, { code: "not_found" }])
  h.scripted.fail("listBranches", h.scripted.error("listBranches", "repository_not_found", 404))
  const missing = await h.fetch(`/api/repos/${repo.owner}/${repo.name}/refs`)
  expect([missing.status, await missing.json()]).toEqual([404, { code: "not_found" }])
})
