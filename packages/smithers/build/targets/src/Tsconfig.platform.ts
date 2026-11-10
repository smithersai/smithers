/**
 * The platform code of Tsconfig.vibe, which a .vibe file does not import as a
 * value (EK4402).
 *
 * @since 0.1.0
 */

import * as NodePath from "node:path"

/**
 * The POSIX directory part of a path.
 *
 * @category paths
 * @since 0.1.0
 */
export const posixDirname = (path: string): string => NodePath.posix.dirname(path)

/**
 * The POSIX relative path from one path to another, both anchored under one
 * absolute base so the result is independent of the process working directory.
 *
 * @category paths
 * @since 0.1.0
 */
export const posixRelativeUnder = (base: string, from: string, to: string): string =>
  NodePath.posix.relative(NodePath.posix.join("/", base, from), NodePath.posix.join("/", base, to))
