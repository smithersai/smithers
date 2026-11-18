import { describe, expect, it } from "vitest"
import { cannotRecord, readsListener } from "../../src/replay/Reads.ts"

const line =
  "smthrs: reads are not observed on this host: strace is not installed; a target that asks for it is keyed by its declared inputs\n"
const sentence =
  "this machine cannot record what a step reads (strace is not installed). A step that names no inputs runs on every commit. On Linux, install strace."

describe("readsListener", () => {
  it("gives the sentence for the line, once", () => {
    const hear = readsListener()
    expect(hear(`//:a  ran\n${line}`)).toBe(sentence)
    expect(hear(line)).toBeUndefined()
  })

  it("finds a line that arrives in two chunks", () => {
    const hear = readsListener()
    expect(hear(line.slice(0, 30))).toBeUndefined()
    expect(hear(line.slice(30))).toBe(sentence)
  })

  it("finds the line behind the frame of the display", () => {
    expect(readsListener()(`│  ${line}`)).toBe(sentence)
  })

  it("keeps a reason with no text after it", () => {
    expect(readsListener()("smthrs: reads are not observed on this host: no tracer\r\n")).toBe(
      cannotRecord("no tracer")
    )
  })

  it("ignores a step that prints the words inside its own line", () => {
    const hear = readsListener()
    expect(hear(`//:a: ${line}`)).toBeUndefined()
    expect(hear("nothing to see\n")).toBeUndefined()
  })
})
