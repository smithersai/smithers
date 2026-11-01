/**
 * `DoneText.project` reads the answer out of a reply that is still streaming.
 *
 * The examples pin each rule the projection states. The properties run over
 * seeded random literals, with JavaScript itself as the oracle: a closed
 * literal projects to exactly what strict-mode evaluation of it yields, and
 * every cut of the reply projects to nothing or to a prefix of that value,
 * growing as the reply grows.
 */
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as DoneText from "../src/DoneText.vibe"

const cell = (source: string): string => "```cell\n" + source + "\n```"

/** The projection of a reply, `undefined` for none. */
const project = (reply: string): string | undefined => Option.getOrUndefined(DoneText.project(reply))

/** The value strict-mode JavaScript gives one literal's source text. */
const evaluate = (literal: string): string => new Function(`"use strict"; return (${literal})`)() as string

/** A seeded generator, so a failing case reproduces from its seed. */
const random = (seed: number) => {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (bound: number): number => Math.floor(next() * bound)
  const pick = <A>(items: ReadonlyArray<A>): A => items[int(items.length)]!
  return { int, pick }
}

type Random = ReturnType<typeof random>

const hex = (value: number, width: number): string => value.toString(16).padStart(width, "0")

const plain = [..."abcXYZ019 .,:;!?#%&*+-=<>|~^@/()[]{}é中😀\u2028\u2029", "ctx.done(", "\t"]

/** One fragment of a literal's source, valid inside `quote`. */
const fragment = (rng: Random, quote: string): string => {
  const template = quote === "`"
  switch (rng.int(14)) {
    case 0:
      return rng.pick(["\\n", "\\t", "\\r", "\\b", "\\f", "\\v"])
    case 1:
      // `\0` is NUL only when no digit follows, so a letter always does.
      return "\\0" + rng.pick(["a", "z", " "])
    case 2:
      return "\\x" + hex(rng.int(256), 2)
    case 3:
      // Lone surrogates included: a string is code units.
      return "\\u" + hex(rng.int(0x10000), 4)
    case 4:
      return "\\u{" + "0".repeat(rng.int(3)) + hex(rng.int(0x110000), 1) + "}"
    case 5:
      return "\\" + rng.pick(["\"", "'", "`", "\\", "$", "q", "z", "{", "}", "é", "😀"])
    case 6:
      return "\\" + rng.pick(["\n", "\r\n", "\r", "\u2028", "\u2029"])
    case 7:
      return template ? rng.pick(["\n", "\r\n", "\r", "$a", "$}", "$\\{"]) : "$"
    case 8:
      return rng.pick(["\"", "'", "`"].filter((other) => other !== quote))
    default:
      return rng.pick(plain)
  }
}

const literal = (rng: Random): string => {
  const quote = rng.pick(["\"", "'", "`"])
  const parts = Array.from({ length: rng.int(12) }, () => fragment(rng, quote))
  return quote + parts.join("") + quote
}

/** Code before the final call: none of it is a `ctx.done(` call. */
const decoys = [
  "console.log(\"ctx.done(\\\"decoy\\\")\")",
  "// ctx.done(\"decoy\")",
  "/* ctx.done(\"decoy\") */",
  "const re = /ctx.done\\(\"decoy\"/g",
  "const t = `ctx.done(\"decoy\") ${ { a: \"}\" }.a } ${`${ \"ctx.done(\" }`}`",
  "await ctx.call(\"app/theme/set\", { mode: \"dark\" })",
  "const half = total / 2 / count",
  "my.ctx.done(\"decoy\")",
  "ctx.doneish(\"decoy\")"
]

interface Case {
  readonly reply: string
  /** Where the final call's literal opens, its quote included. */
  readonly opens: number
  readonly value: string
  /** An earlier call's value, which a cut before the final call may show. */
  readonly earlier?: string
}

const replyCase = (rng: Random): Case => {
  const lines = Array.from({ length: rng.int(4) }, () => rng.pick(decoys))
  const earlier = rng.int(3) === 0 ? "earlier \\u{1F600}" : undefined
  if (earlier !== undefined) lines.push(`if (seen) ctx.done("${earlier}")`)
  const source = literal(rng)
  const head = (rng.int(2) === 0 ? "Sure.\n" : "") +
    (rng.int(2) === 0 ? cell("const seen = false") + "\n" : "") +
    "```cell\n" + lines.map((line) => line + "\n").join("") + "ctx.done("
  return {
    reply: head + source + ")\n```",
    opens: head.length,
    value: evaluate(source),
    ...(earlier === undefined ? {} : { earlier: evaluate(`"${earlier}"`) })
  }
}

const seeds = Array.from({ length: 400 }, (_, index) => index + 1)

describe("DoneText.project", () => {
  it("projects the literal of a streaming ctx.done", () => {
    expect(project(
      "Switching now.\n```cell\nawait ctx.call(\"app/theme/set\", { mode: \"dark\" })\nctx.done(\"Switched to dar"
    )).toBe("Switched to dar")
    expect(project(cell("ctx.done(\"Dark mode is on.\")"))).toBe("Dark mode is on.")
    expect(project(cell("ctx.done('single')"))).toBe("single")
    expect(project(cell("ctx.done(`template`)"))).toBe("template")
    expect(project(cell("ctx . done ( \n \"spaced\" )"))).toBe("spaced")
  })

  it("reads only cell blocks, joined, and the last ctx.done in them", () => {
    expect(project("ctx.done(\"prose\")")).toBeUndefined()
    expect(project("```python\nctx.done(\"python\")\n```")).toBeUndefined()
    expect(project(cell("ctx.done(\"first\")") + "\n```ts\nctx.done(\"second\" as string)\n```")).toBe("second")
    expect(project(cell("if (ok) ctx.done(\"yes\")\nelse ctx.done(\"no\")"))).toBe("no")
    expect(project("```cell\n```")).toBeUndefined()
  })

  it("answers none before the literal opens and for an argument that is not a literal", () => {
    expect(project("```cell\nctx.done(")).toBeUndefined()
    expect(project("```cell\nctx.done(  \n")).toBeUndefined()
    expect(project(cell("ctx.done(answer)"))).toBeUndefined()
    expect(project(cell("ctx.done(String.raw`x`)"))).toBeUndefined()
    expect(project(cell("ctx.done(/* why */ \"x\")"))).toBeUndefined()
    expect(project("```cell\nctx.done(\"")).toBe("")
  })

  it("skips a ctx.done( in a string, comment, regular expression or template text", () => {
    for (const decoy of decoys) expect(project(cell(decoy))).toBeUndefined()
    expect(project(cell("/* ctx.done(\"open comment\")"))).toBeUndefined()
    expect(project(cell("// ctx.done(\"last line\")"))).toBeUndefined()
    expect(project(cell("// note\nctx.done(\"after a comment\")"))).toBe("after a comment")
    expect(project(cell("const t = `${ {} } \\` ctx.done(\"no\")`"))).toBeUndefined()
    expect(project(cell("const s = 'it\\'s ctx.done(\"no\")'"))).toBeUndefined()
  })

  it("tells a regular expression from division", () => {
    const after = (code: string) => project(cell(`${code}\nctx.done("ok")`))
    expect(after("const f = (s) => { return /\"/.test(s) }")).toBe("ok")
    expect(after("const r = /[/\"]/")).toBe("ok")
    expect(after("const r = /\\/\"/")).toBe("ok")
    expect(after("const r = /\"/gi.test(s)")).toBe("ok")
    expect(after("const q = (a) / 2 / (b)")).toBe("ok")
    expect(after("const q = list[0] / 2 / list[1]")).toBe("ok")
    expect(after("const q = 0x1f / 2 / 1_000")).toBe("ok")
    expect(after("const q = { a: 1 }\n/\"/.test(s)")).toBe("ok")
    // A regular expression or a string left open ends at its line.
    expect(after("const r = /\"")).toBe("ok")
    expect(after("const s = \"open")).toBe("ok")
    expect(after("const s = 'open\r")).toBe("ok")
    expect(after("const r = /\"\\")).toBe("ok")
    expect(project(cell("const r = /\"ctx.done(\"no\")"))).toBeUndefined()
    expect(project("```cell\nconst r = /\"")).toBeUndefined()
    expect(project("```cell\nconst r = /a\\")).toBeUndefined()
    expect(project("```cell\nconst s = \"ctx.done(")).toBeUndefined()
  })

  it.each([
    "if (ready)",
    "if (check(nested(value)))",
    "while (ready)",
    "for (; ready;)",
    "for (const value of values)",
    "for await (const value of values)",
    "if /* condition */ (ready)",
    "with (scope)"
  ])("skips regex answer decoys after the control header %s", (header) => {
    // This is a valid regex: its parentheses are a capturing group, not a call.
    const source = `${header} /ctx.done("decoy")/.test(value)`
    expect(project(cell(source))).toBeUndefined()
    expect(project(cell(`ctx.done("earlier"); ${source}`))).toBe("earlier")
    expect(project(cell(`${source}; ctx.done("real")`))).toBe("real")
    // A streaming regex must not leak its apparent answer before its slash arrives.
    expect(project("```cell\n" + header + " /ctx.done(\"decoy\")")).toBeUndefined()
  })

  it("keeps division after a method named like a control keyword", () => {
    expect(project(cell("obj.if(value) / ctx.done(\"answer\") / count"))).toBe("answer")
    expect(project(cell("if (ctx.done(\"answer\")) /ctx.done(\"decoy\")/.test(value)"))).toBe("answer")
  })

  it.each(["obj. if", "obj . /* method */ if", "obj.\nif"])(
    "keeps division after the spaced property %s",
    (method) => {
      expect(project(cell(`${method}(value) / ctx.done("answer") / count`))).toBe("answer")
    }
  )

  it("continues a string across a CR LF line continuation", () => {
    expect(project(cell("const s = \"a\\\r\nctx.done(\\\"no\\\")\"\nctx.done(\"yes\")"))).toBe("yes")
    expect(project(cell("const s = \"a\\\r\nctx.done(\\\"no\\\")\""))).toBeUndefined()
  })

  it("decodes every escape a strict-mode literal allows", () => {
    expect(project(cell("ctx.done(\"\\b\\f\\n\\r\\t\\v\")"))).toBe("\b\f\n\r\t\v")
    expect(project(cell("ctx.done(\"\\x41\\u0042\\u{43}\\u{1F600}\\u{0000044}\")"))).toBe("ABC😀D")
    expect(project(cell("ctx.done(\"\\\"\\'\\`\\\\\\$\\q\")"))).toBe("\"'`\\$q")
    expect(project(cell("ctx.done(\"a\\0b\")"))).toBe("a\0b")
    expect(project(cell("ctx.done(\"a\\\nb\\\r\nc\\\rd\\\u2028e\\\u2029f\")"))).toBe("abcdef")
    expect(project(cell("ctx.done(\"line\u2028separator\")"))).toBe("line\u2028separator")
  })

  it("stops at an escape strict code refuses", () => {
    expect(project(cell("ctx.done(\"a\\01\")"))).toBe("a")
    expect(project(cell("ctx.done(\"a\\1\")"))).toBe("a")
    expect(project(cell("ctx.done(\"a\\8\")"))).toBe("a")
    expect(project(cell("ctx.done(\"a\\x4g\")"))).toBe("a")
    expect(project(cell("ctx.done(\"a\\u00g0\")"))).toBe("a")
    expect(project(cell("ctx.done(\"a\\u{}\")"))).toBe("a")
    expect(project(cell("ctx.done(\"a\\u{110000}\")"))).toBe("a")
    expect(project(cell("ctx.done(\"a\\u{12g}\")"))).toBe("a")
    expect(project(cell("ctx.done(\"line\nbreak\")"))).toBe("line")
    expect(project(cell("ctx.done('line\rbreak')"))).toBe("line")
  })

  it("stops at an escape the input cut short", () => {
    for (const tail of ["\\", "\\0", "\\x", "\\x4", "\\u", "\\u00", "\\u{", "\\u{1F6"]) {
      expect(project("```cell\nctx.done(\"ab" + tail)).toBe("ab")
    }
    expect(project("```cell\nctx.done(\"ab\\\r")).toBe("ab")
  })

  it("reads a template's text up to its first interpolation", () => {
    expect(project(cell("ctx.done(`Hi ${name}, welcome`)"))).toBe("Hi ")
    expect(project(cell("ctx.done(`cost: $5 and $}`)"))).toBe("cost: $5 and $}")
    expect(project("```cell\nctx.done(`cost $")).toBe("cost ")
    expect(project(cell("ctx.done(`a\r\nb\rc\nd`)"))).toBe("a\nb\nc\nd")
    expect(project("```cell\nctx.done(`a\r")).toBe("a\n")
    expect(project(cell("ctx.done(`\\${not} \\` done`)"))).toBe("${not} ` done")
  })

  it("drops a high surrogate whose pair has not arrived, and keeps a closed one", () => {
    expect(project("```cell\nctx.done(\"smile \\uD83D")).toBe("smile ")
    expect(project("```cell\nctx.done(\"smile \\uD83D\\uDE00")).toBe("smile 😀")
    expect(project(cell("ctx.done(\"lone \\uD83D\")"))).toBe("lone \uD83D")
    expect(project("```cell\nctx.done(\"smile \uD83D")).toBe("smile ")
    // The high-surrogate range is exactly D800 to DBFF.
    expect(project("```cell\nctx.done(\"x\\uD800")).toBe("x")
    expect(project("```cell\nctx.done(\"x\\uDBFF")).toBe("x")
    expect(project("```cell\nctx.done(\"x\\uD7FF")).toBe("x\uD7FF")
    expect(project("```cell\nctx.done(\"x\\uDC00")).toBe("x\uDC00")
  })

  it("projects a closed literal to exactly the value strict JavaScript gives it", () => {
    for (const seed of seeds) {
      const sample = replyCase(random(seed))
      expect(project(sample.reply), `seed ${seed}`).toBe(sample.value)
    }
  })

  it("round-trips any string through JSON.stringify", () => {
    for (const seed of seeds) {
      const rng = random(seed)
      const value = String.fromCharCode(...Array.from({ length: rng.int(24) }, () => rng.int(0x10000)))
      expect(project(cell(`ctx.done(${JSON.stringify(value)})`)), `seed ${seed}`).toBe(value)
    }
  })

  it("projects every cut of a reply to nothing or a prefix of the value, growing with the reply", () => {
    for (const seed of seeds) {
      const sample = replyCase(random(seed))
      let previous: string | undefined
      for (let cutAt = 0; cutAt <= sample.reply.length; cutAt++) {
        const projected = project(sample.reply.slice(0, cutAt))
        const where = `seed ${seed}, cut ${cutAt}`
        if (cutAt <= sample.opens) {
          // Before the final literal opens: nothing, or the earlier call's text.
          if (projected !== undefined) {
            expect(sample.earlier?.startsWith(projected), where).toBe(true)
          }
          continue
        }
        expect(projected, where).toBeDefined()
        expect(sample.value.startsWith(projected!), where).toBe(true)
        if (previous !== undefined) expect(projected!.startsWith(previous), where).toBe(true)
        previous = projected
      }
      expect(previous, `seed ${seed}`).toBe(sample.value)
    }
  })
})
