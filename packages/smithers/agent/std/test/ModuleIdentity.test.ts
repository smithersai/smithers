/**
 * The package's identity, pinned across every module.
 *
 * One package name in the barrel header, `@since` stamps inside the releases
 * this package has, one `@smthrs/std/<Name>` prefix for every service key,
 * error tag and class identifier, the decoded `Input` and `Output` types beside
 * every flow's schemas, and module headers that describe the module instead of
 * citing a file that does not exist.
 */
import { Context } from "effect"
import * as Fs from "node:fs"
import * as Path from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import * as Std from "../src/index.ts"

const packageRoot = Path.resolve(import.meta.dirname, "..")
const repositoryRoot = Path.resolve(packageRoot, "../../../..")
const sourceRoot = Path.join(packageRoot, "src")
const manifest = JSON.parse(Fs.readFileSync(Path.join(packageRoot, "package.json"), "utf8")) as {
  readonly name: string
  readonly version: string
}
const prefix = `${manifest.name}/`

/** A source module: TypeScript, or the same module migrated to VibeLang. */
const sourceExtensions = [".ts", ".vibe"] as const

/** A source module's file, and not the declaration sidecar a `.vibe` module may emit. */
const isSourceFile = (file: string): boolean =>
  sourceExtensions.some((extension) => file.endsWith(extension)) && !file.endsWith(".d.vibe.ts")

/** The one file, among the paths `exists` accepts, that holds the module `name`. */
const sourceFile = (exists: (file: string) => boolean, name: string): string => {
  const found = sourceExtensions.map((extension) => `${name}${extension}`).filter(exists)
  if (found.length !== 1) {
    throw new Error(`${name} needs one source module, found ${found.length === 0 ? "none" : found.join(" and ")}`)
  }
  return found[0]!
}

const sources: ReadonlyArray<string> = Fs.readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
  .filter(isSourceFile)
  .map((file) => Path.join(sourceRoot, file))
  .sort()
const read = (file: string): string => Fs.readFileSync(file, "utf8")
const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
const relative = (file: string): string => Path.relative(packageRoot, file)
const header = (file: string): string => /^\/\*\*([\s\S]*?)\*\//.exec(read(file))?.[1] ?? ""
const prose = (comment: string): string =>
  comment
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("@"))
    .join(" ")

const version = (text: string): ReadonlyArray<number> => text.split("-")[0]!.split(".").map(Number)
const compare = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number =>
  left.map((part, index) => part - right[index]!).find((difference) => difference !== 0) ?? 0

const barrelFile = Path.join(sourceRoot, sourceFile((file) => Fs.existsSync(Path.join(sourceRoot, file)), "index"))
const barrel = parse(barrelFile)
const modules: ReadonlyArray<{ readonly name: string; readonly file: string }> = barrel.statements.flatMap((
  statement
) =>
  ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamespaceExport(statement.exportClause)
    && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
    ? [{
      name: statement.exportClause.name.text,
      file: Path.join(sourceRoot, statement.moduleSpecifier.text)
    }]
    : []
)
const namespaces = Std as unknown as Readonly<Record<string, Readonly<Record<string, unknown>>>>

describe("the barrel header", () => {
  it("names the package it is the entry point of", () => {
    expect(prose(header(barrelFile))).toContain(`\`${manifest.name}\``)
  })
})

describe("module headers", () => {
  it("describe every public module in prose", () => {
    const silent = modules.filter((module) => prose(header(module.file)).length === 0).map((module) => module.name)
    expect(silent).toEqual([])
  })

  it("cite only documents that exist", () => {
    const dead = sources.flatMap((file) =>
      [...header(file).replace(/\n\s*\*\s?/g, " ").matchAll(/`([^`]+\.md)`/g)]
        .map((match) => match[1]!)
        .filter((cited) =>
          !Fs.existsSync(Path.join(packageRoot, cited)) && !Fs.existsSync(Path.join(repositoryRoot, cited))
        )
        .map((cited) => `${relative(file)}: ${cited}`)
    )
    expect(dead).toEqual([])
  })
})

describe("@since", () => {
  // The oldest release this package has is the last heading its changelog
  // records; the newest it can stamp is the version it is about to ship.
  const releases = [...Fs.readFileSync(Path.join(packageRoot, "CHANGELOG.md"), "utf8").matchAll(/^## \[(\d[^\]]*)\]/gm)]
  const first = version(releases.at(-1)![1]!)
  const current = version(manifest.version)

  it("names only a version between the first release and the one being shipped", () => {
    const stamps = sources.flatMap((file) =>
      [...read(file).matchAll(/@since (\S+?)(?:\s|\*\/)/g)].map((match) => ({ file: relative(file), since: match[1]! }))
    )
    expect(stamps.length).toBeGreaterThan(0)
    expect(stamps.filter(({ since }) => compare(version(since), first) < 0 || compare(version(since), current) > 0))
      .toEqual([])
  })
})

describe("tags", () => {
  it("key every service by the package name and the export that holds it", () => {
    const keys = Object.entries(namespaces).flatMap(([, members]) =>
      Object.entries(members).flatMap(([name, member]) =>
        Context.isKey(member) ? [{ key: member.key, expected: `${prefix}${name}` }] : []
      )
    )
    expect(keys.length).toBeGreaterThanOrEqual(6)
    expect(keys.filter(({ expected, key }) => key !== expected)).toEqual([])
  })

  it("tag the standard error with the package name", () => {
    expect(new Std.StdError.StdError({ code: "not_found", message: "missing" })._tag).toBe(`${prefix}StdError`)
  })

  it("identify every service, error and class in the source by the package name", () => {
    const identifiers = sources.flatMap((file) => {
      const found: Array<string> = []
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) && /^(Context\.Service|Schema\.\w*(Class|Error))\b/.test(node.expression.getText())
        ) {
          const first = node.arguments[0]
          if (first && ts.isStringLiteralLike(first)) found.push(first.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(parse(file))
      return found
    })
    expect(identifiers.length).toBeGreaterThanOrEqual(9)
    expect(identifiers.filter((identifier) => !identifier.startsWith(prefix))).toEqual([])
  })
})

describe("flow modules", () => {
  const flows = modules.filter((module) => "flow" in namespaces[module.name]!)

  it("are exactly the modules the manifest registers", () => {
    expect(flows).toHaveLength(Object.keys(Std.Manifest.flows).length)
  })

  it("export the decoded Input and Output types beside their schemas", () => {
    const missing = flows.flatMap((module) => {
      const aliases = new Map(
        parse(module.file).statements.flatMap((statement) =>
          ts.isTypeAliasDeclaration(statement)
            && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
            ? [[statement.name.text, statement.type.getText()] as const]
            : []
        )
      )
      return ["Input", "Output"]
        .filter((name) => aliases.get(name) !== `typeof ${name}.Type`)
        .map((name) => `${module.name}.${name}`)
    })
    expect(missing).toEqual([])
  })
})

describe("source modules", () => {
  it.each([
    ["a .ts module", ["M.ts"], "M.ts"],
    ["a .vibe module", ["M.vibe"], "M.vibe"]
  ])("finds %s", (_case, files, expected) => {
    expect(sourceFile((file) => files.includes(file), "M")).toBe(expected)
  })

  it.each([
    ["a missing module", ["Other.ts"], "none"],
    ["a module in both languages", ["M.ts", "M.vibe"], "M.ts and M.vibe"],
    ["a declaration sidecar only", ["M.d.vibe.ts"], "none"],
    ["a module in another language", ["M.js"], "none"]
  ])("refuses %s", (_case, files, found) => {
    expect(() => sourceFile((file) => files.includes(file), "M")).toThrow(`M needs one source module, found ${found}`)
  })

  it.each([
    ["M.ts", true],
    ["internal/M.vibe", true],
    ["M.d.vibe.ts", false],
    ["M.js", false],
    ["README.md", false]
  ])("reads %s as a source file: %s", (file, expected) => {
    expect(isSourceFile(file)).toBe(expected)
  })
})
