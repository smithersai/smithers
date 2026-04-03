import { describe, expect, it } from "bun:test"

import {
  extractStructuredOutputProseText,
  parseInlineCodeSegments,
  parseStructuredOutputCards,
  parseStructuredOutputJsonObjects,
} from "./structured-output"

describe("parseStructuredOutputCards", () => {
  it("builds one message card per JSON object", () => {
    const cards = parseStructuredOutputCards(
      '{"summary":"This is a summary.","highlights":["Point one","Point two"]}'
    )

    expect(cards).toHaveLength(1)
    expect(cards[0]?.title).toBe("Message 1")

    const summarySection = cards[0]?.sections.find((section) => section.title === "summary")
    expect(summarySection).toEqual({
      title: "summary",
      kind: "paragraph",
      text: "This is a summary.",
    })

    const highlightsSection = cards[0]?.sections.find((section) => section.title === "highlights")
    expect(highlightsSection).toEqual({
      title: "highlights",
      kind: "bullets",
      items: ["Point one", "Point two"],
    })
  })

  it("classifies string arrays with file extensions as file tables", () => {
    const cards = parseStructuredOutputCards(
      '{"files":["apps/web/src/app.tsx","README.md","src/main.test.ts:42"]}'
    )

    expect(cards).toHaveLength(1)
    const filesSection = cards[0]?.sections.find((section) => section.title === "files")
    expect(filesSection).toEqual({
      title: "files",
      kind: "files",
      files: [
        { path: "apps/web/src/app.tsx", extension: "tsx" },
        { path: "README.md", extension: "md" },
        { path: "src/main.test.ts:42", extension: "ts" },
      ],
    })
  })

  it("extracts multiple JSON objects from noisy transcript text", () => {
    const cards = parseStructuredOutputCards(`codex
{"summary":"One"}
exec
/bin/zsh -lc 'ls -la'
codex
{"summary":"Two","items":["a","b"]}`)

    expect(cards).toHaveLength(2)
    expect(cards[0]?.sections.find((section) => section.title === "summary")).toEqual({
      title: "summary",
      kind: "paragraph",
      text: "One",
    })
    expect(cards[1]?.sections.find((section) => section.title === "summary")).toEqual({
      title: "summary",
      kind: "paragraph",
      text: "Two",
    })
  })

  it("returns no cards when output has no JSON objects", () => {
    const cards = parseStructuredOutputCards("plain text only")
    expect(cards).toHaveLength(0)
  })

  it("extracts prose text while removing trailing structured json blocks", () => {
    const prose = extractStructuredOutputProseText(`Intro text

\`\`\`json
{"summary":"One","steps":["a","b"]}
\`\`\``)

    expect(prose).toBe("Intro text")
  })

  it("returns empty prose when output is only structured json", () => {
    const prose = extractStructuredOutputProseText('{"summary":"Only structured"}')
    expect(prose).toBe("")
  })

  it("hides sections for null, empty strings, and empty arrays", () => {
    const cards = parseStructuredOutputCards(
      '{"keep":"Shown","hideNull":null,"hideEmptyString":"","hideEmptyArray":[]}'
    )

    expect(cards).toHaveLength(1)
    expect(cards[0]?.sections).toEqual([
      {
        title: "keep",
        kind: "paragraph",
        text: "Shown",
      },
    ])
  })

  it("extracts deduped JSON objects for raw mode", () => {
    const objects = parseStructuredOutputJsonObjects(`{"a":1}
{"a":1}
{"b":2}`)

    expect(objects).toEqual([{ a: 1 }, { b: 2 }])
  })

  it("splits multi-word keys from camelCase and kebab-case", () => {
    const cards = parseStructuredOutputCards(
      '{"intentSummary":"Summary text","search-keywords":["alpha","beta"],"single":"ok"}'
    )

    expect(cards).toHaveLength(1)
    expect(cards[0]?.sections.map((section) => section.title)).toEqual([
      "Intent Summary",
      "Search Keywords",
      "single",
    ])
  })

  it("parses paired backticks into inline code segments", () => {
    const segments = parseInlineCodeSegments("Use `smithers run` in `./workspace`")
    expect(segments).toEqual([
      { kind: "text", text: "Use " },
      { kind: "code", text: "smithers run" },
      { kind: "text", text: " in " },
      { kind: "code", text: "./workspace" },
    ])
  })

  it("keeps unmatched backticks as plain text", () => {
    const segments = parseInlineCodeSegments("Use `smithers run")
    expect(segments).toEqual([{ kind: "text", text: "Use `smithers run" }])
  })
})
