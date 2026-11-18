import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Command } from "../src/index.ts"

const packageDir = fileURLToPath(new URL("..", import.meta.url))
const docsDir = join(packageDir, "docs")
const read = (path: string): string => readFileSync(join(packageDir, path), "utf8")

const pages = (readdirSync(docsDir, { recursive: true, encoding: "utf8" }) as Array<string>)
  .filter((path) => path.endsWith(".md"))
  .map((path) => join("docs", path))
  .sort()

/** The rows of the first table under `## heading`, as trimmed cells. */
const table = (markdown: string, heading: string): ReadonlyArray<ReadonlyArray<string>> => {
  const lines = markdown.split("\n")
  const start = lines.indexOf(`## ${heading}`)
  if (start === -1) throw new Error(`no "## ${heading}" section`)
  const rest = lines.slice(start + 1)
  const first = rest.findIndex((line) => line.startsWith("|"))
  const end = rest.findIndex((line, index) => index > first && !line.startsWith("|"))
  return rest.slice(first, end === -1 ? undefined : end)
    .slice(2)
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
}

const code = (cell: string): string => {
  const match = /^`([^`]*)`$/.exec(cell)
  if (match === null) throw new Error(`expected one code span, got ${cell}`)
  return match[1]!
}

/** `smithers-ci` is the command with no name; `smithers-ci apply` is `apply`. */
const commandName = (cell: string): string => code(cell).replace(/^smithers-ci ?/, "")

const defaultOf = (cell: string): string => cell === "none" ? "" : code(cell)

/** Every line of code, inline or fenced, in a Markdown page. */
const codeOf = (markdown: string): ReadonlyArray<string> => {
  const fenced = [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].flatMap((match) => match[1]!.split("\n"))
  const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "")
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!)
  return [...fenced, ...inline]
}

/** Each `smithers-ci` invocation in a line of code: its command and its flags. */
const invocations = (line: string): ReadonlyArray<{ command: string; flags: ReadonlyArray<string> }> =>
  [...line.matchAll(/smithers-ci((?: +[^\s|`]+)*)/g)].map((match) => {
    const words = match[1]!.trim().split(/ +/).filter((word) => word !== "")
    const command = words[0] !== undefined && !words[0].startsWith("-") && !words[0].startsWith("[") ? words[0] : ""
    const flags = words.filter((word) => word.startsWith("--")).map((word) => word.split("=")[0]!)
    return { command, flags }
  })

/** The commands, flags and exit codes a command reference documents, in contract 7's shape. */
const documented = (reference: string) => ({
  commands: Object.fromEntries(table(reference, "Commands").map(([name, help]) => [commandName(name!), help])),
  flags: Object.fromEntries(
    table(reference, "Flags").map(([flag, on, value, help]) => [
      code(flag!).replace(/^--/, ""),
      { on: on!.split(",").map((cell) => commandName(cell.trim())), default: defaultOf(value!), help }
    ])
  ),
  exitCodes: Object.fromEntries(
    table(reference, "Exit codes").map(([value, name]) => [code(name!), Number(code(value!))])
  ),
  environment: Object.fromEntries(table(reference, "Environment").map(([name, help]) => [code(name!), help]))
})

const contract = {
  commands: Command.commands,
  flags: Command.flags,
  exitCodes: Command.exitCodes,
  environment: Command.environment
}

describe("command reference", () => {
  const reference = read("docs/reference/cli.md")

  it("documents exactly the commands, flags, defaults, exit codes and variables of contract 7", () => {
    expect(documented(reference)).toEqual(contract)
  })

  it("names every flag: in the Flags table, and in the syntax line exactly when it takes no value", () => {
    const names = Object.keys(Command.flags) as ReadonlyArray<keyof typeof Command.flags>
    expect(Object.keys(documented(reference).flags).sort()).toEqual([...names].sort())
    // The line gives one flag with its value as the example, and then every flag that takes none.
    const [example = "", none = ""] = Command.syntax.value.split(". ")
    const namedIn = (sentence: string) => [...sentence.matchAll(/`--([a-z-]+)[ `]/g)].map((match) => match[1])
    expect(namedIn(none).sort()).toEqual(names.filter((name) => Command.flags[name].default === "false").sort())
    for (const name of namedIn(example)) {
      expect(Command.flags[name as keyof typeof Command.flags].default).not.toBe("false")
    }
    expect(namedIn(example)).toHaveLength(1)
    // The page states both rules in the contract's words.
    expect(reference).toContain(Command.syntax.value)
    expect(reference).toContain(Command.syntax.help)
  })

  it("gives each exit code the meaning contract 7 gives it", () => {
    const meanings = Object.fromEntries(
      table(reference, "Exit codes").map(([_value, name, meaning]) => [code(name!), meaning])
    )
    expect(meanings).toEqual(Command.exitCodeHelp)
    expect(meanings["mismatch"]).toContain("flaky")
  })

  it("disagrees with contract 7 when a default, a help text, a command or an exit code drifts", () => {
    const drifts = [
      reference.replace(/(\| `--commits` +\|[^|]+\| +)`20`/, "$1`50`"),
      reference.replace("How many past commits to replay.", "How many commits to replay."),
      reference.replace(/\| `smithers-ci replay` +\|/, "| `smithers-ci rerun` |"),
      reference.replace(/(\| `--json` +\| `smithers-ci`), `smithers-ci inventory`/, "$1"),
      reference.replace(/\| `3` +\| `unsupported`/, "| `4` | `unsupported`"),
      reference.replace(/^\| `--out` .*\n/m, ""),
      reference.replace(/^\| `AI_GATEWAY_API_KEY` .*\n/m, ""),
      reference.replace("The token sent to the shared cache", "A token for the shared cache")
    ]
    for (const drifted of drifts) {
      expect(drifted).not.toBe(reference)
      expect(documented(drifted)).not.toEqual(contract)
    }
  })

  it("refuses a reference with a section or a code span missing", () => {
    expect(() => documented(reference.replace("## Exit codes", "## Exits"))).toThrow("no \"## Exit codes\" section")
    expect(() => documented(reference.replace(/\| `--jobs` +\|/, "| --jobs |"))).toThrow("expected one code span")
  })
})

/** The GitHub anchor of every heading in a Markdown page. */
const anchors = (markdown: string): ReadonlyArray<string> =>
  [...markdown.matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
    match[1]!.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")
  )

/** Commands and flags a page uses that contract 7 lacks, or does not allow together. */
const surfaceProblems = (page: string, text: string) => {
  const flags: Record<string, { readonly on: ReadonlyArray<string> }> = Command.flags
  const lines = page.endsWith(".html")
    ? [...text.matchAll(/<code>([^<]*)<\/code>/g)].map((match) => match[1]!)
    : codeOf(text)
  const problems: Array<string> = []
  const uses: Array<string> = []
  for (const { command, flags: named } of lines.flatMap(invocations)) {
    const shown = command === "" ? "smithers-ci" : `smithers-ci ${command}`
    if (!Object.hasOwn(Command.commands, command)) problems.push(`${page}: unknown command \`${shown}\``)
    uses.push(command)
    for (const flag of named) {
      const entry = Object.hasOwn(flags, flag.slice(2)) ? flags[flag.slice(2)] : undefined
      if (entry === undefined) problems.push(`${page}: unknown flag \`${flag}\``)
      else if (!entry.on.includes(command)) problems.push(`${page}: \`${shown}\` does not accept \`${flag}\``)
      uses.push(flag)
    }
  }
  return { problems, uses }
}

describe("every docs page", () => {
  it("finds the pages", () => {
    expect(pages).toContain("docs/README.md")
    expect(pages).toContain("docs/reference/cli.md")
  })

  it("uses only commands and flags contract 7 has, on commands that accept them", () => {
    const found = [...pages, "docs/splash/index.html"].map((page) => surfaceProblems(page, read(page)))
    expect(found.flatMap((result) => result.problems)).toEqual([])
    const uses = found.flatMap((result) => result.uses)
    expect(uses).toEqual(expect.arrayContaining(["", "apply", "inventory", "replay", "--commits", "--mode", "--json"]))
  })

  it("reports a command, a flag, or a flag on a command that contract 7 does not have", () => {
    const page =
      "Run `smithers-ci rerun`.\n\n```sh\nbunx smithers-ci --shard 1\nbunx smithers-ci inventory --mode fast\n```\n"
    expect(surfaceProblems("page.md", page).problems).toEqual([
      "page.md: unknown flag `--shard`",
      "page.md: `smithers-ci inventory` does not accept `--mode`",
      "page.md: unknown command `smithers-ci rerun`"
    ])
    const html = "<p><code>bunx smithers-ci apply --json</code> and <code>smithers-ci --cache=URL</code></p>"
    expect(surfaceProblems("page.html", html)).toEqual({
      problems: ["page.html: `smithers-ci apply` does not accept `--json`"],
      uses: ["apply", "--json", "", "--cache"]
    })
  })

  it("links only to files that exist", () => {
    for (const page of pages) {
      const text = read(page)
      for (const match of text.matchAll(/\]\(([^)\s#]+)(?:#([^)]*))?\)/g)) {
        const target = match[1]!
        if (/^[a-z]+:/.test(target)) continue
        const path = join(dirname(join(packageDir, page)), target)
        expect(existsSync(path), `${page} links ${target} (${relative(packageDir, path)})`).toBe(true)
        const anchor = match[2]
        if (anchor !== undefined) {
          expect(anchors(readFileSync(path, "utf8")), `${page} links ${match[0]}`).toContain(anchor)
        }
      }
    }
  })

  it("is linked from the docs index", () => {
    const index = read("docs/README.md")
    for (const page of pages.filter((path) => path !== "docs/README.md")) {
      expect(index, page).toContain(`](${relative("docs", page)})`)
    }
  })
})
