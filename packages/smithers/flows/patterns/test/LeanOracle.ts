/**
 * Whether a built Lean oracle answers for the specification this checkout holds.
 *
 * A file's modification time says when it was written here, not what it was built from: an oracle copied in from
 * another checkout is newer than every source and older than none. So freshness is decided by content. The
 * specification's whole source tree (every `.lean` file at any depth, the toolchain pin and the lakefile) is hashed
 * into one fingerprint, and a build records the fingerprint it was made from in a manifest beside the oracle. An
 * oracle is fresh only when its manifest names the fingerprint of the sources as they are now.
 *
 * A specification whose sources cannot all be seen has no fingerprint: a required file is absent, or a source imports
 * a module of the specification that has no file. Such a tree is never fresh.
 */
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** What a specification's tree must hold to be complete. */
export interface Specification {
  /** The specification's directory, the one holding its lakefile. */
  readonly directory: string
  /** The built oracle. */
  readonly binary: string
  /** Files that must be present, relative to `directory`. */
  readonly required: ReadonlyArray<string>
  /** The library's module prefix (`PatternsSpec`): an import under it must resolve to a file of the tree. */
  readonly library: string
}

/** The specification's sources as they are, or why they are not all visible. */
export type Sources =
  | { readonly _tag: "Complete"; readonly files: ReadonlyArray<string>; readonly fingerprint: string }
  | { readonly _tag: "Incomplete"; readonly missing: ReadonlyArray<string> }

// `lake-manifest.json` is not a source: `lake build` writes it, and this specification has no dependency to pin.
const isSource = (name: string): boolean =>
  name.endsWith(".lean") || name === "lean-toolchain" || name === "lakefile.toml"

/** Every source under `directory`, at any depth, relative to it and in a stable order. Build output is not a source. */
const walk = (directory: string, prefix = ""): Array<string> =>
  readdirSync(join(directory, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) return entry.name === ".lake" ? [] : walk(directory, relative)
      return entry.isFile() && isSource(entry.name) ? [relative] : []
    })
    .sort()

/** The modules of `library` that `text` imports, as the files that must hold them. */
const imported = (text: string, library: string): Array<string> =>
  [...text.matchAll(/^import\s+([\w.]+)\s*$/gm)]
    .map((match) => match[1]!)
    .filter((module) => module === library || module.startsWith(`${library}.`))
    .map((module) => `${module.split(".").join("/")}.lean`)

/**
 * Reads the specification's sources and fingerprints them, or lists what is missing: a required file, or the file of
 * a module the tree imports from its own library.
 */
export const sources = (specification: Specification): Sources => {
  if (!existsSync(specification.directory)) return { _tag: "Incomplete", missing: specification.required }
  const files = walk(specification.directory)
  const present = new Set(files)
  const hash = createHash("sha256")
  const missing = new Set(specification.required.filter((file) => !present.has(file)))
  for (const file of files) {
    const bytes = readFileSync(join(specification.directory, ...file.split("/")))
    hash.update(`${file.length}:${file}:${bytes.length}:`).update(bytes)
    if (!file.endsWith(".lean")) continue
    for (const module of imported(bytes.toString("utf8"), specification.library)) {
      if (!present.has(module)) missing.add(module)
    }
  }
  return missing.size > 0
    ? { _tag: "Incomplete", missing: [...missing].sort() }
    : { _tag: "Complete", files, fingerprint: hash.digest("hex") }
}

/** Where a build records the fingerprint of the sources it was made from. */
export const manifestPath = (specification: Specification): string => `${specification.binary}.sources.json`

/** Records that the oracle now standing was built from `built`. Call only after a build of exactly those sources. */
export const record = (specification: Specification, built: Extract<Sources, { _tag: "Complete" }>): void =>
  writeFileSync(
    manifestPath(specification),
    `${JSON.stringify({ fingerprint: built.fingerprint, files: built.files }, null, 2)}\n`
  )

/**
 * True unless the oracle exists and its manifest names the fingerprint of `current`. No oracle, no manifest, an
 * unreadable manifest, another fingerprint and an incomplete tree are all stale.
 */
export const stale = (specification: Specification, current: Sources = sources(specification)): boolean => {
  if (current._tag === "Incomplete" || !existsSync(specification.binary)) return true
  const path = manifestPath(specification)
  if (!existsSync(path)) return true
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { readonly fingerprint?: unknown } | null
    return manifest?.fingerprint !== current.fingerprint
  } catch {
    return true
  }
}
