/**
 * The run's automatic call ledger.
 *
 * These cases fix what a line says and what it never says: a line names the
 * call and the shape of its result, and it carries no payload at all.
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as CallLedger from "../src/CallLedger.ts"

const settlement = (
  flow: string,
  input: unknown,
  value: unknown = null,
  message?: string
): CallLedger.Settlement => ({
  flow,
  input: input as never,
  ok: message === undefined,
  value: value as never,
  ...(message === undefined ? {} : { message })
})

const wrote = (
  flow: string,
  input: unknown,
  value: unknown = null,
  message?: string
): CallLedger.Settlement => ({ ...settlement(flow, input, value, message), mutates: true })

describe("CallLedger.subject", () => {
  it("names the first term of the input that names a target", () => {
    // The same lexer and the same target/condition split `NarrowedCheck` uses,
    // so a path, a test id, or the file inside a shell command is picked out
    // without this module knowing what any of those are.
    expect(CallLedger.subject({ command: "python -m pytest tests/test_a.py -q" })).toBe("tests/test_a.py")
    expect(CallLedger.subject({ limit: 70, offset: 100, path: "sphinx/util/rst.py" })).toBe("sphinx/util/rst.py")
  })

  it("quotes the whole input when nothing in it names a target", () => {
    expect(CallLedger.subject({ pattern: "fromstring" })).toBe("{\"pattern\":\"fromstring\"}")
  })

  it("skips a separator that names nothing, so a glob-only search is named by its own terms", () => {
    // `**/*.py` lexes to a bare `/` and a bare `.py`. Both carry a separator,
    // so `NarrowedCheck.targeting` accepts both, and neither tells a reader
    // which search this was.
    expect(CallLedger.subject({ globs: ["**/*.py"], pattern: "docinfo_re", root: "sphinx" })).toBe(
      "{\"globs\":[\"**/*.py\"],\"pattern\":\"docinfo_re\",\"root\":\"sphinx\"}"
    )
    expect(CallLedger.subject({ globs: ["**/*.py"], path: "sphinx/util/rst.py" })).toBe("sphinx/util/rst.py")
  })

  it("quotes the whole input when it names several targets, because one of them is not the subject", () => {
    // A `classify` batch over four files: named after the first of them, the
    // line said which file it had judged and never said what it asked. The
    // question is in the input, so the input is the subject.
    const batch = {
      questions: { mentionsLine: { instructions: "Does this text contain the word line?", type: "boolean" } },
      states: ["notes/n1.txt", "notes/n2.txt"].map((path) => ({ path, text: "this line matters" }))
    }
    expect(CallLedger.sole(batch)).toBeUndefined()
    expect(CallLedger.subject(batch)).toContain("Does this text contain the word line?")
    expect(CallLedger.subject(batch)).not.toBe("notes/n1.txt")
  })

  it("names the one target however often the input repeats it", () => {
    // A patch names its file on every hunk header, and it is one target.
    expect(CallLedger.sole({ patch: "*** Update File: a/b.py\n@@\n-x\n+y\n*** End a/b.py" })).toBe("a/b.py")
  })

  it("clips a subject longer than the line allows, and says it clipped it", () => {
    const subject = CallLedger.subject({ command: "x".repeat(400) })
    expect(subject.startsWith(`{"command":"${"x".repeat(50)}`)).toBe(true)
    expect(subject).toContain("[+294b, clipped]")
  })
})

describe("CallLedger.digest", () => {
  it("reports counts and statuses and never the payload", () => {
    expect(CallLedger.digest({ exitCode: 1, stdout: "boom\n", stdoutTruncated: false })).toBe(
      "exitCode=1 stdout=5b stdoutTruncated=false"
    )
    expect(CallLedger.digest({ matches: [1, 2, 3], truncated: true })).toBe("matches=[3] truncated=true")
    expect(CallLedger.digest({ missing: null })).toBe("missing=null")
  })

  it("names a leaf by its path, because that is where a judgement sits", () => {
    expect(CallLedger.digest({ nested: { deep: 1 } })).toBe("nested.deep=1")
    expect(CallLedger.digest({ answers: { even: { type: "boolean", value: true, probability: 0.99 } } })).toBe(
      "answers.even.probability=0.99 answers.even.type=7b answers.even.value=true"
    )
  })

  it("folds an array of records into one leaf per path, with the values its members took", () => {
    expect(
      CallLedger.digest({
        results: [
          { ok: true, answers: { even: { value: false } } },
          { ok: true, answers: { even: { value: true } } },
          { ok: true, answers: { even: { value: false } } }
        ]
      })
    ).toBe("results[].answers.even.value=false×2 true results[].ok=true×3")
  })

  it("counts an array of scalars rather than descending into it", () => {
    expect(CallLedger.digest({ paths: ["a.ts", "b.ts"], empty: [] })).toBe("empty=[0] paths=[2]")
  })

  it("stops descending at the depth it declares", () => {
    const deep = (left: number): Schema.Json => left === 0 ? { leaf: 1 } : { down: deep(left - 1) }
    const path = Array.from({ length: CallLedger.depth }, () => "down").join(".")
    expect(CallLedger.digest(deep(CallLedger.depth))).toBe(`${path}={…}`)
    expect(CallLedger.digest(deep(CallLedger.depth - 1))).toBe(
      `${Array.from({ length: CallLedger.depth - 1 }, () => "down").join(".")}.leaf=1`
    )
  })

  it("caps how many distinct values one folded leaf names, and says how many it left out", () => {
    expect(CallLedger.digest({ rows: Array.from({ length: 5 }, (_, index) => ({ n: index })) })).toBe(
      "rows[].n=0 1 2 +2 more"
    )
  })

  it("tells an empty record from a record it stopped short of", () => {
    expect(CallLedger.digest({ usage: {} })).toBe("usage={}")
    expect(CallLedger.digest({})).toBe("{}")
  })

  it("names members in a stable order however the result was built", () => {
    expect(CallLedger.digest({ b: 1, a: 2 })).toBe(CallLedger.digest({ a: 2, b: 1 }))
  })

  it("caps how many members one line names, and says how many it left out", () => {
    const wide = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`k${index}`, index]))
    expect(CallLedger.digest(wide)).toBe("k0=0 k1=1 k2=2 k3=3 k4=4 k5=5 +3 more")
  })

  it("digests a result that is not an object at all", () => {
    expect(CallLedger.digest(null)).toBe("null")
    expect(CallLedger.digest(7)).toBe("7")
    expect(CallLedger.digest("hello")).toBe("5b")
    expect(CallLedger.digest([1, 2])).toBe("[2]")
  })

  it("reports string members in UTF-8 bytes", () => {
    expect(CallLedger.digest({ ascii: "A", cjk: "界", combining: "e\u0301", emoji: "\u{1F600}" })).toBe(
      "ascii=1b cjk=3b combining=3b emoji=4b"
    )
  })

  it("clips a digest wider than the result line allows, and says what it dropped", () => {
    const line = CallLedger.digest(
      Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`verylongkeyname${index}`.repeat(8), index]))
    )
    const [kept] = line.split("… [+")
    expect(new TextEncoder().encode(kept).byteLength).toBe(CallLedger.resultWidth)
    expect(line).toMatch(/… \[\+\d+b, clipped\]$/)
  })
})

describe("CallLedger.remember", () => {
  it("numbers calls across frames in one continuing sequence", () => {
    const first = CallLedger.remember([], [settlement("grep", { pattern: "x" })])
    const second = CallLedger.remember(first, [
      settlement("read", { path: "src/a.ts" }),
      settlement("bash", { command: "run src/a.ts" })
    ])

    expect(second.map((entry) => entry.ordinal)).toEqual([1, 2, 3])
    expect(second.map((entry) => entry.flow)).toEqual(["grep", "read", "bash"])
  })

  it("drops the oldest lines past the bound and keeps their ordinals honest", () => {
    const many = Array.from({ length: CallLedger.bound + 5 }, (_, index) => settlement("read", { path: `f${index}/a` }))
    const ledger = CallLedger.remember([], many)

    expect(ledger).toHaveLength(CallLedger.bound)
    expect(ledger[0]?.ordinal).toBe(6)
    expect(CallLedger.settled(ledger)).toBe(CallLedger.bound + 5)
  })

  it("records what the flow said about a failure, which is the whole of that result", () => {
    const ledger = CallLedger.remember([], [settlement("edit", { path: "a/b.py" }, null, "oldString does not occur")])
    expect(ledger[0]?.ok).toBe(false)
    expect(ledger[0]?.digest).toBe("oldString does not occur")
  })

  it("records a failure the flow said nothing about", () => {
    const ledger = CallLedger.remember([], [{ flow: "edit", input: { path: "a/b.py" }, ok: false, value: null }])
    expect(ledger[0]?.digest).toBe("failed")
  })

  it("records canonical results in UTF-8 bytes", () => {
    const ledger = CallLedger.remember([], [
      settlement("ascii", null, "A"),
      settlement("cjk", null, "界"),
      settlement("combining", null, "e\u0301"),
      settlement("emoji", null, "\u{1F600}")
    ])

    expect(ledger.map((entry) => entry.bytes)).toEqual([3, 5, 5, 6])
  })
})

describe("CallLedger.render", () => {
  it("renders nothing at all before the run has settled a call", () => {
    expect(CallLedger.render([])).toBeUndefined()
    expect(CallLedger.settled([])).toBe(0)
  })

  it("renders one line per call, oldest first", () => {
    const ledger = CallLedger.remember([], [
      settlement("grep", { pattern: "def x", root: "src/lib" }, { matches: [1, 2] })
    ])

    expect(CallLedger.render(ledger)).toContain("1. grep src/lib — ok: matches=[2] (17b)")
  })

  it("states how many lines aged out rather than renumbering what is left", () => {
    const many = Array.from({ length: CallLedger.bound + 2 }, (_, index) => settlement("read", { path: `f${index}/a` }))
    const rendered = CallLedger.render(CallLedger.remember([], many)) ?? ""

    expect(rendered).toContain(
      `Calls this run has settled (${CallLedger.bound + 2}), oldest first; the 2 oldest are not listed`
    )
    expect(rendered).toContain("3. read f2/a")
  })

  it("says nothing about writes for a run that has made none", () => {
    const ledger = CallLedger.remember([], [settlement("read", { path: "a/b.py" }, { content: "x" })])
    expect(CallLedger.render(ledger)).not.toContain("WROTE")
  })
})

describe("CallLedger and the writes a run has already made", () => {
  const patch = "*** Begin Patch\n" + "d".repeat(4_949)
  const applied = { modified: ["sympy/stats/crv_types.py"], output: "Success." }

  it("marks a write, names its target and states the bytes it carried", () => {
    // The target comes off the result here: a patch names its files in its own
    // text, so the input is one opaque blob and the paths come back in
    // `modified`. A line naming this call by the patch's first hundred bytes
    // would say nothing the next line could be matched against.
    const ledger = CallLedger.remember([], [wrote("apply_patch", { input: patch }, applied)])

    expect(ledger[0]?.mutates).toBe(true)
    expect(ledger[0]?.payloadBytes).toBe(4_965)
    expect(CallLedger.render(ledger)).toContain("1. apply_patch sympy/stats/crv_types.py — WROTE 4965b, ok:")
  })

  it("names a write by its first target even when it touches several", () => {
    // The sole-target rule is for reads: a write that names two files is still
    // the write to the first of them, and a line that fell back to the patch's
    // own bytes would say nothing the next line could be matched against.
    const two = "*** Update File: a/one.py\n-x\n+y\n*** Update File: a/two.py\n-p\n+q"
    const ledger = CallLedger.remember([], [wrote("apply_patch", { input: two }, { modified: ["a/one.py"] })])

    expect(ledger[0]?.subject).toBe("a/one.py")
  })

  it("points a repeated write back at the write it repeats", () => {
    // The `sympy__sympy-13878` shape, in miniature: the identical patch applied
    // in a later frame, after a revert, returning `Success` both times. Nothing
    // is refused; the second line simply says what it is.
    const first = CallLedger.remember([], [wrote("apply_patch", { input: patch }, applied)])
    const second = CallLedger.remember(first, [
      wrote("bash", { command: "git checkout -- sympy/stats/crv_types.py" }, { exitCode: 0 }),
      wrote("apply_patch", { input: patch }, applied)
    ])
    const rendered = CallLedger.render(second) ?? ""

    expect(rendered).toContain(
      "3. apply_patch sympy/stats/crv_types.py — WROTE 4965b, ok — the same write as 1, which succeeded"
    )
    expect(rendered).toContain("1. apply_patch sympy/stats/crv_types.py — WROTE 4965b, ok:")
    expect(rendered).toContain("A line marked `WROTE` changed the tree")
  })

  it("names the first attempt even when it failed, so a retry reads as one", () => {
    const ledger = CallLedger.remember([], [
      wrote("edit", { path: "a/b.py", newString: "widen" }, null, "oldString does not occur"),
      wrote("edit", { path: "a/b.py", newString: "widen" }, { hunk: "+widen" })
    ])
    expect(CallLedger.render(ledger)).toContain("the same write as 1, which failed")
  })

  it("does not call two different writes to one file the same write", () => {
    const ledger = CallLedger.remember([], [
      wrote("edit", { newString: "one", path: "a/b.py" }, { hunk: "+one" }),
      wrote("edit", { newString: "two", path: "a/b.py" }, { hunk: "+two" })
    ])
    expect(CallLedger.render(ledger)).not.toContain("the same write as")
  })

  it("does not mark a repeated read, because a repeated read is a different failure", () => {
    // Rule 7 asks a run to replay the check that failed for the right reason, so
    // a repeat there is compliance. Marking it would charge the contract's own
    // instruction as a mistake.
    const ledger = CallLedger.remember([], [
      settlement("bash", { command: "run-tests test_a" }, { exitCode: 1 }),
      settlement("bash", { command: "run-tests test_a" }, { exitCode: 0 })
    ])
    expect(CallLedger.render(ledger)).not.toContain("the same write as")
    expect(CallLedger.render(ledger)).not.toContain("WROTE")
  })

  it("survives the journal round trip a resumed run rebuilds it from", () => {
    const entry = CallLedger.remember([], [wrote("write", { content: "hello world", path: "a/b.py" })])[0]!
    const decoded = Schema.decodeUnknownSync(CallLedger.Entry)(JSON.parse(JSON.stringify(entry)))
    expect(decoded.mutates).toBe(true)
    expect(decoded.payloadBytes).toBe(11)
    expect(decoded.signature).toBe(entry.signature)
  })

  it("decodes a line journaled before writes were recorded at all", () => {
    const decoded = Schema.decodeUnknownSync(CallLedger.Entry)({
      ordinal: 1,
      flow: "read",
      subject: "a/b.py",
      ok: true,
      digest: "content=1b",
      bytes: 14
    })
    expect(decoded.mutates).toBe(false)
    expect(decoded.payloadBytes).toBe(0)
    expect(decoded.signature).toBe("")
  })
})

describe("CallLedger.payload", () => {
  it("reports the longest string the input carries, in UTF-8 bytes", () => {
    expect(CallLedger.payload({ content: "héllo", path: "a/b.py" })).toBe(6)
    expect(CallLedger.payload({ hunks: [{ text: "abc" }, { text: "abcdefg" }] })).toBe(7)
    expect(CallLedger.payload("plain")).toBe(5)
  })

  it("reports nothing for an input with no bytes to carry", () => {
    expect(CallLedger.payload({ path: 7, force: true })).toBe(0)
    expect(CallLedger.payload(null)).toBe(0)
    expect(CallLedger.payload(12)).toBe(0)
  })
})
