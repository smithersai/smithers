import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { MemoryStore, Namespace } from "../src/index.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "400" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/memory SQLite state-machine & namespace isolation fuzz invariants", () => {
  it("MemoryStore facts CRUD enforces strict namespace isolation and exact model equivalence over real SQLite", async () => {
    const nsArb = Schema.Literals(["flow:alpha", "agent:beta"])
    const keyArb = Schema.Literals(["k1", "k2", "k3", "k4"])
    const opArb = Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("put"),
        ns: nsArb,
        key: keyArb,
        val: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50 })))
      }),
      Schema.Struct({
        _tag: Schema.Literal("get"),
        ns: nsArb,
        key: keyArb
      }),
      Schema.Struct({
        _tag: Schema.Literal("del"),
        ns: nsArb,
        key: keyArb
      })
    ])
    const arb = Arbitrary.schema(Schema.Array(opArb).pipe(Schema.check(Schema.isMaxLength(18))))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) =>
          Effect.gen(function*() {
            const store = yield* MemoryStore.MemoryStore
            const model = new Map<string, number>()
            const mk = (ns: string, k: string) => `${ns}\0${k}`
            const toNs = (ns: "flow:alpha" | "agent:beta"): Namespace.Namespace =>
              ns === "flow:alpha" ? { kind: "flow", id: "alpha" } : { kind: "agent", id: "beta" }

            for (const op of ops) {
              const namespace = toNs(op.ns)
              const key = mk(op.ns, op.key)
              if (op._tag === "put") {
                yield* store.putFact({
                  namespace,
                  key: op.key,
                  value: { v: op.val },
                  provenance: { runId: "fuzz-run" }
                })
                model.set(key, op.val)
              } else if (op._tag === "get") {
                const got = yield* store.getFact({ namespace, key: op.key })
                const exp = model.get(key)
                if (exp === undefined) {
                  if (got !== undefined) return false
                } else {
                  if (got === undefined) return false
                  const v = (got.value as { v?: number })?.v
                  if (v !== exp) return false
                }
              } else {
                yield* store.deleteFact({ namespace, key: op.key })
                model.delete(key)
              }
            }
            return true
          }).pipe(Effect.provide(TestMemory.layer)),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
