/** How a replay stops a command: a real process that ignores the signal to stop is killed. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { exec, runStep } from "../../src/replay/Process.vibe"

const made: Array<string> = []
afterAll(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })))

const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "replay-process-"))
  made.push(path)
  return path
}

/** A shell that writes its process id, ignores the signal to stop, and becomes a long `sleep`. */
const stubborn = (file: string): ReadonlyArray<string> => ["-c", `trap "" TERM; echo $$ > ${file}; exec sleep 120`]

const environment = { PATH: process.env["PATH"] }

const onNode = <A, E>(work: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(work)

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether the process at the id in `file` has ended, given a moment to be reaped. */
const ended = async (file: string): Promise<boolean> => {
  expect(existsSync(file)).toBe(true)
  const pid = Number(readFileSync(file, "utf8").trim())
  for (let tries = 0; tries < 50 && isRunning(pid); tries++) await new Promise((done) => setTimeout(done, 100))
  return !isRunning(pid)
}

describe("a command that ignores the signal to stop", { timeout: 120_000 }, () => {
  it("is killed when it runs past a step's time limit", async () => {
    const cwd = directory()
    const file = join(cwd, "pid")
    const run = await onNode(
      runStep("sh", stubborn(file), cwd, environment, "2 seconds").pipe(Effect.provide(NodeServices.layer)) as never
    ) as { readonly timedOut: boolean; readonly exitCode: number }
    expect(run).toMatchObject({ timedOut: true, exitCode: 124 })
    expect(await ended(file)).toBe(true)
  })

  it("is killed when the replay stops waiting for it", async () => {
    const cwd = directory()
    const file = join(cwd, "pid")
    const outcome = await onNode(
      exec("sh", stubborn(file), cwd, environment, 4000, undefined, true).pipe(
        Effect.timeoutOption("2 seconds"),
        Effect.provide(NodeServices.layer)
      ) as never
    ) as Option.Option<unknown>
    expect(Option.isNone(outcome)).toBe(true)
    expect(await ended(file)).toBe(true)
  })
})
