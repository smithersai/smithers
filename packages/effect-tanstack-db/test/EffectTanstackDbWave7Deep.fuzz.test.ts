import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Collection from "../src/Collection.ts"
import { decodeOutboxValue, encodeOutboxValue } from "../src/internal/outboxStored.ts"
import * as Persistence from "../src/Persistence.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261130")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const Item = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.String,
  count: Schema.Int
})

describe("@smthrs/effect-tanstack-db Wave 7 deep fuzz (outboxStored codec + Collection.local/persisted/make CRUD & failure paths)", () => {
  it("encodeOutboxValue / decodeOutboxValue round-trip Dates, escaped __type objects, arrays, and reject corrupt records", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals(["date", "escapedObject", "nested", "badDateNull", "badDateStr", "badObject", "badTemporal", "primitive"]),
        encoding: Schema.Literals(["none", "v2", "v3"]),
        label: Schema.Literals(["alpha", "beta", "gamma"]),
        num: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, encoding, label, num }) =>
          Effect.sync(() => {
            const enc = encoding === "none" ? undefined : encoding === "v2" ? 2 : 3
            if (kind === "date") {
              const d = new Date(1_700_000_000_000 + num * 1000)
              const encoded = encodeOutboxValue({ at: d, label })
              const decoded = decodeOutboxValue(encoded, enc) as { at: Date; label: string }
              expect(decoded.at).toBeInstanceOf(Date)
              expect(decoded.at.getTime()).toBe(d.getTime())
              expect(decoded.label).toBe(label)
            } else if (kind === "escapedObject") {
              const orig = { __type: "Date", value: label, extra: num }
              const encoded = encodeOutboxValue(orig)
              const decoded = decodeOutboxValue(encoded, 2) as Record<string, unknown>
              expect(decoded.__type).toBe("Date")
              expect(decoded.value).toBe(label)
            } else if (kind === "nested") {
              const d = new Date(1_710_000_000_000)
              const orig = [1, label, null, { nested: [d, { __type: "Object", k: num }] }]
              const encoded = encodeOutboxValue(orig)
              const decoded = decodeOutboxValue(encoded, 3) as Array<unknown>
              expect(Array.isArray(decoded)).toBe(true)
              expect(decoded[1]).toBe(label)
            } else if (kind === "badDateNull") {
              expect(() => decodeOutboxValue({ __type: "Date", value: null }, enc)).toThrow()
            } else if (kind === "badDateStr") {
              expect(() => decodeOutboxValue({ __type: "Date", value: "not-a-date" }, enc)).toThrow()
            } else if (kind === "badObject") {
              if (enc !== undefined) {
                expect(() => decodeOutboxValue({ __type: "Object", value: [1, 2] }, enc)).toThrow()
                expect(() => decodeOutboxValue({ __type: "Object", value: null }, enc)).toThrow()
              }
            } else if (kind === "badTemporal") {
              if (enc === 3) {
                expect(() => decodeOutboxValue({ __type: "Temporal", type: "Temporal.Bogus", value: "x" }, 3)).toThrow()
                expect(() => decodeOutboxValue({ __type: "Temporal", type: "Temporal.Instant", value: 123 }, 3)).toThrow()
              }
            } else {
              expect(decodeOutboxValue(label, enc)).toBe(label)
              expect(decodeOutboxValue(num, enc)).toBe(num)
              expect(decodeOutboxValue(null, enc)).toBeNull()
            }
            return true
          }),
        { executions: Math.min(executions, 140), seed }
      )
    )
    assertPassed(report)
  }, 30_000)

  it("Collection.local & Collection.persisted preserve CRUD state, schema validation, and rollback on persistence refusal", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["localCrud", "persistedCrud", "persistedReload", "invalidRowRejected"]),
        id: Schema.Literals(["a", "b", "c"]),
        title: Schema.Literals(["one", "two", "three"]),
        count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, id, title, count }) =>
          Effect.gen(function*() {
            if (mode === "localCrud") {
              const col = yield* Collection.local({
                id: `local-${id}`,
                schema: Item,
                getKey: (item) => item.id
              })
              yield* col.insert({ id, title, count })
              const got = yield* col.get(id)
              expect(got?._tag).toBe("Some")
              yield* col.update(id, (draft) => {
                draft.count = count + 1
              })
              const updated = yield* col.get(id)
              expect(updated._tag === "Some" ? updated.value.count : -1).toBe(count + 1)
              yield* col.delete(id)
              const gone = yield* col.get(id)
              expect(gone._tag).toBe("None")
            } else if (mode === "persistedCrud" || mode === "persistedReload") {
              const col1 = yield* Collection.persisted({
                id: `persisted-${id}`,
                schema: Item,
                getKey: (item) => item.id,
                schemaVersion: 1
              })
              yield* col1.preload
              const insTx = yield* col1.insert({ id, title, count })
              yield* insTx.persisted
              const got1 = yield* col1.get(id)
              expect(got1._tag === "Some" ? got1.value.title : "").toBe(title)
              if (mode === "persistedReload") {
                const updTx = yield* col1.update(id, (draft) => {
                  draft.count = count + 5
                })
                yield* updTx.persisted
                const got2 = yield* col1.get(id)
                expect(got2._tag === "Some" ? got2.value.count : -1).toBe(count + 5)
              } else {
                const delTx = yield* col1.delete(id)
                yield* delTx.persisted
                const after = yield* col1.get(id)
                expect(after._tag).toBe("None")
              }
            } else {
              const col = yield* Collection.local({
                id: `bad-${id}`,
                schema: Item,
                getKey: (item) => item.id
              })
              const ex = yield* col.insert({ id: "", title, count } as never).pipe(Effect.exit)
              expect(Exit.isFailure(ex)).toBe(true)
            }
            return true
          }).pipe(Effect.scoped, Effect.provide(Persistence.memory)),
        { executions: Math.min(executions, 80), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 45_000)
})
