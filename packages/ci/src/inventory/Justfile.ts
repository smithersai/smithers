/**
 * Reads a Justfile: each recipe is a job and each recipe line a step.
 *
 * Only what is written out is read. An interpolation resolves when it names a
 * string literal or a parameter's literal default; anything `just` would have
 * to evaluate is reported, not guessed.
 *
 * @since 0.1.0
 */

import { addStep, type Draft, draft, fileProblem, note, type Parsed } from "./Draft.ts"
import { shellQuote } from "./Values.ts"

const source = "justfile"
const jobId = (name: string): string => `justfile:${name}`

interface Attribute {
  readonly name: string
  readonly value: string | undefined
}

interface Parameter {
  readonly name: string
  readonly exported: boolean
  /** The value it has when the recipe runs with no arguments, when that is known. */
  readonly value: string | undefined
}

interface BodyLine {
  readonly text: string
  readonly number: number
}

interface Recipe {
  readonly name: string
  readonly attributes: ReadonlyArray<Attribute>
  readonly parameters: ReadonlyArray<Parameter>
  readonly dependencies: ReadonlyArray<string>
  readonly body: ReadonlyArray<BodyLine>
}

interface Module {
  readonly name: string
  readonly reason: string
}

interface Justfile {
  readonly variables: Map<string, string | undefined>
  readonly exported: Set<string>
  readonly aliases: Map<string, string>
  readonly settings: Array<string>
  readonly modules: Array<Module>
  readonly recipes: Array<Recipe>
  readonly unreadable: Array<number>
  exportAll: boolean
}

/** Settings that do not change what a recipe's commands do when it runs with no arguments. */
const harmlessSettings = new Set([
  "allow-duplicate-recipes",
  "allow-duplicate-variables",
  "fallback",
  "ignore-comments",
  "positional-arguments",
  "quiet",
  "unstable",
  "windows-powershell",
  "windows-shell"
])

const harmlessAttributes = new Set(["doc", "exit-message", "group", "no-exit-message", "no-quiet", "private"])
const platforms = new Set(["android", "dragonfly", "freebsd", "linux", "macos", "netbsd", "openbsd", "unix", "windows"])
const thisPlatform = new Set(["linux", "unix"])

/** The string a literal holds, or `undefined` for anything `just` must evaluate. */
const literal = (text: string): string | undefined =>
  (/^'([^']*)'(?:\s+#.*)?$/.exec(text) ?? /^"([^"\\]*)"(?:\s+#.*)?$/.exec(text))?.[1]

/** Splits on spaces outside quotes and parentheses, stopping at the first such colon when asked. */
const scanWords = (text: string, stopAtColon: boolean) => {
  const words: Array<string> = []
  let word = ""
  let quote = ""
  let depth = 0
  const flush = () => {
    if (word !== "") words.push(word)
    word = ""
  }
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index)
    if (quote !== "") {
      if (char === quote) quote = ""
      word += char
    } else if (char === "'" || char === `"`) {
      quote = char
      word += char
    } else if (depth === 0 && stopAtColon && char === ":") {
      flush()
      return { words, rest: text.slice(index + 1) }
    } else if (depth === 0 && /\s/.test(char)) {
      flush()
    } else {
      if (char === "(") depth++
      if (char === ")") depth--
      word += char
    }
  }
  flush()
  return { words, rest: undefined }
}

const readParameter = (word: string): Parameter | undefined => {
  const match = /^([*+]?)(\$?)([A-Za-z_][\w-]*)(?:=(.*))?$/.exec(word)
  if (match === null) return undefined
  const [, variadic, exported, name, defaultText] = match as unknown as [string, string, string, string, string?]
  const value = defaultText === undefined ? (variadic === "*" ? "" : undefined) : literal(defaultText)
  return { name, exported: exported === "$", value }
}

const readAttributes = (line: string): ReadonlyArray<Attribute> =>
  [...line.slice(1, -1).matchAll(/([\w-]+)(?:\s*[:(]\s*(?:'([^']*)'|"([^"]*)")\s*\)?)?/g)].map((match) => ({
    name: match[1] as string,
    value: match[2] ?? match[3]
  }))

const readSetting = (justfile: Justfile, name: string, value: string | undefined): void => {
  if (name === "export") justfile.exportAll = value?.trim() !== "false"
  else if (!harmlessSettings.has(name)) justfile.settings.push(name)
}

/** Reads one line outside any recipe. Returns the recipe a header starts, if it is one. */
const readTopLine = (
  justfile: Justfile,
  line: string,
  attributes: ReadonlyArray<Attribute>
): Omit<Recipe, "body"> | "read" | "unreadable" => {
  const setting = /^set\s+([\w-]+)(?:\s*:=\s*(.*))?$/.exec(line)
  if (setting !== null) {
    readSetting(justfile, setting[1] as string, setting[2])
    return "read"
  }
  const alias = /^alias\s+([\w-]+)\s*:=\s*([\w:-]+)\s*(?:#.*)?$/.exec(line)
  if (alias !== null) {
    justfile.aliases.set(alias[1] as string, alias[2] as string)
    return "read"
  }
  const module = /^mod\??\s+([\w-]+)(?:\s+(\S.*))?$/.exec(line)
  if (module !== null) {
    const name = module[1] as string
    const place = module[2] === undefined ? "" : ` in ${module[2]}`
    justfile.modules.push({ name, reason: `the recipes of module ${name}${place} were not read` })
    return "read"
  }
  const imported = /^import\??\s+(\S.*)$/.exec(line)
  if (imported !== null) {
    justfile.modules.push({ name: "import", reason: `the recipes imported from ${imported[1]} were not read` })
    return "read"
  }
  const assignment = /^(export\s+)?([A-Za-z_][\w-]*)\s*:=\s*(.*)$/.exec(line)
  if (assignment !== null) {
    const name = assignment[2] as string
    justfile.variables.set(name, literal((assignment[3] as string).trim()))
    if (assignment[1] !== undefined) justfile.exported.add(name)
    return "read"
  }
  const header = /^@?([A-Za-z_][\w-]*)(.*)$/.exec(line)
  const scanned = header === null ? undefined : scanWords(header[2] as string, true)
  if (header === null || scanned === undefined || scanned.rest === undefined) return "unreadable"
  const parameters = scanned.words.map(readParameter)
  if (!parameters.every((parameter) => parameter !== undefined)) return "unreadable"
  const words = scanWords(scanned.rest, false).words
  const comment = words.findIndex((word) => word.startsWith("#"))
  return {
    name: header[1] as string,
    attributes,
    parameters: parameters,
    dependencies: comment === -1 ? words : words.slice(0, comment)
  }
}

const parse = (text: string): Justfile => {
  const justfile: Justfile = {
    variables: new Map(),
    exported: new Set(),
    aliases: new Map(),
    settings: [],
    modules: [],
    recipes: [],
    unreadable: [],
    exportAll: false
  }
  const lines = text.split(/\r?\n/)
  let attributes: Array<Attribute> = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] as string
    const number = ++index
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    if (/^\s/.test(line)) {
      justfile.unreadable.push(number)
    } else if (/^\[.*\]$/.test(trimmed)) {
      attributes.push(...readAttributes(trimmed))
    } else {
      const read = readTopLine(justfile, trimmed, attributes)
      if (read === "unreadable") justfile.unreadable.push(number)
      if (typeof read === "object") {
        const body: Array<BodyLine> = []
        while (index < lines.length && /^(\s|$)/.test(lines[index] as string)) {
          body.push({ text: lines[index] as string, number: ++index })
        }
        justfile.recipes.push({ ...read, body })
      }
      attributes = []
    }
  }
  return justfile
}

const interpolate = (text: string, values: ReadonlyMap<string, string | undefined>) => {
  const unresolved: Array<string> = []
  const resolved = text.replace(/\{\{\{\{|\{\{(.*?)\}\}/g, (whole, inner: string | undefined) => {
    if (inner === undefined) return "{{"
    const value = values.get(inner.trim())
    if (value !== undefined) return value
    unresolved.push(inner.trim())
    return whole
  })
  return { text: resolved, unresolved }
}

/** Joins lines ending in a backslash, as `just` does, and leaves out blanks and comments. */
const logicalLines = (body: ReadonlyArray<BodyLine>): ReadonlyArray<BodyLine> => {
  const lines: Array<BodyLine> = []
  let open: BodyLine | undefined
  for (const line of body) {
    const text = open === undefined ? line.text.trim() : line.text.trimStart()
    if (open === undefined && (text === "" || text.startsWith("#"))) continue
    const joined: BodyLine = open === undefined ? { text, number: line.number } : { ...open, text: open.text + text }
    if (joined.text.trimEnd().endsWith("\\")) {
      open = { ...joined, text: joined.text.trimEnd().slice(0, -1) }
    } else {
      lines.push(joined)
      open = undefined
    }
  }
  return open === undefined ? lines : [...lines, open]
}

interface RecipeContext {
  readonly job: Draft
  readonly recipe: Recipe
  readonly values: ReadonlyMap<string, string | undefined>
  readonly cwd: string
  readonly env: ReadonlyMap<string, string>
}

const readScript = (context: RecipeContext, shebang: string, lines: ReadonlyArray<BodyLine>): void => {
  const { cwd, env, job, recipe, values } = context
  const interpreter = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?|\/(?:[\w.-]+\/)*)(bash|sh)((?:\s+-[\w-]+)*)\s*$/.exec(
    shebang
  )
  if (interpreter === null) return note(job, "interpreter", `${recipe.name} runs in ${shebang.slice(2).trim()}`)
  const indent = Math.min(
    ...lines.filter((line) => line.text.trim() !== "").map((line) => /^\s*/.exec(line.text)?.[0].length as number)
  )
  const script = interpolate(lines.map((line) => line.text.slice(indent)).join("\n").trim(), values)
  if (script.unresolved.length > 0) {
    return note(job, "expression", `${recipe.name} depends on ${script.unresolved.join(", ")}`)
  }
  const start = `${interpreter[1]}${(interpreter[2] as string).replace(/\s+/g, " ")}`
  addStep(job, { where: recipe.name, command: `${start} -c ${shellQuote(script.text)}`, cwd, env })
}

const readLine = (context: RecipeContext, line: BodyLine): void => {
  const { cwd, env, job, recipe, values } = context
  const where = `${recipe.name} line ${line.number}`
  const prefix = /^[@-]*/.exec(line.text)?.[0] as string
  if (prefix.includes("-")) note(job, "ignored-failure", `${where} may fail without failing the recipe`)
  const command = interpolate(line.text.slice(prefix.length), values)
  if (command.unresolved.length > 0) {
    return note(job, "expression", `${where} depends on ${command.unresolved.join(", ")}`)
  }
  addStep(job, { where, command: command.text, cwd, env })
}

const runsHere = (recipe: Recipe): boolean => {
  const named = recipe.attributes.filter((attribute) => platforms.has(attribute.name))
  return named.length === 0 || named.some((attribute) => thisPlatform.has(attribute.name))
}

const readDependencies = (job: Draft, recipe: Recipe, aliases: ReadonlyMap<string, string>): ReadonlyArray<string> => {
  const after = recipe.dependencies.indexOf("&&")
  if (after !== -1) note(job, "subsequent-recipes", `${recipe.name} runs recipes after itself`)
  const before = after === -1 ? recipe.dependencies : recipe.dependencies.slice(0, after)
  return before.flatMap((word) => {
    if (!word.startsWith("(")) return [jobId(aliases.get(word) ?? word)]
    note(job, "dependency-arguments", `${recipe.name} passes arguments to ${word}`)
    return []
  })
}

const readRecipe = (justfile: Justfile, recipe: Recipe, file: string): Draft => {
  const dependencies = draft({ id: jobId(recipe.name), source, file, name: recipe.name })
  const job = { ...dependencies, needs: readDependencies(dependencies, recipe, justfile.aliases) }
  for (const setting of justfile.settings) note(job, "setting", `set ${setting} changes how recipes run`)
  let cwd = ""
  let platformBlocked = false
  for (const attribute of recipe.attributes) {
    if (attribute.name === "working-directory" && attribute.value !== undefined) cwd = attribute.value
    else if (platforms.has(attribute.name)) platformBlocked = !runsHere(recipe)
    else if (!harmlessAttributes.has(attribute.name)) {
      note(job, "attribute", `${recipe.name} has attribute ${attribute.name}`)
    }
  }
  const values = new Map(justfile.variables)
  const env = new Map<string, string>()
  for (const name of justfile.exportAll ? justfile.variables.keys() : justfile.exported) {
    const value = justfile.variables.get(name)
    if (value === undefined) note(job, "expression", `${recipe.name} exports ${name}, which just must evaluate`)
    else env.set(name, value)
  }
  for (const parameter of recipe.parameters) {
    values.set(parameter.name, parameter.value)
    if (parameter.value === undefined) {
      note(job, "recipe-argument", `${recipe.name} needs a value for ${parameter.name}`)
    } else if (parameter.exported || justfile.exportAll) env.set(parameter.name, parameter.value)
  }
  if (platformBlocked) {
    note(job, "platform", `${recipe.name} does not run on Linux`)
    return job
  }
  const context: RecipeContext = { job, recipe, values, cwd, env }
  const first = recipe.body.find((line) => line.text.trim() !== "")
  if (first?.text.trim().startsWith("#!")) {
    readScript(context, first.text.trim(), recipe.body.slice(recipe.body.indexOf(first) + 1))
  } else {
    for (const line of logicalLines(recipe.body)) readLine(context, line)
  }
  return job
}

/**
 * Reads a Justfile. A recipe becomes one job; recipes with the same name keep
 * the first that runs on Linux.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const readJustfile = (file: string, text: string): Parsed => {
  const justfile = parse(text)
  const jobs = new Map<string, Draft>()
  const ordered = [
    ...justfile.recipes.filter((recipe) => runsHere(recipe)),
    ...justfile.recipes.filter((recipe) => !runsHere(recipe))
  ]
  for (const recipe of ordered) {
    const existing = jobs.get(recipe.name)
    if (existing === undefined) jobs.set(recipe.name, readRecipe(justfile, recipe, file))
    else note(existing, "duplicate-recipe", `${recipe.name} is defined more than once; the first was kept`)
  }
  const modules = justfile.modules.map((module) => {
    const job = draft({ id: jobId(`${module.name}::*`), source, file, name: module.name })
    note(job, "module", module.reason)
    return job
  })
  const problems = justfile.unreadable.length === 0
    ? []
    : fileProblem(
      "justfile",
      source,
      file,
      "malformed-file",
      `line ${justfile.unreadable[0]} cannot be read (${justfile.unreadable.length} such lines)`
    ).jobs
  return {
    jobs: [...jobs.values(), ...modules, ...problems],
    toolchains: [{ name: "just", source: file }]
  }
}
