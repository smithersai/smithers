import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as RecallSemantic from "@smthrs/memory/RecallSemantic"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Effect, Stream } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"

describe("public consumer surface", () => {
  it("constructs the SQL vector store using only public memory subpaths", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const store = RecallSemantic.makeSqlVectorStore({ sql, write: writer.write })
        yield* store.upsert({
          bank: "flow-one",
          recordKind: "note",
          recordId: "note",
          model: "test",
          contentDigest: "digest",
          dimensions: 1,
          vector: [1],
          updatedAtMs: 0
        })
        const scanned = (yield* Stream.runCollect(store.scan(["flow-one"], "test"))).flat()
        return { keys: Object.keys(store).sort(), scanned: scanned.map((vector) => vector.recordId) }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(result).toEqual({ keys: ["scan", "upsert"], scanned: ["note"] })
  })
})
