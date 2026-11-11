// The platform code of calibrate.vibe: the journal directory on Node's filesystem.
import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"

/** Every entry under `dir`, subdirectories included, relative to `dir`. */
export const listJournalEntries = (dir: string): Promise<ReadonlyArray<string>> => readdir(dir, { recursive: true })

/** One journal file's text. */
export const readJournal = (path: string): Promise<string> => readFile(path, "utf8")

/**
 * The file name of a journal entry.
 * @throws {never}
 */
export function journalName(entry: string): string {
  return basename(entry)
}

/**
 * The path of `entry` under `dir`.
 * @throws {never}
 */
export function journalPath(dir: string, entry: string): string {
  return join(dir, entry)
}
