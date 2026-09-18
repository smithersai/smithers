/*
 * One process at a time owns the turn journal's SQLite file.
 *
 * SQLite in WAL mode tolerates concurrent readers but the durable-turn objects
 * above it assume a single owner per scope, so a second launch pointed at the
 * same state directory must be refused rather than silently interleaved. The
 * lease is a pid file beside the database: a live owner refuses the caller, a
 * dead owner's file is taken over, so a crash never leaves the journal locked.
 *
 * This replaced the local daemon's lease when the daemon retired
 * (docs/LOCAL-BACKEND-RETIREMENT.md); the journal is the one thing that still
 * needs single ownership.
 */
import { openSync, closeSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const LEASE_FILE = "owner.pid"

/*
 * The leases this process itself holds, by resolved directory.
 *
 * A pid file naming our own pid is ambiguous on disk: it is either a lease a
 * live owner in THIS process took, or a dead run's file whose pid the OS
 * recycled onto us. Only the process that wrote it can tell, so it remembers.
 * Without this, two owners inside one process — a host booted while another is
 * still serving the same state directory — would both hold the journal, which
 * is the one thing the lease exists to prevent.
 */
const held = new Set<string>()

/** True when a process with this pid exists and this user may signal it. */
const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which is still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Claims the directory for this process, returning the release. Throws when
 * another live process already holds it.
 */
export const acquireTurnJournalLease = (directory: string): (() => void) => {
  const resolved = realpathSync(directory)
  const path = join(resolved, LEASE_FILE)
  for (;;) {
    try {
      const handle = openSync(path, "wx", 0o600)
      try {
        writeFileSync(handle, `${process.pid}\n`)
      } finally {
        closeSync(handle)
      }
      held.add(resolved)
      let released = false
      return () => {
        if (released) return
        released = true
        held.delete(resolved)
        try {
          if (Number(readFileSync(path, "utf8").trim()) === process.pid) unlinkSync(path)
        } catch {
          // Someone else already cleaned it up; the lease is gone either way.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    let owner: number
    try {
      owner = Number(readFileSync(path, "utf8").trim())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    if (held.has(resolved)) throw new Error("This Smithers process already owns the turn journal in that state directory.")
    if (owner !== process.pid && alive(owner)) {
      throw new Error(`Another Smithers process (pid ${owner}) already owns the turn journal.`)
    }
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}
