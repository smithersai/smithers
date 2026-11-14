import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as PlatformError from "effect/PlatformError"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import { Process } from "../src/internal/Process.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "exec-teardown-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const payload = (script: string): Exec.Payload => ({
  cwd: ".",
  argv: ["/bin/sh", "-c", script],
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: 60_000
})

/** The supervisor's teardown failure, as its scope finalizer dies with it. */
const teardownFault = (code: string, description: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "kill",
    pathOrDescriptor: "/bin/sh",
    description,
    cause: { code, message: description }
  })

/**
 * The real supervisor, whose scope close then dies with `fault`, as the
 * supervisor's finalizer does when a stalled host keeps the finished process's
 * owner from exiting within its bound. The real cleanup still runs after it.
 */
const stalledTeardown = (fault: PlatformError.PlatformError) => ({
  spawn: (options: ScopedProcess.Options) =>
    ScopedProcess.spawn(options).pipe(Effect.tap(() => Effect.addFinalizer(() => Effect.die(fault)))),
  status: ScopedProcess.status
})

const run = (service: ReturnType<typeof stalledTeardown>, script: string, observed: Array<string> = []) =>
  Effect.runPromiseExit(
    Exec.run({
      workspaceRoot: root,
      onStderr: (chunk) => observed.push(Buffer.from(chunk).toString("utf8"))
    }, payload(script)).pipe(Effect.provideService(Process, service))
  )

const killTimedOut = teardownFault("supervisor_timeout", "Process supervisor kill timed out")

describe.skipIf(process.platform === "win32")("a teardown that times out after the tool exited", () => {
  it("keeps the exit status 0 result and says the cleanup was not confirmed", async () => {
    const observed: Array<string> = []
    const exit = await run(stalledTeardown(killTimedOut), "echo ok", observed)
    expect(Exit.isSuccess(exit), String(Exit.isFailure(exit) && exit.cause)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.exitCode).toBe(0)
      expect(exit.value.stdout).toBe("ok\n")
    }
    expect(observed.join("")).toContain(
      "smthrs: the tool exited with status 0, but the machine was too busy to confirm its process cleanup " +
        "in time; the result stands (Unknown: ChildProcess.kill (/bin/sh): Process supervisor kill timed out)"
    )
  })

  it("reports a nonzero exit status as the tool's failure, not as the teardown timeout", async () => {
    const exit = await run(stalledTeardown(killTimedOut), "echo broken >&2; exit 3")
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      expect(failure?._tag === "Fail" && failure.error.code).toBe("exit_status")
      expect(failure?._tag === "Fail" && failure.error.exitCode).toBe(3)
      expect(exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(false)
    }
  })

  it("still fails when the supervisor could not verify the process group was stopped", async () => {
    const unverified = teardownFault(
      "cleanup_unverified",
      "Process cleanup could not be verified; its ledger record is retained (group members: 4242 live)"
    )
    const exit = await run(stalledTeardown(unverified), "echo ok")
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
      expect(defect?._tag === "Die" && defect.defect).toBe(unverified)
    }
  })
})
