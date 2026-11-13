/**
 * Validates the SFT dataset before it is uploaded or trained on.
 *
 * The exit code is the verdict, so this runs as a `NodeTest` gate: it proves
 * every row is a well-formed OpenAI chat example before an irreversible
 * `firectl dataset create` ships it to Fireworks. `firectl` uploads each row
 * verbatim, so the gate also rejects anything that must not leave this machine:
 * top-level metadata beside `messages`, absolute host paths, and credential
 * shapes. Assistant code may only import public paths from current workspace
 * packages. It reads its dataset and workspace graph relative to this file,
 * independently of the runner's working directory.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"

const roles = new Set(["system", "user", "assistant", "tool"])
const messageKeys = new Set(["role", "content"])
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

interface WorkspacePackage {
  readonly directory: string
  readonly exports: unknown
}

interface ImportSpecifier {
  readonly text: string
  readonly require: boolean
  readonly typeOnly: boolean
}

/** Read the package names and public paths from the root's declared workspaces. */
const workspaceExports = (): ReadonlyMap<string, WorkspacePackage> => {
  const root = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")) as {
    workspaces: ReadonlyArray<string>
  }
  const packages = new Map<string, WorkspacePackage>()
  for (const pattern of root.workspaces) {
    const directories = pattern.endsWith("/*")
      ? readdirSync(join(workspaceRoot, pattern.slice(0, -2)), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${pattern.slice(0, -1)}${entry.name}`)
      : [pattern]
    for (const directory of directories) {
      const manifest = join(workspaceRoot, directory, "package.json")
      if (!existsSync(manifest)) continue
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string
        exports?: unknown
      }
      if (pkg.name) {
        packages.set(pkg.name, { directory: join(workspaceRoot, directory), exports: pkg.exports })
      }
    }
  }
  return packages
}

const publicPackages = workspaceExports()

/** Parse assistant TypeScript so comments and quoted examples are not imports. */
const importSpecifiers = (code: string): ReadonlyArray<ImportSpecifier> => {
  const source = ts.createSourceFile("assistant.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const specifiers: ImportSpecifier[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause
      const typeOnly = (ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly ?? false : node.isTypeOnly) ||
        ((!ts.isImportDeclaration(node) || node.importClause?.name === undefined) &&
          bindings !== undefined && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
          bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly))
      specifiers.push({ text: node.moduleSpecifier.text, require: false, typeOnly })
    } else if (
      ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push({ text: node.moduleReference.expression.text, require: true, typeOnly: node.isTypeOnly })
    } else if (
      ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push({ text: node.argument.literal.text, require: false, typeOnly: true })
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push({
        text: node.arguments[0].text,
        require: node.expression.kind !== ts.SyntaxKind.ImportKeyword,
        typeOnly: false
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

/** Choose the first active condition in manifest order, without loading code. */
const conditionalTarget = (target: unknown, conditions: ReadonlySet<string>): string | null | undefined => {
  if (typeof target === "string") {
    const segments = target.slice(2).split("/")
    return target.startsWith("./") &&
        segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." &&
          segment.toLowerCase() !== "node_modules")
      ? target
      : null
  }
  if (target === null) return null
  if (Array.isArray(target)) {
    let fallback: null | undefined = target.length === 0 ? null : undefined
    for (const entry of target) {
      const selected = conditionalTarget(entry, conditions)
      if (selected != null) return selected
      if (selected === null) fallback = null
    }
    return fallback
  } else if (isRecord(target)) {
    for (const [condition, entry] of Object.entries(target)) {
      if (!conditions.has(condition)) continue
      const selected = conditionalTarget(entry, conditions)
      if (selected !== undefined) return selected
    }
    return undefined
  }
  return null
}

const isExposed = (pkg: WorkspacePackage, subpath: string, specifier: ImportSpecifier): boolean => {
  if (pkg.exports === undefined) {
    try {
      // Legacy packages have no export-map encapsulation; Node resolves main or index.
      return statSync(createRequire(join(pkg.directory, "package.json")).resolve(resolve(pkg.directory, subpath))).isFile()
    } catch {
      return false
    }
  }
  const exports = isRecord(pkg.exports) && Object.keys(pkg.exports).some((key) => key.startsWith("."))
    ? pkg.exports
    : { ".": pkg.exports }
  let target = exports[subpath]
  let capture: string | undefined
  if (!Object.hasOwn(exports, subpath)) {
    const wildcard = Object.keys(exports)
      .filter((key) => {
        const star = key.indexOf("*")
        return star >= 0 && subpath.length >= key.length &&
          subpath.startsWith(key.slice(0, star)) && subpath.endsWith(key.slice(star + 1))
      })
      .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length)[0]
    if (wildcard === undefined) return false
    const star = wildcard.indexOf("*")
    const suffix = wildcard.length - star - 1
    capture = subpath.slice(star, suffix === 0 ? undefined : -suffix)
    target = exports[wildcard]
  }
  const conditions = new Set(["node", "default", specifier.require ? "require" : "import"])
  if (specifier.typeOnly) conditions.add("types")
  const selected = conditionalTarget(target, conditions)
  if (selected == null || !selected.startsWith("./")) return false
  const file = resolve(pkg.directory, capture === undefined ? selected : selected.split("*").join(capture))
  return file.startsWith(pkg.directory + sep) && (statSync(file, { throwIfNoEntry: false })?.isFile() ?? false)
}

const workspaceImportProblem = (specifier: ImportSpecifier): string | undefined => {
  if (!specifier.text.startsWith("@smthrs/")) return undefined
  const parts = specifier.text.split("/")
  const name = parts.slice(0, 2).join("/")
  const pkg = publicPackages.get(name)
  if (!pkg) return `imports ${JSON.stringify(specifier.text)} from a missing workspace package`
  const subpath = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`
  if (!isExposed(pkg, subpath, specifier)) return `imports unpublished path ${JSON.stringify(specifier.text)}`
  return undefined
}

/**
 * Content that must never reach the training corpus: a home directory reveals
 * the maintainer's username and layout, and a credential shape is a leaked key.
 */
const forbidden: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  {
    label: "absolute host path",
    pattern: /(?:\/(?:Users|home)\/[A-Za-z0-9._-]+|\b[A-Za-z]:\\Users\\[A-Za-z0-9._-]+|(?:^|[\s"'`(=:])~[A-Za-z0-9._-]*\/)/
  },
  { label: "Fireworks API key", pattern: /\bfw_[A-Za-z0-9]{16,}/ },
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "JSON Web Token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/ }
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validateRow = (parsed: unknown, row: number): ReadonlyArray<string> => {
  if (!isRecord(parsed)) {
    return [`row ${row}: not a JSON object`]
  }
  const problems: string[] = []
  const extraKeys = Object.keys(parsed).filter((key) => key !== "messages")
  if (extraKeys.length > 0) {
    problems.push(`row ${row}: ${extraKeys.length} unexpected top-level key(s); only "messages" is allowed`)
  }

  const messages = parsed.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    problems.push(`row ${row}: missing a non-empty "messages" array`)
    return problems
  }

  messages.forEach((message: unknown, messageIndex) => {
    const at = `row ${row}, message ${messageIndex + 1}`
    if (!isRecord(message)) {
      problems.push(`${at}: not a JSON object`)
      return
    }
    const extraMessageKeys = Object.keys(message).filter((key) => !messageKeys.has(key))
    if (extraMessageKeys.length > 0) {
      problems.push(`${at}: ${extraMessageKeys.length} unexpected key(s); only "role" and "content" are allowed`)
    }
    if (typeof message.role !== "string" || !roles.has(message.role)) {
      problems.push(`${at}: role is not one of ${[...roles].join(", ")}`)
    }
    if (typeof message.content !== "string" || message.content.trim().length === 0) {
      problems.push(`${at}: content is empty or not a string`)
      return
    }
    for (const { label, pattern } of forbidden) {
      if (pattern.test(message.content)) problems.push(`${at}: content contains ${label}`)
    }
    if (message.role === "assistant") {
      for (const specifier of importSpecifiers(message.content)) {
        const problem = workspaceImportProblem(specifier)
        if (problem) problems.push(`${at}: ${problem}`)
      }
    }
  })

  const lastIndex = messages.length - 1
  const last: unknown = messages[lastIndex]
  if (!isRecord(last) || last.role !== "assistant") {
    problems.push(`row ${row}: last message is not an "assistant" turn`)
  }
  const userBeforeLast = messages.slice(0, lastIndex).some((message: unknown) => isRecord(message) && message.role === "user")
  if (!userBeforeLast) {
    problems.push(`row ${row}: no "user" turn before the final assistant turn`)
  }
  return problems
}

/**
 * Returns every problem in a JSONL dataset; an empty list means it may ship.
 * A problem names its row, message, and rule but never quotes row text, keys,
 * or values: the CLI prints each one, and a rejected row may hold a credential.
 */
export const validateDataset = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    return ["dataset is empty"]
  }
  return lines.flatMap((line, index) => {
    const row = index + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return [`row ${row}: not valid JSON`]
    }
    return validateRow(parsed, row)
  })
}

if (import.meta.main) {
  const datasetPath = fileURLToPath(new URL("./data/pilot-sft.jsonl", import.meta.url))
  const text = readFileSync(datasetPath, "utf8")
  const problems = validateDataset(text)
  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} problem(s) in ${datasetPath}`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  const rows = text.split("\n").filter((line) => line.trim().length > 0).length
  console.log(`OK: ${rows} row(s) valid in ${datasetPath}`)
}
