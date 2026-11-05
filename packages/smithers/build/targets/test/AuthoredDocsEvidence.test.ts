import { describe, expect, it } from "vitest"
import * as DocsCheck from "../src/DocsCheck.ts"
import { Smithers as S } from "../src/index.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"

const ignore = { frontmatterKeys: ["verified"], sections: ["Log"] }
const text =
  "---\nowner: Will\nverified: yesterday\n---\n# Guide\nKeep this promise.\n## Log\nVerified yesterday.\n## Contract\nKeep this too.\n"
const digest = (value: string) => Input.digestText(DocsCheck.normalize(value, ignore))
const page = { path: "guide.md", digest: Input.digestText(text) }
const input = { path: "policy.md", digest: "policy-v1" }

describe("authored documentation", () => {
  it("normalizes only explicitly selected metadata and sections", () => {
    expect(DocsCheck.normalize(text)).toBe(text)
    expect(digest(text.replaceAll("yesterday", "today"))).toBe(digest(text))
    for (
      const changed of [
        text.replace("owner: Will", "owner: Alex"),
        text.replace("Keep this promise", "Change this promise"),
        text.replace("Keep this too", "Change this too"),
        text.replace("## Log", "## Logs")
      ]
    ) expect(digest(changed)).not.toBe(digest(text))
  })

  it("keeps heading lookalikes in fenced code and the next real section", () => {
    const code =
      "# Guide\n```md\n## Log\nsemantic example\n```\n## Log\nmetadata\n```md\n## Contract\n```\n## Contract\nsemantic contract\n"
    expect(digest(code.replace("semantic example", "different example"))).not.toBe(digest(code))
    expect(digest(code.replace("semantic contract", "different contract"))).not.toBe(digest(code))
    expect(digest(code.replace("metadata", "other metadata"))).toBe(digest(code))
  })

  it("fails closed on complex YAML instead of swallowing another field", () => {
    const complex = "---\nverified: |\n  metadata\nowner: Will\n---\nBody\n"
    expect(() => DocsCheck.normalize(complex, ignore)).toThrow(/scalar/)
    expect(() => DocsCheck.normalize("---\nverified: today\nBody", ignore)).toThrow(/frontmatter/)
  })

  it("compares identical evidence closures without reporting a change", () => {
    expect(DocsCheck.firstDifference([input, { path: "absent", digest: null }], [
      { path: "absent", digest: undefined },
      input
    ])).toBeUndefined()
    expect(DocsCheck.firstDifference([], [input])).toEqual({ path: input.path, change: "added" })
    expect(DocsCheck.firstDifference([{ path: "before.md", digest: "old" }], [input]))
      .toEqual({ path: "before.md", change: "removed" })
  })

  it("binds the normalization policy to the stamp and uses authored wording", () => {
    const stamp = DocsCheck.makeStamp({ producer: "Will", output: page, inputs: [input], ignore })
    expect(DocsCheck.parseStamp(DocsCheck.renderStamp(stamp))).toEqual(stamp)
    const verdict = DocsCheck.judge({
      page: page.path,
      stampPath: "stamp.json",
      stamp,
      output: page,
      inputs: [input],
      authored: true
    })
    expect(verdict?.reason).toBe("modified")
    expect(verdict?.message).toContain("re-verify the doc")
    expect(verdict?.message).not.toContain("regenerate")
  })

  it("does not cache time-dependent evidence checks", () => {
    const target = S.Docs.Check({
      stamp: S.file("stamp.json"),
      output: S.file("guide.md"),
      inputs: [],
      authored: true,
      ignore,
      evidence: [{ file: S.file("evidence.json"), dependency: "live:service", ttlMs: 1000 }]
    })
    expect(Target.metadata(target).cacheable).toBe(false)
    expect(Target.metadata(target).inputs).toContainEqual(S.file("evidence.json"))
  })
})

describe("local evidence evaluation", () => {
  const input: DocsCheck.EvidenceInput = { file: S.file("evidence.json"), dependency: "live:service", ttlMs: 1000 }
  const record = { format: 1, dependency: "live:service", digest: "external-v1", observedAt: 1000 }
  const json = (extra = {}) => JSON.stringify({ ...record, ...extra })

  it("expires at the exact TTL boundary and is independent of collection time", () => {
    const digest = DocsCheck.evidenceDigest(json(), input, 1999)
    expect(digest).toBe(Input.digestText(JSON.stringify({ dependency: "live:service", digest: "external-v1" })))
    expect(DocsCheck.evidenceDigest(json({ observedAt: 1500 }), input, 1999)).toBe(digest)
    expect(DocsCheck.evidenceDigest(json({ digest: "external-v2" }), input, 1999)).not.toBe(digest)
    expect(DocsCheck.evidenceDigest(json(), input, 2000)).toBeUndefined()
    expect(DocsCheck.evidenceDigest(json(), input, 2001)).toBeUndefined()
  })

  it("never calls missing, malformed, future or unbound observations fresh", () => {
    for (
      const value of [
        undefined,
        "not json",
        "{}",
        json({ format: 2 }),
        json({ digest: "" }),
        json({ dependency: "other" }),
        json({ observedAt: -1 }),
        json({ observedAt: 1.5 }),
        json({ observedAt: 2000 }),
        json({ observedAt: "1000" }),
        json({ status: "unavailable" })
      ]
    ) {
      expect(DocsCheck.evidenceDigest(value, input, 1999)).toBeUndefined()
    }
    for (const now of [NaN, Infinity, -1, 1.5]) {
      expect(DocsCheck.evidenceDigest(json(), input, now)).toBeUndefined()
    }
    for (const ttlMs of [NaN, 0, -1, 1.5]) {
      expect(DocsCheck.evidenceDigest(json(), { ...input, ttlMs }, 1999)).toBeUndefined()
    }
  })

  it("refuses invalid TTLs and ambiguous local evidence paths at declaration", () => {
    const declare = (evidence: ReadonlyArray<DocsCheck.EvidenceInput>) =>
      S.Docs.Check({
        stamp: S.file("stamp.json"),
        output: S.file("guide.md"),
        inputs: [],
        evidence
      })
    for (const ttlMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => declare([{ ...input, ttlMs }])).toThrow(/positive safe integer/)
    }
    for (
      const evidence of [[input, input], [{ ...input, file: S.file("stamp.json") }], [{
        ...input,
        file: S.file("guide.md")
      }]]
    ) {
      expect(() => declare(evidence)).toThrow(/distinct/)
    }
    expect(Target.metadata(declare([])).cacheable).toBe(true)
  })
})

describe("normalization syntax boundaries", () => {
  it("preserves bytes without selected metadata, including line endings and trailing spaces", () => {
    for (const value of ["", "body", "body  \r\n", "---\nowner: Will\n---\nbody\n"]) {
      expect(DocsCheck.normalize(value, {})).toBe(value)
      expect(DocsCheck.normalize(value, { frontmatterKeys: ["verified"] })).toBe(value)
    }
    const crlf = "---\r\nverified: today\r\nowner: Will\r\n...\r\nbody  \r\n"
    expect(DocsCheck.normalize(crlf, { frontmatterKeys: ["verified"] })).toBe(
      "---\r\nverified: null\r\nowner: Will\r\n...\r\nbody  \r\n"
    )
    expect(DocsCheck.normalize("---\nverified: today\n---", { frontmatterKeys: ["verified"] })).toBe(
      "---\nverified: null\n---"
    )
    expect(DocsCheck.normalize("---\nowner: Will\n---\n## Log\nmeta", { sections: ["Log"] })).toBe(
      "---\nowner: Will\n---\n"
    )
    expect(DocsCheck.normalize("\n# Guide\n", { sections: ["Log"] })).toBe("\n# Guide\n")
  })

  it("accepts simple quoted metadata and leaves other YAML values intact", () => {
    for (const value of ["\"today\"", "'today'", "42", "null", ""]) {
      expect(DocsCheck.normalize(`---\nverified: ${value}\nowner: Will\n---\n`, ignore))
        .toBe("---\nverified: null\nowner: Will\n---\n")
    }
    for (const value of ["[]", "{}", "\"owner\"", "'owner'"]) {
      expect(DocsCheck.normalize(`---\nowner: ${value}\n---\n`, ignore)).toBe(`---\nowner: ${value}\n---\n`)
    }
    for (const value of ["[", "{", "'open", "\"open"]) {
      expect(() => DocsCheck.normalize(`---\nowner: ${value}\nverified: today\n---\n`, ignore)).toThrow(/single-line/)
    }
    expect(() => DocsCheck.normalize("---\nverified: today\n  continuation\n---\n", ignore)).toThrow(/scalar/)
  })

  it("refuses ambiguous YAML quoting, anchors and flow collections", () => {
    for (
      const value of [
        "\"escaped\\\"",
        "'doubled''",
        "[\"open]",
        "{nested: {field: true}}",
        "&anchor value",
        "*alias",
        "!tag value"
      ]
    ) {
      expect(() => DocsCheck.normalize(`---\nowner: ${value}\nverified: today\n---\n`, ignore)).toThrow(
        DocsCheck.NormalizationError
      )
    }
    expect(() => DocsCheck.normalize("---\n'quoted-key': value\nverified: today\n---\n", ignore)).toThrow(/simple YAML/)
    expect(() => DocsCheck.normalize("---\nowner:\n  \"open\nverified: semantic\n  close\"\n---\n", ignore))
      .toThrow(/simple YAML/)
    const comments = "---\n# metadata\n\nverified: today\nowner: Will\n---\n"
    expect(DocsCheck.normalize(comments, ignore)).toBe(comments.replace("verified: today", "verified: null"))
  })

  it("keeps shorter or different fences inside an example and handles repeated sections", () => {
    const value =
      "# Guide\n~~~~md\n## Log\n~~~\n```\n~~~~ content\n~~~~\n## Log ###\nmeta\n### Detail\nmore meta\n# Next\nsemantic\n## Log\nlast meta"
    expect(DocsCheck.normalize(value, { sections: ["Log"] })).toBe(
      "# Guide\n~~~~md\n## Log\n~~~\n```\n~~~~ content\n~~~~\n# Next\nsemantic\n"
    )
    for (
      const value of [
        "## Log\nmeta\n```md\n## Next\nsemantic",
        "## Log\nmeta\n<div>\n## Next\nsemantic",
        "## Log\nmeta\nContract\n---\nsemantic"
      ]
    ) {
      expect(() => DocsCheck.normalize(value, { sections: ["Log"] })).toThrow(DocsCheck.NormalizationError)
    }
    expect(DocsCheck.normalize("```\n", { frontmatterKeys: ["verified"] })).toBe("```\n")
  })

  it("refuses fence and HTML ambiguities that could swallow a semantic heading", () => {
    for (
      const value of [
        "## Log\n```bad`info\n## Contract\nsemantic\n```\n",
        "prefix <!--\n## Log\n-->\nsemantic\n## Next\n",
        "## Log\n- example\n  ```md\n## Contract\nsemantic\n```\n"
      ]
    ) expect(() => DocsCheck.normalize(value, { sections: ["Log"] })).toThrow(DocsCheck.NormalizationError)
  })

  it("canonicalizes policy order without changing the default stamp layout", () => {
    const options = { producer: null, output: page, inputs: [input] }
    const stamp = DocsCheck.makeStamp({
      ...options,
      ignore: { sections: ["Z", "Log", "Z"], frontmatterKeys: ["verified", "checked"] }
    })
    const reordered = DocsCheck.makeStamp({
      ...options,
      ignore: { sections: ["Log", "Z"], frontmatterKeys: ["checked", "verified"] }
    })
    expect(DocsCheck.renderStamp(stamp)).toBe(DocsCheck.renderStamp(reordered))
    expect(
      DocsCheck.judge({
        page: page.path,
        stampPath: "stamp.json",
        stamp,
        output: page,
        inputs: [input],
        ignore: reordered.ignore
      })
    ).toBeUndefined()
    expect(DocsCheck.makeStamp(options)).not.toHaveProperty("ignore")
    expect(DocsCheck.parseStamp(DocsCheck.renderStamp(DocsCheck.makeStamp({ ...options, ignore: {} })))?.ignore)
      .toEqual({ frontmatterKeys: [], sections: [] })
  })
})
