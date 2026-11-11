/** The repository host adapter uses actual pipes, files, processes and native failures. */
import { Cause, Effect, Exit } from "effect"
import { createWriteStream } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { finished } from "node:stream/promises"
import { expect, it } from "vitest"
import * as RepositoryProcess from "../src/internal/RepositoryProcess.ts"

it("writes each terminal stream through its real writable without closing caller-owned streams", async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-repository-terminal-"))
  const stdout = createWriteStream(Path.join(root, "stdout"))
  const stderr = createWriteStream(Path.join(root, "stderr"))
  try {
    const services = RepositoryProcess.make({ stdout, stderr })
    services.output("stdout", "out\n")
    services.output("stderr", "err\n")
    expect(stdout.writableEnded).toBe(false)
    expect(stderr.writableEnded).toBe(false)
    stdout.end()
    stderr.end()
    await Promise.all([finished(stdout), finished(stderr)])
    expect(await Fs.readFile(Path.join(root, "stdout"), "utf8")).toBe("out\n")
    expect(await Fs.readFile(Path.join(root, "stderr"), "utf8")).toBe("err\n")
  } finally {
    stdout.destroy()
    stderr.destroy()
    await Fs.rm(root, { recursive: true, force: true })
  }
})

it("spawns a real process and exposes its output and exit code", async () => {
  const child = await Effect.runPromise(RepositoryProcess.live.spawn(
    process.execPath,
    ["-e", "process.stdout.write(\"out\"); process.stderr.write(\"err\"); process.exitCode=7"],
    { cwd: process.cwd(), env: {} }
  ))
  const stdout: Array<Buffer> = []
  const stderr: Array<Buffer> = []
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
  await new Promise<void>((resolve) => child.once("close", () => resolve()))
  expect(Buffer.concat(stdout).toString()).toBe("out")
  expect(Buffer.concat(stderr).toString()).toBe("err")
  expect(child.exitCode).toBe(7)
})

it("preserves a synchronous native spawn rejection", async () => {
  const result = await Effect.runPromiseExit(RepositoryProcess.live.spawn("\0", [], {}))
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) {
    expect(Cause.squash(result.cause)).toMatchObject({ code: "ERR_INVALID_ARG_VALUE" })
  }
})

it.skipIf(process.platform === "win32")("signals a real detached process group and joins its pipes", async () => {
  const child = await Effect.runPromise(
    RepositoryProcess.live.spawn(process.execPath, [
      "-e",
      "require(\"node:net\").createServer().listen(0, \"127.0.0.1\", () => process.stdout.write(\"ready\"))"
    ], { detached: true, cwd: process.cwd(), env: {} })
  )
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  try {
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()))
    await Effect.runPromise(RepositoryProcess.live.killGroup(child.pid!))
    await closed
    expect(child.signalCode).toBe("SIGKILL")
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await closed
  }
})

it("preserves native rejection of a process-group id outside the host integer range", async () => {
  const result = await Effect.runPromiseExit(RepositoryProcess.live.killGroup(Number.MAX_SAFE_INTEGER))
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) {
    expect(Cause.squash(result.cause)).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" })
  }
})
