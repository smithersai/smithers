import { watch } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { expect } from "vitest"
import { writeExecutable, writeNativeExecutable } from "./Executable.ts"

/** A single real process, including on Windows; publishes its PID before waiting. */
export const hungExecutable = async (root: string, name: string, native = process.platform === "win32") => {
  const marker = Path.join(root, name + ".started")
  // A native hang has no interpreter child for execFile to orphan on Windows.
  const binary = native
    ? await writeNativeExecutable(
      Path.join(root, name + (process.platform === "win32" ? ".exe" : "")),
      `
fn main() {
  std::fs::write(${JSON.stringify(marker + ".pending")}, std::process::id().to_string()).unwrap();
  std::fs::rename(${JSON.stringify(marker + ".pending")}, ${JSON.stringify(marker)}).unwrap();
  loop { std::thread::park(); }
}`
    )
    : await writeExecutable(
      Path.join(root, name),
      `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(marker + ".pending")}, String(process.pid))
fs.renameSync(${JSON.stringify(marker + ".pending")}, ${JSON.stringify(marker)})
setInterval(() => {}, 1000)
`
    )
  // Acquire the watcher only after compilation succeeds and before execution.
  let processId: number | undefined
  let ready!: (pid: number) => void
  let failed!: (cause: unknown) => void
  const started = new Promise<number>((resolve, reject) => {
    ready = resolve
    failed = reject
  })
  const watcher = watch(root, (_event, file) => {
    if (String(file) === name + ".started") {
      Fs.readFile(marker, "utf8").then((value) => {
        const pid = Number(value)
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid fixture PID")
        processId = pid
        ready(pid)
      }).catch(failed)
    }
  })
  const alive = () => {
    if (processId === undefined) return false
    try {
      process.kill(processId, 0)
      return true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false
      throw cause
    }
  }
  return {
    binary,
    started,
    alive,
    close: async () => {
      watcher.close()
      if (alive()) {
        try {
          process.kill(processId!, "SIGKILL")
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
        }
      }
      await expect.poll(alive, { timeout: 5_000 }).toBe(false)
    }
  }
}
