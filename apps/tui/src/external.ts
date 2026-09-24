/**
 * Leaving the TUI for another program: Ctrl+G's external editor, and the
 * bounded wait on quit.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Edits `text` in `editor` (`$VISUAL`/`$EDITOR`, which may carry arguments),
 * in an owner-only temporary file removed afterwards. The file path is passed
 * to the shell as `$1`, never spliced into the command. `undefined` when the
 * editor exits nonzero.
 */
export const edit = async (text: string, editor: string, parent = tmpdir()): Promise<string | undefined> => {
  const folder = mkdtempSync(join(parent, "smithers-editor-"))
  try {
    const file = join(folder, "prompt.md")
    writeFileSync(file, text, { mode: 0o600 })
    const child = Bun.spawn(["/bin/sh", "-c", `${editor} "$1"`, "sh", file], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit"
    })
    const status = await child.exited
    return status === 0 ? readFileSync(file, "utf8").replace(/\n$/, "") : undefined
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

/** How long quit waits for turns, flows and the host to close before exiting anyway. */
export const quitMs = 3000

/** Settles when `work` does or after `ms`, whichever is first: a hung close never keeps the process alive. */
export const bounded = (work: Promise<unknown>, ms = quitMs): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    work.then(done, done)
  })
