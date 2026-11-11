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
  ChildProcesses.spawn(process.execPath, [ChildProcesses.vibeImport, fixture, filename, runId], {
    cwd: repositoryRoot,
    // The fixture reads only argv; never hand it the parent's credentials.
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" }
  })

/** The child's first protocol line, ignoring admission telemetry. */
export const firstJsonLine = (child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> =>
  ChildProcesses.waitForLine(child, (line) => line.startsWith("{"), {
    timeoutMs: processBudget,
    description: "JSON line"
  }).then((line) => JSON.parse(line) as Record<string, unknown>)

/** SIGKILLs the child's process group and waits for the child to exit. */
export const killHard = (child: ChildProcessWithoutNullStreams): Promise<void> => ChildProcesses.kill(child)
