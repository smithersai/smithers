/** The platform code of land.vibe, which a .vibe file does not use directly (EK4402). */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import * as NodePath from "node:path"

/** The operator's home directory. */
export const homeDirectory = (): string => homedir()

/** The host's temporary directory. */
export const temporaryDirectory = (): string => tmpdir()

/**
 * Whether `path` exists.
 *
 * @throws {never}
 */
export const pathExists = (path: string): boolean => existsSync(path)

/** A file's UTF-8 text; throws when it cannot be read. */
export const readText = (path: string): string => readFileSync(path, "utf8")

/** Writes `text` to `path`; throws when it cannot be written. */
export const writeText = (path: string, text: string): void => writeFileSync(path, text)

/** Renames `from` to `to`; throws when it cannot. */
export const renameFile = (from: string, to: string): void => renameSync(from, to)

/** Whether `path` matches the glob `pattern`. */
export const matchesGlob = (path: string, pattern: string): boolean => NodePath.matchesGlob(path, pattern)

/**
 * The landing lock `SMITHERS_LAND_LOCK` names, if any.
 *
 * @throws {never}
 */
export const landLockOverride = (): string | undefined => process.env.SMITHERS_LAND_LOCK
