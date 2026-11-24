import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Embedding from "../src/Embedding.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Namespace from "../src/Namespace.ts"
import * as RecallKeyword from "../src/RecallKeyword.ts"
import * as Semantic from "../src/RecallSemantic.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

// PostgreSQL cannot store U+0000 in text. This suite runs on SQLite and, in
// the storage matrix, on PostgreSQL: both must answer the same typed refusal,
// never a backend database error.
const structured = { kind: "user", id: "shared\u0000x" } as const
const bank = "user-shared\u0000x"

const code = <A, R>(effect: Effect.Effect<A, { readonly code: string }, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.code))

describe("a namespace id containing U+0000", () => {
  it("is refused with invalid_namespace by every store and recall entry point, on every backend", async () => {
    const message = { threadId: "chat", id: "m1", role: "user", text: "text", at: 0 } as const
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const codes = yield* Effect.all([
          ...[structured, bank].flatMap((namespace) => [
            code(store.putFact({ namespace, key: "k", value: "v", provenance: {} })),
            code(store.getFact({ namespace, key: "k" })),
            code(store.listFacts({ namespace })),
            code(store.deleteFact({ namespace, key: "k" })),
            code(store.putNote({ namespace, id: "n", text: "text", tags: [], provenance: {} })),
            code(store.listNotes({ namespace })),
            code(store.searchRows({ namespace })),
            code(store.appendMessage({ namespace, ...message })),
            code(store.listThreads({ namespace })),
            code(store.listMessages({ namespace, threadId: "chat" })),
            code(store.deleteThread({ namespace, threadId: "chat" }))
          ]),
          code(RecallKeyword.recall({ banks: [bank], query: "text" })),
          code(
            Semantic.recall({ banks: [bank], query: "text" }, {
              vectorStore: { scan: () => Stream.empty, upsert: () => Effect.void }
            }).pipe(Effect.provideService(Embedding.Embedding, Embedding.makeInProcess()))
          )
        ])
        // Nothing was stored, and the global views still read.
        const stored = [(yield* store.listAllFacts).length, (yield* store.listThreadRefs).length]
        // A neighbouring id without the NUL is an ordinary namespace.
        yield* store.appendMessage({ namespace: { kind: "user", id: "sharedx" }, ...message })
        return { codes, stored, refs: yield* store.listThreadRefs }
      }).pipe(Effect.provide(TestMemory.layer))
    )

    expect(new Set(result.codes)).toEqual(new Set(["invalid_namespace"]))
    expect(result.codes).toHaveLength(24)
    expect(result.stored).toEqual([0, 0])
    expect(result.refs).toEqual([{ namespace: { kind: "user", id: "sharedx" }, threadId: "chat" }])
  })

  it("is refused by the Namespace schema, which still accepts the same id without it", () => {
    const decode = Schema.decodeUnknownSync(Namespace.Namespace)
    expect(() => decode(structured)).toThrow(/U\+0000/u)
    expect(decode({ kind: "user", id: "sharedx" })).toEqual({ kind: "user", id: "sharedx" })
  })
})
