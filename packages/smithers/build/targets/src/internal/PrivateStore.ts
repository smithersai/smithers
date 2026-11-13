/**
 * A private directory of JSON records: owner-only permissions, no symbolic
 * links, and flushed, atomic replacement of every record.
 * @since 1.0.0
 */

import { randomBytes } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"

const recordName = /^[a-z]+\/[a-f0-9]{64}\.json$/

const privateDirectory = (path: string, io: typeof NodeFs): void => {
  io.mkdirSync(path, { recursive: true, mode: 0o700 })
  const stats = io.lstatSync(path)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Review finding store is not a directory: ${path}`)
  }
  if (process.platform !== "win32") io.chmodSync(path, 0o700)
}

/**
 * Creates or opens a store directory readable only by its owner and returns its canonical path.
 * @category store
 * @since 1.0.0
 */
export const ensure = (directory: string, io: typeof NodeFs = NodeFs): string => {
  if (!NodePath.isAbsolute(directory)) throw new Error("Review finding store directory must be absolute")
  privateDirectory(directory, io)
  return io.realpathSync(directory)
}

/** A collection is a real directory inside the store, never a link out of it. */
const collection = (directory: string, name: string, io: typeof NodeFs): string | undefined => {
  const path = NodePath.join(directory, name)
  const stats = io.lstatSync(path, { throwIfNoEntry: false })
  if (stats === undefined) return undefined
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Review finding store collection is not a directory: ${name}`)
  }
  return path
}

const recordPath = (directory: string, name: string): string => {
  if (!recordName.test(name)) throw new Error(`Review finding store record name is not usable: ${name}`)
  return NodePath.join(directory, name)
}

/**
 * Atomically replaces one record, readable only by its owner. Flushes its
 * bytes before replacement and its directory afterward on POSIX hosts.
 * @category store
 * @since 1.0.0
 */
export const write = (directory: string, name: string, value: unknown, io: typeof NodeFs = NodeFs): void => {
  const path = recordPath(directory, name)
  privateDirectory(NodePath.dirname(path), io)
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`
  const descriptor = io.openSync(temporary, "wx", 0o600)
  try {
    try {
      io.writeFileSync(descriptor, `${JSON.stringify(value)}\n`)
      io.fsyncSync(descriptor)
    } finally {
      io.closeSync(descriptor)
    }
    io.renameSync(temporary, path)
    // Windows cannot open directory descriptors for fsync.
    if (process.platform !== "win32") {
      for (const parent of [NodePath.dirname(path), directory]) {
        const handle = io.openSync(parent, io.constants.O_RDONLY | io.constants.O_DIRECTORY)
        try {
          io.fsyncSync(handle)
        } finally {
          io.closeSync(handle)
        }
      }
    }
  } finally {
    io.rmSync(temporary, { force: true })
  }
}

/** One refusal for every way an opened record can fail its identity check. */
const invalidRecord = (name: string, cause?: unknown): Error =>
  new Error(`Review finding store record is not a regular file: ${name}`, { cause })

/**
 * Reads one record, or undefined when it does not exist. A symbolic link or other non-file fails.
 * @category store
 * @since 1.0.0
 */
export const read = (directory: string, name: string, io: typeof NodeFs = NodeFs): unknown => {
  const path = recordPath(directory, name)
  if (collection(directory, NodePath.dirname(name), io) === undefined) return undefined
  let descriptor: number
  let expected: NodeFs.BigIntStats
  try {
    expected = io.lstatSync(path, { bigint: true })
    if (!expected.isFile()) throw invalidRecord(name)
    // O_NOFOLLOW is unavailable on Windows. Verify the opened identity against
    // the non-following stat before reading; O_NONBLOCK never waits on a FIFO.
    descriptor = io.openSync(
      path,
      io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK
    )
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw invalidRecord(name, cause)
  }
  try {
    const opened = io.fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw invalidRecord(name)
    }
    return JSON.parse(io.readFileSync(descriptor, "utf8")) as unknown
  } finally {
    io.closeSync(descriptor)
  }
}

/**
 * Reads available records in name order. Stray filenames, malformed JSON and
 * missing or permission-denied records are absent; unsafe identities still fail.
 * @category store
 * @since 1.0.0
 */
export const list = (directory: string, name: string, io: typeof NodeFs = NodeFs): ReadonlyArray<unknown> => {
  const path = collection(directory, name, io)
  if (path === undefined) return []
  const records: Array<unknown> = []
  for (const entry of io.readdirSync(path).sort()) {
    const record = `${name}/${entry}`
    if (!recordName.test(record)) continue
    try {
      const value = read(directory, record, io)
      if (value !== undefined) records.push(value)
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException
      const code = (error.cause as NodeJS.ErrnoException | undefined)?.code ?? error.code
      // Corrupt or unavailable records are misses; confinement and storage
      // failures must still reach the caller.
      if (!(cause instanceof SyntaxError) && code !== "EACCES" && code !== "EPERM" && code !== "ENOENT") throw cause
    }
  }
  return records
}
