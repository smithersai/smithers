import { Collection } from "@smthrs/effect-tanstack-db"
import { Context, Deferred, Effect, Layer, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, expect, test, vi } from "vitest"
import { openTab, openTestApi, TestChatApi, TEST_REPOSITORY } from "../../test/chatApi"
import { PublishStore } from "../branch/publishStore.vibe"
import { role } from "../repo/actions.vibe"
import { RepoStore } from "../repo/store.vibe"
import { PullsClient, PullsRequestFailed } from "./api.vibe"
import { readComparison } from "./comparison.vibe"
import { comparisonKey } from "./contract"
import { PullsStore } from "./store.vibe"
import { type Compared, FilesRow } from "./schema"

const closing: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of closing.splice(0).reverse()) await runtime.dispose() })
const base = "a".repeat(40), head = "b".repeat(40)
const result = (filename: string): Compared => ({ files: [{ filename, status: "added", additions: 1, deletions: 0, patch: "+line" }], truncated: false, commits: [], commitsTruncated: false })

test.each(["success", "failure"] as const)("a late %s from a refused repository cannot populate another repository's comparison", async outcome => {
  const api = openTestApi(); closing.push(api)
  const runtime = openTab(await api.runPromise(Effect.service(TestChatApi))); closing.push(runtime)
  const repos = await runtime.runPromise(Effect.service(RepoStore))
  await runtime.runPromise(repos.refusalsKnown)
  const rows = await runtime.runPromise(Collection.local({ id: "comparison-race", schema: FilesRow, getKey: row => row.id }).pipe(Effect.provideService(Scope.Scope, repos.scope)))
  const shown = await runtime.runPromise(repos.gate(rows).pipe(Effect.provideService(Scope.Scope, repos.scope)))
  shown.tanstack.startSyncImmediate()
  await runtime.runPromise(repos.registerCache(["comparison-race"], repo => Effect.flatMap(rows.toArray, held =>
    Effect.asVoid(rows.delete(held.filter(row => row.repoId === repo).map(row => row.id))))))
  const requested = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<Compared, PullsRequestFailed>())
  const delivered = Effect.runSync(Deferred.make<void>())
  const real = await runtime.runPromise(Effect.service(PullsClient))
  const client = { ...real, compare: (owner: string) => owner === "private"
    ? Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.ensuring(Deferred.succeed(delivered, undefined)))
    : Effect.succeed(result("other.txt")) }
  const read = (owner: string) => runtime.runPromise(readComparison(rows, repos.scope, owner, "repo", base, head).pipe(Effect.provideService(PullsClient, client)))
  await read("private")
  await Effect.runPromise(Deferred.await(requested))
  await runtime.runPromise(repos.refuse("github/private/repo"))
  await runtime.runPromise(repos.wiped("github/private/repo"))
  await read("other")
  await vi.waitFor(() => expect(rows.tanstack.get(comparisonKey("github/other/repo", base, head))?.status).toBe("ready"))
  await Effect.runPromise(outcome === "success" ? Deferred.succeed(release, result("private.txt")) : Deferred.fail(release, new PullsRequestFailed({ status: 503 })))
  await Effect.runPromise(Deferred.await(delivered))
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(shown.tanstack.toArray.map(row => row.files.map(file => file.filename))).toEqual([["other.txt"]])
  expect(rows.tanstack.has(comparisonKey("github/private/repo", base, head))).toBe(false)
})

test("Branch Compare retries after a refused pending comparison and a new access grant", async () => {
  const api = openTestApi(); closing.push(api)
  const runtime = openTab(await api.runPromise(Effect.service(TestChatApi))); closing.push(runtime)
  const repos = await runtime.runPromise(Effect.service(RepoStore))
  const store = await runtime.runPromise(Effect.service(PublishStore))
  await runtime.runPromise(repos.refusalsKnown)
  const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]
  const repoId = `github/${TEST_REPOSITORY}`
  const key = comparisonKey(repoId, base, head)
  const requested = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<Compared>())
  const delivered = Effect.runSync(Deferred.make<void>())
  const real = await runtime.runPromise(Effect.service(PullsClient))
  const read = (compare: typeof real.compare) => runtime.runPromise(
    readComparison(store.comparisons, store.scope, owner, name, base, head).pipe(Effect.provideService(PullsClient, { ...real, compare })))
  await read(() => Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.ensuring(Deferred.succeed(delivered, undefined))))
  await Effect.runPromise(Deferred.await(requested))
  await runtime.runPromise(repos.refuse(repoId))
  await runtime.runPromise(repos.wiped(repoId))
  expect(store.comparisons.tanstack.has(key)).toBe(false)
  await Effect.runPromise(Deferred.succeed(release, result("obsolete.txt")))
  await Effect.runPromise(Deferred.await(delivered))
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(store.comparisons.tanstack.has(key)).toBe(false)
  await runtime.runPromise(role(owner, name))
  expect(repos.isRefused(repoId)).toBe(false)
  await read(() => Effect.succeed(result("fresh.txt")))
  await vi.waitFor(() => expect(store.comparisons.tanstack.get(key)).toMatchObject({ status: "ready", files: [{ filename: "fresh.txt" }] }))
})

test("without a repository store, a comparison is read once, kept, and read again only after it failed", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const scope = yield* Effect.scope
  const rows = yield* Collection.local({ id: "comparison-unfenced", schema: FilesRow, getKey: row => row.id })
  const answers: Array<Effect.Effect<Compared, PullsRequestFailed>> = [Effect.fail(new PullsRequestFailed({})), Effect.succeed(result("kept.txt"))]
  const asked: Array<string> = []
  const told: Array<[string, string]> = []
  const client = PullsClient.of({
    merge: () => Effect.fail(new PullsRequestFailed({})),
    review: () => Effect.fail(new PullsRequestFailed({})),
    compare: (owner, name, from, to) => Effect.suspend(() => {
      asked.push(`${owner}/${name}@${from}...${to}`)
      return answers.shift() ?? Effect.fail(new PullsRequestFailed({ status: 500 }))
    }),
  })
  const key = comparisonKey("github/acme/widgets", base, head)
  const read = (from: string) => readComparison(rows, scope, "Acme", "Widgets", from, head, (repository, id) => { told.push([repository, id]) })
    .pipe(Effect.provideService(PullsClient, client))
  const settled = (status: string) => Effect.promise(() => vi.waitFor(() => expect(rows.tanstack.get(key)?.status).toBe(status)))
  yield* read("main")
  expect(asked).toEqual([])
  yield* read(base)
  yield* settled("failed")
  yield* read(base)
  yield* settled("ready")
  yield* read(base)
  expect(asked).toEqual([`Acme/Widgets@${base}...${head}`, `Acme/Widgets@${base}...${head}`])
  expect(told).toEqual([["github/acme/widgets", key], ["github/acme/widgets", key], ["github/acme/widgets", key]])
  expect(rows.tanstack.get(key)).toMatchObject({ repoId: "github/acme/widgets", status: "ready", files: [{ filename: "kept.txt" }] })
}))))

test("an answer for a comparison row another read replaced writes nothing back", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const scope = yield* Effect.scope
  const rows = yield* Collection.local({ id: "comparison-replaced", schema: FilesRow, getKey: row => row.id })
  const first = yield* Deferred.make<Compared, PullsRequestFailed>()
  const answers: Array<Effect.Effect<Compared, PullsRequestFailed>> = [Deferred.await(first), Effect.succeed(result("second.txt"))]
  const client = PullsClient.of({
    merge: () => Effect.fail(new PullsRequestFailed({})),
    review: () => Effect.fail(new PullsRequestFailed({})),
    compare: () => Effect.suspend(() => answers.shift() ?? Effect.fail(new PullsRequestFailed({ status: 500 }))),
  })
  const key = comparisonKey("github/acme/widgets", base, head)
  const read = readComparison(rows, scope, "acme", "widgets", base, head).pipe(Effect.provideService(PullsClient, client))
  yield* read
  yield* rows.delete(key)
  yield* read
  yield* Effect.promise(() => vi.waitFor(() => expect(rows.tanstack.get(key)?.status).toBe("ready")))
  yield* Deferred.succeed(first, result("first.txt"))
  yield* Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)))
  expect(rows.tanstack.get(key)).toMatchObject({ status: "ready", files: [{ filename: "second.txt" }] })
}))))

test("a repository already refused reads no comparison", async () => {
  const api = openTestApi(); closing.push(api)
  const runtime = openTab(await api.runPromise(Effect.service(TestChatApi))); closing.push(runtime)
  const repos = await runtime.runPromise(Effect.service(RepoStore))
  await runtime.runPromise(repos.refusalsKnown)
  await runtime.runPromise(repos.refuse("github/private/repo"))
  const rows = await runtime.runPromise(Collection.local({ id: "comparison-refused", schema: FilesRow, getKey: row => row.id }).pipe(Effect.provideService(Scope.Scope, repos.scope)))
  const asked: Array<string> = []
  const told: Array<string> = []
  const real = await runtime.runPromise(Effect.service(PullsClient))
  const client = { ...real, compare: (owner: string) => Effect.sync(() => { asked.push(owner) }).pipe(Effect.as(result("refused.txt"))) }
  await runtime.runPromise(readComparison(rows, repos.scope, "private", "repo", base, head, (_, id) => { told.push(id) })
    .pipe(Effect.provideService(PullsClient, client)))
  expect(asked).toEqual([])
  expect(told).toEqual([])
  expect(rows.tanstack.has(comparisonKey("github/private/repo", base, head))).toBe(false)
})

test("a repository's refusal drops the comparisons the pull requests' store read of it, and only those", async () => {
  const api = openTestApi(); closing.push(api)
  const chatApi = await api.runPromise(Effect.service(TestChatApi))
  const runtime = openTab(chatApi); closing.push(runtime)
  await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const repos = yield* RepoStore
    yield* repos.refusalsKnown
    const store = Context.get(yield* Layer.build(PullsStore.layer({ origin: chatApi.origin }).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, chatApi.fetch)),
    )), PullsStore)
    const real = yield* PullsClient
    const client = { ...real, compare: (owner: string) => Effect.succeed(result(`${owner}.txt`)) }
    const read = (owner: string) => readComparison(store.files, store.scope, owner, "repo", base, head, store.compared)
      .pipe(Effect.provideService(PullsClient, client))
    const refused = comparisonKey("github/private/repo", base, head)
    const kept = comparisonKey("github/other/repo", base, head)
    yield* read("private")
    yield* read("other")
    yield* Effect.promise(() => vi.waitFor(() =>
      expect([refused, kept].map(key => store.files.tanstack.get(key)?.status)).toEqual(["ready", "ready"])))
    yield* repos.refuse("github/private/repo")
    yield* repos.wiped("github/private/repo")
    expect(store.files.tanstack.has(refused)).toBe(false)
    expect(store.files.tanstack.get(kept)).toMatchObject({ status: "ready", files: [{ filename: "other.txt" }] })
  })))
})
