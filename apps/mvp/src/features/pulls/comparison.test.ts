import { Collection } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { openTab, openTestApi, TestChatApi, TEST_REPOSITORY } from "../../test/chatApi"
import { PublishStore } from "../branch/publishStore"
import { role } from "../repo/actions"
import { RepoStore } from "../repo/store"
import { PullsClient, PullsRequestFailed } from "./api"
import { readComparison } from "./comparison"
import { comparisonKey } from "./contract"
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
