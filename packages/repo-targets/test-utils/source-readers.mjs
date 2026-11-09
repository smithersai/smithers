// What a test that inspects this repository's source reads, for .ts and .vibe modules alike.
//
// A reader that lists `*.ts` files skips a module converted to VibeLang and passes without checking it, and one that
// reads `x.ts` by name fails once it is `x.vibe`. These helpers list and resolve both. A reader that looks for text
// (a string literal, a call it names) reads sourceText, the module as written, since VibeLang keeps TypeScript's
// expressions. A reader that walks a TypeScript syntax tree parses typeScriptOf: a TypeScript file as written, and a
// VibeLang module as the TypeScript projection VibeLang gives linters (`vibelang --ts-projection`), which keeps the
// module's offsets and lowers VibeLang's own forms, so `try e` reads `(yield* $run(e))` and `effect function f() {`
// reads `function f() { return $gen(function* () {`. The projection decides from the one file, so it may also rewrite
// a member call on a name it takes for a service (`try Users.find(id)` reads `$use(Users).find(id)`), and its types
// are not usable: it imports a prelude VibeLang does not ship.
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { findCompiler } from "vibelang/project"
import { isVibeLangFile, resolveSource } from "vibelang/source"

const SOURCE = /\.(?:tsx?|vibex?)$/
const DECLARATION = /\.d\.(?:[a-z]+\.)?tsx?$/
const pathOf = (path) => (path instanceof URL ? fileURLToPath(path) : path)

export const isSource = (path) => SOURCE.test(path) && !DECLARATION.test(path)

export const modulePath = (path) => {
  const resolved = resolveSource(pathOf(path))
  if (resolved === undefined) throw new Error(`No module at ${pathOf(path)}, nor a .vibe or .vibex beside it.`)
  return resolved
}

export const sourcesUnder = (directory, skip = () => false) => {
  const root = pathOf(directory)
  const walk = (relative) =>
    readdirSync(join(root, relative)).sort().flatMap((name) => {
      const path = relative ? `${relative}/${name}` : name
      if (name === "node_modules" || skip(path)) return []
      if (statSync(join(root, path)).isDirectory()) return walk(path)
      return isSource(name) ? [path] : []
    })
  return walk("")
}

export const sourceText = (path) => readFileSync(modulePath(path), "utf8")

const projections = new Map()
export const typeScriptOf = (path) => {
  const file = modulePath(path)
  if (!/\.vibex?$/.test(file) && !isVibeLangFile(file)) return readFileSync(file, "utf8")
  let text = projections.get(file)
  if (text === undefined) {
    const output = execFileSync(findCompiler(dirname(file)), ["--ts-projection", file], {
      input: readFileSync(file), encoding: "utf8", maxBuffer: 64 * 1024 * 1024
    })
    text = JSON.parse(output).text
    projections.set(file, text)
  }
  return text
}
