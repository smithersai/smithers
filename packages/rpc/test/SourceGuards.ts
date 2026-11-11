/** Source traversal and failure-site analysis shared by the contract guards. */
import { readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import ts from "typescript"

export const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(?:tsx?|vibe)$/.test(entry.name) && !/\.test\.(?:tsx?|vibe)$/.test(entry.name) ? [path] : []
  })

/** Analyze the complete source set so imported contract errors retain their tags. */
export const rawFailures = (files: ReadonlyArray<{ readonly file: string; readonly text: string }>) => {
  const key = (file: string): string => {
    const path = resolve(file).replaceAll("\\", "/")
    return ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase()
  }
  const parsed = files.map(({ file, text }) =>
    ts.createSourceFile(
      key(file),
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
  )
  // Bind only the supplied sources. Import aliases are scoped by their module;
  // no library implementation or ambient declarations are needed by this guard.
  const inputs = new Map(parsed.map((source) => [source.fileName, source]))
  const options: ts.CompilerOptions = {
    noLib: true,
    noEmit: true,
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler
  }
  const host = ts.createCompilerHost(options)
  host.fileExists = (file) => inputs.has(key(file))
  host.readFile = (file) => inputs.get(key(file))?.text
  host.getSourceFile = (file) => inputs.get(key(file))
  host.directoryExists = (directory) => {
    const path = key(directory)
    const prefix = path.endsWith("/") ? path : path + "/"
    return [...inputs.keys()].some((file) => file.startsWith(prefix))
  }
  const checker = ts.createProgram([...inputs.keys()], options, host).getTypeChecker()
  const nameOf = (expression: ts.Expression): string =>
    ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : ""
  const classOf = (expression: ts.Expression): ts.ClassLikeDeclaration | string => {
    let name = nameOf(expression)
    let symbol = checker.getSymbolAtLocation(expression)
    const imported = symbol?.declarations?.find(ts.isImportSpecifier)
    if (imported !== undefined) name = imported.propertyName?.text ?? imported.name.text
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    const declaration = symbol?.valueDeclaration
    if (declaration !== undefined) {
      if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return declaration
      if (
        ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined &&
        ts.isClassExpression(declaration.initializer)
      ) return declaration.initializer
    }
    return name
  }
  const isNamedTag = (name: ts.PropertyName): boolean =>
    (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "_tag"
  const hasTag = (node: ts.ClassLikeDeclaration): boolean =>
    node.members.some((member) =>
      ts.isPropertyDeclaration(member) && isNamedTag(member.name) &&
        !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ||
      ts.isConstructorDeclaration(member) && member.parameters.some((parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === "_tag" &&
          parameter.modifiers?.some((modifier) =>
            [
              ts.SyntaxKind.ReadonlyKeyword,
              ts.SyntaxKind.PublicKeyword,
              ts.SyntaxKind.ProtectedKeyword,
              ts.SyntaxKind.PrivateKeyword
            ].includes(modifier.kind)
          )
        )
    )
  const bases = (node: ts.ClassLikeDeclaration): ReadonlyArray<ts.ClassLikeDeclaration | string> =>
    (node.heritageClauses ?? []).flatMap((clause) =>
      clause.token === ts.SyntaxKind.ExtendsKeyword ? clause.types.map((parent) => classOf(parent.expression)) : []
    )
  const inherits = (
    value: ts.ClassLikeDeclaration | string,
    matches: (value: ts.ClassLikeDeclaration | string) => boolean,
    seen = new Set<ts.ClassLikeDeclaration>()
  ): boolean => {
    if (matches(value)) return true
    if (typeof value === "string" || seen.has(value)) return false
    seen.add(value)
    return bases(value).some((parent) => inherits(parent, matches, seen))
  }
  const isError = (value: ts.ClassLikeDeclaration | string): boolean =>
    inherits(value, (value) =>
      /^(?:[A-Z][A-Za-z0-9_$]*)?Error$/.test(
        typeof value === "string" ? value : value.name?.text ?? ""
      ))
  const isTagged = (value: ts.ClassLikeDeclaration | string): boolean =>
    inherits(value, (value) => typeof value !== "string" && hasTag(value))

  return new Map(parsed.map((source, index) => {
    const lines = new Set<number>()
    const isText = (node: ts.Node): boolean =>
      ts.isParenthesizedExpression(node) ? isText(node.expression) : /^["'`]/.test(node.getText(source))
    const visit = (node: ts.Node): void => {
      let raw = false
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        raw = bases(node).some(isError) && !hasTag(node) && !bases(node).some(isTagged)
      } else if (ts.isNewExpression(node)) {
        const value = classOf(node.expression)
        raw = isError(value) && !isTagged(value)
      } else if (ts.isThrowStatement(node)) {
        raw = isText(node.expression)
      } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const member = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : node.argumentExpression !== undefined && ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text :
          ""
        raw = ["parse", "parseAsync"].includes(member) &&
          !(ts.isIdentifier(node.expression) && ["JSON", "Date"].includes(node.expression.text))
      } else if (
        ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Effect" &&
        ["fail", "die"].includes(node.expression.name.text) && node.arguments[0] !== undefined
      ) {
        raw = isText(node.arguments[0])
      }
      if (raw) lines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
      ts.forEachChild(node, visit)
    }
    visit(source)
    return [files[index]!.file, [...lines].sort((a, b) => a - b)] as const
  }))
}

/** Analyze one snippet with the same guard used for the package source set. */
export const rawFailureLines = (text: string, file = "source.ts"): ReadonlyArray<number> =>
  rawFailures([{ file, text }]).get(file) ?? []

/** Static module specifiers, including side effects and commented import/require calls. */
export const moduleSpecifiers = (text: string, file = "source.ts"): ReadonlyArray<string> => {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        found.push(node.moduleSpecifier.text)
      }
    } else if (
      ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined && ts.isStringLiteral(node.moduleReference.expression)
    ) {
      found.push(node.moduleReference.expression.text)
    } else if (
      ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
    ) {
      found.push(node.argument.literal.text)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === "require")
    ) {
      const argument = node.arguments[0]
      if (argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        found.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}
