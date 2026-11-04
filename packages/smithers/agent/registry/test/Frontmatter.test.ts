import { describe, expect, it, vi } from "vitest"
import * as Frontmatter from "../src/internal/Frontmatter.vibe"

describe("Frontmatter", () => {
  it("splits leading frontmatter from its body", () => {
    expect(Frontmatter.split("---\nname: review\n---\n# Review")).toEqual({
      frontmatter: "name: review\n",
      body: "# Review"
    })
  })

  it("keeps files without frontmatter unchanged", () => {
    expect(Frontmatter.split("# Review\n")).toEqual({ frontmatter: undefined, body: "# Review\n" })
  })

  it("accepts CRLF frontmatter and a UTF-8 BOM", () => {
    expect(Frontmatter.split("\uFEFF---\r\nname: review\r\n---\r\n# Review")).toEqual({
      frontmatter: "name: review\r\n",
      body: "# Review"
    })
  })

  it("supports empty frontmatter blocks", () => {
    expect(Frontmatter.split("---\n---\nbody")).toEqual({ frontmatter: "", body: "body" })
  })

  it("keeps an unterminated frontmatter document as body text", () => {
    expect(Frontmatter.split("---\nname: review\nbody without a closing fence")).toEqual({
      frontmatter: undefined,
      body: "---\nname: review\nbody without a closing fence"
    })
    expect(Frontmatter.split("---")).toEqual({ frontmatter: undefined, body: "---" })
  })

  it("detects when a streamed metadata prefix is complete", () => {
    expect(Frontmatter.isMetadataComplete("---\ndescription: Review")).toBe(false)
    expect(Frontmatter.isMetadataComplete("---\ndescription: Review\n---\npartial body")).toBe(true)
    expect(Frontmatter.isMetadataComplete("# No frontmatter")).toBe(true)
  })

  it("treats a prefix shorter than an opening fence as incomplete", () => {
    expect(Frontmatter.isMetadataComplete("")).toBe(false)
    expect(Frontmatter.isMetadataComplete("--")).toBe(false)
    expect(Frontmatter.isMetadataComplete("\uFEFF--")).toBe(false)
    expect(Frontmatter.isMetadataComplete("---")).toBe(false)
  })

  it("completes a leading rule that is not an opening fence once its line ends", () => {
    expect(Frontmatter.isMetadataComplete("----------")).toBe(false)
    expect(Frontmatter.isMetadataComplete("----------\nbody")).toBe(true)
  })

  it("reads no fields from a document without frontmatter", () => {
    expect(Frontmatter.parse({ path: "/skills/review/SKILL.md", text: "# Review\n" })).toEqual({
      fields: {},
      warnings: []
    })
    expect(Frontmatter.parse({ path: "/skills/review/SKILL.md", text: "---\n---\nbody" })).toEqual({
      fields: {},
      warnings: []
    })
    expect(Frontmatter.parse({ path: "/skills/review/SKILL.md", text: "---\n   \n---\nbody" })).toEqual({
      fields: {},
      warnings: []
    })
  })

  it("retains finite numeric members of a decoded binary scalar", () => {
    expect(Frontmatter.parse({
      path: "/skills/review/SKILL.md",
      text: "---\ndata: !!binary aGk=\n---\nbody"
    })).toEqual({
      fields: { data: { 0: 104, 1: 105 } },
      warnings: []
    })
  })

  it("replaces a non-serializable scalar with null and warns once", () => {
    const result = Frontmatter.parse({
      path: "/skills/review/SKILL.md",
      text: "---\ndescription: Review\nmerged: !!merge x\n---\nbody"
    })

    expect(result.fields).toEqual({ description: "Review", merged: null })
    expect(result.warnings).toEqual([expect.objectContaining({ code: "non_serializable_frontmatter" })])
  })

  it("parses YAML fields without validating unknown keys", () => {
    expect(Frontmatter.parse({
      path: "/skills/review/SKILL.md",
      text: "---\ndescription: 'Review: a pull request'\nallowed-tools: [a, b]\nblock:\n  - one\n  - two\n---\nbody"
    })).toEqual({
      fields: {
        description: "Review: a pull request",
        "allowed-tools": ["a", "b"],
        block: ["one", "two"]
      },
      warnings: []
    })
  })

  it("uses failsafe scalar semantics compatible with skills-ref", () => {
    expect(Frontmatter.parse({
      path: "/skills/review/SKILL.md",
      text: "---\nlicense: 2.0\nmetadata:\n  version: 1.0\n  enabled: true\n---\nbody"
    })).toEqual({
      fields: {
        license: "2.0",
        metadata: {
          version: "1.0",
          enabled: "true"
        }
      },
      warnings: []
    })
  })

  it("sanitizes cyclic YAML aliases into serializable metadata", () => {
    const result = Frontmatter.parse({
      path: "/skills/review/SKILL.md",
      text: [
        "---",
        "description: Review",
        "metadata: &metadata",
        "  author: Example",
        "  self: *metadata",
        "---",
        "body"
      ].join("\n")
    })

    expect(result.fields).toEqual({
      description: "Review",
      metadata: {
        author: "Example",
        self: null
      }
    })
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "non_serializable_frontmatter"
    }))
    expect(() => JSON.stringify(result.fields)).not.toThrow()
  })

  it("retains reserved mapping keys without creating inherited metadata and freezes the graph", () => {
    const objectPrototypeHadName = Object.hasOwn(Object.prototype, "name")
    const result = Frontmatter.parse({
      path: "/skills/review/SKILL.md",
      text: [
        "---",
        "__proto__:",
        "  name: inherited",
        "constructor:",
        "  prototype:",
        "    poisoned: true",
        "prototype:",
        "  name: top-prototype",
        "nested:",
        "  __proto__:",
        "    name: nested-inherited",
        "  constructor: nested-constructor",
        "  prototype: nested-prototype",
        "items:",
        "  - __proto__:",
        "      name: item-inherited",
        "---",
        "body"
      ].join("\n")
    })
    const fields = result.fields as Record<string, unknown>
    const nested = fields.nested as Record<string, unknown>
    const items = fields.items as ReadonlyArray<Record<string, unknown>>

    expect(Object.getPrototypeOf(fields)).toBe(null)
    expect(Object.getPrototypeOf(nested)).toBe(null)
    expect(Object.getPrototypeOf(fields.__proto__)).toBe(null)
    expect(Object.getPrototypeOf(items[0])).toBe(null)
    expect(Object.hasOwn(fields, "__proto__")).toBe(true)
    expect(Object.hasOwn(fields, "constructor")).toBe(true)
    expect(Object.hasOwn(fields, "prototype")).toBe(true)
    expect(Object.hasOwn(nested, "__proto__")).toBe(true)
    expect(Object.hasOwn(nested, "constructor")).toBe(true)
    expect(Object.hasOwn(nested, "prototype")).toBe(true)
    expect(Object.hasOwn(fields, "name")).toBe(false)
    expect("name" in fields).toBe(false)
    for (const key in fields) expect(Object.hasOwn(fields, key)).toBe(true)
    for (const key in nested) expect(Object.hasOwn(nested, key)).toBe(true)
    expect(Object.isFrozen(fields)).toBe(true)
    expect(Object.isFrozen(fields.__proto__)).toBe(true)
    expect(Object.isFrozen(nested)).toBe(true)
    expect(Object.isFrozen(items)).toBe(true)
    expect(Object.isFrozen(items[0])).toBe(true)
    expect(({} as { readonly name?: unknown }).name).toBeUndefined()
    expect(Object.hasOwn(Object.prototype, "name")).toBe(objectPrototypeHadName)
  })

  it("returns one warning for malformed YAML", () => {
    const result = Frontmatter.parse({ path: "/skills/broken/SKILL.md", text: "---\nname: [\n---\nbody" })
    expect(result.fields).toEqual({})
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.code).toBe("frontmatter_parse_error")
  })

  it("reports malformed YAML without disclosing parser excerpts or raw causes", () => {
    const secret = "SUPERSECRET-TOKEN"
    const result = Frontmatter.parse({
      path: "/skills/broken/SKILL.md",
      text: `---\ndescription: "${secret}\n---\nbody`
    })

    expect(result.fields).toEqual({})
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({
      code: "frontmatter_parse_error",
      path: "/skills/broken/SKILL.md"
    })
    expect(Object.hasOwn(result.warnings[0]!, "cause")).toBe(false)
    expect(result.warnings[0]?.message).toMatch(/line \d+, column \d+/)
    expect(result.warnings[0]?.message).not.toContain(secret)
    expect(JSON.stringify(result.warnings[0])).not.toContain(secret)
  })

  it("converts YAML alias-expansion refusal into a bounded public warning", () => {
    const result = Frontmatter.parse({
      path: "/skills/broken/SKILL.md",
      text: [
        "---",
        "a: &a [x,x,x,x,x,x,x,x,x,x]",
        "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]",
        "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
        "d: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]",
        "---",
        "body"
      ].join("\n")
    })

    expect(result.fields).toEqual({})
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "frontmatter_parse_error",
        path: "/skills/broken/SKILL.md",
        message: "Could not parse frontmatter (YAML_PARSE_ERROR) at line 1, column 1"
      })
    ])
  })

  it("returns one warning for non-object YAML", () => {
    const result = Frontmatter.parse({ path: "/skills/broken/SKILL.md", text: "---\n- review\n---\nbody" })
    expect(result.fields).toEqual({})
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.code).toBe("frontmatter_parse_error")
  })
  it("never writes a YAML library warning to the process for a collection key", () => {
    // Discovery runs inside a terminal UI; a process warning there lands on
    // stderr in the middle of the rendered screen.
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined)
    try {
      const result = Frontmatter.parse({
        path: "/skills/review/SKILL.md",
        text: "---\n? [a, b]\n: c\nname: review\n---\nbody"
      })
      expect(result.fields.name).toBe("review")
      expect(emitWarning).not.toHaveBeenCalled()
    } finally {
      emitWarning.mockRestore()
    }
  })
})
