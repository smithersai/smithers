/**
 * The other files a discovered module's body runs.
 *
 * A module body's `contentDigest` measures the ENTRY FILE and nothing else.
 * Everything the entry reaches is code the flow runs and the entry digest
 * never saw: a helper edited after a plan was approved would keep the
 * approval, and a loader that reopened the helper's path would run bytes no
 * one measured.
 *
 * This module closes that gap by naming what the entry reaches. It walks the
 * transitive closure of RELATIVE specifiers (`./`, `../`) statically — the same
 * lexer `ModuleMetadata` reads declarations with — and records each reached
 * module as a path relative to the entry's directory plus the digest of its
 * bytes. Discovery puts that list on the module {@link module:Descriptor.BodyRef},
 * so it rides `Descriptor.executionDigest` through the existing schema
 * encoding, and the loader recomputes it with {@link snapshot} before
 * importing anything, then evaluates the very bytes it measured.
 *
 * A BARE SPECIFIER IS NOT ALWAYS A PACKAGE. `@smthrs/flow` and `effect`
 * resolve into installed code, which is the host's own code and carries the
 * host's trust. But a loader can map a bare specifier onto the project's own
 * files: a package.json `imports` entry (`#impl` → `./impl.ts`), a tsconfig
 * or jsconfig `paths` alias or `baseUrl` (which Bun honours), and a package
 * importing itself by name through its `exports`. The walk follows the first
 * two to the files they name and pins those, and reports a `#` specifier it
 * cannot map and a self-import as unpinnable. What is left resolves into
 * installed packages and is not measured.
 *
 * A COMPUTED LOAD IS DECIDED WHEN IT RUNS. `createRequire(...)` and
 * `import(name)` name their file only at run time, so the walk records the
 * module as one that computes loads ({@link ModuleImport} `computed`) and the
 * loader admits it only on a host whose {@link module:LoadGuard} refuses, at
 * run time, every unmeasured file inside the flow's source root.
 *
 * THE PIN IS NOT A SANDBOX. It covers the loads this scan can read. A module
 * that hides a load behind `eval`, `new Function`, or a member access whose
 * name is computed at run time loads a file the pin does not measure; the
 * hiding code is itself in the digested source an approver reviews.
 *
 * TYPE-ONLY IMPORTS ARE PINNED TOO. `import type ... from "./x.ts"` is erased
 * before anything runs, so pinning it is conservative rather than necessary. It
 * costs an approval when a types-only sibling changes and saves deciding, per
 * specifier, whether a compiler would have erased it.
 *
 * @since 1.0.0-rc.0
 */

import { parse } from "@babel/parser"
import * as Digest from "@smthrs/core/Digest"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import type { ModuleImport } from "../Descriptor.ts"
import * as Prompt from "../Prompt.ts"
import { stringLiteral, type Token, tokenize } from "./ModuleMetadata.ts"

/**
 * How many modules one entry's closure may name.
 *
 * A closure past the bound is not pinned and says so, because the alternative
 * is a discovery scan whose cost is a flow author's import graph.
 *
 * @category constants
 * @since 1.0.0-rc.0
 * @private
 */
export const closureFileLimit = 512

/**
 * How many bytes one entry's closure may total.
 *
 * @category constants
 * @since 1.0.0-rc.0
 * @private
 */
export const closureByteLimit = 16 * 1024 * 1024

/**
 * How many bytes one package.json, tsconfig.json or jsconfig.json may hold.
 *
 * A larger config is not parsed, and a bare specifier it could map is reported
 * as unpinnable: a loader would still honour the mapping, so reading the
 * config as absent would leave the mapped file unmeasured.
 *
 * @category constants
 * @since 1.0.0
 * @private
 */
export const configByteLimit = 1024 * 1024

/**
 * How many configs one inheritance chain may traverse.
 * @category constants
 * @since 1.0.0
 * @private
 */
export const configDepthLimit = 64

/**
 * How many uncached evaluations one config inheritance resolution may perform.
 * Cycles cannot share context-dependent partial options, so they also need a
 * total work ceiling rather than only the inheritance-depth ceiling.
 * @category constants
 * @since 1.0.0
 * @private
 */
export const configEvaluationLimit = 4096

interface Effective {
  readonly paths?: { readonly map: Record<string, unknown>; readonly base: string }
  readonly baseUrl?: string
  readonly depth: number
  readonly truncated: boolean
  readonly cyclic: boolean
  readonly contextual: boolean
  readonly exhausted: boolean
  /** Config paths and refusal reasons, independent of the importer and specifier. */
  readonly problems: ReadonlyMap<string, string>
}

/**
 * The directory a source's closure must stay inside: as the source spells it,
 * and with every symbolic link resolved.
 *
 * @category models
 * @since 1.0.0
 * @private
 */
export interface Confinement {
  readonly root: string
  readonly realRoot: string
}

/** Whether `candidate` is `root` or a path beneath it. Both are resolved paths. */
const contains = (path: Path.Path, root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(path.join(root, path.sep))

/**
 * How a walk reads files.
 *
 * A discovery scan reads hostile trees nobody has measured, so it reads
 * through a `"bounded"` stream. The loader re-measures a closure discovery
 * already held to its ceilings, on hosts whose confined file system offers
 * only atomic whole-file reads (no `stream`, no `open`), so it reads `"whole"`
 * files and checks the size the host reported before, and the bytes after.
 */
type Reading = "bounded" | "whole"

/**
 * A file's bytes, or `undefined` when it holds more than `limit` of them.
 *
 * A `"bounded"` read stops one byte past the ceiling, so a file of any size
 * costs at most `limit + 1` bytes of memory, whatever size the host reports
 * for it. A `"whole"` read is checked after the host returned it.
 */
const readWithin = (fs: FileSystem.FileSystem, file: string, limit: number, reading: Reading) =>
  reading === "whole"
    ? Effect.map(fs.readFile(file), (bytes) => bytes.length > limit ? undefined : bytes)
    : fs.stream(file, { bytesToRead: limit + 1 }).pipe(
      Stream.runCollect,
      Effect.map((chunks) => {
        const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
        if (size > limit) return undefined
        const bytes = new Uint8Array(size)
        let position = 0
        for (const chunk of chunks) {
          bytes.set(chunk, position)
          position += chunk.length
        }
        return bytes
      })
    )

/**
 * The suffixes a specifier is resolved through, in order.
 *
 * The exact path is checked first; these are what an extensionless specifier such as
 * `"../coding/schema"` means under this project's loaders.
 */
const suffixes = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".vibe"]

/**
 * The TypeScript sources a JavaScript specifier stands for.
 *
 * Under NodeNext, `import "./schema.js"` names `schema.ts`: the author writes
 * the extension the module will have after compilation. TypeScript and Bun
 * both resolve it that way when no `.js` file exists, so the pinner does too.
 */
const typeScriptCounterparts: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  [".js", [".ts", ".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]]
]

/** The files a specifier naming a DIRECTORY resolves to. */
const indexNames = ["index.ts", "index.tsx", "index.mts", "index.js", "index.mjs", "index.vibe"]

/** VibeLang's source loader follows the compiler's extensionless lookup order. */
const vibeSuffixes = [".ts", ".tsx", ".vibe", ".js", ".jsx"]
const vibeIndexNames = vibeSuffixes.map((extension) => `index${extension}`)

/** A shared directory can hold importers in both languages with different .js counterparts. */
const resolutionKey = (directory: string, specifier: string, vibe: boolean): string =>
  `${directory}\0${specifier}\0${vibe}`

/**
 * The literal specifier of one static `import` or `export`, and the source
 * range of the string token that spells it, quotes included.
 *
 * @category models
 * @since 1.0.0
 * @private
 */
export interface StaticSpecifier {
  readonly literal: string
  readonly start: number
  readonly end: number
}

/**
 * What one module's source says it loads from beside itself.
 *
 * `opaque` counts the loads whose target is not a literal: an `import(...)` or
 * `require(...)` (including `import.meta.require(...)`) whose argument is
 * computed, every mention of `createRequire` (called, imported, or renamed),
 * every `require` used as a value rather than called (`const r = require`),
 * and every import of `module` or `node:module`, since each yields a loader
 * whose calls this scan cannot follow. The target of one is decided at run time, so
 * no static walk can pin it, and a module carrying one is reported as
 * unpinnable rather than as pinned. `unparsed` says the count includes source
 * the lexer could not read to its end, which can hide any load at all, a
 * static one included. `absolute` lists the literal specifiers
 * that name a file by absolute path or `file:` URL; the pin records paths
 * relative to the entry and does not follow them, so they are unpinnable too.
 * `bare` lists every other literal specifier except `node:` and `bun:`
 * builtins; {@link collect} decides which of them name project files.
 * `builtins` retains those host imports for the approval disclosure.
 * `statics` locates every literal specifier of a static `import` or `export`
 * — not of an `import()` or `require()` call — as the string token's source
 * range, which is what {@link snapshot} rewrites.
 *
 * A lexer cannot always tell a division from a regular expression (see
 * `SlashReading`): a line starting `/` after a TypeScript type annotation
 * begins a regular expression where the same tokens in JavaScript divide. So
 * the source is read both ways and every list is their union, with the larger
 * `opaque` count, so a load either reading exposes is pinned or refused.
 * Neither reading is a parser: source that mixes both ambiguities can still
 * mislead both, which is one more reason the pin is not a sandbox. `statics`
 * come from the likely reading alone, because they locate text to rewrite.
 *
 * @category parsing
 * @since 1.0.0-rc.0
 * @private
 */
export const specifiersOf = (source: string, file: string): Specifiers => {
  const tokens = tokenize(source, "likely")
  const erased = importTypes(source, tokens, file)
  const likely = scan(tokens, erased)
  const alternate = scan(tokenize(source, "alternate"), erased)
  const union = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => [
    ...left,
    ...right.filter((specifier) => !left.includes(specifier))
  ]
  return {
    relative: union(likely.relative, alternate.relative),
    opaque: Math.max(likely.opaque, alternate.opaque),
    unparsed: likely.unparsed || alternate.unparsed,
    absolute: union(likely.absolute, alternate.absolute),
    bare: union(likely.bare, alternate.bare),
    builtins: union(likely.builtins, alternate.builtins),
    runtime: union(likely.runtime, alternate.runtime),
    statics: likely.statics
  }
}

interface Specifiers {
  readonly relative: ReadonlyArray<string>
  readonly opaque: number
  readonly unparsed: boolean
  readonly absolute: ReadonlyArray<string>
  readonly bare: ReadonlyArray<string>
  readonly builtins: ReadonlyArray<string>
  readonly runtime: ReadonlyArray<string>
  readonly statics: ReadonlyArray<StaticSpecifier>
}

/**
 * Only a parsed TypeScript import type may be exempted from runtime loads.
 * In particular, `typeof import("x")` is also a valid JavaScript expression.
 * Unsupported syntax retains the lexer's conservative runtime classification.
 */
const importTypes = (source: string, tokens: ReadonlyArray<Token>, file: string): ReadonlySet<number> => {
  const erased = new Set<number>()
  // JavaScript comparisons can spell a TypeScript type argument. The host
  // executes JavaScript as JavaScript, including compiled MDX expressions.
  if (!/\.(?:[cm]?ts|tsx|vibe)$/.test(file)) return erased
  if (!tokens.some((token, index) => token.value === "import" && tokens[index + 1]?.value === "(")) return erased
  try {
    const syntax = parse(source, {
      sourceType: "module",
      plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"]
    })
    const pending: Array<unknown> = [syntax.program]
    while (pending.length > 0) {
      const value = pending.pop()
      if (Array.isArray(value)) {
        for (const child of value) pending.push(child)
      } else if (value !== null && typeof value === "object") {
        const node = value as { readonly type?: string; readonly start: number }
        if (node.type === "TSImportType") erased.add(node.start)
        for (const child of Object.values(value)) pending.push(child)
      }
    }
  } catch {
    // A failed parse is never evidence that a load is erased.
  }
  return erased
}

const scan = (tokens: ReadonlyArray<Token>, erased: ReadonlySet<number>): Specifiers => {
  const relative: Array<string> = []
  const absolute: Array<string> = []
  const bare: Array<string> = []
  const builtins: Array<string> = []
  const runtime: Array<string> = []
  const statics: Array<StaticSpecifier> = []
  let opaque = 0
  let unparsed = false
  const recordStatic = (token: Token) => {
    const literal = stringLiteral(token.value)
    if (literal !== undefined) statics.push({ literal, start: token.start, end: token.end })
    record(literal)
  }
  const record = (literal: string | undefined) => {
    if (literal === undefined) return
    if (isRelativeSpecifier(literal)) relative.push(literal)
    else if (isAbsoluteSpecifier(literal)) absolute.push(literal)
    else if (literal === "module" || literal === "node:module") {
      opaque++
      builtins.push(literal)
    } else if (literal.startsWith("node:") || literal.startsWith("bun:")) builtins.push(literal)
    else bare.push(literal)
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.kind === "unparsed") {
      opaque++
      unparsed = true
      continue
    }
    // `host["require"]` reaches the loader through a computed member access
    // that names it with a literal, which is a loader under another spelling.
    if (token.kind === "string") {
      const literal = stringLiteral(token.value)
      if (
        (literal === "require" || literal === "createRequire") &&
        tokens[index - 1]?.value === "[" && tokens[index + 1]?.value === "]"
      ) opaque++
    }
    if (token.kind !== "identifier") continue
    // `createRequire` in any position: `createRequire(...)`, and the renames
    // `import { createRequire as load }` and `const load = createRequire`
    // that would otherwise hide the call behind another name.
    if (token.value === "createRequire") {
      opaque++
      continue
    }
    // `require` used as a value — `const load = require`, `[require][0]`,
    // `fn(require)` — is a loader under another name. `require.resolve`
    // names a path without loading it, an object key `{ require: … }` is
    // not the binding, and neither is a property of an ordinary object
    // (`opts.require = true`). A property of a host object that carries the
    // loader (`import.meta.require`, `module.require`, `globalThis.require`)
    // is still the loader.
    if (token.value === "require" && tokens[index + 1]?.value !== "(") {
      const next = tokens[index + 1]?.value
      const previous = tokens[index - 1]?.value
      const resolveOnly = next === "." && tokens[index + 2]?.value === "resolve"
      const objectKey = next === ":" && (previous === "{" || previous === ",")
      const owner = tokens[index - (tokens[index - 2]?.value === "?" ? 3 : 2)]?.value
      const ordinaryProperty = previous === "." && owner !== undefined && !loaderHosts.has(owner)
      if (!resolveOnly && !objectKey && !ordinaryProperty) opaque++
      continue
    }
    if ((token.value === "import" || token.value === "require") && tokens[index + 1]?.value === "(") {
      const argument = tokens[index + 2]
      // `import("./x.ts")` and `require("./x.ts")` name their target;
      // `import(name)` does not, and neither does a template with a
      // substitution in it.
      const literal = argument?.kind === "string" ? stringLiteral(argument.value) : undefined
      if (token.value === "import" && erased.has(token.start)) record(literal)
      else if (literal === undefined || tokens[index + 3]?.value !== ")") opaque++
      else {
        record(literal)
        runtime.push(literal)
      }
      continue
    }
    // `import "./side-effect.ts"`, which names no bindings and so has no `from`.
    if (token.value === "import" && tokens[index + 1]?.kind === "string") {
      recordStatic(tokens[index + 1]!)
      continue
    }
    // Every other module specifier — `import … from "x"`, `export … from "x"`,
    // `export * from "x"` — sits immediately after the contextual keyword
    // `from`. A `from` followed by a string literal has no other meaning in a
    // module: an object key is `from:`, an argument is `from,`, an assignment
    // is `from =`.
    if (token.value === "from" && tokens[index + 1]?.kind === "string") {
      recordStatic(tokens[index + 1]!)
    }
  }
  return { relative, opaque, unparsed, absolute, bare, builtins, runtime, statics }
}

/**
 * The objects whose `require` property is the module loader: `import.meta`
 * (read as its last segment, `meta`), CommonJS `module`, and the global object
 * under each of its names. A `require` property of any other object is data.
 */
const loaderHosts: ReadonlySet<string> = new Set(["meta", "module", "globalThis", "global", "self", "window"])

/** A specifier naming a file beside the importer. */
const isRelativeSpecifier = (specifier: string): boolean => specifier.startsWith("./") || specifier.startsWith("../")

/** A specifier naming a file by absolute path or URL rather than beside the importer. */
const isAbsoluteSpecifier = (specifier: string): boolean =>
  specifier.startsWith("/") || specifier.startsWith("\\") || /^file:/i.test(specifier) ||
  /^[A-Za-z]:[\\/]/.test(specifier)

/** A POSIX-separated path from `fromDirectory` to `target`, for the record. */
const relativePath = (path: Path.Path, fromDirectory: string, target: string): string =>
  path.relative(fromDirectory, target).replaceAll("\\", "/")

/** What `base` can stand for when it is not itself a file, in the loader's order. */
const fallbacks = (path: Path.Path, base: string, vibe: boolean): ReadonlyArray<string> => {
  const candidates: Array<string> = []
  for (const [extension, sources] of typeScriptCounterparts) {
    if (!base.endsWith(extension)) continue
    for (const source of vibe && extension === ".js" ? [".vibe", ...sources] : sources) {
      candidates.push(`${base.slice(0, -extension.length)}${source}`)
    }
  }
  candidates.push(
    ...(vibe ? vibeSuffixes : suffixes).map((suffix) => `${base}${suffix}`),
    ...(vibe ? vibeIndexNames : indexNames).map((name) => path.join(base, name))
  )
  return candidates
}

/**
 * The module of a measured closure a relative specifier names, in the order
 * {@link resolve} probes the disk. Every file a relative specifier resolves to
 * is a module of the closure that pinned it, so membership answers what the
 * disk answered when the closure was measured.
 */
const member = (
  path: Path.Path,
  directory: string,
  specifier: string,
  has: (file: string) => boolean,
  vibe: boolean
): string | undefined => {
  const base = path.resolve(directory, specifier)
  return [base, ...fallbacks(path, base, vibe)].find(has)
}

/**
 * The file a relative specifier names, or `undefined` when nothing answers to
 * it. The order is the loader's: the exact path first, then the suffixes this
 * project's specifiers omit, then a directory's index.
 */
const resolve = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  fromDirectory: string,
  specifier: string,
  memo: Cache,
  vibe: boolean
): Effect.Effect<string | undefined> =>
  Effect.gen(function*() {
    const key = resolutionKey(fromDirectory, specifier, vibe)
    if (memo.resolutions.has(key)) return memo.resolutions.get(key)
    // Different importers and aliases can probe the same absolute candidate.
    // Cache misses too: wildcard paths usually leave bare imports to packages.
    const isFile = (candidate: string) =>
      Effect.gen(function*() {
        if (memo.isFile.has(candidate)) return memo.isFile.get(candidate)!
        const stat = yield* Effect.result(fs.stat(candidate))
        const found = stat._tag === "Success" && stat.success.type === "File"
        memo.isFile.set(candidate, found)
        if (found) memo.sizes.set(candidate, Number(stat.success.size))
        return found
      })
    const base = path.resolve(fromDirectory, specifier)
    if (yield* isFile(base)) {
      memo.resolutions.set(key, base)
      return base
    }
    const candidates = fallbacks(path, base, vibe)
    // Most fallbacks are missing wildcard aliases. Overlap their host reads,
    // then select in loader order regardless of which probe finished first.
    const matches = yield* Effect.forEach(candidates, isFile, { concurrency: 16 })
    const resolved = candidates[matches.findIndex(Boolean)]
    memo.resolutions.set(key, resolved)
    return resolved
  })

/**
 * A JSON document that may carry comments and trailing commas, as tsconfig and
 * jsconfig files do. `undefined` when it is not an object even then.
 */
const parseJsonc = (text: string): Record<string, unknown> | undefined => {
  let out = ""
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (character === "\"") {
      let end = index + 1
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1
      out += text.slice(index, end + 1)
      index = end
    } else if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++
    } else if (character === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++
      index++
    } else {
      out += character
    }
  }
  try {
    const parsed: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** A record field that is itself a plain object. */
const objectField = (value: unknown, key: string): Record<string, unknown> | undefined => {
  const field = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? field as Record<string, unknown>
    : undefined
}

/**
 * What a `paths`/`imports`-style pattern key makes of a specifier: the text
 * its one `*` stands for, `""` for an exact key, or `undefined` for no match.
 */
const matchPattern = (key: string, specifier: string): string | undefined => {
  const star = key.indexOf("*")
  if (star === -1) return key === specifier ? "" : undefined
  const prefix = key.slice(0, star)
  const suffix = key.slice(star + 1)
  return specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined
}

/** Every string a package.json `imports` target can stand for, across its conditions. */
const targetLeaves = (target: unknown): ReadonlyArray<string> =>
  typeof target === "string"
    ? [target]
    : Array.isArray(target)
    ? target.flatMap(targetLeaves)
    : typeof target === "object" && target !== null
    ? Object.values(target).flatMap(targetLeaves)
    : []

/** The package a bare specifier names: `@scope/name` or `name`. */
const packageName = (specifier: string): string => {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}

/** The files, and the refusals, one bare specifier comes to from one directory. */
interface BareTargets {
  readonly files: ReadonlyArray<string>
  readonly unpinnable: ReadonlyArray<string>
}

/**
 * The project files a bare specifier can load from `directory`, by every
 * mapping a loader honours, and what could not be followed.
 *
 * A `#` specifier is a package.json `imports` key, resolved against the
 * nearest package.json the way Node and Bun do. Any other bare specifier is
 * checked against the `paths` and `baseUrl` of EVERY tsconfig.json and
 * jsconfig.json above the importer, followed through `extends`: which one a
 * loader consults differs between loaders, and pinning a file a loader would
 * not have picked costs an approval, never a hole. A candidate that is not a
 * file is dropped, which is how `"*": ["./*"]` leaves `effect` to the
 * installed package. A specifier naming the nearest package.json's own `name`
 * is a self-import through `exports`, which this walk does not follow. A
 * config past {@link configByteLimit} is not parsed, and the specifier is
 * unpinnable because that config could map it.
 */
const bareTargets = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  specifier: string,
  memo: Cache,
  reading: Reading
): Effect.Effect<BareTargets> =>
  Effect.gen(function*() {
    const files: Array<string> = []
    const unpinnable: Array<string> = []
    const problems = new Map<string, string>()
    const configs = memo.configs
    const configRefusals = () =>
      [...problems].map(([file, reason]) =>
        `"${specifier}", which "${relativePath(path, directory, file)}" may map: ${reason}`
      )
    // A config that is missing, unreadable or not a JSON object is no config.
    const readConfig = (file: string, failures = problems) =>
      Effect.gen(function*() {
        if (!configs.has(file)) {
          const bytes = yield* Effect.result(readWithin(fs, file, configByteLimit, reading))
          configs.set(
            file,
            bytes._tag === "Failure"
              ? undefined
              : bytes.success === undefined
              ? "oversized"
              : parseJsonc(new TextDecoder().decode(bytes.success))
          )
        }
        const config = configs.get(file)
        if (config !== "oversized") return config
        failures.set(file, `that config is larger than ${configByteLimit} bytes`)
        return undefined
      })
    const ancestors: Array<string> = []
    for (let current = path.resolve(directory);;) {
      ancestors.push(current)
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    let nearestPackage: { readonly directory: string; readonly json: Record<string, unknown> } | undefined
    for (const candidate of ancestors) {
      const json = yield* readConfig(path.join(candidate, "package.json"))
      if (json === undefined) continue
      nearestPackage = { directory: candidate, json }
      break
    }

    if (specifier.startsWith("#")) {
      let matched = false
      for (const [key, target] of Object.entries(objectField(nearestPackage?.json, "imports") ?? {})) {
        const star = matchPattern(key, specifier)
        if (star === undefined) continue
        matched = true
        for (const leaf of targetLeaves(target)) {
          if (leaf.startsWith("./")) files.push(path.resolve(nearestPackage!.directory, leaf.replaceAll("*", star)))
          else unpinnable.push(`"${specifier}" maps to "${leaf}", which the pin does not follow`)
        }
      }
      if (!matched) unpinnable.push(`"${specifier}" names no package.json "imports" entry the pin can follow`)
      return { files, unpinnable: [...unpinnable, ...configRefusals()] }
    }

    const name = nearestPackage?.json["name"]
    if (name === packageName(specifier) && nearestPackage?.json["exports"] !== undefined) {
      unpinnable.push(
        `"${specifier}" imports the flow's own package through its "exports", which the pin does not follow`
      )
    }

    // One config's effective `paths` and `baseUrl`, through `extends`. A
    // config that extends itself, however indirectly, stops at `seen`.
    const effective = (
      file: string,
      json: Record<string, unknown>,
      seen: ReadonlySet<string>,
      budget: { evaluated: number }
    ): Effect.Effect<Effective> =>
      Effect.gen(function*() {
        if (seen.size > configDepthLimit) {
          return { depth: 1, truncated: true, cyclic: false, contextual: false, exhausted: false, problems: new Map() }
        }
        // Truncated results depend on the remaining depth. Keep them separate
        // so a later, shorter chain can still resolve this same config fully.
        // Package-style extends uses this importer's ancestor search path.
        // Relative-only inheritance can share its result across directories.
        const contextKey = `${file}\0${directory}`
        const depthKey = `${contextKey}\0${configDepthLimit - seen.size}`
        const rootKey = `${file}\0root`
        const contextRootKey = `${contextKey}\0root`
        const root = seen.size === 1
        const cached = (root ? memo.effective.get(rootKey) ?? memo.effective.get(contextRootKey) : undefined) ??
          memo.effective.get(file) ?? memo.effective.get(contextKey) ?? memo.effective.get(depthKey)
        if (cached !== undefined) {
          return !cached.truncated && seen.size + cached.depth - 1 > configDepthLimit
            ? { ...cached, truncated: true }
            : cached
        }
        if (budget.evaluated >= configEvaluationLimit) {
          return {
            depth: 1,
            truncated: true,
            cyclic: false,
            contextual: false,
            exhausted: true,
            problems: new Map()
          }
        }
        budget.evaluated++
        const here = path.dirname(file)
        let inherited: Effective = {
          depth: 1,
          truncated: false,
          cyclic: false,
          contextual: false,
          exhausted: false,
          problems: new Map()
        }
        const failures = new Map<string, string>()
        let depth = 1
        let truncated = false
        let cyclic = false
        let contextual = false
        let exhausted = false
        const extended = json["extends"]
        for (const parent of Array.isArray(extended) ? extended : [extended]) {
          if (typeof parent !== "string") {
            continue
          }
          const relative = parent.startsWith(".") || path.isAbsolute(parent)
          contextual ||= !relative
          const bases = relative
            ? [path.resolve(here, parent)]
            : ancestors.map((dir) => path.join(dir, "node_modules", parent))
          const candidates = bases.flatMap((base) => [base, `${base}.json`, path.join(base, "tsconfig.json")])
          for (const candidate of candidates) {
            const parentJson = yield* readConfig(candidate, failures)
            if (parentJson === undefined) continue
            if (seen.has(candidate)) {
              cyclic = true
              continue
            }
            const resolved = yield* effective(candidate, parentJson, new Set([...seen, candidate]), budget)
            depth = Math.max(depth, resolved.depth + 1)
            truncated ||= resolved.truncated
            cyclic ||= resolved.cyclic
            contextual ||= resolved.contextual
            exhausted ||= resolved.exhausted
            for (const [config, reason] of resolved.problems) failures.set(config, reason)
            inherited = { ...inherited, ...resolved }
            break
          }
        }
        const options = objectField(json, "compilerOptions")
        const map = objectField(options, "paths")
        const baseUrl = options?.["baseUrl"]
        const result: Effective = {
          ...inherited,
          ...(typeof baseUrl === "string" ? { baseUrl: path.resolve(here, baseUrl) } : {}),
          ...(map === undefined ? {} : { paths: { map, base: here } }),
          depth,
          truncated,
          cyclic,
          contextual,
          exhausted,
          problems: failures
        }
        // A cycle's partial options depend on which ancestor was skipped.
        // Root evaluations always start with the same chain and work budget.
        if (root) memo.effective.set(contextual ? contextRootKey : rootKey, result)
        if (!cyclic && !exhausted) memo.effective.set(truncated ? depthKey : contextual ? contextKey : file, result)
        return result
      })

    for (const candidate of ancestors) {
      for (const configName of ["tsconfig.json", "jsconfig.json"]) {
        const file = path.join(candidate, configName)
        const json = yield* readConfig(file)
        if (json === undefined) continue
        const resolved = yield* effective(file, json, new Set([file]), { evaluated: 0 })
        for (const [config, reason] of resolved.problems) problems.set(config, reason)
        if (resolved.truncated) {
          problems.set(
            file,
            resolved.exhausted
              ? `config inheritance exceeds ${configEvaluationLimit} evaluations`
              : `config inheritance exceeds ${configDepthLimit} files`
          )
          continue
        }
        const { baseUrl, paths } = resolved
        if (paths !== undefined) {
          for (const [key, targets] of Object.entries(paths.map)) {
            const star = matchPattern(key, specifier)
            if (star === undefined || !Array.isArray(targets)) continue
            for (const target of targets) {
              if (typeof target === "string") {
                files.push(path.resolve(baseUrl ?? paths.base, target.replaceAll("*", star)))
              }
            }
          }
        }
        if (baseUrl !== undefined) files.push(path.resolve(baseUrl, specifier))
      }
    }
    return { files, unpinnable: [...unpinnable, ...configRefusals()] }
  })

/**
 * One module's digest and what it loads, read once per scan.
 *
 * Sibling flows in one project share most of their imports, so a scan that
 * re-read and re-tokenized each of them per flow would cost the union of the
 * closures times the number of flows.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @private
 */
export interface Cache {
  readonly files: Map<string, {
    readonly contentDigest: string
    readonly size: number
    readonly specifiers: ReadonlyArray<string>
    readonly opaque: number
    readonly unparsed: boolean
    readonly absolute: ReadonlyArray<string>
    readonly bare: ReadonlyArray<string>
    readonly builtins: ReadonlyArray<string>
  }>
  /** Parsed package.json, tsconfig.json and jsconfig.json files, by path; `"oversized"` past the config ceiling. */
  readonly configs: Map<string, Record<string, unknown> | "oversized" | undefined>
  /** Inherited compiler options and refusals, with importer context for package-style extends. */
  readonly effective: Map<string, Effective>
  /** What each bare specifier came to, keyed by importer directory and specifier. */
  readonly bare: Map<string, BareTargets>
  /** Relative/alias resolution, including misses, by importer directory and specifier. */
  readonly resolutions: Map<string, string | undefined>
  /** File probes shared even when different specifiers name the same candidate. */
  readonly isFile: Map<string, boolean>
  /** The size the host reported for each file a probe found. */
  readonly sizes: Map<string, number>
  /** Whether each resolved file's real path is inside the scan's confinement root. */
  readonly confined: Map<string, boolean>
}

/**
 * A fresh per-scan cache.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @private
 */
export const cache = (): Cache => ({
  files: new Map(),
  configs: new Map(),
  effective: new Map(),
  bare: new Map(),
  resolutions: new Map(),
  isFile: new Map(),
  sizes: new Map(),
  confined: new Map()
})

/** The record for a specifier nothing could be pinned for. */
const unpinnable = (description: string): ModuleImport => ({ path: description })

/**
 * The record for a module that computes the target of a load. Source the
 * lexer could not finish reading may hide a static load as well, so it stays
 * an ordinary unpinnable record that no host admits.
 */
const computedLoads = (description: string, unparsed: boolean): ModuleImport =>
  unparsed ? unpinnable(description) : { path: description, computed: true }

/**
 * Every module one entry reaches through relative specifiers and through the
 * loader mappings of bare ones ({@link bareTargets}), sorted by path.
 *
 * Never fails: a file that cannot be read, a specifier that resolves to
 * nothing, a computed `import()`, and a closure past its bound are all RECORDED
 * — as an entry carrying no `contentDigest` — rather than raised, because
 * discovery lists a directory a person is editing and one unreadable sibling is
 * not a reason to drop the flow from the catalog. Refusing to RUN such a flow
 * is {@link module:Executable}'s decision, made where the code is about to be
 * imported.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @private
 */
export const collect = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  entryPath: string,
  entrySource: string,
  memo: Cache = cache(),
  /** The bounds, lowered by the suite that proves they are enforced. */
  bounds: { readonly files: number; readonly bytes: number } = {
    files: closureFileLimit,
    bytes: closureByteLimit
  }
): Effect.Effect<ReadonlyArray<ModuleImport>> =>
  walk(fs, path, entryPath, entrySource, memo, bounds, undefined, new Set(), undefined)

/**
 * The pinned closure and its unrestricted builtin, addon and package imports.
 * External packages are
 * listed conservatively: a static scan cannot prove whether they load addons.
 *
 * With `confinement`, a specifier that leaves the root, by its spelling or
 * through a symbolic link, is recorded as unpinnable and its target is never
 * read: a pack's `import "../../../x"` must not get a host file hashed into
 * the pack's descriptor.
 *
 * @category constructors
 * @since 1.0.0
 * @private
 */
export const analyze = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  entryPath: string,
  entrySource: string,
  memo: Cache = cache(),
  confinement?: Confinement
): Effect.Effect<{ readonly imports: ReadonlyArray<ModuleImport>; readonly hostImports: ReadonlyArray<string> }> =>
  Effect.gen(function*() {
    const hostImports = new Set<string>()
    const imports = yield* walk(
      fs,
      path,
      entryPath,
      entrySource,
      memo,
      {
        files: closureFileLimit,
        bytes: closureByteLimit
      },
      undefined,
      hostImports,
      confinement
    )
    return { imports, hostImports: [...hostImports].sort() }
  })

/** What {@link walk} keeps of each module it reads when asked to: the bytes it measured. */
interface Read {
  readonly bytes: Uint8Array
  readonly source: string
}

/**
 * The closure walk behind {@link collect} and {@link snapshot}. With `reads`,
 * every module is read afresh rather than answered from `memo`, and its bytes
 * — the very bytes its digest is taken over — are kept there by path. That
 * is the loader's walk, which reads whole files ({@link Reading}); without
 * `reads` the walk is a discovery scan and every read is a bounded stream.
 */
const walk = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  entryPath: string,
  entrySource: string,
  memo: Cache,
  bounds: { readonly files: number; readonly bytes: number },
  reads: Map<string, Read> | undefined,
  hostImports: Set<string>,
  confinement: Confinement | undefined
): Effect.Effect<ReadonlyArray<ModuleImport>> =>
  Effect.gen(function*() {
    const normalizedEntryPath = path.resolve(entryPath)
    const entryDirectory = path.dirname(normalizedEntryPath)
    const found = new Map<string, ModuleImport>()
    const reading: Reading = reads === undefined ? "bounded" : "whole"
    const visited = new Set<string>([normalizedEntryPath])
    // `pending` carries the importer so an unresolvable specifier can name the
    // file that asked for it rather than only the specifier nothing answered.
    const pending: Array<{ readonly from: string; readonly directory: string; readonly specifier: string }> = []
    let bytes = 0
    const enqueue = (from: string, directory: string, specifiers: ReadonlyArray<string>) => {
      for (const specifier of specifiers) pending.push({ from, directory, specifier })
    }
    const reportBuiltins = (specifiers: ReadonlyArray<string>) => {
      for (const specifier of specifiers) hostImports.add(specifier)
    }
    const reportOpaque = (importer: string, count: number, unparsed: boolean) => {
      if (count === 0) return
      const description = `${importer} computes the target of ${count} import() or require() call(s)`
      found.set(description, computedLoads(description, unparsed))
    }
    const reportAbsolute = (importer: string, specifiers: ReadonlyArray<string>) => {
      for (const specifier of specifiers) {
        const description = `${importer} imports "${specifier}", an absolute specifier the pin does not follow`
        found.set(description, unpinnable(description))
      }
    }
    // A bare specifier is followed only when a loader maps it onto a project
    // file; the files it maps to are walked like relative ones, so a later
    // edit to the mapping or to the file is a changed closure.
    const followBare = (importer: string, from: string, specifiers: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const directory = path.dirname(from)
        for (const specifier of specifiers) {
          const key = `${directory}\0${specifier}`
          const targets = memo.bare.get(key) ??
            (yield* bareTargets(fs, path, directory, specifier, memo, reading))
          memo.bare.set(key, targets)
          for (const reason of targets.unpinnable) {
            const description = `${importer} imports ${reason}`
            found.set(description, unpinnable(description))
          }
          let mapped = false
          for (const file of targets.files) {
            if ((yield* resolve(fs, path, directory, file, memo, from.endsWith(".vibe"))) !== undefined) {
              mapped = true
              if (from.endsWith(".mdx") && specifier === "@smthrs/registry/Prompt/jsx-runtime") {
                const description = `${importer} maps the MDX text runtime to project files`
                found.set(description, unpinnable(description))
              } else pending.push({ from, directory, specifier: file })
            }
          }
          if (!mapped) hostImports.add(specifier)
        }
      })
    const { absolute, bare, builtins, opaque, relative, unparsed } = specifiersOf(entrySource, normalizedEntryPath)
    if (opaque > 0) {
      found.set(
        normalizedEntryPath,
        computedLoads(`the entry computes the target of ${opaque} import() or require() call(s)`, unparsed)
      )
    }
    reportAbsolute("the entry", absolute)
    reportBuiltins(builtins)
    enqueue(normalizedEntryPath, entryDirectory, relative)
    yield* followBare("the entry", normalizedEntryPath, bare)

    // A real path that cannot be resolved cannot be shown to be inside the root.
    const confined = (root: string, file: string) =>
      Effect.gen(function*() {
        if (memo.confined.has(file)) return memo.confined.get(file)!
        const real = yield* Effect.result(fs.realPath(file))
        const inside = real._tag === "Success" && contains(path, root, path.resolve(real.success))
        memo.confined.set(file, inside)
        return inside
      })

    while (pending.length > 0) {
      const { directory, from, specifier } = pending.shift()!
      const importer = from === normalizedEntryPath ? "the entry" : `"${relativePath(path, entryDirectory, from)}"`
      const escapes = () => {
        const description = `${importer} imports "${specifier}", which resolves outside the source's confinement root`
        found.set(description, unpinnable(description))
      }
      // The spelling alone decides `../../../x`, before the host is asked
      // whether the file exists.
      if (confinement !== undefined && !contains(path, confinement.root, path.resolve(directory, specifier))) {
        escapes()
        continue
      }
      const resolved = yield* resolve(fs, path, directory, specifier, memo, from.endsWith(".vibe"))
      if (resolved === undefined) {
        const description = `${importer} imports "${specifier}", which resolves to no file`
        found.set(description, unpinnable(description))
        continue
      }
      // A symbolic link inside the root can still name a file outside it.
      if (confinement !== undefined && !(yield* confined(confinement.realRoot, resolved))) {
        escapes()
        continue
      }
      if (resolved.endsWith(".node")) hostImports.add(relativePath(path, entryDirectory, resolved))
      // A cycle is ordinary: `visited` is what ends the walk, and a module
      // already recorded keeps the one record it has.
      if (visited.has(resolved)) continue
      visited.add(resolved)
      if (visited.size > bounds.files) {
        const description = `the closure names more than ${bounds.files} modules`
        found.set(description, unpinnable(description))
        break
      }
      const recorded = relativePath(path, entryDirectory, resolved)
      const cached = reads === undefined ? memo.files.get(resolved) : undefined
      if (cached !== undefined) {
        bytes += cached.size
        if (bytes > bounds.bytes) {
          const description = `the closure totals more than ${bounds.bytes} bytes`
          found.set(description, unpinnable(description))
          break
        }
        found.set(recorded, { path: recorded, contentDigest: cached.contentDigest })
        reportOpaque(`"${recorded}"`, cached.opaque, cached.unparsed)
        reportAbsolute(`"${recorded}"`, cached.absolute)
        reportBuiltins(cached.builtins)
        enqueue(resolved, path.dirname(resolved), cached.specifiers)
        yield* followBare(`"${recorded}"`, resolved, cached.bare)
        continue
      }
      const remaining = bounds.bytes - bytes
      const overflows = () => {
        const description = `the closure totals more than ${bounds.bytes} bytes`
        found.set(description, unpinnable(description))
      }
      // A whole read cannot stop early, so a file the host already reported
      // as past the ceiling is not read at all.
      if (reading === "whole" && memo.sizes.get(resolved)! > remaining) {
        overflows()
        break
      }
      // The ceiling is enforced on the bytes read, never on a reported size
      // alone: a bounded read holds at most one byte past what is left.
      const read = yield* Effect.result(readWithin(fs, resolved, remaining, reading))
      if (read._tag === "Failure") {
        const description = `"${recorded}" could not be read`
        found.set(description, unpinnable(description))
        continue
      }
      const contents = read.success
      if (contents === undefined) {
        overflows()
        break
      }
      bytes += contents.length
      const contentDigest = Digest.digest(contents)
      const rawSource = new TextDecoder().decode(contents)
      const compiled = yield* Effect.result(
        resolved.endsWith(".mdx") ? Prompt.compile(rawSource) : Effect.succeed(rawSource)
      )
      if (compiled._tag === "Failure") {
        const description = `"${recorded}" could not be compiled as MDX`
        found.set(description, unpinnable(description))
        continue
      }
      const source = compiled.success
      reads?.set(resolved, { bytes: contents, source })
      const specifiers = specifiersOf(source, resolved)
      reportOpaque(`"${recorded}"`, specifiers.opaque, specifiers.unparsed)
      reportAbsolute(`"${recorded}"`, specifiers.absolute)
      reportBuiltins(specifiers.builtins)
      memo.files.set(resolved, {
        contentDigest,
        size: contents.length,
        specifiers: specifiers.relative,
        opaque: specifiers.opaque,
        unparsed: specifiers.unparsed,
        absolute: specifiers.absolute,
        bare: specifiers.bare,
        builtins: specifiers.builtins
      })
      found.set(recorded, { path: recorded, contentDigest })
      enqueue(resolved, path.dirname(resolved), specifiers.relative)
      yield* followBare(`"${recorded}"`, resolved, specifiers.bare)
    }

    return [...found.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  })

/**
 * One module of a {@link snapshot}: the bytes that were measured, executable
 * source (compiled for MDX), and its static links to other captured modules.
 *
 * @category models
 * @since 1.0.0
 * @private
 */
export interface Module {
  readonly bytes: Uint8Array
  readonly source: string
  readonly links: ReadonlyArray<{ readonly start: number; readonly end: number; readonly target: string }>
}

/**
 * The closure {@link collect} records, together with the bytes it measured,
 * keyed by absolute path, entry included.
 *
 * A loader that evaluates these bytes, rather than reopening the paths,
 * runs exactly the version the records describe. A static specifier is
 * linked when it is relative, or a package.json `imports` key that maps to
 * exactly one file, and it resolves to a module of this closure. Other
 * loads — `import()` and `require()` calls, and bare specifiers another
 * mapping resolves — remain measured, but `unsupported` names those the
 * native loader cannot evaluate coherently. Admission refuses them before
 * importing the entry; installed packages and builtins retain host trust.
 *
 * @category constructors
 * @since 1.0.0
 * @private
 */
export const snapshot = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  entryPath: string,
  entryBytes: Uint8Array,
  /** The bounds, lowered by the suite that proves they are enforced. */
  bounds: { readonly files: number; readonly bytes: number } = {
    files: closureFileLimit,
    bytes: closureByteLimit
  }
): Effect.Effect<{
  readonly imports: ReadonlyArray<ModuleImport>
  readonly modules: ReadonlyMap<string, Module>
  readonly unsupported: ReadonlyArray<string>
}> =>
  Effect.gen(function*() {
    const memo = cache()
    const entrySource = new TextDecoder().decode(entryBytes)
    const reads = new Map<string, Read>([[path.resolve(entryPath), { bytes: entryBytes, source: entrySource }]])
    const imports = yield* walk(
      fs,
      path,
      entryPath,
      entrySource,
      memo,
      bounds,
      reads,
      new Set(),
      undefined
    )
    const modules = new Map<string, Module>()
    const unsupported = new Set<string>()
    for (const [file, read] of reads) {
      const directory = path.dirname(file)
      const links: Array<Module["links"][number]> = []
      const specifiers = specifiersOf(read.source, file)
      // Mapping candidates can be missing (for example wildcard paths for an
      // installed package). Only a target actually resolved into this measured
      // closure needs project-module admission rather than host package trust.
      const hasMappedModule = (literal: string) =>
        memo.bare.get(`${directory}\0${literal}`)?.files.some((candidate) => {
          const resolved = memo.resolutions.get(resolutionKey(directory, candidate, file.endsWith(".vibe")))
          return resolved !== undefined && reads.has(resolved)
        }) ?? false
      for (const literal of specifiers.runtime) {
        if (isRelativeSpecifier(literal) || hasMappedModule(literal)) {
          unsupported.add(
            `"${relativePath(path, path.dirname(entryPath), file)}" loads "${literal}" through import() or require()`
          )
        }
      }
      for (const site of specifiers.statics) {
        const target = isRelativeSpecifier(site.literal)
          ? member(path, directory, site.literal, (candidate) => reads.has(candidate), file.endsWith(".vibe"))
          : site.literal.startsWith("#")
          ? yield* soleImportsTarget(fs, path, directory, site.literal, memo, file.endsWith(".vibe"))
          : undefined
        if (target !== undefined && reads.has(target)) links.push({ start: site.start, end: site.end, target })
        else if (hasMappedModule(site.literal)) {
          unsupported.add(
            `"${
              relativePath(path, path.dirname(entryPath), file)
            }" uses mapped specifier "${site.literal}" without one coherent static target`
          )
        }
      }
      modules.set(file, { ...read, links })
    }
    return { imports, modules, unsupported: [...unsupported] }
  })

/** The one file a package.json `imports` key maps to, or `undefined` when it maps to none or several. */
const soleImportsTarget = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  specifier: string,
  memo: Cache,
  vibe: boolean
): Effect.Effect<string | undefined> =>
  Effect.gen(function*() {
    // The walk followed every bare specifier of every module it read, so the
    // mapping is already in `memo`.
    const targets = memo.bare.get(`${directory}\0${specifier}`)!
    return targets.files.length === 1 && targets.unpinnable.length === 0
      ? yield* resolve(fs, path, directory, targets.files[0]!, memo, vibe)
      : undefined
  })

/**
 * Whether `module.links` are exactly the links its own text gives it within a
 * closure whose modules `has` names.
 *
 * A link replaces a span of source with the path of the module it names, so a
 * stored link is code, and a store is not evidence. Every link has to sit on a
 * static specifier token this scanner finds in `module.source`. A relative
 * specifier must link to the module {@link member} resolves it to, and to no
 * other. A package.json `imports` specifier (`#x`) must link to a module of the
 * closure: the mapping lives in a config the closure does not hold, so which
 * module it names is not recomputed, but an unlinked one would reopen a live
 * path whose bytes nobody measured.
 *
 * @category verification
 * @since 1.0.0
 * @private
 */
export const linked = (
  path: Path.Path,
  file: string,
  module: Pick<Module, "source" | "links">,
  has: (file: string) => boolean
): boolean => {
  const directory = path.dirname(file)
  let count = 0
  for (const site of specifiersOf(module.source, file).statics) {
    const relative = isRelativeSpecifier(site.literal)
    if (!relative && !site.literal.startsWith("#")) continue
    const target = relative
      ? member(path, directory, site.literal, has, file.endsWith(".vibe"))
      : module.links[count]?.target
    if (relative && target === undefined) continue
    const link = module.links[count++]
    if (
      link === undefined || link.start !== site.start || link.end !== site.end || link.target !== target ||
      !has(link.target)
    ) return false
  }
  return count === module.links.length
}
