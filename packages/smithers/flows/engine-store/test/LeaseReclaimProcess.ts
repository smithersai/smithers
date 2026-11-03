/** The child `HardKillReclaim` SIGKILLs after it claims a run, so nothing releases the claim. */
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as ChildProcesses from "./ChildProcesses.ts"

export const fixture = fileURLToPath(new URL("./fixtures/lease-reclaim-child.ts", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))

/**
 * Wall-clock budget for the process case, matching `DurableWaitingRestart`.
 *
 * The child boots an engine and runs migrations, which is most of the cost,
 * and coverage-instrumented workers multiply it. Finite, so a child that never
 * speaks still fails the gate rather than hanging it.
 */
export const processBudget = 120_000

/** Starts the child that claims `runId` in `filename` and then runs until killed. */
export const launch = (filename: string, runId: string): ChildProcessWithoutNullStreams =>
  ChildProcesses.spawn(process.execPath, [fixture, filename, runId], {
    cwd: repositoryRoot,
    // The fixture reads only argv; never hand it the parent's credentials.
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" }
  })

/** Keep only the last 4 KiB of child output in an error message. */
const tail = (text: string): string => text.length > 4096 ? `...${text.slice(-4096)}` : text

/** The child's first protocol line, or a failure naming what it did instead. */
export const firstJsonLine = (child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      reject(new Error(`child did not produce a JSON line\n${tail(stderr)}\n${tail(stdout)}`))
    }, processBudget)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      // Admission telemetry shares stdout with this child protocol.
      const line = stdout.split("\n").slice(0, -1).find((line) => line.startsWith("{"))
      if (line === undefined) return
      clearTimeout(timeout)
      resolve(JSON.parse(line) as Record<string, unknown>)
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (cause) => {
      clearTimeout(timeout)
      reject(cause)
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`child exited before its marker with ${code ?? signal}\n${tail(stderr)}\n${tail(stdout)}`))
    })
  })

/** SIGKILLs the child's process group and waits for the child to exit. */
export const killHard = (child: ChildProcessWithoutNullStreams): Promise<void> => ChildProcesses.kill(child)
