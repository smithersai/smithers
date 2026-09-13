import { dlopen, FFIType } from "bun:ffi"
import { closeSync, constants, fstatSync, openSync } from "node:fs"
import { join } from "node:path"

/**
 * The kernel, never a saved PID, arbitrates one session owner per state directory.
 * Held for the owner's entire lifetime; a crash releases it automatically.
 * The file is deliberately never unlinked (unlinking an advisory lock permits
 * two processes to lock different inodes under the same name).
 */
export const acquireDaemonLease = (directory: string): (() => void) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Persistent local terminals require macOS or Linux.")
  }
  const library = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
  })
  let descriptor: number | undefined
  try {
    descriptor = openSync(join(directory, "owner.lock"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()) {
      throw new Error("The session-owner lease must be private and owned by the current user.")
    }
    if (library.symbols.flock(descriptor, 2 | 4) !== 0) throw new Error("Another Smithers session owner holds this state directory.")
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    library.close()
    throw error
  }
  const held = descriptor
  let released = false
  return () => {
    if (released) return
    released = true
    // close releases the lease even if an explicit unlock fails.
    try { library.symbols.flock(held, 8) } finally { closeSync(held); library.close() }
  }
}
