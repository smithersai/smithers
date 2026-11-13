import { parse } from "@babel/parser"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellValidation from "../src/CellValidation.ts"

describe("cell compiler failure boundary", () => {
  it.each([null, "compiler unavailable", 0])("turns an unexpected compiler throw into a refusal (%s)", (cause) => {
    const result = CellValidation.validate(Cell.source("const x = 1"), () => {
      throw cause
    })
    expect(result.compiled).toBeUndefined()
    expect(result.rejected?.code).toBe("compile_failed")
    expect(result.rejected?.message).toBe(`The cell did not compile — ${String(cause)}`)
  })

  it("retains an out-of-source diagnostic without inventing a source line", () => {
    const result = CellValidation.validate(Cell.source("const x = 1"), () => {
      throw Object.assign(new Error("invalid emitted code"), { loc: { line: 10, column: 2 } })
    })
    expect(result.compiled).toBeUndefined()
    expect(result.rejected?.code).toBe("compile_failed")
    expect(result.rejected?.message).toBe("The cell did not compile — line 10, column 3: invalid emitted code")
  })

  it.each(["javascript", "typescript"] as const)("passes %s source and options to the supplied parser", (language) => {
    const text = language === "typescript" ? "const x: number = 1" : "const x = 1"
    const inputs: Array<Parameters<typeof parse>> = []
    const result = CellValidation.validate(Cell.source(text, language), (...args) => {
      inputs.push(args)
      return parse(...args)
    })
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toEqual([
      text,
      expect.objectContaining({
        sourceType: "script",
        plugins: language === "typescript" ? ["typescript"] : []
      })
    ])
    expect(result.rejected).toBeUndefined()
    expect(result.compiled).toBe(language === "typescript" ? "\"use strict\";\nvar x = 1" : "var x = 1")
  })

  it("uses the real parser independently after an injected failure", () => {
    const cell = Cell.source("const x = 1")
    const refused = CellValidation.validate(cell, () => {
      throw new Error("compiler unavailable")
    })
    expect(refused.rejected?.code).toBe("compile_failed")
    expect(CellValidation.validate(cell)).toEqual({ rejected: undefined, compiled: "var x = 1" })
  })
})
