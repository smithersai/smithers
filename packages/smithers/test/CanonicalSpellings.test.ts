/**
 * Every command the CLI prints is spelled the way the canonical tree names it.
 *
 * Hidden transition aliases (`ls`, `ps`, `up`, `status`, `logs`, `approve`,
 * `run --resume`, ...) still run, but a message that teaches one teaches a
 * spelling the help and docs no longer show. The scan reads every string a
 * source file under `packages/smithers` can print, including the argument
 * lists handed to a shell-quoting helper, and resolves each `smthrs ...`
 * spelling against the canonical Incur manifest.
 */
import { Cli as Incur } from "incur"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it, onTestFailed } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { cli } from "../src/Command.ts"
import * as Unsupported from "../src/Unsupported.ts"

const packageRoot = join(import.meta.dirname, "..")

const capture = async (
  args: ReadonlyArray<string>,
  published = false,
  progress?: (stage: string) => void
): Promise<string> => {
  const environment = { ...process.env, NO_COLOR: "1" } as Record<string, string>
  let output = ""
  const cli = makeCli({ environment })
  progress?.("constructed")
  const tree = published ? Incur.create("smthrs") : cli
  if (published) {
    const commands = Incur.toCommands.get(tree as never)!
    for (const [name, entry] of Incur.toCommands.get(cli as never)!) commands.set(name, entry)
  }
  await tree.serve([...args], {
    env: environment,
    stdout: (text) => {
      output += text
    },
    exit: () => {}
  })
  progress?.("served")
  return output
}

interface Manifest {
  readonly commands: ReadonlyArray<{
    readonly name: string
    readonly schema?: { readonly options?: { readonly properties?: Record<string, unknown> } }
  }>
  readonly globals?: { readonly properties?: Record<string, unknown> }
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

const sources = (root = packageRoot): ReadonlyArray<string> => {
  const files: Array<string> = []
  const walk = (directory: string, inSource: boolean): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "test", "fixtures"].includes(entry.name)) continue
        walk(path, inSource || entry.name === "src")
      } else if (
        inSource && /\.(?:tsx?|vibe)$/.test(entry.name) && !entry.name.endsWith(".d.ts") &&
        !entry.name.includes(".test.")
      ) {
        files.push(path)
      }
    }
  }
  walk(root, false)
  return files
}

/** A substitution the scan cannot read; it ends a command path like any positional. */
const hole = "\u2026"

/** The text with `\uXXXX`, `\u{…}` and `\xXX` escapes decoded, as a string literal reads. */
const decodeEscapes = (text: string): string =>
  text.replace(
    /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
    (_: string, braced?: string, unicode?: string, hex?: string) =>
      String.fromCodePoint(Number.parseInt(braced ?? unicode ?? hex ?? "0", 16))
  )

interface ScanProgress {
  files: number
  parsed: number
  nodes: number
  locations: number
  texts: number
}
const printedTexts = (
  file: string,
  progress?: ScanProgress
): ReadonlyArray<{ readonly line: number; readonly text: string }> => {
  if (progress) progress.files++
  const contents = readFileSync(file, "utf8")
  // Package imports such as @smthrs/flow are not printed CLI commands. They
  // occur in most SDK sources, so parsing them traversed 1.8 million nodes.
  // Keep standalone spellings (including shellCommand's first argument),
  // escaped spellings and the separate migration-instruction check.
  // Keep possible identity escapes and escaped whitespace boundaries. Octal
  // escapes enter the compiler directly. Ordinary regexes and newlines alone
  // no longer force a full parse of unrelated SDK sources.
  const candidate = decodeEscapes(contents.replace(/\\(?:\r\n|[\r\n\u2028\u2029])/g, ""))
  if (
    !/(?:(?<![\w@/.-])|\\[bfnrtv0])s\\?m\\?t\\?h\\?r\\?s\b|s\\?m\\?i\\?t\\?h\\?e\\?r\\?s\\?-\\?m\\?i\\?g\\?r\\?a\\?t\\?e/
      .test(candidate) && !/\\[0-7]/.test(contents)
  ) return []
  if (progress) progress.parsed++
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, false)
  const texts: Array<{ line: number; text: string }> = []
  const literal = (node: ts.Node): string | undefined =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined
  const record = (node: ts.Node, text: string) => {
    // Compiler-decoded text decides relevance. Escaped sources still get a
    // complete parse, without locating every import, key and unrelated string.
    if (!/(?<![\w@/.-])smthrs\b|smithers-migrate/.test(text)) return
    if (file.endsWith("/src/internal/RetiredSkills.ts") && text === "command: smthrs create-app") return
    if (progress) progress.locations++
    texts.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text })
  }
  const visit = (node: ts.Node): void => {
    if (progress) progress.nodes++
    const text = literal(node)
    if (text !== undefined) record(node, text)
    else if (ts.isTemplateExpression(node)) {
      record(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(hole))
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && literal(node.arguments[0]!) === "smthrs") {
      // `shellCommand("smthrs", "runs", "logs", runId)` prints a command
      // no single literal spells.
      record(node, node.arguments.map((argument) => literal(argument) ?? hole).join(" "))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (progress) progress.texts += texts.length
  return texts
}

describe("the spelling prefilter", () => {
  const keyword = "smthrs"
  const escapedKeywords = [...keyword].flatMap((letter, index) => {
    const prefix = keyword.slice(0, index)
    const suffix = keyword.slice(index + 1)
    const hex = letter.charCodeAt(0).toString(16)
    return [
      `${prefix}\\u00${hex}${suffix}`,
      `${prefix}\\u{${hex}}${suffix}`,
      `${prefix}\\x${hex}${suffix}`,
      `${prefix}\\${letter.charCodeAt(0).toString(8)}${suffix}`,
      `${prefix}\\\n${letter}${suffix}`,
      ...(["s", "m", "h"].includes(letter) ? [`${prefix}\\${letter}${suffix}`] : [])
    ]
  })
  it.each([
    ...escapedKeywords,
    ...["\\n", "\\r", "\\t", "\\b", "\\f", "\\v", "\\0", "\\073", "\\u005c", "\\x5c", "\\u{5c}"]
      .map((prefix) => `${prefix}smthrs`),
    "a\\\\s\\mthrs",
    "a\\u005cs\\mthrs"
  ])("retains the compiler's decoded command for %j", (spelling) => {
    const root = mkdtempSync(join(tmpdir(), "smithers-escaped-spelling-"))
    const file = join(root, "commands.ts")
    try {
      writeFileSync(file, `const message = "${spelling} status"`)
      expect(printedTexts(file).map(({ text }) => text)).toEqual(
        expect.arrayContaining([expect.stringContaining("smthrs status")])
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("skips compiler parsing for unrelated escaped SDK text", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-unprinted-spelling-"))
    const file = join(root, "commands.ts")
    try {
      writeFileSync(
        file,
        [
          "import { Flow } from \"@smthrs/flow\"",
          "const newline = \"\\n\"",
          "const whitespace = /\\s+/",
          "const slash = /\\\\/g"
        ].join("\n")
      )
      const progress: ScanProgress = { files: 0, parsed: 0, nodes: 0, locations: 0, texts: 0 }
      expect(printedTexts(file, progress)).toEqual([])
      expect(progress).toEqual({ files: 1, parsed: 0, nodes: 0, locations: 0, texts: 0 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("reads a literal that spells smthrs through escapes", () => {
    expect(decodeEscapes("\"sm\\u0074hrs status\"")).toContain("smthrs status")
    expect(decodeEscapes("\"\\x73mthrs\"")).toContain("smthrs")
    expect(decodeEscapes("\"\\u{73}mthrs\"")).toContain("smthrs")
  })

  it("parses escaped commands, templates, shell arguments and migration warnings with their source lines", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-spellings-"))
    const directory = join(root, "src")
    const file = join(directory, "commands.vibe")
    try {
      mkdirSync(directory)
      writeFileSync(
        file,
        [
          "import { Flow } from \"@smthrs/flow\"",
          "const escaped = \"sm\\u0074hrs status\"",
          "const template = `smthrs runs view ${runId}`",
          "const shell = shellCommand(\"smthrs\", \"runs\", \"view\", runId)",
          "const migration = 'run \"smithers-migrate\"'"
        ].join("\n")
      )
      expect(sources(root)).toEqual([file])
      const progress: ScanProgress = { files: 0, parsed: 0, nodes: 0, locations: 0, texts: 0 }
      const texts = printedTexts(file, progress)
      expect(texts).toEqual(expect.arrayContaining([
        { line: 2, text: "smthrs status" },
        { line: 3, text: `smthrs runs view ${hole}` },
        { line: 4, text: `smthrs runs view ${hole}` },
        { line: 5, text: "run \"smithers-migrate\"" }
      ]))
      expect(texts.map(({ text }) => text)).not.toContain("@smthrs/flow")
      expect(texts.map(({ text }) => text)).not.toContain("runs")
      expect(texts.map(({ text }) => text)).not.toContain("view")
      expect(progress.locations).toBe(texts.length)
      expect(progress.nodes).toBeGreaterThan(progress.locations)
      // A forbidden migration spelling must still be read without a valid
      // command elsewhere in the file.
      writeFileSync(file, "const migration = 'run \"smithers-migrate\"'")
      expect(printedTexts(file)).toEqual([{ line: 1, text: "run \"smithers-migrate\"" }])
      // Import-only SDK files have no printable commands to parse.
      writeFileSync(file, "import { Flow } from \"@smthrs/flow\"\nconst name = \"asmthrs command\"")
      const imports: ScanProgress = { files: 0, parsed: 0, nodes: 0, locations: 0, texts: 0 }
      expect(printedTexts(file, imports)).toEqual([])
      expect(imports).toEqual({ files: 1, parsed: 0, nodes: 0, locations: 0, texts: 0 })
      writeFileSync(file, `const command = ${JSON.stringify("Try:\nsmthrs status")}`)
      expect(printedTexts(file)).toEqual([{ line: 1, text: "Try:\nsmthrs status" }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("published group children", () => {
  it("resolves child options even when install discovery omits the library door", async () => {
    const manifest = JSON.parse(await capture(["--llms-full", "--format", "json"], true)) as Manifest
    expect(manifest.commands.find((command) => command.name === "runs logs")?.schema?.options?.properties)
      .toHaveProperty("follow")
  })
})

/**
 * Commands the install catalog hides and a message may still name.
 *
 * `smthrs migrate` is the command every 0.x project is told to run: by the
 * notice the `smthrs` package throws, by the READMEs, and by the migration
 * guide. A sweep once respelled it `smithers-migrate` to satisfy this suite
 * (#3071), which is `@smthrs/migrate`'s own bin and is not on the PATH of a
 * project that ran `npx smthrs`, so the 0.x notice named a command its reader
 * did not have (#3845).
 */
const documentedDoors: ReadonlyArray<string> = ["migrate"]

const sharedOptions = (manifest: Manifest, help: string) => {
  const flags = new Set([...help.matchAll(/--([a-z][a-z0-9-]*)/g)].map((match) => match[1]!))
  const values = new Set([...help.matchAll(/--([a-z][a-z0-9-]*)\s+<[^>]+>/g)].map((match) => match[1]!))
  for (const [name, property] of Object.entries(manifest.globals?.properties ?? {})) {
    flags.add(kebab(name))
    if ((property as { type?: string }).type !== "boolean") values.add(kebab(name))
  }
  return { flags, values }
}

const validatePrinted = (
  text: string,
  file: string,
  line: number,
  canonical: ReadonlyMap<string, Manifest["commands"][number]>,
  paths: ReadonlySet<string>,
  topLevel: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  sharedFlags: ReadonlySet<string>,
  sharedValues: ReadonlySet<string>
): Array<string> => {
  const alternatives = /[a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)+/.exec(text)
  if (alternatives) {
    return alternatives[0].split("|").flatMap((word) =>
      validatePrinted(
        text.replace(alternatives[0], word),
        file,
        line,
        canonical,
        paths,
        topLevel,
        hidden,
        sharedFlags,
        sharedValues
      )
    )
  }
  const findings: Array<string> = []
  for (const match of text.matchAll(/(?<![\w@/.-])smthrs +(?=\S)/g)) {
    const before = text.slice(0, match.index)
    let after = text.slice(match.index + match[0].length)
    // These source strings name the executable, rather than an invocation.
    if (/(?:command -v|@jsxImportSource) $/.test(before)) continue
    if (
      /^(?:CLI verbs\b|from (?:the WORKSPACE\.ts|its bin)\b|results$|serves:|has no removal notice\b|wrote it\.|interrupted by\b|needs Node\b)/
        .test(after)
    ) continue
    // A prose quote encloses the whole command; shell quotes enclose one argument.
    const enclosing = before.at(-1)
    if (enclosing && ["`", "'", "\""].includes(enclosing)) {
      const closing = after.indexOf(enclosing)
      if (closing >= 0) after = after.slice(0, closing)
    }
    const words: Array<string> = []
    for (const token of after.matchAll(/(?:[^\s"'`]+|'[^']*'|"(?:\\.|[^"\\])*")+/g)) {
      const raw = token[0]
      if (["&&", "|", "#", "smthrs"].includes(raw)) break
      const quoted = /^(['"]).*\1$/.test(raw)
      words.push(quoted ? raw.slice(1, -1) : raw === "." ? raw : raw.replace(/[.,;:)]+$/, ""))
      if (!quoted && /[.,;:)]$/.test(raw)) break
    }
    const where = `${file}:${line}: smthrs ${words.slice(0, 4).join(" ")}`
    // Incur extracts globals before command resolution, including flags between
    // group names. Keep their values from being mistaken for child commands.
    const tokens: Array<string> = []
    for (let index = 0; index < words.length; index++) {
      const token = words[index]!
      const flag = /^--([a-z][a-z0-9-]*)/.exec(token)?.[1]
      if (flag && sharedFlags.has(flag)) {
        if (!token.includes("=") && sharedValues.has(flag)) index++
      } else tokens.push(token)
    }
    const first = tokens[0]
    if (first === undefined || first === "." || first.startsWith("//")) continue
    if (hidden.has(first)) {
      findings.push(`${where} (hidden command ${first})`)
      continue
    }
    if (first.includes(hole) || first.startsWith("<") || first.startsWith("[")) continue
    if (!topLevel.has(first) && !paths.has(first) && !documentedDoors.includes(first)) {
      findings.push(`${where} (unknown command ${first})`)
      continue
    }
    let path = first, index = 1
    while (index < tokens.length && paths.has(`${path} ${tokens[index]}`)) {
      path = `${path} ${tokens[index++]}`
    }
    // Only executable manifest entries can consume positional arguments.
    if (!canonical.has(path) && !documentedDoors.includes(path)) {
      const child = tokens[index]
      if (child === undefined || child.includes(hole) || child.startsWith("<") || child.startsWith("[")) continue
      if (!child.startsWith("-")) {
        findings.push(`${where} (unknown command ${path} ${child})`)
        continue
      }
    }
    const options = new Set(Object.keys(canonical.get(path)?.schema?.options?.properties ?? {}).map(kebab))
    for (; index < tokens.length; index++) {
      const token = tokens[index]!
      const flag = /^--([a-z][a-z0-9-]*)/.exec(token)?.[1]
      if (flag !== undefined && !options.has(flag)) {
        findings.push(`${where} (undeclared option --${flag} on ${path})`)
      }
    }
  }
  return findings
}

describe("complete printed command validation", () => {
  const commands = ["runs show", "runs list", "runs logs", "environment run", "environment remote run", "target"]
  const canonical = new Map(commands.map((name) => [name, { name }]))
  const paths = new Set(
    commands.flatMap((name) => name.split(" ").map((_, i, words) => words.slice(0, i + 1).join(" ")))
  )
  const shared = sharedOptions({
    commands: [],
    globals: { properties: { root: { type: "string" }, dryRun: { type: "boolean" } } }
  }, "--help --json --format <format> --filter-output <keys> --token-limit <n> --token-offset <n>")
  const validate = (text: string) =>
    validatePrinted(
      text,
      "fixture.ts",
      1,
      canonical,
      paths,
      new Set(["runs", "environment", "target"]),
      new Set(["status"]),
      shared.flags,
      shared.values
    )
  it.each([
    "smthrs runz list",
    "smthrs --json runz list",
    "smthrs --token-limit 100 runz list",
    "smthrs --json runs view run-1",
    "smthrs --format json runs view run-1",
    "smthrs --format 'json' runz list",
    "smthrs runs --json view run-1",
    "smthrs runs view run-1",
    "smthrs environment rn local",
    "smthrs environment remote rn"
  ])(
    "rejects a command that cannot dispatch: %s",
    (text) => {
      expect(validate(text)).toHaveLength(1)
      expect(validate(text)[0]).toContain("unknown command")
    }
  )
  it.each([
    "smthrs runs show run-1",
    "smthrs .",
    "Use `smthrs .` to open the checkout.",
    "smthrs '//packages/x:test'",
    "smthrs runs logs run-1 --json",
    "smthrs target '//packages/x:test'",
    "smthrs runs",
    "Use `smthrs runs` for history.",
    "Use `smthrs environment remote` for the remote.",
    "smthrs --json runs list",
    "smthrs --token-limit 100 runs list",
    "smthrs runs --token-offset 10 list",
    "smthrs --filter-output 'items.name' runs list",
    "smthrs --root 'project' runs list",
    "smthrs --dry-run runs list",
    "smthrs runs --json list",
    "smthrs --format 'json' runs list",
    "smthrs --help",
    "smthrs runs --help",
    "smthrs runs show|logs run-1",
    "smthrs environment remote run local"
  ])(
    "accepts executable commands and their positional arguments: %s",
    (text) => expect(validate(text)).toEqual([])
  )
  it("scans unknown words after prose and templates through the same validator", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-invalid-spelling-"))
    const file = join(root, "commands.ts")
    try {
      writeFileSync(
        file,
        [
          "const top = \"Try smthrs runz list\"",
          "const child = `smthrs runs view ${runId}`",
          "const shell = shellCommand(\"smthrs\", \"environment\", \"rn\", name)"
        ].join("\n")
      )
      const findings = printedTexts(file).flatMap(({ text }) => validate(text))
      expect(findings).toHaveLength(3)
      expect(findings.join("\n")).toContain("unknown command runz")
      expect(findings.join("\n")).toContain("unknown command runs view")
      expect(findings.join("\n")).toContain("unknown command environment rn")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it.each([
    "Build smthrs CLI verbs, and the catalog",
    "Upload smthrs results",
    "command -v smthrs >/dev/null 2>&1",
    "smthrs needs Node 26 or later",
    "Try smthrs …",
    "Try smthrs runs <command>",
    "Try smthrs runs [command]",
    "Try smthrs runs " + hole,
    "An older smthrs wrote it. Run smthrs runs list"
  ])("distinguishes executable mentions and dynamic spellings: %s", (text) => {
    expect(validate(text)).toEqual([])
  })
  it("still rejects aliases and undeclared flags", () => {
    expect(validate("smthrs status")[0]).toContain("hidden command status")
    expect(validate("smthrs --json status")[0]).toContain("hidden command status")
    expect(validate("smthrs runs logs run-1 --invalid")[0]).toContain("undeclared option --invalid")
    expect(validate("smthrs runs logs 'run-1' --invalid")[0]).toContain("undeclared option --invalid")
    expect(validate("smthrs runs --help --invalid")[0]).toContain("undeclared option --invalid")
    expect(validate("smthrs runs show|view run-1")[0]).toContain("unknown command runs view")
  })
})

describe("printed command spellings", () => {
  it("name only canonical, non-hidden commands and their declared options", async () => {
    const started = Date.now()
    const stages: Array<{ stage: string; elapsedMs: number }> = []
    const progress: ScanProgress = { files: 0, parsed: 0, nodes: 0, locations: 0, texts: 0 }
    const mark = (stage: string) => stages.push({ stage, elapsedMs: Date.now() - started })
    const receipt = () => "Canonical scan progress " + JSON.stringify({ stages, progress })
    const diagnostic = () => console.error(receipt())
    onTestFailed(({ task }) => {
      for (const error of task.result?.errors ?? []) error.message += `\n${receipt()}`
      diagnostic()
    })
    mark("manifest")
    const manifest = JSON.parse(
      await capture(["--llms-full", "--format", "json"], false, (stage) => mark(`manifest ${stage}`))
    ) as Manifest
    // Install discovery hides published library children. Their printed flags
    // still resolve against their own schema, never the catalog parent schema.
    mark("published manifest")
    const published = JSON.parse(
      await capture(["--llms-full", "--format", "json"], true, (stage) => mark(`published ${stage}`))
    ) as Manifest
    const canonical = new Map(published.commands.map((command) => [command.name, command]))
    const paths = new Set(
      published.commands.flatMap((command) => {
        const words = command.name.split(" ")
        return words.map((_, index) => words.slice(0, index + 1).join(" "))
      })
    )
    const topLevel = new Set(manifest.commands.map((command) => command.name.split(" ")[0]!))
    // Published library doors remain valid in their own output even when install
    // discovery omits them. Only compatibility spellings are hidden aliases.
    const registered = cli.subcommands.flatMap((group) => group.commands.map((command) => command.name))
    // Every documented door is a command the tree answers, so the exception
    // above cannot outlive the command it names.
    expect(documentedDoors.filter((name) => !registered.includes(name))).toEqual([])
    const hidden = new Set(
      [
        ...registered,
        ...Unsupported.removedVerbs.map((verb) => verb.name)
      ].filter((name) => !topLevel.has(name) && !paths.has(name) && !documentedDoors.includes(name))
    )
    mark("help")
    const help = await capture(["--help"], false, (stage) => mark(`help ${stage}`))
    const { flags: sharedFlags, values: sharedValues } = sharedOptions(manifest, help)

    const findings: Array<string> = []
    // Sentences that tell the reader which command migrates a project.
    const migrateInstructions: Array<string> = []
    mark("source scan")
    for (const file of sources()) {
      for (const { line, text } of printedTexts(file, progress)) {
        if (/\brun "(?:smthrs migrate|smithers-migrate)"|`(?:smthrs migrate|smithers-migrate)` replaces/.test(text)) {
          migrateInstructions.push(text)
        }
        findings.push(
          ...validatePrinted(
            text,
            relative(packageRoot, file),
            line,
            canonical,
            paths,
            topLevel,
            hidden,
            sharedFlags,
            sharedValues
          )
        )
      }
    }
    mark("assertions")
    if (process.env.SMITHERS_TEST_SCAN_PROGRESS === "1") diagnostic()
    expect(hidden.size).toBeGreaterThan(0)
    expect(findings).toEqual([])
    // The 0.x notice and the `upgrade` refusal both name the migration
    // command, and both name the spelling the reader has.
    expect(migrateInstructions.filter((text) => text.includes("smthrs migrate")).length).toBeGreaterThanOrEqual(2)
    expect(migrateInstructions.filter((text) => text.includes("smithers-migrate"))).toEqual([])
  })
})
