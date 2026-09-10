/**
 * The truncation ledger.
 *
 * These cases fix what the run remembers about output it was handed as a
 * fragment, and what counts as handing that fragment back: an exact byte match
 * and nothing looser, so derived content is never mistaken for a replay of the
 * cut capture.
 */
import * as Digest from "@smthrs/core/Digest"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as TruncatedOutput from "../src/TruncatedOutput.ts"

/** A payload comfortably over the ledger's floor. */
const long = (seed: string): string => seed.repeat(Math.ceil(2048 / seed.length))

const shellResult = (stdout: string, droppedBytes = 24_071): Schema.Json => ({
  exitCode: 0,
  stdout,
  stderr: "",
  stdoutTruncated: true,
  stderrTruncated: false,
  stdoutDroppedBytes: droppedBytes,
  stderrDroppedBytes: 0
})

describe("TruncatedOutput.captures", () => {
  it("records the field a suffixed flag names, with the bytes the flow dropped", () => {
    const stdout = long("def visit(node):\n    return node\n")
    const captures = TruncatedOutput.captures("bash", shellResult(stdout))

    expect(captures).toHaveLength(1)
    expect(captures[0]?.flow).toBe("bash")
    expect(captures[0]?.field).toBe("stdout")
    expect(captures[0]?.droppedBytes).toBe(24_071)
    expect(captures[0]?.digest).toBe(Digest.digest(stdout))
  })

  it("ignores a flag that is false, and a stream that was not cut", () => {
    expect(
      TruncatedOutput.captures("bash", {
        stdout: long("a"),
        stderr: long("b"),
        stdoutTruncated: false,
        stderrTruncated: false
      })
    ).toEqual([])
  })

  it("records nothing for a payload under the byte floor", () => {
    expect(TruncatedOutput.captures("bash", shellResult("tail\n"))).toEqual([])
  })

  it("records a payload of exactly the floor, and nothing one byte under it", () => {
    // The floor is a `<`, so the two sides of it are the only inputs that tell
    // a kept capture from a dropped one.
    const atFloor = "z".repeat(TruncatedOutput.minimumBytes)

    expect(TruncatedOutput.captures("bash", shellResult(atFloor))).toHaveLength(1)
    expect(TruncatedOutput.captures("bash", shellResult(atFloor.slice(1)))).toEqual([])
  })

  it("reports zero dropped bytes when the flow states none, or states a nonsense count", () => {
    const stdout = long("x")
    expect(
      TruncatedOutput.captures("bash", { stdout, stdoutTruncated: true })[0]?.droppedBytes
    ).toBe(0)
    expect(
      TruncatedOutput.captures("bash", { stdout, stdoutTruncated: true, stdoutDroppedBytes: -1 })[0]
        ?.droppedBytes
    ).toBe(0)
    expect(
      TruncatedOutput.captures("bash", { stdout, stdoutTruncated: true, stdoutDroppedBytes: "many" })[0]
        ?.droppedBytes
    ).toBe(0)
  })

  it("reads a bare flag as cutting every long string beside it", () => {
    const content = long("1\tfrom pytest import fixture\n")
    const captures = TruncatedOutput.captures("read", {
      content,
      startLine: 1,
      totalLines: 900,
      truncated: true,
      notice: "Showing 200 of 900 lines; output was truncated."
    })

    // The short notice beside the flag is disclosure, not a payload.
    expect(captures.map((capture) => capture.field)).toEqual(["content"])
    expect(captures[0]?.droppedBytes).toBe(0)
  })

  it("ignores a flag whose name is the bare suffix, which names no sibling", () => {
    expect(TruncatedOutput.captures("odd", { Truncated: true, stdout: long("x") })).toEqual([])
  })

  it("ignores a flag whose named sibling is absent or is not text", () => {
    expect(TruncatedOutput.captures("odd", { stdoutTruncated: true })).toEqual([])
    expect(TruncatedOutput.captures("odd", { stdout: 12, stdoutTruncated: true })).toEqual([])
  })

  it("finds a cut payload nested inside arrays and objects", () => {
    const stdout = long("nested\n")
    const captures = TruncatedOutput.captures("compound", {
      steps: [{ result: shellResult(stdout) }, null, 7]
    })

    expect(captures.map((capture) => capture.digest)).toEqual([Digest.digest(stdout)])
  })

  it("records nothing for a result that is not a JSON object", () => {
    expect(TruncatedOutput.captures("bash", null)).toEqual([])
    expect(TruncatedOutput.captures("bash", long("scalar"))).toEqual([])
  })
})

describe("TruncatedOutput.reuse", () => {
  const stdout = long("class Module:\n    pass\n")
  const ledger = TruncatedOutput.captures("bash", shellResult(stdout))

  it("finds the input field that carries a capture verbatim", () => {
    const found = TruncatedOutput.reuse({ path: "src/module.py", content: stdout }, ledger)

    expect(found?.path).toBe("content")
    expect(found?.capture.flow).toBe("bash")
  })

  it("passes a large input that is not a capture", () => {
    expect(TruncatedOutput.reuse({ path: "src/module.py", content: long("other\n") }, ledger))
      .toBeUndefined()
  })

  it("passes content derived from a capture rather than handed back whole", () => {
    expect(TruncatedOutput.reuse({ content: `${stdout}\n# appended` }, ledger)).toBeUndefined()
    expect(TruncatedOutput.reuse({ content: stdout.slice(1) }, ledger)).toBeUndefined()
  })

  it("passes every input while the ledger is empty", () => {
    expect(TruncatedOutput.reuse({ content: stdout }, [])).toBeUndefined()
  })

  it("finds a capture handed back at exactly the floor, which is the smallest one there is", () => {
    const atFloor = "z".repeat(TruncatedOutput.minimumBytes)
    const floorLedger = TruncatedOutput.captures("bash", shellResult(atFloor))

    expect(floorLedger).toHaveLength(1)
    expect(TruncatedOutput.reuse({ content: atFloor }, floorLedger)?.path).toBe("content")
  })

  it("names the position of a capture found inside an array", () => {
    const found = TruncatedOutput.reuse({ edits: [{ text: "short" }, { text: stdout }] }, ledger)

    expect(found?.path).toBe("edits[1].text")
  })

  it("names a bare string input as the input itself", () => {
    expect(TruncatedOutput.reuse(stdout, ledger)?.path).toBe("input")
  })

  it("passes an input with no string long enough to be a capture", () => {
    expect(TruncatedOutput.reuse({ path: "src/module.py", lines: [1, 2, null], deep: {} }, ledger))
      .toBeUndefined()
  })
})

describe("TruncatedOutput.refusal", () => {
  it("names the fragment, its origin, and the way to restore a file instead", () => {
    const stdout = long("def main():\n    return 0\n")
    const [capture] = TruncatedOutput.captures("bash", shellResult(stdout))
    const message = TruncatedOutput.refusal("write", { path: "content", capture: capture! })

    expect(message).toContain("Flow write was refused")
    expect(message).toContain("byte-identical")
    expect(message).toContain("bash cut stdout and dropped 24071 bytes")
    expect(message).toContain("git checkout or git restore")
    expect(message).toContain("never route file content through captured stdout")
  })
})

describe("TruncatedOutput.retain", () => {
  const capture = (index: number) =>
    new TruncatedOutput.Capture({ flow: "bash", field: "stdout", droppedBytes: index, digest: `d${index}` })

  it("keeps a ledger that is within its bound untouched", () => {
    const ledger = [capture(0), capture(1)]
    expect(TruncatedOutput.retain(ledger)).toBe(ledger)
  })

  it("keeps the most recent captures once the bound is passed", () => {
    const ledger = Array.from({ length: TruncatedOutput.retained + 3 }, (_, index) => capture(index))
    const retained = TruncatedOutput.retain(ledger)

    expect(retained).toHaveLength(TruncatedOutput.retained)
    expect(retained[0]?.droppedBytes).toBe(3)
    expect(retained[TruncatedOutput.retained - 1]?.droppedBytes).toBe(TruncatedOutput.retained + 2)
  })

  /**
   * The run this guard exists for repeated one restore frame after frame. If
   * each repetition took a slot, seventeen identical `git show` calls would
   * evict every other fragment and the write those bytes came from would be
   * accepted on the next frame.
   */
  it("counts one repeated capture once, and keeps its newest record", () => {
    const first = capture(1)
    const again = new TruncatedOutput.Capture({ flow: "bash", field: "stdout", droppedBytes: 99, digest: "d1" })
    const other = capture(2)
    const retained = TruncatedOutput.retain([first, other, again])

    expect(retained.map((entry) => entry.digest)).toEqual(["d2", "d1"])
    expect(retained[1]?.droppedBytes).toBe(99)
  })

  it("does not let a repeated capture push a distinct one out of the bound", () => {
    const distinct = Array.from({ length: TruncatedOutput.retained }, (_, index) => capture(index))
    const repeated = Array.from({ length: TruncatedOutput.retained }, () => capture(0))
    const retained = TruncatedOutput.retain([...distinct, ...repeated])

    expect(retained).toHaveLength(TruncatedOutput.retained)
    // The oldest fragment survives, because the loop that re-read it adds no
    // new payload — every entry the run was handed is still recognised.
    expect(new Set(retained.map((entry) => entry.digest)))
      .toEqual(new Set(distinct.map((entry) => entry.digest)))
  })

  it("bounds a ledger that is still over the bound after the repeats collapse", () => {
    const distinct = Array.from({ length: TruncatedOutput.retained + 2 }, (_, index) => capture(index))
    const retained = TruncatedOutput.retain([...distinct, capture(0)])

    expect(retained).toHaveLength(TruncatedOutput.retained)
    expect(retained.map((entry) => entry.digest)).not.toContain("d1")
    // `d0` was re-handed last, so it is the newest entry and survives the bound.
    expect(retained[TruncatedOutput.retained - 1]?.digest).toBe("d0")
  })
})

describe("TruncatedOutput.Ledger", () => {
  it("decodes a record written before the ledger existed as an empty one", () => {
    const Carrier = Schema.Struct({ truncatedOutputs: TruncatedOutput.Ledger })

    expect(Schema.decodeUnknownSync(Carrier)({}).truncatedOutputs).toEqual([])
  })

  it("round-trips recorded captures", () => {
    const encoded = { truncatedOutputs: [{ flow: "bash", field: "stdout", droppedBytes: 12, digest: "abc" }] }
    const Carrier = Schema.Struct({ truncatedOutputs: TruncatedOutput.Ledger })

    expect(Schema.encodeUnknownSync(Carrier)(Schema.decodeUnknownSync(Carrier)(encoded))).toEqual(encoded)
  })
})
