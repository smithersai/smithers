/**
 * The platform code of NewPackage.vibe, which a .vibe file does not import as a
 * value (EK4402).
 *
 * @since 0.1.0
 */

import { randomUUID as nodeRandomUUID } from "node:crypto"
import type * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"

/**
 * Joins host path segments.
 *
 * @category paths
 * @since 0.1.0
 */
export const join = (...segments: ReadonlyArray<string>): string => NodePath.join(...segments)

/**
 * The host relative path from one path to another.
 *
 * @category paths
 * @since 0.1.0
 */
export const relative = (from: string, to: string): string => NodePath.relative(from, to)

/**
 * The host path separator.
 *
 * @category paths
 * @since 0.1.0
 */
export const sep: string = NodePath.sep

/**
 * Reads a path's status without following a final symbolic link.
 *
 * @category files
 * @since 0.1.0
 */
export const lstat = (path: string): Promise<NodeFs.Stats> => Fs.lstat(path)

/**
 * Creates one directory.
 *
 * @category files
 * @since 0.1.0
 */
export const mkdir = async (path: string): Promise<void> => {
  await Fs.mkdir(path)
}

/**
 * Resolves a path to its canonical form.
 *
 * @category files
 * @since 0.1.0
 */
export const realpath = (path: string): Promise<string> => Fs.realpath(path)

/**
 * Lists a directory's entry names.
 *
 * @category files
 * @since 0.1.0
 */
export const readdir = (path: string): Promise<Array<string>> => Fs.readdir(path)

/**
 * Renames a path.
 *
 * @category files
 * @since 0.1.0
 */
export const rename = (from: string, to: string): Promise<void> => Fs.rename(from, to)

/**
 * Removes a path and everything under it; an absent path is not an error.
 *
 * @category files
 * @since 0.1.0
 */
export const removeRecursive = (path: string): Promise<void> => Fs.rm(path, { recursive: true, force: true })

/**
 * A random RFC 4122 version 4 UUID.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const randomUUID = (): string => nodeRandomUUID()

/**
 * Whether a value is a Proxy.
 *
 * @category guards
 * @since 0.1.0
 */
export const isProxy = (value: unknown): boolean => NodeUtil.isProxy(value)
