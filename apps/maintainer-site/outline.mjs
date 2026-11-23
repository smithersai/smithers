// Comment, fold and symbol ranges for the queue's code view, from TypeScript's own parser.
//
//   const ts = (await import("typescript")).default
//   outlineOf(ts, text, "ModelStep.ts") // { comments, folds, symbols }
//
// Lines are 1-based and columns 0-based UTF-16 offsets into the line, after \r\n becomes \n, the way the client splits
// the file. `typescript` is passed in, so this module has no dependencies; serve.mjs loads it on the first outline.

// The files TypeScript parses: TypeScript and JavaScript, with or without JSX.
export const OUTLINE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])

// A statement block folds only when it is this many lines or more; function, class and object bodies always fold.
export const LARGE_BLOCK = 6

export function outlineOf(ts, source, fileName = "file.ts") {
  // The browser's decoder drops a byte-order mark, so columns on line 1 match only without it.
  const text = String(source).replace(/^﻿/, "").replace(/\r\n?/g, "\n")
  const ext = (fileName.match(/\.[a-z]+$/i)?.[0] ?? ".ts").toLowerCase()
  const scriptKind = { ".tsx": ts.ScriptKind.TSX, ".jsx": ts.ScriptKind.JSX, ".js": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS }[ext] ?? ts.ScriptKind.TS
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind)
  const at = (pos) => {
    const { line, character } = file.getLineAndCharacterOfPosition(pos)
    return { line: line + 1, col: character }
  }
  return { comments: comments(ts, file, at), folds: folds(ts, file, at), symbols: symbols(ts, file, at) }
}

// ---------------------------------------------------------------------------------------------------------
// Comments: every comment the scanner sees between tokens, so `//` in a string, a template or a regular expression is
// never one. `lines` are runs of lines that hold only comments; `inline` are comments beside code, per line.

function comments(ts, file, at) {
  const text = file.text
  const S = ts.SyntaxKind
  // Collect every literal/JSX-text span from the real AST (without calling
  // `node.getChildren(file)`, which re-lexes every node). Any `//` or `/*`
  // outside these spans is a genuine comment, including comments inside
  // `${...}` template expressions and trailing comments on punctuation tokens.
  const excluded = []
  const collectExcluded = (node) => {
    const kind = node.kind
    if (
      kind === S.StringLiteral ||
      kind === S.NoSubstitutionTemplateLiteral ||
      kind === S.TemplateHead ||
      kind === S.TemplateMiddle ||
      kind === S.TemplateTail ||
      kind === S.RegularExpressionLiteral ||
      kind === S.JsxText
    ) {
      excluded.push([node.getStart(file), node.end])
      return
    }
    ts.forEachChild(node, collectExcluded)
  }
  collectExcluded(file)
  excluded.sort((a, b) => a[0] - b[0])

  const ranges = []
  const length = text.length
  let exIndex = 0
  let pos = 0
  while (pos < length) {
    while (exIndex < excluded.length && excluded[exIndex][1] <= pos) exIndex++
    if (exIndex < excluded.length && pos >= excluded[exIndex][0]) {
      pos = excluded[exIndex][1]
      continue
    }
    const nextSlash = text.indexOf("/", pos)
    if (nextSlash === -1) break
    while (exIndex < excluded.length && excluded[exIndex][1] <= nextSlash) exIndex++
    if (exIndex < excluded.length && nextSlash >= excluded[exIndex][0]) {
      pos = excluded[exIndex][1]
      continue
    }
    const nextChar = text.charCodeAt(nextSlash + 1)
    if (nextChar === 47) { // `//`
      const end = text.indexOf("\n", nextSlash + 2)
      const stop = end === -1 ? length : end
      ranges.push([nextSlash, stop])
      pos = stop
    } else if (nextChar === 42) { // `/*`
      const close = text.indexOf("*/", nextSlash + 2)
      const stop = close === -1 ? length : close + 2
      ranges.push([nextSlash, stop])
      pos = stop
    } else {
      pos = nextSlash + 1
    }
  }

  // Each comment, split per line.
  const perLine = new Map()
  for (const [startPos, endPos] of ranges) {
    const start = at(startPos)
    const stop = at(endPos)
    for (let line = start.line; line <= stop.line; line++) {
      const from = line === start.line ? start.col : 0
      const to = line === stop.line ? stop.col : Infinity
      if (!perLine.has(line)) perLine.set(line, [])
      perLine.get(line).push([from, to])
    }
  }
  const starts = file.getLineStarts()
  const lineText = (line) => text.slice(starts[line - 1], line < starts.length ? starts[line] - 1 : text.length)
  const lines = []
  const inline = []
  for (const [line, spans] of [...perLine].sort((a, b) => a[0] - b[0])) {
    const content = lineText(line)
    const clipped = spans.map(([from, to]) => [from, Math.min(to, content.length)]).filter(([from, to]) => to > from)
    if (!clipped.length) continue
    let rest = ""
    let col = 0
    for (const [from, to] of clipped) {
      rest += content.slice(col, from)
      col = to
    }
    rest += content.slice(col)
    if (rest.trim() === "") {
      const run = lines.at(-1)
      if (run && run[1] === line - 1) run[1] = line
      else lines.push([line, line])
    } else for (const [from, to] of clipped) inline.push([line, from, to])
  }
  return { lines, inline }
}

// ---------------------------------------------------------------------------------------------------------
// Folds: function, method, class and object bodies, and statement blocks of LARGE_BLOCK lines or more. Each runs from
// its `{` to its `}`; `open` and `close` are their columns. One fold per first line: the outermost.

function folds(ts, file, at) {
  const S = ts.SyntaxKind
  const found = []
  const add = (kind, open, close) => {
    const start = at(open)
    const end = at(close)
    if (end.line <= start.line) return
    if (kind === "block" && end.line - start.line + 1 < LARGE_BLOCK) return
    found.push({ from: start.line, to: end.line, open: start.col, close: end.col, kind })
  }
  const isFunction = (node) =>
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
  const visit = (node) => {
    if (isFunction(node) && node.body && ts.isBlock(node.body)) add("function", node.body.getStart(file), node.body.end - 1)
    else if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) add("class", node.members.pos - 1, node.end - 1)
    else if (ts.isModuleBlock(node)) add("class", node.getStart(file), node.end - 1)
    else if (ts.isObjectLiteralExpression(node) || ts.isTypeLiteralNode(node)) add("object", node.getStart(file), node.end - 1)
    else if ((ts.isBlock(node) && !isFunction(node.parent)) || node.kind === S.CaseBlock) add("block", node.getStart(file), node.end - 1)
    ts.forEachChild(node, visit)
  }
  visit(file)
  const byLine = new Map()
  for (const fold of found) {
    const held = byLine.get(fold.from)
    if (!held || fold.to > held.to) byLine.set(fold.from, fold)
  }
  return [...byLine.values()].sort((a, b) => a.from - b.from)
}

// ---------------------------------------------------------------------------------------------------------
// Symbols, in file order with their nesting: what a file declares at its top and in namespaces (functions, classes,
// interfaces, types, enums, variables, `export default`), class and interface members, the members of an object a
// declaration builds, functions declared inside functions, and the named steps of a generator: `const x = yield* …`,
// Effect.gen's steps. Kinds use the app's outline labels: fn, class, method, prop, new, enum, member, type, mod, const,
// var, step and default.

function symbols(ts, file, at) {
  const out = []
  const add = (name, kind, node, depth, exported = false) => {
    out.push({ name, kind, line: at(node.getStart(file)).line, depth, ...(exported ? { exported: true } : {}) })
  }
  const isExported = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
  const nameOf = (node) => {
    const name = node.name
    if (!name) return null
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
    return name.getText(file).replace(/\s+/g, " ")
  }
  const unwrap = (node) => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression
    return node
  }
  const isFunction = (node) => Boolean(node) && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
  const isStep = (node) => Boolean(node) && ts.isYieldExpression(node) && Boolean(node.asteriskToken)

  // A function's body: its statements, or an arrow's expression.
  const body = (node, depth, generator) => {
    if (!node) return
    if (ts.isBlock(node)) for (const child of node.statements) statement(child, depth, false, generator)
    else nested(node, depth, generator)
  }

  // A statement. `module` is true at the top of a file or a namespace, where every variable is listed; inside a function
  // only functions, classes and generator steps are.
  function statement(node, depth, module, generator) {
    if (ts.isFunctionDeclaration(node)) {
      add(nameOf(node) ?? "default", "fn", node.name ?? node, depth, isExported(node))
      return body(node.body, depth + 1, Boolean(node.asteriskToken))
    }
    if (ts.isClassDeclaration(node)) {
      add(nameOf(node) ?? "default", "class", node.name ?? node, depth, isExported(node))
      return members(node, depth + 1)
    }
    if (ts.isInterfaceDeclaration(node)) {
      add(nameOf(node), "type", node.name, depth, isExported(node))
      for (const member of node.members) if (member.name) add(nameOf(member), ts.isMethodSignature(member) ? "method" : "prop", member.name, depth + 1)
      return
    }
    if (ts.isTypeAliasDeclaration(node)) return add(nameOf(node), "type", node.name, depth, isExported(node))
    if (ts.isEnumDeclaration(node)) {
      add(nameOf(node), "enum", node.name, depth, isExported(node))
      for (const member of node.members) add(nameOf(member), "member", member.name, depth + 1)
      return
    }
    if (ts.isModuleDeclaration(node)) {
      add(nameOf(node), "mod", node.name, depth, isExported(node))
      let inner = node.body
      while (inner && ts.isModuleDeclaration(inner)) inner = inner.body
      if (inner && ts.isModuleBlock(inner)) for (const child of inner.statements) statement(child, depth + 1, true, false)
      return
    }
    if (ts.isVariableStatement(node)) {
      const kind = node.declarationList.flags & ts.NodeFlags.Const ? "const" : "var"
      for (const declaration of node.declarationList.declarations) variable(declaration, kind, depth, module, generator)
      return
    }
    if (ts.isExportAssignment(node)) {
      add("default", "default", node, depth, true)
      return expression(node.expression, depth + 1)
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return
    nested(node, depth, generator)
  }

  function variable(declaration, kind, depth, module, generator) {
    const value = unwrap(declaration.initializer)
    const name = nameOf(declaration)
    if (generator && isStep(value)) {
      add(name, "step", declaration.name, depth)
      return nested(value, depth + 1, generator)
    }
    if (isFunction(value)) {
      add(name, "fn", declaration.name, depth, isExported(declaration))
      return body(value.body, depth + 1, Boolean(value.asteriskToken))
    }
    if (value && ts.isClassExpression(value)) {
      add(name, "class", declaration.name, depth, isExported(declaration))
      return members(value, depth + 1)
    }
    if (module) {
      add(name, kind, declaration.name, depth, isExported(declaration))
      return expression(value, depth + 1)
    }
    if (value) nested(value, depth, generator)
  }

  function members(node, depth) {
    for (const member of node.members) {
      if (ts.isConstructorDeclaration(member)) {
        add("constructor", "new", member, depth)
        body(member.body, depth + 1, false)
      } else if (ts.isMethodDeclaration(member)) {
        add(nameOf(member), "method", member.name, depth)
        body(member.body, depth + 1, Boolean(member.asteriskToken))
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        add(nameOf(member), "prop", member.name, depth)
        body(member.body, depth + 1, false)
      } else if (ts.isPropertyDeclaration(member) && member.name) {
        const value = unwrap(member.initializer)
        add(nameOf(member), isFunction(value) ? "method" : "prop", member.name, depth)
        if (isFunction(value)) body(value.body, depth + 1, Boolean(value.asteriskToken))
        else expression(value, depth + 1)
      }
    }
  }

  // The value a declaration builds: an object's members, a function's body, and through calls and `.pipe(…)` to the
  // objects and functions passed in (`Flow.make("tag", { body })`, `Effect.gen(function* () { … })`).
  function expression(node, depth) {
    node = unwrap(node)
    if (!node) return
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
          add(nameOf(property), "method", property.name, depth)
          body(property.body, depth + 1, Boolean(property.asteriskToken))
        } else if (ts.isPropertyAssignment(property)) {
          const value = unwrap(property.initializer)
          add(nameOf(property), isFunction(value) ? "method" : "prop", property.name, depth)
          if (isFunction(value)) body(value.body, depth + 1, Boolean(value.asteriskToken))
          else expression(value, depth + 1)
        } else if (ts.isShorthandPropertyAssignment(property)) add(nameOf(property), "prop", property.name, depth)
      }
    } else if (isFunction(node)) body(node.body, depth, Boolean(node.asteriskToken))
    else if (ts.isClassExpression(node)) members(node, depth)
    else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      expression(node.expression, depth)
      for (const argument of node.arguments ?? []) expression(argument, depth)
    } else if (ts.isPropertyAccessExpression(node) || ts.isAwaitExpression(node) || ts.isYieldExpression(node)) expression(node.expression, depth)
  }

  // Inside a function: functions and classes declared in nested blocks, and the steps of the generators it passes on
  // (`Effect.forEach(items, (item) => Effect.gen(function* () { const x = yield* … }))`), at this depth.
  function nested(node, depth, generator) {
    if (isFunction(node)) return body(node.body, depth, Boolean(node.asteriskToken))
    const visit = (child) => {
      if (isFunction(child)) return body(child.body, depth, Boolean(child.asteriskToken))
      if (ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child) || ts.isVariableStatement(child)) return statement(child, depth, false, generator)
      if (ts.isClassExpression(child)) return members(child, depth)
      ts.forEachChild(child, visit)
    }
    ts.forEachChild(node, visit)
  }

  for (const child of file.statements) statement(child, 0, true, false)
  return out
}
