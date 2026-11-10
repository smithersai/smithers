/** The platform code of calibrate.vibe, which a .vibe file does not use directly (EK4402). */
import { readdir, readFile } from "node:fs/promises"
import * as NodePath from "node:path"

/** Every path under `dir`, subdirectories included, relative to `dir`. */
export const listRecursive = (dir: string): Promise<Array<string>> => readdir(dir, { recursive: true })

/** A file's UTF-8 text. */
export const readText = (path: string): Promise<string> => readFile(path, "utf8")

/**
 * The host's path join.
 *
 * @throws {never}
 */
export const join = (...parts: Array<string>): string => NodePath.join(...parts)

/**
 * The host's path basename.
 *
 * @throws {never}
 */
export const basename = (path: string): string => NodePath.basename(path)
