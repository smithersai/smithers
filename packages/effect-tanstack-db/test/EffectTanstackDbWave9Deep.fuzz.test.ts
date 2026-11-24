import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { wholeTransactions } from "../src/internal/wholeTransactions.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261165")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(40, Math.min(baseExecutions, 150))

const assertPassed = <A, E = unknown>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("@smthrs/effect-tanstack-db Wave 9 deep fuzzing", () => {
  it(
    "wholeTransactions buffers deferred writes until commit or metadata read, supports nested transactions, and proxies persistence capabilities transparently",
    async () => {
      const opArb = Schema.Literals([
        "begin",
        "write",
        "truncate",
        "commit",
        "row.get",
        "row.set",
        "row.delete",
        "col.get",
        "col.set",
        "col.delete",
        "col.list",
        "reserveCommitTurn",
        "expectCurrentCommit",
        "otherProp"
      ])
      const arb = Arbitrary.schema(
        Schema.Array(opArb).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24)))
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (ops) =>
            Effect.sync(() => {
              const log: Array<string> = []
              let captured: any
              const wrapped = wholeTransactions({
                sync: (params: any) => {
                  captured = params
                  return () => {}
                }
              })

              const rowMeta = new Map<string, unknown>()
              const colMeta = new Map<string, unknown>()
              const coreParams = {
                begin: () => log.push("begin"),
                write: (msg: unknown) => log.push(`write:${JSON.stringify(msg)}`),
                truncate: () => log.push("truncate"),
                commit: () => {
                  log.push("commit")
                  return "committed"
                },
                markReady: () => log.push("ready"),
                metadata: {
                  row: {
                    get: (k: string) => {
                      log.push(`row.get:${k}`)
                      return rowMeta.get(k)
                    },
                    set: (k: string, v: unknown) => {
                      log.push(`row.set:${k}`)
                      rowMeta.set(k, v)
                    },
                    delete: (k: string) => {
                      log.push(`row.delete:${k}`)
                      rowMeta.delete(k)
                    }
                  },
                  collection: {
                    get: (k: string) => {
                      log.push(`col.get:${k}`)
                      return colMeta.get(k)
                    },
                    set: (k: string, v: unknown) => {
                      log.push(`col.set:${k}`)
                      colMeta.set(k, v)
                    },
                    delete: (k: string) => {
                      log.push(`col.delete:${k}`)
                      colMeta.delete(k)
                    },
                    list: (prefix?: string) => {
                      log.push(`col.list:${prefix ?? ""}`)
                      return [...colMeta.entries()].map(([key, value]) => ({ key, value }))
                    }
                  },
                  persistence: {
                    protocol: "sqlite-v1",
                    reserveCommitTurn: () => log.push("reserveCommitTurn"),
                    resumeSnapshot: {
                      expectCurrentCommit: () => log.push("expectCurrentCommit"),
                      getKeySetEvidence: () => "evidence-ok"
                    }
                  }
                }
              }

              wrapped.sync(coreParams as never)
              expect(captured).toBeDefined()

              let openDepth = 0
              let materialized = false
              for (let i = 0; i < ops.length; i++) {
                const op = ops[i]!
                if (op === "begin") {
                  const lenBefore = log.length
                  captured.begin()
                  openDepth += 1
                  materialized = false
                  // Core MUST NOT see begin yet!
                  expect(log.length).toBe(lenBefore)
                } else if (op === "write") {
                  const lenBefore = log.length
                  captured.write({ type: "insert", value: { id: `k${i}` } })
                  if (openDepth > 0 && !materialized) {
                    expect(log.length).toBe(lenBefore)
                  }
                } else if (op === "truncate") {
                  captured.truncate()
                } else if (op === "commit") {
                  if (openDepth > 0) {
                    const ret = captured.commit()
                    expect(ret).toBe("committed")
                    openDepth -= 1
                    materialized = false
                  }
                } else if (op === "row.get") {
                  captured.metadata.row.get("r1")
                  if (openDepth > 0) materialized = true
                } else if (op === "row.set") {
                  captured.metadata.row.set("r1", i)
                } else if (op === "row.delete") {
                  captured.metadata.row.delete("r1")
                } else if (op === "col.get") {
                  captured.metadata.collection.get("c1")
                  if (openDepth > 0) materialized = true
                } else if (op === "col.set") {
                  captured.metadata.collection.set("c1", i)
                } else if (op === "col.delete") {
                  captured.metadata.collection.delete("c1")
                } else if (op === "col.list") {
                  captured.metadata.collection.list("c")
                  if (openDepth > 0) materialized = true
                } else if (op === "reserveCommitTurn") {
                  captured.metadata.persistence.reserveCommitTurn()
                } else if (op === "expectCurrentCommit") {
                  captured.metadata.persistence.resumeSnapshot.expectCurrentCommit()
                  if (openDepth > 0) materialized = true
                } else if (op === "otherProp") {
                  expect(captured.metadata.persistence.protocol).toBe("sqlite-v1")
                  expect(captured.metadata.persistence.resumeSnapshot.getKeySetEvidence()).toBe("evidence-ok")
                }
              }
              while (openDepth > 0) {
                captured.commit()
                openDepth -= 1
              }
              const begins = log.filter((x) => x === "begin").length
              const commits = log.filter((x) => x === "commit").length
              expect(begins).toBe(commits)
              return true
            }),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
