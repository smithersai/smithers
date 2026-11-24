/**
 * Host access a bundler cannot see.
 *
 * The browser contract (`browser/browser-check.mjs`) bundles each browser
 * entry point and fails when the bundle resolves a `node:` built-in. Two
 * shapes reach the host without resolving anything, so a bundle that holds
 * them still builds and the gate passes:
 *
 * - a dynamic `import()` or `require()` whose specifier is an expression. The
 *   bundler cannot follow it, leaves it in place, and the runtime resolves it
 *   later. `@smthrs/sandbox` loaded `@smthrs/jj/node/NodeJj` this way, so the
 *   `@smthrs/flows` root passed the gate while carrying Node-only jj code.
 * - `process.getBuiltinModule`, which fetches a built-in at run time.
 *
 * {@link hiddenHostAccess} finds both in bundled code. In a dependency's
 * module a `getBuiltinModule` call is taken as feature detection rather than
 * a dependency when the code still runs on a host without it: an optional
 * call, `process?.getBuiltinModule?.("x")`, or a call inside a `try` block in
 * the same function. Those are not reported there.
 *
 * A module the repository's platform rule governs, one of a workspace package
 * that is not a host package, gets no such allowance: the rule puts all
 * platform code in the host packages, feature-detected or not.
 * `@smthrs/sandbox` set V8 flags and built a VM context through an optional
 * `getBuiltinModule` call, and the allowance let it through. In a governed
 * module every `getBuiltinModule` call is reported, and so are two shapes a
 * bundler resolves nothing for at all: a read of the ambient `process`, `Bun`
 * or `Deno` global (a free name, or a property of `globalThis`), and a
 * `node:` or `bun:` module specifier written as a string.
 *
 * Node loads this module directly through type stripping, so it uses only
 * erasable TypeScript.
 *
 * @since 0.1.0
 */

import ts from "typescript"

/**
 * How code reaches the host out of the bundler's sight.
 *
 * @category models
 * @since 0.1.0
 */
export type HiddenAccessKind = "dynamic-import" | "require" | "builtin" | "ambient-global" | "host-module"

/**
 * One place bundled code reaches the host without the bundler resolving it.
 *
 * @category models
 * @since 0.1.0
 */
export interface HiddenAccess {
  readonly kind: HiddenAccessKind
  /** The access as written, cut to 80 characters. */
  readonly call: string
  /** The bundled module it sits in, from esbuild's `// <path>` markers, or `""` before the first. */
  readonly module: string
  /** The 1-based line in the bundle. */
  readonly line: number
}

/** A specifier the bundler resolves: a string literal or a template with no substitution. */
const literal = (argument: ts.Expression | undefined): boolean =>
  argument !== undefined && ts.isStringLiteralLike(argument)

/** Whether a `try` block of the enclosing function holds `node`. */
const insideTry = (node: ts.Node): boolean => {
  let child = node
  for (let parent = node.parent; parent !== undefined; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false
    if (ts.isTryStatement(parent) && parent.tryBlock === child) return true
  }
  return false
}

/** The kind of hidden access `call` is, or `undefined` for an ordinary call. */
const kindOf = (call: ts.CallExpression, governed: boolean): HiddenAccessKind | undefined => {
  const callee = call.expression
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return literal(call.arguments[0]) ? undefined : "dynamic-import"
  if (ts.isIdentifier(callee) && (callee.text === "require" || callee.text === "__require")) {
    return literal(call.arguments[0]) ? undefined : "require"
  }
  if (
    ts.isPropertyAccessExpression(callee) && callee.name.text === "getBuiltinModule"
    && (governed || call.questionDotToken === undefined && !insideTry(call))
  ) {
    return "builtin"
  }
  return undefined
}

/** The runtime globals that are a host: Node's and Bun's `process`, `Bun`, and `Deno`. */
const hostGlobals: ReadonlySet<string> = new Set(["process", "Bun", "Deno"])

/** A `node:` or `bun:` module specifier. */
const hostModule = /^(?:node|bun):/

const isGlobalObject = (node: ts.Expression): boolean => ts.isIdentifier(node) && node.text === "globalThis"

const namesHostGlobal = (node: ts.Expression | undefined): boolean =>
  node !== undefined && ts.isStringLiteralLike(node) && hostGlobals.has(node.text)

/**
 * Whether `node` reads a host global off `globalThis`: `globalThis.process`,
 * `globalThis["Bun"]`, or `Reflect.get(globalThis, "Deno")`.
 */
const readsGlobalProperty = (node: ts.Node): boolean => {
  if (ts.isPropertyAccessExpression(node)) return isGlobalObject(node.expression) && hostGlobals.has(node.name.text)
  if (ts.isElementAccessExpression(node)) {
    return isGlobalObject(node.expression) && namesHostGlobal(node.argumentExpression)
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
  const [target, key] = node.arguments
  return ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Reflect"
    && node.expression.name.text === "get" && target !== undefined && isGlobalObject(target) && namesHostGlobal(key)
}

/**
 * Whether `node`, a host global's name, is read where it stands, rather than
 * naming a property or declaring a binding. A shorthand property, `{ process }`,
 * is both: the name of the property and a read of the binding.
 */
const isRead = (node: ts.Identifier): boolean => {
  const parent = node.parent
  if (ts.isShorthandPropertyAssignment(parent)) return true
  if ((parent as { readonly name?: ts.Node }).name === node) return false
  return !(ts.isBindingElement(parent) && parent.propertyName === node)
}

/**
 * A checker over the one bundle, so a free name can be told from a binding the
 * bundle declares. With no default library and no resolution, the bundle is
 * the only file the program asks for.
 */
const checkerOf = (source: ts.SourceFile): ts.TypeChecker =>
  ts.createProgram({
    rootNames: [source.fileName],
    options: { allowJs: true, noLib: true, noResolve: true, types: [] },
    host: { ...ts.createCompilerHost({}), getSourceFile: () => source }
  }).getTypeChecker()

/**
 * Every place `code` reaches the host out of a bundler's sight, in source
 * order. `governed` says whether the platform rule governs the bundled module
 * at a path, as esbuild's `// <path>` markers name it.
 *
 * @category utilities
 * @since 0.1.0
 */
export const hiddenHostAccess = (
  code: string,
  governed: (module: string) => boolean
): ReadonlyArray<HiddenAccess> => {
  const source = ts.createSourceFile("bundle.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const markers = [
    ...code.matchAll(
      /^\/\/ ((?![a-z][a-z0-9+.-]*:\/\/)(?:[^\s]+[/\\][^\s]+|[\w.-]+\.(?:[cm]?[jt]sx?|vibex?|json|css)|[\w-]+:[^\s]+))\r?$/gim
    )
  ].map((match) => [match.index, match[1]] as const)
  const moduleAt = (position: number): string => {
    let current = ""
    for (const [index, path] of markers) {
      if (index > position) break
      current = path
    }
    return current
  }
  let checker: ts.TypeChecker | undefined
  /** Whether the bundle declares no binding that `node`, a read, resolves to. */
  const free = (node: ts.Identifier): boolean => {
    checker ??= checkerOf(source)
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node)
    return !(symbol?.declarations ?? []).some((declaration) => declaration.getSourceFile() === source)
  }
  const found: Array<HiddenAccess & { readonly start: number; readonly end: number }> = []
  const report = (node: ts.Node, kind: HiddenAccessKind, module: string): void => {
    const start = node.getStart(source)
    found.push({
      kind,
      call: node.getText(source).slice(0, 80),
      module,
      line: source.getLineAndCharacterOfPosition(start).line + 1,
      start,
      end: node.getEnd()
    })
  }
  const visit = (node: ts.Node): void => {
    const governs = (): string | undefined => {
      const module = moduleAt(node.getStart(source))
      return governed(module) ? module : undefined
    }
    if (ts.isCallExpression(node)) {
      const module = moduleAt(node.getStart(source))
      const kind = kindOf(node, governed(module))
      if (kind !== undefined) report(node, kind, module)
    }
    if (ts.isIdentifier(node) && hostGlobals.has(node.text) && isRead(node)) {
      const module = governs()
      if (module !== undefined && free(node)) report(node, "ambient-global", module)
    } else if (readsGlobalProperty(node)) {
      const module = governs()
      if (module !== undefined) report(node, "ambient-global", module)
    } else if (ts.isStringLiteralLike(node) && hostModule.test(node.text)) {
      const module = governs()
      if (module !== undefined) report(node, "host-module", module)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map(({ call, kind, line, module }) => ({ kind, call, module, line }))
}
