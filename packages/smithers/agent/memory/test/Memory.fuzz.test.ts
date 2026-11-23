import * as CoreFlow from "@smthrs/core/Flow"
import * as Markdown from "@smthrs/core/Markdown"
import * as Node from "@smthrs/core/Node"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as DurableFlow from "@smthrs/flow/Flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Result, Schema, Stream } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import {
  Bank,
  Embedding,
  Flows,
  Maintenance,
  MemoryStore,
  MemoryTrellis,
  Namespace,
  Opening,
  Recall,
  RecallFts,
  RecallKeyword,
  RecallSemantic,
  SnapshotRecorder,
  Source,
  WithMemory
} from "../src/index.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const dbExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "120" : "30"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const silentLayer = Logger.layer([])
const testMemoryLayer = Layer.merge(TestMemory.layerWithDatabase, silentLayer)

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
      else return false
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

const TagPool = Schema.Literals(["branch:main", "stream:ci", "scope:dev", "source:eval", "scope:proj"])
const MatchModePool = Schema.Literals(["any", "all", "any_strict", "all_strict", "exact"])

describe("@smthrs/memory Namespace, Bank & TagGroup AST fuzz invariants", () => {
  it("Namespace.matches satisfies De Morgan laws, strict/wildcard source: security rules, and budget bounds", async () => {
    const leafArb = Schema.Struct({
      tags: Schema.Array(TagPool).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(3))),
      match: Schema.Union([Schema.Undefined, MatchModePool])
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        l1: leafArb,
        l2: leafArb,
        l3: leafArb,
        recordTags: Schema.Array(TagPool).pipe(Schema.check(Schema.isMaxLength(4))),
        bankKind: Schema.Literals(["flow", "agent", "user", "global"]),
        bankId: Schema.Literals(["alpha", "beta-1", "x_y"])
      })
    )
    const decodeTagGroup = Schema.decodeUnknownSync(Namespace.TagGroup)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ l1, l2, l3, recordTags, bankKind, bankId }) =>
          Effect.gen(function*() {
            const u1 = [...new Set(l1.tags)]
            const u2 = [...new Set(l2.tags)]
            const u3 = [...new Set(l3.tags)]
            const g1: Namespace.TagGroup = l1.match === undefined ? { tags: u1 } : { tags: u1, match: l1.match }
            const g2: Namespace.TagGroup = l2.match === undefined ? { tags: u2 } : { tags: u2, match: l2.match }
            const g3: Namespace.TagGroup = l3.match === undefined ? { tags: u3 } : { tags: u3, match: l3.match }
            const uniqRecord = [...new Set(recordTags)]

            // Schema decode succeeds for valid TagGroup ASTs
            const combined: Namespace.TagGroup = { and: [{ or: [g1, g2] }, { not: g3 }] }
            decodeTagGroup(combined)

            // Boolean algebra laws
            const m1 = Namespace.matches(g1, uniqRecord)
            const m2 = Namespace.matches(g2, uniqRecord)
            const m3 = Namespace.matches(g3, uniqRecord)
            if (Namespace.matches({ and: [g1, g2] }, uniqRecord) !== (m1 && m2)) return false
            if (Namespace.matches({ or: [g1, g2] }, uniqRecord) !== (m1 || m2)) return false
            if (Namespace.matches({ not: g3 }, uniqRecord) !== !m3) return false
            if (Namespace.matches(combined, uniqRecord) !== ((m1 || m2) && !m3)) return false
            // De Morgan: !(g1 && g2) === (!g1 || !g2)
            if (
              Namespace.matches({ not: { and: [g1, g2] } }, uniqRecord) !==
                Namespace.matches({ or: [{ not: g1 }, { not: g2 }] }, uniqRecord)
            ) {
              return false
            }

            // Security invariant: untagged record NEVER matches a leaf naming a `source:` tag
            if (l1.tags.some((t) => t.startsWith("source:")) && Namespace.matches(g1, [])) return false

            // Bank round-trip invariant
            const ns: Namespace.Namespace = { kind: bankKind, id: bankId }
            const bank = Recall.bankForNamespace(ns)
            const parsed = yield* Bank.parse(bank)
            const syn = Recall.namespaceForBank(bank)
            if (parsed.kind !== ns.kind || parsed.id !== ns.id) return false
            if (syn.kind !== ns.kind || syn.id !== ns.id) return false

            // Unprefixed bank resolves to flow
            const unprefixed = yield* Bank.parse(bankId)
            return unprefixed.kind === "flow" && unprefixed.id === bankId
          }),
        { seed, executions }
      )
    )
    assertPassed(report)

    // Budget limits & malformed TagGroup shapes fail closed to false / schema error
    let tooDeep: Namespace.TagGroup = { tags: ["scope:proj"] }
    for (let i = 0; i < 20; i++) tooDeep = { not: tooDeep }
    expect(Namespace.matches(tooDeep, ["scope:proj"])).toBe(false)
    expect(() => Schema.decodeUnknownSync(Namespace.TagGroup)(tooDeep)).toThrow()

    const tooMany: Namespace.TagGroup = {
      and: Array.from({ length: 100 }, () => ({ tags: ["scope:proj"] }))
    }
    expect(Namespace.matches(tooMany, ["scope:proj"])).toBe(false)
    expect(() => Schema.decodeUnknownSync(Namespace.TagGroup)(tooMany)).toThrow()
    expect(Namespace.matches(null as unknown as Namespace.TagGroup, ["scope:proj"])).toBe(false)
    expect(Namespace.matches({ bad: 1 } as unknown as Namespace.TagGroup, ["scope:proj"])).toBe(false)
    expect(Namespace.matches({ and: "nope" } as unknown as Namespace.TagGroup, ["scope:proj"])).toBe(false)
    expect(Namespace.matches({ tags: ["scope:proj"], match: "bogus" } as unknown as Namespace.TagGroup, ["scope:proj"]))
      .toBe(false)

    // Empty bank rejected by Bank.parse; bare prefix falls back to flow-local id
    const emptyBank = await Effect.runPromise(Effect.result(Bank.parse("")))
    expect(Result.isFailure(emptyBank)).toBe(true)
    const barePrefix = await Effect.runPromise(Bank.parse("flow-"))
    expect(barePrefix).toEqual({ kind: "flow", id: "flow-" })
  })
})

describe("@smthrs/memory SQLite MemoryStore facts, notes, threads & recall fuzz invariants", () => {
  it("MemoryStore facts, notes lifecycle, supersession & threads match exact model over real SQLite", async () => {
    const nsArb = Schema.Literals(["flow:alpha", "agent:beta"])
    const keyArb = Schema.Literals(["k1", "k2", "k3", "k4"])
    const opArb = Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("putFact"),
        ns: nsArb,
        key: keyArb,
        val: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50 }))),
        tag: Schema.Literals(["branch:main", "stream:ci", "scope:proj"])
      }),
      Schema.Struct({
        _tag: Schema.Literal("delFact"),
        ns: nsArb,
        key: keyArb
      }),
      Schema.Struct({
        _tag: Schema.Literal("putNote"),
        ns: nsArb,
        id: Schema.Literals(["n1", "n2", "n3"]),
        text: Schema.Literals(["alpha guide", "beta guide", "gamma rule"]),
        status: Schema.Literals(["pending", "accepted", "rejected"]),
        tag: Schema.Literals(["branch:main", "stream:ci", "source:eval"])
      }),
      Schema.Struct({
        _tag: Schema.Literal("setNoteStatus"),
        id: Schema.Literals(["n1", "n2", "n3"]),
        status: Schema.Literals(["accepted", "rejected"])
      }),
      Schema.Struct({
        _tag: Schema.Literal("appendMsg"),
        thread: Schema.Literals(["th1", "th2"]),
        msgId: Schema.Literals(["m1", "m2", "m3", "m4"]),
        text: Schema.Literals(["hello world", "second message 🚀", "alpha beta"]),
        at: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 })))
      })
    ])
    const arb = Arbitrary.schema(Schema.Array(opArb).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(16))))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) =>
          Effect.gen(function*() {
            const store = yield* MemoryStore.MemoryStore
            const factModel = new Map<string, number>()
            const noteModel = new Map<
              string,
              { text: string; status: MemoryStore.NoteStatus; ns: "flow:alpha" | "agent:beta" }
            >()
            const msgModel = new Map<string, Map<string, { at: number; text: string }>>()
            const toNs = (ns: "flow:alpha" | "agent:beta"): Namespace.Namespace =>
              ns === "flow:alpha" ? { kind: "flow", id: "alpha" } : { kind: "agent", id: "beta" }
            const threadNs = (thread: "th1" | "th2"): Namespace.Namespace =>
              toNs(thread === "th1" ? "flow:alpha" : "agent:beta")

            // Create both threads upfront
            yield* store.createThread({ id: "th1", namespace: toNs("flow:alpha"), title: "T1", metadata: { a: 1 } })
            yield* store.createThread({ id: "th2", namespace: toNs("agent:beta"), title: "T2" })
            msgModel.set("th1", new Map())
            msgModel.set("th2", new Map())

            for (const op of ops) {
              if (op._tag === "putFact") {
                yield* store.putFact({
                  namespace: toNs(op.ns),
                  key: op.key,
                  value: { content: `fact ${op.val} alpha` },
                  tags: [op.tag],
                  provenance: { runId: "r1", nodeId: "n1", iteration: 1 }
                })
                factModel.set(`${op.ns}\0${op.key}`, op.val)
              } else if (op._tag === "delFact") {
                yield* store.deleteFact({ namespace: toNs(op.ns), key: op.key })
                factModel.delete(`${op.ns}\0${op.key}`)
              } else if (op._tag === "putNote") {
                const noteKey = `${op.ns} ${op.id}`
                const existing = noteModel.get(noteKey)
                const res = yield* Effect.result(
                  store.putNote({
                    namespace: toNs(op.ns),
                    id: op.id,
                    text: op.text,
                    tags: [op.tag],
                    status: op.status,
                    provenance: { runId: "r1" }
                  })
                )
                if (existing === undefined) {
                  if (Result.isFailure(res)) return false
                  noteModel.set(noteKey, { text: op.text, status: op.status, ns: op.ns })
                } else {
                  // Same (namespace, id) with differing payload fails with supersede_conflict
                  if (Result.isSuccess(res) && existing.text !== op.text) return false
                }
              } else if (op._tag === "setNoteStatus") {
                const existing = noteModel.get(`flow:alpha ${op.id}`) ?? noteModel.get(`agent:beta ${op.id}`)
                const res = yield* Effect.result(
                  store.setNoteStatus({
                    namespace: toNs(existing?.ns ?? "flow:alpha"),
                    id: op.id,
                    status: op.status,
                    ...(op.status === "accepted" ? { acceptedTodo: "todo-1" } : {})
                  })
                )
                if (existing === undefined) {
                  if (Result.isSuccess(res)) return false
                } else if (Result.isSuccess(res)) {
                  existing.status = op.status
                }
              } else {
                const threadMsgs = msgModel.get(op.thread)!
                const prevMsg = threadMsgs.get(op.msgId)
                if (prevMsg !== undefined) {
                  // Idempotent appendMessageOnce keeps first stored row on matching text, rejects conflicting text
                  const onceRes = yield* Effect.result(
                    store.appendMessageOnce({
                      namespace: threadNs(op.thread),
                      threadId: op.thread,
                      id: op.msgId,
                      role: "user",
                      text: op.text
                    })
                  )
                  if (prevMsg.text === op.text) {
                    if (Result.isFailure(onceRes) || onceRes.success.at !== prevMsg.at) return false
                  } else {
                    if (Result.isSuccess(onceRes)) return false
                  }
                } else {
                  yield* store.appendMessage({
                    namespace: threadNs(op.thread),
                    threadId: op.thread,
                    id: op.msgId,
                    role: "user",
                    text: op.text,
                    at: op.at
                  })
                  threadMsgs.set(op.msgId, { at: op.at, text: op.text })
                }
              }
            }

            // Verify fact listing + isolation + count
            const alphaFacts = yield* store.listFacts({ namespace: toNs("flow:alpha"), prefix: "k", limit: 10 })
            const betaFacts = yield* store.listFacts({ namespace: toNs("agent:beta") })
            const allFacts = yield* store.listAllFacts
            const expectedAlpha = [...factModel.keys()].filter((k) => k.startsWith("flow:alpha\0")).length
            const expectedBeta = [...factModel.keys()].filter((k) => k.startsWith("agent:beta\0")).length
            if (alphaFacts.length !== expectedAlpha || betaFacts.length !== expectedBeta) return false
            if (allFacts.length !== factModel.size) return false

            // Verify note queries (getNote, listNotes with status/tagGroups)
            for (const [noteKey, expected] of noteModel.entries()) {
              const id = noteKey.slice(noteKey.indexOf(" ") + 1)
              const got = yield* store.getNote({ namespace: toNs(expected.ns), id })
              if (got === undefined || got.status !== expected.status) return false
            }
            const listedAccepted = yield* store.listNotes({
              namespace: toNs("flow:alpha"),
              status: "accepted",
              limit: 10
            })
            if (listedAccepted.some((n) => n.status !== "accepted")) return false

            // Verify thread messages, pagination, counts, stats
            const threads = yield* store.listThreads({ namespace: toNs("flow:alpha") })
            if (threads.length !== 1 || threads[0]!.id !== "th1") return false
            const th1 = yield* store.getThread({ namespace: threadNs("th1"), threadId: "th1" })
            if (th1 === undefined) return false
            const th1Count = yield* store.countMessages({ namespace: threadNs("th1"), threadId: "th1" })
            if (th1Count !== msgModel.get("th1")!.size) return false
            const stats = yield* store.messageStats({ namespace: threadNs("th1"), threadId: "th1" })
            if (stats.messages !== th1Count) return false
            const page1 = yield* store.listMessages({ namespace: threadNs("th1"), threadId: "th1", limit: 1 })
            if (page1.length === 1 && th1Count > 1) {
              const page2 = yield* store.listMessages({
                namespace: threadNs("th1"),
                threadId: "th1",
                limit: 10,
                cursor: { at: page1[0]!.at, id: page1[0]!.id }
              })
              if (page1.length + page2.length !== th1Count) return false
            }

            // Exercise Keyword & FTS recall on real populated DB
            const kwRes = yield* RecallKeyword.recall({
              banks: ["flow-alpha", "agent-beta"],
              query: "alpha guide",
              maxTokens: 2048
            })
            for (let i = 1; i < kwRes.length; i++) {
              if (Recall.compareResults(kwRes[i - 1]!, kwRes[i]!) > 0) return false
            }

            // FTS before enabling fails with fts_not_enabled
            const ftsBefore = yield* Effect.result(
              RecallFts.recall({ banks: ["flow-alpha"], query: "alpha" })
            )
            if (Result.isSuccess(ftsBefore) || ftsBefore.failure.code !== "fts_not_enabled") return false

            // Enable FTS and query
            yield* store.enableFts("flow")
            const ftsAfter = yield* RecallFts.recall({
              banks: ["flow-alpha"],
              query: "alpha \"OR\" NOT:bad*",
              tagGroups: [{ tags: ["branch:main", "stream:ci", "scope:proj", "source:eval"], match: "any" }],
              maxTokens: 2048
            })
            if (ftsAfter.some((r) => r.bank !== "flow-alpha")) return false

            // Delete thread cleanly
            yield* store.deleteThread({ namespace: threadNs("th2"), threadId: "th2" })
            const gone = yield* store.getThread({ namespace: threadNs("th2"), threadId: "th2" })
            return gone === undefined
          }).pipe(Effect.provide(testMemoryLayer)),
        { seed: seed + 1, executions: dbExecutions }
      )
    )
    assertPassed(report)

    // Also test supersede, auto-generated threadId, deleteMessages, and makeNoop
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const ns: Namespace.Namespace = { kind: "flow", id: "sup" }
        yield* store.putNote({ namespace: ns, id: "old-n", text: "old", tags: [], provenance: {} })
        yield* store.putNote({ namespace: ns, id: "new-n", text: "new", tags: [], provenance: {} })
        yield* store.supersede({ namespace: ns, supersederId: "new-n", targetId: "old-n" })
        const visible = yield* store.listNotes({ namespace: ns })
        expect(visible.map((n) => n.id)).toEqual(["new-n"])

        const autoTh = yield* store.createThread({ namespace: ns })
        expect(autoTh.id.length).toBeGreaterThan(0)
        yield* store.appendMessage({ namespace: ns, threadId: autoTh.id, id: "m1", role: "user", text: "hi", at: 1 })
        expect(yield* store.deleteMessages({ namespace: ns, threadId: autoTh.id, ids: ["m1"] })).toBe(1)

        // makeNoop / layerNoop
        const noop = MemoryStore.makeNoop()
        expect(Result.isFailure(yield* Effect.result(noop.getFact({ namespace: ns, key: "k" })))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(noop.listAllFacts))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(noop.deleteExpiredFacts))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(noop.listThreads({ namespace: ns })))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(noop.enableFts("flow")))).toBe(true)
      }).pipe(Effect.provide(testMemoryLayer))
    )
  })
})

describe("@smthrs/memory Recall, Embedding, RecallSemantic, Source & Opening fuzz invariants", () => {
  it("Recall.capRecallResults enforces UTF-8 byte ceiling, Embedding validates batches, and FTS escapes arbitrary queries", async () => {
    const encoder = new TextEncoder()
    const arb = Arbitrary.schema(
      Schema.Struct({
        rows: Schema.Array(
          Schema.Struct({
            bank: Schema.Literals(["b1", "b2"]),
            key: Schema.Literals(["k1", "k2", "k3"]),
            text: Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
            score: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
            updatedAtMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })))
          })
        ).pipe(Schema.check(Schema.isMaxLength(8))),
        maxTokens: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 400 }))),
        query: Schema.String.pipe(Schema.check(Schema.isMaxLength(60)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rows, maxTokens, query }) =>
          Effect.gen(function*() {
            if (!isWellFormed(query) || rows.some((r) => !isWellFormed(r.text))) return true
            const capped = Recall.capRecallResults(rows, maxTokens)
            if (capped.length > 0) {
              const serializedBytes = encoder.encode(JSON.stringify(capped)).byteLength
              if (serializedBytes > maxTokens) return false
            }
            if (capped.some((r) => r.text.length === 0)) return false

            // compareResults antisymmetry
            const sorted = [...rows].sort(Recall.compareResults)
            for (let i = 1; i < sorted.length; i++) {
              if (Recall.compareResults(sorted[i - 1]!, sorted[i]!) > 0) return false
            }

            // inProcessVector unit-norm or zero vector invariant
            const vec = Embedding.inProcessVector(query)
            if (vec.length !== 64) return false
            const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0))
            if (norm > 1e-9 && Math.abs(norm - 1) > 1e-6) return false

            // literalFtsQuery wraps every term in double quotes without throwing
            const escaped = RecallFts.literalFtsQuery(query)
            if (escaped.length > 0 && (!escaped.startsWith("\"") || !escaped.endsWith("\""))) return false

            // boundedQuery respects UTF-8 byte cap
            const bq = Opening.boundedQuery(query, Math.min(maxTokens, 32))
            if (encoder.encode(bq).byteLength > Math.min(maxTokens, 32)) return false
            if (!query.endsWith(bq)) return false

            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)

    // Embedding service providers & invalid batch rejections
    await Effect.runPromise(
      Effect.gen(function*() {
        const inProc = Embedding.makeInProcess()
        const single = yield* inProc.embed("hello")
        expect(single.vector.length).toBe(64)
        const empty = yield* inProc.embedMany([])
        expect(empty.embeddings).toEqual([])

        const noop = Embedding.makeNoop()
        expect(Result.isFailure(yield* Effect.result(noop.embed("x")))).toBe(true)

        const fakeArr = yield* Embedding.Embedding.pipe(
          Effect.provide(Embedding.layerFake([[1, 0], [0, 1]]))
        )
        expect((yield* fakeArr.embed("a")).vector).toEqual([1, 0])

        const fakeFn = yield* Embedding.Embedding.pipe(
          Effect.provide(Embedding.layerFake((_inp, idx) => [idx + 1, 2]))
        )
        expect((yield* fakeFn.embed("a")).vector).toEqual([1, 2])

        // Validation failures: length mismatch, empty vector, dim mismatch, NaN
        for (
          const bad of [
            () => Effect.succeed([]),
            () => Effect.succeed([[]]),
            () => Effect.succeed([[1, 2], [1]]),
            () => Effect.succeed([[Number.NaN, 1], [1, 1]])
          ]
        ) {
          const svc = Embedding.make(bad)
          expect(Result.isFailure(yield* Effect.result(svc.embedMany(["a", "b"])))).toBe(true)
        }
      })
    )
  })

  it("RecallSemantic SQL vector store, projector, decorated store & semantic recall work end-to-end", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const writer = yield* DurableWriter
          const baseStore = yield* MemoryStore.MemoryStore
          const embedding = Embedding.makeInProcess()
          const vectorStore = RecallSemantic.makeSqlVectorStore({ sql, write: writer.write })
          const projector = yield* RecallSemantic.makeProjector({ vectorStore })
          const decorated = RecallSemantic.decorateStore(baseStore, projector, embedding)

          const ns: Namespace.Namespace = { kind: "flow", id: "sem" }
          yield* decorated.putFact({
            namespace: ns,
            key: "rust-tip",
            value: { content: "use cargo clippy for rust linting" },
            tags: ["scope:rust"],
            provenance: { runId: "r1" }
          })
          yield* decorated.putNote({
            namespace: ns,
            id: "note-1",
            text: "effect layer composition guide for typescript",
            tags: ["scope:ts"],
            provenance: { runId: "r1" }
          })
          expect(projector.activeKeys()).toBe(0)

          // Recall via layer across budgets
          const semLayer = RecallSemantic.layer({ vectorStore }).pipe(
            Layer.provide(Layer.succeed(MemoryStore.MemoryStore)(decorated)),
            Layer.provide(Embedding.layerInProcess)
          )
          const hits = yield* Effect.flatMap(Recall.Recall, (r) =>
            r.recall({
              banks: ["flow-sem"],
              query: "use cargo clippy for rust linting",
              budget: "high",
              tagGroups: [{ tags: ["scope:rust"], match: "any" }],
              maxTokens: 2048
            })).pipe(Effect.provide(semLayer))
          expect(hits.length).toBeGreaterThanOrEqual(1)
          expect(hits[0]!.key).toBe("rust-tip")

          // Direct vector upsert without text + validateVector error branches
          yield* vectorStore.upsert({
            bank: "flow-sem",
            recordKind: "fact",
            recordId: "direct-1",
            model: "m1",
            contentDigest: "d1",
            dimensions: 2,
            vector: [1, 0],
            updatedAtMs: 100
          })
          const badVectors: ReadonlyArray<RecallSemantic.Vector> = [
            {
              bank: "flow-sem",
              recordKind: "fact",
              recordId: "",
              model: "m",
              contentDigest: "d",
              dimensions: 1,
              vector: [1],
              updatedAtMs: 1
            },
            {
              bank: "flow-sem",
              recordKind: "fact",
              recordId: "x",
              model: "",
              contentDigest: "d",
              dimensions: 1,
              vector: [1],
              updatedAtMs: 1
            },
            {
              bank: "flow-sem",
              recordKind: "fact",
              recordId: "x",
              model: "m",
              contentDigest: "",
              dimensions: 1,
              vector: [1],
              updatedAtMs: 1
            },
            {
              bank: "flow-sem",
              recordKind: "fact",
              recordId: "x",
              model: "m",
              contentDigest: "d",
              dimensions: 2,
              vector: [1],
              updatedAtMs: 1
            },
            {
              bank: "flow-sem",
              recordKind: "fact",
              recordId: "x",
              model: "m",
              contentDigest: "d",
              dimensions: 0,
              vector: [],
              updatedAtMs: 1
            },
            {
              bank: "flow-sem",
              recordKind: "fact",
              recordId: "x",
              model: "m",
              contentDigest: "d",
              dimensions: 1,
              vector: [Number.NaN],
              updatedAtMs: 1
            },
            {
              bank: "flow-sem",
              recordKind: "fact",
              recordId: "x",
              model: "m",
              contentDigest: "d",
              dimensions: 1,
              vector: [1e300],
              updatedAtMs: 1
            },
            {
              bank: "flow-sem",
              recordKind: "fact",
              recordId: "x",
              model: "m",
              contentDigest: "d",
              dimensions: 1,
              vector: [1],
              updatedAtMs: -1
            }
          ]
          for (const bv of badVectors) {
            expect(Result.isFailure(yield* Effect.result(vectorStore.upsert(bv)))).toBe(true)
          }

          // Bad halfLifeMs, dimension mismatch, and oversized page
          const badHalf = yield* Effect.result(
            RecallSemantic.recall({ banks: ["flow-sem"], query: "rust" }, { vectorStore, halfLifeMs: 0 }).pipe(
              Effect.provideService(Embedding.Embedding, embedding)
            )
          )
          expect(Result.isFailure(badHalf)).toBe(true)

          const dimMismatchStore: RecallSemantic.VectorStore = {
            scan: () =>
              Stream.succeed([
                {
                  bank: "flow-sem",
                  recordKind: "fact",
                  recordId: "rust-tip",
                  model: RecallSemantic.defaultModel,
                  contentDigest: "d",
                  dimensions: 3,
                  vector: [1, 0, 0],
                  updatedAtMs: 1
                }
              ]),
            upsert: () => Effect.void
          }
          const dimErr = yield* Effect.result(
            RecallSemantic.recall({ banks: ["flow-sem"], query: "rust" }, { vectorStore: dimMismatchStore }).pipe(
              Effect.provideService(Embedding.Embedding, embedding)
            )
          )
          expect(Result.isFailure(dimErr) && dimErr.failure.code === "vector_model_mismatch").toBe(true)

          const hugePageStore: RecallSemantic.VectorStore = {
            scan: () =>
              Stream.succeed(
                Array.from({ length: 65 }, (_, i) => ({
                  bank: "flow-sem",
                  recordKind: "fact" as const,
                  recordId: `r${i}`,
                  model: RecallSemantic.defaultModel,
                  contentDigest: "d",
                  dimensions: 64,
                  vector: Embedding.inProcessVector("x"),
                  updatedAtMs: 1
                }))
              ),
            upsert: () => Effect.void
          }
          const pageErr = yield* Effect.result(
            RecallSemantic.recall({ banks: ["flow-sem"], query: "rust" }, { vectorStore: hugePageStore }).pipe(
              Effect.provideService(Embedding.Embedding, embedding)
            )
          )
          expect(Result.isFailure(pageErr)).toBe(true)
        })
      ).pipe(Effect.provide(testMemoryLayer))
    )
  })

  it("Source.render escapes all fence/label/newline characters, Source.make memoizes & Opening.select enforces budgets", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rows: Schema.Array(
          Schema.Struct({
            origin: Schema.Literals(["primer", "recall"]),
            bank: Schema.Literals(["b1", "b[evil]", "b/k\nline"]),
            key: Schema.Literals(["k1", "</flows_memory_context>", "k:1\r\n"]),
            text: Schema.String.pipe(Schema.check(Schema.isMaxLength(50)))
          })
        ).pipe(Schema.check(Schema.isMaxLength(6))),
        budget: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
        query: Schema.Literals(["deploy worker", "the is a", "skill alpha beta"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rows, budget, query }) =>
          Effect.gen(function*() {
            const rendered = Source.render(rows)
            if (rows.length === 0) {
              if (rendered !== "") return false
            } else {
              const lines = rendered.split("\n")
              // Exactly opening fence + 1 line per row + closing fence
              if (lines.length !== rows.length + 2) return false
              if (lines[0] !== "<flows_memory_context>" || lines[lines.length - 1] !== "</flows_memory_context>") {
                return false
              }
              // No inner line may contain an unescaped closing fence
              for (let i = 1; i < lines.length - 1; i++) {
                if (lines[i]!.includes("</flows_memory_context>")) return false
              }
            }

            // ofRows digest matches render
            const decl = Source.ofRows(rows)
            if (decl.rows.length !== rows.length || decl.digest.length === 0) return false

            // Opening.shortlist + Opening.select invariants
            const candidates: ReadonlyArray<Opening.Candidate> = rows.map((r, i) => ({
              kind: i % 2 === 0 ? "memory" : "skill",
              bank: r.bank,
              key: r.key,
              text: `${r.text} deploy alpha`
            }))
            const shortlisted = Opening.shortlist(query, candidates, 4)
            if (shortlisted.length > Math.min(4, candidates.length)) return false

            const selection = yield* Opening.select({
              query,
              candidates,
              tokenBudget: budget,
              maxCandidates: 4,
              judge: (items) =>
                Effect.succeed([
                  ...items.map((_, index) => ({ index, unnecessary: index * 0.2, withheld: index % 3 === 2 })),
                  { index: -1, unnecessary: 0, withheld: false },
                  { index: 0, unnecessary: 0.1, withheld: false }, // duplicate index ignored
                  { index: 999, unnecessary: 0.1, withheld: false }
                ])
            })
            if (selection.recalled !== candidates.length) return false
            if (selection.inserted + selection.filtered !== selection.recalled) return false
            if (selection.bytes > budget && selection.rows.length > 0) return false
            if (selection.skillsInserted > selection.skillsRecalled) return false
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    assertPassed(report)

    // Exercise Source.make memoization, changed-field warning, capacity eviction, SnapshotRecorder, selectRecall & Opening.layerSources
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const ns: Namespace.Namespace = { kind: "flow", id: "src" }
        yield* store.putNote({ namespace: ns, id: "p1", text: "primer alpha", tags: [], provenance: {} })
        yield* store.putFact({ namespace: ns, key: "f1", value: { content: "fact alpha" }, provenance: {} })

        expect(() => Source.make({ capacity: 0 })).toThrow(TypeError)
        const src = Source.make({ capacity: 1 })
        const kwLayer = RecallKeyword.layer.pipe(Layer.provide(Layer.succeed(MemoryStore.MemoryStore)(store)))

        const snap1 = yield* Source.declared(src, {
          lineageId: "lin-1",
          iteration: 1,
          banks: ["flow-src"],
          query: "alpha",
          maxBytes: 256
        }).pipe(Effect.provide(kwLayer))
        // Second call with changed query triggers warning and returns frozen snapshot
        const snap2 = yield* src.read({
          lineageId: "lin-1",
          iteration: 1,
          banks: ["flow-src"],
          query: "changed-query",
          maxBytes: 256
        }).pipe(Effect.provide(kwLayer))
        expect(snap2.rows).toEqual(snap1.rows)

        // Evicts lin-1 when capacity=1
        yield* src.read({
          lineageId: "lin-2",
          iteration: 1,
          banks: ["flow-src"],
          query: "alpha",
          maxBytes: 90
        }).pipe(Effect.provide(kwLayer))

        // SnapshotRecorder integration
        const recorded = new Map<string, SnapshotRecorder.Snapshot>()
        const recLayer = SnapshotRecorder.layer({
          record: (id, eff) => {
            const k = `${id.lineageId}:${id.iteration}`
            const hit = recorded.get(k)
            if (hit !== undefined) return Effect.succeed(hit)
            return eff.pipe(Effect.tap((s) => Effect.sync(() => recorded.set(k, s))))
          }
        })
        const srcA = Source.make()
        const srcB = Source.make()
        const sA = yield* srcA.read({ lineageId: "rec", iteration: 0, banks: ["flow-src"], query: "alpha" }).pipe(
          Effect.provide(Layer.merge(kwLayer, recLayer))
        )
        const sB = yield* srcB.read({ lineageId: "rec", iteration: 0, banks: ["flow-src"], query: "alpha" }).pipe(
          Effect.provide(Layer.merge(kwLayer, recLayer))
        )
        expect(sB).toEqual(sA)

        // selectRecall & Opening.layerSources & Recall.layerNoop / Recall.layer
        const chosen = yield* Source.selectRecall(
          { banks: ["flow-src"], query: "alpha" },
          (rows) => Effect.succeed([0, 0, -1, 99, ...rows.map((_, i) => i)]),
          () => 5,
          10
        ).pipe(Effect.provide(kwLayer))
        expect(chosen.length).toBeLessThanOrEqual(2)

        const openingSources = yield* Opening.Sources.pipe(
          Effect.provide(
            Opening.layerSources(["flow-src"], [{ kind: "skill", bank: "skills", key: "s1", text: "deploy" }]).pipe(
              Layer.provide(kwLayer)
            )
          )
        )
        const cands = yield* openingSources.recall("alpha")
        expect(cands.some((c) => c.kind === "skill")).toBe(true)

        const noopRecall = yield* Recall.Recall.pipe(Effect.provide(Recall.layerNoop))
        expect(yield* noopRecall.recall({ banks: ["flow-src"], query: "alpha" })).toEqual([])
        const customRecall = yield* Recall.Recall.pipe(
          Effect.provide(Recall.layer({ recall: () => Effect.succeed([]) }))
        )
        expect(yield* customRecall.recall({ banks: ["flow-src"], query: "alpha" })).toEqual([])
      }).pipe(Effect.provide(testMemoryLayer))
    )
  })
})

describe("@smthrs/memory Flows, WithMemory, MemoryTrellis & Maintenance fuzz invariants", () => {
  it("WithMemory policies govern Flows.handlersFor, MemoryTrellis inherits policies, and Maintenance compacts & limits history", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* MemoryStore.MemoryStore
          const kwLayer = RecallKeyword.layer.pipe(Layer.provide(Layer.succeed(MemoryStore.MemoryStore)(store)))

          // WithMemory on BindingRecord, CoreFlow, DurableFlow
          const leafRecord: WithMemory.BindingRecord = {
            name: "leaf",
            input: Schema.Unknown,
            output: Schema.Unknown
          }
          const parentRecord: WithMemory.BindingRecord = {
            name: "parent",
            input: Schema.Unknown,
            output: Schema.Unknown,
            flows: ["unresolved-ref", leafRecord]
          }
          const policy: WithMemory.Policy = { banks: ["flow-allowed"], maxTokens: 512 }
          const scopedParent = WithMemory.withMemory(parentRecord, policy)
          expect(WithMemory.policyOf(scopedParent)).toEqual(policy)
          expect(WithMemory.references(scopedParent).length).toBe(2)
          expect(WithMemory.children(scopedParent).length).toBe(1)
          expect(WithMemory.policyOf(WithMemory.children(scopedParent)[0]!)).toEqual(policy)

          // Invalid policy throws MemoryError
          expect(() => WithMemory.withMemory(leafRecord, { banks: [], maxTokens: 100 })).toThrow()

          // CoreFlow + DurableFlow + MemoryTrellis
          const coreChild = Markdown.lowerMarkdown({ name: "c-child" }, "child prompt")
          const coreParent = CoreFlow.withFlows(
            Markdown.lowerMarkdown({ name: "c-parent" }, "parent prompt"),
            [coreChild, "named-ref"]
          )
          const scopedCore = WithMemory.withMemory(coreParent, policy)
          expect(WithMemory.policyOf(scopedCore)).toEqual(policy)

          const durFlow = DurableFlow.make("dur-recall", {
            payload: Flows.RecallInput,
            success: Flows.RecallOutput,
            body: () => Node.succeed([])
          })
          expect(Flows.bindRecall(durFlow)).toBe(durFlow)
          expect(WithMemory.policyOf(WithMemory.withMemory(durFlow, policy))).toEqual(policy)

          const passthrough = (name: string) =>
            DurableFlow.make(name, {
              payload: { input: Schema.Unknown },
              success: Schema.Unknown,
              body: ({ input }) => Node.succeed(input)
            })
          const trellis = MemoryTrellis.make({
            name: "mt",
            description: "desc",
            author: passthrough("author"),
            leaf: passthrough("leaf"),
            continue: passthrough("cont"),
            memory: policy,
            envelope: { fuel: 2, depth: 2, fanout: 2 }
          })
          expect(WithMemory.policyOf(trellis)).toEqual(policy)

          // Flows handlers: missing policy, retain: "never", recall: "none", allowed bank, foreign bank, reserved source: tag
          const noPolHandlers = Flows.handlersFor(Flows.remember)
          expect(
            Result.isFailure(
              yield* Effect.result(noPolHandlers.remember({ bank: "flow-allowed", key: "k", text: "t" }))
            )
          ).toBe(true)
          expect(
            Result.isFailure(
              yield* Effect.result(noPolHandlers.recall({ banks: [], query: "q" }).pipe(Effect.provide(kwLayer)))
            )
          ).toBe(true)

          const scopedRem = WithMemory.withMemory(Flows.remember, policy)
          const handlers = Flows.handlersFor(scopedRem, { runId: "r-flow" })
          yield* handlers.remember({
            bank: "flow-allowed",
            key: "k1",
            text: "hello world",
            tags: ["scope:ok"],
            ttlMs: 60_000
          })
          yield* handlers.remember({ bank: "flow-allowed", key: "k-exp", text: "expires now", ttlMs: 0 })
          expect(
            Result.isFailure(yield* Effect.result(handlers.remember({ bank: "flow-foreign", key: "k2", text: "no" })))
          ).toBe(true)
          expect(
            Result.isFailure(
              yield* Effect.result(
                Flows.runRemember({ bank: "flow-allowed", key: "k3", text: "x", tags: ["source:fake"] })
              )
            )
          ).toBe(true)

          const recalled = yield* handlers.recall({ banks: [], query: "hello" }).pipe(Effect.provide(kwLayer))
          expect(recalled.length).toBeGreaterThanOrEqual(1)

          const neverPolicy: WithMemory.Policy = {
            banks: ["flow-allowed"],
            maxTokens: 128,
            recall: "none",
            retain: "never"
          }
          const neverHandlers = Flows.handlersFor(WithMemory.withMemory(Flows.remember, neverPolicy))
          expect(yield* neverHandlers.remember({ bank: "flow-foreign", key: "dropped", text: "x" })).toEqual({
            key: "dropped"
          })
          expect(yield* neverHandlers.recall({ banks: ["flow-foreign"], query: "x" }).pipe(Effect.provide(kwLayer)))
            .toEqual([])

          // Maintenance: ttlGc, layerTtlGc, limitHistory (ASCII + multi-byte UTF-8 + invalid args), compact (multi-window + invalid args)
          const gc = yield* Maintenance.ttlGc
          expect(gc.deletedFacts).toBeGreaterThanOrEqual(0)
          yield* Layer.build(Maintenance.layerTtlGc({ interval: "1 hour" }))

          const maintNs: Namespace.Namespace = { kind: "flow", id: "m" }
          const thAscii = yield* store.createThread({ id: "m-ascii", namespace: maintNs })
          const thUtf8 = yield* store.createThread({ id: "m-utf8", namespace: maintNs })
          for (let i = 1; i <= 5; i++) {
            yield* store.appendMessage({
              namespace: maintNs,
              threadId: thAscii.id,
              id: `a${i}`,
              role: "user",
              text: `message number ${i} padding`,
              at: i
            })
            yield* store.appendMessage({
              namespace: maintNs,
              threadId: thUtf8.id,
              id: `u${i}`,
              role: "user",
              text: `🚀 message ${i} 日本語`,
              at: i
            })
          }
          expect(Result.isFailure(yield* Effect.result(Maintenance.limitHistory({ maxTokens: -1 })))).toBe(true)
          expect(Result.isFailure(yield* Effect.result(Maintenance.limitHistory({ maxTokens: 10, charsPerToken: 0 }))))
            .toBe(true)
          const limited = yield* Maintenance.limitHistory({ maxTokens: 12, charsPerToken: 4 })
          expect(limited.deletedMessages).toBeGreaterThan(0)

          // Multi-window compaction
          const thComp = yield* store.createThread({ id: "m-comp", namespace: maintNs })
          for (let i = 1; i <= 5; i++) {
            yield* store.appendMessage({
              namespace: maintNs,
              threadId: thComp.id,
              id: `c${i}`,
              role: "user",
              text: `turn ${i}`,
              at: i * 10
            })
          }
          expect(
            Result.isFailure(
              yield* Effect.result(
                Maintenance.compact({ summarizer: { summarize: () => Effect.succeed("s") }, keepRecent: -1 })
              )
            )
          ).toBe(true)
          expect(
            Result.isFailure(
              yield* Effect.result(
                Maintenance.compact({ summarizer: { summarize: () => Effect.succeed("s") }, maxMessagesPerSummary: 1 })
              )
            )
          ).toBe(true)
          const compacted = yield* Maintenance.compact({
            thread: { namespace: maintNs, threadId: thComp.id },
            keepRecent: 1,
            maxMessagesPerSummary: 2,
            summarizer: { summarize: ({ rendered }) => Effect.succeed(`sum(${rendered.split("\n").length})`) }
          })
          expect(compacted.compactedThreads).toBe(1)
          expect(compacted.deletedMessages).toBeGreaterThanOrEqual(4)
        })
      ).pipe(Effect.provide(testMemoryLayer))
    )
  })
})
