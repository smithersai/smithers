/**
 * Reads a Makefile: each rule with a plain name is a job and each recipe line
 * a step. `ci: lint test` is a job that needs `lint`, then `test`.
 *
 * Only what the file states is read, with the meaning GNU Make gives it. What
 * Make would have to evaluate, such as a function or an included file, is
 * reported on every job it can reach and never guessed.
 *
 * Contract 4 runs a step with `bash -e -c`, and Make runs a line with
 * `sh -c`, so a line the two shells could read differently names its shell.
 *
 * @since 0.1.0
 */

import type { Unsupported } from "../contract/Inventory.ts"
import { addStep, type Draft, draft, note, type Parsed } from "./Draft.ts"
import { isLiteralSecret } from "./Secrets.ts"
import { shellQuote, shellWord } from "./Values.ts"

const source = "makefile"
const jobId = (name: string): string => `makefile:${name}`

/** Why something cannot be stated: an `Unsupported.feature` and the end of a sentence about it. */
interface Problem {
  readonly feature: string
  readonly reason: string
}

interface Variable {
  readonly text: string
  /** Expanded again at each use, as `=` and `?=` make it. */
  readonly recursive: boolean
  /** Why its value is not known. Empty when it is. */
  readonly problems: ReadonlyArray<Problem>
}

interface RecipeLine {
  readonly text: string
  readonly number: number
}

interface Rule {
  readonly name: string
  prerequisites: ReadonlyArray<string>
  orderOnly: ReadonlyArray<string>
  /** `undefined` when no rule for this name has a recipe, which is when Make looks for an implicit one. */
  recipe: ReadonlyArray<RecipeLine> | undefined
  readonly problems: Array<Problem>
}

/** The rule header being read: the recipe lines after it belong to each of its rules. */
interface Header {
  readonly rules: ReadonlyArray<Rule>
  readonly prerequisites: ReadonlyArray<string>
  readonly orderOnly: ReadonlyArray<string>
  readonly lines: Array<RecipeLine>
  started: boolean
}

interface Makefile {
  readonly variables: Map<string, Variable>
  readonly rules: Map<string, Rule>
  readonly phony: Set<string>
  /** The target side of every pattern and suffix rule. */
  readonly patterns: Array<string>
  readonly exported: Set<string>
  readonly unexported: Set<string>
  /** Names given a variable of their own, which their prerequisites inherit. */
  readonly scoped: Set<string>
  /** What makes every job of the file impossible to state. */
  readonly blockers: Array<Problem>
  exportAll: boolean
  oneShell: boolean
  posix: boolean
}

interface Scope {
  readonly variables: ReadonlyMap<string, Variable>
  readonly automatic: ReadonlyMap<string, string>
  readonly active: Set<string>
  readonly problems: Array<Problem>
}

const scopeOf = (
  variables: ReadonlyMap<string, Variable>,
  automatic: ReadonlyMap<string, string> = new Map()
): Scope => ({ variables, automatic, active: new Set(), problems: [] })

const fail = (scope: Scope, feature: string, reason: string): string => {
  scope.problems.push({ feature, reason })
  return ""
}

/** The index of the bracket closing the one at `open`, or -1. Make counts only brackets of the same kind. */
const referenceEnd = (text: string, open: number): number => {
  const opener = text.charAt(open)
  const closer = opener === "(" ? ")" : "}"
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text.charAt(index)
    if (char === opener) depth++
    else if (char === closer && --depth === 0) return index
  }
  return -1
}

/** The last index of the reference starting at the `$` at `dollar`. */
const referenceLast = (text: string, dollar: number): number => {
  const next = text.charAt(dollar + 1)
  if (next !== "(" && next !== "{") return dollar + 1
  const end = referenceEnd(text, dollar + 1)
  return end === -1 ? text.length : end
}

/** The first of `stops` outside any variable reference, or -1. */
const topLevel = (text: string, stops: string): number => {
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index)
    if (char === "$") index = referenceLast(text, index)
    else if (stops.includes(char)) return index
  }
  return -1
}

const reference = (scope: Scope, raw: string): string => {
  const stop = raw.search(/[\s,$]/)
  if (stop !== -1 && raw.charAt(stop) !== "$") {
    return fail(scope, "function", `calls the Make function ${raw.slice(0, stop)}`)
  }
  const name = stop === -1 ? raw : expand(scope, raw)
  if (/:.*=/.test(name)) return fail(scope, "substitution", `rewrites a value with $(${name})`)
  const automatic = scope.automatic.get(name)
  if (automatic !== undefined) return automatic
  if (/^[@<^+|*?%][DF]?$/.test(name)) return fail(scope, "automatic-variable", `reads $${name}`)
  const variable = scope.variables.get(name)
  if (variable === undefined) {
    return name === "MAKE" ? "make" : fail(scope, "variable", `reads ${name}, which the file does not set`)
  }
  scope.problems.push(...variable.problems)
  if (scope.active.has(name)) return fail(scope, "variable", `reads ${name}, which refers to itself`)
  scope.active.add(name)
  const value = variable.recursive ? expand(scope, variable.text) : variable.text
  scope.active.delete(name)
  return isLiteralSecret(name, value) ? fail(scope, "secret-value", `reads ${name}, which holds a secret`) : value
}

/** Expands `text` as Make does. What cannot be expanded is added to the scope's problems. */
const expand = (scope: Scope, text: string): string => {
  let result = ""
  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)
    const next = text.charAt(index + 1)
    if (char !== "$" || next === "") {
      result += char
      index++
    } else if (next === "$") {
      result += "$"
      index += 2
    } else if (next === "(" || next === "{") {
      const end = referenceEnd(text, index + 1)
      if (end === -1) {
        fail(scope, "syntax", "has a variable reference with no end")
        return result
      }
      result += reference(scope, text.slice(index + 2, end))
      index = end + 1
    } else {
      result += reference(scope, next)
      index += 2
    }
  }
  return result
}

const words = (text: string): ReadonlyArray<string> => text.split(/\s+/).filter((word) => word !== "")

/** True when the line ends in an odd number of backslashes, which continues it. */
const continues = (line: string): boolean => /(?:^|[^\\])(?:\\\\)*\\$/.test(line)

/** The line up to its comment, with `\#` read as `#`. */
const withoutComment = (line: string): string => {
  let result = ""
  for (let index = 0; index < line.length; index++) {
    const char = line.charAt(index)
    if (char === "#") return result
    if (char === "$") {
      const last = referenceLast(line, index)
      result += line.slice(index, last + 1)
      index = last
    } else if (char === "\\" && line.charAt(index + 1) === "#") {
      result += "#"
      index++
    } else {
      result += char
    }
  }
  return result
}

/**
 * What follows a directive word, or `undefined` when the text is not that directive. The end of the
 * line is kept: it is part of a value assigned there.
 */
const directive = (text: string, word: string): string | undefined => {
  if (!text.startsWith(word)) return undefined
  const rest = text.slice(word.length)
  if (rest !== "" && !/^\s/.test(rest)) return undefined
  const value = rest.trimStart()
  return /^(?::|=|\+=|\?=|!=)/.test(value) ? undefined : value
}

/** Variables that change how Make itself runs. */
const makeSettings = new Set([
  ".EXTRA_PREREQS",
  ".LIBPATTERNS",
  ".RECIPEPREFIX",
  "GNUMAKEFLAGS",
  "MAKEFILES",
  "MAKEFLAGS",
  "MAKEOVERRIDES",
  "MAKESHELL",
  "MFLAGS",
  "VPATH"
])

/** Special targets that leave what a recipe runs as it is. */
const harmlessSpecial = new Set([
  ".DELETE_ON_ERROR",
  ".INTERMEDIATE",
  ".LOW_RESOLUTION_TIME",
  ".NOTINTERMEDIATE",
  ".NOTPARALLEL",
  ".PRECIOUS",
  ".SECONDARY",
  ".SILENT"
])

/** Special targets whose effect is not stated in the commands. */
const blockingSpecial = new Map([
  [".DEFAULT", "default-rule"],
  [".IGNORE", "ignored-failure"],
  [".SECONDEXPANSION", "second-expansion"]
])

/** The suffixes Make knows, which make `.c.o` a rule and not a file. */
const knownSuffixes = new Set(
  (".out .a .ln .o .c .cc .C .cpp .p .f .F .m .r .y .l .ym .yl .s .S .mod .sym .def .h .info .dvi .tex .texinfo .texi "
    + ".txinfo .w .ch .web .sh .elc .el").split(" ")
)

/** What Make's built-in rules build from, directly or through another built-in rule. */
const builtinSources = (".o .c .cc .C .cpp .p .f .F .m .r .s .S .mod .sh .y .l .w .web .ym .def .tex .texinfo .texi "
  + ".txinfo").split(" ")

/** The suffixes Make's built-in rules build. */
const builtinResults = new Set(".o .c .ln .f .r .m .s .sym .dvi .info .tex .p .out".split(" "))

const block = (makefile: Makefile, feature: string, reason: string): void => {
  if (!makefile.blockers.some((entry) => entry.feature === feature && entry.reason === reason)) {
    makefile.blockers.push({ feature, reason })
  }
}

const blockAll = (makefile: Makefile, scope: Scope, number: number): void => {
  for (const problem of scope.problems) block(makefile, problem.feature, `line ${number} ${problem.reason}`)
}

const assign = (makefile: Makefile, name: string, operator: string, value: string): void => {
  const { variables } = makefile
  const existing = variables.get(name)
  const immediate = (): Variable => {
    const scope = scopeOf(variables)
    return { text: expand(scope, value), recursive: false, problems: scope.problems }
  }
  if (makeSettings.has(name)) block(makefile, "make-setting", `sets ${name}, which changes how Make runs`)
  if (operator === "!=") {
    const reason = `reads ${name}, which comes from a shell command`
    variables.set(name, { text: "", recursive: false, problems: [{ feature: "function", reason }] })
  } else if (operator === "+=" && existing !== undefined) {
    const added = existing.recursive ? { text: value, problems: [] } : immediate()
    const text = existing.text === "" ? added.text : `${existing.text} ${added.text}`
    variables.set(name, { text, recursive: existing.recursive, problems: [...existing.problems, ...added.problems] })
  } else if (operator === ":=" || operator === "::=" || operator === ":::=") {
    variables.set(name, immediate())
  } else if (operator !== "?=" || existing === undefined) {
    variables.set(name, { text: value, recursive: true, problems: [] })
  }
}

interface Assignment {
  readonly name: string
  readonly operator: string
  readonly value: string
}

/** The assignment a line states, or `undefined` when it states none. */
const readAssignment = (text: string): Assignment | undefined => {
  const at = topLevel(text, ":=")
  if (at === -1) return undefined
  const operator = text.charAt(at) === "="
    ? (/[?+!]/.test(text.charAt(at - 1)) ? `${text.charAt(at - 1)}=` : "=")
    : /^:{1,3}=/.exec(text.slice(at))?.[0]
  if (operator === undefined) return undefined
  const end = operator.startsWith(":") || operator === "=" ? at : at - 1
  const name = text.slice(0, end).trim()
  if (name === "" || /\s/.test(name)) return undefined
  return { name, operator, value: text.slice(at + (operator.startsWith(":") ? operator.length : 1)).trimStart() }
}

const unknownVariable = (name: string, feature: string, cause: string): Variable => ({
  text: "",
  recursive: false,
  problems: [{ feature, reason: `reads ${name}, which ${cause}` }]
})

const readExport = (makefile: Makefile, rest: string, number: number): void => {
  const assignment = readAssignment(rest)
  if (assignment !== undefined) {
    applyAssignment(makefile, assignment, number)
    makefile.exported.add(assignment.name)
  } else if (rest.trim() === "") {
    makefile.exportAll = true
  } else {
    const scope = scopeOf(makefile.variables)
    for (const name of words(expand(scope, rest))) makefile.exported.add(name)
    blockAll(makefile, scope, number)
  }
}

const readUnexport = (makefile: Makefile, rest: string, number: number): void => {
  if (rest.trim() === "") {
    makefile.exportAll = false
    return
  }
  const scope = scopeOf(makefile.variables)
  for (const name of words(expand(scope, rest))) {
    makefile.exported.delete(name)
    makefile.unexported.add(name)
  }
  blockAll(makefile, scope, number)
}

const applyAssignment = (makefile: Makefile, assignment: Assignment, number: number): void => {
  if (assignment.name.includes("$")) {
    block(makefile, "computed-name", `line ${number} sets a variable whose name is computed`)
  } else {
    assign(makefile, assignment.name, assignment.operator, assignment.value)
  }
}

const ruleFor = (makefile: Makefile, name: string): Rule => {
  const existing = makefile.rules.get(name)
  if (existing !== undefined) return existing
  const rule: Rule = { name, prerequisites: [], orderOnly: [], recipe: undefined, problems: [] }
  makefile.rules.set(name, rule)
  return rule
}

/** Applies a special target. True when the name is one and needs no rule of its own. */
const readSpecial = (makefile: Makefile, name: string, prerequisites: ReadonlyArray<string>, number: number) => {
  const blocking = blockingSpecial.get(name)
  if (blocking !== undefined) block(makefile, blocking, `line ${number} uses ${name}`)
  else if (name === ".PHONY") prerequisites.forEach((target) => makefile.phony.add(target))
  else if (name === ".ONESHELL") makefile.oneShell = true
  else if (name === ".POSIX") makefile.posix = true
  else if (name === ".EXPORT_ALL_VARIABLES") makefile.exportAll = true
  else if (name === ".SUFFIXES") {
    if (prerequisites.length > 0) block(makefile, "suffix-rule", `line ${number} adds suffixes`)
  } else return harmlessSpecial.has(name)
  return true
}

/** The target side of the pattern a suffix rule states, or `undefined` when the name is no suffix rule. */
const suffixPattern = (name: string, prerequisites: ReadonlyArray<string>): string | undefined => {
  if (prerequisites.length > 0) return undefined
  if (knownSuffixes.has(name)) return "%"
  const split = name.indexOf(".", 1)
  const isPair = split !== -1 && knownSuffixes.has(name.slice(0, split)) && knownSuffixes.has(name.slice(split))
  return isPair ? `%${name.slice(split)}` : undefined
}

const emptyHeader = (): Header => ({ rules: [], prerequisites: [], orderOnly: [], lines: [], started: false })

/** Starts the recipe of a header. Make puts the prerequisites of the rule with the recipe first. */
const startRecipe = (header: Header): void => {
  if (header.started) return
  header.started = true
  for (const rule of header.rules) {
    const earlier = rule.prerequisites.slice(0, rule.prerequisites.length - header.prerequisites.length)
    const earlierOrder = rule.orderOnly.slice(0, rule.orderOnly.length - header.orderOnly.length)
    rule.prerequisites = [...header.prerequisites, ...earlier]
    rule.orderOnly = [...header.orderOnly, ...earlierOrder]
    rule.recipe = header.lines
  }
}

const targetVariable = /^\s*(?:(?:export|override|private|unexport)\s+)*[^\s:=#]+\s*(?:\?|\+|!|:{1,3})?=/

/** Reads a line holding a rule. What follows a semicolon is the first line of its recipe. */
const readRule = (makefile: Makefile, plain: string, raw: string, number: number, continued: boolean): Header => {
  const stop = topLevel(raw, ";#")
  const inline = stop !== -1 && raw.charAt(stop) === ";" ? raw.slice(stop + 1) : undefined
  const text = inline === undefined ? plain : raw.slice(0, stop)
  const colon = topLevel(text, ":")
  if (colon === -1) {
    block(makefile, "malformed-file", `line ${number} cannot be read`)
    return emptyHeader()
  }
  const grouped = text.slice(0, colon).trimEnd().endsWith("&")
  const double = text.charAt(colon + 1) === ":"
  const rest = text.slice(colon + (double ? 2 : 1))
  const scope = scopeOf(makefile.variables)
  const targets = words(expand(scope, text.slice(0, colon).trimEnd().replace(/&$/, "")))
  if (scope.problems.length > 0) {
    blockAll(makefile, scope, number)
    return emptyHeader()
  }
  if (targetVariable.test(rest)) {
    for (const target of targets) {
      if (target.includes("%")) block(makefile, "target-variable", `line ${number} sets a variable for ${target}`)
      else makefile.scoped.add(target)
    }
    return emptyHeader()
  }
  const isStatic = topLevel(rest, ":") !== -1
  const bar = isStatic ? -1 : topLevel(rest, "|")
  const prerequisites = isStatic ? [] : words(expand(scope, bar === -1 ? rest : rest.slice(0, bar)))
  const orderOnly = bar === -1 ? [] : words(expand(scope, rest.slice(bar + 1)))
  const rules: Array<Rule> = []
  for (const target of targets) {
    const pattern = target.includes("%") ? target : suffixPattern(target, prerequisites)
    if (pattern !== undefined) {
      makefile.patterns.push(pattern)
    } else if (!(target.startsWith(".") && readSpecial(makefile, target, prerequisites, number))) {
      const rule = ruleFor(makefile, target)
      rule.prerequisites = [...rule.prerequisites, ...prerequisites]
      rule.orderOnly = [...rule.orderOnly, ...orderOnly]
      for (const problem of scope.problems) {
        rule.problems.push({ ...problem, reason: `at line ${number} ${problem.reason}` })
      }
      if (double) rule.problems.push({ feature: "double-colon", reason: "has a double-colon rule" })
      if (grouped) rule.problems.push({ feature: "grouped-targets", reason: "is built together with other files" })
      if (isStatic) rule.problems.push({ feature: "pattern-rule", reason: "comes from a static pattern rule" })
      if (inline !== undefined && continued) {
        rule.problems.push({ feature: "syntax", reason: "continues a recipe written after a semicolon" })
      }
      rules.push(rule)
    }
  }
  const header: Header = { rules, prerequisites, orderOnly, lines: [], started: false }
  if (inline !== undefined) {
    startRecipe(header)
    header.lines.push({ text: inline, number })
  }
  return header
}

const conditionalWords = ["ifeq", "ifneq", "ifdef", "ifndef"]

/** The lines read so far and the place reached. */
interface Reader {
  readonly makefile: Makefile
  readonly lines: ReadonlyArray<string>
  index: number
  header: Header | undefined
  /** How many conditionals are open. */
  depth: number
}

/** Passes over a `define` block. Its value is reported wherever it is read. */
const skipDefine = (reader: Reader, name: string, number: number): void => {
  const { lines, makefile } = reader
  makefile.variables.set(name, unknownVariable(name, "define", "a define block sets"))
  let open = 1
  while (open > 0 && reader.index < lines.length) {
    const text = (lines[reader.index++] as string).trim()
    if (directive(text, "define") !== undefined) open++
    else if (directive(text, "endef") !== undefined) open--
  }
  if (open > 0) block(makefile, "malformed-file", `the define block at line ${number} has no end`)
}

/** Reads a line inside a conditional: an assignment leaves its variable unknown, anything else stops the file. */
const readConditionalLine = (makefile: Makefile, text: string, number: number): void => {
  const assignment = readAssignment(directive(text, "override") ?? text)
  if (assignment === undefined || assignment.name.includes("$")) {
    block(makefile, "conditional", `line ${number} is inside a conditional`)
    return
  }
  assign(makefile, assignment.name, assignment.operator, assignment.value)
  makefile.variables.set(assignment.name, unknownVariable(assignment.name, "conditional", "a conditional sets"))
}

/** Reads a directive. True when the line was one. */
const readDirective = (reader: Reader, text: string, number: number): boolean => {
  const { makefile } = reader
  for (const word of ["include", "-include", "sinclude"]) {
    const rest = directive(text, word)
    if (rest !== undefined) {
      block(makefile, "include", `line ${number} includes ${rest.trim()}, which was not read`)
      return true
    }
  }
  for (const word of ["vpath", "load", "-load"]) {
    if (directive(text, word) !== undefined) {
      block(makefile, word.replace("-", ""), `line ${number} uses ${word}`)
      return true
    }
  }
  const exported = directive(text, "export")
  const unexported = directive(text, "unexport")
  const removed = directive(text, "undefine")
  if (exported !== undefined) readExport(makefile, exported, number)
  else if (unexported !== undefined) readUnexport(makefile, unexported, number)
  else if (removed !== undefined) makefile.variables.delete(removed.trim())
  else return false
  return true
}

/** Reads a line that is not part of a recipe. */
const readLine = (reader: Reader, raw: string, tabbed: boolean, number: number, continued: boolean): void => {
  const { makefile } = reader
  const plain = withoutComment(raw)
  const text = plain.trim()
  if (text === "") return
  const defined = /^(?:(?:override|export|private)\s+)*define\s+(\S+)/.exec(text)
  if (defined !== null) {
    reader.header = undefined
    return skipDefine(reader, defined[1] as string, number)
  }
  if (conditionalWords.some((word) => directive(text, word) !== undefined)) {
    reader.depth++
    return
  }
  if (directive(text, "else") !== undefined || directive(text, "endif") !== undefined) {
    if (reader.depth === 0) block(makefile, "malformed-file", `line ${number} cannot be read`)
    if (directive(text, "endif") !== undefined) reader.depth = Math.max(0, reader.depth - 1)
    return
  }
  reader.header = undefined
  if (reader.depth > 0) return readConditionalLine(makefile, text, number)
  const kept = plain.trimStart()
  if (readDirective(reader, kept, number)) return
  const assignment = readAssignment(directive(kept, "override") ?? directive(kept, "private") ?? kept)
  if (assignment !== undefined) return applyAssignment(makefile, assignment, number)
  if (!tabbed && topLevel(text, ":") !== -1) {
    reader.header = readRule(makefile, plain, raw, number, continued)
  } else if (text.includes("$")) {
    block(makefile, "expansion", `line ${number} expands to something Make reads as more of the file`)
  } else {
    block(makefile, "malformed-file", `line ${number} cannot be read`)
  }
}

const readRecipeLine = (reader: Reader, header: Header, line: string, number: number): void => {
  let text = line.slice(1)
  while (continues(text) && reader.index < reader.lines.length) {
    const next = reader.lines[reader.index++] as string
    text += `\n${next.startsWith("\t") ? next.slice(1) : next}`
  }
  if (reader.depth > 0) {
    for (const rule of header.rules) {
      rule.problems.push({ feature: "conditional", reason: "has a recipe with a conditional in it" })
    }
  }
  startRecipe(header)
  header.lines.push({ text, number })
}

/** Gives each prerequisite of a rule with a variable of its own the problem: it inherits the variable. */
const spreadScoped = (makefile: Makefile): void => {
  for (const name of makefile.scoped) {
    const seen = new Set<string>()
    const visit = (target: string): void => {
      const rule = makefile.rules.get(target)
      if (rule === undefined || seen.has(target)) return
      seen.add(target)
      rule.problems.push({ feature: "target-variable", reason: `runs with a variable set for ${name}` })
      for (const prerequisite of [...rule.prerequisites, ...rule.orderOnly]) visit(prerequisite)
    }
    visit(name)
  }
}

const parse = (text: string): Makefile => {
  const makefile: Makefile = {
    variables: new Map(),
    rules: new Map(),
    phony: new Set(),
    patterns: [],
    exported: new Set(),
    unexported: new Set(),
    scoped: new Set(),
    blockers: [],
    exportAll: false,
    oneShell: false,
    posix: false
  }
  const reader: Reader = { makefile, lines: text.split(/\r?\n/), index: 0, header: undefined, depth: 0 }
  while (reader.index < reader.lines.length) {
    const number = reader.index + 1
    const line = reader.lines[reader.index++] as string
    if (line.startsWith("\t") && reader.header !== undefined) {
      readRecipeLine(reader, reader.header, line, number)
      continue
    }
    let raw = line
    let continued = false
    while (continues(raw) && reader.index < reader.lines.length) {
      raw = `${raw.slice(0, -1).trimEnd()} ${(reader.lines[reader.index++] as string).trimStart()}`
      continued = true
    }
    readLine(reader, raw, line.startsWith("\t"), number, continued)
  }
  if (reader.depth > 0) block(makefile, "malformed-file", "a conditional has no endif")
  spreadScoped(makefile)
  return makefile
}

/** Commands the shell itself provides, which `sh` and `bash` do not run alike. */
const shellBuiltins = new Set(
  (". : [ alias bg bind break builtin caller cd command compgen complete continue declare dirs disown echo enable eval "
    + "exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd "
    + "read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask "
    + "unalias unset wait").split(" ")
)

/** True for a program and plain words, which mean the same to both shells. */
const isPlainCommand = (line: string): boolean =>
  /^[\w@%+=:,./ -]+$/.test(line) && !line.startsWith("-") && !shellBuiltins.has(line.split(" ")[0] as string)

interface Shell {
  /** The words before a quoted line. */
  readonly start: string
  /** True for a POSIX shell with flags that leave a plain command as it is. */
  readonly posixLike: boolean
}

const posixShell = /^(?:\/usr\/bin\/env\s+)?(?:\S*\/)?(?:ba|da)?sh$/
const posixFlags = /^(?:-[eux]+\s+|-o\s+pipefail\s+)*-[eux]*c$/

const shellOf = (makefile: Makefile, scope: Scope): Shell => {
  const { variables } = makefile
  const program = variables.has("SHELL") ? expand(scope, "$(SHELL)").trim() : ""
  const flags = variables.has(".SHELLFLAGS") ? expand(scope, "$(.SHELLFLAGS)").trim() : makefile.posix ? "-ec" : "-c"
  const shell = program === "" ? "sh" : program
  return {
    start: [...words(shell), ...words(flags)].map(shellWord).join(" "),
    posixLike: posixShell.test(shell) && posixFlags.test(flags)
  }
}

const inShell = (shell: Shell, line: string): string =>
  shell.posixLike && isPlainCommand(line) ? line : `${shell.start} ${shellQuote(line)}`

interface Context {
  readonly makefile: Makefile
  /** Every tracked file and every directory holding one. */
  readonly present: ReadonlySet<string>
}

const matchesPattern = (pattern: string, name: string): boolean => {
  const subject = pattern.includes("/") ? name : name.slice(name.lastIndexOf("/") + 1)
  const percent = pattern.indexOf("%")
  const before = pattern.slice(0, percent)
  const after = pattern.slice(percent + 1)
  return subject.length >= before.length + after.length && subject.startsWith(before) && subject.endsWith(after)
}

/** A tracked file one of Make's built-in rules would build `name` from. */
const builtinSource = (present: ReadonlySet<string>, name: string): string | undefined => {
  const directory = name.slice(0, name.lastIndexOf("/") + 1)
  const base = name.slice(directory.length)
  const dot = base.lastIndexOf(".")
  const suffix = dot > 0 ? base.slice(dot) : ""
  const stem = builtinResults.has(suffix) ? directory + base.slice(0, dot) : undefined
  const sources = [
    ...builtinSources.map((ending) => name + ending),
    ...(stem === undefined ? [] : builtinSources.map((ending) => stem + ending)),
    ...(stem !== undefined && suffix === ".out" ? [stem] : []),
    `${name},v`,
    `${directory}RCS/${base},v`,
    `${directory}RCS/${base}`,
    `${directory}s.${base}`,
    `${directory}SCCS/s.${base}`
  ]
  return sources.find((candidate) => candidate !== name && present.has(candidate))
}

/** Notes what a name with no recipe of its own would get from a rule that is not written for it. */
const noteImplicit = (context: Context, job: Draft, name: string, where: string): boolean => {
  const pattern = context.makefile.patterns.find((entry) => matchesPattern(entry, name))
  if (pattern !== undefined) {
    note(job, "pattern-rule", `${where} depends on the pattern rule ${pattern}`)
    return true
  }
  const built = builtinSource(context.present, name)
  if (built !== undefined) note(job, "implicit-rule", `${where} depends on Make building ${name} from ${built}`)
  return built !== undefined
}

const checkFiles = (context: Context, job: Draft, rule: Rule): void => {
  const { makefile, present } = context
  if (!makefile.phony.has(rule.name)) {
    if (rule.recipe === undefined) {
      noteImplicit(context, job, rule.name, rule.name)
    } else if (present.has(rule.name)) {
      note(job, "file-target", `${rule.name} is also a file in the repository, so Make may skip its recipe`)
    }
  }
  for (const name of [...rule.prerequisites, ...rule.orderOnly]) {
    if (!makefile.rules.has(name) && !makefile.phony.has(name)) {
      const implicit = noteImplicit(context, job, name, rule.name)
      if (!implicit && !present.has(name)) {
        note(job, "missing-prerequisite", `${rule.name} needs ${name}, which no rule builds and no file provides`)
      }
    }
  }
}

const quietFlags = new Set(["-s", "--silent", "--quiet", "--no-print-directory"])

/** The first rule, or the one `.DEFAULT_GOAL` names. */
const defaultGoal = (makefile: Makefile): string | undefined => {
  if (makefile.variables.has(".DEFAULT_GOAL")) {
    const scope = scopeOf(makefile.variables)
    const named = words(expand(scope, "$(.DEFAULT_GOAL)"))
    if (scope.problems.length > 0) return undefined
    if (named.length > 0) return named[0]
  }
  return [...makefile.rules.keys()].find((name) => !name.startsWith("."))
}

/** The rules a line asks Make to build, when the line does nothing else. */
const subMakeGoals = (makefile: Makefile, line: string): ReadonlyArray<string> | undefined => {
  const [program, ...args] = words(line)
  if (program !== "make") return undefined
  const goals = args.filter((arg) => !quietFlags.has(arg))
  const named = goals.length > 0 ? goals : [defaultGoal(makefile)]
  const known = named.filter((goal): goal is string => goal !== undefined && makefile.rules.has(goal))
  return known.length === named.length ? known : undefined
}

/** Adds the steps of one Make run of `goals`: each rule once, after what it needs. */
const runGoals = (
  context: Context,
  job: Draft,
  goals: ReadonlyArray<string>,
  running: ReadonlySet<string>
): void => {
  const seen = new Set<string>()
  const visit = (name: string): void => {
    const rule = context.makefile.rules.get(name)
    if (rule === undefined || seen.has(name)) return
    seen.add(name)
    for (const prerequisite of [...rule.prerequisites, ...rule.orderOnly]) visit(prerequisite)
    readRuleSteps(context, job, rule, running)
  }
  goals.forEach(visit)
}

const prefixOf = (text: string): string => (/^[ \t@+-]*/.exec(text) as RegExpExecArray)[0]

const noteAll = (job: Draft, where: string, problems: ReadonlyArray<Problem>): void => {
  for (const problem of problems) note(job, problem.feature, `${where} ${problem.reason}`)
}

interface RecipeContext {
  readonly context: Context
  readonly job: Draft
  readonly rule: Rule
  readonly automatic: ReadonlyMap<string, string>
  readonly shell: Shell
  readonly env: ReadonlyMap<string, string>
  readonly running: ReadonlySet<string>
}

/** The text of a recipe line with variables filled in, or `undefined` once the reason is recorded. */
const fillIn = (recipe: RecipeContext, line: RecipeLine, where: string): string | undefined => {
  const scope = scopeOf(recipe.context.makefile.variables, recipe.automatic)
  const text = expand(scope, line.text)
  noteAll(recipe.job, where, scope.problems)
  return scope.problems.length > 0 ? undefined : text
}

const readRecipeStep = (recipe: RecipeContext, line: RecipeLine): void => {
  const { context, env, job, rule, running, shell } = recipe
  const where = `${rule.name} line ${line.number}`
  const text = fillIn(recipe, line, where)
  if (text === undefined) return
  const prefix = prefixOf(text)
  const command = text.slice(prefix.length)
  // Make hands a comment to the shell, which does nothing with it.
  if (command.trim() === "" || (command.startsWith("#") && !command.includes("\n"))) return
  const ignored = prefix.includes("-")
  const goals = ignored ? undefined : subMakeGoals(context.makefile, command)
  if (goals !== undefined) return runGoals(context, job, goals, running)
  const stated = inShell(shell, command)
  addStep(job, { where, command: ignored ? `${stated} || true` : stated, env })
}

/** Reads a `.ONESHELL` recipe: one shell runs every line, and only the first line's prefix counts. */
const readOneShell = (recipe: RecipeContext, lines: ReadonlyArray<RecipeLine>): void => {
  const { env, job, rule, shell } = recipe
  if (!shell.posixLike) {
    return note(job, "interpreter", `${rule.name} runs as one script in a shell Make treats differently`)
  }
  const texts = lines.map((line) => fillIn(recipe, line, `${rule.name} line ${line.number}`))
  const known = texts.filter((text) => text !== undefined)
  if (known.length < texts.length) return
  const script = known.map((text) => text.slice(prefixOf(text).length)).join("\n").trim()
  if (script === "") return
  const stated = inShell(shell, script)
  const ignored = prefixOf(known[0] as string).includes("-")
  addStep(job, { where: rule.name, command: ignored ? `${stated} || true` : stated, env })
}

const environmentOf = (makefile: Makefile, scope: Scope): ReadonlyMap<string, string> => {
  const all = makefile.exportAll ? [...makefile.variables.keys()] : []
  const names = [
    ...makefile.exported,
    ...all.filter((name) => /^[A-Za-z_]\w*$/.test(name) && name !== "SHELL" && !makefile.unexported.has(name))
  ]
  return new Map(names.map((name) => [name, expand(scope, `$(${name})`)]))
}

/** Adds what running one rule's recipe does to `job`, with everything that keeps it from being stated. */
const readRuleSteps = (context: Context, job: Draft, rule: Rule, running: ReadonlySet<string>): void => {
  if (running.has(rule.name)) return note(job, "recursive-make", `${rule.name} runs Make on itself`)
  noteAll(job, rule.name, rule.problems)
  checkFiles(context, job, rule)
  if (rule.recipe === undefined) return
  const { makefile } = context
  const automatic = new Map([
    ["@", rule.name],
    ["<", rule.prerequisites[0] ?? ""],
    ["^", [...new Set(rule.prerequisites)].join(" ")],
    ["+", rule.prerequisites.join(" ")],
    ["|", [...new Set(rule.orderOnly)].join(" ")]
  ])
  const scope = scopeOf(makefile.variables, automatic)
  const shell = shellOf(makefile, scope)
  const env = environmentOf(makefile, scope)
  noteAll(job, rule.name, scope.problems)
  if (scope.problems.length > 0) return
  const recipe: RecipeContext = {
    context,
    job,
    rule,
    automatic,
    shell,
    env,
    running: new Set([...running, rule.name])
  }
  if (makefile.oneShell) readOneShell(recipe, rule.recipe)
  else rule.recipe.forEach((line) => readRecipeStep(recipe, line))
}

/** Every path given and every directory above one. */
const withDirectories = (tracked: ReadonlyArray<string>): ReadonlySet<string> => {
  const present = new Set<string>()
  for (const path of tracked) {
    present.add(path)
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      present.add(path.slice(0, slash))
    }
  }
  return present
}

const readJob = (context: Context, file: string, rule: Rule): Draft => {
  const { makefile } = context
  const prerequisites = [...new Set([...rule.prerequisites, ...rule.orderOnly])]
  const job = draft({
    id: jobId(rule.name),
    source,
    file,
    name: rule.name,
    needs: prerequisites.filter((name) => name !== rule.name && makefile.rules.has(name)).map(jobId)
  })
  for (const blocker of makefile.blockers) note(job, blocker.feature, blocker.reason)
  if (makefile.blockers.length === 0) readRuleSteps(context, job, rule, new Set())
  return job
}

/**
 * Reads a Makefile. `tracked` lists the repository's files, from its root:
 * Make skips or replaces a recipe depending on which files exist.
 *
 * Every rule with a plain name becomes a job, and the `ci` rule is the CI, as
 * a `ci` recipe is for a Justfile. A prerequisite that is a rule is what the
 * job needs. A line that only runs Make on rules of this file gives their
 * steps in its place.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const readMakefile = (file: string, text: string, tracked: ReadonlyArray<string>): Parsed => {
  const makefile = parse(text)
  const context: Context = { makefile, present: withDirectories(tracked) }
  const jobs = [...makefile.rules.values()].map((rule) => readJob(context, file, rule))
  const runsMake = jobs.some((job) => job.steps.some((step) => /(?:^|[\s;&|('])make(?:\s|$)/.test(step.command)))
  const unsupported: ReadonlyArray<Unsupported> = makefile.blockers.map((blocker) => ({
    feature: blocker.feature,
    detail: `${file}: ${blocker.reason}`
  }))
  return { jobs, toolchains: runsMake ? [{ name: "make", source: file }] : [], unsupported }
}
