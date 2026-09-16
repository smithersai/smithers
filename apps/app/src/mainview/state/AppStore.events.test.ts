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
import { initialSession } from "./AppState"
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

const installProjectorFixture = async (storage: StorageApi, version: number) => {
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
  await store.compactEvents()
  const history = await store.eventHistory()
  const snapshot = structuredClone(history.checkpoint.snapshot)
  Object.assign(snapshot.sessions![0]!, { guide: { version: 3, sequence: "practice-v4", step: 1,
    completed: [], autoPaused: false, conversationOpen: false }, guideVisible: false })
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
  test("rotates retired guide checkpoints without losing materialized rows", async () => {
    const storage = memoryStorage()
    const old = await installProjectorFixture(storage, 1)
    const restored = await open(storage)
    const next = await restored.eventHistory()
    expect(next.head.projectorVersion).toBe(2)
    expect(next.checkpoint.projectorVersion).toBe(2)
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
    await installProjectorFixture(storage, 3)
    const before = storage.getItem(ENVELOPE_STORAGE_KEY)
    await expect(open(storage)).rejects.toEqual(new AppProjectorVersionError(3))
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
