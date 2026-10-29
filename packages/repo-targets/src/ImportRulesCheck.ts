/**
 * The rules an `ImportRules` declaration holds a package to, and the check that
 * runs them.
 *
 * `ImportRules` (the macro) declares the target; this module is what the
 * target runs, through `scripts/import-rules.mjs`, in the declaring package's
 * directory. It reads every source the rules cover once with
 * {@link ImportAnalysis.analyze} and reports each violation with its file and
 * line and the rule's `because`.
 *
 * Node loads this module directly through type stripping, so it uses only
 * erasable TypeScript and imports nothing but `typescript` (through the
 * analysis) and Node built-ins.
 *
 * @since 0.1.0
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { isBuiltin } from "node:module"
import { join, matchesGlob } from "node:path"
import * as ImportAnalysis from "./ImportAnalysis.ts"

/**
 * What every rule kind declares.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuleScope {
  /**
   * Package-relative globs of the sources the rule reads, matched with
   * `node:path` `matchesGlob`: `*` stops at `/` and `**` crosses it, so
   * `src/**\/*.tsx` is every `.tsx` file under `src/`.
   * A rule must match at least one source; an empty scope throws with the
   * rule's index, kind, patterns and reason before any source is analyzed.
   *
   * @default every source file in the package
   */
  readonly files?: ReadonlyArray<string> | undefined
  /**
   * Why the rule holds, naming the `AGENTS.md` rule that governs it. Every
   * violation prints it.
   */
  readonly because: string
}

/**
 * Whether a type-only reference escapes a rule. Only the import rule kinds
 * take it; a call is never type-only.
 *
 * @category models
 * @since 0.1.0
 */
export interface TypeOnlyOption {
  /**
   * Allow a reference that loads nothing at runtime: `import type`,
   * `export type`, a `type` modifier on a named element, or an `import()`
   * type. A declaration whose elements all carry `type` modifiers still
   * counts as a module import.
   *
   * @default false
   */
  readonly allowTypeOnly?: boolean | undefined
}

/**
 * Forbids importing modules.
 *
 * @category models
 * @since 0.1.0
 */
export interface ForbidRule extends RuleScope, TypeOnlyOption {
  readonly kind: "forbid"
  /** Module specifier globs: `effect` is the root, `effect/*` one level below it, `effect/**` every subpath. */
  readonly modules: ReadonlyArray<string>
}

/**
 * Forbids taking names from modules: a named import, a re-export, a default
 * import (`default`), or a member read through a namespace or default binding
 * (`React.useState`).
 *
 * @category models
 * @since 0.1.0
 */
export interface ForbidNamesRule extends RuleScope, TypeOnlyOption {
  readonly kind: "forbidNames"
  /** Module specifier globs the names come from. */
  readonly modules: ReadonlyArray<string>
  /** Exported names, matched exactly. */
  readonly names: ReadonlyArray<string>
}

/**
 * Forbids a deep import of a package: a specifier that names a subpath of a
 * package whose name matches.
 *
 * @category models
 * @since 0.1.0
 */
export interface RootImportsOnlyRule extends RuleScope, TypeOnlyOption {
  readonly kind: "rootImportsOnly"
  /** Package-name globs, such as `@smthrs/*` or `effect`. */
  readonly packages: ReadonlyArray<string>
}

/**
 * Forbids calls by the callee's text, such as `Model.stream`, or by the
 * callee's final member name, such as `*.route`.
 *
 * The match is syntactic. `Model.stream` sees `Model.stream(request)` and not
 * `const model = yield* Model.Model; model.stream(request)`, nor a callee
 * reached through destructuring, an alias or a parameter. `*.route` sees every
 * call of a `route` member whatever its receiver, including one reached
 * through a variable, an alias or a parameter; only destructuring escapes it.
 *
 * @category models
 * @since 0.1.0
 */
export interface ForbidCallsRule extends RuleScope {
  readonly kind: "forbidCalls"
  /**
   * Callees, each one of:
   *
   * - a callee's text, such as `Model.stream` or `page.context().route`,
   *   matched exactly against {@link ImportAnalysis.Call.callee}, so
   *   `page.route` does not match `tab.page.route`;
   * - `*.<member>`, such as `*.route`, matching every call whose callee ends
   *   in that member, whatever the receiver: `page.route(...)`,
   *   `tab.page.route(...)`, `page.context().route(...)`, `page?.route(...)`
   *   and `page["route"](...)`, but not `router.routes()`, `reroute()` or a
   *   bare `route()`.
   *
   * A `*` anywhere else is refused.
   */
  readonly callees: ReadonlyArray<string>
}

/**
 * Forbids Node builtins (including bare names) and Node/Bun module schemes.
 *
 * @category models
 * @since 0.1.0
 */
export interface ForbidHostModulesRule extends RuleScope, TypeOnlyOption {
  readonly kind: "forbidHostModules"
}

/**
 * One rule of an `ImportRules` declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type ImportRule = ForbidHostModulesRule | ForbidRule | ForbidNamesRule | RootImportsOnlyRule | ForbidCallsRule

/**
 * One source that breaks one rule.
 *
 * @category models
 * @since 0.1.0
 */
export interface Violation {
  /** The package-relative path of the source. */
  readonly file: string
  readonly line: number
  /** The rule's index in the declaration. */
  readonly rule: number
  readonly kind: ImportRule["kind"]
  /** What the source does, such as `imports "effect"`. */
  readonly usage: string
  readonly because: string
}

/**
 * One source to check: its package-relative path and its text.
 *
 * @category models
 * @since 0.1.0
 */
export interface Source {
  readonly path: string
  readonly text: string
}

/**
 * The file extensions a source has: TypeScript's and JavaScript's, and
 * VibeLang's `.vibe`, whose import syntax is TypeScript's.
 *
 * @category constants
 * @since 0.1.0
 */
export const sourceExtensions: ReadonlyArray<string> = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vibe"
]

/**
 * Directories never read: dependencies, build and test output, and every
 * dot-directory (tool state such as `.alchemy` or `.wrangler`).
 */
const skippedDirectories = new Set(["node_modules", "dist", "coverage", "target", "tmp", "test-results", "playwright-report"])

const kinds = ["forbid", "forbidNames", "rootImportsOnly", "forbidCalls", "forbidHostModules"] as const

/** The keys each rule kind accepts, beyond `kind`, `because` and `files`. */
const kindKeys: Readonly<Record<ImportRule["kind"], ReadonlyArray<string>>> = {
  forbid: ["modules", "allowTypeOnly"],
  forbidHostModules: ["allowTypeOnly"],
  forbidNames: ["modules", "names", "allowTypeOnly"],
  rootImportsOnly: ["packages", "allowTypeOnly"],
  forbidCalls: ["callees"]
}

/** The non-empty string list a rule names at `key`, or a reason it is not one. */
const stringList = (rule: Record<string, unknown>, key: string): ReadonlyArray<string> | string => {
  const value = rule[key]
  if (!Array.isArray(value) || value.length === 0) return `\`${key}\` must be a non-empty array of strings`
  if (!value.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    return `\`${key}\` must hold only non-empty strings`
  }
  return value as ReadonlyArray<string>
}

/** A `forbidCalls` entry that names a member whatever its receiver: `*.route`, `*.#send`. */
const memberPattern = /^\*\.#?[A-Za-z_$][\w$]*$/

/** A package-relative glob, or a reason it is not one. */
const packageRelative = (glob: string): string | undefined =>
  glob.startsWith("/") || glob.split("/").includes("..") ? `files glob "${glob}" must be package-relative` : undefined

/**
 * Checks a declaration's rules and returns them, or throws a `TypeError`
 * naming the first rule that is not one and why.
 *
 * Unknown keys are refused, so a misspelled `module` for `modules` fails at
 * declaration instead of matching nothing.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateRules = (rules: unknown): ReadonlyArray<ImportRule> => {
  if (!Array.isArray(rules) || rules.length === 0) throw new TypeError("ImportRules needs a non-empty array of rules")
  rules.forEach((candidate: unknown, index) => {
    const refuse = (reason: string): never => {
      throw new TypeError(`ImportRules rule ${index}: ${reason}`)
    }
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) refuse("must be an object")
    const rule = candidate as Record<string, unknown>
    const kind = rule["kind"]
    if (!kinds.includes(kind as ImportRule["kind"])) refuse(`\`kind\` must be one of ${kinds.join(", ")}`)
    const allowed = new Set(["kind", "because", "files", ...kindKeys[kind as ImportRule["kind"]]])
    const unknown = Object.keys(rule).filter((key) => !allowed.has(key))
    if (unknown.length > 0) refuse(`${kind as string} does not take ${unknown.map((key) => `\`${key}\``).join(", ")}`)
    if (typeof rule["because"] !== "string" || rule["because"].trim() === "") {
      refuse("`because` must say why, naming the AGENTS.md rule that governs it")
    }
    if (rule["files"] !== undefined) {
      const files = stringList(rule, "files")
      if (typeof files === "string") refuse(files)
      for (const glob of files as ReadonlyArray<string>) {
        const reason = packageRelative(glob)
        if (reason !== undefined) refuse(reason)
      }
    }
    for (const key of kindKeys[kind as ImportRule["kind"]]) {
      if (key === "allowTypeOnly") {
        if (rule[key] !== undefined && typeof rule[key] !== "boolean") refuse("`allowTypeOnly` must be a boolean")
        continue
      }
      const list = stringList(rule, key)
      if (typeof list === "string") refuse(list)
      if (key !== "callees") continue
      const pattern = (list as ReadonlyArray<string>).find((entry) => entry.includes("*") && !memberPattern.test(entry))
      if (pattern !== undefined) refuse(`\`callees\` entry "${pattern}" must be a callee or \`*.<member>\``)
    }
  })
  return rules as ReadonlyArray<ImportRule>
}

/**
 * Lists a package's sources, package-relative with `/`, sorted.
 *
 * Every file with a {@link sourceExtensions} extension counts, except under
 * `node_modules`, build and test output, a dot-directory, or a nested
 * directory holding its own `package.json` (another package). Symbolic links
 * are not followed.
 *
 * @category files
 * @since 0.1.0
 */
export const listSources = (packageDirectory: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(packageDirectory, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue
        const nested = lstatSync(join(packageDirectory, path, "package.json"), { throwIfNoEntry: false })
        if (nested?.isFile() === true) continue
        walk(path)
      } else if (entry.isFile() && sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(path)
      }
    }
  }
  walk("")
  return found.sort()
}

/** The npm package a bare specifier names, or undefined for a relative, absolute or scheme specifier. */
const packageName = (specifier: string): string | undefined => {
  if (/^[./#~]/.test(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return undefined
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

const verb = (reference: ImportAnalysis.ModuleReference): string =>
  reference.form === "export" ? "re-exports" : "imports"

const matchesAny = (value: string, globs: ReadonlyArray<string>): boolean =>
  globs.some((glob) => matchesGlob(value, glob))

/**
 * Whether a `forbidCalls` entry names a callee: `*.<member>` names every callee
 * ending in `.<member>`, and any other entry only its own text. A callee's last
 * step reads `.<name>` or `["<key>"]`, so an identifier after `*.` never
 * matches part of a name.
 */
const namesCallee = (entry: string, callee: string): boolean =>
  entry.startsWith("*.") ? callee.endsWith(entry.slice(1)) : callee === entry

/** The usage text and line of every way one analysis breaks one rule. */
const breaches = (
  rule: ImportRule,
  analysis: ImportAnalysis.Analysis
): ReadonlyArray<{ readonly line: number; readonly usage: string }> => {
  if (rule.kind === "forbidCalls") {
    return analysis.calls
      .filter((call) => rule.callees.some((entry) => namesCallee(entry, call.callee)))
      .map((call) => ({ line: call.line, usage: `calls ${call.callee}` }))
  }
  const allowTypeOnly = rule.allowTypeOnly === true
  const found: Array<{ readonly line: number; readonly usage: string }> = []
  for (const reference of analysis.references) {
    const { specifier } = reference
    if (rule.kind === "forbidNames") {
      if (!matchesAny(specifier, rule.modules)) continue
      for (const name of reference.names) {
        if (rule.names.includes(name.name) && !(allowTypeOnly && name.typeOnly)) {
          found.push({ line: name.line, usage: `${verb(reference)} ${name.name} from "${specifier}"` })
        }
      }
      for (const name of reference.members) {
        if (rule.names.includes(name.name) && !(allowTypeOnly && name.typeOnly)) {
          found.push({ line: name.line, usage: `uses ${name.binding}.${name.name} from "${specifier}"` })
        }
      }
      continue
    }
    if (allowTypeOnly && reference.typeOnly) continue
    if (rule.kind === "forbidHostModules") {
      if (specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier === "bun" || isBuiltin(specifier)) {
        found.push({ line: reference.line, usage: `${verb(reference)} "${specifier}"` })
      }
      continue
    }
    if (rule.kind === "forbid") {
      if (matchesAny(specifier, rule.modules)) found.push({ line: reference.line, usage: `${verb(reference)} "${specifier}"` })
      continue
    }
    const name = packageName(specifier)
    if (name !== undefined && name !== specifier && matchesAny(name, rule.packages)) {
      found.push({ line: reference.line, usage: `${verb(reference)} "${specifier}", not the root "${name}"` })
    }
  }
  return found
}

/**
 * Every violation of `rules` in `sources`, by file, then line, then rule.
 *
 * Each source is parsed at most once, and only when a rule reads it.
 * Throws before parsing if any rule covers no source, naming every empty
 * rule and its patterns. An omitted `files` means `**\/*` for this report.
 *
 * @category check
 * @since 0.1.0
 */
export const check = (rules: ReadonlyArray<ImportRule>, sources: ReadonlyArray<Source>): ReadonlyArray<Violation> => {
  const scopes = rules.map((rule, index) => ({
    rule,
    index,
    sources: rule.files === undefined ? sources : sources.filter((source) => matchesAny(source.path, rule.files!))
  }))
  const empty = scopes.filter((scope) => scope.sources.length === 0).map(({ rule, index }) =>
    `ImportRules rule ${index} (${rule.kind}) matches no source files; files: ${JSON.stringify(rule.files ?? ["**/*"])}. ${rule.because}`
  )
  if (empty.length > 0) throw new Error(empty.join("\n"))
  const analyses = new Map<string, ImportAnalysis.Analysis>()
  const violations: Array<Violation> = []
  scopes.forEach(({ rule, index, sources: scoped }) => {
    for (const source of scoped) {
      let analysis = analyses.get(source.path)
      if (analysis === undefined) {
        analysis = ImportAnalysis.analyze(source.path, source.text)
        analyses.set(source.path, analysis)
      }
      for (const { line, usage } of breaches(rule, analysis)) {
        violations.push({ file: source.path, line, rule: index, kind: rule.kind, usage, because: rule.because })
      }
    }
  })
  return violations.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.rule - b.rule
  )
}

/**
 * One line of the report for a violation:
 * `- <package>/<file>:<line> <usage> (<kind>). <because>`.
 *
 * @category report
 * @since 0.1.0
 */
export const formatViolation = (packageDirectory: string, violation: Violation): string =>
  `- ${packageDirectory}/${violation.file}:${violation.line} ${violation.usage} (${violation.kind}). ${violation.because}`

/**
 * What a run reports, and the exit code it ends with.
 *
 * @category models
 * @since 0.1.0
 */
export interface Outcome {
  readonly exitCode: 0 | 1
  readonly output: string
}

/**
 * Checks one package's sources against its declared rules.
 *
 * `directory` is where the package's files are read; `packageDirectory` is
 * its workspace-relative path, which the report prefixes to every file.
 * Invalid rules throw, as {@link validateRules} does.
 *
 * @category check
 * @since 0.1.0
 */
export const run = (options: {
  readonly packageDirectory: string
  readonly directory: string
  readonly rules: unknown
}): Outcome => {
  const rules = validateRules(options.rules)
  const paths = listSources(options.directory)
  const violations = check(
    rules,
    paths.map((path) => ({ path, text: readFileSync(join(options.directory, path), "utf8") }))
  )
  const scope = `${rules.length} rule${rules.length === 1 ? "" : "s"} over ${paths.length} source file${
    paths.length === 1 ? "" : "s"
  }`
  if (violations.length === 0) return { exitCode: 0, output: `ImportRules passed in ${options.packageDirectory}: ${scope}.` }
  return {
    exitCode: 1,
    output: [
      `ImportRules failed in ${options.packageDirectory}: ${violations.length} violation${
        violations.length === 1 ? "" : "s"
      } of ${scope}.`,
      "",
      ...violations.map((violation) => formatViolation(options.packageDirectory, violation))
    ].join("\n")
  }
}
