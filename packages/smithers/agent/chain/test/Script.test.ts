import * as Digest from "@smthrs/core/Digest"
import { describe, expect, it } from "vitest"
import * as Script from "../src/Script.ts"
import { flow } from "./harness.ts"

describe("Script", () => {
  it("digests the script text", () => {
    const script = Script.make("return done(null)")
    expect(script.text).toBe("return done(null)")
    expect(script.digest).toBe(Digest.digest("return done(null)"))
  })

  it("re-keys on any text change", () => {
    expect(Script.make("a").digest).not.toBe(Script.make("b").digest)
  })

  it("extracts the body of exactly one flow block", () => {
    const raw = ["Some prose.", flow("return done(1)"), "Trailing prose."].join("\n")
    const extraction = Script.extract(raw)
    expect(extraction._tag).toBe("Extracted")
    if (extraction._tag === "Extracted") {
      expect(extraction.script.text).toBe("return done(1)")
      expect(extraction.script.digest).toBe(Digest.digest("return done(1)"))
    }
  })

  it("rejects a flow block holding an unpaired surrogate instead of digesting it", () => {
    expect(Script.extract(flow(`return done("\uD83D")`))).toEqual({
      _tag: "Rejected",
      reason: "the ```flow block holds an unpaired UTF-16 surrogate, which is not text"
    })
  })

  it("rejects output with no flow block", () => {
    const extraction = Script.extract("just prose")
    expect(extraction).toEqual({ _tag: "Rejected", reason: "the author output contains no ```flow block" })
  })

  it("rejects a differently tagged fence", () => {
    const extraction = Script.extract("```js\nreturn done(1)\n```")
    expect(extraction._tag).toBe("Rejected")
  })

  it("rejects output with more than one flow block", () => {
    const raw = [flow("return done(1)"), flow("return done(2)")].join("\n")
    const extraction = Script.extract(raw)
    expect(extraction._tag).toBe("Rejected")
    if (extraction._tag === "Rejected") {
      expect(extraction.reason).toContain("2")
    }
  })

  it("does not close the block on a fence line that carries text", () => {
    const body = ["const opener = `", "```ts`", "return done(opener)"].join("\n")
    expect(Script.extract(flow(body))).toEqual({ _tag: "Extracted", script: Script.make(body) })
  })

  it("lets a longer opening fence hold a bare inner fence line", () => {
    const body = ["const md = `", "```", "x()", "```", "`", "return done(md)"].join("\n")
    expect(Script.extract(["````flow", body, "````"].join("\n"))).toEqual({
      _tag: "Extracted",
      script: Script.make(body)
    })
  })

  it("accepts a closing fence with trailing spaces at the end of the reply", () => {
    expect(Script.extract("```flow\nreturn done(1)\n```  ")).toEqual({
      _tag: "Extracted",
      script: Script.make("return done(1)")
    })
  })

  it("does not close the block on a shorter fence", () => {
    expect(Script.extract("````flow\nreturn done(1)\n```")._tag).toBe("Rejected")
  })

  it("extracts a block from CRLF author output with LF line endings", () => {
    const raw = "Prose.\r\n```flow\r\nconst a = 1\r\nreturn done(a)\r\n```\r\nMore prose.\r\n"
    expect(Script.extract(raw)).toEqual({
      _tag: "Extracted",
      script: Script.make("const a = 1\nreturn done(a)")
    })
  })

  it("keeps a lone carriage return inside the script body", () => {
    expect(Script.extract("```flow\nreturn done(\"a\\rb\")\n```")).toEqual({
      _tag: "Extracted",
      script: Script.make("return done(\"a\\rb\")")
    })
  })
})
