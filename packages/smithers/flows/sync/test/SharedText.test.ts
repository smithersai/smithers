/**
 * SharedText: replicas that edit one text at once converge, keep every edit,
 * carry cursors through each other's edits, and refuse what isn't an update.
 * The properties deliver updates in a shuffled order with repeats, as a
 * transport that is late, reordered and at-least-once does.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as fc from "fast-check"
import * as Y from "yjs"
import * as SharedText from "../src/SharedText.vibe"

/** Runs `body` with `count` fresh replicas, closed afterwards. */
const replicas = <A>(count: number, body: (texts: ReadonlyArray<SharedText.SharedText>) => Effect.Effect<A, unknown>) =>
  Effect.scoped(Effect.flatMap(Effect.all(Array.from({ length: count }, () => SharedText.make)), body))

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runSync(effect)

/** One edit a replica makes, in proportions of its text's length so it always lands. */
const Op = fc.oneof(
  fc.record({
    kind: fc.constant("insert" as const),
    at: fc.double({ min: 0, max: 1, noNaN: true }),
    text: fc.string({ maxLength: 4 })
  }),
  fc.record({
    kind: fc.constant("delete" as const),
    at: fc.double({ min: 0, max: 1, noNaN: true }),
    length: fc.integer({ min: 0, max: 3 })
  }),
  fc.record({ kind: fc.constant("replace" as const), text: fc.string({ maxLength: 6 }) })
)
type Op = typeof Op extends fc.Arbitrary<infer A> ? A : never

/** Makes `op` on `text`: the update it sent, if any. */
const perform = (text: SharedText.SharedText, op: Op) =>
  Effect.gen(function*() {
    const now = yield* text.text
    if (op.kind === "replace") return yield* text.replace(op.text)
    const at = Math.floor(op.at * now.length)
    return yield* op.kind === "insert"
      ? text.edit([{ from: at, to: at, insert: op.text }])
      : text.edit([{ from: at, to: at + op.length, insert: "" }])
  })

describe("SharedText", () => {
  it("converges: replicas editing at once, updates delivered shuffled and repeated, end with one text", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(Op, { maxLength: 6 }), { minLength: 2, maxLength: 4 }),
        fc.array(fc.nat(), { minLength: 40, maxLength: 40 }),
        (scripts, shuffle) =>
          run(replicas(scripts.length + 1, (texts) =>
            Effect.gen(function*() {
              const sent: Array<Uint8Array> = []
              // Each replica edits without hearing the others: every edit is concurrent.
              for (const [index, script] of scripts.entries()) {
                for (const op of script) {
                  const update = yield* perform(texts[index]!, op)
                  if (update !== undefined) sent.push(update)
                }
              }
              const late = [...sent, ...sent.slice(0, shuffle[0]! % (sent.length + 1))]
                .map((update, index) => ({ update, key: shuffle[index % shuffle.length]! + index * 7919 }))
                .sort((left, right) => left.key - right.key)
                .map(({ update }) => update)
              for (const text of texts) for (const update of late) yield* text.apply(update)
              const finals = yield* Effect.forEach(texts, (text) => text.text)
              expect(new Set(finals).size).toBe(1)
            })))
      ),
      { numRuns: 150 }
    )
  })

  it("loses nothing: every replica's concurrent insertion is in every replica once", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 2, maxLength: 5 }),
        fc.string({ maxLength: 12 }),
        (places, start) =>
          run(replicas(places.length, (texts) =>
            Effect.gen(function*() {
              // Both delimiters are absent from the seed. Distinct ends prevent
              // a match across a marker's close, a seed digit and the next open.
              const [open, close] = Array.from({ length: start.length + 2 }, (_, index) => String.fromCharCode(index))
                .filter((candidate) => !start.includes(candidate))
              const inserted = places.map((_, index) => `${open!}${index}${close!}`)
              const base = SharedText.seed(start)
              for (const text of texts) yield* text.apply(base)
              const updates = yield* Effect.forEach(texts, (text, index) => {
                const at = Math.floor(places[index]! * start.length)
                return text.edit([{ from: at, to: at, insert: inserted[index]! }])
              })
              for (const text of texts) for (const update of [...updates].reverse()) yield* text.apply(update!)
              for (const text of texts) {
                const final = yield* text.text
                for (const token of inserted) expect(final.split(token)).toHaveLength(2)
                expect(inserted.reduce((rest, token) => rest.replaceAll(token, ""), final)).toBe(start)
              }
            })))
      ),
      { numRuns: 150, examples: [[[0, 0], "<0>"], [[0, 0], "\0"], [[0.5, 0, 0], "0 "]] }
    )
  })

  it.effect("keeps a deletion and an insertion made at once inside it", () =>
    replicas(2, ([ada, bob]) =>
      Effect.gen(function*() {
        yield* ada!.apply(SharedText.seed("hello world"))
        yield* bob!.apply(SharedText.seed("hello world"))
        const cleared = yield* ada!.edit([{ from: 0, to: 11, insert: "" }])
        const typed = yield* bob!.edit([{ from: 5, to: 5, insert: "," }])
        yield* ada!.apply(typed!)
        yield* bob!.apply(cleared!)
        expect(yield* ada!.text).toBe(",")
        expect(yield* bob!.text).toBe(",")
      })))

  it.effect("applies several changes in one edit, each in the text before any of them", () =>
    replicas(2, ([ada, bob]) =>
      Effect.gen(function*() {
        yield* ada!.apply(SharedText.seed("abcdef"))
        const update = yield* ada!.edit([
          { from: 1, to: 2, insert: "B" },
          { from: 4, to: 4, insert: "-" },
          { from: 5, to: 99, insert: "!" }
        ])
        expect(yield* ada!.text).toBe("aBcd-e!")
        yield* bob!.apply(SharedText.seed("abcdef"))
        yield* bob!.apply(update!)
        expect(yield* bob!.text).toBe("aBcd-e!")
      })))

  it.effect("answers no update for an edit that changes nothing", () =>
    replicas(1, ([ada]) =>
      Effect.gen(function*() {
        expect(yield* ada!.edit([])).toBeUndefined()
        expect(yield* ada!.edit([{ from: 3, to: 3, insert: "" }])).toBeUndefined()
        expect(yield* ada!.replace("")).toBeUndefined()
        expect(yield* ada!.replace("x")).toBeInstanceOf(Uint8Array)
        expect(yield* ada!.replace("x")).toBeUndefined()
      })))

  it.effect("an update applied twice, or before the one it builds on, still gives the text once", () =>
    replicas(2, ([ada, bob]) =>
      Effect.gen(function*() {
        const first = yield* ada!.replace("one")
        const second = yield* ada!.replace("one two")
        yield* bob!.apply(second!)
        expect(yield* bob!.text).toBe("")
        yield* bob!.apply(first!)
        yield* bob!.apply(first!)
        yield* bob!.apply(second!)
        expect(yield* bob!.text).toBe("one two")
      })))

  describe("an edit made on an older text", () => {
    /** Ada's replica holds `current`; her input still showed `base` when she made it `next`. */
    const stale = (base: string, current: string, next: string, caret?: number) =>
      Effect.runSync(replicas(1, ([ada]) =>
        Effect.gen(function*() {
          yield* ada!.apply(SharedText.seed(base))
          yield* ada!.replace(current)
          yield* ada!.replace(next, { base, ...(caret === undefined ? {} : { caret }) })
          return yield* ada!.text
        })))

    it("keeps the update that arrived meanwhile, before, after or around it", () => {
      // Bob added " world"; Ada typed "!" at the start of the "hello" she still saw.
      expect(stale("hello", "hello world", "!hello", 1)).toBe("!hello world")
      // Bob replaced "b" with "XYZ"; Ada typed "Q" after the "b".
      expect(stale("abc", "aXYZc", "abQc", 3)).toBe("aXYZQc")
      // Bob typed "X" where Ada's deletion of "cd" starts.
      expect(stale("abcdef", "abXcdef", "abef", 2)).toBe("abXef")
      // Bob replaced "cd" with "XY" where Ada's deletion of "bcd" ends.
      expect(stale("abcdef", "abXYef", "aef", 1)).toBe("aXYef")
      // Bob's text sits inside what Ada replaced: it stays, after hers.
      expect(stale("abcdef", "abcXdef", "aQf", 2)).toBe("aQXf")
      // Ada typed inside what Bob replaced: hers goes after his.
      expect(stale("abcdef", "aXYZef", "abcQdef", 4)).toBe("aXYZQef")
      // Ada replaced only text Bob had already replaced: hers goes after his.
      expect(stale("abcdef", "aXYZef", "abQef", 3)).toBe("aXYZQef")
      // Ada typed after Bob's change.
      expect(stale("abc", "Xabc", "abcQ", 4)).toBe("XabcQ")
      // Ada deleted after Bob's change, and across it.
      expect(stale("abcdef", "Xabcdef", "abc", 3)).toBe("Xabc")
      expect(stale("abcdef", "abXYef", "af", 1)).toBe("aXYf")
      // A base that is the replica's own text is an ordinary replace.
      expect(stale("abc", "abc", "abcd", 4)).toBe("abcd")
    })
  })

  it.effect("merges several updates into one that applies as they would", () =>
    replicas(2, ([ada, bob]) =>
      Effect.gen(function*() {
        const updates = [(yield* ada!.replace("a"))!, (yield* ada!.replace("ab"))!, (yield* ada!.replace("abc"))!]
        yield* bob!.apply(SharedText.merge(updates))
        expect(yield* bob!.text).toBe("abc")
      })))

  describe("changeOf", () => {
    it("places a letter typed beside the same letter where the caret is", () => {
      expect(SharedText.changeOf("aa", "aaa", 2)).toEqual({ from: 1, to: 1, insert: "a" })
      expect(SharedText.changeOf("aa", "aaa", 3)).toEqual({ from: 2, to: 2, insert: "a" })
      expect(SharedText.changeOf("aa", "aaa")).toEqual({ from: 0, to: 0, insert: "a" })
      expect(SharedText.changeOf("abc", "ac", 1)).toEqual({ from: 1, to: 2, insert: "" })
      expect(SharedText.changeOf("abc", "aXc", 2)).toEqual({ from: 1, to: 2, insert: "X" })
      expect(SharedText.changeOf("same", "same", 2)).toEqual({ from: 2, to: 2, insert: "" })
    })

    it("clamps a caret outside the text", () => {
      expect(SharedText.changeOf("ab", "abc", 99)).toEqual({ from: 2, to: 2, insert: "c" })
      expect(SharedText.changeOf("ab", "abc", -5)).toEqual({ from: 2, to: 2, insert: "c" })
    })

    it("never splits a surrogate pair", () => {
      // 😀 and 😃 share their high surrogate.
      expect(SharedText.changeOf("😀", "😃")).toEqual({ from: 0, to: 2, insert: "😃" })
      expect(SharedText.changeOf("x😀", "x😃", 3)).toEqual({ from: 1, to: 3, insert: "😃" })
      // ≈ and ≉ share nothing, but 𝒜 and 𝒞 share their high surrogate and end in the same code unit after it.
      expect(SharedText.changeOf("a𝒜b", "a𝒞b")).toEqual({ from: 1, to: 3, insert: "𝒞" })
      expect(SharedText.changeOf("𝒜", "𝂜")).toEqual({ from: 0, to: 2, insert: "𝂜" })
    })

    it("turns any text into any other", () => {
      fc.assert(
        fc.property(
          fc.string(),
          fc.string(),
          fc.option(fc.integer({ min: -2, max: 40 }), { nil: undefined }),
          (before, after, caret) => {
            const change = SharedText.changeOf(before, after, caret)
            expect(before.slice(0, change.from) + change.insert + before.slice(change.to)).toBe(after)
          }
        )
      )
    })
  })

  describe("anchors", () => {
    it.effect("follow the text through another replica's edits", () =>
      replicas(2, ([ada, bob]) =>
        Effect.gen(function*() {
          const seeded = SharedText.seed("hello world")
          yield* ada!.apply(seeded)
          yield* bob!.apply(seeded)
          const cursor = yield* ada!.anchor(6)
          const end = yield* ada!.anchor(11)
          expect(yield* bob!.resolve(cursor)).toBe(6)
          yield* ada!.apply((yield* bob!.edit([{ from: 0, to: 0, insert: ">> " }]))!)
          expect(yield* ada!.resolve(cursor)).toBe(9)
          expect(yield* ada!.resolve(end)).toBe(14)
          expect(yield* bob!.resolve(end)).toBe(14)
        })))

    it.effect("clamp an index outside the text", () =>
      replicas(1, ([ada]) =>
        Effect.gen(function*() {
          yield* ada!.replace("abc")
          expect(yield* ada!.resolve(yield* ada!.anchor(99))).toBe(3)
          expect(yield* ada!.resolve(yield* ada!.anchor(-4))).toBe(0)
        })))

    it.effect("resolve to nothing before the text they point into arrives, or for bytes that aren't one", () =>
      replicas(2, ([ada, bob]) =>
        Effect.gen(function*() {
          const typed = yield* ada!.replace("abc")
          const cursor = yield* ada!.anchor(1)
          expect(yield* bob!.resolve(cursor)).toBeUndefined()
          yield* bob!.apply(typed!)
          expect(yield* bob!.resolve(cursor)).toBe(1)
          expect(yield* bob!.resolve(new Uint8Array([255, 255, 255]))).toBeUndefined()
          const other = new Y.Doc()
          const elsewhere = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(other.getText("notes"), 0))
          expect(yield* bob!.resolve(elsewhere)).toBeUndefined()
        })))
  })

  describe("seed", () => {
    it("is the same bytes for the same text, and gives the text once however often it is applied", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 40 }), (text) => {
          expect(SharedText.seed(text)).toEqual(SharedText.seed(text))
          run(replicas(1, ([ada]) =>
            Effect.gen(function*() {
              yield* ada!.apply(SharedText.seed(text))
              yield* ada!.apply(SharedText.seed(text))
              expect(yield* ada!.text).toBe(text)
            })))
        })
      )
    })

    it.effect("is edited on like any text", () =>
      replicas(2, ([ada, bob]) =>
        Effect.gen(function*() {
          yield* ada!.apply(SharedText.seed("body { }"))
          yield* bob!.apply(SharedText.seed("body { }"))
          yield* bob!.apply((yield* ada!.edit([{ from: 7, to: 7, insert: "color: red; " }]))!)
          expect(yield* bob!.text).toBe("body { color: red; }")
        })))
  })

  describe("marks", () => {
    it("converge: replicas setting marks at once, updates delivered shuffled and repeated, end with one value per mark", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.array(fc.tuple(fc.constantFrom("saved", "other"), fc.string({ maxLength: 4 })), { maxLength: 4 }),
            {
              minLength: 2,
              maxLength: 4
            }
          ),
          fc.array(fc.nat(), { minLength: 20, maxLength: 20 }),
          (scripts, shuffle) =>
            run(replicas(scripts.length, (texts) =>
              Effect.gen(function*() {
                const sent: Array<Uint8Array> = []
                for (const [index, script] of scripts.entries()) {
                  for (const [name, value] of script) {
                    const update = yield* texts[index]!.mark(name, value)
                    if (update !== undefined) sent.push(update)
                  }
                }
                const late = [...sent, ...sent.slice(0, shuffle[0]! % (sent.length + 1))]
                  .map((update, index) => ({ update, key: shuffle[index % shuffle.length]! + index * 7919 }))
                  .sort((left, right) => left.key - right.key)
                  .map(({ update }) => update)
                for (const text of texts) for (const update of late) yield* text.apply(update)
                const finals = yield* Effect.forEach(
                  texts,
                  (text) => Effect.map(text.marks, (marks) => JSON.stringify([...marks].sort()))
                )
                expect(new Set(finals).size).toBe(1)
                // Marks never touch the text.
                for (const text of texts) expect(yield* text.text).toBe("")
              })))
        ),
        { numRuns: 150 }
      )
    })

    it.effect("a mark set after seeing another replaces it; setting the value it holds sends nothing", () =>
      replicas(3, ([ada, bob, carol]) =>
        Effect.gen(function*() {
          yield* ada!.apply(SharedText.seed("body {}"))
          yield* bob!.apply(SharedText.seed("body {}"))
          expect(yield* ada!.marks).toEqual(new Map())
          const first = yield* ada!.mark("saved", "one")
          yield* bob!.apply(first!)
          expect(yield* bob!.marks).toEqual(new Map([["saved", "one"]]))
          expect(yield* bob!.mark("saved", "one")).toBeUndefined()
          yield* ada!.apply((yield* bob!.mark("saved", "two"))!)
          expect(yield* ada!.marks).toEqual(new Map([["saved", "two"]]))
          // A late, repeated delivery of the older mark changes nothing.
          yield* ada!.apply(first!)
          expect(yield* ada!.marks).toEqual(new Map([["saved", "two"]]))
          expect(yield* ada!.text).toBe("body {}")
          // A snapshot carries the marks, and a mark is an ordinary update to a server.
          yield* carol!.apply(yield* ada!.snapshot)
          expect(yield* carol!.marks).toEqual(new Map([["saved", "two"]]))
          yield* SharedText.validate((yield* carol!.mark("saved", "three"))!, { seed: false })
        })))

    it.effect("a value that isn't a string, from a replica outside this module, isn't a mark", () =>
      replicas(1, ([ada]) =>
        Effect.gen(function*() {
          const foreign = new Y.Doc()
          foreign.getMap(SharedText.marksName).set("count", 3)
          foreign.getMap(SharedText.marksName).set("saved", "x")
          yield* ada!.apply(Y.encodeStateAsUpdate(foreign))
          foreign.destroy()
          expect(yield* ada!.marks).toEqual(new Map([["saved", "x"]]))
        })))
  })

  describe("validate", () => {
    it.effect("takes a seed as a seed and an edit as an edit", () =>
      replicas(1, ([ada]) =>
        Effect.gen(function*() {
          yield* SharedText.validate(SharedText.seed("x"), { seed: true })
          yield* SharedText.validate(SharedText.seed(""), { seed: true })
          yield* ada!.apply(SharedText.seed("x"))
          yield* SharedText.validate((yield* ada!.replace("xy"))!, { seed: false })
          // Deleting seeded text is an ordinary edit.
          yield* SharedText.validate((yield* ada!.replace("y"))!, { seed: false })
        })))

    it.effect("refuses text written as the seed's replica outside a seed, and a seed with anyone else's", () =>
      replicas(1, ([ada]) =>
        Effect.gen(function*() {
          const forged = yield* Effect.exit(SharedText.validate(SharedText.seed("x"), { seed: false }))
          expect(forged).toEqual(Exit.fail(new SharedText.InvalidUpdate({ reason: "seed_client" })))
          const typed = yield* ada!.replace("x")
          const notASeed = yield* Effect.exit(SharedText.validate(typed!, { seed: true }))
          expect(notASeed).toEqual(Exit.fail(new SharedText.InvalidUpdate({ reason: "seed_client" })))
        })))

    it.effect("refuses bytes that aren't an update, and so does apply, which changes nothing", () =>
      replicas(1, ([ada]) =>
        Effect.gen(function*() {
          yield* ada!.replace("kept")
          const garbage = new Uint8Array([7, 255, 1, 3])
          const refused = Exit.fail(new SharedText.InvalidUpdate({ reason: "malformed" }))
          expect(yield* Effect.exit(SharedText.validate(garbage, { seed: false }))).toEqual(refused)
          expect(yield* Effect.exit(ada!.apply(garbage))).toEqual(refused)
          expect(yield* ada!.text).toBe("kept")
        })))
  })

  it.effect("a snapshot carries everything a replica holds", () =>
    replicas(2, ([ada, bob]) =>
      Effect.gen(function*() {
        yield* ada!.apply(SharedText.seed("a"))
        yield* ada!.replace("ab")
        yield* ada!.replace("abc")
        yield* bob!.apply(yield* ada!.snapshot)
        expect(yield* bob!.text).toBe("abc")
      })))
})
