/**
 * The files `@` offers: tracked and untracked-but-not-ignored files from git,
 * else `rg --files`, which also honors `.gitignore`. Read again at most once
 * every few seconds so a file the agent just wrote shows up.
 */
import { execFile } from "node:child_process"

const maxFiles = 20_000
const freshMs = 5_000

const run = (command: string, args: ReadonlyArray<string>, cwd: string, timeout: number): Promise<Array<string> | undefined> =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? undefined : stdout.split("\n").filter((line) => line !== "").slice(0, maxFiles))
    })
  })

export const list = async (cwd: string, timeoutMs = 2_000): Promise<ReadonlyArray<string>> =>
  await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], cwd, timeoutMs) ??
  await run("rg", ["--files"], cwd, timeoutMs) ?? []

/** `list`, cached for a few seconds. */
export const lister = (cwd: string, now: () => number = Date.now, changed: () => void = () => {}): (() => ReadonlyArray<string>) => {
  let cached: ReadonlyArray<string> = []
  let readAt = -Infinity
  let loading = false
  return () => {
    if (!loading && now() - readAt > freshMs) {
      loading = true
      void list(cwd).then((files) => {
        cached = files
        readAt = now()
        loading = false
        changed()
      })
    }
    return cached
  }
}
