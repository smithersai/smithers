/**
 * The identity of the Apple SDK or developer directory a command inherits
 * through `SDKROOT` or `DEVELOPER_DIR`.
 *
 * The identity is the content of every file a compiler can reach below the
 * root, with the resolved path and the version manifests Apple writes. A
 * manifest alone is not an identity: a header changed in place leaves it as it
 * was. The read is bounded, so a root too large to read whole, or one holding
 * an entry whose content cannot be read, has no identity and its command is
 * not cached.
 *
 * @since 1.0.0
 */

import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import * as Path from "./Path.ts"

/**
 * The files that state an SDK's or a developer directory's version, relative
 * to its root.
 *
 * @category measuring
 * @since 1.0.0
 */
export const manifests: ReadonlyArray<string> = ["SDKSettings.json", "SDKSettings.plist", "version.plist"]

/**
 * How much of a root is read before it is refused. A linked directory's
 * entries count like any other.
 *
 * @category measuring
 * @since 1.0.0
 */
export interface Limits {
  readonly entries: number
  readonly bytes: number
}

/**
 * The default bound on a root.
 *
 * @category measuring
 * @since 1.0.0
 */
export const defaultLimits: Limits = { entries: 4096, bytes: 64 * 1024 * 1024 }

/** The manifests of one root; Xcode keeps its own beside `Contents/Developer`. */
const manifestPaths = (root: string): ReadonlyArray<string> => {
  const paths = manifests.map((name) => NodePath.join(root, name))
  const parent = NodePath.dirname(root)
  return NodePath.basename(root) === "Developer" && NodePath.basename(parent) === "Contents"
    ? [...paths, NodePath.join(parent, "version.plist")]
    : paths
}

/** The bytes of a regular file, or nothing when the path is not one. */
const fileBytes = (path: string): Buffer | undefined => {
  try {
    return NodeFs.statSync(path).isFile() ? NodeFs.readFileSync(path) : undefined
  } catch {
    return undefined
  }
}

/**
 * Every name, file and link reachable below a root, or nothing when the limits
 * are passed or an entry's content cannot be read.
 */
const reachableTree = (root: string, limits: Limits): string | undefined => {
  const hash = createHash("sha256")
  let entries = 0
  let bytes = 0
  // The resolved directories being read, outermost first: a link back to one
  // of them is a cycle, whose content the outer read already covers.
  const open = new Set<string>()
  const visit = (directory: string, prefix: string): boolean => {
    const resolved = NodeFs.realpathSync(directory)
    open.add(resolved)
    const children = new Map(NodeFs.readdirSync(directory, { withFileTypes: true }).map((child) => [child.name, child]))
    for (const child of [...children.keys()].sort().map((name) => children.get(name)!)) {
      if (++entries > limits.entries) return false
      const path = NodePath.join(directory, child.name)
      const name = `${prefix}${child.name}`
      const link = child.isSymbolicLink() ? NodeFs.readlinkSync(path) : ""
      // A link is its target's text and its target's content, wherever the
      // target lives. One that leads nowhere has no content to read.
      const stats = NodeFs.statSync(path, { throwIfNoEntry: false })
      if (stats === undefined) return false
      if (stats.isDirectory()) {
        if (child.isSymbolicLink() && open.has(NodeFs.realpathSync(path))) {
          hash.update(`c\0${name}\0${link}\n`)
          continue
        }
        hash.update(`d\0${name}\0${link}\n`)
        if (!visit(path, `${name}/`)) return false
        continue
      }
      // A socket, a pipe or a device is not content a digest can hold.
      if (!stats.isFile()) return false
      bytes += stats.size
      if (bytes > limits.bytes) return false
      const executable = (stats.mode & 0o111) === 0 ? "-" : "x"
      hash.update(
        `f\0${name}\0${link}\0${executable}\0${createHash("sha256").update(NodeFs.readFileSync(path)).digest("hex")}\n`
      )
    }
    open.delete(resolved)
    return true
  }
  return visit(root, "") ? hash.digest("hex") : undefined
}

/**
 * The identity of the SDK or developer directory at `path`, or `null` when it
 * has none: the path is missing, it holds the workspace, it is too large to
 * read whole, or something below it cannot be read. A manifest adds to the
 * identity and never stands in for the content.
 *
 * @category measuring
 * @since 1.0.0
 */
export const identify = (path: string, workspaceRoot: string, limits: Limits = defaultLimits): string | null => {
  try {
    const root = NodeFs.realpathSync(path)
    if (Path.contains(root, workspaceRoot)) return null
    const hash = createHash("sha256").update(`${root}\n`)
    for (const manifest of manifestPaths(root)) {
      const bytes = fileBytes(manifest)
      if (bytes === undefined) continue
      hash.update(
        `manifest\0${NodePath.relative(root, manifest)}\0${createHash("sha256").update(bytes).digest("hex")}\n`
      )
    }
    const tree = reachableTree(root, limits)
    return tree === undefined ? null : hash.update(`tree\0${tree}\n`).digest("hex")
  } catch {
    return null
  }
}
