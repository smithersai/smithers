import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  BodyRefMarkdown,
  FlowDescriptor,
  Provenance,
  SchemaRefMarkdownArgs,
  SchemaRefMarkdownOutput
} from "../src/Descriptor.vibe"
import * as Disclosure from "../src/Disclosure.ts"

const descriptor = (
  name: string,
  description: string,
  modelInvocable = true
): FlowDescriptor =>
  new FlowDescriptor({
    name,
    description,
    modelInvocable,
    body: new BodyRefMarkdown({
      path: "/private/DO-NOT-DISCLOSE-body.md",
      baseDirectory: "/private/DO-NOT-DISCLOSE-base"
    }),
    input: new SchemaRefMarkdownArgs({}),
    output: new SchemaRefMarkdownOutput({}),
    model: Option.none(),
    flows: [],
    capabilities: ["DO-NOT-DISCLOSE-capability"],
    effects: {
      reads: [],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none(),
    path: "/private/DO-NOT-DISCLOSE-path.md",
    frontmatter: { secret: "DO-NOT-DISCLOSE-frontmatter" },
    provenance: new Provenance({
      source: "DO-NOT-DISCLOSE-provenance",
      root: "/private/DO-NOT-DISCLOSE-root"
    })
  })

const descriptionText = (xml: string): string => {
  const match = /<description>([\s\S]*?)<\/description>/.exec(xml)
  if (match === null) throw new Error("description element is missing")
  return match[1]!
}

const assertWellFormedXml = (xml: string): void => {
  for (const character of xml) {
    const codePoint = character.codePointAt(0)!
    const allowed = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    if (!allowed || (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) >= 0xfffe) {
      throw new Error(`forbidden XML character U+${codePoint.toString(16).toUpperCase()}`)
    }
  }

  const stack: Array<string> = []
  let cursor = 0
  for (const tag of xml.matchAll(/<\/?([a-z_]+)>/g)) {
    const raw = tag[0]
    const index = tag.index
    const text = xml.slice(cursor, index)
    if (text.includes("<") || /&(?!(?:amp|lt|gt|quot|apos);)/.test(text)) {
      throw new Error("unescaped XML character data")
    }
    const name = tag[1]!
    if (raw.startsWith("</")) {
      if (stack.pop() !== name) throw new Error(`mismatched closing tag ${name}`)
    } else {
      stack.push(name)
    }
    cursor = index + raw.length
  }
  if (cursor !== xml.length || stack.length !== 0) throw new Error("unclosed XML element")
}

describe("Disclosure", () => {
  it("renders model-invocable entries as a sorted agentskills XML block", () => {
    expect(
      Disclosure.toXml([
        descriptor("zebra", "Zebra flow"),
        descriptor("alpha", "Alpha flow")
      ])
    ).toBe([
      "<available_skills>",
      "  <skill>",
      "    <name>alpha</name>",
      "    <description>Alpha flow</description>",
      "  </skill>",
      "  <skill>",
      "    <name>zebra</name>",
      "    <description>Zebra flow</description>",
      "  </skill>",
      "</available_skills>"
    ].join("\n"))
  })

  it("escapes XML metacharacters in names and descriptions", () => {
    expect(Disclosure.toXml([descriptor("a<&>\"'", "b<&>\"'")])).toBe([
      "<available_skills>",
      "  <skill>",
      "    <name>a&lt;&amp;&gt;&quot;&apos;</name>",
      "    <description>b&lt;&amp;&gt;&quot;&apos;</description>",
      "  </skill>",
      "</available_skills>"
    ].join("\n"))
  })

  it.each([
    ["NUL", "a\0b", "a\uFFFDb"],
    ["tab", "a\tb", "a\tb"],
    ["line feed", "a\nb", "a\nb"],
    ["carriage return", "a\rb", "a\rb"],
    ["lone high surrogate", "a\uD800b", "a\uFFFDb"],
    ["lone low surrogate", "a\uDC00b", "a\uFFFDb"],
    ["replacement character", "a\uFFFDb", "a\uFFFDb"],
    ["combining sequence", "Cafe\u0301", "Cafe\u0301"],
    ["astral character", "a😀b", "a😀b"],
    ["BMP noncharacter", "a\uFDD0b", "a\uFFFDb"],
    ["astral noncharacter", `a${String.fromCodePoint(0x1fffe)}b`, "a\uFFFDb"]
  ])("applies the XML character policy to %s", (_label, input, expected) => {
    expect(descriptionText(Disclosure.toXml([descriptor("safe", input)]))).toBe(expected)
  })

  it("emits a strictly well-formed document after replacing forbidden characters", () => {
    const xml = Disclosure.toXml([
      descriptor("safe", `NUL:\0 emoji:😀 combining:e\u0301 noncharacter:${String.fromCodePoint(0x10ffff)}`)
    ])

    expect(() => assertWellFormedXml(xml)).not.toThrow()
  })

  it("keeps model-hidden entries in autocomplete while excluding them from XML", () => {
    const hidden = descriptor("hidden", "Only slash invocation", false)

    expect(Disclosure.toEntries([hidden])).toEqual([
      { name: "hidden", description: "Only slash invocation" }
    ])
    expect(Disclosure.toXml([hidden])).toBe("<available_skills>\n</available_skills>")
  })

  it("sorts entries by name while preserving equal-name order", () => {
    expect(
      Disclosure.toEntries([
        descriptor("zebra", "Zebra flow"),
        descriptor("alpha", "First alpha flow"),
        descriptor("alpha", "Alpha flow")
      ])
    ).toEqual([
      { name: "alpha", description: "First alpha flow" },
      { name: "alpha", description: "Alpha flow" },
      { name: "zebra", description: "Zebra flow" }
    ])
  })

  it("keeps entries that already arrive in name order", () => {
    expect(
      Disclosure.toEntries([
        descriptor("alpha", "Alpha flow"),
        descriptor("zebra", "Zebra flow")
      ])
    ).toEqual([
      { name: "alpha", description: "Alpha flow" },
      { name: "zebra", description: "Zebra flow" }
    ])
  })

  it("renders a single entry", () => {
    expect(Disclosure.toEntries([descriptor("only", "The only flow")])).toEqual([
      { name: "only", description: "The only flow" }
    ])
    expect(Disclosure.toXml([descriptor("only", "The only flow")])).toBe([
      "<available_skills>",
      "  <skill>",
      "    <name>only</name>",
      "    <description>The only flow</description>",
      "  </skill>",
      "</available_skills>"
    ].join("\n"))
  })

  it("renders an exact empty block", () => {
    expect(Disclosure.toXml([])).toBe("<available_skills>\n</available_skills>")
  })

  it("does not disclose descriptor metadata", () => {
    const rendered = Disclosure.toXml([descriptor("public", "Public description")])

    expect(rendered).not.toContain("DO-NOT-DISCLOSE")
  })
})
