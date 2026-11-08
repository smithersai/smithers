// GitHub's own answer for how an escaped machine body renders (render-fixtures.json, recorded by render-fixtures.mjs
// from POST https://api.github.com/markdown, gfm mode): each case shows exactly as written, with no link, code,
// emphasis, mention, emoji or math markup. Offline: the recorded answers, checked against today's escaper.
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
// @ts-expect-error: a plain .mjs module, untyped here.
import { RENDER_CASES } from "./render-cases.mjs"
import { escapeMarkdown } from "../../src/features/issues/publicContent.mjs"

type Fixture = { text: string; escaped: string; html: string }
const recorded = JSON.parse(readFileSync(new URL("./render-fixtures.json", import.meta.url), "utf8")) as { fixtures: Array<Fixture> }

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" }
/** What a reader sees of GitHub's HTML: paragraphs and line breaks as newlines, tags gone, entities decoded, word joiners unseen. */
const shown = (html: string) =>
  html
    .replace(/<br>\n?/g, "\n")
    .replace(/<\/p>\n?/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) =>
      NAMED[code.toLowerCase()] ?? (code[0] === "#" ? String.fromCodePoint(code[1]!.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))) : whole))
    .replace(/⁠/g, "")
/** HTML drops a line's leading and trailing spaces; everything else must be the same. */
const settled = (text: string) => text.replace(/[ \t]+$/gm, "").replace(/^[ \t]+/gm, "").trim()

describe("GitHub renders an escaped machine body as written", () => {
  test("the recordings are of today's cases and today's escaper: refresh them with render-fixtures.mjs when either changes", () => {
    expect(recorded.fixtures.map((fixture) => fixture.text)).toEqual(RENDER_CASES)
    for (const fixture of recorded.fixtures) expect(fixture.escaped, fixture.text).toBe(escapeMarkdown(fixture.text))
  })

  test.each(recorded.fixtures.map((fixture) => [fixture.text.slice(0, 40), fixture] as const))("%s", (_, fixture) => {
    expect(fixture.html).not.toMatch(/<(?!\/?(?:p|br)\b)[a-z]/i)
    expect(fixture.html).not.toMatch(/user-mention|issue-link|class="emoji"|math-renderer/)
    expect(settled(shown(fixture.html))).toBe(settled(fixture.text))
  })
})
