/** The child `ReclaimedAttemptCache` kills during its `Test` step, so its rows are the ones a SIGKILL leaves. */
import { expect } from "@effect/vitest"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as ChildProcesses from "./ChildProcesses.ts"

export const fixture = fileURLToPath(new URL("./fixtures/reclaimed-attempt-child.ts", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))

/** Wall-clock budget per case: a child boot plus migrations, under coverage, on a loaded host. */
export const processBudget = 180_000

/** The execution the child owns when it is killed. */
export const orphan = "orphan"

/**
 * Runs the child entrypoint `script` with `args`, waits for the first JSON
 * line it prints, SIGKILLs it, and returns that line.
 */
export const killAtMarker = async (script: string, args: ReadonlyArray<string>): Promise<unknown> => {
  const child: ChildProcessWithoutNullStreams = ChildProcesses.spawn(process.execPath, [
    ChildProcesses.vibeImport,
    script,
    ...args
  ], {
    cwd: repositoryRoot,
    // The fixture reads only argv; never hand it the parent's credentials.
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" }
  })
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      const timeout = setTimeout(
        () => reject(new Error(`child never printed its marker\n${stderr}\n${stdout}`)),
        processBudget
      )
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk
        // Admission telemetry shares stdout with this child protocol.
        const line = stdout.split("\n").slice(0, -1).find((line) => line.startsWith("{"))
        if (line === undefined) return
        clearTimeout(timeout)
        resolve(JSON.parse(line))
      })
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4096)
      })
      child.once("exit", (code, signal) => {
        clearTimeout(timeout)
        reject(new Error(`child exited before its marker with ${code ?? signal}\n${stderr}\n${stdout}`))
      })
    })
  } finally {
    await ChildProcesses.kill(child)
  }
}

/** Kills the child once its `Test` body is running. */
export const killDuringTest = async (filename: string): Promise<void> => {
  const marker = await killAtMarker(fixture, [filename, orphan, "#42"])
  expect(marker).toMatchObject({ status: "testing" })
}
