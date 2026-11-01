/**
 * Stable codes on the failures a caller has to tell apart: a spawn that never
 * started, a budget that ran out, a child that was signalled, a tool that
 * exited non-zero, and a generated file that could not be read at all.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as CiToolchain from "../src/CiToolchain.ts"
import * as Exec from "../src/Exec.ts"
import * as GeneratedFile from "../src/GeneratedFile.ts"

let root: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-codes-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const failureOf = async (value: Exec.Payload): Promise<Exec.ExecError> => {
  const exit = await Effect.runPromiseExit(Exec.run({ workspaceRoot: root }, value))
  if (Exit.isSuccess(exit)) throw new Error("expected the run to fail")
  const rendered = JSON.stringify(exit.cause)
  // Effect 4.1 renders a cause as its reasons, each tagged; a failure is `Fail`.
  const parsed = JSON.parse(rendered) as {
    readonly reasons?: ReadonlyArray<{ readonly _tag: string; readonly error?: Exec.ExecError }>
  }
  const error = parsed.reasons?.find((reason) => reason._tag === "Fail")?.error
  if (error === undefined) throw new Error(`expected an ExecError: ${rendered}`)
  return error
}

const payload = (overrides: Partial<Exec.Payload>): Exec.Payload => ({
  argv: [process.execPath, "-e", ""],
  cwd: ".",
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: 30_000,
  ...overrides
} as Exec.Payload)

describe("Exec failure codes", () => {
  it("reports invalid_payload for a payload the action refuses", async () => {
    const error = await failureOf(payload({ cwd: "../outside" }))
    expect(error.code).toBe("invalid_payload")
  })

  it("reports spawn_failed for an executable that is not there", async () => {
    const error = await failureOf(payload({ argv: [NodePath.join(root, "no-such-tool")] }))
    expect(error.code).toBe("spawn_failed")
  })

  /**
   * `spawn <name> ENOENT` names the command for two different faults: an
   * executable that is not on PATH, and a working directory that does not
   * exist. A reader who trusts the message chases the wrong one, and this
   * cost a full day of CI investigation on exactly that mistake.
   *
   * The case above covers the executable. This covers the directory, and
   * asserts the message says so, because the two are indistinguishable
   * otherwise.
   */
  it("says so when the working directory, not the executable, is missing", async () => {
    const error = await failureOf(payload({
      argv: [process.execPath, "-e", ""],
      cwd: "no-such-directory"
    }))
    expect(error.code).toBe("spawn_failed")
    expect(error.stderr).toContain("does not exist")
    expect(error.stderr).toContain("no-such-directory")
  })

  it("reports timed_out with the budget named", async () => {
    const error = await failureOf(payload({
      argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 50
    }))
    expect(error.code).toBe("timed_out")
    expect(error.stderr).toContain("timed out")
  })

  it("reports signaled with the signal as its own field", async () => {
    const error = await failureOf(payload({
      argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 5000)"]
    }))
    if (process.platform === "win32") {
      expect(error.code).toBe("exit_status")
      expect(error.exitCode).toBe(1)
      expect(error.signal).toBeUndefined()
    } else {
      expect(error.code).toBe("signaled")
      expect(error.signal).toBe("SIGKILL")
    }
  })

  it("reports exit_status with the real exit code for a tool that ran and failed", async () => {
    const error = await failureOf(payload({ argv: [process.execPath, "-e", "process.exit(3)"] }))
    expect(error.code).toBe("exit_status")
    expect(error.exitCode).toBe(3)
  })

  // The codes above are only worth switching on if the schema refuses the
  // reasonless value. While `code` was optional, the exported type still
  // admitted the untyped failure these codes exist to eliminate, so an
  // encoder outside this package could produce one.
  it("refuses an exec failure that names no code", () => {
    const withoutCode = {
      _tag: "smithers-build/ExecError",
      argv: ["tool"],
      cwd: ".",
      exitCode: -1,
      stdout: "",
      stderr: "it failed"
    }
    expect(() => Schema.decodeUnknownSync(Exec.ExecError)(withoutCode)).toThrow()
    expect(Schema.decodeUnknownSync(Exec.ExecError)({ ...withoutCode, code: "spawn_failed" }).code)
      .toBe("spawn_failed")
  })

  it("refuses an exec failure whose code is not one of the closed set", () => {
    expect(() =>
      Schema.decodeUnknownSync(Exec.ExecError)({
        _tag: "smithers-build/ExecError",
        argv: ["tool"],
        cwd: ".",
        exitCode: -1,
        stdout: "",
        stderr: "it failed",
        code: "something_else"
      })
    ).toThrow()
  })
})

const driftOf = (exit: Exit.Exit<unknown, GeneratedFile.DriftError>): GeneratedFile.DriftError => {
  if (Exit.isSuccess(exit)) throw new Error("expected the check to fail")
  const rendered = JSON.stringify(exit.cause)
  // Effect 4.1 renders a cause as its reasons, each tagged; a failure is `Fail`.
  const parsed = JSON.parse(rendered) as {
    readonly reasons?: ReadonlyArray<{ readonly _tag: string; readonly error?: GeneratedFile.DriftError }>
    readonly error?: GeneratedFile.DriftError
  }
  const error = parsed.reasons?.find((reason) => reason._tag === "Fail")?.error ?? parsed.error
  if (error === undefined) throw new Error(`expected a DriftError: ${rendered}`)
  return error
}

describe("generated-file check reasons", () => {
  const contents = "generated\n"

  it("reports missing for a file that is not there and drifted for one that changed", async () => {
    const missing = await Effect.runPromiseExit(
      GeneratedFile.checkGeneratedFile(root, { path: "out.txt", contents })
    )
    expect(Exit.isFailure(missing)).toBe(true)
    expect(driftOf(missing).reason).toBe("missing")

    await Fs.writeFile(NodePath.join(root, "out.txt"), "something else\n")
    const drifted = await Effect.runPromiseExit(
      GeneratedFile.checkGeneratedFile(root, { path: "out.txt", contents })
    )
    expect(driftOf(drifted).reason).toBe("drifted")
  })

  it("reports unreadable rather than drift for a symbolic link standing in for the file", async () => {
    await Fs.writeFile(NodePath.join(root, "real.txt"), contents)
    await Fs.symlink(NodePath.join(root, "real.txt"), NodePath.join(root, "out.txt"))
    const exit = await Effect.runPromiseExit(
      GeneratedFile.checkGeneratedFile(root, { path: "out.txt", contents })
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = driftOf(exit)
    expect(error.reason).toBe("unreadable")
    expect(error.message).toContain("could not be read")
  })

  it("passes a file that matches", async () => {
    await Fs.writeFile(NodePath.join(root, "out.txt"), contents)
    const exit = await Effect.runPromiseExit(
      GeneratedFile.checkGeneratedFile(root, { path: "out.txt", contents })
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  // Same closure as the exec codes: the discriminator is only load-bearing
  // while no drift failure can omit it, and the shared constructor is the
  // path every other module reaches this error through.
  it("refuses a drift failure that names no reason", () => {
    const withoutReason = {
      _tag: "smithers-build/DriftError",
      path: "out.txt",
      message: "the generated file is missing"
    }
    expect(() => Schema.decodeUnknownSync(GeneratedFile.DriftError)(withoutReason)).toThrow()
    expect(Schema.decodeUnknownSync(GeneratedFile.DriftError)({ ...withoutReason, reason: "missing" }).reason)
      .toBe("missing")
  })

  it("makes the shared constructor name a reason", () => {
    expect(GeneratedFile.driftError("out.txt", "the generator rewrote it", "drifted").reason).toBe("drifted")
    expect(GeneratedFile.driftError("out.txt", "it could not be read", "unreadable").reason).toBe("unreadable")
  })
})

describe("CiToolchain executable validation", () => {
  it.each(["*", "?", "[a-z]", "-rf", "a b", "a'b", "a\"b", "a;b", "a$b"])(
    "refuses %s as a browser executable",
    (executable) => {
      expect(() => CiToolchain.Browser({ executable, reason: "the runner image ships it" }))
        .toThrow(/is not a usable browser executable/)
    }
  )

  it("still accepts an ordinary absolute path", () => {
    expect(
      CiToolchain.Browser({ executable: "/usr/bin/google-chrome", reason: "the runner image ships it" }).executable
    )
      .toBe("/usr/bin/google-chrome")
  })

  it("keeps the permissive shape for artifact globs", () => {
    expect(CiToolchain.validatePath("/tmp/shot-*.png", "artifact source")).toBe("/tmp/shot-*.png")
    expect(() => CiToolchain.validateExecutable("/tmp/shot-*.png", "browser executable")).toThrow()
  })
})
