/**
 * Settles where one command keeps its cache directory.
 *
 * The person who starts a command, or the machine it runs on, may put the
 * cache directory outside the workspace; the workspace declaration may not.
 * `--cache-dir` names any directory: a workspace-relative path is the
 * declared form, and an absolute path or one that starts with `..` names a
 * directory outside. `S.Cache({ outside: true })` asks for an outside
 * directory without naming it, and the machine places it under its user
 * cache directory.
 *
 * An outside directory is carried in the resolved form
 * `Config.normalizeCacheDirectory` accepts: enough `..` segments to climb from
 * any workspace root to the filesystem root, then the absolute path. Every
 * site that joins the cache directory with a root, the canonical root, or a
 * scratch copy therefore names the same outside directory.
 *
 * @since 1.0.0
 */

import * as Config from "@smthrs/targets/Config"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"

/**
 * The machine facts an outside directory depends on.
 *
 * @category models
 * @since 1.0.0
 */
export interface Host {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly platform: NodeJS.Platform
  readonly home: string
}

/**
 * The cache part of a workspace declaration.
 *
 * @category models
 * @since 1.0.0
 */
export interface Declared {
  readonly directory: string
  readonly outside?: boolean | undefined
}

/**
 * The fewest `..` segments an outside directory carries. A scratch copy of
 * the workspace lives under the host's temporary directory and can sit deeper
 * than the workspace itself; the climb must reach the filesystem root from it
 * too.
 *
 * @category constants
 * @since 1.0.0
 */
export const minimumClimb = 64

/**
 * The machine's user cache directory: `XDG_CACHE_HOME` when it is absolute,
 * else `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows when it is
 * absolute, else `~/.cache`.
 *
 * @category resolution
 * @since 1.0.0
 */
export const userCacheDirectory = (host: Host): string => {
  const xdg = host.environment["XDG_CACHE_HOME"]
  if (xdg !== undefined && NodePath.isAbsolute(xdg)) return xdg
  if (host.platform === "darwin") return NodePath.join(host.home, "Library", "Caches")
  const local = host.environment["LOCALAPPDATA"]
  if (host.platform === "win32" && local !== undefined && NodePath.isAbsolute(local)) return local
  return NodePath.join(host.home, ".cache")
}

/**
 * Where `S.Cache({ directory, outside: true })` keeps a workspace's state:
 * `<user cache directory>/smithers/<name>-<hash>/<directory>`. The name is
 * the workspace name with every run of characters other than letters,
 * digits, `.`, `_` and `-` replaced by `-`; the hash is the first 12 hex
 * digits of the sha256 of the canonical workspace root, so two checkouts of
 * one repository keep apart.
 *
 * @category resolution
 * @since 1.0.0
 */
export const machineDirectory = (
  canonicalRoot: string,
  name: string,
  directory: string,
  host: Host
): string => {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 64) || "workspace"
  const hash = createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 12)
  return NodePath.join(userCacheDirectory(host), "smithers", `${safe}-${hash}`, ...directory.split("/"))
}

/**
 * The host this process runs on, read through the environment a command
 * received: its `HOME` when that is absolute, else the account's home.
 *
 * @category resolution
 * @since 1.0.0
 */
export const ambientHost = (environment: Readonly<Record<string, string | undefined>>): Host => {
  const home = environment["HOME"]
  return {
    environment,
    platform: process.platform,
    home: home !== undefined && NodePath.isAbsolute(home) ? home : NodeOs.homedir()
  }
}

/**
 * Resolves the cache directory one command uses, in its resolved form.
 *
 * The flag wins over the declaration. A flag that names a workspace-relative
 * path, and every declared directory, goes through
 * `Config.normalizeDeclaredCacheDirectory` with every check it has today.
 *
 * @category resolution
 * @since 1.0.0
 */
export const resolve = (
  root: string,
  flag: string | undefined,
  declared: Declared,
  name: string,
  host: Host
): string => {
  if (flag === undefined) {
    if (declared.outside !== true) return declared.directory
    return encode(root, machineDirectory(canonical(root), name, declared.directory, host))
  }
  const trimmed = flag.trim()
  if (!NodePath.isAbsolute(trimmed) && trimmed.split(/[/\\]/)[0] !== "..") {
    return Config.normalizeDeclaredCacheDirectory(flag)
  }
  return encode(root, NodePath.resolve(root, trimmed))
}

/**
 * The absolute directory a resolved cache directory names for a workspace
 * root.
 *
 * @category resolution
 * @since 1.0.0
 */
export const absolute = (root: string, cacheDirectory: string): string =>
  NodePath.join(root, ...cacheDirectory.split("/"))

const canonical = (path: string): string => NodeFs.realpathSync(path)

/** The path with its deepest existing ancestor's links resolved. */
const physical = (path: string): string => {
  try {
    return NodeFs.realpathSync(path)
  } catch {
    // The filesystem root always exists, so the climb ends.
    return NodePath.join(physical(NodePath.dirname(path)), NodePath.basename(path))
  }
}

const within = (root: string, candidate: string): string | undefined => {
  const relative = NodePath.relative(root, candidate)
  return relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative)
    ? undefined
    : relative
}

const depth = (path: string): number => path.split(NodePath.sep).filter((segment) => segment !== "").length

/**
 * Encodes an absolute directory for a workspace root. A directory that is
 * inside the workspace, lexically or once links are followed, is the
 * declared form; one that holds the workspace is refused, so clearing the
 * cache can never reach the checkout.
 */
const encode = (root: string, target: string): string => {
  const real = canonical(root)
  const resolved = physical(target)
  const inside = within(root, target) ?? within(real, resolved)
  if (inside !== undefined) return Config.normalizeDeclaredCacheDirectory(inside.split(NodePath.sep).join("/"))
  if (within(target, root) !== undefined || within(resolved, real) !== undefined) {
    throw new Error(`the cache directory ${target} holds the workspace; name a directory beside or inside it`)
  }
  const climb = Math.max(minimumClimb, depth(root), depth(real))
  const tail = NodePath.relative(NodePath.parse(real).root, target).split(NodePath.sep)
  return Config.normalizeCacheDirectory([...Array.from({ length: climb }, () => ".."), ...tail].join("/"))
}
