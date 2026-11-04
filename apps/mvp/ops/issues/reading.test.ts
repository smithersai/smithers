// The readings the repository scrub reads (reading.mjs) and the Unicode data they fold (reading-data.mjs).
import { describe, expect, test } from "vitest"
import { COLON_CHARS, ENTITIES, SLASH_CHARS } from "./reading-data.mjs"
import { normalizedText, readingsOf } from "./reading.mjs"

describe("the folded code points", () => {
  test("every code point NFKC folds to a slash or a colon is in the generated sets (a complete enumeration)", () => {
    const missing: string[] = []
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const c = String.fromCodePoint(cp)
      const folded = c.normalize("NFKC")
      if (/[/\\]/.test(folded) && !SLASH_CHARS.includes(c)) missing.push(`U+${cp.toString(16)}`)
      if (folded.includes(":") && !folded.includes(";") && !COLON_CHARS.includes(c) && !SLASH_CHARS.includes(c)) missing.push(`U+${cp.toString(16)}`)
    }
    expect(missing).toEqual([])
  })
  test("every slash-like and colon-like code point reads as `/` and `:` between two names", () => {
    for (const c of SLASH_CHARS) {
      // A compatibility character spells more than the slash (`℀` is `a/c`): it still separates.
      const expected = /[/\\]/.test(c.normalize("NFKC")) ? `owner${c.normalize("NFKC").replace(/[/\\]+/g, "/")}name` : "owner/name"
      expect([c, normalizedText(`owner${c}name`)]).toEqual([c, expected])
    }
    for (const c of COLON_CHARS) {
      const expected = c.normalize("NFKC").includes(":") ? `owner${c.normalize("NFKC")}name` : "owner:name"
      expect([c, normalizedText(`owner${c}name`)]).toEqual([c, expected])
    }
  })
  test("the sets hold the review's look-alikes", () => {
    for (const c of "⁄∕⧸╱⟋〳∖⼃／﹨") expect(SLASH_CHARS).toContain(c)
    for (const c of "：∶꞉﹕") expect(COLON_CHARS).toContain(c)
  })
})

describe("readings keep source offsets", () => {
  test("a span in a normalized reading maps back over everything that produced it", () => {
    const text = "see smithersai&sol;./x/../secret-vault now"
    const reading = readingsOf(text).find((r) => r.text.includes("smithersai/secret-vault"))!
    const at = reading.text.indexOf("smithersai/secret-vault")
    const end = at + "smithersai/secret-vault".length
    expect(text.slice(reading.from[at], reading.to[end - 1])).toBe("smithersai&sol;./x/../secret-vault")
  })
  test("whitespace and controls around a slash between two names, slash runs and dot steps fold", () => {
    for (const text of ["a/\tb", "a / b", "a\n/b", "a//b", "a/./b", "a/x/../b", "a&#47;&#x2F;b", "a%2F%2Fb", "a\\b", "a&bsol;b"]) {
      expect([text, normalizedText(text)]).toEqual([text, "a/b"])
    }
  })
  test("the full HTML5 table decodes; an unknown named reference stays literal", () => {
    expect(Object.keys(ENTITIES).length).toBeGreaterThan(2000)
    expect(normalizedText("a&colon;b &frasl; &Aopf;")).toBe("a:b/A")
    expect(normalizedText("AT&T; ptr = &val;")).toBe("AT&T; ptr = &val;")
  })
  test("combining marks, emphasis markers and tags inside a name are read without", () => {
    const texts = (text: string) => readingsOf(text).map((reading) => reading.text)
    expect(texts("smithersa\u0301i/secretrepo")).toContain("smithersai/secretrepo")
    expect(texts("smithersai/**secretrepo**")).toContain("smithersai/secretrepo")
    expect(texts("smithersai/<b>secretrepo</b>")).toContain("smithersai/secretrepo")
    expect(texts("secret-**vault** and secret-<b>vault</b>")).toContain("secret-vault and secret-vault")
    // A slash overlay is a separator, not a mark to drop.
    expect(texts("owner\u0338name")).toContain("owner/name")
  })
})
