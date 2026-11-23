/**
 * GitHub Actions expressions: the text inside `${{ }}` and after `if:`.
 *
 * An expression is evaluated as far as the workflow file allows. What is
 * known before the job runs becomes a value. What is only known while the job
 * runs, such as a step's output, stays in the result as a variable, and the
 * step works the rest out in its shell. What cannot be known either way is a
 * problem, and the caller leaves the job out: nothing is guessed.
 *
 * The rules are GitHub's, from "Evaluate expressions in workflows and
 * actions": the literals, the operators and their order, loose equality with
 * its conversion to numbers, comparison of strings without case, the falsy
 * values, and the functions.
 *
 * @since 0.1.0
 */

/**
 * A value an expression gives.
 *
 * @category models
 * @since 0.1.0
 */
export type Value = null | boolean | number | string | ReadonlyArray<Value> | { readonly [name: string]: Value }

/**
 * A text value known only while the job runs. `id` says where the step finds
 * it and `name` is how the workflow wrote it. A `nullable` variable may be
 * absent, which an expression reads as `null`. A `typed` variable is a
 * number or a boolean on GitHub: its text is known, so it can be written
 * into text, and it cannot be compared or tested.
 *
 * @category models
 * @since 0.1.0
 */
export interface Variable {
  readonly id: string
  readonly name: string
  readonly nullable: boolean
  readonly typed: boolean
}

/**
 * An operator between two values.
 *
 * @category models
 * @since 0.1.0
 */
export type Operator = "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||"

/**
 * An expression with everything known before the run worked out.
 *
 * @category models
 * @since 0.1.0
 */
export type Residual =
  | { readonly kind: "literal"; readonly value: Value }
  | { readonly kind: "variable"; readonly variable: Variable }
  | { readonly kind: "not"; readonly operand: Residual }
  | { readonly kind: "binary"; readonly operator: Operator; readonly left: Residual; readonly right: Residual }
  | { readonly kind: "call"; readonly name: string; readonly args: ReadonlyArray<Residual> }

/**
 * What a name such as `github` or `steps.build.outputs` stands for: a value,
 * an expression still to finish, a mapping whose fields are looked up one at
 * a time, something nobody can know here, or a secret.
 *
 * @category models
 * @since 0.1.0
 */
export type Context =
  | { readonly kind: "value"; readonly value: Value }
  | { readonly kind: "residual"; readonly residual: Residual }
  | { readonly kind: "fields"; readonly field: (name: string) => Context }
  | { readonly kind: "unknown"; readonly why: string }
  | { readonly kind: "secret"; readonly name: string }

/**
 * What the status functions give where the expression stands, in the order
 * `success`, `always`, `cancelled`, `failure`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Status {
  readonly success: boolean
  readonly always: boolean
  readonly cancelled: boolean
  readonly failure: boolean
}

/**
 * Where an expression is evaluated: the contexts by name in lower case, the
 * status functions when the place allows them, and `hashFiles` when it does.
 *
 * @category models
 * @since 0.1.0
 */
export interface Scope {
  readonly context: (name: string) => Context | undefined
  readonly status?: Status | undefined
  readonly hashFiles?: ((patterns: ReadonlyArray<string>) => Context) | undefined
}

/**
 * The result of evaluating: the expression as far as it goes, why it cannot
 * be evaluated, or the secret it reads.
 *
 * @category models
 * @since 0.1.0
 */
export type Evaluated =
  | { readonly kind: "ok"; readonly residual: Residual }
  | { readonly kind: "problem"; readonly why: string }
  | { readonly kind: "secret"; readonly name: string }

/**
 * A context that is one value.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const value = (held: Value): Context => ({ kind: "value", value: held })

/**
 * A context known only while the job runs.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const variable = (id: string, name: string, nullable = false, typed = false): Context => ({
  kind: "residual",
  residual: { kind: "variable", variable: { id, name, nullable, typed } }
})

/**
 * A context nobody can know off GitHub.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const unknown = (why: string): Context => ({ kind: "unknown", why })

/**
 * A mapping context. GitHub reads property names without case, so `field`
 * is asked with the name in lower case, or as written with `exact` (the
 * `env` context on Linux and macOS). A name it does not answer is `null`, as
 * a missing property is.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const fields = (field: (name: string) => Context | undefined, exact = false): Context => ({
  kind: "fields",
  field: (name) => field(exact ? name : name.toLowerCase()) ?? value(null)
})

type Node =
  | { readonly kind: "literal"; readonly value: Value }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "member"; readonly object: Node; readonly property: Node }
  | { readonly kind: "star"; readonly object: Node }
  | { readonly kind: "not"; readonly operand: Node }
  | { readonly kind: "binary"; readonly operator: Operator; readonly left: Node; readonly right: Node }
  | { readonly kind: "call"; readonly name: string; readonly args: ReadonlyArray<Node> }

/** Ends an evaluation that cannot go on. Caught where the evaluation started. */
class Stop {
  readonly result: Evaluated
  constructor(result: Evaluated) {
    this.result = result
  }
}

const problem = (why: string): Stop => new Stop({ kind: "problem", why })

interface Token {
  readonly kind: "symbol" | "number" | "string" | "word"
  readonly text: string
}

const symbols = ["&&", "||", "==", "!=", "<=", ">=", "(", ")", "[", "]", ",", ".", "!", "<", ">", "*"]
const numberStart = /^-?(?:0x[0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i
const wordStart = /^[A-Za-z_][A-Za-z0-9_-]*/

/** Splits an expression into tokens. Strings are written in single quotes, with `''` for a quote. */
const tokenize = (text: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = []
  let at = 0
  while (at < text.length) {
    const rest = text.slice(at)
    const space = /^\s+/.exec(rest)?.[0]
    const symbol = symbols.find((candidate) => rest.startsWith(candidate))
    const number = numberStart.exec(rest)?.[0]
    const word = wordStart.exec(rest)?.[0]
    if (space !== undefined) {
      at += space.length
    } else if (rest.startsWith("'")) {
      const literal = /^'((?:[^']|'')*)'/.exec(rest)
      if (literal === null) throw problem("a string has no closing quote")
      tokens.push({ kind: "string", text: (literal[1] as string).replaceAll("''", "'") })
      at += literal[0].length
    } else if (number !== undefined && (symbol === undefined || symbol === ".")) {
      tokens.push({ kind: "number", text: number })
      at += number.length
    } else if (symbol !== undefined) {
      tokens.push({ kind: "symbol", text: symbol })
      at += symbol.length
    } else if (word !== undefined) {
      tokens.push({ kind: "word", text: word })
      at += word.length
    } else {
      throw problem(`${JSON.stringify(rest[0])} is not part of an expression`)
    }
  }
  return tokens
}

const keywords: ReadonlyMap<string, Value> = new Map<string, Value>([
  ["true", true],
  ["false", false],
  ["null", null],
  ["nan", Number.NaN],
  ["infinity", Number.POSITIVE_INFINITY]
])

/** The operators by how tightly they bind, loosest first, as GitHub orders them. */
const levels: ReadonlyArray<ReadonlyArray<Operator>> = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="]]

/**
 * The root context names in an expression, including ones passed to functions whole.
 *
 * @category readers
 * @since 0.1.0
 * @throws {never}
 */
export const contextNames = (text: string): ReadonlyArray<string> | undefined => {
  try {
    const tokens = tokenize(text)
    return tokens.flatMap((token, index) => {
      const name = token.text.toLowerCase()
      return token.kind === "word" && tokens[index - 1]?.text !== "." && tokens[index + 1]?.text !== "(" &&
          !keywords.has(name)
        ? [name] :
        []
    })
  } catch {
    return undefined
  }
}

/** Reads tokens into a tree. */
const parse = (text: string): Node => {
  const tokens = tokenize(text)
  let at = 0
  const peek = (symbol: string): boolean => tokens[at]?.kind === "symbol" && tokens[at]?.text === symbol
  const take = (symbol: string): boolean => {
    if (!peek(symbol)) return false
    at += 1
    return true
  }
  const expect = (symbol: string): void => {
    if (!take(symbol)) throw problem(`${JSON.stringify(symbol)} is missing`)
  }
  const list = (): ReadonlyArray<Node> => {
    const items: Array<Node> = []
    if (take(")")) return items
    do items.push(binary(0))
    while (take(","))
    expect(")")
    return items
  }
  const primary = (): Node => {
    const token = tokens[at]
    at += 1
    if (token === undefined) throw problem("the expression ends early")
    if (token.kind === "string") return { kind: "literal", value: token.text }
    // `Number` reads a sign before a decimal number, and not before one written in hexadecimal.
    if (token.kind === "number") {
      return { kind: "literal", value: token.text.startsWith("-") ? -Number(token.text.slice(1)) : Number(token.text) }
    }
    if (token.kind === "word") {
      if (take("(")) return { kind: "call", name: token.text.toLowerCase(), args: list() }
      const keyword = keywords.get(token.text.toLowerCase())
      return keyword === undefined ? { kind: "name", name: token.text } : { kind: "literal", value: keyword }
    }
    if (token.text !== "(") throw problem(`${JSON.stringify(token.text)} is not expected here`)
    const inner = binary(0)
    expect(")")
    return inner
  }
  const postfix = (): Node => {
    let node = primary()
    for (;;) {
      if (take(".")) {
        const name = tokens[at]
        at += 1
        if (name?.kind === "symbol" && name.text === "*") node = { kind: "star", object: node }
        else if (name?.kind === "word") {
          node = { kind: "member", object: node, property: { kind: "literal", value: name.text } }
        } else throw problem("a property name is missing after a dot")
      } else if (take("[")) {
        node = { kind: "member", object: node, property: binary(0) }
        expect("]")
      } else {
        return node
      }
    }
  }
  const unary = (): Node => take("!") ? { kind: "not", operand: unary() } : postfix()
  const binary = (level: number): Node => {
    const operators = levels[level]
    if (operators === undefined) return unary()
    let left = binary(level + 1)
    for (;;) {
      const operator = operators.find((candidate) => peek(candidate))
      if (operator === undefined) return left
      at += 1
      left = { kind: "binary", operator, left, right: binary(level + 1) }
    }
  }
  const node = binary(0)
  if (at < tokens.length) throw problem(`${JSON.stringify((tokens[at] as Token).text)} is not expected here`)
  return node
}

const isList = (held: Value): held is ReadonlyArray<Value> => Array.isArray(held)

const isMapping = (held: Value): held is { readonly [name: string]: Value } =>
  typeof held === "object" && held !== null && !isList(held)

/**
 * The number GitHub converts a value to when two types are compared: `null`
 * is 0, `true` is 1, an empty string is 0, other text is the number it
 * spells or `NaN`, and a list or mapping is `NaN`.
 *
 * @category conversions
 * @since 0.1.0
 * @throws {never}
 */
export const toNumber = (held: Value): number => {
  if (held === null) return 0
  if (typeof held === "number") return held
  if (typeof held === "boolean") return held ? 1 : 0
  if (typeof held !== "string") return Number.NaN
  const text = held.trim()
  if (text === "") return 0
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || /^0[xo][0-9a-f]+$/i.test(text)
    ? Number(text)
    : Number.NaN
}

/**
 * The text GitHub writes for a value: `null` is empty, a list is `Array` and
 * a mapping is `Object`.
 *
 * @category conversions
 * @since 0.1.0
 * @throws {never}
 */
export const toText = (held: Value): string => {
  if (held === null) return ""
  if (typeof held === "string") return held
  if (typeof held === "number") return numberText(held)
  if (typeof held === "boolean") return String(held)
  return isList(held) ? "Array" : "Object"
}

/**
 * A number as GitHub's runner writes it: with 15 significant digits, and
 * with an exponent, as `1.23456789012346E+17` or `1.234E-06`, when the
 * number has more digits before the point than that or starts more than
 * four zeros after it.
 */
const numberText = (held: number): string => {
  if (!Number.isFinite(held) || (Number.isInteger(held) && Math.abs(held) < 1e15)) return String(held)
  const [digits, exponent] = held.toExponential(14).split("e") as [string, string]
  const power = Number(exponent)
  if (power >= -5 && power < 15) return String(Number(held.toPrecision(15)))
  return `${digits.replace(/\.?0+$/, "")}E${exponent[0]}${exponent.slice(1).padStart(2, "0")}`
}

/**
 * Whether a value counts as true: everything but `false`, `0`, `NaN`, the
 * empty string and `null`.
 *
 * @category conversions
 * @since 0.1.0
 * @throws {never}
 */
export const truthy = (held: Value): boolean =>
  !(held === null || held === false || held === "" || held === 0 || (typeof held === "number" && Number.isNaN(held)))

const typeOf = (held: Value): string => held === null ? "null" : isList(held) ? "array" : typeof held

/** GitHub compares strings without case. */
/**
 * GitHub compares text without case one character at a time: `é` equals `É`, and `ß` does not equal `SS`, which
 * `toUpperCase` of a whole text would make it.
 */
const fold = (text: string): string =>
  [...text].map((character) => {
    const upper = character.toUpperCase()
    return upper.length === character.length ? upper : character
  }).join("")

const equal = (left: Value, right: Value): boolean => {
  if (typeOf(left) !== typeOf(right)) return toNumber(left) === toNumber(right)
  return typeof left === "string" ? fold(left) === fold(right as string) : left === right
}

const ordered = (operator: "<" | "<=" | ">" | ">=", left: Value, right: Value): boolean => {
  const both = typeof left === "string" && typeof right === "string"
  const [a, b] = both ? [fold(left), fold(right)] : [toNumber(left), toNumber(right)]
  if (operator === "<") return a < b
  if (operator === "<=") return a <= b
  return operator === ">" ? a > b : a >= b
}

const compare = (operator: Operator, left: Value, right: Value): boolean => {
  if (operator === "==") return equal(left, right)
  if (operator === "!=") return !equal(left, right)
  return ordered(operator as "<", left, right)
}

const primitive = (held: Value): boolean => held === null || typeof held !== "object"

/**
 * The pieces of a `format` template: text, and the number of the value that
 * goes between. `{{` and `}}` write a brace. `undefined` for a template
 * with a brace that is neither.
 *
 * @category conversions
 * @since 0.1.0
 * @throws {never}
 */
export const formatPieces = (template: string): ReadonlyArray<string | number> | undefined => {
  const pieces: Array<string | number> = []
  let valid = true
  let at = 0
  for (const match of template.matchAll(/\{\{|\}\}|\{(\d+)\}|[{}]/g)) {
    pieces.push(template.slice(at, match.index))
    at = match.index + match[0].length
    if (match[1] !== undefined) pieces.push(Number(match[1]))
    else if (match[0].length === 2) pieces.push(match[0][0] as string)
    else valid = false
  }
  return valid ? [...pieces, template.slice(at)] : undefined
}

/** `format('{0} and {1}', a, b)`. */
const format = (args: ReadonlyArray<Value>): string => {
  const [template, ...values] = args
  const pieces = formatPieces(toText(template as Value))
  if (pieces === undefined) throw problem("format was given a template with a brace that names no value")
  return pieces.map((piece) => {
    if (typeof piece === "string") return piece
    const held = values[piece]
    if (held === undefined) throw problem(`format has no value for {${piece}}`)
    return toText(held)
  }).join("")
}

const fromJson = (text: string): Value => {
  try {
    return JSON.parse(text) as Value
  } catch {
    throw problem("fromJSON was given text that is not JSON")
  }
}

/** The text of two values that are not lists or mappings, without case; `undefined` when one of them is. */
const texts = (left: Value, right: Value): readonly [string, string] | undefined =>
  primitive(left) && primitive(right) ? [fold(toText(left)), fold(toText(right))] : undefined

const contains = (search: Value, item: Value): boolean => {
  if (isList(search)) return search.some((entry) => equal(entry, item))
  const pair = texts(search, item)
  return pair !== undefined && pair[0].includes(pair[1])
}

const startsWith = (text: Value, start: Value): boolean => {
  const pair = texts(text, start)
  return pair !== undefined && pair[0].startsWith(pair[1])
}

const endsWith = (text: Value, end: Value): boolean => {
  const pair = texts(text, end)
  return pair !== undefined && pair[0].endsWith(pair[1])
}

const join = (items: Value, separator: Value | undefined): string =>
  isList(items) ? items.map(toText).join(separator === undefined ? "," : toText(separator)) : toText(items)

type Apply = (args: ReadonlyArray<Value>) => Value

/** The functions whose arguments are all known, with the fewest and the most values each takes. */
const functions: ReadonlyMap<string, readonly [least: number, most: number, apply: Apply]> = new Map<
  string,
  readonly [number, number, Apply]
>([
  ["contains", [2, 2, (args) => contains(args[0] as Value, args[1] as Value)]],
  ["startswith", [2, 2, (args) => startsWith(args[0] as Value, args[1] as Value)]],
  ["endswith", [2, 2, (args) => endsWith(args[0] as Value, args[1] as Value)]],
  ["format", [1, Number.POSITIVE_INFINITY, (args) => format(args)]],
  ["join", [1, 2, (args) => join(args[0] as Value, args[1])]],
  ["tojson", [1, 1, (args) => JSON.stringify(args[0], undefined, 2)]],
  ["fromjson", [1, 1, (args) => fromJson(toText(args[0] as Value))]]
])

const statusNames: ReadonlyArray<keyof Status> = ["success", "always", "cancelled", "failure"]

const literal = (held: Value): Residual => ({ kind: "literal", value: held })

/** A property of a known value. Names are read without case; what is not there is `null`. */
const property = (held: Value, name: Value): Value => {
  if (isList(held)) return typeof name === "number" ? held[name] ?? null : null
  if (!isMapping(held)) return null
  const wanted = toText(name).toLowerCase()
  const key = Object.keys(held).find((candidate) => candidate.toLowerCase() === wanted)
  return key === undefined ? null : held[key] as Value
}

/** What `.*` gives, with the property read from each entry that has it. */
interface Each {
  readonly kind: "each"
  readonly items: ReadonlyArray<Value>
}

/**
 * What {@link finish} gives: the value, or why there is none.
 *
 * @category models
 * @since 0.1.0
 */
export type Finished =
  | { readonly kind: "ok"; readonly value: Value }
  | { readonly kind: "problem"; readonly why: string }

/** The result of `work`, or why it stopped. */
const stopped = <A>(work: () => A): A | Exclude<Evaluated, { readonly kind: "ok" }> => {
  try {
    return work()
  } catch (stop) {
    if (stop instanceof Stop) return stop.result as Exclude<Evaluated, { readonly kind: "ok" }>
    if (stop instanceof RangeError) return { kind: "problem", why: "it nests too deep to read" }
    throw stop
  }
}

const evaluateNode = (node: Node, scope: Scope): Residual => {
  const settle = (found: Context | Each, what: string): Residual => {
    if (found.kind === "value") return literal(found.value)
    if (found.kind === "each") return literal(found.items)
    if (found.kind === "residual") return found.residual
    if (found.kind === "secret") throw new Stop(found)
    throw problem(found.kind === "unknown" ? found.why : `${what} is not one value`)
  }
  const known = (operand: Node, what: string): Value => {
    const residual = walk(operand)
    if (residual.kind !== "literal") throw problem(`${what} is decided while the job runs`)
    return residual.value
  }
  const look = (target: Node): Context | Each => {
    if (target.kind === "name") {
      return scope.context(target.name.toLowerCase()) ??
        unknown(`${target.name} is not a context an expression can read`)
    }
    if (target.kind === "star") {
      const whole = settle(look(target.object), "the value before .*")
      if (whole.kind !== "literal") throw problem("the value before .* is decided while the job runs")
      const held = whole.value
      return { kind: "each", items: isList(held) ? held : isMapping(held) ? Object.values(held) : [] }
    }
    if (target.kind !== "member") return { kind: "residual", residual: walk(target) }
    const owner = look(target.object)
    if (owner.kind === "unknown" || owner.kind === "secret") return owner
    const name = known(target.property, "a property name")
    if (owner.kind === "fields") return owner.field(toText(name))
    if (owner.kind === "each") {
      return { kind: "each", items: owner.items.map((item) => property(item, name)).filter((item) => item !== null) }
    }
    if (owner.kind === "value") return value(property(owner.value, name))
    if (owner.residual.kind === "literal") return value(property(owner.residual.value, name))
    throw problem("a property of a value decided while the job runs")
  }
  const call = (name: string, args: ReadonlyArray<Node>): Residual => {
    if (statusNames.includes(name as keyof Status)) {
      if (args.length !== 0) throw problem(`${name} was given ${args.length} values`)
      if (scope.status === undefined) throw problem(`${name}() has no meaning here`)
      return literal(scope.status[name as keyof Status])
    }
    if (name === "hashfiles") {
      if (scope.hashFiles === undefined) throw problem("hashFiles has no meaning here")
      return settle(scope.hashFiles(args.map((arg) => toText(known(arg, "a hashFiles pattern")))), "hashFiles")
    }
    const found = functions.get(name)
    if (found === undefined) throw problem(`${name} is not a function an expression can call`)
    const [least, most, apply] = found
    if (args.length < least || args.length > most) throw problem(`${name} was given ${args.length} values`)
    const walked = args.map(walk)
    return walked.every((arg) => arg.kind === "literal")
      ? literal(apply(walked.map((arg) => arg.value)))
      : { kind: "call", name, args: walked }
  }
  const walk = (target: Node): Residual => {
    if (target.kind === "literal") return literal(target.value)
    if (target.kind === "not") {
      const operand = walk(target.operand)
      return operand.kind === "literal" ? literal(!truthy(operand.value)) : { kind: "not", operand }
    }
    if (target.kind === "call") return call(target.name, target.args)
    if (target.kind !== "binary") return settle(look(target), "this context")
    const left = walk(target.left)
    const { operator } = target
    if (operator === "&&" || operator === "||") {
      // GitHub stops at the left value when it decides the result, so the right side is never read.
      if (left.kind === "literal") return truthy(left.value) === (operator === "&&") ? walk(target.right) : left
      return { kind: "binary", operator, left, right: walk(target.right) }
    }
    const right = walk(target.right)
    return left.kind === "literal" && right.kind === "literal"
      ? literal(compare(operator, left.value, right.value))
      : { kind: "binary", operator, left, right }
  }
  return walk(node)
}

/**
 * Evaluates one expression, written without `${{ }}`.
 *
 * @category evaluation
 * @since 0.1.0
 * @throws {never}
 */
export const evaluate = (text: string, scope: Scope): Evaluated =>
  stopped(() => ({
    kind: "ok",
    residual: evaluateNode(parse(text), scope)
  }))

/**
 * The variables an expression still to finish reads, once for each place it
 * reads one.
 *
 * @category evaluation
 * @since 0.1.0
 * @throws {never}
 */
export const variablesOf = (node: Residual): ReadonlyArray<Variable> => {
  if (node.kind === "variable") return [node.variable]
  if (node.kind === "not") return variablesOf(node.operand)
  if (node.kind === "binary") return [...variablesOf(node.left), ...variablesOf(node.right)]
  return node.kind === "call" ? node.args.flatMap(variablesOf) : []
}

const valueOf = (node: Residual, known: (found: Variable) => Value): Value => {
  const of = (operand: Residual): Value => valueOf(operand, known)
  if (node.kind === "literal") return node.value
  if (node.kind === "variable") return known(node.variable)
  if (node.kind === "not") return !truthy(of(node.operand))
  if (node.kind === "call") {
    const [, , apply] = functions.get(node.name) as readonly [number, number, Apply]
    return apply(node.args.map(of))
  }
  const left = of(node.left)
  const { operator } = node
  if (operator !== "&&" && operator !== "||") return compare(operator, left, of(node.right))
  return truthy(left) === (operator === "&&") ? of(node.right) : left
}

/**
 * Finishes an expression once `known` gives every variable it reads, by the
 * same rules as {@link evaluate}: a matrix value is known for one variant,
 * so an expression over the matrix has one answer per variant.
 *
 * @category evaluation
 * @since 0.1.0
 * @throws {never}
 */
export const finish = (node: Residual, known: (found: Variable) => Value): Finished =>
  // A value is all these functions read, so what stops them is always a problem.
  stopped(() => ({ kind: "ok", value: valueOf(node, known) })) as Finished

/**
 * One piece of text with expressions in it: text, or an expression still to
 * finish while the job runs, with the `${{ }}` the workflow wrote for it.
 *
 * @category models
 * @since 0.1.0
 */
export type Part = string | { readonly residual: Residual; readonly written: string }

/**
 * The result of filling a text: its pieces, why one expression cannot be
 * evaluated, or the secret one reads.
 *
 * @category models
 * @since 0.1.0
 */
export type Filled =
  | { readonly kind: "ok"; readonly parts: ReadonlyArray<Part> }
  | { readonly kind: "problem"; readonly why: string }
  | { readonly kind: "secret"; readonly name: string }

/** Where the expression that starts at `from` ends: the first `}}` outside a string. */
const closing = (text: string, from: number): number => {
  let quoted = false
  for (let at = from; at < text.length - 1; at += 1) {
    if (text[at] === "'") quoted = !quoted
    else if (!quoted && text[at] === "}" && text[at + 1] === "}") return at
  }
  return -1
}

/**
 * The expressions in a text, each with the text before it, and the text
 * after the last.
 *
 * @category evaluation
 * @since 0.1.0
 * @throws {never}
 */
export const split = (
  text: string
): {
  readonly pieces: ReadonlyArray<readonly [before: string, expression: string, written: string]>
  readonly rest: string
} => {
  const pieces: Array<readonly [string, string, string]> = []
  let at = 0
  for (;;) {
    const open = text.indexOf("${{", at)
    const close = open < 0 ? -1 : closing(text, open + 3)
    if (close < 0) return { pieces, rest: text.slice(at) }
    pieces.push([text.slice(at, open), text.slice(open + 3, close).trim(), text.slice(open, close + 2)])
    at = close + 2
  }
}

/**
 * Fills every `${{ }}` in a text. Text and known values are joined; an
 * expression decided while the job runs stays as its own piece.
 *
 * @category evaluation
 * @since 0.1.0
 * @throws {never}
 */
export const fill = (text: string, scope: Scope): Filled => {
  const { pieces, rest } = split(text)
  const parts: Array<Part> = []
  const add = (part: Part): void => {
    const last = parts.at(-1)
    if (typeof part === "string" && typeof last === "string") parts[parts.length - 1] = last + part
    else if (part !== "") parts.push(part)
  }
  for (const [before, expression, written] of pieces) {
    const evaluated = evaluate(expression, scope)
    if (evaluated.kind !== "ok") {
      return evaluated.kind === "problem" ? { kind: "problem", why: `${expression}: ${evaluated.why}` } : evaluated
    }
    add(before)
    add(
      evaluated.residual.kind === "literal"
        ? toText(evaluated.residual.value)
        : { residual: evaluated.residual, written }
    )
  }
  add(rest)
  return { kind: "ok", parts }
}

/**
 * The expression a whole text is, or `undefined` when it is text with
 * expressions in it. `if:` may be written without `${{ }}`, so with
 * `bare` a text holding none is an expression too. Nothing is trimmed: on
 * GitHub `${{ x }}` followed by a space or a line end is text, not `x`.
 *
 * @category evaluation
 * @since 0.1.0
 * @throws {never}
 */
export const whole = (text: string, bare = false): string | undefined => {
  const { pieces, rest } = split(text)
  if (pieces.length === 0) return bare ? rest : undefined
  const [first] = pieces
  return first !== undefined && pieces.length === 1 && first[0] === "" && rest === "" ? first[1] : undefined
}
