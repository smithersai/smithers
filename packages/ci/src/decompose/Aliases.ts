/**
 * Removes alias definitions from a file's text before it is scanned for what
 * it reads.
 *
 * An alias says where an import of a name would be found:
 *
 *     "paths": { "@acme/ui": ["../ui/src/index.ts"] }       // tsconfig.json
 *     alias: { "@acme/ui": path.resolve(root, "ui/src") }   // a bundler's config
 *
 * The file that holds the alias reads nothing through it. A resolver follows
 * it only for a module that imports the name, and that module's own text
 * names the package. A shared configuration that lists an alias for every
 * package would otherwise make every package reach every other.
 *
 * Only an entry keyed by a workspace package's name is removed, and in code
 * only when its value does nothing but build a path. Any other entry stays
 * and is read as before.
 *
 * @since 0.1.0
 */

import { findNodeAtLocation, type Node, parseTree } from "jsonc-parser"

const typescriptConfig = /(?:^|\/)[jt]sconfig(?:\.[^/]*)?\.json$/
const code = /\.[cm]?[jt]sx?$/

// The package an alias key names: the key itself, or the key without a
// trailing `/*` or subpath.
const packageOf = (key: string, names: ReadonlySet<string>): string | undefined => {
  const parts = key.split("/")
  const name = key.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] as string
  return names.has(name) ? name : undefined
}

const blank = (text: string, spans: ReadonlyArray<readonly [start: number, end: number]>): string => {
  let out = text
  for (const [start, end] of spans) {
    out = `${out.slice(0, start)}${out.slice(start, end).replace(/[^\n]/g, " ")}${out.slice(end)}`
  }
  return out
}

// The `compilerOptions.paths` entries of a tsconfig that are keyed by a package's name.
const tsconfigAliases = (text: string, names: ReadonlySet<string>): ReadonlyArray<readonly [number, number]> => {
  const tree: Node | undefined = parseTree(text, [], { allowTrailingComma: true })
  const paths = tree === undefined ? undefined : findNodeAtLocation(tree, ["compilerOptions", "paths"])
  const entries = paths?.type === "object" ? paths.children as ReadonlyArray<Node> : []
  return entries.flatMap((property) => {
    // A property's first child is its key.
    const key = (property.children as ReadonlyArray<Node>)[0]?.value as string
    return packageOf(key, names) === undefined ? [] : [[property.offset, property.offset + property.length] as const]
  })
}

const quotes = new Set(["\"", "'", "`"])
const opening = new Set(["(", "[", "{"])
const closing = new Set([")", "]", "}"])

// The index after the string literal that starts at `at`, or `undefined` when it does not end.
const stringEnd = (text: string, at: number): number | undefined => {
  const quote = text[at] as string
  for (let index = at + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1
    else if (text[index] === quote) return index + 1
  }
  return undefined
}

// Walks balanced code from `at` until `stop` says to stop at depth zero.
// Gives the index it stopped at, or `undefined` when the text ends first.
const walk = (text: string, at: number, stop: (char: string) => boolean): number | undefined => {
  let depth = 0
  for (let index = at; index < text.length;) {
    const char = text[index] as string
    if (quotes.has(char)) {
      const end = stringEnd(text, index)
      if (end === undefined) return undefined
      index = end
      continue
    }
    if (depth === 0 && stop(char)) return index
    if (opening.has(char)) depth += 1
    if (closing.has(char)) depth -= 1
    index += 1
  }
  return undefined
}

const pathBuilders = new Set([
  "path.resolve",
  "path.join",
  "path.normalize",
  "path.dirname",
  "resolve",
  "join",
  "dirname",
  "fileURLToPath",
  "URL"
])

// True when an expression only builds a path: string literals, names, and
// calls to functions that join or resolve paths. Such a value reads no file.
const buildsPath = (value: string): boolean => {
  const bare = value.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "")
  if (value.trim() === "" || !/^[\s\w.$,()]*$/.test(bare)) return false
  return [...bare.matchAll(/([\w.$]+)\s*\(/g)].every((call) => pathBuilders.has(call[1] as string))
}

// The entries of every `alias: { … }` map that are keyed by a package's name
// and whose value only builds a path.
const codeAliases = (text: string, names: ReadonlySet<string>): ReadonlyArray<readonly [number, number]> => {
  const spans: Array<readonly [number, number]> = []
  for (const map of text.matchAll(/\balias\s*:\s*\{/g)) {
    const open = map.index + map[0].length
    const close = walk(text, open, (char) => char === "}")
    if (close === undefined) continue
    for (let at = open; at < close;) {
      const end = walk(text, at, (char) => char === "," || char === "}") as number
      const entry = /^(\s*)(["'`])([^"'`]+)\2\s*:/.exec(text.slice(at, end))
      if (entry !== null && packageOf(entry[3] as string, names) !== undefined) {
        if (buildsPath(text.slice(at + entry[0].length, end))) spans.push([at + (entry[1] as string).length, end])
      }
      at = end + 1
    }
  }
  return spans
}

/**
 * A file's text with its alias definitions for workspace packages replaced
 * by spaces. Text that holds none is returned as it was.
 *
 * @throws {never}
 * @category scanning
 * @since 0.1.0
 */
export const withoutAliases = (file: string, text: string, names: ReadonlySet<string>): string => {
  if (typescriptConfig.test(file)) return blank(text, tsconfigAliases(text, names))
  return code.test(file) ? blank(text, codeAliases(text, names)) : text
}
