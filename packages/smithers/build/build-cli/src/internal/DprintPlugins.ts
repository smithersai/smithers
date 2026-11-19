/**
 * The dprint plugins a format check runs, as key material and as a grant.
 *
 * dprint keeps the plugins a configuration names in its own cache, outside
 * the workspace: each plugin downloaded once, checked against the checksum
 * the configuration pins, and compiled to a `.cwasm` file beside a `.json`
 * file naming its source. A confined run has an empty home and no network, so
 * it is shown those files read-only, through a link where dprint looks for
 * its cache inside the run's private temporary directory, and their bytes are
 * measured into its key. Nothing else in the cache is shown or measured.
 *
 * A plugin dprint has not fetched, a configuration that extends another, a
 * configuration that is not plain JSON, and a plugin that is not a remote
 * `.wasm` pinned by checksum each leave the check's result unreused, with the
 * reason.
 *
 * @since 1.0.0
 */

import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"

/**
 * Where dprint keeps its cache on a host, as dprint itself resolves it, or
 * nothing on a platform no build confinement runs on.
 *
 * @category resolution
 * @since 1.0.0
 */
export const cacheDirectory = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  home: string
): string | undefined => {
  const declared = env["DPRINT_CACHE_DIR"]
  if (declared !== undefined && declared !== "") return declared
  if (platform === "darwin") return NodePath.join(home, "Library", "Caches", "dprint", "cache")
  if (platform !== "linux") return undefined
  const base = env["XDG_CACHE_HOME"]
  return NodePath.join(base === undefined || base === "" ? NodePath.join(home, ".cache") : base, "dprint", "cache")
}

/**
 * Where dprint looks for its cache inside a confined run, relative to the
 * run's private temporary directory: the sandbox sets `XDG_CACHE_HOME` to its
 * `cache` directory on Linux and `HOME` to its `home` directory everywhere.
 *
 * @category resolution
 * @since 1.0.0
 */
export const privateCachePath = (platform: NodeJS.Platform): string =>
  platform === "darwin" ? "home/Library/Caches/dprint/cache" : "cache/dprint/cache"

/**
 * The plugin files a check reads and the digest of their bytes.
 *
 * @category models
 * @since 1.0.0
 */
export interface Measured {
  /** The cache directory dprint resolves on the host. */
  readonly cache: string
  /** Absolute paths of the measured plugin files. */
  readonly files: ReadonlyArray<string>
  readonly digest: string
}

/** A remote plugin pinned by its checksum, as `dprint.json` names one. */
const pinned = /^https:\/\/[^@\s]+\.wasm@[0-9a-f]{64}$/

/** File digests by status, so a plan of many format checks reads each plugin once. */
const remembered = new Map<string, string>()

const fileDigest = (path: string): string => {
  const status = NodeFs.statSync(path, { bigint: true })
  const key = `${path}\0${status.dev}\0${status.ino}\0${status.size}\0${status.mtimeNs}\0${status.ctimeNs}`
  const known = remembered.get(key)
  if (known !== undefined) return known
  const digest = createHash("sha256").update(NodeFs.readFileSync(path)).digest("hex")
  remembered.set(key, digest)
  return digest
}

/**
 * Measures the plugins the configuration at `config` names in the cache at
 * `cache`, or says why its result cannot be reused.
 *
 * @category measurement
 * @since 1.0.0
 */
export const measure = (config: string, cache: string | undefined): Measured | string => {
  if (cache === undefined) return "dprint's plugin cache cannot be shown to a confined run on this platform"
  let parsed: { readonly extends?: unknown; readonly plugins?: unknown }
  try {
    parsed = JSON.parse(NodeFs.readFileSync(config, "utf8"))
  } catch {
    return `the dprint configuration ${config} is not plain JSON, so the plugins it names cannot be read`
  }
  if (parsed.extends !== undefined) {
    return "the dprint configuration extends another, whose plugins no key covers"
  }
  const plugins = parsed.plugins ?? []
  if (!Array.isArray(plugins) || plugins.some((plugin) => typeof plugin !== "string" || !pinned.test(plugin))) {
    return "a dprint plugin is not a remote .wasm pinned by its checksum"
  }
  const sources = new Set(plugins.map((plugin: string) => `remote:${plugin.slice(0, plugin.lastIndexOf("@"))}`))
  const directory = NodePath.join(cache, "plugins")
  const files = new Map<string, Array<string>>()
  let names: ReadonlyArray<string> = []
  try {
    names = NodeFs.readdirSync(directory)
  } catch {
    // No cache yet: every plugin is missing below.
  }
  for (const name of [...names].sort()) {
    if (!name.endsWith(".json")) continue
    let source: unknown
    try {
      source = (JSON.parse(NodeFs.readFileSync(NodePath.join(directory, name), "utf8")) as { source?: unknown }).source
    } catch {
      continue
    }
    if (typeof source !== "string" || !sources.has(source)) continue
    const compiled = NodePath.join(directory, `${name.slice(0, -".json".length)}.cwasm`)
    files.set(source, [
      ...(files.get(source) ?? []),
      NodePath.join(directory, name),
      ...(NodeFs.existsSync(compiled) ? [compiled] : [])
    ])
  }
  for (const source of sources) {
    if (!files.has(source)) {
      return `dprint has not fetched ${source.slice("remote:".length)}; one run of dprint on this host fetches it`
    }
  }
  const measured = [...files.values()].flat().sort()
  const hash = createHash("sha256")
  for (const file of measured) hash.update(`${NodePath.basename(file)}\0${fileDigest(file)}\n`)
  return { cache, files: measured, digest: hash.digest("hex") }
}
