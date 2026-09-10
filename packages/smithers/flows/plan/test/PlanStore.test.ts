import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as Plan from "../src/Plan.ts"
import * as PlanStore from "../src/PlanStore.ts"
import { withCrypto } from "./Crypto.ts"
import { compile, draft } from "./PlanFixtures.ts"

const stores = Layer.provideMerge(PlanStore.layer, Layer.provideMerge(Migrations.layer, TestDatabase.layer))

const withStore = <A, E>(
  use: (store: PlanStore.Service) => Effect.Effect<A, E, SqlClient.SqlClient>
) =>
  withCrypto(
    Effect.flatMap(PlanStore.PlanStore, use).pipe(Effect.provide(stores)) as Effect.Effect<A, E, never>
  )

/** The message SQLite's `RAISE(ABORT, ...)` carried, through the SqlError. */
const raised = (error: unknown): string =>
  (error as { readonly reason?: { readonly cause?: { readonly message?: string } } }).reason?.cause?.message ??
    String(error)

const samplePlan = () =>
  compile([
    draft("root", { writes: ["out"] }),
    draft("child", { inputs: [{ _tag: "Ref", from: "root", path: [] }] })
  ])

describe("PlanStore", () => {
  it.effect("records a plan and reads it back node for node", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const { read, recorded } = yield* withStore((store) =>
        Effect.gen(function*() {
          const recorded = yield* store.record(plan, 1)
          const read = yield* store.get(plan.planId)
          return { read, recorded }
        })
      )
      expect(recorded).toEqual({ _tag: "Recorded" })
      expect(Option.getOrThrow(read)).toEqual(plan)
    }))

  it.effect("is first-writer-wins: an identical re-record is not an error, a different one is a conflict", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const other = yield* withCrypto(compile([draft("root", { body: { seed: 9 } })]))
      const { conflict, same } = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(plan, 1)
          const same = yield* store.record(plan, 2)
          const conflict = yield* store.record({ ...other, planId: plan.planId }, 3)
          return { conflict, same }
        })
      )
      expect(same).toEqual({ _tag: "ExistingSame" })
      expect(conflict).toEqual({ _tag: "Conflict", digest: plan.digest })
    }))

  it.effect("appends an elaborated subgraph and advances the digest", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(samplePlan())
      const grown = yield* withCrypto(
        Plan.append(base, [draft("late", { inputs: [{ _tag: "Pending", from: "child" }] })])
      )
      const read = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          yield* store.append(grown)
          return yield* store.get(base.planId)
        })
      )
      expect(Option.getOrThrow(read)).toEqual(grown)
    }))

  it.effect("refuses a divergent branch and rolls the attempted append back byte for byte", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const planA = yield* withCrypto(Plan.append(base, [draft("a")]))
      const planB = yield* withCrypto(Plan.append(base, [draft("b")]))
      const planB2 = yield* withCrypto(Plan.append(planB, [
        draft("c", { inputs: [{ _tag: "Ref", from: "b", path: [] }] })
      ]))
      const { after, afterCount, before, beforeCount, failure } = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(base, 1)
          yield* store.append(planA)
          const before = yield* store.get(base.planId)
          const beforeRows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`
          const failure = yield* Effect.flip(store.append(planB2))
          const after = yield* store.get(base.planId)
          const afterRows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`
          return {
            after,
            afterCount: afterRows[0]!.count,
            before,
            beforeCount: beforeRows[0]!.count,
            failure
          }
        })
      )

      expect(failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} recorded plan's nodes diverge from the plan this append was grown from`
      })
      expect(after).toEqual(before)
      expect(afterCount).toBe(beforeCount)
    }))

  it.effect("refuses a same-key priority-divergent prefix and rolls the append back byte for byte", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const branchA = yield* withCrypto(Plan.append(base, [draft("a", { priority: 1 })]))
      const branchB = yield* withCrypto(Plan.append(base, [draft("a", { priority: 2 })]))
      const branchB2 = yield* withCrypto(Plan.append(branchB, [
        draft("c", { inputs: [{ _tag: "Ref", from: "a", path: [] }] })
      ]))
      expect(branchA.nodes[1]!.key).toBe(branchB.nodes[1]!.key)

      const result = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(base, 1)
          yield* store.append(branchA)
          const beforePlan = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${base.planId}
          `
          const beforeNodes = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plan_nodes WHERE plan_id = ${base.planId} ORDER BY ordinal
          `
          const failure = yield* Effect.flip(store.append(branchB2))
          const afterPlan = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${base.planId}
          `
          const afterNodes = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plan_nodes WHERE plan_id = ${base.planId} ORDER BY ordinal
          `
          return { afterNodes, afterPlan, beforeNodes, beforePlan, failure }
        })
      )

      expect(result.failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} recorded plan's nodes diverge from the plan this append was grown from`
      })
      expect(result.afterPlan).toEqual(result.beforePlan)
      expect(result.afterNodes).toEqual(result.beforeNodes)
      expect(result.afterPlan[0]).toMatchObject({ digest: branchA.digest, generation: 1 })
    }))

  it.effect("refuses a skipped generation and rolls the attempted append back byte for byte", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("a")]))
      const generation1 = yield* withCrypto(Plan.append(base, [draft("b")]))
      const generation2 = yield* withCrypto(Plan.append(generation1, [
        draft("c", { inputs: [{ _tag: "Ref", from: "b", path: [] }] })
      ]))
      const { after, before, failure } = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          const before = yield* store.get(base.planId)
          const failure = yield* Effect.flip(store.append(generation2))
          const after = yield* store.get(base.planId)
          return { after, before, failure }
        })
      )

      expect(failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} was never recorded, or generation 2 was skipped or moved under the append`
      })
      expect(after).toEqual(before)
    }))

  it.effect("stores successive append ordinals contiguously in plan order", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("a"), draft("b")]))
      const generation1 = yield* withCrypto(Plan.append(base, [draft("c"), draft("d")]))
      const generation2 = yield* withCrypto(Plan.append(generation1, [
        draft("e", { inputs: [{ _tag: "Pending", from: "d" }] })
      ]))
      const rows = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          yield* store.append(generation1)
          yield* store.append(generation2)
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ node_id: string; ordinal: number }>`
            SELECT node_id, ordinal FROM flows_plan_nodes
            WHERE plan_id = ${base.planId}
            ORDER BY ordinal
          `
        })
      )

      expect(rows).toEqual(generation2.nodes.map((node, ordinal) => ({ node_id: node.id, ordinal })))
    }))

  it.effect("returns none for a plan that was never recorded", () =>
    Effect.gen(function*() {
      expect(yield* withStore((store) => store.get("absent"))).toEqual(Option.none())
    }))

  it.effect("refuses to append to a plan that was never recorded, and leaves no orphan rows", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(samplePlan())
      const grown = yield* withCrypto(
        Plan.append(base, [draft("late", { inputs: [{ _tag: "Pending", from: "child" }] })])
      )
      const { failure, orphans } = yield* withStore((store) =>
        Effect.gen(function*() {
          // The UPDATE matches nothing while the node inserts succeed, so
          // without the check this wrote a generation of a plan that does not
          // exist — and the append-only triggers mean those rows could never be
          // taken back out again.
          const failure = yield* Effect.flip(store.append(grown))
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{ n: number }>`SELECT count(*) AS n FROM flows_plan_nodes`
          return { failure, orphans: rows[0]!.n }
        })
      )
      expect(failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} was never recorded, or generation 1 was skipped or moved under the append`
      })
      expect(orphans).toBe(0)
    }))

  it.effect("refuses every non-generation-zero record shape with an exact invalid_plan error", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const grown = yield* withCrypto(Plan.append(base, [draft("late")]))
      const other = yield* withCrypto(compile([draft("other")], "other-plan"))
      const wrongBase: Plan.Plan = { ...base, baseDigest: other.digest }
      const wrongNode: Plan.Plan = {
        ...base,
        nodes: [{ ...base.nodes[0]!, generation: 1 }]
      }
      const [grownFailure, baseFailure, nodeFailure] = yield* withStore((store) =>
        Effect.all([
          Effect.flip(store.record(grown, 1)),
          Effect.flip(store.record(wrongBase, 1)),
          Effect.flip(store.record(wrongNode, 1))
        ], { concurrency: 1 })
      )

      expect(grownFailure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} has generation 1; record requires generation 0`
      })
      expect(baseFailure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} has base digest ${other.digest}, but generation 0 digest is ${base.digest}`
      })
      expect(nodeFailure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} node root has generation 1; record requires node generation 0`
      })
    }))

  it.effect("refuses an append whose newest generation has no nodes", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const empty: Plan.Plan = { ...base, generation: 1 }
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          return yield* Effect.flip(store.append(empty))
        })
      )

      expect(failure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} generation 1 has no nodes to append`
      })
    }))

  it.effect("refuses a value that is not a plan", () =>
    Effect.gen(function*() {
      const failure = yield* withStore((store) =>
        Effect.flip(
          store.record(
            { planId: "", flow: "f", generation: 0, baseDigest: "x", digest: "x", nodes: [] } as unknown as Plan.Plan,
            1
          )
        )
      )
      expect(failure).toMatchObject({ code: "invalid_plan" })
    }))

  it.effect("refuses an append that re-inserts a node id the plan already holds", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const forged: Plan.Plan = {
        ...plan,
        generation: 1,
        nodes: [...plan.nodes, { ...plan.nodes[0]!, generation: 1 }]
      }
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(plan, 1)
          // Persistence verifies imported plans before any SQL mutation.
          return yield* Effect.flip(store.append(forged))
        })
      )
      expect(failure).toMatchObject({ code: "invalid_plan" })
    }))

  it.effect("raises when a recorded node row is rewritten or deleted", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failures = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          const update = yield* Effect.flip(sql`UPDATE flows_plan_nodes SET kind = 'agent'`)
          const remove = yield* Effect.flip(sql`DELETE FROM flows_plan_nodes`)
          const edge = yield* Effect.flip(sql`UPDATE flows_plan_edges SET to_node = 'x'`)
          const edgeDelete = yield* Effect.flip(sql`DELETE FROM flows_plan_edges`)
          const backwards = yield* Effect.flip(sql`UPDATE flows_plans SET generation = 0`)
          return [update, remove, edge, edgeDelete, backwards].map(raised)
        })
      )
      expect(failures.filter((message) => message.includes("append-only")).length).toBe(4)
      expect(failures[4]).toBe("a plan only grows")
    }))

  it.effect("refuses deleting a recorded plan row", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          return yield* Effect.flip(sql`DELETE FROM flows_plans WHERE plan_id = ${plan.planId}`)
        })
      )

      expect(raised(failure)).toBe("flows_plans is append-only")
    }))

  it.effect("refuses rewriting a recorded plan's flow, creation time, or base digest as it moves forward", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const other = yield* withCrypto(compile([draft("other")], "other-plan"))
      const grown = yield* withCrypto(Plan.append(plan, [draft("late")]))
      const { after, baseDigest, before, createdAt, flow, forward } = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          const before = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${plan.planId}
          `
          // Each mutation ALSO advances the generation, so the forward-only
          // predicate cannot be what rejects it and only the field's own guard
          // can. Without the advance all three statements are refused by
          // `NEW.generation <= OLD.generation` alone and still pass with the
          // flow, creation-time, and base-digest guards deleted.
          const flow = yield* Effect.flip(sql`
            UPDATE flows_plans SET flow = 'other/Flow', generation = generation + 1
            WHERE plan_id = ${plan.planId}
          `)
          const createdAt = yield* Effect.flip(sql`
            UPDATE flows_plans SET created_at_ms = 2, generation = generation + 1
            WHERE plan_id = ${plan.planId}
          `)
          const baseDigest = yield* Effect.flip(sql`
            UPDATE flows_plans SET base_digest = ${other.digest}, generation = generation + 1
            WHERE plan_id = ${plan.planId}
          `)
          const after = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${plan.planId}
          `
          // The control: the one UPDATE the schema exists to admit. A guard
          // wide enough to catch the three above must still let this through.
          yield* sql`
            UPDATE flows_plans SET digest = ${grown.digest}, generation = generation + 1
            WHERE plan_id = ${plan.planId}
          `
          const forward = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${plan.planId}
          `
          return { after, baseDigest, before, createdAt, flow, forward }
        })
      )

      expect(raised(flow)).toBe("a plan only grows")
      expect(raised(createdAt)).toBe("a plan only grows")
      expect(raised(baseDigest)).toBe("a plan only grows")
      // Not just the raise: no refused statement left a field behind.
      expect(after).toEqual(before)
      expect(forward).toEqual([{ ...before[0], digest: grown.digest, generation: 1 }])
    }))

  it.effect("refuses rewriting a plan id during a forward update and preserves the row", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const { after, before, failure } = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          const before = yield* sql<Record<string, unknown>>`
            SELECT * FROM flows_plans WHERE plan_id = ${plan.planId}
          `
          const failure = yield* Effect.flip(sql`
            UPDATE flows_plans
            SET plan_id = 'stolen', generation = generation + 1, digest = 'd1'
            WHERE plan_id = ${plan.planId}
          `)
          const after = yield* sql<Record<string, unknown>>`SELECT * FROM flows_plans`
          return { after, before, failure }
        })
      )

      expect(raised(failure)).toBe("a plan only grows")
      expect(after).toEqual(before)
    }))

  it.effect("refuses two nodes with the same plan ordinal", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          return yield* Effect.flip(sql`
            INSERT INTO flows_plan_nodes (
              plan_id, node_id, generation, ordinal, kind, key_digest, node_json
            )
            SELECT plan_id, 'duplicate-ordinal', generation, ordinal, kind, key_digest, node_json
            FROM flows_plan_nodes
            WHERE plan_id = ${plan.planId} AND node_id = 'root'
          `)
        })
      )

      expect(raised(failure)).toBe(
        "UNIQUE constraint failed: flows_plan_nodes.plan_id, flows_plan_nodes.ordinal"
      )
    }))

  it.effect("reports an undecodable node row rather than returning a broken plan", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          yield* sql`DROP TRIGGER flows_plan_nodes_append_only`
          yield* sql`UPDATE flows_plan_nodes SET node_json = '{"id":"broken"}'`
          return yield* Effect.flip(store.get(plan.planId))
        })
      )
      expect(failure).toMatchObject({ code: "decode_failed", message: expect.stringContaining("flows_plan_nodes") })
    }))

  it.effect("reports an undecodable plan row rather than returning a broken plan", () =>
    Effect.gen(function*() {
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          // Every `flows_plans` CHECK holds — the digests are nonempty strings
          // — so SQLite admits this row. They are still not `StoredKey`s,
          // which is the syntax the envelope decoder requires, so the schema's
          // constraints do not make this branch unreachable.
          yield* sql`
            INSERT INTO flows_plans (plan_id, flow, base_digest, digest, generation, created_at_ms)
            VALUES ('malformed', 'example/Build', 'x', 'x', 0, 1)
          `
          return yield* Effect.flip(store.get("malformed"))
        })
      )
      expect(failure).toMatchObject({ code: "decode_failed", message: "could not decode flows_plans row" })
    }))

  it.effect("refuses a node the encoder cannot serialize", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const forged: Plan.Plan = {
        ...plan,
        nodes: [{ ...plan.nodes[0]!, material: { ...plan.nodes[0]!.material, body: 1n } }]
      }
      const failure = yield* withStore((store) => Effect.flip(store.record(forged, 1)))
      expect(failure).toMatchObject({ code: "invalid_plan" })
    }))

  it.effect("maps a missing table to a persistence failure", () =>
    Effect.gen(function*() {
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`DROP TABLE flows_plans`
          return yield* Effect.flip(store.get("anything"))
        })
      )
      expect(failure).toMatchObject({ code: "persistence_failed" })
    }))

  it.effect("reports a stored envelope digest that drifted from its rows as decode_failed on append", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const other = yield* withCrypto(compile([draft("other")], "other-plan"))
      const grown = yield* withCrypto(Plan.append(base, [draft("late")]))
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(base, 1)
          yield* sql`DROP TRIGGER flows_plans_forward_only`
          yield* sql`UPDATE flows_plans SET digest = ${other.digest} WHERE plan_id = ${base.planId}`
          return yield* Effect.flip(store.append(grown))
        })
      )
      expect(failure).toMatchObject({ code: "decode_failed" })
    }))

  it.effect(
    "keeps per-append cost flat: the window around append 300 stays within a small multiple of the first 25",
    () =>
      Effect.gen(function*() {
        const { early, late } = yield* withStore((store) =>
          Effect.gen(function*() {
            let plan = yield* withCrypto(compile([draft("n0", { writes: ["out/0"] })]))
            yield* store.record(plan, 1)
            let early = 0
            let late = 0
            for (let generation = 1; generation <= 300; generation++) {
              plan = yield* withCrypto(
                Plan.append(plan, [
                  draft(`n${generation}`, {
                    writes: [`out/${generation}`],
                    inputs: [{ _tag: "Pending", from: `n${generation - 1}` }]
                  })
                ])
              )
              const started = yield* Effect.sync(() => performance.now())
              yield* store.append(plan)
              const elapsed = yield* Effect.sync(() => performance.now() - started)
              if (generation <= 25) early += elapsed
              if (generation > 275) late += elapsed
            }
            return { early: early / 25, late: late / 25 }
          })
        )
        // Append used to re-read, decode, and re-verify the whole stored plan
        // per append, so the window around append 300 cost roughly fifty
        // times the first 25 (the review probe measured 2.7 ms growing to
        // 68.9 ms; this in-memory setup measures ~75 ms against ~1.5 ms).
        // Matching the stored envelope against the verified prefix's approval
        // digest keeps the ratio near the cost of one prefix hash.
        expect(late).toBeLessThan(early * 12)
      }),
    300_000
  )
})
