import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import { initialSetup, setupActivationProblems, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import type { StorageApi } from "@tanstack/db"
import { Database } from "bun:sqlite"
import { afterEach,describe,expect,test } from "bun:test"
import { mkdtempSync,rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APP_SCHEMA_VERSION,SCHEMA_VERSION_STORAGE_KEY } from "../chain/SchemaVersion"
import { openSqliteRowStorage,ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import { PRIVACY_RETIREMENT_KEY, readPrivacyRetirement } from "../chain/PrivacyRetirement"
import { ENVELOPE_STORAGE_KEY,parseStorageEnvelope } from "../chain/TransactionalStorage"
import { digest } from "@smthrs/core/Digest"
import { APP_PROJECTOR_VERSION, AppProjectorVersionError, AppEventIntegrityError, appProjectionHash, retiredAppStreamKey, replayAppEvents } from "./AppEventStream"
import { initialSession, cardFrameId } from "./AppState"
import { createAppStore,PERSISTED_COLLECTION_SPECS,type AppStore } from "./AppStore"
import { canonicalEventValue, decodeEventValue, encodeEventValue } from "./EventValue"
import { memoryStorage } from "./TestFixtures"
import { MAX_TRANSITION_PAYLOAD_BYTES } from "./TransitionDiagnostics"

const opened: AppStore[] = []
const directories: string[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.dispose?.()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const open = async (storage: StorageApi) => {
  const store = await createAppStore({ kind: "localStorage", storage }, { seedWiki: false })
  opened.push(store)
  return store
}
const editEnvelope = (storage: StorageApi, edit: (entries: Record<string, string>) => void) => {
  const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
  edit(envelope.entries)
  storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
}
const envelopeRows = (storage: StorageApi) => Object.fromEntries(Object.entries(
  parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!.entries
).map(([key, value]) => [key, JSON.parse(value)]))
const privateKeys = new Set(["app-events", "app-event-heads", "app-event-checkpoints", "app-event-retirements"].map(id => `smithers-mvp.${id}`))

const sqliteStore = async (path: string) => {
  const db = new Database(path)
  const adapter = await openSqliteRowStorage({
    execute: async <Row>(sql: string, params: ReadonlyArray<unknown> = []) => {
      const statement = db.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<Row>
      statement.run(...params as []); return []
    }, close: () => db.close()
  }, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
  const store = await createAppStore({ kind: "opfs", ...adapter, storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } }, { seedWiki: false })
  return { store, db }
}

const installProjectorFixture = async (storage: StorageApi, version: number, retiredPresentation = false) => {
  const store = await open(storage)
  await store.dispatch({ type: "message.submitted", actor: "user", turnId: "kept", text: "Keep my work" }).isPersisted.promise
  await store.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "kept" }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id: "kept", kind: "file", title: "kept.ts", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "org/repo", path: "kept.ts", content: "retained", truncated: false }
  } }).isPersisted.promise
  await store.dispatch({ type: "repo.pinned", actor: "user", pin: {
    id: "kept", name: "kept", path: "/kept", branch: "main", origin: "local", pinnedAt: 1
  } }).isPersisted.promise
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
    allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "world.document.upserted", actor: "user", document: {
    id: "kept", path: "kept.md", title: "Kept", body: "Retain wiki", links: [], tags: [], sources: [], confidence: 1
  } }).isPersisted.promise
  const builtIn = AGENT_ROLES[0]!
  const custom = { ...builtIn, id: "custom-reviewer", builtin: false, label: "Custom reviewer" }
  if (retiredPresentation) {
    await store.dispatch({ type: "card.upsert", actor: "user", card: {
      id: "kept-agents", kind: "agents", title: "Agents", status: "active", createdAt: 2, ordinal: 2,
      payload: { native: true, agents: [{ ...builtIn, harnessName: "Claude", available: true, reason: "", account: "" }] }
    } }).isPersisted.promise
    await store.dispatch({ type: "card.maximized", actor: "user", id: "kept" }).isPersisted.promise
  }
  await store.compactEvents()
  const history = await store.eventHistory()
  const snapshot = structuredClone(history.checkpoint.snapshot)
  Object.assign(snapshot.sessions![0]!, { guide: { version: 3, sequence: "practice-v4", step: 1,
    completed: [], autoPaused: false, conversationOpen: false }, guideVisible: false })
  const retireFixture = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(retireFixture)
    if (value === null || typeof value !== "object") return value
    const row = value as Record<string, unknown>
    if (row.kind === "file" && row.id === "kept") return { ...row, kind: "repo-home", payload: {
      repo: "org/repo", path: ".smithers/home.json", blocks: [{ type: "text", text: "Old home" }], featuredFlows: null
    } }
    if (row.kind === "agents") return { ...row, payload: { native: true, agents: [
      { ...builtIn, label: "Edited built-in", purpose: "Custom purpose", model: { provider: "custom", id: "custom-model", label: "Custom" },
        harnessName: "Claude", available: true, reason: "", account: "" },
      { ...custom, harnessName: "Claude", available: true, reason: "", account: "" }
    ] } }
    return Object.fromEntries(Object.entries(row).map(([key, field]) => [key, retireFixture(field)]))
  }
  if (retiredPresentation) {
    Object.assign(snapshot, retireFixture(snapshot))
    snapshot.agents = [{ ...builtIn, label: "Edited built-in" }, custom]
  }
  const stateHash = appProjectionHash(snapshot as unknown as Parameters<typeof appProjectionHash>[0])
  const head = { ...history.head, projectorVersion: version, stateHash }
  const eventBody = { formatVersion: 1, projectorVersion: version, id: "retired-guide-event", streamId: head.streamId,
    sequence: head.sequence + 1, revision: head.revision + 1, kind: "transition", type: "guide.visibility.changed",
    actor: "user", createdAt: 1, persistenceMode: "localStorage",
    input: encodeEventValue({ type: "guide.visibility.changed", actor: "user", visible: false }),
    previousEventHash: head.eventHash, previousStateHash: stateHash, stateHash }
  const event = { ...eventBody, hash: digest("smithers-app/event/v1:" + canonicalEventValue(eventBody)) }
  if (version === 1) Object.assign(head, { sequence: event.sequence, revision: event.revision, eventHash: event.hash })
  const { hash: _, ...body } = { ...history.checkpoint, projectorVersion: version, snapshot, stateHash }
  const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
  await store.dispose?.()
  opened.splice(opened.indexOf(store), 1)
  editEnvelope(storage, entries => {
    if (retiredPresentation) {
      entries["smithers-mvp.app-agents"] = JSON.stringify(Object.fromEntries(snapshot.agents!.map(row => {
        const agent = row as Record<string, unknown>
        return [`s:${agent.id}`, { versionKey: "fixture", data: agent }]
      })))
      for (const id of ["app-cards", "app-frames"]) {
        const key = `smithers-mvp.${id}`
        if (entries[key]) entries[key] = JSON.stringify(retireFixture(JSON.parse(entries[key]!)))
      }
    }
    if (version === 1) {
      entries["smithers-mvp.app-events"] = JSON.stringify({ "s:retired-guide-event": { versionKey: "fixture", data: event } })
      const sessions = JSON.parse(entries["smithers-mvp.app-sessions"]!)
      Object.assign(sessions["s:main"].data, { guide: (snapshot.sessions![0] as Record<string, unknown>).guide, guideVisible: false })
      entries["smithers-mvp.app-sessions"] = JSON.stringify(sessions)
    }
    for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
      entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
    }
  })
  return history
}

describe("the live store's authoritative event path", () => {
  test("version 6 upgrade retains setup policy and a later pending guide survives reopen", async () => {
    const storage = memoryStorage(), store = await open(storage)
    const payload = initialSetup("org/repo", "issues", "alice")
    payload.active = { revision: 1, digest: setupCandidate(payload), registrationId: "issues", sourceRevision: "source", enabled: false, owned: true }
    await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 6 }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: 6 }], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const upgraded = await open(storage), card = upgraded.collections.cards.get("setup")!
    if (card.kind !== "repository-setup") throw Error("Missing setup")
    expect(card.payload).toEqual(payload)
    expect((await upgraded.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    const guidance = { id: "6405cbb6-c18f-452e-99db-adb1283ee18a", state: "requested" as const }
    await upgraded.dispatch({ type: "card.upsert", actor: "user", card: { ...card, payload: { ...card.payload, guidance } } }).isPersisted.promise
    await upgraded.dispose?.(); opened.splice(opened.indexOf(upgraded), 1)
    const reopened = await open(storage)
    expect(reopened.collections.cards.get("setup")).toMatchObject({ payload: { guidance, active: payload.active } })
    expect((await reopened.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("version 5 upgrade preserves a chore policy; its observed next execution survives reopen without granting evidence", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const payload = initialSetup("org/repo", "chores", "alice")
    payload.draft.schedule = "0 9 * * *"
    payload.active = { revision: 1, digest: setupCandidate(payload), registrationId: "chore", sourceRevision: "immutable-source", enabled: true, owned: true }
    payload.recovery = { id: "recover", baseRevision: 1, baseDigest: setupCandidate(payload), state: "completed", registrationState: "known" }
    await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "chore", kind: "repository-setup", title: "Automate a chore", status: "active", createdAt: 1, ordinal: 1, payload } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 5 }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: 5 }], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage), card = restored.collections.cards.get("chore")!
    if (card.kind !== "repository-setup") throw Error("Chore was not retained")
    expect(card.payload).toEqual(payload)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    await restored.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload,
      active: { ...card.payload.active!, schedule: { expression: "0 9 * * *", nextFireAt: "2026-09-18T09:00:00Z" } }
    } } }).isPersisted.promise
    await restored.dispose?.(); opened.splice(opened.indexOf(restored), 1)
    const reopened = await open(storage), resumed = reopened.collections.cards.get("chore")!
    if (resumed.kind !== "repository-setup") throw Error("Chore was not retained")
    expect(resumed.payload.active?.schedule?.nextFireAt).toBe("2026-09-18T09:00:00Z")
    expect(resumed.payload.evaluation).toBeUndefined()
    expect(resumed.payload.trial).toBeUndefined()
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("version 4 upgrade preserves setup cases and an unfinished receipt; recovery markers survive the next reopen", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const payload = initialSetup("org/repo", "issues", "alice")
    payload.draft.cases = [{ id: "retained-case", name: "Retained case", input: "An issue", expected: "A source-bound answer", required: true }]
    const candidate = setupCandidate(payload)
    payload.request = { id: "retained-request", operation: "evaluate", revision: 1, digest: candidate, state: "running" }
    payload.receipt = { requestId: "retained-request", operation: "evaluate", revision: 1, digest: candidate, runId: "retained-run", phase: "waiting", updatedAt: 1, results: [], evidence: ["run:retained-run"] }
    await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: 1, payload } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 4 }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: 4 }], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage), card = restored.collections.cards.get("setup")!
    if (card.kind !== "repository-setup") throw Error("Setup was not retained")
    expect(card.payload).toEqual(payload)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    await restored.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload,
      request: { ...card.payload.request!, observeOnly: true }, recovery: { id: "recover", baseRevision: 1, baseDigest: candidate, state: "requested", registrationState: "unknown", adoptDraft: false }
    } } }).isPersisted.promise
    await restored.dispose?.(); opened.splice(opened.indexOf(restored), 1)
    const reopened = await open(storage), resumed = reopened.collections.cards.get("setup")!
    if (resumed.kind !== "repository-setup") throw Error("Setup was not retained")
    expect(resumed.payload.request?.observeOnly).toBe(true)
    expect(resumed.payload.recovery?.state).toBe("requested")
    expect(resumed.payload.receipt?.phase).toBe("waiting")
    expect(resumed.payload.trial).toBeUndefined()
    expect(resumed.payload.evaluation).toBeUndefined()
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("version 7 upgrade decodes a chore draft stored before the chore event existed", async () => {
    const storage = memoryStorage(), store = await open(storage)
    const payload = initialSetup("org/repo", "chores", "alice")
    payload.draft.schedule = "0 9 * * *"
    payload.draft.steps = payload.draft.steps.map(step => ({ ...step, mode: "approved" as const }))
    payload.draft.cases = [{ id: "retained-chore", name: "Retained chore", input: "A weekly tidy", expected: "A scoped maintenance change", required: true }]
    // The digest the pre-stack code at 1f7d9b40bcc5 wrote into this card, not one this build recomputes.
    const digestBeforeChoreEvents = "4ae1937060bb181a4d1e1a910fab2b986e4139b8513c296f4c7279fd532686bd"
    const evidence = (operation: "evaluate" | "trial") => ({ requestId: `${operation}-request`, runId: `${operation}-run`,
      revision: 1, operation, phase: "completed" as const, digest: digestBeforeChoreEvents, updatedAt: 1,
      results: [{ caseId: "retained-chore", status: "passed" as const, observed: "A scoped maintenance change", evidence: ["execution:retained-chore"], executionId: "retained-chore" }],
      evidence: [`run:${operation}-run`], sourceRevision: "immutable-source" })
    payload.evaluation = evidence("evaluate")
    payload.trial = evidence("trial")
    payload.active = { revision: 1, digest: digestBeforeChoreEvents, registrationId: "chore", sourceRevision: "immutable-source", enabled: true, owned: true }
    await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "chore", kind: "repository-setup", title: "Automate a chore", status: "active", createdAt: 1, ordinal: 1, payload } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const withoutChoreEvent = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutChoreEvent)
      if (value === null || typeof value !== "object") return value
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "choreEvent").map(([key, field]) => [key, withoutChoreEvent(field)]))
    }
    const snapshot = withoutChoreEvent(structuredClone(old.checkpoint.snapshot)) as typeof old.checkpoint.snapshot
    const stateHash = appProjectionHash(snapshot as unknown as Parameters<typeof appProjectionHash>[0])
    const head = { ...old.head, projectorVersion: 7, stateHash }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 7, snapshot, stateHash }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      entries["smithers-mvp.app-cards"] = JSON.stringify(withoutChoreEvent(JSON.parse(entries["smithers-mvp.app-cards"]!)))
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage), card = restored.collections.cards.get("chore")!
    if (card.kind !== "repository-setup") throw Error("Chore was not retained")
    expect(card.payload.draft.choreEvent).toBe("none")
    expect(card.payload).toEqual(payload)
    expect(setupCandidate(card.payload)).toBe(card.payload.active!.digest)
    expect(setupActivationProblems(card.payload)).toEqual([])
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("version 8 upgrade drops the retired sidebar state", async () => {
    const storage = memoryStorage(), store = await open(storage)
    await store.compactEvents()
    const old = await store.eventHistory()
    const snapshot = structuredClone(old.checkpoint.snapshot)
    Object.assign(snapshot.sessions![0]!, { sidebarOpen: false })
    const stateHash = appProjectionHash(snapshot as unknown as Parameters<typeof appProjectionHash>[0])
    const head = { ...old.head, projectorVersion: 8, stateHash }
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 8, snapshot, stateHash }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.(); opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      const sessions = JSON.parse(entries["smithers-mvp.app-sessions"]!)
      sessions["s:main"].data.sidebarOpen = false
      entries["smithers-mvp.app-sessions"] = JSON.stringify(sessions)
      for (const [id, data] of [["app-event-heads", head], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect((await restored.eventHistory()).head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect((await restored.verifyState()).valid).toBe(true)
    expect(restored.session()).not.toHaveProperty("sidebarOpen")
  })

  test("version 3 upgrade preserves a deferred repository command and its route receipt", async () => {
    const storage = memoryStorage()
    const store = await open(storage)
    await store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "saved-url", repo: "alpha/one", phase: "pending" } }).isPersisted.promise
    await store.dispatch({ type: "command.deferred", actor: "user", name: "files.list", args: JSON.stringify({ path: "docs", repo: "alpha/one" }), requirement: "repository-ready" }).isPersisted.promise
    await store.dispatch({ type: "card.upsert", actor: "user", card: {
      id: "kept", kind: "file", title: "kept.ts", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: "alpha/one", path: "kept.ts", content: "retained", truncated: false }
    } }).isPersisted.promise
    await store.compactEvents()
    const old = await store.eventHistory()
    const pending = structuredClone(store.session().pendingCommand)
    const { hash: _, ...body } = { ...old.checkpoint, projectorVersion: 3 }
    const checkpoint = { ...body, hash: digest("smithers-app/checkpoint/v1:" + canonicalEventValue(body)) }
    await store.dispose?.()
    opened.splice(opened.indexOf(store), 1)
    editEnvelope(storage, entries => {
      for (const [id, data] of [["app-event-heads", { ...old.head, projectorVersion: 3 }], ["app-event-checkpoints", checkpoint]] as const) {
        entries[`smithers-mvp.${id}`] = JSON.stringify({ "s:current": { versionKey: "fixture", data } })
      }
    })
    const restored = await open(storage)
    expect((await restored.eventHistory()).checkpoint.reason).toBe("projector-upgrade")
    expect(restored.session().repositoryEntry).toEqual({ requestId: "saved-url", repo: "alpha/one", phase: "pending" })
    expect(restored.session().pendingCommand).toEqual(pending)
    expect(restored.session().repositoryCommandEntry).toBeUndefined()
    expect(restored.collections.cards.get("kept")?.payload).toEqual({ repo: "alpha/one", path: "kept.ts", content: "retained", truncated: false })
    expect((await restored.verifyState()).valid).toBe(true)
    const reopened = await open(storage)
    expect(reopened.session().pendingCommand).toEqual(pending)
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("version 2 cards retire across reopening while historical frames and conversations survive", async () => {
    const storage = memoryStorage()
    const old = await installProjectorFixture(storage, 2, true)
    const restored = await open(storage)
    const history = await restored.eventHistory()
    expect(history.checkpoint.reason).toBe("projector-upgrade")
    expect(history.head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect(history.head.streamId).not.toBe(old.head.streamId)
    expect(restored.collections.cards.get("kept")).toMatchObject({ id: "kept", kind: "retired", payload: {}, title: "" })
    const branch = restored.session().activeBranchId!
    const frame = restored.collections.frames.get(cardFrameId(branch, "kept"))!
    expect(frame.id).toBe(cardFrameId(branch, "kept"))
    expect(frame.snapshot?.cards.find(card => card.id === "kept")).toMatchObject({ kind: "retired", payload: {} })
    expect(restored.collections.messages.get("message-kept-user")?.text).toBe("Keep my work")
    expect([...restored.collections.agents.keys()].sort()).toEqual(AGENT_ROLES.map(role => role.id).sort())
    for (const role of AGENT_ROLES) expect(restored.collections.agents.get(role.id)).toMatchObject(role)
    const agentsCard = restored.collections.cards.get("kept-agents")!
    expect(agentsCard.kind).toBe("agents")
    if (agentsCard.kind !== "agents") throw new Error("Missing built-in roster")
    expect(agentsCard.payload.agents).toHaveLength(1)
    expect(agentsCard.payload.agents[0]).toMatchObject({ id: AGENT_ROLES[0]!.id, label: AGENT_ROLES[0]!.label, model: AGENT_ROLES[0]!.model })
    expect(frame.snapshot?.cards.find(card => card.id === "kept-agents")).toMatchObject({ kind: "agents", payload: agentsCard.payload })
    expect((await restored.verifyState()).valid).toBe(true)
    const reopened = await open(storage)
    expect(reopened.collections.frames.get(frame.id)).toEqual(frame)
    expect(reopened.collections.cards.get("kept")?.kind).toBe("retired")
    expect(reopened.collections.agents.has("custom-reviewer")).toBe(false)
    expect(reopened.collections.cards.get("kept-agents")).toEqual(agentsCard)
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("rotates retired guide checkpoints without losing materialized rows", async () => {
    const storage = memoryStorage()
    const old = await installProjectorFixture(storage, 1)
    const restored = await open(storage)
    const next = await restored.eventHistory()
    expect(next.head.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect(next.checkpoint.projectorVersion).toBe(APP_PROJECTOR_VERSION)
    expect(next.checkpoint.reason).toBe("projector-upgrade")
    expect(next.head.streamId).not.toBe(old.head.streamId)
    expect(next.events).toHaveLength(0)
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toContain(retiredAppStreamKey(old.head.streamId))
    expect(restored.session()).not.toHaveProperty("guide")
    expect(restored.session()).not.toHaveProperty("guideVisible")
    expect(next.checkpoint.stateHash).toBe(old.checkpoint.stateHash)
    for (const name of ["sessions", "cards", "messages", "worldDocuments", "pinnedRepos", "identitySessions"]) {
      expect(next.checkpoint.snapshot[name]!.length).toBeGreaterThan(0)
    }
    expect((await restored.verifyState()).valid).toBe(true)
    const reopened = await open(storage)
    expect((await reopened.eventHistory()).head.streamId).toBe(next.head.streamId)
  })

  for (const phase of ["complete", "pending"] as const) test(`upgrade resumes a failed ${phase} privacy marker update`, async () => {
    const bytes = new Map<string, string>()
    const inner = { get length() { return bytes.size }, key: (index: number) => [...bytes.keys()][index] ?? null,
      getItem: (key: string) => bytes.get(key) ?? null, setItem: (key: string, value: string) => { bytes.set(key, value) },
      removeItem: (key: string) => { bytes.delete(key) } }
    const old = await installProjectorFixture(inner, 1)
    inner.setItem(PRIVACY_RETIREMENT_KEY, JSON.stringify({ version: 2, id: "previous-signout", mode: "account",
      backend: "localStorage", targetStreamId: old.head.streamId, phase, erasures: [] }))
    let failMarker = true
    const storage = { ...inner, get length() { return inner.length }, setItem: (key: string, value: string) => {
      if (failMarker && key === PRIVACY_RETIREMENT_KEY) throw new Error("marker unavailable")
      inner.setItem(key, value)
    } }
    const boot = () => createAppStore({ backend: { kind: "localStorage", storage }, mode: "localStorage", degraded: false,
      privacy: { record: storage, eraseInactiveDatabase: async () => {} } }, { seedWiki: false })
    await expect(boot()).rejects.toThrow("marker unavailable")
    failMarker = false
    const restored = await boot(); opened.push(restored)
    expect(readPrivacyRetirement(storage)?.targetStreamId).toBe((await restored.eventHistory()).head.streamId)
    expect(restored.collections.messages.get("message-kept-user")?.text).toBe("Keep my work")
    const reopened = await boot(); opened.push(reopened)
    expect((await reopened.verifyState()).valid).toBe(true)
  })

  test("newer projectors refuse boot and preserve history", async () => {
    const storage = memoryStorage()
    await installProjectorFixture(storage, APP_PROJECTOR_VERSION + 1)
    const before = storage.getItem(ENVELOPE_STORAGE_KEY)
    await expect(open(storage)).rejects.toEqual(new AppProjectorVersionError(APP_PROJECTOR_VERSION + 1))
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toBe(before)
  })

  test("row shape changes without a projector bump still fail checkpoint verification", async () => {
    const storage = memoryStorage()
    await installProjectorFixture(storage, APP_PROJECTOR_VERSION)
    const before = envelopeRows(storage)
    await expect(open(storage)).rejects.toEqual(new AppEventIntegrityError("checkpoint"))
    expect(envelopeRows(storage)).toEqual(before)
  })

  test("a failed upgrade commit preserves the old authority for retry", async () => {
    const inner = memoryStorage()
    await installProjectorFixture(inner, 1)
    const before = inner.getItem(ENVELOPE_STORAGE_KEY)
    let writes = 0
    const storage: StorageApi = { ...inner, setItem: (key, value) => {
      if (key === ENVELOPE_STORAGE_KEY && ++writes === 2) throw new Error("disk full")
      inner.setItem(key, value)
    } }
    await expect(open(storage)).rejects.toThrow("disk full")
    const prior = parseStorageEnvelope(before!)!.entries
    const retained = parseStorageEnvelope(inner.getItem(ENVELOPE_STORAGE_KEY)!)!.entries
    for (const key of privateKeys) expect(JSON.parse(retained[key] ?? "null")).toEqual(JSON.parse(prior[key] ?? "null"))
    expect((await (await open(inner)).eventHistory()).checkpoint.reason).toBe("projector-upgrade")
  })

  test("billing plan observations replay and erase with their account owner", async () => {
    const storage = memoryStorage()
    const first = await open(storage)
    await first.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const sandbox = { concurrentSandboxes: 2, concurrentInUse: 1, idleTimeoutSecs: 60, hoursPerDay: 3,
      secondsUsedToday: 120, dayResetsAt: "2026-09-16T00:00:00Z" }
    const plans = [{ key: "pro" as const, display_name: "Observed plan", price_cents: 1234, interval: "month",
      limits: { concurrent_sandboxes: 2, idle_timeout_secs: 60, hours_per_day: 3, private_repos: 1,
        storage_bytes: 100, ci_minutes: 2, agent_runs: 3, seats: 1 }, checkout_available: true }]
    await first.dispatch({ type: "billing.plans.loaded", actor: "user", planKey: "pro", sandbox, plans }).isPersisted.promise
    const history = await first.eventHistory()
    expect(replayAppEvents(history.checkpoint, history.events, history.head).snapshot.billingAccounts[0]).toMatchObject({ planKey: "pro", sandbox, plans })
    const restored = await open(storage)
    expect(restored.collections.billingAccounts.get("billing")).toMatchObject({ planKey: "pro", sandbox, plans })
    expect((await restored.verifyState()).valid).toBe(true)
    await restored.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    expect(restored.collections.billingAccounts.get("billing")).toMatchObject({ planKey: null, sandbox: null, plans: [] })
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).not.toContain("Observed plan")
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("diagnostic elision preserves full Unicode facts and replayed content", async () => {
    const storage = memoryStorage()
    const first = await open(storage)
    const content = "日本語🙂".repeat(500)
    const transition = { type: "card.upsert", actor: "user", card: {
      id: "large-file", kind: "file", title: "source.ts", status: "active", createdAt: 1, ordinal: 3,
      payload: { repo: "org/repo", path: "source.ts", content, truncated: false }
    } } as const
    await first.dispatch(transition).isPersisted.promise
    const history = await first.eventHistory()
    expect(decodeEventValue(history.events[0]!.input)).toEqual(transition)
    const diagnostic = [...first.collections.transitions.values()].at(-1)!
    expect(new TextEncoder().encode(diagnostic.payload).byteLength).toBeLessThanOrEqual(MAX_TRANSITION_PAYLOAD_BYTES)
    expect(diagnostic.payload).not.toContain(content)
    expect(first.collections.cards.get("large-file")?.payload).toHaveProperty("content", content)
    const restored = await open(storage)
    expect(restored.collections.cards.get("large-file")?.payload).toHaveProperty("content", content)
    expect(replayAppEvents(history.checkpoint, history.events, history.head).snapshot.cards[0]?.payload).toHaveProperty("content", content)
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("accepted facts rebuild erased projections and retain draft clears through actual reload", async () => {
    const storage = memoryStorage()
    const first = await open(storage)
    await first.dispatch({ type: "message.submitted", actor: "user", turnId: "t", text: "Keep the original question" }).isPersisted.promise
    await first.dispatch({ type: "message.response.delta", actor: "smithers", turnId: "t", channel: "text", delta: "An answer" }).isPersisted.promise
    await first.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "t" }).isPersisted.promise
    await first.dispatch({ type: "card.upsert", actor: "user", card: {
      id: "file", kind: "file", title: "source.ts", status: "active", createdAt: 1, ordinal: 3,
      payload: { repo: "org/repo", path: "source.ts", content: "export {}", truncated: false, line: 7 }
    } }).isPersisted.promise
    await first.dispatch({ type: "card.updated", actor: "user", id: "file", patch: { payload: { line: undefined } } }).isPersisted.promise
    const before = await first.eventHistory()
    expect((await first.verifyState()).valid).toBe(true)
    editEnvelope(storage, entries => {
      for (const key of Object.keys(entries)) if (!privateKeys.has(key)) delete entries[key]
    })
    const restored = await open(storage)
    expect(restored.collections.messages.get("message-t-user")?.text).toBe("Keep the original question")
    expect(restored.collections.messages.get("message-t-smithers")?.text).toBe("An answer")
    expect(restored.collections.cards.get("file")?.payload).not.toHaveProperty("line", 7)
    expect((await restored.verifyState()).valid).toBe(true)
    expect((await restored.eventHistory()).head.streamId).toBe(before.head.streamId)
  })

  test("draft coalescing commits one immutable fact with the final input", async () => {
    const store = await open(memoryStorage())
    const one = store.dispatch({ type: "composer.changed", actor: "user", draft: "a" })
    const two = store.dispatch({ type: "composer.changed", actor: "user", draft: "abc" })
    expect(one).toBe(two)
    await one.isPersisted.promise
    const history = await store.eventHistory()
    expect(history.events).toHaveLength(1)
    expect(decodeEventValue(history.events[0]!.input)).toEqual({ type: "composer.changed", actor: "user", draft: "abc" })
    expect((await store.verifyState()).valid).toBe(true)
  })

  test("legacy rows gain an honest baseline and new facts start after it", async () => {
    const storage = memoryStorage()
    storage.setItem(SCHEMA_VERSION_STORAGE_KEY, "11")
    storage.setItem("smithers-mvp.app-sessions", JSON.stringify({ "s:main": {
      versionKey: "legacy", data: { ...initialSession("dark"), draft: "Existing work", revision: 28 }
    } }))
    const store = await open(storage)
    const migrated = await store.eventHistory()
    expect(migrated.checkpoint.reason).toBe("legacy-baseline")
    expect(migrated.head.sequence).toBe(0)
    expect(migrated.events).toHaveLength(0)
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "light" }).isPersisted.promise
    const next = await store.eventHistory()
    expect(next.events[0]?.sequence).toBe(1)
    expect(next.events[0]?.revision).toBe(29)
    expect((await store.verifyState()).valid).toBe(true)
  })

  test("checkpoints cover removed history and suffix replay still equals served state", async () => {
    const storage = memoryStorage()
    const store = await open(storage)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "Covered by checkpoint" }).isPersisted.promise
    const full = await store.eventHistory()
    await store.compactEvents()
    const compacted = await store.eventHistory()
    expect(compacted.events).toHaveLength(0)
    expect(compacted.checkpoint.sequence).toBe(full.head.sequence)
    expect(compacted.checkpoint.stateHash).toBe(full.head.stateHash)
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const suffix = await store.eventHistory()
    expect(suffix.events).toHaveLength(1)
    expect(replayAppEvents(suffix.checkpoint, suffix.events, suffix.head).snapshot.sessions[0]?.draft).toBe("Covered by checkpoint")
    const restored = await open(storage)
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("unknown event versions and missing history refuse boot without adopting the cached rows", async () => {
    for (const corrupt of ["version", "missing"] as const) {
      const storage = memoryStorage()
      const store = await open(storage)
      await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
      editEnvelope(storage, entries => {
        const key = "smithers-mvp.app-events"
        const rows = JSON.parse(entries[key]!) as Record<string, { data: Record<string, unknown> }>
        if (corrupt === "missing") delete rows[Object.keys(rows)[0]!]
        else Object.values(rows)[0]!.data.formatVersion = 999
        entries[key] = JSON.stringify(rows)
      })
      const preserved = storage.getItem(ENVELOPE_STORAGE_KEY)
      await expect(open(storage)).rejects.toThrow()
      expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toBe(preserved)
    }
  })

  test("signout erases private event and historical payloads and retires their stream", async () => {
    const storage = memoryStorage()
    const store = await open(storage)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: "private", text: "secret-before-signout" }).isPersisted.promise
    const old = await store.eventHistory()
    await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    const current = await store.eventHistory()
    expect(current.head.streamId).not.toBe(old.head.streamId)
    expect(current.checkpoint.reason).toBe("privacy-reset")
    expect(current.events).toHaveLength(0)
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).not.toContain("secret-before-signout")
    expect(() => replayAppEvents(current.checkpoint, old.events, current.head)).toThrow()
    expect((await store.verifyState()).valid).toBe(true)
  })

  test("concurrent accepted writes are not reported as projection corruption", async () => {
    const store = await open(memoryStorage())
    const before = store.verifyState()
    const accepted = store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const during = store.verifyState()
    const next = store.dispatch({ type: "composer.changed", actor: "user", draft: "Arrived during verification" }).isPersisted.promise
    const after = store.verifyState()
    const proofs = await Promise.all([before, during, after])
    await Promise.all([accepted, next])
    expect(proofs.every(proof => proof.valid)).toBe(true)
    expect(proofs[2]?.sequence).toBe(2)
  })

  test("failed commits reject their events and every optimistic dependent", async () => {
    const inner = memoryStorage()
    let broken = false
    const storage: StorageApi = { ...inner, setItem: (key, value) => {
      if (broken && key === ENVELOPE_STORAGE_KEY) throw new Error("disk full")
      inner.setItem(key, value)
    } }
    const store = await open(storage)
    const before = await store.eventHistory()
    broken = true
    const first = store.dispatch({ type: "composer.changed", actor: "user", draft: "Not accepted" }).isPersisted.promise
    const dependent = store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const outcomes = await Promise.allSettled([first, dependent])
    expect(outcomes.map(row => row.status)).toEqual(["rejected", "rejected"])
    expect((await store.eventHistory()).head).toEqual(before.head)
    expect((await store.verifyState()).valid).toBe(true)
    broken = false
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const restored = await open(storage)
    expect(restored.session().draft).toBe("")
    expect((await restored.verifyState()).valid).toBe(true)
  })

  test("a stale SQLite owner cannot compact against a newer committed head", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-app-event-cas-")); directories.push(directory)
    const path = join(directory, "state.sqlite")
    const stale = await sqliteStore(path)
    const first = await sqliteStore(path)
    await first.store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const accepted = await first.store.eventHistory()
    await expect(stale.store.compactEvents()).rejects.toThrow()
    const head = JSON.parse((first.db.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-event-heads'`).get() as { value: string }).value)
    expect(head).toEqual(accepted.head)
    const checkpoint = JSON.parse((first.db.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-event-checkpoints'`).get() as { value: string }).value)
    expect(checkpoint.reason).toBe("created")
    await Promise.resolve(stale.store.dispose?.()).catch(() => {})
    await first.store.dispose?.()
    const restored = await sqliteStore(path); opened.push(restored.store)
    expect(restored.store.session().theme).toBe("dark")
    expect((await restored.store.verifyState()).valid).toBe(true)
  })

  test("real SQLite close/reopen rebuilds deleted materializations from committed authority", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-app-events-")); directories.push(directory)
    const path = join(directory, "state.sqlite")

    const first = await sqliteStore(path)
    await first.store.dispatch({ type: "composer.changed", actor: "user", draft: "SQLite authority" }).isPersisted.promise
    await first.store.dispatch({ type: "message.submitted", actor: "user", turnId: "long-turn", text: "A retained question" }).isPersisted.promise
    for (let index = 0; index < 505; index += 1) {
      await first.store.dispatch({ type: "message.response.delta", actor: "smithers", turnId: "long-turn", channel: "text", delta: `${index},` }).isPersisted.promise
    }
    await first.store.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "long-turn" }).isPersisted.promise
    await first.store.dispatch({ type: "composer.changed", actor: "user", draft: "SQLite authority" }).isPersisted.promise
    const accepted = await first.store.eventHistory()
    expect(accepted.events.length).toBeGreaterThan(500)
    expect(first.store.collections.transitions.size).toBe(500)
    expect([...first.store.collections.transitions.values()].some(row => row.type === "message.submitted")).toBe(false)
    await first.store.dispose?.()
    const tamper = new Database(path)
    tamper.run(`DELETE FROM ${ROW_TABLE_NAME} WHERE collection_id NOT IN ('app-events', 'app-event-heads', 'app-event-checkpoints', 'app-event-retirements')`)
    tamper.close()
    const restored = await sqliteStore(path); opened.push(restored.store)
    expect(restored.store.session().draft).toBe("SQLite authority")
    expect(restored.store.collections.messages.get("message-long-turn-user")?.text).toBe("A retained question")
    expect(restored.store.collections.messages.get("message-long-turn-smithers")?.text).toEndWith("504,")
    expect((await restored.store.eventHistory()).head.streamId).toBe(accepted.head.streamId)
    expect((await restored.store.verifyState()).valid).toBe(true)
  }, 120_000)
})
