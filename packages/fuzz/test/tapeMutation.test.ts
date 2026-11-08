// Vitest's TypeScript contribution-copy project loads *.test.ts without a VibeLang transformer.
import { describe, expect, it } from "vitest"
import { spliceTail } from "../src/internal/fuzz/tape.ts"

describe("crossing corpus tapes", () => {
  it("retains a tail longer than the JavaScript argument limit", () => {
    // The long campaign grew an AgentEvent tape beyond the native call's argument limit.
    // This exact value is compactly retained as a deterministic uint32 sequence.
    const tail = Array.from({ length: 200_000 }, (_, at) => Math.imul(at, 0x9e3779b9) >>> 0)
    const tape = [11, 22, 33]
    spliceTail(tape, 1, tail)
    expect(tape).toEqual([11, ...tail])
  })
  it("deletes the old tail when the other corpus tape is exhausted", () => {
    const tape = [11, 22, 33]
    spliceTail(tape, 1, [])
    expect(tape).toEqual([11])
  })
})
