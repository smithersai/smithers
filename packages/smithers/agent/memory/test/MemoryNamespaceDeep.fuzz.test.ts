import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Result, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Maintenance, MemoryStore, type Namespace, Recall, RecallKeyword } from "../src/index.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

// A fresh in-memory SQLite database per execution, with a clock the property
// moves by hand so creation order and timestamp ties are part of the input.
const memoryLayer = Layer.mergeAll(TestMemory.layerWithDatabase, Logger.layer([]), TestClock.layer())

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const intBetween = (minimum: number, maximum: number) =>
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum, maximum })))

const encoder = new TextEncoder()
const utf8Length = (text: string): number => encoder.encode(text).byteLength

// SQLite's BINARY collation and PostgreSQL's "C" collation both order text by
// its UTF-8 bytes, which differs from JavaScript's UTF-16 order above U+D7FF.
const compareUtf8 = (left: string, right: string): number => {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.length - b.length
}

// Namespaces chosen to collide wherever an implementation compares loosely:
// the same id under two kinds, a bank-name spelling of another namespace
// (`flow` + `user-shared` against `user` + `shared`), case, LIKE wildcards,
// trailing whitespace and an embedded NUL.
const namespaces: ReadonlyArray<Namespace.Namespace> = [
  { kind: "user", id: "shared" },
  { kind: "flow", id: "shared" },
  { kind: "flow", id: "user-shared" },
  { kind: "user", id: "SHARED" },
  { kind: "user", id: "shared%" },
  { kind: "user", id: "shared " },
  { kind: "user", id: "shared\u0000x" }
]
const NsIndex = intBetween(0, namespaces.length - 1)
const marker = (index: number): string => `zq${index}zq`
const NoteId = Schema.Literals(["n1", "n2", "n3"])
const ThreadId = Schema.Literals(["chat", "chat%"])
const MessageId = Schema.Literals(["m1", "m2", "m3"])
const FactKey = Schema.Literals(["prefs", "prefs%", "k"])
const Status = Schema.Literals(["pending", "accepted", "rejected"])

const snapshot = (namespace: Namespace.Namespace) =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const threads = yield* store.listThreads({ namespace })
    const messages: Array<unknown> = []
    for (const threadId of ThreadId.literals) {
      messages.push(
        yield* store.listMessages({ namespace, threadId }),
        yield* store.messageStats({ namespace, threadId })
      )
    }
    return JSON.stringify({
      facts: yield* store.listFacts({ namespace }),
      notes: yield* store.listNotes({ namespace, status: "any", includeSuperseded: true }),
      visible: (yield* store.listNotes({ namespace })).map((note) => note.id),
      rows: (yield* store.searchRows({ namespace, status: "any", includeSuperseded: true })).map((row) => [
        row.kind,
        row.key,
        row.text,
        row.status
      ]),
      threads,
      messages
    })
  })

describe("@smthrs/memory composite (namespace_kind, namespace_id, id) isolation (#4712)", () => {
  it("no write, supersession, compaction or delete in one namespace changes or leaks into another with identical ids", async () => {
    const Op = Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("putFact"), ns: NsIndex, key: FactKey, value: intBetween(0, 3) }),
      Schema.Struct({ _tag: Schema.Literal("deleteFact"), ns: NsIndex, key: FactKey }),
      Schema.Struct({
        _tag: Schema.Literal("putNote"),
        ns: NsIndex,
        id: NoteId,
        status: Status,
        supersedes: Schema.Array(NoteId).pipe(Schema.check(Schema.isMaxLength(2)))
      }),
      Schema.Struct({ _tag: Schema.Literal("setNoteStatus"), ns: NsIndex, id: NoteId, status: Status }),
      Schema.Struct({ _tag: Schema.Literal("supersede"), ns: NsIndex, superseder: NoteId, target: NoteId }),
      Schema.Struct({
        _tag: Schema.Literal("append"),
        ns: NsIndex,
        threadId: ThreadId,
        id: MessageId,
        at: intBetween(0, 4)
      }),
      Schema.Struct({
        _tag: Schema.Literal("deleteMessages"),
        ns: NsIndex,
        threadId: ThreadId,
        ids: Schema.Array(MessageId).pipe(Schema.check(Schema.isMaxLength(3)))
      }),
      Schema.Struct({ _tag: Schema.Literal("deleteThread"), ns: NsIndex, threadId: ThreadId }),
      Schema.Struct({ _tag: Schema.Literal("compact"), ns: NsIndex, threadId: ThreadId, keepRecent: intBetween(0, 1) }),
      // A caller in `ns` presents another namespace's messages as its sources.
      Schema.Struct({ _tag: Schema.Literal("forgedCompact"), ns: NsIndex, from: NsIndex, threadId: ThreadId })
    ])
    const arb = Arbitrary.schema(Schema.Array(Op).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(14))))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) =>
          Effect.gen(function*() {
            const store = yield* MemoryStore.MemoryStore
            const facts = namespaces.map(() => new Map<string, number>())
            let before = yield* Effect.forEach(namespaces, snapshot)

            for (const op of ops) {
              const namespace = namespaces[op.ns]!
              const own = marker(op.ns)
              if (op._tag === "putFact") {
                yield* store.putFact({
                  namespace,
                  key: op.key,
                  value: { content: `${own} common fact ${op.value}` },
                  provenance: {}
                })
                facts[op.ns]!.set(op.key, op.value)
              } else if (op._tag === "deleteFact") {
                const deleted = yield* store.deleteFact({ namespace, key: op.key })
                if (deleted !== facts[op.ns]!.delete(op.key)) return false
              } else if (op._tag === "putNote") {
                yield* Effect.result(store.putNote({
                  namespace,
                  id: op.id,
                  text: `${own} common note ${op.id}`,
                  tags: [],
                  provenance: {},
                  status: op.status,
                  supersedes: op.supersedes
                }))
              } else if (op._tag === "setNoteStatus") {
                yield* Effect.result(store.setNoteStatus({ namespace, id: op.id, status: op.status }))
              } else if (op._tag === "supersede") {
                yield* Effect.result(
                  store.supersede({ namespace, supersederId: op.superseder, targetId: op.target })
                )
              } else if (op._tag === "append") {
                yield* Effect.result(store.appendMessage({
                  namespace,
                  threadId: op.threadId,
                  id: op.id,
                  role: "user",
                  text: `${own} common message ${op.id}`,
                  at: op.at
                }))
              } else if (op._tag === "deleteMessages") {
                yield* store.deleteMessages({ namespace, threadId: op.threadId, ids: op.ids })
              } else if (op._tag === "deleteThread") {
                yield* store.deleteThread({ namespace, threadId: op.threadId })
              } else if (op._tag === "compact") {
                yield* Effect.result(Maintenance.compact({
                  summarizer: { summarize: ({ messages }) => Effect.succeed(`${own} summary of ${messages.length}`) },
                  thread: { namespace, threadId: op.threadId },
                  keepRecent: op.keepRecent
                }))
              } else {
                const sources = yield* store.listMessages({ namespace: namespaces[op.from]!, threadId: op.threadId })
                const forged = yield* Effect.result(store.compactMessages({
                  namespace,
                  threadId: op.threadId,
                  summary: { threadId: op.threadId, id: "forged", role: "system", text: `${own} forged`, at: 0 },
                  sourceMessages: sources
                }))
                // Another namespace's rows are never this namespace's sources:
                // they carry the other marker, so nothing here matches them.
                if (op.from !== op.ns && sources.length > 0 && Result.isSuccess(forged)) return false
              }

              const after = yield* Effect.forEach(namespaces, snapshot)
              for (let index = 0; index < namespaces.length; index++) {
                // Isolation: only the namespace the operation named may differ.
                if (index !== op.ns && after[index] !== before[index]) return false
                // No leak: nothing a namespace holds was written under another's marker.
                for (let other = 0; other < namespaces.length; other++) {
                  if (other !== index && after[index]!.includes(marker(other))) return false
                }
              }
              before = after
            }

            // Every namespace still holds exactly the facts written to it.
            for (let index = 0; index < namespaces.length; index++) {
              const listed = yield* store.listFacts({ namespace: namespaces[index]! })
              const expected = [...facts[index]!.entries()].sort(([left], [right]) => left < right ? -1 : 1)
              if (listed.length !== expected.length) return false
              for (const [key, value] of expected) {
                const fact = yield* store.getFact({ namespace: namespaces[index]!, key })
                if (
                  JSON.stringify(fact?.value) !== JSON.stringify({ content: `${marker(index)} common fact ${value}` })
                ) {
                  return false
                }
              }
            }

            // The global views are the disjoint union of the namespaced ones.
            const allFacts = yield* store.listAllFacts
            if (allFacts.length !== facts.reduce((total, map) => total + map.size, 0)) return false
            const refs = yield* store.listThreadRefs
            let threadCount = 0
            for (const namespace of namespaces) threadCount += (yield* store.listThreads({ namespace })).length
            if (refs.length !== threadCount) return false
            if (new Set(refs.map((ref) => JSON.stringify(ref))).size !== refs.length) return false

            // Recall over one bank returns that namespace's rows only.
            for (let index = 0; index < namespaces.length; index++) {
              const bank = Recall.bankForNamespace(namespaces[index]!)
              const recalled = yield* RecallKeyword.recall({ banks: [bank], query: "common", maxTokens: 4096 })
              for (const row of recalled) {
                if (row.bank !== bank || !row.text.includes(marker(index))) return false
              }
              const visible = yield* store.searchRows({ namespace: namespaces[index]!, status: "accepted" })
              if (recalled.length !== visible.length) return false
            }
            return true
          }).pipe(Effect.provide(memoryLayer)),
        { seed, executions: ioExecutions }
      )
    )
    assertPassed(report)
  })
})

describe("@smthrs/memory note supersession stays a DAG", () => {
  type NoteModel = { status: MemoryStore.NoteStatus; readonly createdAtMs: number }
  type SupersessionModel = { readonly notes: Map<string, NoteModel>; readonly edges: Set<string> }
  const DagNoteId = Schema.Literals(["a", "b", "c", "d"])
  const twins: ReadonlyArray<Namespace.Namespace> = [{ kind: "user", id: "alice" }, { kind: "user", id: "bob" }]
  const TwinIndex = intBetween(0, 1)
  const edge = (superseder: string, target: string): string => `${superseder}>${target}`

  // `from` supersedes `to`, directly or through other notes.
  const reaches = (edges: ReadonlySet<string>, from: string, to: string): boolean => {
    const seen = new Set<string>()
    const pending = [from]
    while (pending.length > 0) {
      const current = pending.pop()!
      if (current === to) return true
      if (seen.has(current)) continue
      seen.add(current)
      for (const entry of edges) {
        const [superseder, target] = entry.split(">") as [string, string]
        if (superseder === current) pending.push(target)
      }
    }
    return false
  }

  const acyclic = (edges: ReadonlySet<string>): boolean =>
    [...edges].every((entry) => {
      const [superseder, target] = entry.split(">") as [string, string]
      return !reaches(edges, target, superseder)
    })

  const visibleIds = (model: SupersessionModel): ReadonlyArray<string> =>
    [...model.notes.entries()]
      .filter(([id, note]) =>
        note.status === "accepted" &&
        ![...model.edges].some((entry) => {
          const [superseder, target] = entry.split(">") as [string, string]
          return target === id && model.notes.get(superseder)?.status === "accepted"
        })
      )
      .sort(([leftId, left], [rightId, right]) => left.createdAtMs - right.createdAtMs || (leftId < rightId ? -1 : 1))
      .map(([id]) => id)

  const Op = Schema.Union([
    Schema.Struct({
      _tag: Schema.Literal("put"),
      ns: TwinIndex,
      id: DagNoteId,
      status: Schema.Literals(["pending", "accepted", "rejected"]),
      supersedes: Schema.Array(DagNoteId).pipe(Schema.check(Schema.isMaxLength(2)))
    }),
    Schema.Struct({ _tag: Schema.Literal("supersede"), ns: TwinIndex, superseder: DagNoteId, target: DagNoteId }),
    // Listed twice so half the operations draw edges: a cycle needs several.
    Schema.Struct({ _tag: Schema.Literal("supersede"), ns: TwinIndex, superseder: DagNoteId, target: DagNoteId }),
    Schema.Struct({
      _tag: Schema.Literal("status"),
      ns: TwinIndex,
      id: DagNoteId,
      status: Schema.Literals(["pending", "accepted", "rejected"])
    }),
    Schema.Struct({ _tag: Schema.Literal("tick"), ms: intBetween(0, 2) })
  ])
  type Op = typeof Op.Type

  const property = (ops: ReadonlyArray<Op>) =>
    Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* SqlClient.SqlClient
      const models: ReadonlyArray<SupersessionModel> = twins.map(() => ({ notes: new Map(), edges: new Set() }))
      let now = 0
      // Both namespaces start with the same three accepted notes, so most
      // generated edges join real notes; `d` exists only once an operation puts it.
      for (let index = 0; index < twins.length; index++) {
        for (const id of ["a", "b", "c"]) {
          yield* store.putNote({ namespace: twins[index]!, id, text: `note ${id}`, tags: [], provenance: {} })
          models[index]!.notes.set(id, { status: "accepted", createdAtMs: now })
        }
      }

      for (const op of ops) {
        if (op._tag === "tick") {
          yield* TestClock.adjust(op.ms)
          now += op.ms
          continue
        }
        const namespace = twins[op.ns]!
        const model = models[op.ns]!
        if (op._tag === "put") {
          const targets = [...new Set(op.supersedes)].sort()
          const existing = model.notes.get(op.id)
          const result = yield* Effect.result(store.putNote({
            namespace,
            id: op.id,
            text: `note ${op.id}`,
            tags: [],
            provenance: {},
            status: op.status,
            supersedes: op.supersedes
          }))
          const persisted = [...model.edges].filter((entry) => entry.startsWith(`${op.id}>`)).sort()
          const expected = targets.includes(op.id)
            ? false
            : existing === undefined
            ? targets.every((target) => model.notes.has(target))
            // A retry is the same note only when its supersession set is the stored one.
            : JSON.stringify(persisted) === JSON.stringify(targets.map((target) => edge(op.id, target)))
          if (Result.isSuccess(result) !== expected) return false
          if (Result.isFailure(result) && result.failure.code !== "supersede_conflict") return false
          if (expected && existing === undefined) {
            model.notes.set(op.id, { status: op.status, createdAtMs: now })
            for (const target of targets) model.edges.add(edge(op.id, target))
          }
          // A refused insert leaves no row behind; a retry keeps the first status.
          const stored = yield* store.getNote({ namespace, id: op.id })
          if (stored?.status !== model.notes.get(op.id)?.status) return false
        } else if (op._tag === "supersede") {
          const result = yield* Effect.result(
            store.supersede({ namespace, supersederId: op.superseder, targetId: op.target })
          )
          const expected = op.superseder !== op.target && model.notes.has(op.superseder) &&
            model.notes.has(op.target) &&
            // The edge closes a cycle when its target already supersedes its superseder.
            !reaches(model.edges, op.target, op.superseder)
          if (Result.isSuccess(result) !== expected) return false
          if (Result.isFailure(result) && result.failure.code !== "supersede_conflict") return false
          if (expected) model.edges.add(edge(op.superseder, op.target))
        } else {
          const result = yield* Effect.result(store.setNoteStatus({ namespace, id: op.id, status: op.status }))
          const note = model.notes.get(op.id)
          if (Result.isSuccess(result) !== (note !== undefined)) return false
          if (note !== undefined) note.status = op.status
        }

        for (let index = 0; index < twins.length; index++) {
          const twin = twins[index]!
          const expected = models[index]!
          const rows = yield* sql<{ readonly superseder_id: string; readonly target_id: string }>`
            SELECT superseder_id, target_id FROM memory_note_supersedes
            WHERE namespace_kind = ${twin.kind} AND namespace_id = ${twin.id}`
          const stored = new Set(rows.map((row) => edge(row.superseder_id, row.target_id)))
          // The stored graph is the model's, and it never holds a cycle.
          if (stored.size !== expected.edges.size || [...stored].some((entry) => !expected.edges.has(entry))) {
            return false
          }
          if (!acyclic(stored)) return false

          const visible = (yield* store.listNotes({ namespace: twin })).map((note) => note.id)
          if (JSON.stringify(visible) !== JSON.stringify(visibleIds(expected))) return false
          // In a DAG some accepted note has no accepted superseder, so
          // accepted knowledge can never all vanish from recall.
          const accepted = [...expected.notes.values()].some((note) => note.status === "accepted")
          if (accepted && visible.length === 0) return false
          const every = yield* store.listNotes({ namespace: twin, status: "any", includeSuperseded: true })
          if (every.length !== expected.notes.size) return false
          if (every.some((note) => expected.notes.get(note.id)?.status !== note.status)) return false
        }
      }
      return true
    }).pipe(Effect.provide(memoryLayer))

  it("refuses every edge that would close a cycle and lists exactly the unsuperseded accepted notes", async () => {
    const arb = Arbitrary.schema(Schema.Array(Op).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(24))))
    const report = await Effect.runPromise(Fuzz.run(arb, property, { seed: seed + 1, executions: pureExecutions }))
    assertPassed(report)
  })

  // The shrunk counterexample the property above found (seed 20261124, six
  // executions, six shrinks): `supersede` accepted an edge and then its
  // reverse. Two accepted notes that supersede each other each hide the
  // other, so `listNotes` and recall dropped both.
  it("keeps the shrunk counterexample: a mutual supersession is refused and both notes stay recallable", async () => {
    const counterexample: ReadonlyArray<Op> = [
      { _tag: "supersede", ns: 0, superseder: "c", target: "a" },
      { _tag: "supersede", ns: 0, superseder: "a", target: "c" }
    ]
    expect(await Effect.runPromise(property(counterexample))).toBe(true)

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const namespace = twins[0]!
        for (const id of ["a", "b", "c"]) {
          yield* store.putNote({ namespace, id, text: `guide ${id}`, tags: [], provenance: {} })
        }
        yield* store.supersede({ namespace, supersederId: "a", targetId: "b" })
        yield* store.supersede({ namespace, supersederId: "b", targetId: "c" })
        // Retrying an edge the graph already holds is still accepted.
        yield* store.supersede({ namespace, supersederId: "a", targetId: "b" })
        return {
          direct: yield* Effect.flip(store.supersede({ namespace, supersederId: "b", targetId: "a" })),
          transitive: yield* Effect.flip(store.supersede({ namespace, supersederId: "c", targetId: "a" })),
          visible: (yield* store.listNotes({ namespace })).map((note) => note.id),
          recalled: (yield* RecallKeyword.recall({ banks: ["user-alice"], query: "guide" })).map((row) => row.key)
        }
      }).pipe(Effect.provide(memoryLayer))
    )
    expect(result.direct).toMatchObject({ code: "supersede_conflict" })
    expect(result.transitive).toMatchObject({
      code: "supersede_conflict",
      message: "note \"c\" is already superseded by note \"a\"; the edge would close a supersession cycle"
    })
    expect(result.visible).toEqual(["a"])
    expect(result.recalled).toEqual(["a"])
  })
})

describe("@smthrs/memory thread and message ordering", () => {
  it("lists, pages, counts and measures messages in (at, id bytes) order per namespace", async () => {
    // Ids whose UTF-8 byte order and UTF-16 order disagree, a control-character
    // summary id, trailing whitespace and case.
    const AdversarialId = Schema.Literals(["a", "B", "a ", "\u0001summary", "é", "￿", "😀", "z"])
    const Text = Schema.Literals([
      "",
      "plain",
      "naïve café",
      "😀👍🏽",
      "line\nbreak\r\n",
      "'; DROP TABLE memory_messages;--",
      "%_\\"
    ])
    const twins: ReadonlyArray<Namespace.Namespace> = [{ kind: "user", id: "alice" }, { kind: "agent", id: "alice" }]
    const Op = Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("append"),
        ns: intBetween(0, 1),
        id: AdversarialId,
        role: Schema.Literals(["user", "assistant"]),
        text: Text,
        at: intBetween(0, 3)
      }),
      Schema.Struct({
        _tag: Schema.Literal("appendOnce"),
        ns: intBetween(0, 1),
        id: AdversarialId,
        text: Text
      }),
      Schema.Struct({
        _tag: Schema.Literal("delete"),
        ns: intBetween(0, 1),
        ids: Schema.Array(AdversarialId).pipe(Schema.check(Schema.isMaxLength(3)))
      }),
      Schema.Struct({ _tag: Schema.Literal("tick"), ms: intBetween(0, 2) })
    ])
    const arb = Arbitrary.schema(Schema.Struct({
      ops: Schema.Array(Op).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20))),
      pageSize: intBetween(1, 3)
    }))
    const threadId = "chat"
    type Stored = { readonly role: string; readonly text: string; readonly at: number }
    type ThreadModel = { readonly messages: Map<string, Stored>; createdAtMs?: number; updatedAtMs?: number }

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ops, pageSize }) =>
          Effect.gen(function*() {
            const store = yield* MemoryStore.MemoryStore
            const models: ReadonlyArray<ThreadModel> = twins.map(() => ({ messages: new Map() }))
            let now = 0

            for (const op of ops) {
              if (op._tag === "tick") {
                yield* TestClock.adjust(op.ms)
                now += op.ms
                continue
              }
              const namespace = twins[op.ns]!
              const model = models[op.ns]!
              if (op._tag === "delete") {
                const deleted = yield* store.deleteMessages({ namespace, threadId, ids: op.ids })
                let expected = 0
                for (const id of new Set(op.ids)) if (model.messages.delete(id)) expected += 1
                if (deleted !== expected) return false
                continue
              }
              const role = op._tag === "append" ? op.role : "user"
              const requestedAt = op._tag === "append" ? op.at : undefined
              const result = yield* Effect.result(
                op._tag === "append"
                  ? store.appendMessage({ namespace, threadId, id: op.id, role, text: op.text, at: op.at }).pipe(
                    Effect.as(undefined)
                  )
                  : store.appendMessageOnce({ namespace, threadId, id: op.id, role, text: op.text })
              )
              const existing = model.messages.get(op.id)
              if (existing === undefined) {
                if (Result.isFailure(result)) return false
                const at = requestedAt ?? now
                model.messages.set(op.id, { role, text: op.text, at })
                model.updatedAtMs = Math.max(model.updatedAtMs ?? at, at)
              } else {
                // A retry is accepted only as the stored message; it never rewrites it.
                const same = existing.role === role && existing.text === op.text &&
                  (requestedAt === undefined || requestedAt === existing.at)
                if (Result.isSuccess(result) !== same) return false
                if (Result.isFailure(result) && result.failure.code !== "idempotency_conflict") return false
                // An append without a time answers with the time first stored.
                if (Result.isSuccess(result) && result.success !== undefined && result.success.at !== existing.at) {
                  return false
                }
              }
              // The first append made the thread at that message's time.
              model.createdAtMs ??= requestedAt ?? now
            }

            for (let index = 0; index < twins.length; index++) {
              const namespace = twins[index]!
              const model = models[index]!
              const expected = [...model.messages.entries()]
                .map(([id, message]) => ({ threadId, id, ...message }))
                .sort((left, right) => left.at - right.at || compareUtf8(left.id, right.id))
              const listed = yield* store.listMessages({ namespace, threadId })
              if (JSON.stringify(listed) !== JSON.stringify(expected)) return false

              // Cursor pagination walks the same sequence: no skip, no repeat.
              const paged: Array<MemoryStore.Message> = []
              let cursor: MemoryStore.MessageCursor | undefined
              for (let guard = 0; guard <= expected.length; guard++) {
                const page = yield* store.listMessages({ namespace, threadId, limit: pageSize, cursor })
                if (page.length > pageSize) return false
                paged.push(...page)
                const last = page.at(-1)
                if (last === undefined || page.length < pageSize) break
                cursor = { at: last.at, id: last.id }
              }
              if (JSON.stringify(paged) !== JSON.stringify(expected)) return false

              if ((yield* store.countMessages({ namespace, threadId })) !== expected.length) return false
              const stats = yield* store.messageStats({ namespace, threadId })
              const bytes = expected.reduce((total, message) => total + utf8Length(message.text), 0)
              const codePoints = expected.reduce((total, message) => total + [...message.text].length, 0)
              const units = expected.reduce((total, message) => total + message.text.length, 0)
              if (stats.messages !== expected.length || stats.bytes !== bytes || stats.codePoints !== codePoints) {
                return false
              }
              if (stats.codePoints > units || units > stats.bytes) return false

              const thread = yield* store.getThread({ namespace, threadId })
              if (model.createdAtMs === undefined) {
                if (thread !== undefined) return false
              } else if (
                // Deleting messages never deletes the thread or moves its clock back.
                thread?.createdAtMs !== model.createdAtMs || thread.updatedAtMs !== model.updatedAtMs ||
                thread.namespace.kind !== namespace.kind
              ) {
                return false
              }
            }
            return true
          }).pipe(Effect.provide(memoryLayer)),
        { seed: seed + 2, executions: ioExecutions }
      )
    )
    assertPassed(report)
  })
})

describe("@smthrs/memory recall ranking", () => {
  const ResultArb = Schema.Struct({
    bank: Schema.Literals(["user-alice", "user-bob", "flow-alice"]),
    key: Schema.Literals(["k", "K", "k ", "é", "￿", "😀"]),
    text: Schema.Literals(["x", "guide", "naïve 😀 guide", "😀😀😀😀"]),
    score: Schema.Literals([0, 1, 1.5, 2, 1e9]),
    updatedAtMs: Schema.Union([Schema.Undefined, Schema.Literals([0, 1, 7, 1_800_000_000_000])])
  })
  const toResult = (row: typeof ResultArb.Type): Recall.Result => ({
    bank: row.bank,
    key: row.key,
    text: row.text,
    score: row.score,
    ...(row.updatedAtMs === undefined ? {} : { updatedAtMs: row.updatedAtMs })
  })

  it("Recall.compareResults is a strict weak order and capRecallResults a monotone, well-formed prefix", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      rows: Schema.Array(ResultArb).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(9))),
      rotate: intBetween(0, 8),
      budgets: Schema.Tuple([intBetween(0, 600), intBetween(0, 600)])
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rows, rotate, budgets }) =>
          Effect.sync(() => {
            const results = rows.map(toResult)
            for (const a of results) {
              if (Recall.compareResults(a, a) !== 0) return false
              for (const b of results) {
                const ab = Recall.compareResults(a, b)
                if (Math.sign(ab) !== -Math.sign(Recall.compareResults(b, a))) return false
                // Only a row with the same rank fields compares equal.
                const same = a.score === b.score && (a.updatedAtMs ?? 0) === (b.updatedAtMs ?? 0) &&
                  a.key === b.key && a.bank === b.bank
                if ((ab === 0) !== same) return false
                for (const c of results) {
                  if (ab <= 0 && Recall.compareResults(b, c) <= 0 && Recall.compareResults(a, c) > 0) return false
                }
              }
            }
            // The ranking never depends on the order rows arrived in.
            const cut = rotate % results.length
            const rank = (input: ReadonlyArray<Recall.Result>) =>
              JSON.stringify(
                [...input].sort(Recall.compareResults).map((
                  row
                ) => [row.score, row.updatedAtMs ?? 0, row.key, row.bank])
              )
            if (rank(results) !== rank([...results.slice(cut), ...results.slice(0, cut)].reverse())) return false
            const ranked = [...results].sort(Recall.compareResults)
            for (let index = 1; index < ranked.length; index++) {
              if (ranked[index - 1]!.score < ranked[index]!.score) return false
            }

            const [small, large] = budgets[0] <= budgets[1] ? budgets : [budgets[1], budgets[0]]
            const tight = Recall.capRecallResults(ranked, small)
            const loose = Recall.capRecallResults(ranked, large)
            for (const [capped, budget] of [[tight, small], [loose, large]] as const) {
              // The cap is a UTF-8 byte ceiling on the serialized selection.
              if (capped.length > 0 && utf8Length(JSON.stringify(capped)) > budget) return false
              for (let index = 0; index < capped.length; index++) {
                const source = ranked[index]!
                const row = capped[index]!
                // Rows keep their rank; only the last may be cut, and never mid code point.
                if (row.key !== source.key || row.bank !== source.bank || row.score !== source.score) return false
                if (index < capped.length - 1 ? row.text !== source.text : !source.text.startsWith(row.text)) {
                  return false
                }
                if (row.text.length === 0 || !row.text.isWellFormed()) return false
              }
            }
            // A larger budget never recalls less.
            if (tight.length > loose.length) return false
            const tightLast = tight.at(-1)
            return tightLast === undefined || loose[tight.length - 1]!.text.startsWith(tightLast.text)
          }),
        { seed: seed + 3, executions: pureExecutions }
      )
    )
    assertPassed(report)
  })

  it("RecallKeyword ranks the authoritative rows of the requested banks only, in any bank order", async () => {
    const banks: ReadonlyArray<Namespace.Namespace> = [
      { kind: "user", id: "alice" },
      { kind: "user", id: "bob" },
      { kind: "flow", id: "alice" }
    ]
    const Word = Schema.Literals(["guide", "GUIDE", "tabs", "ｓｐａｃｅｓ", "naïve", "zzz"])
    const Record = Schema.Struct({
      bank: intBetween(0, 2),
      kind: Schema.Literals(["fact", "note"]),
      key: Schema.Literals(["prefs", "style", "guide"]),
      words: Schema.Array(Word).pipe(Schema.check(Schema.isMaxLength(4))),
      status: Schema.Literals(["pending", "accepted", "accepted", "rejected"]),
      supersedes: Schema.Union([Schema.Undefined, Schema.Literals(["prefs", "style", "guide"])]),
      tick: intBetween(0, 2)
    })
    const arb = Arbitrary.schema(Schema.Struct({
      records: Schema.Array(Record).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(12))),
      requested: Schema.Array(intBetween(0, 2)).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4))),
      query: Schema.Array(Word).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(3))),
      maxTokens: Schema.Literals([64, 200, 2048])
    }))

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ records, requested, query, maxTokens }) =>
          Effect.gen(function*() {
            const store = yield* MemoryStore.MemoryStore
            for (const record of records) {
              yield* TestClock.adjust(record.tick)
              const namespace = banks[record.bank]!
              // The text names its own bank, kind and key, so a recalled row says where it came from.
              const text = `${Recall.bankForNamespace(namespace)}|${record.kind}/${record.key}| ${
                record.words.join(" ")
              }`
              if (record.kind === "fact") {
                yield* store.putFact({ namespace, key: record.key, value: text, provenance: {} })
              } else {
                yield* Effect.result(store.putNote({
                  namespace,
                  id: record.key,
                  text,
                  tags: [],
                  provenance: {},
                  status: record.status,
                  ...(record.supersedes === undefined ? {} : { supersedes: [record.supersedes] })
                }))
              }
            }

            const names = requested.map((index) => Recall.bankForNamespace(banks[index]!))
            const input = { banks: names, query: query.join(" "), maxTokens }
            const recalled = yield* RecallKeyword.recall(input)

            // The oracle scores the store's own authoritative rows.
            const terms = RecallKeyword.normalizeQueryTerms(input.query)
            const candidates: Array<Recall.Result> = []
            const hidden = new Set<string>()
            for (const index of new Set(requested)) {
              const namespace = banks[index]!
              const bank = Recall.bankForNamespace(namespace)
              for (const row of yield* store.searchRows({ namespace, status: "accepted" })) {
                const score = RecallKeyword.scoreRow(terms, row)
                if (score > 0) {
                  candidates.push({ bank, key: row.key, text: row.text, score, updatedAtMs: row.updatedAtMs })
                }
              }
              const current = new Set((yield* store.listNotes({ namespace })).map((note) => note.id))
              for (const note of yield* store.listNotes({ namespace, status: "any", includeSuperseded: true })) {
                if (!current.has(note.id)) {
                  hidden.add(`${bank}|note/${note.id}|`)
                }
              }
            }
            const expected = Recall.capRecallResults(candidates.sort(Recall.compareResults), maxTokens)
            if (JSON.stringify(recalled) !== JSON.stringify(expected)) return false

            for (let index = 0; index < recalled.length; index++) {
              const row = recalled[index]!
              // No row of an unrequested bank, even one holding the same key.
              // The cap may cut the last row's text short of its whole origin.
              const origin = `${row.bank}|`
              if (!names.includes(row.bank)) return false
              if (!row.text.startsWith(origin) && !origin.startsWith(row.text)) return false
              // A pending, rejected or superseded note is never recalled.
              if ([...hidden].some((origin) => row.text.startsWith(origin))) return false
              if (row.score <= 0) return false
              if (index > 0 && Recall.compareResults(recalled[index - 1]!, row) > 0) return false
            }
            if (utf8Length(JSON.stringify(recalled)) > maxTokens && recalled.length > 0) return false

            // The request's bank order and repeats never change the answer.
            const reordered = yield* RecallKeyword.recall({ ...input, banks: [...new Set(names)].reverse() })
            return JSON.stringify(reordered) === JSON.stringify(recalled)
          }).pipe(Effect.provide(memoryLayer)),
        { seed: seed + 4, executions: ioExecutions }
      )
    )
    assertPassed(report)
  })
})
