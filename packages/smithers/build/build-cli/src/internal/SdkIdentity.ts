/**
 * The identity of the Apple SDK or developer directory a command inherits
 * through `SDKROOT` or `DEVELOPER_DIR`.
 *
 * An installed SDK is gigabytes of read-only files whose links reach into the
 * rest of the system, so it is never read whole. Apple writes its version and
 * build into a manifest at a known place, and the manifest's bytes with the
 * resolved path are the identity. A directory with no manifest is read whole
 * only while it is small; a large one has no identity.
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
 * How much of a directory with no manifest is read before it is refused.
 *
 * @category measuring
 * @since 1.0.0
 */
export interface Limits {
  readonly entries: number
  readonly bytes: number
}

/**
 * The default bound on a directory with no manifest.
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

/** Every name, file and link below a small directory, or nothing once it passes the limits. */
const smallTree = (root: string, limits: Limits): string | undefined => {
  const hash = createHash("sha256")
  let entries = 0
  let bytes = 0
  const visit = (directory: string, prefix: string): boolean => {
    const children = NodeFs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : 1)
    for (const child of children) {
      if (++entries > limits.entries) return false
      const path = NodePath.join(directory, child.name)
      const name = `${prefix}${child.name}`
      if (child.isDirectory()) {
        hash.update(`d\0${name}\n`)
        if (!visit(path, `${name}/`)) return false
        continue
      }
      // A link is its target's text, and its target's bytes when that is a
      // file; where the target lives is not a reason to refuse the tree.
      const link = child.isSymbolicLink() ? NodeFs.readlinkSync(path) : ""
      const stats = NodeFs.statSync(path, { throwIfNoEntry: false })
      if (stats === undefined || !stats.isFile()) {
        hash.update(`l\0${name}\0${link}\n`)
        continue
      }
      bytes += stats.size
      if (bytes > limits.bytes) return false
      const executable = (stats.mode & 0o111) === 0 ? "-" : "x"
      hash.update(
        `f\0${name}\0${link}\0${executable}\0${createHash("sha256").update(NodeFs.readFileSync(path)).digest("hex")}\n`
      )
    }
    return true
  }
  return visit(root, "") ? hash.digest("hex") : undefined
}

/**
 * The identity of the SDK or developer directory at `path`, or `null` when it
 * has none: the path is missing, it holds the workspace, or it has no manifest
 * and is too large to read.
 *
 * @category measuring
 * @since 1.0.0
 */
export const identify = (path: string, workspaceRoot: string, limits: Limits = defaultLimits): string | null => {
  try {
    const root = NodeFs.realpathSync(path)
    if (Path.contains(root, workspaceRoot)) return null
    const hash = createHash("sha256").update(`${root}\n`)
    let found = false
    for (const manifest of manifestPaths(root)) {
      const bytes = fileBytes(manifest)
      if (bytes === undefined) continue
      found = true
      hash.update(
        `manifest\0${NodePath.relative(root, manifest)}\0${createHash("sha256").update(bytes).digest("hex")}\n`
      )
    }
    if (found) return hash.digest("hex")
    const tree = smallTree(root, limits)
    return tree === undefined ? null : hash.update(`tree\0${tree}\n`).digest("hex")
  } catch {
    return null
  }
}
