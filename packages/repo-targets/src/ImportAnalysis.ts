/**
 * One parse of a source file's module references and calls.
 *
 * The `ImportRules` macro and the repository dependency-boundary gate
 * (`contracts/check-dependency-boundaries.mjs`) both read imports, so both read
 * them here, with the TypeScript compiler API. Nothing scans source text with
 * a regular expression: a string or a comment that mentions an import is not
 * one.
 *
 * Node loads this module directly through type stripping, so it uses only
 * erasable TypeScript.
 *
 * @since 0.1.0
 */

/// <reference path="./vibelang-eslint.d.ts" />

import ts from "typescript"
import { parseESTree } from "vibelang/eslint"

/**
 * How a source names a module.
 *
 * `import` and `export` are declarations with a `from` clause (and
 * `import "x"`); `import-equals` is `import x = require("x")`;
 * `dynamic-import` is `import("x")`, with or without import attributes;
 * `require` is a call or constructor that loads the module its first argument names:
 * `require("x")`, a member named `require` or `getBuiltinModule`
 * (`module.require("x")`, `process.getBuiltinModule("node:fs")`), or the
 * function `createRequire` returns, called directly
 * (`createRequire(import.meta.url)("x")`) or through a variable it
 * initializes; `import-type` is an `import("x")` type.
 *
 * @category models
 * @since 0.1.0
 */
export type ReferenceForm = "import" | "export" | "import-equals" | "dynamic-import" | "require" | "import-type"

/**
 * One name a source takes from a module.
 *
 * @category models
 * @since 0.1.0
 */
export interface ReferencedName {
  /** The name the module exports: `useState` for `import { useState as s }`, `default` for a default import. */
  readonly name: string
  /** Whether only a type is taken: `import type`, `export type`, a `type` modifier, or an `import()` type. */
  readonly typeOnly: boolean
  /** The 1-based line it appears on. */
  readonly line: number
}

/**
 * A name read through a namespace or default import binding: `React.useState`
 * from `import * as React from "react"`, or the qualified type `X.Y`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemberName extends ReferencedName {
  /** The local binding the name is read through, `React` above. */
  readonly binding: string
}

/**
 * A place a source takes a module's exports without naming the ones it uses,
 * so a rule about names cannot tell which it takes: `export *` and
 * `export * as x`; any `import()` or `require()`; and a
 * namespace or default binding used other than for a member read, a string
 * key or a destructuring, as in `f(React)`, `React[key]` or `export { React }`.
 *
 * @category models
 * @since 0.1.0
 */
export interface UnnamedUse {
  /** The namespace or default binding used, `React` above; absent for `export *`, `import()` and `require()`. */
  readonly binding?: string
  /** Whether only types are taken: `export type *` or `export type { Namespace }`. */
  readonly typeOnly: boolean
  /** The 1-based line it appears on. */
  readonly line: number
}

/**
 * One place a source names a module.
 *
 * @category models
 * @since 0.1.0
 */
export interface ModuleReference {
  readonly specifier: string
  readonly form: ReferenceForm
  /** The 1-based line of the declaration, call or type. */
  readonly line: number
  /**
   * Whether nothing of the module loads at runtime: `import type`,
   * `export type`, `import type x = require("x")`, or an `import()` type.
   * A declaration whose every named element carries its own `type` modifier
   * is not type-only here, because `verbatimModuleSyntax` keeps it as a
   * side-effect import.
   */
  readonly typeOnly: boolean
  /** Names imported or re-exported by name, and an `import()` type's qualifier. */
  readonly names: ReadonlyArray<ReferencedName>
  /**
   * Names read through this declaration's namespace or default binding:
   * `React.useState`, `React["useState"]`, `const { useState } = React`.
   */
  readonly members: ReadonlyArray<MemberName>
  /** Every place the source takes this module's exports without naming them. */
  readonly unnamed: ReadonlyArray<UnnamedUse>
}

/**
 * One call whose callee is a name or ends in a member name.
 *
 * @category models
 * @since 0.1.0
 */
export interface Call {
  /**
   * The callee as dotted names, with parentheses, type assertions, non-null
   * assertions and optional chaining removed: `Model.stream` for
   * `Model.stream(request)`, `this.client.send` for `this.client!.send()`.
   *
   * A string key reads as a member, so `page["route"]()` is `page.route`; a
   * key that is not an identifier keeps its brackets, as in
   * `headers["content-type"]`. A receiver that is a call ends in `()`, as in
   * `page.context().route`, and any other receiver, such as an `await` or a
   * computed key, reads as `(…)`, as in `(…).route`. A call whose callee does
   * not end in a name, such as `f()()` or `x[name]()`, is not recorded.
   */
  readonly callee: string
  readonly line: number
}

/**
 * Everything {@link analyze} reads from one source.
 *
 * @category models
 * @since 0.1.0
 */
export interface Analysis {
  /** Every module reference, in source order. */
  readonly references: ReadonlyArray<ModuleReference>
  /** Every call whose callee is a name or ends in a member name, outermost first, in source order. */
  readonly calls: ReadonlyArray<Call>
}

/**
 * The parser's script kind for a TypeScript or JavaScript file name.
 */
const scriptKind = (file: string): ts.ScriptKind => {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (/\.[mc]?ts$/.test(file)) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

interface Entry {
  readonly position: number
  readonly reference: {
    readonly specifier: string
    readonly form: ReferenceForm
    readonly line: number
    readonly typeOnly: boolean
    readonly names: Array<ReferencedName>
    readonly members: Array<MemberName>
    readonly unnamed: Array<UnnamedUse>
  }
}

/** Whether a callee, as {@link calleeText} reads it, loads the module its call's first argument names. */
const isLoader = (callee: string): boolean =>
  callee === "require" || callee.endsWith(".require") || callee.endsWith(".getBuiltinModule")

/** Whether a callee, as {@link calleeText} reads it, is `createRequire`. */
const isCreateRequire = (callee: string | undefined): boolean =>
  callee === "createRequire" || (callee?.endsWith(".createRequire") ?? false)

/** An expression with its parentheses and type and non-null assertions removed. */
const unwrap = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ||
  ts.isNonNullExpression(expression) ||
  ts.isAsExpression(expression) ||
  ts.isSatisfiesExpression(expression) ||
  ts.isTypeAssertionExpression(expression)
    ? unwrap(expression.expression)
    : expression

/** A string key as a member: `.route` for `["route"]`, `["content-type"]` for a key that is not an ASCII identifier. */
const keyText = (key: ts.Expression): string | undefined => {
  if (!ts.isStringLiteralLike(key)) return undefined
  return /^[A-Za-z_$][\w$]*$/.test(key.text) ? `.${key.text}` : `[${JSON.stringify(key.text)}]`
}

/** A receiver as text: a call ends in `()`, and anything that is not a callee reads as `(…)`. */
const receiverText = (expression: ts.Expression): string => {
  const receiver = unwrap(expression)
  if (ts.isCallExpression(receiver)) return `${receiverText(receiver.expression)}()`
  return calleeText(receiver) ?? "(…)"
}

/** The callee of a call as text, or undefined when it does not end in a name. */
const calleeText = (expression: ts.Expression): string | undefined => {
  const callee = unwrap(expression)
  if (ts.isIdentifier(callee)) return callee.text
  if (callee.kind === ts.SyntaxKind.ThisKeyword) return "this"
  if (callee.kind === ts.SyntaxKind.SuperKeyword) return "super"
  if (ts.isPropertyAccessExpression(callee)) return `${receiverText(callee.expression)}.${callee.name.text}`
  if (ts.isElementAccessExpression(callee)) {
    const key = keyText(callee.argumentExpression)
    return key === undefined ? undefined : `${receiverText(callee.expression)}${key}`
  }
  return undefined
}

/**
 * Reads one source's module references and calls.
 *
 * `file` names the source for its language: `.tsx` and `.jsx` parse with
 * JSX, `.ts`, `.mts` and `.cts` as TypeScript, VibeLang's `.vibe` with
 * VibeLang's own parser, anything else as JavaScript.
 *
 * A TypeScript syntax error does not throw; the parser recovers and the rest
 * is read. A `.vibe` syntax error throws, because no parser can read past it.
 *
 * A member is recorded only through a binding a top-level import declares,
 * and shadowing is not tracked: a local variable with the binding's name
 * reads as the binding. A use the walk cannot name, such as a binding passed
 * to a function, is recorded in {@link ModuleReference.unnamed}, so a rule
 * about names can refuse what it cannot see.
 *
 * @category analysis
 * @since 0.1.0
 */
export const analyze = (file: string, text: string): Analysis =>
  file.endsWith(".vibe") ? analyzeVibe(file, text) : analyzeTypeScript(file, text)

const analyzeTypeScript = (file: string, text: string): Analysis => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const entries: Array<Entry> = []
  const calls: Array<Call> = []
  const bindings = new Map<string, Entry["reference"]>()
  const declared = new Set<ts.Node>()
  /** Variables `createRequire(...)` initializes, which load like `require`. */
  const loaders = new Set<string>()
  /** Calls through a name with a string first argument, kept until every loader variable is known. */
  const pending: Array<{ readonly node: ts.CallExpression | ts.NewExpression; readonly callee: string; readonly specifier: string }> = []

  const add = (
    node: ts.Node,
    specifier: string,
    form: ReferenceForm,
    typeOnly: boolean,
    names: Array<ReferencedName> = []
  ): Entry["reference"] => {
    const reference = { specifier, form, line: lineOf(node), typeOnly, names, members: [], unnamed: [] }
    entries.push({ position: node.getStart(source), reference })
    return reference
  }

  const addImport = (node: ts.ImportDeclaration & { readonly moduleSpecifier: ts.StringLiteral }): void => {
    const clause = node.importClause
    const typeOnly = clause?.isTypeOnly ?? false
    const names: Array<ReferencedName> = []
    if (clause?.name !== undefined) names.push({ name: "default", typeOnly, line: lineOf(clause.name) })
    const named = clause?.namedBindings
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        names.push({
          name: (element.propertyName ?? element.name).text,
          typeOnly: typeOnly || element.isTypeOnly,
          line: lineOf(element)
        })
      }
    }
    const reference = add(node, node.moduleSpecifier.text, "import", typeOnly, names)
    if (clause?.name !== undefined) bindings.set(clause.name.text, reference)
    if (named !== undefined && ts.isNamespaceImport(named)) bindings.set(named.name.text, reference)
  }

  const addImportEquals = (
    node: ts.ImportEqualsDeclaration & { readonly moduleReference: ts.ExternalModuleReference }
  ): void => {
    const reference = add(
      node,
      (node.moduleReference.expression as ts.StringLiteral).text,
      "import-equals",
      node.isTypeOnly
    )
    bindings.set(node.name.text, reference)
  }

  const isModuleImport = (node: ts.Node): node is ts.ImportDeclaration & { readonly moduleSpecifier: ts.StringLiteral } =>
    ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)

  const isRequireImport = (
    node: ts.Node
  ): node is ts.ImportEqualsDeclaration & { readonly moduleReference: ts.ExternalModuleReference } =>
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteral(node.moduleReference.expression)

  // Top-level imports first, so a member read above its import still binds.
  for (const statement of source.statements) {
    if (isModuleImport(statement)) addImport(statement)
    else if (isRequireImport(statement)) addImportEquals(statement)
    else continue
    declared.add(statement)
  }

  /** The names an object pattern takes, or undefined when it takes the rest or a computed key. */
  const patternNames = (pattern: ts.ObjectBindingPattern): Array<ReferencedName> | undefined => {
    const names: Array<ReferencedName> = []
    for (const element of pattern.elements) {
      const key = element.propertyName ?? element.name
      const name = element.dotDotDotToken !== undefined
        ? undefined
        : ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)
        ? key.text
        : ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression)
        ? key.expression.text
        : undefined
      if (name === undefined) return undefined
      names.push({ name, typeOnly: false, line: lineOf(element) })
    }
    return names
  }

  /**
   * The names the source takes from a module value: a member read, a string
   * key, or a destructuring. Undefined when it uses the value any other way.
   */
  const taken = (value: ts.Node): Array<ReferencedName> | undefined => {
    const parent = value.parent
    if (ts.isPropertyAccessExpression(parent) && parent.expression === value) {
      return [{ name: parent.name.text, typeOnly: false, line: lineOf(parent) }]
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === value) {
      const key = parent.argumentExpression
      return ts.isStringLiteralLike(key) ? [{ name: key.text, typeOnly: false, line: lineOf(parent) }] : undefined
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === value && ts.isObjectBindingPattern(parent.name)) {
      return patternNames(parent.name)
    }
    return undefined
  }

  /** The node an expression's value leaves through, past parentheses and type and non-null assertions. */
  const outermost = (node: ts.Node): ts.Node =>
    ts.isParenthesizedExpression(node.parent) ||
    ts.isNonNullExpression(node.parent) ||
    ts.isAsExpression(node.parent) ||
    ts.isSatisfiesExpression(node.parent) ||
    ts.isTypeAssertionExpression(node.parent)
      ? outermost(node.parent)
      : node

  /** A dynamic load can expose any export, including through a default value or a later alias. */
  const load = (node: ts.CallExpression | ts.NewExpression, specifier: string, form: "dynamic-import" | "require"): void => {
    const reference = add(node, specifier, form, false)
    reference.unnamed.push({ typeOnly: false, line: reference.line })
  }

  /** Whether an identifier refers to a value, rather than naming a declaration, a property or a label, or a type. */
  const isReference = (node: ts.Identifier): boolean => {
    const parent = node.parent as ts.Node & {
      readonly name?: ts.Node
      readonly propertyName?: ts.Node
      readonly label?: ts.Node
    }
    if (ts.isShorthandPropertyAssignment(parent)) return true
    if (ts.isExportSpecifier(parent)) {
      return parent.parent.parent.moduleSpecifier === undefined && (parent.propertyName ?? parent.name) === node
    }
    if (ts.isQualifiedName(parent)) return parent.left === node
    if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) || ts.isImportTypeNode(parent)) return false
    return parent.name !== node && parent.propertyName !== node && parent.label !== node
  }

  /** Records a use of a namespace or default binding: the members it reads, or that it takes them all. */
  const use = (node: ts.Identifier, reference: Entry["reference"]): void => {
    if (!isReference(node)) return
    const binding = node.text
    const typeOnly = ts.isExportSpecifier(node.parent) && (node.parent.isTypeOnly || node.parent.parent.parent.isTypeOnly)
    if (ts.isQualifiedName(node.parent)) {
      reference.members.push({ name: node.parent.right.text, binding, typeOnly: true, line: lineOf(node.parent) })
      return
    }
    const names = taken(outermost(node))
    if (names === undefined) reference.unnamed.push({ binding, typeOnly, line: lineOf(node) })
    else reference.members.push(...names.map((name) => ({ ...name, binding })))
  }

  const visit = (node: ts.Node): void => {
    if (declared.has(node)) {
      // Already read above; its children hold no other reference.
    } else if (isModuleImport(node)) {
      addImport(node)
    } else if (isRequireImport(node)) {
      addImportEquals(node)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: Array<ReferencedName> = []
      if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          names.push({
            name: (element.propertyName ?? element.name).text,
            typeOnly: node.isTypeOnly || element.isTypeOnly,
            line: lineOf(element)
          })
        }
      }
      const reference = add(node, node.moduleSpecifier.text, "export", node.isTypeOnly, names)
      if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
        reference.unnamed.push({ typeOnly: node.isTypeOnly, line: reference.line })
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        let qualifier = node.qualifier
        while (qualifier !== undefined && ts.isQualifiedName(qualifier)) qualifier = qualifier.left
        add(
          node,
          node.argument.literal.text,
          "import-type",
          true,
          qualifier === undefined ? [] : [{ name: qualifier.text, typeOnly: true, line: lineOf(node) }]
        )
      }
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const argument = node.arguments?.[0]
      const literal = argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (literal !== undefined) load(node, literal, "dynamic-import")
      } else {
        const callee = calleeText(node.expression)
        const inner = unwrap(node.expression)
        if (literal !== undefined) {
          if (callee !== undefined && isLoader(callee)) load(node, literal, "require")
          else if (ts.isCallExpression(inner) && isCreateRequire(calleeText(inner.expression))) load(node, literal, "require")
          else if (ts.isIdentifier(inner)) pending.push({ node, callee: inner.text, specifier: literal })
        }
        if (callee !== undefined && ts.isCallExpression(node)) calls.push({ callee, line: lineOf(node) })
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(unwrap(node.initializer)) &&
      isCreateRequire(calleeText((unwrap(node.initializer) as ts.CallExpression).expression))
    ) {
      loaders.add(node.name.text)
    } else if (ts.isIdentifier(node)) {
      const reference = bindings.get(node.text)
      if (reference !== undefined) use(node, reference)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const call of pending) if (loaders.has(call.callee)) load(call.node, call.specifier, "require")

  return {
    references: entries.sort((a, b) => a.position - b.position).map((entry) => entry.reference),
    calls
  }
}

/** The parts of VibeLang's ESTree nodes {@link analyzeVibe} reads. */
interface EsNode {
  readonly type: string
  readonly range: readonly [number, number]
  readonly [key: string]: any
}

const isEsNode = (value: unknown): value is EsNode =>
  typeof value === "object" && value !== null && typeof (value as EsNode).type === "string" && Array.isArray((value as EsNode).range)

/** A node's children with the keys that hold them, in source order, so a walk reads calls outermost first as the TypeScript walk does. */
const esChildren = (node: EsNode): ReadonlyArray<readonly [string, EsNode]> =>
  Object.entries(node)
    .filter(([key]) => key !== "parent")
    .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((child): readonly [string, unknown] => [key, child]))
    .filter((entry): entry is readonly [string, EsNode] => isEsNode(entry[1]))
    .sort(([, a], [, b]) => a.range[0] - b.range[0] || b.range[1] - a.range[1])

/** The string a literal or a template with no substitutions holds. */
const esString = (node: EsNode | null | undefined): string | undefined => {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked
  return undefined
}

const esUnwrap = (node: EsNode): EsNode =>
  ["ChainExpression", "TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"].includes(node.type)
    ? esUnwrap(node.expression)
    : node

/** `try x`, and the other forms the compiler writes as calls, are no call the author wrote. */
const isSynthesized = (node: EsNode): boolean =>
  node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.synthesized === true

const esReceiver = (node: EsNode): string => {
  const receiver = esUnwrap(node)
  if (isSynthesized(receiver)) return "(…)"
  if (receiver.type === "CallExpression") return `${esReceiver(receiver.callee)}()`
  return esCallee(receiver) ?? "(…)"
}

const esCallee = (node: EsNode): string | undefined => {
  const callee = esUnwrap(node)
  if (callee.type === "Identifier") return callee.name
  if (callee.type === "ThisExpression") return "this"
  if (callee.type === "Super") return "super"
  if (callee.type !== "MemberExpression") return undefined
  if (!callee.computed) {
    return `${esReceiver(callee.object)}.${callee.property.type === "PrivateIdentifier" ? "#" : ""}${callee.property.name}`
  }
  const key = esString(callee.property)
  if (key === undefined) return undefined
  return `${esReceiver(callee.object)}${/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`}`
}

/** {@link analyze} for a `.vibe` module, from VibeLang's parser. It records what the TypeScript walk records. */
const analyzeVibe = (file: string, text: string): Analysis => {
  const program: EsNode = parseESTree(text, file)
  const lineOf = (node: EsNode): number => text.slice(0, node.range[0]).split("\n").length
  const entries: Array<Entry> = []
  const calls: Array<Call> = []
  const bindings = new Map<string, Entry["reference"]>()
  const declared = new Set<EsNode>()
  /** Each visited node's parent and the key that holds it; VibeLang's nodes carry no parent. */
  const parents = new Map<EsNode, { readonly node: EsNode; readonly key: string }>()
  const loaders = new Set<string>()
  const pending: Array<{ readonly node: EsNode; readonly callee: string; readonly specifier: string }> = []

  const add = (
    node: EsNode,
    specifier: string,
    form: ReferenceForm,
    typeOnly: boolean,
    names: Array<ReferencedName> = []
  ): Entry["reference"] => {
    const reference = { specifier, form, line: lineOf(node), typeOnly, names, members: [], unnamed: [] }
    entries.push({ position: node.range[0], reference })
    return reference
  }

  const addImport = (node: EsNode): void => {
    const typeOnly = node.importKind === "type"
    const names: Array<ReferencedName> = []
    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") names.push({ name: "default", typeOnly, line: lineOf(specifier) })
      if (specifier.type === "ImportSpecifier") {
        names.push({
          name: specifier.imported.name ?? specifier.imported.value,
          typeOnly: typeOnly || specifier.importKind === "type",
          line: lineOf(specifier)
        })
      }
    }
    const reference = add(node, node.source.value, "import", typeOnly, names)
    for (const specifier of node.specifiers) {
      if (specifier.type !== "ImportSpecifier") bindings.set(specifier.local.name, reference)
    }
  }

  const addImportEquals = (node: EsNode): void => {
    const reference = add(node, esString(node.moduleReference.expression)!, "import-equals", node.importKind === "type")
    bindings.set(node.id.name, reference)
  }

  const isRequireImport = (node: EsNode): boolean =>
    node.type === "TSImportEqualsDeclaration" &&
    node.moduleReference.type === "TSExternalModuleReference" &&
    esString(node.moduleReference.expression) !== undefined

  // Top-level imports first, so a member read above its import still binds.
  for (const statement of program.body as ReadonlyArray<EsNode>) {
    if (statement.type === "ImportDeclaration") addImport(statement)
    else if (isRequireImport(statement)) addImportEquals(statement)
    else continue
    declared.add(statement)
  }

  /** The names an object pattern takes, or undefined when it takes the rest or a computed key. */
  const patternNames = (pattern: EsNode): Array<ReferencedName> | undefined => {
    const names: Array<ReferencedName> = []
    for (const property of pattern.properties as ReadonlyArray<EsNode>) {
      const key = property.key
      const name = property.type !== "Property"
        ? undefined
        : property.computed
        ? esString(key)
        : key.type === "Identifier"
        ? key.name
        : String(key.value)
      if (name === undefined) return undefined
      names.push({ name, typeOnly: false, line: lineOf(property) })
    }
    return names
  }

  /** {@link analyzeTypeScript}'s `taken`: the names a member read, a string key or a destructuring takes from a module value. */
  const taken = (value: EsNode): Array<ReferencedName> | undefined => {
    const parent = parents.get(value)
    if (parent?.node.type === "MemberExpression" && parent.key === "object") {
      const name = parent.node.computed ? esString(parent.node.property) : parent.node.property.name
      return name === undefined ? undefined : [{ name, typeOnly: false, line: lineOf(parent.node) }]
    }
    if (parent?.node.type === "VariableDeclarator" && parent.key === "init" && parent.node.id.type === "ObjectPattern") {
      return patternNames(parent.node.id)
    }
    return undefined
  }

  const outermost = (node: EsNode): EsNode => {
    const parent = parents.get(node)?.node
    return parent !== undefined &&
        ["ChainExpression", "TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"].includes(parent.type)
      ? outermost(parent)
      : node
  }

  /** {@link analyzeTypeScript}'s `load`. */
  const load = (node: EsNode, specifier: string, form: "dynamic-import" | "require"): void => {
    const reference = add(node, specifier, form, false)
    reference.unnamed.push({ typeOnly: false, line: reference.line })
  }

  /** {@link analyzeTypeScript}'s `isReference`, from the key that holds the identifier. */
  const isReference = (node: EsNode): boolean => {
    const { node: parent, key } = parents.get(node)!
    switch (parent.type) {
      case "MemberExpression":
        return key === "object" || parent.computed
      case "TSQualifiedName":
        return key === "left"
      case "Property":
        return (parent.computed && key === "key") ||
          (parents.get(parent)?.node.type !== "ObjectPattern" && key === "value")
      case "ExportSpecifier":
        return key === "local" && (parents.get(parent)?.node.source ?? null) === null
      case "TSTypeReference":
      case "TSTypeQuery":
      case "TSImportType":
      case "ArrayPattern":
      case "RestElement":
        return false
      case "AssignmentPattern":
        return key === "right"
    }
    return !["id", "params", "label", "key", "name", "local", "imported", "exported", "meta", "property"].includes(key) ||
      (key === "key" && parent.computed === true)
  }

  /** {@link analyzeTypeScript}'s `use`. */
  const use = (node: EsNode, reference: Entry["reference"]): void => {
    if (!isReference(node)) return
    const binding: string = node.name
    const parent = parents.get(node)!.node
    const typeOnly = parent.type === "ExportSpecifier" &&
      (parent.exportKind === "type" || parents.get(parent)?.node.exportKind === "type")
    if (parent.type === "TSQualifiedName") {
      reference.members.push({ name: parent.right.name, binding, typeOnly: true, line: lineOf(parent) })
      return
    }
    const names = taken(outermost(node))
    if (names === undefined) reference.unnamed.push({ binding, typeOnly, line: lineOf(node) })
    else reference.members.push(...names.map((name) => ({ ...name, binding })))
  }

  const visit = (node: EsNode): void => {
    if (declared.has(node)) return
    if (node.type === "ImportDeclaration") {
      addImport(node)
    } else if (isRequireImport(node)) {
      addImportEquals(node)
    } else if (node.type === "ExportNamedDeclaration" && node.source !== null && node.source !== undefined) {
      const typeOnly = node.exportKind === "type"
      const names = node.specifiers.map((specifier: EsNode) => ({
        name: specifier.local.name ?? specifier.local.value,
        typeOnly: typeOnly || specifier.exportKind === "type",
        line: lineOf(specifier)
      }))
      add(node, node.source.value, "export", typeOnly, names)
    } else if (node.type === "ExportAllDeclaration") {
      const typeOnly = node.exportKind === "type"
      add(node, node.source.value, "export", typeOnly).unnamed.push({ typeOnly, line: lineOf(node) })
    } else if (node.type === "TSImportType") {
      let qualifier = node.qualifier
      while (qualifier?.type === "TSQualifiedName") qualifier = qualifier.left
      add(node, node.source.value, "import-type", true, qualifier ? [{ name: qualifier.name, typeOnly: true, line: lineOf(node) }] : [])
    } else if (node.type === "ImportExpression") {
      const specifier = esString(node.source)
      if (specifier !== undefined) load(node, specifier, "dynamic-import")
    } else if ((node.type === "CallExpression" || node.type === "NewExpression") && !isSynthesized(node)) {
      const callee = esCallee(node.callee)
      const inner = esUnwrap(node.callee)
      const literal = esString(node.arguments[0])
      if (literal !== undefined) {
        if (callee !== undefined && isLoader(callee)) load(node, literal, "require")
        else if (inner.type === "CallExpression" && !isSynthesized(inner) && isCreateRequire(esCallee(inner.callee))) {
          load(node, literal, "require")
        } else if (inner.type === "Identifier") pending.push({ node, callee: inner.name, specifier: literal })
      }
      if (callee !== undefined && node.type === "CallExpression") calls.push({ callee, line: lineOf(node) })
    } else if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init != null &&
      esUnwrap(node.init).type === "CallExpression" &&
      isCreateRequire(esCallee(esUnwrap(node.init).callee))
    ) {
      loaders.add(node.id.name)
    } else if (node.type === "Identifier" && parents.has(node)) {
      const reference = bindings.get(node.name)
      if (reference !== undefined) use(node, reference)
    }
    for (const [key, child] of esChildren(node)) {
      parents.set(child, { node, key })
      visit(child)
    }
  }
  ;(program.body as ReadonlyArray<EsNode>).forEach(visit)
  for (const call of pending) if (loaders.has(call.callee)) load(call.node, call.specifier, "require")

  return {
    references: entries.sort((a, b) => a.position - b.position).map((entry) => entry.reference),
    calls
  }
}

/**
 * The distinct module specifiers of an {@link Analysis}, sorted.
 *
 * @category analysis
 * @since 0.1.0
 */
export const specifiers = (analysis: Analysis): ReadonlyArray<string> =>
  [...new Set(analysis.references.map((reference) => reference.specifier))].sort()
