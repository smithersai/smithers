import { describe, expect, it } from "vitest"
import { blocks, inline } from "../src/web/markdown.vibe"

describe("reply Markdown", () => {
  it("accepts an info string and keeps prose after its closing fence", () => {
    expect(blocks("Before\n\n```vibe title\nconst x = 1\n```\n\nAfter")).toEqual([
      { kind: "prose", text: "Before" }, { kind: "code", language: "vibe", text: "const x = 1" }, { kind: "prose", text: "After" },
    ])
  })
  it("keeps an unclosed streamed fence and a bare fence", () => {
    expect(blocks("```vibe\nline\nnext")).toEqual([{ kind: "code", language: "vibe", text: "line\nnext" }])
    expect(blocks("```\nline\n```")).toEqual([{ kind: "code", language: "", text: "line" }])
    expect(blocks("\n\none\n\ntwo\n")).toEqual([{ kind: "prose", text: "one" }, { kind: "prose", text: "two" }])
    expect(blocks("")).toEqual([])
  })
  it("keeps inline code, including an odd backtick while streaming", () => {
    expect(inline("Use `try` here")).toEqual([{ code: false, text: "Use " }, { code: true, text: "try" }, { code: false, text: " here" }])
    expect(inline("Use `try")).toEqual([{ code: false, text: "Use " }, { code: true, text: "try" }])
    expect(inline("``")).toEqual([])
  })
})
