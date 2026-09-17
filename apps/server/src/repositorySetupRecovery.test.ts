import { afterEach, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { initialSetup, REPOSITORY_JOBS, setupCandidate, type RepositoryJob, type SetupDraft, type SetupHostInput, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import { memoryStorage, storageLayer } from "./DurableStorage"
import { repositorySetupStorageRequest, setupStorageMutexLayer, setupPointerKey, SETUP_QUEUE_KEY, type SetupRecord } from "./repositorySetupStore"
import worker from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

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

// The digest the pre-stack code at 1f7d9b40bcc5 wrote. A record stored or a
// registration written then carries no choreEvent key at all.
const digestBeforeChoreEvents = "84dee667d8f6ec0cb4cf4357043a8966fa6aa15f51dbdf1a77863c4a9cfb4e26"
const withoutChoreEvent = () => {
  const { choreEvent: _absent, ...draft } = initialSetup("org/repo", "issues", "alice").draft
  return draft
}

test("a setup record stored before the chore event existed is still the indexed request", async () => {
  const t = fixture()
  const stored = record("pre-stack")
  t.storage.data.set("repository-setup:request:pre-stack", { ...stored,
    input: { ...stored.input, digest: digestBeforeChoreEvents, draft: withoutChoreEvent() },
    receipt: { ...stored.receipt, digest: digestBeforeChoreEvents } })
  const found = await t.discover() as { state: string; record: SetupRecord }
  expect(found.state).toBe("found")
  expect(found.record.input.digest).toBe(digestBeforeChoreEvents)
  expect(found.record.input.draft.choreEvent).toBe("none")
})

test("a registration written before the chore event existed keeps a consistent identity", async () => {
  const row = known("issues", "enabled")
  const states = await everyJob([{ ...row, digest: digestBeforeChoreEvents,
    configuration: { ...row.configuration, digest: digestBeforeChoreEvents, input: withoutChoreEvent() } }])
  const state = states.issues
  if (state.state !== "known") throw Error(`Expected issues to stay known, got ${JSON.stringify(state)}`)
  expect(state.active?.digest).toBe(digestBeforeChoreEvents)
  expect(state.active?.draft.choreEvent).toBe("none")
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

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const workspaceId = "11111111-1111-4111-8111-111111111111"
const known = (job: RepositoryJob, mode: "enabled" | "trial", cases: SetupDraft["cases"] = []) => {
  const source = initialSetup("org/repo", job, "alice")
  source.draft.cases = cases
  const shared = { repo: source.repo, workspace_id: workspaceId, source_revision: "b".repeat(40), flow_id: `repository-jobs/${job}`,
    mode, revision: source.revision, digest: setupCandidate(source), schedule: "" }
  return { ...shared, id: `registration-${job}-${mode}`, user_id: 1, job, enabled: true, next_fire_at: null, configuration: { ...shared, input: source.draft } }
}
const unknownRow = (id: string) => ({ id, workspace_id: workspaceId, user_id: 1, job: "flow:nightly", mode: "schedule", revision: 1,
  digest: "c".repeat(64), source_revision: "b".repeat(40), flow_id: "flow:nightly", enabled: true, schedule: "0 3 * * *",
  next_fire_at: null, configuration: { trigger: "schedule", flow: "nightly", input: { repositories: ["org/repo"] } } })

const registry = (rows: unknown) => {
  const settings = { ASSETS: { fetch: async () => new Response("SPA") }, IDENTITY_UPSTREAM_URL: "https://identity.test",
    IDENTITY_SERVICE_TOKEN: "synthetic-service", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" }
  const durable = memoryDurableObjects({ env: settings, nativeAlarms: true })
  const env = { ...settings, GATEWAY_SESSIONS: durable.GATEWAY_SESSIONS, TURN_CANCELS: durable.TURN_CANCELS }
  globalThis.fetch = (async (target: RequestInfo | URL) => {
    const url = new URL(target instanceof Request ? target.url : String(target), "https://identity.test")
    if (url.hostname === "identity.test") return url.pathname === "/api/identity/cloud-token"
      ? Response.json({ found: true, token: "cloud-alice" }) : Response.json({ login: "alice", allowlisted: true, admin: false })
    if (url.pathname === "/api/user") return Response.json({ id: 1 })
    if (url.pathname.endsWith("/repository-jobs")) return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } })
    throw Error("Unexpected upstream")
  }) as typeof fetch
  const background: Promise<unknown>[] = []
  return async (job: RepositoryJob) => {
    const response = await worker.fetch(new Request(`https://app.test/api/repository-setup/state?repo=org%2Frepo&job=${job}`, {
      headers: { cookie: "session=alice" }
    }), env, { waitUntil: promise => { background.push(promise) } })
    return ((await response.json()) as SetupRecoveryResponse).registration
  }
}
const everyJob = async (rows: unknown) => {
  const read = registry(rows)
  return Object.fromEntries(await Promise.all(REPOSITORY_JOBS.map(async job => [job, await read(job)] as const))) as Record<RepositoryJob, SetupRecoveryResponse["registration"]>
}

test("a registration the Worker does not know never hides the five jobs it does", async () => {
  const states = await everyJob([...REPOSITORY_JOBS.map(job => known(job, "enabled")), unknownRow("registration-nightly")])
  for (const job of REPOSITORY_JOBS) {
    const state = states[job]
    if (state.state !== "known") throw Error(`Expected ${job} to stay known, got ${JSON.stringify(state)}`)
    expect(state.active?.digest).toBe(setupCandidate(initialSetup("org/repo", job, "alice")))
    expect(state.trial).toBeUndefined()
  }
})

test("ten known registrations and an eleventh unknown row all report their real state", async () => {
  const rows = REPOSITORY_JOBS.flatMap(job => [known(job, "enabled"), known(job, "trial")])
  const states = await everyJob([...rows, unknownRow("registration-nightly")])
  expect(rows).toHaveLength(10)
  for (const job of REPOSITORY_JOBS) {
    const state = states[job]
    if (state.state !== "known") throw Error(`Expected ${job} to stay known, got ${JSON.stringify(state)}`)
    expect(state.active?.registrationId).toBe(`registration-${job}-enabled`)
    expect(state.trial?.registrationId).toBe(`registration-${job}-trial`)
  }
})

test("unknown rows are ignored however many arrive, while known rows past the scan bound refuse their own job", async () => {
  const noise = Array.from({ length: 400 }, (_, index) => unknownRow(`registration-noise-${index}`))
  const tolerated = await everyJob([known("ci", "enabled"), ...noise])
  expect(tolerated.ci.state).toBe("known")
  const flooded = await everyJob(Array.from({ length: 60 }, () => known("ci", "enabled")))
  expect(flooded.ci).toEqual({ state: "unavailable", error: "Repository registrations exceed the recovery limit" })
})

test("a malformed known registration refuses its own job and no sibling", async () => {
  const states = await everyJob(REPOSITORY_JOBS.map(job => job === "ci" ? { ...known(job, "enabled"), digest: "not-a-digest" } : known(job, "enabled")))
  expect(states.ci).toEqual({ state: "unavailable", error: "Repository registration state is invalid" })
  for (const job of REPOSITORY_JOBS.filter(name => name !== "ci")) {
    const state = states[job]
    if (state.state !== "known") throw Error(`Expected ${job} to stay known, got ${JSON.stringify(state)}`)
    expect(state.active?.registrationId).toBe(`registration-${job}-enabled`)
  }
})

test("a duplicate known mode stays an inconsistency for its job alone", async () => {
  const states = await everyJob([known("issues", "enabled"), known("issues", "enabled"), known("review", "enabled")])
  expect(states.issues).toEqual({ state: "unavailable", error: "Repository registration identity is inconsistent" })
  expect(states.review.state).toBe("known")
})

test("an empty registry is known and unconfigured; a body that is not an array stays unavailable", async () => {
  const empty = await everyJob([])
  for (const job of REPOSITORY_JOBS) expect(empty[job]).toEqual({ state: "known" })
  const wrong = await everyJob({ registrations: [] })
  for (const job of REPOSITORY_JOBS) expect(wrong[job]).toEqual({ state: "unavailable", error: "Repository registration state is invalid" })
})

test("a known job in a mode the Worker cannot interpret is unavailable, never unconfigured", async () => {
  const paused = known("issues", "enabled")
  const states = await everyJob([...REPOSITORY_JOBS.filter(job => job !== "issues").map(job => known(job, "enabled")),
    { ...paused, mode: "paused-v2", configuration: { ...paused.configuration, mode: "paused-v2" } },
    { ...unknownRow("registration-nightly"), mode: "whatever" }])
  expect(states.issues).toEqual({ state: "unavailable", error: "Repository registration state is invalid" })
  for (const job of REPOSITORY_JOBS.filter(name => name !== "issues")) {
    const state = states[job]
    if (state.state !== "known") throw Error(`Expected ${job} to stay known, got ${JSON.stringify(state)}`)
    expect(state.active?.registrationId).toBe(`registration-${job}-enabled`)
  }
})

const heldOut: SetupDraft["cases"] = [{ id: "case-1", name: "Reported bug", input: "a bug report", expected: "HELD_OUT_ANSWER", required: true }]
const readerCopy = (row: ReturnType<typeof known>) => ({ ...row, configuration: { ...row.configuration,
  input: { ...row.configuration.input, cases: row.configuration.input.cases.map(item => ({ id: item.id, name: item.name, required: item.required })) } } })

test("a redacted reader copy is a read-only registration, not corruption", async () => {
  const writer = known("issues", "enabled", heldOut)
  const states = await everyJob(REPOSITORY_JOBS.map(job => job === "issues" ? readerCopy(writer) : known(job, "enabled")))
  const state = states.issues
  if (state.state !== "known") throw Error(`Expected issues to stay known, got ${JSON.stringify(state)}`)
  expect(state.active).toEqual({ registrationId: "registration-issues-enabled", workspaceId, revision: 1, digest: writer.digest,
    sourceRevision: "b".repeat(40), enabled: true, owned: false, draft: { ...writer.configuration.input, cases: [] } })
  expect(state.active?.draft.steps).toEqual(writer.configuration.input.steps)
  for (const job of REPOSITORY_JOBS.filter(name => name !== "issues")) {
    const sibling = states[job]
    if (sibling.state !== "known") throw Error(`Expected ${job} to stay known, got ${JSON.stringify(sibling)}`)
    expect(sibling.active?.owned).toBe(true)
  }
})

test("a writer row keeps its cases, its ownership and its recomputed digest", async () => {
  const writer = known("issues", "enabled", heldOut)
  const whole = await everyJob([writer])
  if (whole.issues.state !== "known") throw Error(`Expected issues to stay known, got ${JSON.stringify(whole.issues)}`)
  expect(whole.issues.active?.owned).toBe(true)
  expect(whole.issues.active?.draft.cases).toEqual(heldOut)
  const tampered = { ...writer, configuration: { ...writer.configuration, input: { ...writer.configuration.input,
    cases: [{ ...heldOut[0]!, expected: "A DIFFERENT ANSWER" }] } } }
  const forged = await everyJob([tampered])
  expect(forged.issues).toEqual({ state: "unavailable", error: "Repository registration identity is inconsistent" })
})

test("a redacted row that is also malformed stays the typed error it is today", async () => {
  const writer = known("issues", "enabled", heldOut)
  const broken = await everyJob([{ ...readerCopy(writer), digest: "not-a-digest" }])
  expect(broken.issues).toEqual({ state: "unavailable", error: "Repository registration state is invalid" })
  const foreign = readerCopy(writer)
  const mismatched = await everyJob([{ ...foreign, configuration: { ...foreign.configuration, repo: "org/other" } }])
  expect(mismatched.issues).toEqual({ state: "unavailable", error: "Repository registration identity is inconsistent" })
  const half = { ...writer, configuration: { ...writer.configuration, input: { ...writer.configuration.input,
    cases: [{ id: "case-1", name: "Reported bug", required: true }, heldOut[0]!] } } }
  const partial = await everyJob([half])
  expect(partial.issues).toEqual({ state: "unavailable", error: "Repository registration state is invalid" })
})
