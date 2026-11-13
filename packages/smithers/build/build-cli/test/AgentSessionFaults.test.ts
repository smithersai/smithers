import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Input from "@smthrs/targets/Input"
import { Effect, PlatformError, Stream } from "effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"
import { ProcessSpawner } from "../src/internal/ContainedProcess.ts"

let root: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-faults-")))
  await Fs.mkdir(NodePath.join(root, "src"))
  await Fs.writeFile(NodePath.join(root, "src", "a.ts"), "export const a = 1\n")
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "initial"]]) {
    execFileSync("git", ["-c", "user.email=test@test", "-c", "user.name=test", ...args], { cwd: root, stdio: "pipe" })
  }
  await Fs.writeFile(NodePath.join(root, "src", "a.ts"), "export const a = 2\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const failure = (description?: string, cause?: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "read",
    ...(description === undefined ? {} : { description }),
    ...(cause === undefined ? {} : { cause })
  })

/** Expands a real git diff in `root` through the given spawner. */
const diffFailure = (spawner: ProcessSpawner["Service"]) =>
  Effect.runPromise(Effect.flip(
    AgentSession.expandDiffSlice(root, [Input.gitDiff({ base: "HEAD", paths: ["src/**"] })]).pipe(
      Effect.provideService(ProcessSpawner, spawner)
    )
  ))

/** Spawns the real git process, then replaces one of its output pipes with a failing stream. */
const failingPipe = (pipe: "stdout" | "stderr", error: PlatformError.PlatformError): ProcessSpawner["Service"] => ({
  spawn: (options) =>
    ScopedProcess.spawn(options).pipe(Effect.map((handle) => ({ ...handle, [pipe]: Stream.fail(error) })))
})

describe("agent subprocess faults", () => {
  it.each(["stdout", "stderr"] as const)("fails typed when the subprocess %s cannot be read", async (pipe) => {
    const cause = new Error("pipe torn down")
    const error = await diffFailure(failingPipe(pipe, failure("read failed", cause)))
    expect(error.phase).toBe("diff")
    expect(error.message).toBe(`${pipe} could not be read: pipe torn down`)
  })

  it("reports the platform description when the spawn failure carries no native Error", async () => {
    const error = await diffFailure({ spawn: () => Effect.fail(failure("no process slot", "EAGAIN")) })
    expect(error.phase).toBe("diff")
    expect(error.message).toBe("no process slot")
  })

  it("reports the platform message when the spawn failure has neither a native Error nor a description", async () => {
    const platform = failure()
    const error = await diffFailure({ spawn: () => Effect.fail(platform) })
    expect(error.phase).toBe("diff")
    expect(error.message).toBe(platform.message)
  })
})
