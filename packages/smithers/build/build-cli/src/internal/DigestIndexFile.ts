/**
 * The file digests one invocation remembers for the next.
 *
 * Planning keys every target on the SHA-256 of each file it declares, and a
 * graph's source-tree filegroups name most of the repository, so a plan read
 * every byte of the tree on every invocation: about 57,000 files for one
 * target of a 4,500-target workspace. The index keeps each settled file's
 * digest beside the status it was read at ({@link SafeFs.DigestIndex}) in the
 * workspace cache directory, so the next plan reads only files whose status
 * changed. A digest is answered from the index only when the live `lstat`
 * still matches, which is the trust Git's index places in the same fields.
 *
 * The directory holds a `.gitignore` that ignores everything in it, so a plan
 * leaves no untracked file in a checkout that does not ignore the cache
 * directory. The file is a cache, never an authority: one that is missing, unreadable,
 * malformed, of another format or whose checksum disagrees is ignored and
 * every file is read again. Writes go to a temporary file renamed into place,
 * so a reader sees a whole index or the previous one; when two invocations
 * save at once the last rename wins and the other's new rows are read again
 * next time.
 *
 * @since 1.0.0
 */

import * as SafeFs from "@smthrs/targets/SafeFs"
import { createHash, randomBytes } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Diagnostic from "../Diagnostic.ts"

/** The format tag a saved index carries; any other tag is ignored. */
const format = "smthrs-file-digests/1"

/**
 * Rows kept in one saved index; rows the current plan used are kept first.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumRows = 500_000

/** The largest index file read; a larger one is ignored. */
const maximumBytes = 512 * 1024 * 1024

const digestPattern = /^[0-9a-f]{64}$/

/**
 * Where a workspace's index lives: `<cache directory>/plan/file-digests.json`.
 *
 * @category paths
 * @since 1.0.0
 */
export const path = (root: string, cacheDirectory: string): string =>
  NodePath.join(root, ...cacheDirectory.split("/"), "plan", "file-digests.json")

/**
 * The rows of an index loaded from disk, noting whether a plan remembered or
 * forgot any row since: an index nothing changed is not written again.
 */
class LoadedRows extends Map<string, SafeFs.DigestRow> {
  changed = false
  constructor(rows: ReadonlyArray<readonly [string, SafeFs.DigestRow]>) {
    super()
    for (const [file, row] of rows) super.set(file, row)
  }
  override set(file: string, row: SafeFs.DigestRow): this {
    this.changed = true
    return super.set(file, row)
  }
  override delete(file: string): boolean {
    const had = super.delete(file)
    if (had) this.changed = true
    return had
  }
  override clear(): void {
    if (this.size > 0) this.changed = true
    super.clear()
  }
}

const checksum = (rows: string): string => createHash("sha256").update(rows).digest("hex")

const rowsOf = (value: unknown): Array<readonly [string, SafeFs.DigestRow]> | undefined => {
  if (!Array.isArray(value)) return undefined
  const rows: Array<readonly [string, SafeFs.DigestRow]> = []
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 3) return undefined
    const [file, status, digest] = row as Array<unknown>
    if (typeof file !== "string" || !NodePath.isAbsolute(file)) return undefined
    if (typeof status !== "string" || status === "") return undefined
    if (typeof digest !== "string" || !digestPattern.test(digest)) return undefined
    rows.push([file, { status, digest, settled: true }])
  }
  return rows
}

/**
 * Loads a workspace's index, or an empty one when there is none to trust.
 *
 * @category io
 * @since 1.0.0
 */
export const load = async (
  root: string,
  cacheDirectory: string,
  log?: (line: string) => void
): Promise<SafeFs.DigestIndex> => {
  const file = path(root, cacheDirectory)
  let text: string
  try {
    const stats = await Fs.stat(file)
    if (stats.size > maximumBytes) {
      log?.(`smthrs: file digest index ignored: ${stats.size} bytes is over ${maximumBytes}`)
      return SafeFs.makeDigestIndex()
    }
    text = await Fs.readFile(file, "utf8")
  } catch (cause) {
    if (SafeFs.errorCode(cause) !== "ENOENT") {
      log?.(`smthrs: file digest index ignored: ${Diagnostic.describe(cause)}`)
    }
    return SafeFs.makeDigestIndex()
  }
  const ignored = (reason: string) => {
    log?.(`smthrs: file digest index ignored: ${reason}`)
    return SafeFs.makeDigestIndex()
  }
  let saved: unknown
  try {
    saved = JSON.parse(text)
  } catch {
    return ignored("not JSON")
  }
  if (typeof saved !== "object" || saved === null) return ignored("not an object")
  const { format: tag, check, rows: encoded } = saved as Record<string, unknown>
  if (tag !== format) return ignored(`format ${JSON.stringify(tag)} is not ${format}`)
  if (typeof encoded !== "string" || typeof check !== "string" || checksum(encoded) !== check) {
    return ignored("checksum mismatch")
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(encoded)
  } catch {
    return ignored("rows are not JSON")
  }
  const rows = rowsOf(decoded)
  if (rows === undefined) return ignored("malformed row")
  return { ...SafeFs.makeDigestIndex(), rows: new LoadedRows(rows) }
}

/**
 * Saves an index's settled rows for the next invocation: the rows this one
 * used first, then the remembered rest, up to {@link maximumRows}. A failure
 * to save is logged, never thrown: the next plan reads the files again. An
 * index {@link load} read whose rows no plan changed is already on disk and
 * is not written again.
 *
 * @category io
 * @since 1.0.0
 */
export const save = async (
  root: string,
  cacheDirectory: string,
  index: SafeFs.DigestIndex,
  log?: (line: string) => void
): Promise<void> => {
  if (index.rows instanceof LoadedRows && !index.rows.changed) return
  const kept: Array<readonly [string, string, string]> = []
  for (const file of index.used) {
    const row = index.rows.get(file)
    if (row?.settled === true && kept.length < maximumRows) kept.push([file, row.status, row.digest])
  }
  for (const [file, row] of index.rows) {
    if (kept.length >= maximumRows) break
    if (row.settled && !index.used.has(file)) kept.push([file, row.status, row.digest])
  }
  const rows = JSON.stringify(kept)
  const file = path(root, cacheDirectory)
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await Fs.mkdir(NodePath.dirname(file), { recursive: true })
    // A plan alone must not leave an untracked cache in a checkout that does
    // not ignore its cache directory: the directory ignores its own contents.
    await Fs.writeFile(NodePath.join(NodePath.dirname(file), ".gitignore"), "*\n", { flag: "wx" }).catch(
      (cause: unknown) => {
        if (SafeFs.errorCode(cause) !== "EEXIST") throw cause
      }
    )
    await Fs.writeFile(temporary, JSON.stringify({ format, check: checksum(rows), rows }), { flag: "wx" })
    await Fs.rename(temporary, file)
  } catch (cause) {
    log?.(`smthrs: file digest index not saved: ${Diagnostic.describe(cause)}`)
    await Fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}
