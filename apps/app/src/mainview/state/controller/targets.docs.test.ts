import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

/*
 * The lane's prose contract. docs/LOCAL-APP.md is the document targets.ts
 * cites, so every section it names must exist there, and its prose obeys the
 * house rule the site's check-docs gate enforces: no em or en dash outside
 * fenced code. The exported openRepo contract must state what the code does,
 * which is registering the repository and refreshing the sidebar mirror;
 * listTargets is the act that draws a card.
 */
const DOCS = `${import.meta.dir}/../../../../docs/LOCAL-APP.md`
const SOURCE = `${import.meta.dir}/targets.ts`
const withoutFences = (markdown: string) => markdown.replace(/```[\s\S]*?```/g, "")

describe("targets controller documentation", () => {
  test("LOCAL-APP.md carries no em or en dash outside fenced code", async () => {
    const prose = withoutFences(await readFile(DOCS, "utf8"))
    expect(prose.split("\n").filter((line) => /[—–]/.test(line))).toEqual([])
  })

  test("every LOCAL-APP.md section targets.ts cites is a heading in it", async () => {
    const headings = new Set(
      (await readFile(DOCS, "utf8")).split("\n")
        .filter((line) => line.startsWith("#"))
        .map((line) => line.replace(/^#+\s*/, "").trim())
    )
    const cited = [...(await readFile(SOURCE, "utf8")).matchAll(/docs\/LOCAL-APP\.md "([^"]+)"/g)].map((match) => match[1])
    expect(cited.length).toBeGreaterThan(0)
    expect(cited.filter((section) => !headings.has(section))).toEqual([])
  })

  test("the openRepo contract promises no card of its own", async () => {
    const source = await readFile(SOURCE, "utf8")
    const contract = source.slice(source.indexOf("export interface TargetsController"))
    const openRepoDoc = contract.slice(0, contract.indexOf("readonly openRepo"))
    expect(openRepoDoc).toContain("listTargets")
    expect(openRepoDoc).not.toMatch(/repo card|auto-load/)
  })
})
