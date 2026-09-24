/*
 * Edits a tracked source file under a running flow-graph host, and puts it
 * back even after a crash.
 *
 * Two graph cases need the WORKING TREE to move while a host serves a
 * revision it already read (`e2e/graph/flow-graph.spec.ts`), so the file must
 * be the tracked one the host loaded: a copy under `TMPDIR` is neither the
 * module the host runs nor a path any revision holds.
 *
 * What is avoidable is leaving it edited. Before the first byte changes, the
 * original is written to a journal outside the checkout, keyed by the file's
 * path and naming the editing process. Every normal exit, a thrown assertion
 * and SIGINT/SIGTERM restore the file and delete the journal. SIGKILL runs no
 * handler, so the journal outlives it: the host restores a journal whose
 * process is dead before it loads the fixture (`recoverTrackedFile`), and the
 * next edit does the same before it reads the "original". A journal whose
 * process is alive is another run editing the same checkout, and a second
 * edit refuses instead of saving that run's edit as its original.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

interface Journal {
  readonly pid: number
  readonly original: string
}

const journalPath = (path: string, directory: string): string =>
  join(directory, `${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}.smithers-fixture-edit.json`)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const readJournal = (journal: string): Journal | undefined => {
  try {
    return JSON.parse(readFileSync(journal, "utf8")) as Journal
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * Restores `path` from a journal a killed edit left behind.
 *
 * `clean`: no edit was pending. `restored`: a dead process's edit was undone.
 * `held`: a live process is editing the file now, and it is left alone.
 */
export const recoverTrackedFile = (path: string, journalDir: string = tmpdir()): "clean" | "restored" | "held" => {
  const journal = journalPath(path, journalDir)
  const pending = readJournal(journal)
  if (pending === undefined) return "clean"
  if (pending.pid !== process.pid && alive(pending.pid)) return "held"
  writeFileSync(path, pending.original)
  rmSync(journal, { force: true })
  return "restored"
}

/**
 * Runs `body` with the file's original bytes and an editor for it, and
 * restores the original whatever happens.
 */
export const overTrackedFile = async (
  path: string,
  body: (original: string, edit: (bytes: string) => void) => Promise<void>,
  journalDir: string = tmpdir()
): Promise<void> => {
  const journal = journalPath(path, journalDir)
  const busy = () =>
    new Error(`${path} is being edited by another flow-graph run (pid ${readJournal(journal)?.pid}); run one at a time per checkout`)
  if (recoverTrackedFile(path, journalDir) === "held") throw busy()
  const original = readFileSync(path, "utf8")
  mkdirSync(journalDir, { recursive: true })
  try {
    // `wx` claims the journal atomically: a run that raced past the check above loses here.
    writeFileSync(journal, JSON.stringify({ pid: process.pid, original } satisfies Journal), { flag: "wx" })
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === "EEXIST" ? busy() : error
  }
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    writeFileSync(path, original)
    rmSync(journal, { force: true })
  }
  const onSignal = () => {
    restore()
    process.exit(1)
  }
  process.once("exit", restore)
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  try {
    await body(original, (bytes) => writeFileSync(path, bytes))
  } finally {
    restore()
    process.off("exit", restore)
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  }
}
