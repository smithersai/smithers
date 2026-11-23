import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as Plan from "@smthrs/plan/Plan"
import { compile, draft } from "@smthrs/plan/test/PlanFixtures"
import { Arbitrary, Effect, Layer, Logger, Option, Result, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import { describe, expect, it } from "vitest"
import * as PlanStorePkg from "../src/index.ts"
import * as Migrations from "../src/Migrations.ts"
import * as PlanStore from "../src/PlanStore.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "150"))
const ioExecutions = Math.max(16, Math.min(Math.ceil(baseExecutions / 3), 50))
const simExecutions = Math.max(12, Math.min(Math.ceil(baseExecutions / 5), 30))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number; readonly execution?: Fuzz.Execution }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(
      arb,
      (value) => predicate(value).pipe(Effect.provide(silentLogger)),
      options
    )
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeStoreLayer = () =>
  Layer.provideMerge(
    PlanStore.layer,
    Layer.provideMerge(Migrations.layer, TestDatabase.layer)
  ).pipe(Layer.provideMerge(NodeCrypto.layer))

const SafeId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,12}$/))

const OpSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("record"),
    planIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
    variant: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
    createdAtMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))
  }),
  Schema.Struct({
    _tag: Schema.Literal("append"),
    planIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
    seedVal: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
    stale: Schema.Boolean
  }),
  Schema.Struct({
    _tag: Schema.Literal("get"),
    planIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
  })
])

describe("@smthrs/plan-store fuzz", () => {
  it("fuzzes stateful PlanStore CRUD, generations, and fencing against a reference model", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prefix: SafeId,
        ops: Schema.Array(OpSchema).check(Schema.isMinLength(1), Schema.isMaxLength(14))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const store = yield* PlanStorePkg.PlanStore.PlanStore
          const model = new Map<string, { base: Plan.Plan; current: Plan.Plan; variant: number }>()
          const planIds = [`${v.prefix}-0`, `${v.prefix}-1`, `${v.prefix}-2`]
          const baseCache = new Map<string, Plan.Plan>()

          const getBase = (planId: string, variant: number) =>
            Effect.gen(function*() {
              const key = `${planId}:${variant}`
              const hit = baseCache.get(key)
              if (hit !== undefined) return hit
              const compiled = yield* Plan.compile({
                planId,
                flow: `flow-${variant}`,
                nodes: [
                  draft("root", { body: { variant }, writes: ["out"] }),
                  draft("child", { body: { variant }, inputs: [{ _tag: "Ref", from: "root", path: [] }] })
                ]
              })
              baseCache.set(key, compiled)
              return compiled
            })

          for (let step = 0; step < v.ops.length; step++) {
            const op = v.ops[step]!
            const planId = planIds[op.planIdx]!
            const existing = model.get(planId)

            if (op._tag === "record") {
              const candidate = yield* getBase(planId, op.variant)
              const res = yield* store.record(candidate, op.createdAtMs)
              if (existing === undefined) {
                expect(res).toEqual({ _tag: "Recorded" })
                model.set(planId, { base: candidate, current: candidate, variant: op.variant })
              } else if (existing.variant === op.variant) {
                expect(res).toEqual({ _tag: "ExistingSame" })
              } else {
                expect(res).toEqual({ _tag: "Conflict", digest: existing.current.digest })
              }
            } else if (op._tag === "append") {
              if (existing === undefined) {
                const unrecorded = yield* getBase(planId, 0)
                const grown = yield* Plan.append(unrecorded, [
                  draft(`extra-${step}`, { body: { seedVal: op.seedVal }, inputs: [{ _tag: "Pending", from: "child" }] })
                ])
                const res = yield* Effect.result(store.append(grown))
                expect(Result.isFailure(res)).toBe(true)
                if (Result.isFailure(res)) expect(res.failure.code).toBe("constraint")
              } else if (op.stale && existing.current.generation > 0) {
                // Append against stale base generation -> must fail with constraint
                const staleGrown = yield* Plan.append(existing.base, [
                  draft(`stale-${step}`, { body: { seedVal: op.seedVal }, inputs: [{ _tag: "Pending", from: "child" }] })
                ])
                const res = yield* Effect.result(store.append(staleGrown))
                expect(Result.isFailure(res)).toBe(true)
                if (Result.isFailure(res)) expect(res.failure.code).toBe("constraint")
              } else {
                const lastNode = existing.current.nodes[existing.current.nodes.length - 1]!.id
                const next = yield* Plan.append(existing.current, [
                  draft(`n-${step}`, {
                    body: { seedVal: op.seedVal },
                    inputs: [{ _tag: "Pending", from: lastNode }]
                  })
                ])
                yield* store.append(next)
                model.set(planId, { ...existing, current: next })

                // Replaying the exact same append must fail with constraint
                const replay = yield* Effect.result(store.append(next))
                expect(Result.isFailure(replay)).toBe(true)
                if (Result.isFailure(replay)) expect(replay.failure.code).toBe("constraint")
              }
            } else {
              const got = yield* store.get(planId)
              if (existing === undefined) {
                expect(Option.isNone(got)).toBe(true)
              } else {
                expect(Option.isSome(got)).toBe(true)
                if (Option.isSome(got)) {
                  expect(got.value).toEqual(existing.current)
                }
              }
            }
          }
          return true
        }).pipe(Effect.provide(makeStoreLayer())),
      { seed: seed + 1, executions: ioExecutions }
    )
  })

  it("fuzzes concurrent record and append races with FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        planId: SafeId,
        seedA: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
        seedB: Schema.Int.check(Schema.isBetween({ minimum: 51, maximum: 100 })),
        sameBase: Schema.Boolean
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const store = yield* PlanStore.PlanStore
          const planA = yield* compile([draft("root", { body: { s: v.seedA } })], v.planId)
          const planB = v.sameBase
            ? planA
            : yield* compile([draft("root", { body: { s: v.seedB } })], v.planId)

          const [r1, r2] = yield* Effect.all(
            [store.record(planA, 10), store.record(planB, 20)],
            { concurrency: "unbounded" }
          )
          const tags = [r1._tag, r2._tag]
          expect(tags.filter((t) => t === "Recorded").length).toBe(1)
          if (v.sameBase) {
            expect(tags).toContain("ExistingSame")
          } else {
            expect(tags).toContain("Conflict")
          }

          const stored = Option.getOrThrow(yield* store.get(v.planId))
          const branch1 = yield* Plan.append(stored, [
            draft("b1", { body: { s: v.seedA }, inputs: [{ _tag: "Pending", from: "root" }] })
          ])
          const branch2 = yield* Plan.append(stored, [
            draft("b2", { body: { s: v.seedB }, inputs: [{ _tag: "Pending", from: "root" }] })
          ])

          const [a1, a2] = yield* Effect.all(
            [Effect.result(store.append(branch1)), Effect.result(store.append(branch2))],
            { concurrency: "unbounded" }
          )
          const successes = [a1, a2].filter(Result.isSuccess).length
          const failures = [a1, a2].filter(Result.isFailure)
          expect(successes).toBe(1)
          expect(failures.length).toBe(1)
          expect(failures[0]!.failure.code).toBe("constraint")

          const finalStored = Option.getOrThrow(yield* store.get(v.planId))
          expect(finalStored.generation).toBe(1)
          return true
        }).pipe(Effect.provide(makeStoreLayer())),
      { seed: seed + 2, executions: simExecutions, execution: FuzzSimulation.execution() }
    )
  })

  it("fuzzes validation failures, divergent prefix, corrupt rows, persistence failures, and SQL triggers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        planId: SafeId,
        caseKind: Schema.Literals([
          "record-invalid-schema",
          "record-nonzero-gen",
          "record-base-digest-mismatch",
          "record-node-nonzero-gen",
          "record-tampered-verify",
          "record-bad-created-at",
          "append-unverified-invalid",
          "append-empty-gen",
          "append-tampered-verify",
          "append-divergent-prefix",
          "append-different-flow",
          "get-corrupt-plan-row",
          "get-corrupt-node-json",
          "get-corrupt-integrity",
          "record-conflict-corrupt-existing",
          "append-cas-corrupt-existing",
          "sql-triggers-append-only",
          "persistence-error-mapping",
          "migrations-idempotent"
        ]),
        seedVal: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const store = yield* PlanStore.PlanStore
          const sql = yield* SqlClient.SqlClient
          const base = yield* Plan.compile({
            planId: v.planId,
            flow: "f1",
            nodes: [
              draft("root", { body: { seedVal: v.seedVal }, writes: ["out"] }),
              draft("child", { body: { seedVal: v.seedVal }, inputs: [{ _tag: "Ref", from: "root", path: [] }] })
            ]
          })
          const flipKey = (k: string) => (k.slice(0, -1) + (k.endsWith("0") ? "1" : "0")) as Plan.Plan["digest"]

          switch (v.caseKind) {
            case "record-invalid-schema": {
              const res = yield* Effect.result(store.record({ ...base, planId: "" } as Plan.Plan, 1))
              expect(Result.isFailure(res) && res.failure.code === "invalid_plan").toBe(true)
              break
            }
            case "record-nonzero-gen": {
              const grown = yield* Plan.append(base, [
                draft("g1", { inputs: [{ _tag: "Pending", from: "child" }] })
              ])
              const res = yield* Effect.result(store.record(grown, 1))
              expect(Result.isFailure(res) && res.failure.code === "invalid_plan").toBe(true)
              break
            }
            case "record-base-digest-mismatch": {
              const fakeDigest = flipKey(base.digest)
              const res = yield* Effect.result(store.record({ ...base, baseDigest: fakeDigest }, 1))
              expect(Result.isFailure(res) && res.failure.code === "invalid_plan").toBe(true)
              break
            }
            case "record-node-nonzero-gen": {
              const badNode = { ...base.nodes[0]!, generation: 1 }
              const res = yield* Effect.result(store.record({ ...base, nodes: [badNode, base.nodes[1]!] }, 1))
              expect(Result.isFailure(res) && res.failure.code === "invalid_plan").toBe(true)
              break
            }
            case "record-tampered-verify": {
              const fakeDigest = flipKey(base.digest)
              const res = yield* Effect.result(
                store.record({ ...base, baseDigest: fakeDigest, digest: fakeDigest }, 1)
              )
              expect(Result.isFailure(res) && res.failure.code === "invalid_plan").toBe(true)
              break
            }
            case "record-bad-created-at": {
              const res = yield* Effect.result(store.record(base, -5))
              expect(Result.isFailure(res) && res.failure.code === "constraint").toBe(true)
              break
            }
            case "append-unverified-invalid": {
              const res = yield* Effect.result(store.append({ ...base, planId: "" } as Plan.Plan))
              expect(Result.isFailure(res) && res.failure.code === "invalid_plan").toBe(true)
              break
            }
            case "append-empty-gen": {
              const res = yield* Effect.result(store.append({ ...base, generation: 1 }))
              expect(Result.isFailure(res) && res.failure.code === "invalid_plan").toBe(true)
              break
            }
            case "append-tampered-verify": {
              const grown = yield* Plan.append(base, [
                draft("g1", { inputs: [{ _tag: "Pending", from: "child" }] })
              ])
              const fakeDigest = flipKey(grown.digest)
              const res = yield* Effect.result(store.append({ ...grown, digest: fakeDigest }))
              expect(Result.isFailure(res) && res.failure.code === "invalid_plan").toBe(true)
              break
            }
            case "append-divergent-prefix": {
              // Record gen 0 and gen 1 (branch A), then try to append gen 2 built on a different gen 1 (branch B)
              yield* store.record(base, 1)
              const gen1A = yield* Plan.append(base, [
                draft("g1a", { body: { b: 1 }, inputs: [{ _tag: "Pending", from: "child" }] })
              ])
              yield* store.append(gen1A)

              const gen1B = yield* Plan.append(base, [
                draft("g1b", { body: { b: 2 }, inputs: [{ _tag: "Pending", from: "child" }] })
              ])
              const gen2FromB = yield* Plan.append(gen1B, [
                draft("g2", { body: { b: 3 }, inputs: [{ _tag: "Pending", from: "g1b" }] })
              ])
              const res = yield* Effect.result(store.append(gen2FromB))
              expect(Result.isFailure(res) && res.failure.code === "constraint").toBe(true)
              if (Result.isFailure(res)) {
                expect(res.failure.message).toContain("diverge")
              }
              break
            }
            case "append-different-flow": {
              yield* store.record(base, 1)
              const otherFlow = yield* Plan.compile({
                planId: v.planId,
                flow: "f2",
                nodes: [draft("root", { body: { seedVal: v.seedVal } })]
              })
              const grown = yield* Plan.append(otherFlow, [
                draft("g1", { inputs: [{ _tag: "Pending", from: "root" }] })
              ])
              const res = yield* Effect.result(store.append(grown))
              expect(Result.isFailure(res) && res.failure.code === "constraint").toBe(true)
              break
            }
            case "get-corrupt-plan-row": {
              yield* sql`
                INSERT INTO flows_plans (plan_id, flow, base_digest, digest, generation, created_at_ms)
                VALUES (${v.planId}, ${"f1"}, ${"not-a-hex-digest"}, ${"not-a-hex-digest"}, ${0}, ${1})
              `
              const res = yield* Effect.result(store.get(v.planId))
              expect(Result.isFailure(res) && res.failure.code === "decode_failed").toBe(true)
              break
            }
            case "get-corrupt-node-json": {
              yield* sql`
                INSERT INTO flows_plans (plan_id, flow, base_digest, digest, generation, created_at_ms)
                VALUES (${v.planId}, ${"f1"}, ${base.baseDigest}, ${base.digest}, ${0}, ${1})
              `
              yield* sql`
                INSERT INTO flows_plan_nodes (plan_id, node_id, generation, ordinal, kind, key_digest, node_json)
                VALUES (${v.planId}, ${"bad"}, ${0}, ${0}, ${"step"}, ${base.nodes[0]!.key}, ${"{}"})
              `
              const res = yield* Effect.result(store.get(v.planId))
              expect(Result.isFailure(res) && res.failure.code === "decode_failed").toBe(true)
              break
            }
            case "get-corrupt-integrity": {
              // Valid row & valid PlanNode JSON, but digest does not match nodes
              const fakeDigest = flipKey(base.digest)
              yield* sql`
                INSERT INTO flows_plans (plan_id, flow, base_digest, digest, generation, created_at_ms)
                VALUES (${v.planId}, ${"f1"}, ${fakeDigest}, ${fakeDigest}, ${0}, ${1})
              `
              const res = yield* Effect.result(store.get(v.planId))
              expect(Result.isFailure(res) && res.failure.code === "decode_failed").toBe(true)
              break
            }
            case "record-conflict-corrupt-existing": {
              yield* sql`
                INSERT INTO flows_plans (plan_id, flow, base_digest, digest, generation, created_at_ms)
                VALUES (${v.planId}, ${"f1"}, ${"bad-digest"}, ${"bad-digest"}, ${0}, ${1})
              `
              const res = yield* Effect.result(store.record(base, 1))
              expect(Result.isFailure(res) && res.failure.code === "decode_failed").toBe(true)
              break
            }
            case "append-cas-corrupt-existing": {
              yield* sql`
                INSERT INTO flows_plans (plan_id, flow, base_digest, digest, generation, created_at_ms)
                VALUES (${v.planId}, ${"f1"}, ${"bad-digest"}, ${"bad-digest"}, ${0}, ${1})
              `
              const grown = yield* Plan.append(base, [
                draft("g1", { inputs: [{ _tag: "Pending", from: "child" }] })
              ])
              const res = yield* Effect.result(store.append(grown))
              expect(Result.isFailure(res) && res.failure.code === "decode_failed").toBe(true)
              break
            }
            case "sql-triggers-append-only": {
              yield* store.record(base, 100)
              const delPlan = yield* Effect.result(sql`DELETE FROM flows_plans WHERE plan_id = ${v.planId}`)
              expect(Result.isFailure(delPlan)).toBe(true)
              const renamePlan = yield* Effect.result(
                sql`UPDATE flows_plans SET plan_id = ${`${v.planId}-renamed`}, generation = 1 WHERE plan_id = ${v.planId}`
              )
              expect(Result.isFailure(renamePlan)).toBe(true)
              const updNode = yield* Effect.result(
                sql`UPDATE flows_plan_nodes SET kind = merge WHERE plan_id = ${v.planId}`
              )
              expect(Result.isFailure(updNode)).toBe(true)
              const delNode = yield* Effect.result(sql`DELETE FROM flows_plan_nodes WHERE plan_id = ${v.planId}`)
              expect(Result.isFailure(delNode)).toBe(true)
              const updEdge = yield* Effect.result(
                sql`UPDATE flows_plan_edges SET to_node = x WHERE plan_id = ${v.planId}`
              )
              expect(Result.isFailure(updEdge)).toBe(true)
              const delEdge = yield* Effect.result(sql`DELETE FROM flows_plan_edges WHERE plan_id = ${v.planId}`)
              expect(Result.isFailure(delEdge)).toBe(true)
              break
            }
            case "persistence-error-mapping": {
              // Faulty DurableWriter returning persistence_failed & SqlError.ConstraintError
              const failingWriter = Layer.succeed(DurableWriter, {
                write: () =>
                  Effect.fail(
                    new DatabaseError({ code: "busy", cause: undefined })
                  )
              })
              const faultyStore = yield* PlanStore.make.pipe(Effect.provide(failingWriter))
              const rBusy = yield* Effect.result(faultyStore.record(base, 1))
              expect(Result.isFailure(rBusy) && rBusy.failure.code === "persistence_failed").toBe(true)

              const constraintSql = Layer.succeed(SqlClient.SqlClient, {
                ...sql,
                // Proxy template tag to return SqlError with ConstraintError
              } as never)
              void constraintSql
              const directErr = new SqlError.SqlError({
                reason: new SqlError.ConstraintError({ cause: new Error("constraint") })
              })
              const constraintWriter = Layer.succeed(DurableWriter, {
                write: () => Effect.fail(directErr as never)
              })
              const constraintStore = yield* PlanStore.make.pipe(Effect.provide(constraintWriter))
              const rConst = yield* Effect.result(constraintStore.record(base, 1))
              expect(Result.isFailure(rConst) && rConst.failure.code === "constraint").toBe(true)
              break
            }
            case "migrations-idempotent": {
              yield* PlanStorePkg.Migrations.run
              expect(PlanStorePkg.Migrations.set.namespace).toBe("plan")
              break
            }
          }
          return true
        }).pipe(Effect.provide(makeStoreLayer())),
      { seed: seed + 3, executions: Math.max(ioExecutions, 90) }
    )
  })
})
