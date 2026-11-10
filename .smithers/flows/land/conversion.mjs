import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

/** VibeLang's parser, loaded on first use so landing tools that compare no migration need no install. */
const parser = () => require("vibelang/eslint")

// Only `function* () { … }`: a name binds inside the body, and `async` changes how `Effect.gen` drives it.
const isPlainGenerator = (node) =>
  node.type === "FunctionExpression" && node.generator && !node.async && node.id === null && node.params.length === 0 &&
  (node.returnType ?? null) === null && (node.typeParameters ?? null) === null

const isEffectGen = (node) =>
  node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed &&
  node.callee.object.name === "Effect" && node.callee.property.name === "gen" && node.arguments.length === 1 &&
  isPlainGenerator(node.arguments[0])

const isSynthesized = (node, name) => node.type === "CallExpression" && node.callee.synthesized === true && node.callee.name === name

// Where each `try` keyword starts. VibeLang's parser writes `try a(b)` as a bare call starting at that keyword, so only
// the position says it runs.
// `try { … }` is a plain statement and `try.all` is its own call; neither is an operand here.
const tryOperands = (tokens) => {
  const starts = new Set()
  tokens.forEach((token, index) => {
    if (token.type === "Keyword" && token.value === "try" && !["{", "."].includes(tokens[index + 1]?.value)) starts.add(token.range[0])
  })
  return starts
}

// A node with no position, and with TypeScript's `Effect.gen(function* () { … })` and `yield*` in the shape of
// VibeLang's `effect { … }` and `try`, so the two spellings of the same Effect code compare equal.
const canonicalizer = (operands) => {
  const canonical = (node) => {
    if (Array.isArray(node)) return node.map(canonical)
    if (node === null || typeof node !== "object") return node
    if (isEffectGen(node) || isSynthesized(node, "$effect")) return { effect: canonical(node.arguments[0].body) }
    if (node.type === "YieldExpression" && node.delegate) return { try: canonical(node.argument) }
    if (isSynthesized(node, "$try")) {
      operands.delete(node.callee.range[0])
      return { try: canonical(node.arguments[0]) }
    }
    if (node.type === "CallExpression" && operands.delete(node.range[0])) return { try: canonical(node) }
    const out = {}
    for (const key in node) if (!["range", "loc", "parent"].includes(key)) out[key] = canonical(node[key])
    return out
  }
  return canonical
}

// One key for each name an import binds, and one for an import that binds none, so neither can change unseen.
const importKeys = (imports) =>
  imports.flatMap((node) => {
    if (node.specifiers.length === 0) return [`${node.source.value}##`]
    return node.specifiers.map((specifier) => {
      const imported = specifier.type === "ImportDefaultSpecifier" ? "default"
        : specifier.type === "ImportNamespaceSpecifier" ? "*"
        : specifier.imported.name ?? specifier.imported.value
      return `${node.source.value}#${imported}#${specifier.local.name}#${node.importKind ?? ""}${specifier.importKind ?? ""}`
    })
  })

// VibeLang's prelude has `effect` and its modules in scope, so a conversion may drop an import of one under its own name.
const inPrelude = (key) => {
  const [source, imported, local] = key.split("#")
  return /^effect(?:\/[A-Za-z0-9_-]+)*$/.test(source) && imported === local
}

class UnplacedTry extends Error {}

const parse = (text, path) => {
  const tree = parser().parseESTree(text, path)
  const operands = tryOperands(tree.tokens)
  const body = JSON.stringify(canonicalizer(operands)(tree.body.filter((node) => node.type !== "ImportDeclaration")))
  // A `try` the tree did not account for could run anything, so it refuses.
  if (operands.size > 0) throw new UnplacedTry()
  return { imports: importKeys(tree.body.filter((node) => node.type === "ImportDeclaration")), body }
}

/**
 * Whether a published `.ts` migration and the `.vibe` file converted from it run the same statements. VibeLang's
 * parser reads both, so a comment or a string can't fool it. Only the two spellings VibeLang has for the same
 * Effect code may differ, and a conversion may add no import and drop only what the prelude supplies. A changed
 * statement, table, column or import fails, as it would for any other edit, and so does a `try` the tree can't place.
 */
export function sameMigration(published, converted) {
  let before, after
  try {
    before = parse(published, "published.vibe")
    after = parse(converted, "converted.vibe")
  } catch (error) {
    if (error instanceof UnplacedTry) return false
    throw error
  }
  // In order: a module's imports run in the order they are written.
  const kept = before.imports.filter((key) => !inPrelude(key) || after.imports.includes(key))
  return JSON.stringify(kept) === JSON.stringify(after.imports) && before.body === after.body
}
