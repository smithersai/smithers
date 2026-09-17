import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { initialSetup, setupCandidate, type SetupHostInput } from "@smthrs/rpc/RepositorySetup"
import { memoryStorage, storageLayer } from "./DurableStorage"
import { repositorySetupStorageRequest, setupStorageMutexLayer, setupPointerKey, SETUP_QUEUE_KEY, type SetupRecord } from "./repositorySetupStore"

const input = (id: string): SetupHostInput => {
  const setup = initialSetup("org/repo", "issues", "alice")
  return { requestId: id, repo: setup.repo, job: setup.job, revision: 1, digest: setupCandidate(setup), draft: setup.draft, operation: "apply" }
}
const record = (id: string): SetupRecord => ({ version: 0, input: input(id), receipt: {
  requestId: id, operation: "apply", revision: 1, digest: input(id).digest, phase: "queued", updatedAt: 1, results: [], evidence: []
} })
const fixture = () => {
  const storage = memoryStorage(), writes: unknown[] = [], state = { reject: false }
  const layer = Layer.mergeAll(storageLayer({ ...storage, put: async (key, value) => {
    writes.push(key)
    if (state.reject) throw Error("Storage unavailable")
    await storage.put(key, value)
  } }), setupStorageMutexLayer())
  const call = (body: unknown) => Effect.runPromise(repositorySetupStorageRequest(new Request("https://internal/repository-setup", { method: "POST", body: JSON.stringify(body) })).pipe(Effect.provide(layer)))
  const discover = () => call({ action: "discover", repo: "org/repo", job: "issues" }).then(response => response.json())
  return { storage, writes, state, call, discover }
}

test("new request, index and queue commit atomically; duplicate retry and completion cannot rewind admission", async () => {
  const t = fixture()
  t.state.reject = true
  await expect(t.call({ action: "create", login: "alice", input: input("first") })).rejects.toThrow()
  expect([...t.storage.data]).toEqual([])
  expect(Object.keys(t.writes[0] as object).sort()).toEqual([SETUP_QUEUE_KEY, setupPointerKey("org/repo", "issues"), "repository-setup:request:first"].sort())
  t.state.reject = false
  const first = await (await t.call({ action: "create", login: "alice", input: input("first") })).json() as { record: SetupRecord }
  await t.call({ action: "create", login: "alice", input: input("second") })
  await Promise.all(Array.from({ length: 8 }, () => t.call({ action: "create", login: "alice", input: input("first") })))
  const receipt = { ...first.record.receipt, runId: "run-first", phase: "completed" as const }
  await t.call({ action: "update", requestId: "first", expectedVersion: 0, record: { ...first.record, receipt, result: { requestId: "first", revision: 1, digest: receipt.digest, receipt } } })
  expect(t.storage.data.get(setupPointerKey("org/repo", "issues"))).toEqual({ sequence: 2, requestId: "second" })
  expect((await t.discover() as { record: SetupRecord }).record.input.requestId).toBe("second")
})

test("one queued legacy item is ambiguous when another unfinished observation expired", async () => {
  const t = fixture()
  t.storage.data.set("repository-setup:request:queued", record("queued"))
  t.storage.data.set("repository-setup:request:expired", { ...record("expired"), observationError: "Expired" })
  t.storage.data.set(SETUP_QUEUE_KEY, { login: "alice", requests: { queued: Date.now() + 10000 } })
  expect(await t.discover()).toEqual({ state: "unavailable", error: "More than one previous setup request is unfinished" })
  expect(t.storage.data.has(setupPointerKey("org/repo", "issues"))).toBe(false)
  expect(t.writes).toEqual([])
})

test("a complete bounded scan may seed one legacy receipt but never enqueue it", async () => {
  const t = fixture()
  t.storage.data.set("repository-setup:request:expired", { ...record("expired"), observationError: "Expired" })
  const found = await t.discover() as { state: string; record: SetupRecord }
  expect(found.state).toBe("found")
  expect(found.record.runId).toBeUndefined()
  expect(found.record.observationError).toBe("Expired")
  expect(t.storage.data.has(SETUP_QUEUE_KEY)).toBe(false)
  expect(t.writes).toEqual([setupPointerKey("org/repo", "issues")])
})

test("a corrupt row or incomplete 200-record scan cannot seed an apparently unique queue item", async () => {
  const t = fixture()
  t.storage.data.set("repository-setup:request:only", record("only"))
  t.storage.data.set("repository-setup:request:broken", {})
  expect((await t.discover() as { state: string }).state).toBe("unavailable")
  t.storage.data.delete("repository-setup:request:broken")
  for (let index = 0; index < 200; index++) t.storage.data.set(`repository-setup:request:other-${index}`, record(`other-${index}`))
  expect(await t.discover()).toEqual({ state: "unavailable", error: "Previous setup requests exceed the recovery limit" })
  expect(t.writes).toEqual([])
})

test("a dangling new pointer does not fall back to an arbitrary legacy candidate", async () => {
  const t = fixture()
  t.storage.data.set(setupPointerKey("org/repo", "issues"), { sequence: 4, requestId: "missing" })
  t.storage.data.set("repository-setup:request:old", record("old"))
  expect(await t.discover()).toEqual({ state: "unavailable", error: "The indexed setup request is unavailable" })
  expect(t.writes).toEqual([])
})

test("legacy byte limit also refuses selection and matching requires the exact immutable registration source", async () => {
  const t = fixture()
  for (let index = 0; index < 50; index++) {
    const row = record(`large-${index}`)
    row.receipt.evidence = ["x".repeat(90000)]
    t.storage.data.set(`repository-setup:request:large-${index}`, row)
  }
  expect(await t.discover()).toEqual({ state: "unavailable", error: "Previous setup requests exceed the recovery limit" })
  expect(t.writes).toEqual([])
  t.storage.data.clear()
  for (const id of ["one", "two"]) {
    const row = record(id)
    row.workspaceId = "11111111-1111-4111-8111-111111111111"
    row.receipt = { ...row.receipt, phase: "completed", runId: `run-${id}`, registrationId: "active", sourceRevision: `source-${id}` }
    row.result = { requestId: id, revision: 1, digest: row.input.digest, receipt: row.receipt }
    t.storage.data.set(`repository-setup:request:${id}`, row)
  }
  const match = { registrationId: "active", revision: 1, digest: input("two").digest, workspaceId: "11111111-1111-4111-8111-111111111111", sourceRevision: "source-two" }
  const selected = await (await t.call({ action: "discover", repo: "org/repo", job: "issues", match })).json() as { record: SetupRecord }
  expect(selected.record.input.requestId).toBe("two")
  expect(t.storage.data.has(SETUP_QUEUE_KEY)).toBe(false)
})

test("a held atomic admission cannot acknowledge or expose a partial request and duplicate admission shares its pointer", async () => {
  const storage = memoryStorage()
  let release!: () => void, writing = false
  const held = new Promise<void>(resolve => { release = resolve })
  const layer = Layer.mergeAll(storageLayer({ ...storage, put: async (key, value) => {
    if (typeof key !== "string") { writing = true; await held }
    await storage.put(key, value)
  } }), setupStorageMutexLayer())
  const call = (body: unknown) => Effect.runPromise(repositorySetupStorageRequest(new Request("https://internal/repository-setup", { method: "POST", body: JSON.stringify(body) })).pipe(Effect.provide(layer)))
  let acknowledged = false
  const first = call({ action: "create", login: "alice", input: input("held") }).then(response => { acknowledged = true; return response })
  while (!writing) await new Promise(resolve => setTimeout(resolve, 1))
  const second = call({ action: "create", login: "alice", input: input("held") })
  expect(acknowledged).toBe(false)
  expect([...storage.data]).toEqual([])
  release(); await Promise.all([first, second])
  expect(storage.data.get(setupPointerKey("org/repo", "issues"))).toEqual({ sequence: 1, requestId: "held" })
  expect([...storage.data.keys()].filter(name => name.startsWith("repository-setup:request:"))).toHaveLength(1)
})
