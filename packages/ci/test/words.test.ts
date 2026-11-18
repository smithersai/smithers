/**
 * The words a person reads about fast mode: every page, the README and every
 * message the program can print say "the model that predicts which tests a
 * change cannot break", never the internal words for it.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageDir = fileURLToPath(new URL("..", import.meta.url))
const read = (path: string): string => readFileSync(join(packageDir, path), "utf8")
const under = (directory: string): ReadonlyArray<string> =>
  (readdirSync(join(packageDir, directory), { recursive: true, encoding: "utf8" }) as Array<string>)
    .map((path) => join(directory, path))
    .sort()

const internal = /\b(?:judge[sd]?|judging|jev|scorer|scored|rows?)\b/i

/** A page as a person reads it: its code is the program's own spelling, such as the file `rows.jsonl`. */
const prose = (page: string): string => page.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "").replace(/`[^`\n]*`/g, "")

/** The README without "Contract changes", the record of what the contracts were called when they changed. */
const readme = (text: string): string => text.replace(/^## Contract changes\n[\s\S]*?(?=^## )/m, "")

/** What in a line of source is text a person can be shown: its strings, with what they interpolate left out. */
const stringsOf = (line: string): ReadonlyArray<string> =>
  [...line.replace(/\$\{[^{}]*\}/g, "").matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g)]
    .map((match) => match[0])

/** The strings of a source file that use an internal word. An import path and an HTML attribute are not messages. */
const messagesIn = (source: string): ReadonlyArray<string> =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|import\b|export \* |\} from )/.test(line))
    .map((line) => line.replace(/\s\/\/ .*$/, "").replace(/scope="row"/g, "").replaceAll("rows.jsonl", ""))
    .flatMap(stringsOf)
    .filter((text) => internal.test(text))

/** What the reference pages show of a contract: its doc comments, without their code and links. */
const docCommentsIn = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/\/\*\*[\s\S]*?\*\//g)].map((match) =>
    match[0].replace(/`[^`]*`/g, "").replace(/\{@link [^}]*\}/g, "")
  )

const isProgram = (path: string): boolean =>
  /\.(?:ts|vibe)$/.test(path) && !path.endsWith(".d.vibe.ts") && !path.includes("/.")

describe("the words for fast mode", () => {
  it("are plain on every page", () => {
    const pages = under("docs").filter((path) => /\.(?:md|html)$/.test(path))
    expect(pages.length).toBeGreaterThan(5)
    expect(pages.filter((path) => internal.test(prose(read(path))))).toEqual([])
  })

  it("are plain in the README, outside the record of contract changes", () => {
    expect(readme(read("README.md"))).not.toMatch(internal)
    expect(readme("## Contract changes\nthe judge\n## Rules\nkept\n")).toBe("## Rules\nkept\n")
  })

  it("are plain in every message the program can print", () => {
    const sources = under("src").filter(isProgram)
    expect(sources.length).toBeGreaterThan(20)
    expect(sources.flatMap((path) => messagesIn(read(path)).map((text) => `${path}: ${text}`))).toEqual([])
  })

  it("are plain in the doc comments of the contracts, which the reference pages show", () => {
    const contracts = under("src/contract").filter(isProgram)
    expect(contracts.length).toBeGreaterThan(5)
    const found = contracts.flatMap((path) =>
      docCommentsIn(read(path)).filter((text) => internal.test(text)).map((text) => `${path}: ${text}`)
    )
    expect(found).toEqual([])
    expect(docCommentsIn("/** The `rows` of {@link Rows}. */\n/** The scorer. */")).toEqual([
      "/** The  of . */",
      "/** The scorer. */"
    ])
  })

  it("finds an internal word in a message, and not in a comment, an import or an interpolated name", () => {
    expect(messagesIn(`const a = "the scorer said no"\n`)).toEqual([`"the scorer said no"`])
    expect(messagesIn("fail(`${count} rows left`)\n")).toEqual(["` rows left`"])
    expect(messagesIn(`/* the judge */\n// the judge\nimport * as Rows from "./Rows.vibe"\nconst b = 1 // the jev\n`))
      .toEqual([])
    expect(messagesIn("html(`<th scope=\"row\">${metrics.rows}</th>`)\nread(\"rows.jsonl\")\n")).toEqual([])
  })
})
