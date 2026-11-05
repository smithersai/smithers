import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { Migrations } from "../src/index.ts"

// The lock: each store's schema fingerprint by version, so a schema that changes without a new version, an old
// version's schema that is edited, or a store that disappears fails a test before it reaches a device.

const V1 = Schema.Struct({ id: Schema.String, text: Schema.String })
const V2 = Schema.Struct({ id: Schema.String, text: Schema.String, n: Schema.Number })
const V2Changed = Schema.Struct({ id: Schema.String, text: Schema.String, n: Schema.String })
const toV2 = Migrations.step(V1, V2, (row) => ({ ...row, n: 0 }))

const local = (versions: 1 | 2, schema2: Migrations.Row<{ readonly id: string }> = V2) =>
  versions === 1
    ? Migrations.local({ id: "drafts", versions: [V1], getKey: (row) => row.id })
    : Migrations.local({
      id: "drafts",
      versions: [V1, schema2],
      migrations: [Migrations.step(V1, schema2, (row) => ({ ...row, n: schema2 === V2 ? 0 : "0" }))],
      getKey: (row) => row.id
    })

const registry = (options: {
  readonly drafts?: Migrations.Local<any, any>
  readonly messages?: Migrations.Synced<any>
  readonly payload?: Migrations.Payload<any>
  readonly mutations?: ReadonlyArray<string>
  readonly retired?: ReadonlyArray<Migrations.Retired>
  readonly renamed?: Readonly<Record<string, string>>
  readonly retiredMutations?: ReadonlyArray<string>
}) =>
  Migrations.registry({
    stores: [
      ...(options.drafts === undefined ? [] : [options.drafts]),
      ...(options.messages === undefined ? [] : [options.messages])
    ],
    retired: options.retired ?? [],
    outbox: {
      payloads: options.payload === undefined ? [] : [options.payload],
      mutations: options.mutations ?? [],
      ...(options.renamed === undefined ? {} : { renamed: options.renamed }),
      ...(options.retiredMutations === undefined ? {} : { retired: options.retiredMutations })
    }
  })

const messages = (version: number, schema: Schema.Codec<any, any> = V1) =>
  Migrations.synced({ id: "messages", version, schema, family: true })
const asking = (versions: 1 | 2) =>
  versions === 1
    ? Migrations.payload({ key: "asking", versions: [V1] })
    : Migrations.payload({ key: "asking", versions: [V1, V2], migrations: [toV2] })

const recorded = (from: Migrations.Registry, previous?: Migrations.Lock) => {
  const result = Migrations.lock(from, previous)
  expect(result.refused).toEqual([])
  return result.lock
}

describe("fingerprint", () => {
  test("is the same for schemas that check rows alike, and differs when a field changes", () => {
    const again = Schema.Struct({ text: Schema.String, id: Schema.String })
    expect(Migrations.fingerprint(V1)).toBe(Migrations.fingerprint(again))
    expect(Migrations.fingerprint(V1)).toMatch(/^[0-9a-f]{16}$/)
    expect(Migrations.fingerprint(V2)).not.toBe(Migrations.fingerprint(V2Changed))
    expect(Migrations.fingerprint(Schema.Array(V1))).not.toBe(Migrations.fingerprint(V1))
  })
})

describe("the lock", () => {
  const base = registry({ drafts: local(1), messages: messages(1), payload: asking(1), mutations: ["ask"] })

  test("records every version of every store, payload and mutation name; a registry matching it has no problem", () => {
    const lock = recorded(base)
    expect(lock).toEqual({
      epoch: 3,
      stores: {
        drafts: { kind: "local", versions: { 1: Migrations.fingerprint(V1) } },
        messages: { kind: "synced", versions: { 1: Migrations.fingerprint(V1) } }
      },
      payloads: { asking: { kind: "payload", versions: { 1: Migrations.fingerprint(V1) } } },
      mutations: ["ask"]
    })
    expect(Migrations.check(base, lock)).toEqual([])
  })

  test("without a lock, every store is unrecorded", () => {
    expect(Migrations.check(base, undefined)).toEqual([
      { store: "drafts", problem: "unrecorded", version: 1 },
      { store: "messages", problem: "unrecorded", version: 1 },
      { store: "asking", problem: "unrecorded", version: 1 }
    ])
  })

  test("fails a schema that changed without a new version, and refuses to record it", () => {
    const lock = recorded(registry({ drafts: local(2), messages: messages(1) }))
    const changed = registry({ drafts: local(2, V2Changed), messages: messages(1, V2) })
    const problems = [
      { store: "drafts", problem: "changed_without_version", version: 2 },
      { store: "messages", problem: "changed_without_version", version: 1 }
    ]
    expect(Migrations.check(changed, lock)).toEqual(problems)
    const { lock: next, refused } = Migrations.lock(changed, lock)
    expect(refused).toEqual(problems)
    // Recording never rewrites a fingerprint.
    expect(next.stores["drafts"]?.versions["2"]).toBe(Migrations.fingerprint(V2))
  })

  test("a new version is unrecorded until the lock records it, beside the versions before it", () => {
    const lock = recorded(base)
    const bumped = registry({ drafts: local(2), messages: messages(2, V2), payload: asking(2), mutations: ["ask"] })
    expect(Migrations.check(bumped, lock)).toEqual([
      { store: "drafts", problem: "unrecorded", version: 2 },
      { store: "messages", problem: "unrecorded", version: 2 },
      { store: "asking", problem: "unrecorded", version: 2 }
    ])
    const next = recorded(bumped, lock)
    expect(next.stores["messages"]?.versions).toEqual({ 1: Migrations.fingerprint(V1), 2: Migrations.fingerprint(V2) })
    expect(next.epoch).toBe(6)
    expect(Migrations.check(bumped, next)).toEqual([])
  })

  test("fails an older version whose schema was edited, a version that went back and a store that changed kind", () => {
    const lock = recorded(registry({ drafts: local(2), messages: messages(2) }))
    const EditedV1 = Schema.Struct({ id: Schema.String })
    const edited = Migrations.local({
      id: "drafts",
      versions: [EditedV1, V2],
      migrations: [Migrations.step(EditedV1, V2, (row) => ({ ...row, text: "", n: 0 }))],
      getKey: (row) => row.id
    })
    expect(Migrations.check(registry({ drafts: edited, messages: messages(2) }), lock)).toEqual([
      { store: "drafts", problem: "history_changed", version: 1 }
    ])
    expect(Migrations.check(registry({ drafts: local(1), messages: messages(2) }), lock)).toEqual([
      { store: "drafts", problem: "version_went_back", version: 1 }
    ])
    const asSynced = Migrations.synced({ id: "drafts", version: 2, schema: V2 })
    expect(Migrations.check(Migrations.registry({ stores: [asSynced, messages(2)] }), lock)).toEqual([
      { store: "drafts", problem: "kind_changed" }
    ])
  })

  test("fails a store, payload or mutation name that disappeared, unless it was retired or renamed", () => {
    const lock = recorded(registry({ drafts: local(1), payload: asking(1), mutations: ["ask", "save"] }))
    expect(Migrations.check(registry({ mutations: [] }), lock)).toEqual([
      { store: "drafts", problem: "removed" },
      { store: "asking", problem: "removed" },
      { store: "ask", problem: "mutation_removed" },
      { store: "save", problem: "mutation_removed" }
    ])
    const declared = registry({
      payload: asking(1),
      retired: [Migrations.retired({ id: "drafts", kind: "local", version: 1 })],
      mutations: ["ask.v2"],
      renamed: { ask: "ask.v2" },
      retiredMutations: ["save"]
    })
    expect(Migrations.check(declared, lock).filter(({ problem }) => problem !== "unrecorded")).toEqual([])
    const next = recorded(declared, lock)
    expect(next.stores["drafts"]).toEqual({ kind: "local", versions: { 1: Migrations.fingerprint(V1) }, retired: true })
    expect(next.mutations).toEqual(["ask.v2"])
    // A retired store stays in the lock, so dropping its declaration later is still no problem.
    expect(Migrations.check(registry({ payload: asking(1), mutations: ["ask.v2"] }), next)).toEqual([])
  })

  test("records a store retired before the lock knew it", () => {
    const next = recorded(registry({ retired: [Migrations.retired({ id: "old", kind: "synced", version: 4 })] }))
    expect(next.stores["old"]).toEqual({ kind: "synced", versions: {}, retired: true })
  })
})

describe("persisted snapshots", () => {
  test("omits the derived epoch, sorts stores and mutations, and keeps all historical versions", () => {
    const legacy: Migrations.Lock = {
      epoch: 99,
      stores: {
        z: { kind: "synced", versions: { "10": "new", "2": "old" } },
        a: { kind: "local", retired: true, versions: { "1": "kept" } }
      },
      payloads: { z: { kind: "payload", versions: { "1": "payload" } }, a: { kind: "payload", versions: {} } },
      mutations: ["save", "ask", "save"]
    }
    const result = Migrations.snapshot(legacy)
    expect(result).not.toHaveProperty("epoch")
    expect(Object.keys(result.stores)).toEqual(["a", "z"])
    expect(Object.keys(result.payloads)).toEqual(["a", "z"])
    expect(result.stores["a"]).toEqual(legacy.stores["a"])
    expect(result.stores["z"]?.versions).toEqual({ "2": "old", "10": "new" })
    expect(result.mutations).toEqual(["ask", "save"])
    expect(Migrations.snapshot(result)).toEqual(result)
    expect(legacy.epoch).toBe(99)
    expect(legacy.mutations).toEqual(["save", "ask", "save"])
  })

  test("accepts new and legacy snapshots without weakening schema checks", () => {
    const declared = registry({ drafts: local(1), payload: asking(1), mutations: ["ask"] })
    const legacy = recorded(declared)
    const stored = Migrations.snapshot(legacy)
    expect(Migrations.check(declared, stored)).toEqual([])
    expect(Migrations.lock(declared, stored).lock).toEqual(legacy)
    const changed = registry({ drafts: local(2), payload: asking(1), mutations: ["ask"] })
    expect(Migrations.check(changed, stored)).toEqual([{ store: "drafts", problem: "unrecorded", version: 2 }])
    expect(Migrations.check(changed, legacy)).toEqual(Migrations.check(changed, stored))
  })
})
