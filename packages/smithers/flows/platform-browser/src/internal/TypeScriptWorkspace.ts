/**
 * TypeScript's language service over a read-only workspace, answering in the
 * Language Server Protocol's own shapes. It runs inside the worker
 * `BrowserLanguageServer.serve` starts: the files arrive through `Loader`,
 * asked for by path from the commit's file list, so the program only ever
 * holds what a request needed.
 *
 * - A request for a file loads the file and its import closure (relative
 *   imports, `/// <reference path>`, and the specifiers `tsconfig.json`'s
 *   `paths` and `baseUrl` map into the workspace), resolved against the file
 *   list, so a guess never costs a read.
 * - `references` widens the program to every script under the file's
 *   `tsconfig.json`; `workspaceSymbols` searches what is loaded.
 * - Both stop at the limits ({@link MAX_FILES} files and {@link MAX_BYTES}
 *   characters by default); `loaded` says when they did.
 *
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type TS from "typescript"

/**
 * The TypeScript compiler API, as the worker entry hands it over.
 *
 * @category models
 * @since 1.0.0
 */
export type TypeScript = typeof TS

/**
 * Where the `lib.*.d.ts` files live in the workspace's namespace; no repository path starts with it.
 *
 * @category constants
 * @since 1.0.0
 */
export const LIB_DIRECTORY = "/.typescript"

/**
 * The most workspace files one workspace loads.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_FILES = 2000

/**
 * The most characters of workspace files one workspace loads.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_BYTES = 16 * 1024 * 1024

/**
 * The most symbols `workspaceSymbols` answers.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_SYMBOLS = 100

/**
 * Diagnostic codes that follow from packages a commit doesn't hold, since
 * `node_modules` is not in git, rather than from its own code: a module or
 * its declarations not found, missing `@types/node` or test globals, and JSX
 * without React's types.
 *
 * @category constants
 * @since 1.0.0
 */
export const ENVIRONMENT_CODES: ReadonlySet<number> = new Set([
  2307,
  2792,
  7016,
  2688,
  2580,
  2581,
  2582,
  2583,
  2584,
  2591,
  2592,
  2593,
  7026,
  2875
])

const SCRIPT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const CONFIGS = ["tsconfig.json", "jsconfig.json"]
const MAX_EXTENDS = 4
// The most files one read asks for.
const SLICE = 32

/**
 * A file's text by absolute path, or `null` for one that can't be read as text.
 *
 * @category models
 * @since 1.0.0
 */
export type Read = ReadonlyArray<readonly [path: string, text: string | null]>

/**
 * Where the workspace's files and TypeScript's lib files come from.
 *
 * @category models
 * @since 1.0.0
 */
export interface Loader {
  readonly read: (paths: ReadonlyArray<string>) => Effect.Effect<Read>
  readonly lib: (fileName: string) => Effect.Effect<string | undefined>
}

/**
 * A request the workspace refused: the code and a message without content.
 *
 * @category errors
 * @since 1.0.0
 */
export class Refusal extends Data.TaggedError("Refusal")<{
  readonly code: "not_found" | "binary_file" | "invalid_input" | "response_too_large"
  readonly message: string
}> {}

/**
 * A 0-based position, as the protocol counts it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Position {
  readonly line: number
  readonly character: number
}

/**
 * A range of positions, its end exclusive.
 *
 * @category models
 * @since 1.0.0
 */
export interface Range {
  readonly start: Position
  readonly end: Position
}

/**
 * A range in a file, named by its `file:` URI.
 *
 * @category models
 * @since 1.0.0
 */
export interface Location {
  readonly uri: string
  readonly range: Range
}

/**
 * An absolute workspace path as a `file:` URI, each segment percent-encoded.
 *
 * @category utils
 * @since 1.0.0
 */
export const uriOf = (path: string): string => `file://${path.split("/").map(encodeURIComponent).join("/")}`

/**
 * Makes `path` absolute: `src/a.ts` is `/src/a.ts`.
 *
 * @category utils
 * @since 1.0.0
 */
export const absolute = (path: string): string => (path.startsWith("/") ? path : `/${path}`)

const dirname = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/"

const join = (directory: string, name: string): string => (directory === "/" ? `/${name}` : `${directory}/${name}`)

/**
 * Resolves `.` and `..` in an absolute path; `..` above the root stays at the root.
 *
 * @category utils
 * @since 1.0.0
 */
export const normalize = (path: string): string => {
  const parts: Array<string> = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

/**
 * Where each line starts: line breaks are `\n`, `\r\n` and `\r`, as the protocol counts them.
 *
 * @category utils
 * @since 1.0.0
 */
export const lineStarts = (text: string): Array<number> => {
  const starts = [0]
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    if (code === 13 && text.charCodeAt(at + 1) === 10) at++
    if (code === 13 || code === 10) starts.push(at + 1)
  }
  return starts
}

/**
 * The offset of a 0-based position, clamped to its line and the text.
 *
 * @category utils
 * @since 1.0.0
 */
export const offsetAt = (text: string, starts: ReadonlyArray<number>, position: Position): number => {
  const start = starts[position.line]
  if (start === undefined) return text.length
  let end = starts[position.line + 1] ?? text.length
  if (starts[position.line + 1] !== undefined) {
    if (text.charCodeAt(end - 1) === 10) end--
    if (text.charCodeAt(end - 1) === 13) end--
  }
  return Math.min(start + Math.max(0, position.character), end)
}

/**
 * The 0-based position of an offset.
 *
 * @category utils
 * @since 1.0.0
 */
export const positionAt = (starts: ReadonlyArray<number>, offset: number): Position => {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= offset) low = middle
    else high = middle - 1
  }
  return { line: low, character: offset - starts[low]! }
}

/**
 * LSP `SymbolKind` for a TypeScript element kind.
 *
 * @category utils
 * @since 1.0.0
 */
export const symbolKind = (kind: string): number => {
  switch (kind) {
    case "module":
    case "external module name":
      return 2
    case "class":
    case "local class":
      return 5
    case "method":
      return 6
    case "property":
    case "getter":
    case "setter":
    case "accessor":
      return 7
    case "constructor":
      return 9
    case "enum":
      return 10
    case "interface":
    case "type":
      return 11
    case "function":
    case "local function":
      return 12
    case "const":
      return 14
    case "enum member":
      return 22
    case "type parameter":
      return 26
    default:
      return 13
  }
}

/**
 * LSP `DiagnosticSeverity` for a TypeScript diagnostic category.
 *
 * @category utils
 * @since 1.0.0
 */
export const severityOf = (ts: TypeScript, category: TS.DiagnosticCategory): number =>
  category === ts.DiagnosticCategory.Error
    ? 1
    : category === ts.DiagnosticCategory.Warning
    ? 2
    : category === ts.DiagnosticCategory.Suggestion
    ? 4
    : 3

/** One project: the options of one `tsconfig.json` (or the defaults) and the files it has opened. */
interface Project {
  readonly directory: string
  readonly options: TS.CompilerOptions
  readonly roots: Set<string>
  readonly service: TS.LanguageService
  widened: boolean
}

/**
 * The workspace's state and requests.
 *
 * @category models
 * @since 1.0.0
 */
export interface Workspace {
  readonly hover: (path: string, position: Position) => Effect.Effect<unknown, Refusal>
  readonly definition: (path: string, position: Position) => Effect.Effect<unknown, Refusal>
  readonly references: (path: string, position: Position) => Effect.Effect<unknown, Refusal>
  readonly implementation: (path: string, position: Position) => Effect.Effect<unknown, Refusal>
  readonly documentSymbols: (path: string) => Effect.Effect<unknown, Refusal>
  readonly workspaceSymbols: (query: string) => Effect.Effect<unknown>
  readonly diagnostics: (path: string) => Effect.Effect<unknown, Refusal>
  readonly sync: (path: string, text: string) => Effect.Effect<void>
  readonly close: (path: string) => Effect.Effect<void>
  /** Files loaded, and whether a cap stopped a load. */
  readonly loaded: () => { readonly files: number; readonly partial: boolean }
}

/**
 * How much one workspace loads.
 *
 * @category models
 * @since 1.0.0
 */
export interface Limits {
  readonly files: number
  readonly bytes: number
}

/**
 * Builds a workspace over `paths`, every file's path at the commit, relative or absolute.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  ts: TypeScript,
  paths: ReadonlyArray<string>,
  loader: Loader,
  limits: Limits = { files: MAX_FILES, bytes: MAX_BYTES }
): Workspace => {
  const listing = new Set(paths.map(absolute))
  const directories = new Set<string>()
  for (const path of listing) for (let dir = dirname(path); dir !== "/"; dir = dirname(dir)) directories.add(dir)
  directories.add("/")
  const texts = new Map<string, string>()
  const unreadable = new Set<string>()
  const overlays = new Map<string, string>()
  const versions = new Map<string, number>()
  const libs = new Map<string, string>()
  const lines = new Map<string, { readonly text: string; readonly starts: ReadonlyArray<number> }>()
  const projects = new Map<string, Project>()
  const registry = ts.createDocumentRegistry()
  let bytes = 0
  let partial = false
  // Set once a read file did not fit the bytes left; no load reads after that.
  let full = false

  const textOf = (path: string): string | undefined => overlays.get(path) ?? texts.get(path) ?? libs.get(path)
  const startsOf = (path: string, text: string): ReadonlyArray<number> => {
    const cached = lines.get(path)
    if (cached?.text === text) return cached.starts
    const starts = lineStarts(text)
    lines.set(path, { text, starts })
    return starts
  }
  // Every file a program answers about is one it read, so it has text.
  const rangeOf = (path: string, span: TS.TextSpan): Range => {
    const starts = startsOf(path, textOf(path)!)
    return { start: positionAt(starts, span.start), end: positionAt(starts, span.start + span.length) }
  }
  const locationOf = (entry: { readonly fileName: string; readonly textSpan: TS.TextSpan }): Location => ({
    uri: uriOf(entry.fileName),
    range: rangeOf(entry.fileName, entry.textSpan)
  })

  const directoryExists = (path: string): boolean =>
    directories.has(path) || [...overlays.keys()].some((file) => file.startsWith(`${path}/`))

  const resolution: TS.ModuleResolutionHost = {
    fileExists: (path) => listing.has(path) || overlays.has(path),
    readFile: textOf,
    directoryExists,
    getCurrentDirectory: () => "/"
  }

  const needsLoad = (path: string) => listing.has(path) && !texts.has(path) && !unreadable.has(path)

  /** What `text` imports that the workspace holds, resolved with `options`. */
  const importsOf = (path: string, text: string, options: TS.CompilerOptions): Effect.Effect<Array<string>> =>
    Effect.gen(function*() {
      const info = ts.preProcessFile(text, true, true)
      // Resolution is synchronous, but manifests arrive through the asynchronous loader.
      // Read the manifests it probes, then resolve again with their actual contents.
      while (true) {
        const manifests = new Set<string>()
        const host: TS.ModuleResolutionHost = {
          ...resolution,
          readFile: (name) => {
            if (name.endsWith("/package.json") && needsLoad(name)) manifests.add(name)
            return textOf(name)
          }
        }
        const found = info.referencedFiles.map((reference) => normalize(join(dirname(path), reference.fileName)))
        for (const imported of info.importedFiles) {
          const resolved = ts.resolveModuleName(imported.fileName, path, options, host).resolvedModule
          if (resolved !== undefined) found.push(resolved.resolvedFileName)
        }
        if (manifests.size === 0) return found
        const before = texts.size + unreadable.size
        yield* load([...manifests], options)
        if (texts.size + unreadable.size === before) return found
      }
    })

  /**
   * Loads `wanted` and everything they import, within the caps. Files are read
   * `SLICE` at a time and each slice is stored before the next is asked
   * for, so the byte cap bounds a load and an interrupted load keeps what it
   * read. A file that does not fit the bytes left is refused and ends loading.
   */
  const load = (wanted: ReadonlyArray<string>, options: TS.CompilerOptions): Effect.Effect<void> =>
    Effect.gen(function*() {
      const visited = new Set<string>()
      let frontier = [...new Set(wanted)]
      while (frontier.length > 0) {
        const pending = frontier.filter(needsLoad)
        let at = 0
        while (at < pending.length) {
          const room = Math.min(SLICE, limits.files - texts.size)
          if (room <= 0 || full) {
            partial = true
            break
          }
          const slice = pending.slice(at, at + room)
          at += slice.length
          // Reserve every admitted file before asynchronous import discovery can load manifests.
          for (const [path, text] of yield* loader.read(slice)) {
            if (text === null) unreadable.add(path)
            else if (bytes + text.length > limits.bytes) {
              full = true
              partial = true
            } else {
              texts.set(path, text)
              bytes += text.length
            }
          }
        }
        const next = new Set<string>()
        for (const path of frontier) {
          visited.add(path)
          const text = textOf(path)
          // Cached text is not evidence that an interrupted request finished its imports.
          if (text === undefined || !SCRIPT.test(path)) continue
          for (const imported of yield* importsOf(path, text, options)) next.add(imported)
        }
        frontier = [...next].filter((path) => !visited.has(path))
      }
    })

  /** A config's own `compilerOptions`, converted against its directory, under those of what it extends. */
  const configOptions = (path: string, depth: number): Effect.Effect<TS.CompilerOptions> =>
    Effect.gen(function*() {
      yield* load([path], {})
      const text = texts.get(path)
      if (text === undefined) return {}
      const json = ts.parseConfigFileTextToJson(path, text).config as
        | { readonly extends?: unknown; readonly compilerOptions?: unknown }
        | undefined
      const bases = typeof json?.extends === "string"
        ? [json.extends]
        : Array.isArray(json?.extends)
        ? json.extends
        : []
      let options: TS.CompilerOptions = {}
      for (const base of bases) {
        if (typeof base !== "string" || !base.startsWith(".") || depth >= MAX_EXTENDS) continue
        const target = normalize(join(dirname(path), base))
        const file = listing.has(target) ? target : `${target}.json`
        options = { ...options, ...(yield* configOptions(file, depth + 1)) }
      }
      const own = ts.convertCompilerOptionsFromJson(json?.compilerOptions ?? {}, dirname(path), path).options
      return { ...options, ...own, ...(own.paths === undefined ? {} : { pathsBasePath: dirname(path) }) }
    })

  /** Loads the lib files `options` names and every lib they reference. */
  const loadLibs = (options: TS.CompilerOptions) =>
    Effect.suspend(() => {
      const added: Array<string> = []
      return Effect.gen(function*() {
        let names = options.lib ?? [ts.getDefaultLibFileName(options)]
        while (names.length > 0) {
          const next: Array<string> = []
          for (const name of names) {
            const path = `${LIB_DIRECTORY}/${name}`
            if (libs.has(path)) continue
            const text = yield* loader.lib(name)
            libs.set(path, text ?? "")
            added.push(path)
            if (text === undefined) continue
            for (const reference of ts.preProcessFile(text, true, true).libReferenceDirectives) {
              next.push(`lib.${reference.fileName.toLowerCase()}.d.ts`)
            }
          }
          names = next
        }
      }).pipe(Effect.onInterrupt(() =>
        Effect.sync(() => {
          for (const path of added) libs.delete(path)
        })
      ))
    })

  /** The nearest `tsconfig.json` or `jsconfig.json` above `path`, if any. */
  const configAbove = (path: string): string | undefined => {
    for (let dir = dirname(path);; dir = dirname(dir)) {
      for (const name of CONFIGS) if (listing.has(join(dir, name))) return join(dir, name)
      if (dir === "/") return undefined
    }
  }

  const projectFor = (path: string) =>
    Effect.gen(function*() {
      const config = configAbove(path)
      const key = config ?? "/"
      const known = projects.get(key)
      if (known !== undefined) return known
      const configured = config === undefined ? {} : yield* configOptions(config, 0)
      const options: TS.CompilerOptions = {
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        esModuleInterop: true,
        resolveJsonModule: true,
        ...configured,
        noEmit: true,
        skipLibCheck: true,
        types: []
      }
      yield* loadLibs(options)
      const roots = new Set<string>()
      const host: TS.LanguageServiceHost = {
        getCompilationSettings: () => options,
        getScriptFileNames: () => [...roots],
        getScriptVersion: (name) => String(versions.get(name) ?? 0),
        getScriptSnapshot: (name) => {
          const text = textOf(name)
          return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
        },
        getCurrentDirectory: () => "/",
        getDefaultLibFileName: (settings) => `${LIB_DIRECTORY}/${ts.getDefaultLibFileName(settings)}`,
        fileExists: (name) => textOf(name) !== undefined,
        readFile: textOf,
        directoryExists: (name) => directoryExists(name) || name === LIB_DIRECTORY
      }
      const project: Project = {
        directory: config === undefined ? "/" : dirname(config),
        options,
        roots,
        service: ts.createLanguageService(host, registry),
        widened: false
      }
      projects.set(key, project)
      return project
    })

  /** Opens `path` in its project: loads it and its imports, and makes it a root. */
  const open = (path: string) =>
    Effect.gen(function*() {
      if (!listing.has(path) && !overlays.has(path)) {
        return yield* Effect.fail(new Refusal({ code: "not_found", message: "Not in the workspace" }))
      }
      const project = yield* projectFor(path)
      yield* load([path], project.options)
      const text = textOf(path)
      if (text === undefined) {
        return yield* Effect.fail(
          unreadable.has(path)
            ? new Refusal({ code: "binary_file", message: "Not a text file" })
            : new Refusal({ code: "response_too_large", message: "Past the workspace's limits" })
        )
      }
      project.roots.add(path)
      return { project, text }
    })

  /** Widens the project of `path` to every script under its config's directory. */
  const widen = (project: Project) =>
    Effect.gen(function*() {
      if (project.widened) return
      const prefix = project.directory === "/" ? "/" : `${project.directory}/`
      const scripts = [...listing].filter((path) =>
        path.startsWith(prefix) && SCRIPT.test(path) && !path.includes("/node_modules/")
      )
      yield* load(scripts, project.options)
      for (const path of scripts) if (texts.has(path)) project.roots.add(path)
      project.widened = true
    })

  const at = (path: string, position: Position) =>
    Effect.map(open(path), ({ project, text }) => ({
      service: project.service,
      project,
      offset: offsetAt(text, startsOf(path, text), position)
    }))

  const markdownOf = (info: TS.QuickInfo): string => {
    const signature = ts.displayPartsToString(info.displayParts)
    const documentation = ts.displayPartsToString(info.documentation)
    const tags = (info.tags ?? []).map((tag) => {
      const text = ts.displayPartsToString(tag.text)
      return text === "" ? `*@${tag.name}*` : `*@${tag.name}* ${text}`
    })
    return ["```typescript\n" + signature + "\n```", documentation, ...tags].filter((part) => part !== "").join("\n\n")
  }

  const symbolOf = (path: string, item: TS.NavigationTree): Array<unknown> => {
    if (item.kind === "alias") return []
    const span = item.spans[0]!
    return [{
      name: item.text,
      kind: symbolKind(item.kind),
      range: rangeOf(path, span),
      selectionRange: rangeOf(path, item.nameSpan ?? span),
      children: (item.childItems ?? []).flatMap((child) => symbolOf(path, child))
    }]
  }

  const bump = (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1)

  return {
    hover: (path, position) =>
      Effect.map(at(path, position), ({ offset, service }) => {
        const info = service.getQuickInfoAtPosition(path, offset)
        return info === undefined
          ? null
          : { contents: { kind: "markdown", value: markdownOf(info) }, range: rangeOf(path, info.textSpan) }
      }),
    definition: (path, position) =>
      Effect.map(
        at(path, position),
        ({ offset, service }) => (service.getDefinitionAtPosition(path, offset) ?? []).map(locationOf)
      ),
    implementation: (path, position) =>
      Effect.map(
        at(path, position),
        ({ offset, service }) => (service.getImplementationAtPosition(path, offset) ?? []).map(locationOf)
      ),
    references: (path, position) =>
      Effect.gen(function*() {
        const { offset, project } = yield* at(path, position)
        yield* widen(project)
        return (project.service.findReferences(path, offset) ?? []).flatMap((symbol) =>
          symbol.references.map(locationOf)
        )
      }),
    documentSymbols: (path) =>
      Effect.map(
        open(path),
        ({ project }) =>
          (project.service.getNavigationTree(path).childItems ?? []).flatMap((item) => symbolOf(path, item))
      ),
    workspaceSymbols: (query) =>
      Effect.sync(() =>
        [...projects.values()]
          .flatMap((project) => project.service.getNavigateToItems(query, MAX_SYMBOLS))
          .slice(0, MAX_SYMBOLS)
          .map((item) => ({
            name: item.name,
            kind: symbolKind(item.kind),
            location: locationOf(item),
            containerName: item.containerName
          }))
      ),
    diagnostics: (path) =>
      Effect.map(open(path), ({ project }) => ({
        kind: "full",
        items: [
          ...project.service.getSyntacticDiagnostics(path),
          ...project.service.getSemanticDiagnostics(path)
        ]
          .filter((diagnostic) => !ENVIRONMENT_CODES.has(diagnostic.code))
          .map((diagnostic) => ({
            range: rangeOf(path, { start: diagnostic.start ?? 0, length: diagnostic.length ?? 0 }),
            severity: severityOf(ts, diagnostic.category),
            code: diagnostic.code,
            source: "ts",
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
          }))
      })),
    sync: (path, text) =>
      Effect.sync(() => {
        overlays.set(path, text)
        bump(path)
      }),
    close: (path) =>
      Effect.sync(() => {
        if (overlays.delete(path)) bump(path)
      }),
    loaded: () => ({ files: texts.size, partial })
  }
}
