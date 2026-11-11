import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { TransactionSerializer } from "@tanstack/offline-transactions"
import { Schema } from "effect"
import { execFileSync } from "node:child_process"
import { expect, test } from "vitest"
import { Migrations } from "../src/index.ts"
import { decodeOutboxValue, encodeOutboxValue } from "../src/internal/outboxStored.ts"

const V1 = Schema.Struct({
  id: Schema.String,
  at: Schema.Date,
  data: Schema.optionalKey(Schema.Unknown),
  __type: Schema.String
})
const V2 = Schema.Struct({ ...V1.fields, migrated: Schema.Boolean })
const upgrade = Migrations.outbox(Migrations.registry({
  stores: [],
  outbox: {
    payloads: [Migrations.payload({
      key: "events",
      versions: [V1, V2],
      migrations: [Migrations.step(V1, V2, (row) => ({ ...row, migrated: true }))]
    })],
    mutations: ["save"]
  }
}))

const withStored = async (
  type: "insert" | "update" | "delete",
  data: unknown,
  check: (stored: string, serializer: TransactionSerializer) => void,
  metadata: Record<string, unknown> = { versions: { events: 1 } }
) => {
  const original = { id: "q", at: new Date(0), data, __type: "event" }
  const collection = createCollection(localOnlyCollectionOptions({
    id: crypto.randomUUID(),
    getKey: (row: typeof original) => row.id,
    initialData: type === "insert" ? [] : [original]
  }))
  await collection.preload()
  try {
    const transaction = type === "insert"
      ? collection.insert(original)
      : type === "delete"
      ? collection.delete("q")
      : collection.update("q", (row) => {
        row.at = new Date(1)
      })
    const serializer = new TransactionSerializer({ events: collection })
    const stored = serializer.serialize({
      id: "tx",
      version: 1,
      mutationFnName: "save",
      mutations: transaction.mutations,
      keys: ["events/q"],
      idempotencyKey: "q",
      createdAt: new Date(0),
      retryCount: 0,
      nextAttemptAt: 0,
      metadata
    })
    check(stored, serializer)
  } finally {
    await collection.cleanup()
  }
}

const upgraded = (stored: string) => {
  const result = upgrade.write(stored)
  expect(result._tag).toBe("Upgraded")
  if (result._tag !== "Upgraded") throw new Error("write was not upgraded")
  expect(upgrade.write(result.value)).toEqual({ _tag: "Current" })
  return result.value
}

test.each(["insert", "update", "delete"] as const)(
  "%s migrates Date rows and remains readable by the real transaction serializer",
  async (type) => {
    await withStored(type, { nested: [null, new Date(2)] }, (stored, serializer) => {
      const before = serializer.deserialize(stored)
      const encoded = upgraded(stored)
      const after = serializer.deserialize(encoded)
      const mutation = after.mutations[0]!
      expect(mutation.modified).toEqual({ ...before.mutations[0]!.modified, migrated: true })
      expect(mutation.modified.at).toBeInstanceOf(Date)
      expect(mutation.original).toEqual(type === "insert" ? {} : { ...before.mutations[0]!.original, migrated: true })
      expect(mutation.changes).toEqual(
        type === "update" ? { at: new Date(1) } : type === "delete" ? before.mutations[0]!.changes : mutation.modified
      )
      expect(after.metadata).toEqual({ versions: { events: 2 } })
      expect(JSON.parse(encoded).mutations[0].modified.value.at).toEqual({
        __type: "Date",
        value: (mutation.modified.at as Date).toISOString()
      })
    })
  }
)

test("marker-shaped user objects, including a row's own __type, remain data", async () => {
  const data = JSON.parse(
    "{\"__type\":\"Date\",\"value\":\"not a date\",\"nested\":{\"__type\":\"Object\",\"value\":{\"__proto__\":{\"safe\":true}}}}"
  )
  await withStored("update", data, (stored, serializer) => {
    const mutation = serializer.deserialize(upgraded(stored)).mutations[0]!
    expect(mutation.modified.data).toEqual(data)
    expect(Object.getPrototypeOf(mutation.modified.data)).toBe(Object.prototype)
    expect(Object.hasOwn((mutation.modified.data as { nested: { value: object } }).nested.value, "__proto__")).toBe(
      true
    )
  })
})

test("metadata values survive upgrading the payload versions", async () => {
  const metadata = { versions: { events: 1 }, __type: "custom", at: new Date(3) }
  await withStored("insert", null, (stored, serializer) => {
    expect(serializer.deserialize(upgraded(stored)).metadata).toEqual({ ...metadata, versions: { events: 2 } })
  }, metadata)
})

test.each([undefined, 2] as const)("legacy value encoding %s retains dates through migration", async (encoding) => {
  await withStored("insert", null, (stored, serializer) => {
    const legacy = JSON.parse(stored)
    delete legacy.valueEncoding
    if (encoding !== undefined) legacy.valueEncoding = encoding
    else {
      legacy.mutations[0].modified = legacy.mutations[0].modified.value
      legacy.mutations[0].changes = legacy.mutations[0].changes.value
    }
    const mutation = serializer.deserialize(upgraded(JSON.stringify(legacy))).mutations[0]!
    expect(mutation.modified.at).toEqual(new Date(0))
  })
})

test.each([
  { __type: "Date" },
  { __type: "Date", value: null },
  { __type: "Date", value: "invalid" },
  { __type: "Object", value: null },
  { __type: "Object", value: [] },
  { __type: "Temporal", type: "Temporal.Unknown", value: "invalid" },
  { __type: "Temporal", type: "Temporal.Instant", value: null },
  { __type: "Temporal", type: "Temporal.Instant", value: "invalid" }
])("an unreadable row marker is parked without throwing: %j", async (marker) => {
  await withStored("insert", null, (stored) => {
    const parsed = JSON.parse(stored)
    parsed.mutations[0].modified.value.data = marker
    expect(upgrade.write(JSON.stringify(parsed))).toEqual({ _tag: "Parked", reason: "decode" })
  })
})

const temporal = (globalThis as unknown as {
  readonly Temporal: Record<string, { readonly from: (value: string) => object }>
}).Temporal

test.each([
  ["Duration", "PT1S"],
  ["Instant", "2026-01-01T00:00:00Z"],
  ["PlainDate", "2026-01-01"],
  ["PlainDateTime", "2026-01-01T01:02:03"],
  ["PlainMonthDay", "01-02"],
  ["PlainTime", "01:02:03"],
  ["PlainYearMonth", "2026-01"],
  ["ZonedDateTime", "2026-01-01T00:00:00+00:00[UTC]"]
])("Temporal.%s survives the real serializer on both sides of a migration", async (name, text) => {
  const value = temporal[name]!.from(text)
  await withStored("insert", { values: [value] }, (stored, serializer) => {
    const after = (serializer.deserialize(upgraded(stored)).mutations[0]!.modified.data as { values: Array<object> })
      .values[0]!
    expect(Object.prototype.toString.call(after)).toBe(Object.prototype.toString.call(value))
    expect(after.toString()).toBe(value.toString())
  })
})

test("unmigrated rows and legacy metadata are re-encoded together when a name changes", async () => {
  await withStored("insert", null, (stored, serializer) => {
    const parsed = JSON.parse(stored)
    delete parsed.valueEncoding
    parsed.mutations[0].modified = parsed.mutations[0].modified.value
    parsed.mutations[0].changes = parsed.mutations[0].changes.value
    parsed.metadata.at = { __type: "Date", value: "literal metadata in the legacy format" }
    const current = Migrations.outbox(Migrations.registry({
      stores: [],
      outbox: {
        payloads: [Migrations.payload({ key: "events", versions: [V1] })],
        mutations: ["renamed"],
        renamed: { save: "renamed" }
      }
    }))
    const result = current.write(JSON.stringify(parsed))
    expect(result._tag).toBe("Upgraded")
    if (result._tag !== "Upgraded") throw new Error("write was not upgraded")
    const after = serializer.deserialize(result.value)
    expect(after.mutations[0]!.modified.at).toEqual(new Date(0))
    expect(after.metadata).toEqual(parsed.metadata)
    expect(after.mutationFnName).toBe("renamed")
  })
})

test("a Date introduced by the migration is encoded even when the old rows had no markers", () => {
  const Plain = Schema.Struct({ id: Schema.String })
  const Dated = Schema.Struct({ id: Schema.String, at: Schema.Date })
  const dateUpgrade = Migrations.outbox(Migrations.registry({
    stores: [],
    outbox: {
      payloads: [Migrations.payload({
        key: "events",
        versions: [Plain, Dated],
        migrations: [Migrations.step(Plain, Dated, (row) => ({ ...row, at: new Date(0) }))]
      })],
      mutations: ["save"]
    }
  }))
  const result = dateUpgrade.write(JSON.stringify({
    mutationFnName: "save",
    mutations: [{ collectionId: "events", type: "insert", modified: { id: "q" }, original: {}, changes: { id: "q" } }],
    metadata: { versions: { events: 1 } }
  }))
  expect(result._tag).toBe("Upgraded")
  if (result._tag !== "Upgraded") throw new Error("write was not upgraded")
  expect(JSON.parse(result.value).mutations[0].modified.at).toEqual({
    __type: "Date",
    value: new Date(0).toISOString()
  })
})

test("an unknown transaction encoding is parked before it can be rewritten", async () => {
  await withStored("insert", null, (stored) => {
    const parsed = JSON.parse(stored)
    parsed.valueEncoding = 4
    expect(upgrade.write(JSON.stringify(parsed))).toEqual({ _tag: "Parked", reason: "unreadable" })
  })
})

test("a migration returning a value the serializer cannot store is parked", async () => {
  await withStored("insert", null, (stored) => {
    const invalid = Migrations.outbox(Migrations.registry({
      stores: [],
      outbox: {
        payloads: [Migrations.payload({
          key: "events",
          versions: [V1, V2],
          migrations: [Migrations.step(V1, V2, (row) => ({ ...row, data: new Date(Number.NaN), migrated: true }))]
        })],
        mutations: ["save"]
      }
    }))
    expect(invalid.write(stored)).toEqual({ _tag: "Parked", reason: "invalid" })
  })
})

test("nested value combinations round-trip in both directions with the real serializer", async () => {
  class TaggedUserObject {
    readonly value = "user data"
    get [Symbol.toStringTag]() {
      return "Temporal.Instant"
    }
  }
  class OtherUserObject {
    get [Symbol.toStringTag]() {
      return "custom"
    }
  }
  const corpus = [
    undefined,
    null,
    false,
    0,
    "text",
    new Date(0),
    temporal.Instant!.from("2026-01-01T00:00:00Z"),
    new TaggedUserObject(),
    new OtherUserObject(),
    new Number(1),
    Object.assign(Object.create(null), { x: 1 }),
    { __type: null },
    { __type: "Object", value: { __type: "Date", value: "user data" } },
    { __type: "unknown", value: new Date(2) },
    JSON.parse("{\"__proto__\":{\"__type\":\"Date\",\"value\":\"user data\"}}")
  ]
  for (const data of corpus.flatMap((value) => [value, [value], { nested: [value] }])) {
    await withStored("insert", data, (stored, serializer) => {
      const parsed = JSON.parse(stored)
      const row = serializer.deserialize(stored).mutations[0]!.modified
      expect(JSON.parse(JSON.stringify(encodeOutboxValue({ id: "q", at: new Date(0), data, __type: "event" }))))
        .toEqual(parsed.mutations[0].modified)
      expect(JSON.parse(JSON.stringify(encodeOutboxValue(row)))).toEqual(parsed.mutations[0].modified)
      expect(decodeOutboxValue(parsed.mutations[0].modified, 3)).toEqual(row)
      const encoded = upgraded(stored)
      expect(serializer.deserialize(encoded).mutations[0]!.modified).toEqual({ ...row, migrated: true })
    })
  }
})

test("a host without Temporal refuses to decode or encode Temporal values", () => {
  const module = new URL("../src/internal/outboxStored.ts", import.meta.url).href
  execFileSync(process.execPath, [
    "--no-harmony-temporal",
    "--input-type=module",
    "-e",
    `
    import assert from "node:assert/strict"
    import { decodeOutboxValue, encodeOutboxValue } from ${JSON.stringify(module)}
    assert.equal(typeof globalThis.Temporal, "undefined")
    assert.throws(() => decodeOutboxValue({
      __type: "Temporal", type: "Temporal.Instant", value: "2026-01-01T00:00:00Z"
    }, 3), TypeError)
    class Tagged { get [Symbol.toStringTag]() { return "Temporal.Instant" } }
    assert.throws(() => encodeOutboxValue(new Tagged()), TypeError)
  `
  ])
})

test("Temporal markers in older encodings retain their original object meaning", () => {
  const value = { __type: "Temporal", type: "Temporal.Instant", value: "user data" }
  expect(decodeOutboxValue(value, undefined)).toEqual(value)
  expect(decodeOutboxValue(value, 2)).toEqual(value)
})
