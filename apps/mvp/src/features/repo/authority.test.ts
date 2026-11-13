import { Collection, Persistence } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Fiber, Metric, Option, Schema, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { SqlClient } from "effect/sql"
import { nodeDevice, openTab, openTestApi, TestChatApi, TEST_REPOSITORY } from "../../test/chatApi"
import { failRestore } from "../../test/restoreFailure"
import { read } from "../../test/otlp"
import { ChatWrites } from "../chat/writes"
import { AuthStore, SESSION } from "../auth/store"
import { RepoClient, RepoRefused } from "./api"
import { role } from "./actions"
import { replaceRole, RepoStore } from "./store"
import { repoVisibility } from "./visibility"

const closing: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of closing.splice(0).reverse()) await runtime.dispose() })
const id = `github/${TEST_REPOSITORY}`
const named = TEST_REPOSITORY.split("/") as [string, string]
const until = (check: () => void) => vi.waitFor(check, { timeout: 5_000 })
const open = async (host = nodeDevice(), existing?: TestChatApi["Service"]) => {
  const api = existing ?? await (async () => {
    const runtime = openTestApi(); closing.push(runtime)
    return runtime.runPromise(Effect.service(TestChatApi))
  })()
  const runtime = openTab(api, { host }); closing.push(runtime)
  const store = await runtime.runPromise(Effect.service(RepoStore))
  return { api, runtime, store, host }
}

test("a failed refusal restore keeps cached repository rows behind the gate while local drafts remain available", async () => {
  const device = nodeDevice()
  const first = await open(device)
  await first.runtime.runPromise(first.store.refuse(id))
  await first.runtime.dispose()
  const tab = await open(failRestore(device, "repo-refusals"), first.api)
  await until(() => expect(tab.runtime.runSync(Metric.value(Metric.withAttributes(Persistence.restoreFailures, { collection: "repo-refusals" }))).count).toBe(1))
  const cached = await tab.runtime.runPromise(Collection.local({ id: "authority-cache", schema: Schema.Struct({ id: Schema.String, repoId: Schema.String }), getKey: row => row.id,
    initialData: [{ id: "retained", repoId: id }] }).pipe(Effect.provideService(Scope.Scope, tab.store.scope)))
  const shown = await tab.runtime.runPromise(tab.store.gate(cached).pipe(Effect.provideService(Scope.Scope, tab.store.scope)))
  shown.tanstack.startSyncImmediate()
  expect(await tab.runtime.runPromise(cached.toArray)).toHaveLength(1)
  expect(await tab.runtime.runPromise(shown.toArray)).toEqual([])
  const writes = await tab.runtime.runPromise(Effect.service(ChatWrites))
  await tab.runtime.runPromise(writes.drafts.insert({ id: "offline", text: "still writable" }).pipe(Effect.flatMap(write => write.persisted)))
  expect(device.storedRows("chat-drafts")).toHaveLength(1)
  await tab.runtime.dispose()
  expect(read(tab.api.telemetry).log("repo.refusals.unavailable")).toHaveLength(1)
})

test.each(["signed_in", "unreachable"] as const)("a 401 keeps an authoritative denial while the session is %s", async status => {
  const tab = await open()
  const auth = await tab.runtime.runPromise(Effect.service(AuthStore))
  const client = await tab.runtime.runPromise(Effect.service(RepoClient))
  await tab.runtime.runPromise(replaceRole(tab.store, { id, role: null, own: false, readable: false }))
  await tab.runtime.runPromise(role(...named).pipe(Effect.provideService(RepoClient, { ...client, role: () => Effect.fail(new RepoRefused({ status: 401 })) })))
  await tab.runtime.runPromise(auth.session.update(SESSION, row => { row.status = status; row.unverifiable = false }))
  const held = Option.getOrThrow(await tab.runtime.runPromise(tab.store.roles.get(id)))
  const session = Option.getOrThrow(await tab.runtime.runPromise(auth.session.get(SESSION)))
  expect(held).toMatchObject({ role: null, readable: false })
  expect(repoVisibility(session, held)).toBe("refused")
})

test("a second tab's repeated refusal fences a pending grant and survives removal of the older mark", async () => {
  const host = nodeDevice()
  const a = await open(host)
  const b = await open(host, a.api)
  await a.runtime.runPromise(a.store.refusalsKnown)
  await b.runtime.runPromise(b.store.refusalsKnown)
  await a.runtime.runPromise(a.store.refuse(id))
  await until(() => expect(b.store.isRefused(id)).toBe(true))
  const before = a.store.refusalSnapshot(id)
  const requested = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  const client = await a.runtime.runPromise(Effect.service(RepoClient))
  const pending = a.runtime.runPromise(role(...named).pipe(Effect.provideService(RepoClient, { ...client,
    role: (owner, name) => client.role(owner, name).pipe(Effect.tap(() => Deferred.succeed(requested, undefined)), Effect.tap(() => Deferred.await(release))),
  })))
  try {
    await Effect.runPromise(Deferred.await(requested))
    const fence = a.store.fenceOf(id)
    await b.runtime.runPromise(b.store.refuse(id))
    await until(() => expect(a.store.fenceOf(id)).toBeGreaterThan(fence))
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await pending
    expect(a.store.isRefused(id)).toBe(true)
    expect(await a.runtime.runPromise(a.store.clearRefusal(id, before))).toBe(false)
    expect(host.storedRows("repo-refusals")).toHaveLength(2)
    // A new affirmative read sees both events and may clear them.
    await a.runtime.runPromise(role(...named))
    await until(() => expect(a.store.isRefused(id)).toBe(false))
    expect(Option.getOrThrow(await a.runtime.runPromise(a.store.roles.get(id))).role).not.toBeNull()
    await until(() => expect(host.storedRows("repo-refusals")).toHaveLength(0))
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await pending
  }
})


test.each([401, 503])("a %s cannot reopen a denial left after another tab cleared the persisted marks", async status => {
  const tab = await open()
  const client = await tab.runtime.runPromise(Effect.service(RepoClient))
  await tab.runtime.runPromise(tab.store.refusalsKnown)
  // A remote clear removes the stored event, not this tab's previous authoritative role answer.
  await tab.runtime.runPromise(replaceRole(tab.store, { id, role: null, own: false, refused: "forbidden" }))
  expect(tab.store.isRefused(id)).toBe(false)
  await tab.runtime.runPromise(role(...named).pipe(Effect.provideService(RepoClient, { ...client, role: () => Effect.fail(new RepoRefused({ status })) })))
  expect(Option.getOrThrow(await tab.runtime.runPromise(tab.store.roles.get(id))).refused).toBe("forbidden")
})

test.each(["rollback", "timeout", "interruption"] as const)("a refusal remains protected through persistence %s and a later failed role check", async mode => {
  const device = nodeDevice()
  let fail = false
  let entered = false
  const release = Promise.withResolvers<void>()
  const host = { ...device, persistence: { ...device.persistence, open: async () => {
    const database = await device.persistence.open()
    return { ...database, execute: <T>(sql: string, params?: ReadonlyArray<unknown>): Promise<ReadonlyArray<T>> =>
      fail && /^\s*(insert|update|delete|replace)\b/i.test(sql)
        ? (entered = true, (mode === "rollback" ? Promise.resolve() : release.promise).then(() => Promise.reject(new Error("disk full"))))
        : database.execute<T>(sql, params) }
  } } }
  const tab = await open(host)
  await tab.runtime.runPromise(tab.store.refusalsKnown)
  const client = await tab.runtime.runPromise(Effect.service(RepoClient))
  fail = true
  const refusing = tab.runtime.runFork(tab.store.refuse(id))
  try {
    await until(() => expect(entered).toBe(true))
    if (mode === "interruption") await Effect.runPromise(Fiber.interrupt(refusing))
    else await Effect.runPromise(Fiber.join(refusing))
    expect(tab.store.isRefused(id)).toBe(true)
  } finally { release.resolve() }
  await until(() => expect(tab.runtime.runSync(Metric.value(Metric.withAttributes(Persistence.writeFailures, { collection: "repo-refusals", operation: "insert" }))).count).toBe(1))
  expect(tab.store.isRefused(id)).toBe(true)
  expect(tab.store.refusalSnapshot(id)).toHaveLength(1)
  expect(device.storedRows("repo-refusals")).toHaveLength(0)
  await tab.runtime.runPromise(role(...named).pipe(Effect.provideService(RepoClient, { ...client, role: () => Effect.fail(new RepoRefused({ status: 503 })) })))
  expect(tab.store.isRefused(id)).toBe(true)
  expect(Option.getOrThrow(await tab.runtime.runPromise(tab.store.roles.get(id))).refused).toBe("forbidden")
  fail = false
  await tab.runtime.runPromise(role(...named))
  expect(tab.store.isRefused(id)).toBe(false)
  expect(tab.store.refusalSnapshot(id)).toEqual([])
  await tab.runtime.dispose()
  expect(read(tab.api.telemetry).log("repo.refusal.unstored")).toEqual([expect.objectContaining({
    attributes: mode === "interruption" ? { feature: "repo", reason: "interrupted" } : { feature: "repo" },
  })])
})

test("a failed repository cache wipe is exported without its repository or error payload", async () => {
  const tab = await open()
  await tab.runtime.runPromise(tab.store.refusalsKnown)
  let attempts = 0
  await tab.runtime.runPromise(tab.store.registerCache(["test-cache"], () => Effect.sync(() => { attempts += 1 }).pipe(
    Effect.andThen(Effect.fail(new Error("private sentinel"))))))
  await tab.runtime.runPromise(tab.store.refuse(id))
  await tab.runtime.runPromise(tab.store.wiped(id))
  await tab.runtime.dispose()
  const failures = read(tab.api.telemetry).log("repo.refusal.wipe_failed")
  expect(attempts).toBeGreaterThan(0)
  expect(failures).toHaveLength(attempts)
  for (const failure of failures) expect(failure.attributes).toEqual({ feature: "repo", family: "test-cache" })
  expect(JSON.stringify(tab.api.telemetry)).not.toContain("private sentinel")
})

// Cold search's authority starts before unrelated repository and branch persistence work.
// These are the real collection adapters; the record contains collection names only, never rows or statements.
test("repository refusal restoration starts before repository metadata and branch conversations", async () => {
  const device = nodeDevice()
  const selected: string[] = []
  const host = { ...device, persistence: { ...device.persistence, make: (...args: Parameters<typeof device.persistence.make>) => {
    const normal = device.persistence.make(...args)
    return { ...normal, resolvePersistenceForCollection: (selection: Parameters<NonNullable<typeof normal.resolvePersistenceForCollection>>[0]) => {
      selected.push(selection.collectionId)
      return normal.resolvePersistenceForCollection?.(selection) ?? normal
    } }
  } } }
  const tab = await open(host)
  await tab.runtime.runPromise(tab.store.refusalsKnown)
  expect(selected).toContain("repo-refusals")
  for (const collection of ["repo-repositories", "branch-conversations"]) {
    expect(selected).toContain(collection)
    expect(selected.indexOf("repo-refusals")).toBeLessThan(selected.indexOf(collection))
  }
})


test("public repository visibility comes from the real role route and clears when its optional flag is absent", async () => {
  const tab = await open()
  const owner = "acme", name = "gadgets", repoId = "github/acme/gadgets"
  // The same metadata an About read retains when GitHub has no App installation on this public repository.
  tab.api.github.scripted.publicElsewhere.add("acme/gadgets")
  await Effect.runPromise(tab.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO repo_about (repo_id, app_absent_until) VALUES (${repoId}, now() + interval '1 hour')`)))
  await tab.runtime.runPromise(role(owner, name))
  expect(Option.getOrThrow(await tab.runtime.runPromise(tab.store.roles.get(repoId))))
    .toMatchObject({ role: null, own: false, readable: false, public: true })
  const client = await tab.runtime.runPromise(RepoClient)
  await tab.runtime.runPromise(role(owner, name).pipe(Effect.provideService(RepoClient, { ...client,
    role: (owner, name) => client.role(owner, name).pipe(Effect.map(({ public: _public, ...answer }) => answer)),
  })))
  expect(Option.getOrThrow(await tab.runtime.runPromise(tab.store.roles.get(repoId))).public).toBeUndefined()
})
