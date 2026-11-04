/**
 * Coalesces adjacent WAL writes before an OPFS call. SQLite's sync/read/size/
 * truncate/close boundaries drain the buffer; FULL durability is unchanged.
 * Only the exclusive access-handle pool may use this: one connection per file.
 *
 * @since 1.0.0
 */

import { SQLITE_IOERR, SQLITE_OK, SQLITE_OPEN_WAL } from "@journeyapps/wa-sqlite"

/**
 * The synchronous access-handle VFS operations whose visibility must drain pending bytes.
 * @private
 * @since 1.0.0
 */
export interface Vfs {
  jOpen(name: string | null, file: number, flags: number, output: DataView): number
  jWrite(file: number, bytes: Uint8Array, offset: number): number
  jRead(file: number, bytes: Uint8Array, offset: number): number
  jSync(file: number, flags: number): number
  jFileSize(file: number, size: DataView): number
  jTruncate(file: number, size: number): number
  jClose(file: number): number
  jDelete(name: string, syncDirectory: number): number
  close(): Promise<void>
}

/** Bounded per WAL file, independent of transaction size; no whole-transaction copy. */
const capacity = 64 * 1024
interface Pending {
  readonly bytes: Uint8Array
  offset: number
  length: number
  error: number
}

/**
 * Installs bounded write coalescing on the real pool, retaining its file format
 * and every durability call. A failed drain poisons that file until close, so
 * a later operation cannot acknowledge bytes whose host write failed.
 * @private
 * @since 1.0.0
 */
export const bufferWalWrites = <T extends Vfs>(vfs: T): T => {
  const write = vfs.jWrite.bind(vfs)
  const pending = new Map<number, Pending>()
  const drain = (file: number): number => {
    const state = pending.get(file)
    if (state === undefined) return SQLITE_OK
    if (state.error !== SQLITE_OK) return state.error
    if (state.length === 0) return SQLITE_OK
    try {
      state.error = write(file, state.bytes.subarray(0, state.length), state.offset)
    } catch {
      state.error = SQLITE_IOERR
    }
    if (state.error === SQLITE_OK) state.length = 0
    return state.error
  }
  const drainAll = (): number => {
    for (const file of pending.keys()) {
      const result = drain(file)
      if (result !== SQLITE_OK) return result
    }
    return SQLITE_OK
  }
  const open = vfs.jOpen.bind(vfs)
  vfs.jOpen = (name, file, flags, output) => {
    const result = open(name, file, flags, output)
    if (result === SQLITE_OK && (flags & SQLITE_OPEN_WAL) !== 0) {
      pending.set(file, { bytes: new Uint8Array(capacity), offset: 0, length: 0, error: SQLITE_OK })
    }
    return result
  }
  vfs.jWrite = (file, bytes, offset) => {
    const state = pending.get(file)
    if (state === undefined) return write(file, bytes, offset)
    if (state.error !== SQLITE_OK) return state.error
    if (state.length > 0 && (offset !== state.offset + state.length || state.length + bytes.length > capacity)) {
      const result = drain(file)
      if (result !== SQLITE_OK) return result
    }
    if (bytes.length > capacity) {
      try {
        state.error = write(file, bytes, offset)
      } catch {
        state.error = SQLITE_IOERR
      }
      return state.error
    }
    if (state.length === 0) state.offset = offset
    // wa-sqlite passes a Uint8Array-like proxy, not an indexed typed array.
    // Materialize its view, then copy: SQLite reuses WASM memory after xWrite.
    state.bytes.set(bytes.subarray(), state.length)
    state.length += bytes.length
    return SQLITE_OK
  }
  const read = vfs.jRead.bind(vfs)
  vfs.jRead = (file, bytes, offset) => {
    const result = drain(file)
    return result === SQLITE_OK ? read(file, bytes, offset) : result
  }
  const sync = vfs.jSync.bind(vfs)
  vfs.jSync = (file, flags) => {
    const result = drain(file)
    return result === SQLITE_OK ? sync(file, flags) : result
  }
  const size = vfs.jFileSize.bind(vfs)
  vfs.jFileSize = (file, output) => {
    const result = drain(file)
    return result === SQLITE_OK ? size(file, output) : result
  }
  const truncate = vfs.jTruncate.bind(vfs)
  vfs.jTruncate = (file, length) => {
    const result = drain(file)
    return result === SQLITE_OK ? truncate(file, length) : result
  }
  const close = vfs.jClose.bind(vfs)
  vfs.jClose = (file) => {
    const result = drain(file)
    // Even a failed file must release its access handle bookkeeping.
    pending.delete(file)
    const closed = close(file)
    return result === SQLITE_OK ? closed : result
  }
  const remove = vfs.jDelete.bind(vfs)
  vfs.jDelete = (name, syncDirectory) => {
    const result = drainAll()
    return result === SQLITE_OK ? remove(name, syncDirectory) : result
  }
  const dispose = vfs.close.bind(vfs)
  vfs.close = async () => {
    // SQLite xClose drains normally. Pool disposal can also follow a dead
    // connection: discard its unsynced tail, never resurrect it after a crash.
    pending.clear()
    await dispose()
  }
  return vfs
}
