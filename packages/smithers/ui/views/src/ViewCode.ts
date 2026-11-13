/**
 * Checks a generated view's TSX module before it runs, and compiles it.
 *
 * A renderer agent writes one module:
 *
 * ```tsx
 * import { Button, Card } from "@smthrs/ui"
 * import type { ViewProps } from "smithers:view"
 * export const interactions = { cell: { kind: "state" }, ask: { kind: "message", label: "Play" } }
 * export const reduce = (state: Board, event: { name: string; arg?: string }): Board => ...
 * export default function View({ props, state }: ViewProps<Board>) { ... }
 * ```
 *
 * {@link check} parses it with `@babel/parser`, refuses what a view may not
 * do, reads its `interactions` export, and compiles it with `sucrase` to the
 * CommonJS body `PresentationRealm` runs. It reports every problem it finds,
 * with a line and column, so a renderer can correct the module in one step.
 *
 * The checker is depth, not the boundary. The QuickJS realm has no network,
 * storage, clock or page to reach, and the frame's sanitizer and CSP stand
 * behind the HTML it produces.
 *
 * What it refuses:
 *
 * - more than {@link maxSourceBytes} of source, or text with a lone surrogate;
 * - imports other than `react`, `@smthrs/ui` (only the components the
 *   presentation bundle carries) and `smithers:view`;
 * - dynamic `import()`, `import.meta`, `require`, `export ... from`, and
 *   exports other than `default`, `interactions`, `reduce` and types;
 * - names that reach the network, storage, the page, a clock, randomness or
 *   code evaluation, such as `fetch`, `localStorage`, `document`, `location`,
 *   `top`, `parent`, `opener`, `setTimeout`, `Date`, `Math.random` and `eval`;
 * - properties such as `constructor`, `__proto__`, `prototype` and
 *   `dangerouslySetInnerHTML`;
 * - the elements `script`, `iframe`, `object`, `embed`, `link`, `meta`,
 *   `base`, `a`, `style` and others that load, navigate or run script;
 * - attributes such as `href`, `src` (outside a `data:image` `<img>`),
 *   `action`, `formAction`, `srcSet`, `xlink:href` and every `on*` handler;
 * - `javascript:` URLs and HTML comment tokens anywhere in the text;
 * - a `data-event` literal naming an event the module does not declare.
 *
 * @since 0.1.0
 */

import { parse } from "@babel/parser"
import { digestSync } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { transform } from "sucrase"
import * as Interactions from "./Interactions.ts"
import { utf8Length } from "./internal/bytes.ts"
import {
  attributeRefusal,
  isRefusedElement,
  refusedNames,
  refusedProperties,
  scriptScheme
} from "./internal/vocabulary.ts"

/**
 * The largest module source, in UTF-8 bytes.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxSourceBytes = 64 * 1024

/**
 * The most problems one check reports.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxProblems = 20

/**
 * The modules a view may import.
 *
 * @category constants
 * @since 0.1.0
 */
export const modules = ["react", "@smthrs/ui", "smithers:view"] as const

/**
 * The values a view may import from `react`. Types may be imported freely.
 *
 * @category constants
 * @since 0.1.0
 */
export const reactValues: ReadonlyArray<string> = [
  "Children",
  "Fragment",
  "cloneElement",
  "createElement",
  "isValidElement"
]

/**
 * The values a view may import from `smithers:view`. Its types, `ViewProps`
 * and `ViewEvent`, may be imported too.
 *
 * @category constants
 * @since 0.1.0
 */
export const viewValues: ReadonlyArray<string> = ["event"]

const viewTypes: ReadonlyArray<string> = ["ViewProps", "ViewEvent"]

/**
 * One thing wrong with a module, with its 1-based line and 0-based column
 * when it has a place.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Problem = Schema.Struct({
  message: Schema.String,
  line: Schema.optionalKey(Schema.Int),
  column: Schema.optionalKey(Schema.Int)
})

/**
 * One thing wrong with a module.
 *
 * @category models
 * @since 0.1.0
 */
export type Problem = typeof Problem.Type

/**
 * Why a module failed its check:
 *
 * - `too_large`: over {@link maxSourceBytes};
 * - `malformed_text`: a lone UTF-16 surrogate;
 * - `syntax`: it does not parse or compile as TSX;
 * - `refused`: it parses, but does something a view may not.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Reason = Schema.Literals(["too_large", "malformed_text", "syntax", "refused"])

/** A failure's message by reason: fixed text, so a span, a log line or a caller's error report carries no content. */
const sentences: Readonly<Record<typeof Reason.Type, string>> = {
  too_large: "The view's module is too large",
  malformed_text: "The view's module is not well-formed text",
  syntax: "The view's module does not parse",
  refused: "The view's module does something a view may not"
}

/**
 * The module failed its check.
 *
 * `detail`, one line per problem as `line:column: message`, and `problems`
 * are written for the renderer that wrote the module. They quote its
 * identifiers and text, which a model can fill with conversation content, so
 * both are redacted and print as `<redacted>`; read them with
 * `Redacted.value` for a correction prompt, never for a log, a span or a
 * metric. `message` names only the reason, so an ordinary span or log line
 * around a check carries no module content.
 *
 * @category errors
 * @since 0.1.0
 */
export class ViewCodeError extends Schema.TaggedError<ViewCodeError>()("@smthrs/views/ViewCodeError", {
  reason: Reason,
  detail: Schema.Redacted(Schema.String),
  problems: Schema.Redacted(Schema.Array(Problem))
}) {
  /** The reason as a sentence; never the module's words. */
  override get message(): string {
    return sentences[this.reason]
  }
}

/**
 * A module that passed its check.
 *
 * - `source`: the TSX as written;
 * - `compiled`: the CommonJS body `PresentationRealm` evaluates;
 * - `digest`: the SHA-256 of `source`, as lowercase hex;
 * - `interactions`: the module's declared events;
 * - `reduces`: whether it exports `reduce`.
 *
 * @category schemas
 * @since 0.1.0
 */
export class CheckedModule extends Schema.Class<CheckedModule>("@smthrs/views/CheckedModule")({
  source: Schema.String,
  compiled: Schema.String,
  digest: Schema.String,
  interactions: Interactions.Declared,
  reduces: Schema.Boolean
}) {}

/**
 * What a check needs besides the source: the component names the
 * presentation bundle carries, which a module may import from `@smthrs/ui`.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckOptions {
  readonly components: ReadonlyArray<string>
}

/** A Babel node, read structurally. */
interface Node {
  readonly type: string
  readonly loc?: { readonly start: { readonly line: number; readonly column: number } } | null
  readonly [key: string]: unknown
}

const skippedKeys = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
  "errors",
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
  "superTypeParameters",
  "superTypeArguments",
  "implements",
  "predicate"
])

/** TypeScript nodes that carry runtime code, walked through their expression; every other `TS*` node is erased. */
const runtimeTypeScript = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSInstantiationExpression",
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember",
  "TSParameterProperty"
])

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"

/** TypeScript the compiler erases, so never walked. */
const isTypeOnly = (node: Node): boolean =>
  (node.type.startsWith("TS") && !runtimeTypeScript.has(node.type)) ||
  (node.type === "ImportDeclaration" && node.importKind === "type") ||
  (node.type === "ExportNamedDeclaration" && node.exportKind === "type")

const nameOf = (node: Node): string | undefined => {
  if (node.type === "Identifier" || node.type === "JSXIdentifier") return node.name as string
  if (node.type === "StringLiteral") return node.value as string
  return undefined
}

const isWellFormed = (text: string): boolean => {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

/** The JSON value of a literal `interactions` object, or `undefined` when it is not one. */
const literalValue = (node: unknown): unknown => {
  if (!isNode(node)) return undefined
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return literalValue(node.expression)
    case "StringLiteral":
      return node.value
    case "ObjectExpression": {
      const value: Record<string, unknown> = Object.create(null)
      for (const property of node.properties as Array<Node>) {
        if (property.type !== "ObjectProperty" || property.computed === true) return undefined
        const key = nameOf(property.key as Node)
        const entry = literalValue(property.value)
        if (key === undefined || entry === undefined) return undefined
        value[key] = entry
      }
      return value
    }
    default:
      return undefined
  }
}

const decodeDeclared = Schema.decodeUnknownOption(Interactions.Declared)

/** What a walk over one module learned. */
interface Findings {
  readonly problems: Array<Problem>
  interactions: Interactions.Declared | undefined
  interactionsNode: Node | undefined
  hasDefault: boolean
  reduces: boolean
  readonly dataEvents: Array<{ readonly value: string; readonly node: Node }>
}

const at = (node: Node, message: string): Problem => ({
  message,
  line: node.loc!.start.line,
  column: node.loc!.start.column
})

/** The 1-based line and 0-based column of an offset into the source. */
const placeOf = (source: string, offset: number): Pick<Problem, "line" | "column"> => {
  const before = source.slice(0, offset)
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n") - 1 }
}

/** Checks one import declaration against the modules and names a view may use. */
const checkImport = (node: Node, components: ReadonlySet<string>, findings: Findings, react: Set<string>) => {
  const source = nameOf(node.source as Node)!
  if (!(modules as ReadonlyArray<string>).includes(source)) {
    findings.problems.push(at(node, `A view may import only react, @smthrs/ui and smithers:view, not ${source}`))
    return
  }
  for (const specifier of node.specifiers as Array<Node>) {
    if (specifier.importKind === "type") continue
    const local = nameOf(specifier.local as Node)!
    if (specifier.type !== "ImportSpecifier") {
      if (source === "react") react.add(local)
      else findings.problems.push(at(specifier, `Import named components from ${source}, not a namespace or default`))
      continue
    }
    const imported = nameOf(specifier.imported as Node)!
    const allowed = source === "react"
      ? reactValues.includes(imported)
      : source === "smithers:view"
      ? viewValues.includes(imported) || viewTypes.includes(imported)
      : components.has(imported)
    if (!allowed) {
      findings.problems.push(at(
        specifier,
        source === "@smthrs/ui"
          ? `@smthrs/ui has no view component ${imported}; use one of ${[...components].sort().join(", ")}`
          : `${source} has no view value ${imported}; import types with \`import type\``
      ))
    }
  }
}

/** Follows local aliases and erased wrappers to check a synchronous entry point. */
const checkSynchronous = (
  value: unknown,
  name: string,
  bindings: ReadonlyMap<string, Node>,
  findings: Findings
) => {
  const seen = new Set<Node>()
  while (isNode(value) && !seen.has(value)) {
    seen.add(value)
    if (value.type === "Identifier") {
      value = bindings.get(value.name as string)
    } else if (
      ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSInstantiationExpression"].includes(
        value.type
      )
    ) {
      value = value.expression
    } else {
      if (value.async === true || value.generator === true) {
        findings.problems.push(at(value, `${name} must be a synchronous, non-generator function`))
      }
      return
    }
  }
}

/** Checks one top-level export against the module contract. */
const checkExport = (node: Node, findings: Findings, bindings: ReadonlyMap<string, Node>) => {
  if (node.type === "ExportDefaultDeclaration") {
    findings.hasDefault = true
    checkSynchronous(node.declaration, "default", bindings, findings)
    return
  }
  if (node.type === "ExportAllDeclaration" || node.source !== null && node.source !== undefined) {
    findings.problems.push(at(node, "A view may not re-export another module"))
    return
  }
  const declaration = node.declaration
  const names: Array<{ readonly name: string; readonly init: unknown; readonly node: Node }> = []
  if (isNode(declaration) && declaration.type === "VariableDeclaration") {
    for (const declarator of declaration.declarations as Array<Node>) {
      const id = declarator.id as Node
      names.push({ name: nameOf(id) ?? "a destructured binding", init: declarator.init, node: declarator })
    }
  } else if (isNode(declaration)) {
    names.push({ name: String(nameOf(declaration.id as Node)), init: declaration, node: declaration })
  } else {
    for (const specifier of node.specifiers as Array<Node>) {
      if (specifier.exportKind === "type") continue
      const name = nameOf(specifier.exported as Node)!
      names.push({ name, init: specifier.local, node: specifier })
    }
  }
  for (const { init, name, node: place } of names) {
    if (name === "reduce" || name === "default") {
      if (name === "reduce") findings.reduces = true
      else findings.hasDefault = true
      checkSynchronous(init, name, bindings, findings)
    } else if (name === "interactions") {
      const value = literalValue(init)
      const declared = value === undefined ? Option.none() : decodeDeclared(value)
      findings.interactionsNode = place
      if (Option.isNone(declared)) {
        findings.problems.push(at(
          place,
          "interactions must be an object literal of { kind: \"state\" } or { kind: \"message\", label } entries, " +
            `at most ${Interactions.maxDeclared}, named like "cell" or "play-again"`
        ))
      } else findings.interactions = declared.value
    } else findings.problems.push(at(place, `A view exports only default, interactions and reduce, not ${name}`))
  }
}

/** Checks one JSX opening element's name and attributes. */
const checkElement = (node: Node, findings: Findings) => {
  const name = node.name as Node
  const element = name.type === "JSXIdentifier" ? (name.name as string) : ""
  if (/^[A-Z]/.test(element) && refusedNames.has(element)) {
    findings.problems.push(at(node, `${element} is refused in a view`))
  }
  if (name.type === "JSXNamespacedName") findings.problems.push(at(node, "Namespaced elements are refused in a view"))
  if (/^[a-z]/.test(element) && isRefusedElement(element)) {
    findings.problems.push(at(node, `<${element}> is refused in a view`))
  }
  for (const attribute of node.attributes as Array<Node>) {
    if (attribute.type !== "JSXAttribute") continue
    const attributeName = attribute.name as Node
    if (attributeName.type === "JSXNamespacedName") {
      findings.problems.push(at(attribute, "Namespaced attributes such as xlink:href are refused in a view"))
      continue
    }
    const key = attributeName.name as string
    const value = attribute.value
    const literal = isNode(value) && value.type === "StringLiteral" ? (value.value as string) : undefined
    const refusal = attributeRefusal(/^[a-z]/.test(element) ? element : "", key, literal)
    if (refusal !== undefined) findings.problems.push(at(attribute, refusal))
    if (key === "data-event" && literal !== undefined) findings.dataEvents.push({ value: literal, node: attribute })
  }
}

/** Whether `node`, met under `parent` at `key`, is a name being referenced rather than a label or a key. */
const isReference = (parent: Node, key: string): boolean => {
  switch (parent.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
      return key !== "property" || parent.computed === true
    case "ObjectProperty":
    case "ObjectMethod":
    case "ClassMethod":
    case "ClassProperty":
    case "ClassPrivateProperty":
    case "ClassAccessorProperty":
      return key !== "key" || parent.computed === true
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return false
    default:
      return true
  }
}

const propertyName = (node: Node): string | undefined =>
  node.computed === true
    ? ((node.property as Node).type === "StringLiteral" ? (node.property as Node).value as string : undefined)
    : nameOf(node.property as Node)

/** Walks the module once, iteratively so a deeply nested module cannot exhaust the host's stack. */
const walk = (program: Node, components: ReadonlySet<string>, findings: Findings) => {
  const react = new Set<string>()
  const bindings = new Map<string, Node>()
  for (const statement of program.body as Array<Node>) {
    const declaration = isNode(statement.declaration) ? statement.declaration : statement
    if (declaration.type === "VariableDeclaration") {
      for (const binding of declaration.declarations as Array<Node>) {
        const name = nameOf(binding.id as Node)
        if (name !== undefined && isNode(binding.init)) bindings.set(name, binding.init)
      }
    } else if (declaration.type === "FunctionDeclaration" && isNode(declaration.id)) {
      bindings.set(nameOf(declaration.id)!, declaration)
    }
  }
  const stack: Array<
    { readonly node: Node; readonly parent: Node; readonly key: string; readonly inFunction: boolean }
  > = []
  for (const statement of program.body as Array<Node>) {
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
      checkImport(statement, components, findings, react)
    } else if (statement.type.startsWith("Export")) {
      if (!isTypeOnly(statement)) checkExport(statement, findings, bindings)
    } else if (statement.type === "TSImportEqualsDeclaration" || statement.type === "TSExportAssignment") {
      findings.problems.push(at(statement, "A view may not use require-style imports or exports"))
    } else if (statement.type === "TSModuleDeclaration") {
      findings.problems.push(at(statement, "Namespaces and declare blocks are refused in a view"))
    }
    stack.push({ node: statement, parent: program, key: "body", inFunction: false })
  }
  while (stack.length > 0) {
    const { inFunction, key, node, parent } = stack.pop()!
    if (isTypeOnly(node) || node.type === "ImportDeclaration") continue
    switch (node.type) {
      case "AwaitExpression":
      case "ForOfStatement":
        if (!inFunction && (node.type === "AwaitExpression" || node.await === true)) {
          findings.problems.push(at(node, "Top-level await is refused in a view"))
        }
        break
      case "ImportExpression":
        findings.problems.push(at(node, "Dynamic import() is refused in a view"))
        break
      case "MetaProperty":
        if (nameOf(node.meta as Node) === "import") findings.problems.push(at(node, "import.meta is refused in a view"))
        break
      case "DebuggerStatement":
        findings.problems.push(at(node, "debugger is refused in a view"))
        break
      case "Identifier": {
        const name = node.name as string
        if (
          name === "Math" && isReference(parent, key) &&
          !((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
            key === "object" && propertyName(parent) !== undefined)
        ) {
          findings.problems.push(at(node, "Math.random is refused in a view; use direct deterministic Math members"))
        }
        if (isReference(parent, key) && refusedNames.has(name)) {
          findings.problems.push(at(node, `${name} is refused in a view`))
        }
        if (
          !isReference(parent, key) && refusedProperties.has(name) &&
          !(parent.type === "ClassMethod" && parent.kind === "constructor" && key === "key")
        ) {
          findings.problems.push(at(node, `The property ${name} is refused in a view`))
        }
        break
      }
      case "MemberExpression":
      case "OptionalMemberExpression":
      case "JSXMemberExpression": {
        const property = propertyName(node)
        const object = nameOf(node.object as Node)
        if (
          property !== undefined && (node.computed === true || node.type === "JSXMemberExpression") &&
          refusedProperties.has(property)
        ) {
          findings.problems.push(at(node, `The property ${property} is refused in a view`))
        }
        if (node.type === "JSXMemberExpression" && object !== undefined && refusedNames.has(object)) {
          findings.problems.push(at(node, `${object} is refused in a view`))
        }
        if (object === "Math" && property === "random") {
          findings.problems.push(at(node, "Math.random is refused in a view"))
        }
        if (object !== undefined && react.has(object) && property !== undefined && !reactValues.includes(property)) {
          findings.problems.push(at(node, `React.${property} is refused in a view; use ${reactValues.join(", ")}`))
        }
        break
      }
      case "ObjectProperty":
        if (
          (node.computed === true || (node.key as Node).type === "StringLiteral") &&
          refusedProperties.has(nameOf(node.key as Node) ?? "")
        ) {
          findings.problems.push(at(node, `The property ${nameOf(node.key as Node)} is refused in a view`))
        }
        break
      case "StringLiteral":
      case "TemplateElement":
      case "JSXText": {
        const text = node.type === "TemplateElement"
          ? (node.value as { readonly raw: string }).raw
          : node.value as string
        if (scriptScheme.test(text)) findings.problems.push(at(node, "javascript: URLs are refused in a view"))
        break
      }
      case "JSXOpeningElement":
        checkElement(node, findings)
        break
      case "CallExpression": {
        const callee = node.callee as Node
        const created = nameOf(callee) === "createElement" ||
          (callee.type === "MemberExpression" && nameOf(callee.property as Node) === "createElement")
        const [first] = node.arguments as Array<Node>
        if (created && first?.type === "StringLiteral" && isRefusedElement(first.value as string)) {
          findings.problems.push(at(node, `<${first.value as string}> is refused in a view`))
        }
        break
      }
    }
    for (const child of Object.keys(node)) {
      if (skippedKeys.has(child)) continue
      const childInFunction = inFunction || (child !== "key" && child !== "decorators" && [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
        "ObjectMethod",
        "ClassMethod",
        "ClassPrivateMethod"
      ].includes(node.type))
      const value = node[child]
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) {
          const item: unknown = value[index]
          if (isNode(item)) stack.push({ node: item, parent: node, key: child, inFunction: childInFunction })
        }
      } else if (isNode(value)) stack.push({ node: value, parent: node, key: child, inFunction: childInFunction })
    }
  }
}

const fail = (reason: typeof Reason.Type, problems: ReadonlyArray<Problem>) => {
  const kept = problems.slice(0, maxProblems)
  return new ViewCodeError({
    reason,
    detail: Redacted.make(
      kept.map((problem) =>
        problem.line === undefined ? problem.message : `${problem.line}:${problem.column}: ${problem.message}`
      ).join("\n")
    ),
    problems: Redacted.make(kept)
  })
}

/** Source order. Every refusal has a place. */
const byPlace = (left: Problem, right: Problem): number => left.line! - right.line! || left.column! - right.column!

/** Both compilers throw `Error`s; a `RangeError` is the host's stack, not the module's syntax. */
const errorText = (error: unknown): string =>
  error instanceof RangeError ? "The module is nested too deeply" : (error as Error).message

const location = (error: unknown): Pick<Problem, "line" | "column"> => {
  const loc = (error as { readonly loc?: { readonly line?: unknown; readonly column?: unknown } }).loc
  return typeof loc?.line === "number" && typeof loc.column === "number" ? { line: loc.line, column: loc.column } : {}
}

/**
 * Checks and compiles a view module.
 *
 * @category checking
 * @since 0.1.0
 */
export const check = (source: string, options: CheckOptions): Effect.Effect<CheckedModule, ViewCodeError> =>
  Effect.suspend(() => {
    if (utf8Length(source) > maxSourceBytes) {
      return Effect.fail(fail("too_large", [{ message: `A view module is at most ${maxSourceBytes} bytes` }]))
    }
    if (!isWellFormed(source)) {
      return Effect.fail(fail("malformed_text", [{ message: "The module contains a lone UTF-16 surrogate" }]))
    }
    let program: Node
    try {
      program = parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] }).program as unknown as Node
    } catch (error) {
      return Effect.fail(fail("syntax", [{ message: errorText(error), ...location(error) }]))
    }
    const findings: Findings = {
      problems: [],
      interactions: undefined,
      interactionsNode: undefined,
      hasDefault: false,
      reduces: false,
      dataEvents: []
    }
    const comment = source.search(/<!--|-->/)
    if (comment !== -1) {
      findings.problems.push({
        message: "HTML comment tokens <!-- and --> are refused in a view",
        ...placeOf(source, comment)
      })
    }
    walk(program, new Set(options.components), findings)
    const declared = findings.interactions ?? {}
    if (!findings.hasDefault) {
      findings.problems.push({
        message: "A view's default export must be its component",
        ...placeOf(source, source.length)
      })
    }
    if (!findings.reduces && Object.values(declared).some((interaction) => interaction.kind === "state")) {
      findings.problems.push(
        at(findings.interactionsNode!, "A state interaction needs an exported reduce(state, event)")
      )
    }
    for (const { node, value } of findings.dataEvents) {
      const event = Interactions.parse(value)
      if (Option.isNone(event)) {
        findings.problems.push(at(node, `data-event="${value}" is not "name" or "name:arg"`))
      } else if (Option.isNone(Interactions.lookup(declared, event.value.name))) {
        findings.problems.push(at(node, `data-event names ${event.value.name}, which interactions does not declare`))
      }
    }
    if (findings.problems.length > 0) return Effect.fail(fail("refused", findings.problems.sort(byPlace)))
    let compiled: string
    try {
      compiled = transform(source, {
        transforms: ["typescript", "jsx", "imports"],
        jsxRuntime: "automatic",
        production: true
      }).code
    } catch (error) {
      return Effect.fail(fail("syntax", [{ message: errorText(error), ...location(error) }]))
    }
    return Effect.succeed(
      new CheckedModule({
        source,
        compiled,
        digest: digestSync(source),
        interactions: declared,
        reduces: findings.reduces
      })
    )
  })
