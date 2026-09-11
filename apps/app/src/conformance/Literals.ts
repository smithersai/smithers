/*
 * The literal extractor behind the conformance pin.
 *
 * A test suite asserts against the application's vocabulary with string
 * literals, and a string literal is invisible to `tsc`: renaming a card kind,
 * a flow, or a DOM attribute leaves every assertion that names the old value
 * compiling, running, and comparing against something that no longer exists.
 * That is how nineteen dead literals in `scripts/worker-e2e.ts` survived the
 * 2026-08-15 `command`→`flow` rename with the suite green for three days.
 *
 * This module pulls the literals back out of the suites so they can be checked
 * against vocabularies derived from the app itself (see `Vocabulary.ts`).
 * Parsing is done with the TypeScript compiler's own parser, so comments,
 * regular expressions, and nested quoting cannot be mistaken for source.
 *
 * WHAT THE EXTRACTOR CAN SEE
 *  - every string literal and every static chunk of a template literal,
 *    with its file and line;
 *  - which call the literal is an argument of, and at which index;
 *  - the property name a literal is assigned to in an object literal, and the
 *    other property names that object carries;
 *  - whether the literal is one side of an `===`/`!==` whose other side is a
 *    `.kind` property read;
 *  - whether the literal reaches a card-kind position by any route the file
 *    itself spells out. Positions are discovered, never listed: a name the
 *    file compares against `.kind` — with `===`/`!==`, as a `switch` case, or
 *    as the collection a `KINDS.has(card.kind)` tests against — or
 *    interpolates straight after `[data-kind=`, is a card-kind position, and
 *    that fact propagates to the parameter it binds, to every argument passed
 *    at that parameter's index, and on through local `const`s, ternary
 *    branches, array members, `for…of` sources, destructuring defaults and
 *    single-argument formatting or wrapping calls until nothing new is
 *    reached. Checking a kind only inside `[data-kind="…"]` and
 *    `x.kind === "…"` was the first cut of this extractor, and it left the pin
 *    blind to `cardOfKind(client, "…")` — which is how the suites pass a kind
 *    most of the time;
 *  - `data-*` attribute names spelled anywhere inside a literal, which is how
 *    CSS selectors carry the DOM contract into a CDP expression.
 *
 * WHAT IT CANNOT SEE, and therefore never reports
 *  - a name assembled at runtime (`command.failed.${name}`): only the static
 *    head is visible, and a head that is not a complete vocabulary member is
 *    not checked. A kind built by concatenation is invisible for the same
 *    reason — there is no literal to check;
 *  - a computed property or a value read out of JSON at run time;
 *  - a literal that reaches the page through a variable defined in another
 *    module, or a kind position established in another module. Propagation
 *    stops at the file edge. The pin is per-file and syntactic on purpose: it
 *    must run in the fast unit gate, and a whole-program dataflow analysis
 *    would not;
 *  - which of two same-named declarations a name binds to, past ordinary
 *    lexical nesting. Resolution walks enclosing functions and blocks for a
 *    parameter or `const` of that name and takes the first; it does not model
 *    hoisting, reassignment, or shadowing inside a nested block of the same
 *    function;
 *  - a kind position reached through anything other than a direct call by
 *    name. A helper stored in an object, passed as a callback, or invoked
 *    through a variable of another name propagates nothing;
 *  - a kind a function RETURNS. Propagation follows values into a call, never
 *    out of one: `if (card.kind === kindFor(row))` marks nothing inside
 *    `kindFor`. Following returns would mean modelling control flow, which is
 *    the line this extractor does not cross;
 *  - whether a position it did find is reachable. The pin is syntactic, so a
 *    kind inside dead code is checked exactly like a live one. That direction
 *    is the safe one: it over-reports rather than under-reports.
 *
 * The consequence of all four is one rule for reading a green run: this pin
 * proves that the literals it CAN see resolve. It is a floor under the suites,
 * not a proof that every name they use is live.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

/** Where a literal was found and what syntactic position it sits in. */
export interface ExtractedLiteral {
  /** The decoded text of the literal — escapes already resolved. */
  readonly value: string
  /** Absolute path of the file it was found in. */
  readonly file: string
  /** 1-indexed line, for an error message that can be jumped to. */
  readonly line: number
  /** A complete literal, or the static head/chunk of an interpolated template. */
  readonly form: "string" | "template-head" | "template-chunk"
  /** The callee name when this literal is the first argument of a call. */
  readonly leadingArgumentOf: string | undefined
  /** The callee name and argument index when this literal is any argument of a call. */
  readonly argumentOf: ArgumentPosition | undefined
  /** The property name this literal is assigned to in an object literal. */
  readonly propertyName: string | undefined
  /** Every property name of the object literal this one sits in, this literal's own included. */
  readonly siblingProperties: ReadonlyArray<string>
  /** True when the literal is compared with `===`/`!==` against a `.kind` read. */
  readonly kindComparison: boolean
  /**
   * True when the literal reaches a card-kind position by any route the file
   * spells out — the comparison above included. This is what a card-kind rule
   * reads; `kindComparison` stays the narrow syntactic fact it always was.
   */
  readonly kindClaim: boolean
}

/** Where a literal sits in an argument list. */
export interface ArgumentPosition {
  /** The callee's simple name: `cardOfKind(client, kind)` → `cardOfKind`. */
  readonly callee: string
  /** 0-indexed position in the argument list. */
  readonly index: number
}

const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Every TypeScript source file under `directory`, recursively, sorted. */
export const sourceFiles = (directory: string): ReadonlyArray<string> => {
  if (!isDirectory(directory)) return []
  const entries = readdirSync(directory, { withFileTypes: true })
  const found = entries.flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return [...sourceFiles(path)]
    return SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : []
  })
  return found.sort()
}

/** The callee's simple name: `page.evaluate(...)` → `evaluate`, `fail(...)` → `fail`. */
const calleeName = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return undefined
}

/** A `.kind` read, the left-hand side of every card-kind comparison in the suites. */
const isKindRead = (node: ts.Node): boolean => ts.isPropertyAccessExpression(node) && node.name.text === "kind"

const COMPARISONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken
])

type CallContext = Pick<ExtractedLiteral, "leadingArgumentOf" | "argumentOf" | "kindComparison">

const NO_CALL_CONTEXT: CallContext = { leadingArgumentOf: undefined, argumentOf: undefined, kindComparison: false }

const contextOf = (node: ts.Node): CallContext => {
  const parent = node.parent as ts.Node | undefined
  if (parent === undefined) return NO_CALL_CONTEXT
  if (ts.isCallExpression(parent)) {
    const index = parent.arguments.indexOf(node as ts.Expression)
    if (index < 0) return NO_CALL_CONTEXT
    const callee = calleeName(parent.expression)
    return {
      leadingArgumentOf: index === 0 ? callee : undefined,
      argumentOf: callee === undefined ? undefined : { callee, index },
      kindComparison: false
    }
  }
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) {
    const other = parent.left === node ? parent.right : parent.left
    return { ...NO_CALL_CONTEXT, kindComparison: isKindRead(other) }
  }
  return NO_CALL_CONTEXT
}

/** The property name a literal is written under, and every name its object carries. */
const objectContextOf = (node: ts.Node): Pick<ExtractedLiteral, "propertyName" | "siblingProperties"> => {
  const assignment = node.parent as ts.Node | undefined
  if (assignment === undefined || !ts.isPropertyAssignment(assignment) || assignment.initializer !== node) {
    return { propertyName: undefined, siblingProperties: [] }
  }
  const object = assignment.parent as ts.Node | undefined
  const siblings = object !== undefined && ts.isObjectLiteralExpression(object)
    ? object.properties.flatMap((property) => (property.name === undefined ? [] : [...nameTextOf(property.name)]))
    : []
  return { propertyName: nameTextOf(assignment.name)[0], siblingProperties: siblings }
}

/** A property name as written, when it is written plainly. Computed names have no static text. */
const nameTextOf = (name: ts.PropertyName): ReadonlyArray<string> =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? [name.text] : []

/** `(x)`, `x as const`, `x!` and `x satisfies T` all name the same expression. */
const unwrap = (expression: ts.Expression): ts.Expression => {
  if (ts.isParenthesizedExpression(expression)) return unwrap(expression.expression)
  if (ts.isAsExpression(expression)) return unwrap(expression.expression)
  if (ts.isSatisfiesExpression(expression)) return unwrap(expression.expression)
  if (ts.isNonNullExpression(expression)) return unwrap(expression.expression)
  return expression
}

/** The name a function answers to at a call site, when it has one. */
const declaredFunctionName = (fn: ts.SignatureDeclaration): string | undefined => {
  if (
    (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined && ts.isIdentifier(fn.name)
  ) {
    return fn.name.text
  }
  const parent = fn.parent as ts.Node | undefined
  if (parent === undefined) return undefined
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  return undefined
}

/**
 * What a name binds to: an argument position other call sites fill, or an
 * expression that already holds the value.
 */
type Binding =
  | { readonly form: "parameter"; readonly callee: string; readonly index: number }
  | { readonly form: "value"; readonly expression: ts.Expression }

/** The `const` or destructuring default a block declares under `name`. */
const declaredValue = (statements: ts.NodeArray<ts.Statement>, name: string): ts.Expression | undefined => {
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        if (declaration.name.text === name) return declaration.initializer
        continue
      }
      for (const element of declaration.name.elements) {
        if (ts.isBindingElement(element) && ts.isIdentifier(element.name) && element.name.text === name) {
          return element.initializer
        }
      }
    }
  }
  return undefined
}

/** The parameter or default a function-like node declares under `name`. */
const parameterBindings = (fn: ts.SignatureDeclaration, name: string): ReadonlyArray<Binding> => {
  const found: Array<Binding> = []
  fn.parameters.forEach((parameter, index) => {
    if (ts.isIdentifier(parameter.name)) {
      if (parameter.name.text !== name) return
      if (parameter.initializer !== undefined) found.push({ form: "value", expression: parameter.initializer })
      const callee = declaredFunctionName(fn)
      if (callee !== undefined) found.push({ form: "parameter", callee, index })
      return
    }
    for (const element of parameter.name.elements) {
      if (
        ts.isBindingElement(element) && ts.isIdentifier(element.name) && element.name.text === name
        && element.initializer !== undefined
      ) {
        found.push({ form: "value", expression: element.initializer })
      }
    }
  })
  return found
}

const declaresLoopName = (initializer: ts.ForInitializer, name: string): boolean =>
  ts.isVariableDeclarationList(initializer)
  && initializer.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)

/**
 * Where `name` was bound, resolved by walking out of `from`. This is lexical
 * scoping done by hand: the first enclosing function that takes the name as a
 * parameter, or the first enclosing block that declares it, wins.
 */
const bindingsOf = (name: string, from: ts.Node): ReadonlyArray<Binding> => {
  for (let node: ts.Node | undefined = from; node !== undefined; node = node.parent as ts.Node | undefined) {
    if (ts.isFunctionLike(node)) {
      const bindings = parameterBindings(node, name)
      if (bindings.length > 0) return bindings
    }
    if (ts.isForOfStatement(node) && declaresLoopName(node.initializer, name)) {
      return [{ form: "value", expression: node.expression }]
    }
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      const value = declaredValue(node.statements, name)
      if (value !== undefined) return [{ form: "value", expression: value }]
    }
  }
  return []
}

/**
 * The static text that ends a card-kind selector, with the interpolation hole
 * next: `` `section[data-kind=${JSON.stringify(kind)}]` ``. The quote is
 * optional because a CDP expression carries its own, sometimes escaped.
 */
const KIND_SELECTOR_TAIL = /\[data-kind\s*=\s*\\?["']?$/

const DISJUNCTIONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken
])

/**
 * Calls that ask whether a `.kind` is one of a collection. `KINDS.has(card.kind)`
 * compares the kind against every member of `KINDS`, so the members hold card
 * kinds exactly as the right-hand side of a `===` does — the parser just spells
 * it differently.
 */
const MEMBERSHIP_CALLS = new Set(["includes", "has", "indexOf", "lastIndexOf"])

/** The collection a membership call tests a `.kind` against, when that is what it does. */
const membershipSubject = (node: ts.CallExpression): ts.Expression | undefined => {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined
  if (!MEMBERSHIP_CALLS.has(node.expression.name.text)) return undefined
  const argument = node.arguments[0]
  if (node.arguments.length !== 1 || argument === undefined || !isKindRead(unwrap(argument))) return undefined
  return node.expression.expression
}

/**
 * Every literal in the file that reaches a card-kind position.
 *
 * The positions are read off the file, not listed here: a name compared
 * against a `.kind` — by `===`, by `switch` case, or by a membership call —
 * or interpolated straight after `[data-kind=`, holds a card kind, and so
 * does whatever flows into it. Propagation runs to a fixpoint over local
 * names, argument positions, ternary branches, array members and
 * single-argument formatting calls. Both sets only grow and every expression
 * is expanded once, so the loop terminates.
 */
const kindClaimNodes = (parsed: ts.SourceFile): ReadonlySet<ts.Node> => {
  const claimed = new Set<ts.Node>()
  const positions = new Set<string>()
  const visited = new Set<ts.Node>()
  const pending: Array<ts.Expression> = []
  const calls: Array<ts.CallExpression> = []
  const consider = (expression: ts.Expression | undefined): void => {
    if (expression !== undefined) pending.push(expression)
  }

  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      calls.push(node)
      consider(membershipSubject(node))
    }
    if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
      if (isKindRead(node.left)) consider(node.right)
      if (isKindRead(node.right)) consider(node.left)
    }
    if (ts.isSwitchStatement(node) && isKindRead(unwrap(node.expression))) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) consider(clause.expression)
      }
    }
    if (ts.isTemplateExpression(node)) {
      let preceding = node.head.text
      for (const span of node.templateSpans) {
        if (KIND_SELECTOR_TAIL.test(preceding)) consider(span.expression)
        preceding = span.literal.text
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(parsed)

  const drain = (): void => {
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const expression = unwrap(next)
      if (visited.has(expression)) continue
      visited.add(expression)
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        claimed.add(expression)
      } else if (ts.isIdentifier(expression)) {
        for (const binding of bindingsOf(expression.text, expression)) {
          if (binding.form === "parameter") positions.add(`${binding.callee}#${binding.index}`)
          else consider(binding.expression)
        }
      } else if (ts.isConditionalExpression(expression)) {
        consider(expression.whenTrue)
        consider(expression.whenFalse)
      } else if (ts.isArrayLiteralExpression(expression)) {
        for (const element of expression.elements) consider(element)
      } else if (ts.isBinaryExpression(expression) && DISJUNCTIONS.has(expression.operatorToken.kind)) {
        consider(expression.left)
        consider(expression.right)
      } else if (
        (ts.isCallExpression(expression) || ts.isNewExpression(expression))
        && expression.arguments?.length === 1
      ) {
        // A one-argument call in a kind position formats or wraps the
        // kind rather than replacing it: `JSON.stringify(kind)` is how a
        // CDP expression quotes one before it reaches the page, and
        // `new Set([…])` is how a suite collects the kinds it accepts.
        consider(expression.arguments[0])
      }
    }
  }

  for (let reached = -1; reached !== claimed.size + positions.size;) {
    reached = claimed.size + positions.size
    drain()
    for (const call of calls) {
      const callee = calleeName(call.expression)
      if (callee === undefined) continue
      call.arguments.forEach((argument, index) => {
        if (positions.has(`${callee}#${index}`)) consider(argument)
      })
    }
    drain()
  }
  return claimed
}

/** Every literal in one source file, with the position context each rule needs. */
export const extractLiterals = (file: string, source: string): ReadonlyArray<ExtractedLiteral> => {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const claimed = kindClaimNodes(parsed)
  const found: Array<ExtractedLiteral> = []
  const record = (node: ts.Node, value: string, form: ExtractedLiteral["form"], context: ts.Node) => {
    const call = contextOf(context)
    found.push({
      value,
      file,
      line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      form,
      ...call,
      ...objectContextOf(context),
      kindClaim: call.kindComparison || claimed.has(node) || claimed.has(context)
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text, "string", node)
    } else if (ts.isTemplateExpression(node)) {
      // The head of `` `flow-run-${id}` `` is the id prefix the app builds;
      // it is the only part of an interpolated template a static pin can own.
      record(node.head, node.head.text, "template-head", node)
      for (const span of node.templateSpans) {
        record(span.literal, span.literal.text, "template-chunk", node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}

/** Every literal under every one of `directories`. */
export const literalsUnder = (directories: ReadonlyArray<string>): ReadonlyArray<ExtractedLiteral> =>
  directories
    .flatMap((directory) => [...sourceFiles(directory)])
    .flatMap((file) => [...extractLiterals(file, readFileSync(file, "utf8"))])

/**
 * The shape of a flow name: lowercase, dot-separated, kebab inside a segment.
 * `flow.run.stop`, `admin.grant.confirm`, `repos.import`. This is also the
 * shape of a transition type and a stream frame type, which is why the broad
 * rule checks presence in the product source rather than membership in the
 * flow registry.
 */
export const DOTTED_IDENTIFIER = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/

/** The shape of a card-id prefix: kebab-case ending in the joining hyphen. */
export const ID_PREFIX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-$/

/** The words a kebab-case name is built from. */
export const segmentsOf = (value: string): ReadonlyArray<string> =>
  value.split("-").filter((segment) => segment.length > 0)

/**
 * File names are not application vocabulary. `index.html` and `version.json`
 * have the dotted shape but name a build artifact, so the dotted rule skips
 * them rather than sending every new fixture path to the allowlist. `db` and
 * `sqlite` are here because a script that stands up a real control plane names
 * the database file it writes, and `c` because the packaged suite compiles a
 * throwaway `sleep.c` to hold a second process group open.
 */
export const FILE_NAME =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|html|css|md|map|txt|lock|toml|ya?ml|png|svg|ico|woff2?|wasm|tar|t?gz|zip|dmg|db|sqlite|c|h)$/

/**
 * The name of a file that asserts against the app instead of building it:
 * `AppStore.test.ts`, `onboarding.spec.ts`.
 */
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/

/**
 * A tree of canned data only a suite imports, such as
 * `src/mainview/cards/fixtures/CodingPlan.ts`. Its literals are the suite's,
 * not the app's.
 */
export const FIXTURE_TREE = /(?:^|\/)fixtures\//

/**
 * Every `data-*` attribute name spelled inside a literal.
 *
 * The lookbehind refuses a match that continues a longer hyphenated word, so
 * the Chrome flag `--user-data-dir` is not read as an attribute named
 * `data-dir`.
 */
export const dataAttributesIn = (value: string): ReadonlyArray<string> => [
  ...new Set([...value.matchAll(/(?<![\w-])data-[a-z0-9]+(?:-[a-z0-9]+)*/g)].map((match) => match[0]))
]

/** The value a CSS selector pins an attribute to: `[data-kind="run-trace"]` → `run-trace`. */
export const attributeSelectorValues = (value: string, attribute: string): ReadonlyArray<string> => {
  const pattern = new RegExp(`\\[${attribute}\\s*=\\s*(?:\\\\?"([^"\\\\]*)\\\\?"|'([^']*)')`, "g")
  return [...value.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? "")
}

/** Levenshtein distance, used only to name the nearest surviving vocabulary member. */
const distance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous = row
  }
  return previous[b.length] ?? 0
}

/**
 * The surviving member a reader most likely meant. The suggestion is what turns
 * a failure into a fix: "workflow.create is not a registered flow; did you mean
 * flow.create?".
 */
const commonSuffix = (a: string, b: string): number => {
  let shared = 0
  while (shared < a.length && shared < b.length && a[a.length - 1 - shared] === b[b.length - 1 - shared]) shared += 1
  return shared
}

export const nearest = (value: string, vocabulary: Iterable<string>): string | undefined => {
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  let bestSuffix = -1
  for (const candidate of vocabulary) {
    const suffix = commonSuffix(value, candidate)
    // A rename replaces the head and keeps the tail: `workflow-run` →
    // `flow-run`, `workflow.create` → `flow.create`. Requiring a shared
    // tail is what keeps the suggestion a lead rather than the nearest
    // stranger — `data-command` gets no suggestion, because the attribute
    // that replaced it shares nothing with it and guessing would mislead.
    if (suffix < 3) continue
    const gap = distance(value, candidate)
    if (gap < bestDistance || (gap === bestDistance && suffix > bestSuffix)) {
      best = candidate
      bestDistance = gap
      bestSuffix = suffix
    }
  }
  // Past half the literal's length the "suggestion" is noise, not a lead.
  return best !== undefined && bestDistance <= Math.max(3, Math.ceil(value.length / 2)) ? best : undefined
}
