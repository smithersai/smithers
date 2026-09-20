/**
 * Where a declaration was written: the author's file and the line it starts
 * on.
 *
 * A digest says what a step IS; it cannot say where to read it. A monitor that
 * offers to show the code behind a node needs the file and line the
 * declaration was authored at, so the declaration carries it from the moment
 * it is made — captured from an `Error` stack, which is the only place a
 * JavaScript runtime keeps it.
 *
 * Two properties make this safe to carry. It is stored as a NON-ENUMERABLE
 * own property, so canonical serialization — which walks enumerable keys —
 * cannot see it, and a declaration's key material is byte-identical with and
 * without it. And every parse is defensive: an engine whose stack format this
 * module does not recognize yields `undefined`, never a throw and never a
 * guessed location.
 *
 * Frames inside the framework are skipped, because the frame that matters is
 * the AUTHOR's: `Action.make` is called from this package, and the interesting
 * line is the one that called it.
 *
 * @since 1.0.0
 */

/** The own property a declaration carries its source position on. @private */
const TypeId = "~@smthrs/flow/DeclaredAt"

/**
 * The file and line a declaration was written at.
 *
 * `path` is the path the runtime reported, which is absolute in every engine
 * this repository runs on. A journal writer makes it repo-relative before it
 * records it, and omits it when it cannot: an absolute home directory is not
 * a fact a durable record may carry.
 *
 * @since 1.0.0
 * @category models
 */
export interface DeclaredAt {
  readonly path: string
  readonly line: number
}

/**
 * Whether a frame belongs to the framework or the runtime rather than to an
 * author.
 *
 * Three shapes are not an author's. Anything under a `node_modules` directory,
 * which is how a published `@smthrs/*` package is loaded. Anything under a
 * `packages/smithers/**\/src` directory, which is how this repository loads the
 * same code from source. And anything that does not name a file at all: a
 * declaration made inside the framework is reached through the module loader,
 * so the first frame under it is a runtime internal such as
 * `node:internal/process/task_queues`, which is a real frame and a false
 * author. A test, an example, and a workspace's own flow file are absolute
 * paths under none of those, so they are what a capture reports.
 *
 * Windows spells those same two directories with backslashes, so separators
 * are read as one before matching: a framework frame taken for an author's
 * would name this package's own `make.js` as the site every node of that run
 * was declared at.
 *
 * @since 1.0.0
 * @category predicates
 */
export const isFrameworkPath = (path: string): boolean => {
  if (!isFilePath(path)) return true
  const separated = path.replaceAll("\\", "/")
  return separated.includes("/node_modules/") || /\/packages\/smithers\/.*\/src\//.test(separated)
}

/** Whether a frame path names a file on disk rather than a runtime module. @private */
const isFilePath = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)

/** The `path:line:column` text of one stack frame, in either engine's spelling. @private */
const location = (frame: string): string | undefined => {
  const parenthesized = /\(([^()]*)\)\s*$/.exec(frame)
  if (parenthesized !== null) return parenthesized[1]
  const trimmed = frame.trim()
  const at = trimmed.lastIndexOf("@")
  if (at >= 0) return trimmed.slice(at + 1)
  return trimmed.startsWith("at ") ? trimmed.slice(3) : undefined
}

/** A `file://` url reported as a frame path, as an ordinary path. @private */
const normalize = (path: string): string =>
  path.startsWith("file://") ? decodeURIComponent(path.slice("file://".length)) : path

/**
 * Where bytes a host evaluated from one file were read from. @private
 *
 * Keyed by the file that was evaluated, which a loader makes unique per load.
 */
const sources = new Map<string, string>()

/**
 * States that a file this runtime is about to evaluate holds bytes read from
 * another, so declarations inside it report the file an author can open.
 *
 * A host that verifies a flow's source has to evaluate THE BYTES IT MEASURED,
 * and the only way to evaluate bytes in this runtime is to write them
 * somewhere and import that path. `@smthrs/registry` `Executable` writes them
 * as a scratch sibling of the entry and removes it as soon as the load is
 * over, so without this every declaration in an agent-authored flow reports a
 * path nothing holds — a Code tab that can never be opened (D-068).
 *
 * The loader states this BEFORE the import, because a declaration's site is
 * captured while the module is evaluated and is never rewritten afterwards.
 * One entry is kept per load: a scratch path is unique and gone, so no later
 * file can take a stale entry's name.
 *
 * @since 1.0.0
 * @category constructors
 */
export const evaluatedFrom = (evaluated: string, entry: string): void => {
  sources.set(normalize(evaluated), normalize(entry))
}

/**
 * The position one stack frame names, in the V8 and JavaScriptCore spellings.
 *
 * V8 writes `    at name (/path/file.ts:12:5)` and, for a top-level frame,
 * `    at /path/file.ts:12:5`. JavaScriptCore — Bun and Safari — writes
 * `name@/path/file.ts:12:5` and `@/path/file.ts:12:5`. Anything else is
 * unparseable and reports nothing.
 *
 * @since 1.0.0
 * @category parsers
 */
export const parseFrame = (frame: string): DeclaredAt | undefined => {
  const text = location(frame)
  if (text === undefined) return undefined
  const position = /^(.*):(\d+):(\d+)$/.exec(text)
  if (position === null) return undefined
  const line = Number(position[2])
  // A frame naming a file a host evaluated measured bytes into reports the
  // entry those bytes were read from; every other frame reports itself.
  const path = normalize(position[1]!)
  return { path: sources.get(path) ?? path, line }
}

/**
 * The first author frame of a captured stack.
 *
 * The header line every V8 stack starts with parses as nothing, so it needs no
 * special case. A decoding failure inside a frame path — a malformed percent
 * escape in a `file://` url — is an unparseable stack rather than a throw,
 * which is the whole contract of this module: provenance is a nicety, and a
 * nicety may never take a declaration down with it.
 *
 * @since 1.0.0
 * @category parsers
 */
export const parseStack = (stack: string | undefined): DeclaredAt | undefined => {
  if (stack === undefined) return undefined
  try {
    for (const frame of stack.split("\n")) {
      const parsed = parseFrame(frame)
      if (parsed !== undefined && !isFrameworkPath(parsed.path)) return parsed
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Where the caller of the function calling this was written.
 *
 * @since 1.0.0
 * @category constructors
 */
export const capture = (): DeclaredAt | undefined => parseStack(new Error().stack)

/**
 * Carries a source position on a declaration without adding a field to it.
 *
 * The property is non-enumerable and non-writable, so it cannot reach a
 * canonical serialization, a digest, or a structural clone, and a later caller
 * cannot rewrite one declaration's provenance to another's.
 *
 * @since 1.0.0
 * @category constructors
 */
export const annotate = <A extends object>(value: A, site: DeclaredAt | undefined): A => {
  // A declaration annotated twice keeps the FIRST site. The property is
  // non-configurable, so a second `defineProperty` would throw rather than
  // overwrite, and a copy that carries its own site has already recorded it.
  if (site === undefined || Object.getOwnPropertyDescriptor(value, TypeId) !== undefined) return value
  Object.defineProperty(value, TypeId, {
    configurable: false,
    enumerable: false,
    value: site,
    writable: false
  })
  return value
}

/**
 * The source position a value carries, when it carries one.
 *
 * Read through an own data descriptor, so neither a prototype nor an accessor
 * on a foreign value can answer for it.
 *
 * @since 1.0.0
 * @category accessors
 */
export const declaredAt = (value: unknown): DeclaredAt | undefined => {
  if (Object(value) !== value) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, TypeId)
  return descriptor === undefined ? undefined : descriptor.value as DeclaredAt | undefined
}
