/**
 * A run nothing confines that still cannot write the paths its request
 * protects.
 *
 * The argv cases use host facts with a real stand-in program for the
 * mechanism, so they hold on every platform. The enforcement cases start the
 * host's own bubblewrap and run on Linux hosts that let it start.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as ExecSandbox from "../src/ExecSandbox.ts"
import { SandboxHost } from "../src/internal/SandboxHost.ts"
import { Sandbox } from "../src/WorkspaceDeclaration.ts"

let root: string
let outside: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-protect-")))
  outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-protect-tools-")))
  await Fs.mkdir(NodePath.join(root, "node_modules", "tool"), { recursive: true })
  await Fs.writeFile(NodePath.join(root, "node_modules", "tool", "program"), "bytes\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

const payload = (script: string): Exec.Payload => ({
  cwd: ".",
  argv: ["/bin/sh", "-c", script],
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: Exec.defaultTimeoutMs
})

const unconfined = (writeProtected?: ReadonlyArray<string>): ExecSandbox.Request => ({
  policy: "none",
  reads: [],
  writes: [],
  ...(writeProtected === undefined ? {} : { writeProtected })
})

const run = (request: ExecSandbox.Request, script: string, hostFacts?: ExecSandbox.Host) =>
  Effect.runPromiseExit(
    Exec.run({ workspaceRoot: root, sandbox: request }, payload(script)).pipe(
      Effect.provideService(SandboxHost, hostFacts)
    )
  )

const failure = (exit: Exit.Exit<Exec.Result, Exec.ExecError>): Exec.ExecError => {
  if (Exit.isSuccess(exit)) throw new Error("expected an exec failure")
  const parsed = JSON.parse(JSON.stringify(exit.cause)) as {
    readonly reasons: ReadonlyArray<{ readonly error: Exec.ExecError }>
  }
  return parsed.reasons[0]!.error
}

const linux = (executable: string | undefined): ExecSandbox.Host => ({
  ...ExecSandbox.host(),
  platform: "linux",
  executable: (name) => name === "bwrap" ? executable : undefined
})

describe("the argv of a protected run", () => {
  const argv = ["tool", "check"]

  it("is the tool's own when the request protects nothing", () => {
    expect(ExecSandbox.protect(unconfined(), "/ws", argv, linux("/usr/bin/bwrap"))).toBe(argv)
    expect(ExecSandbox.protect(unconfined([]), "/ws", argv, linux("/usr/bin/bwrap"))).toBe(argv)
  })

  it("drops a path that leaves the workspace", () => {
    expect(ExecSandbox.protect(unconfined(["../other", "."]), "/ws", argv, linux("/usr/bin/bwrap"))).toBe(argv)
  })

  it("is the tool's own on a host with no mechanism", () => {
    expect(ExecSandbox.protect(unconfined(["node_modules/tool"]), root, argv, linux(undefined))).toBe(argv)
  })

  it("binds each protected workspace path read-only over the host as it is", () => {
    expect(ExecSandbox.protect(unconfined(["node_modules/tool"]), root + NodePath.sep, argv, linux("/usr/bin/bwrap")))
      .toEqual([
        "/usr/bin/bwrap",
        "--dev-bind",
        "/",
        "/",
        "--ro-bind",
        NodePath.join(root, "node_modules", "tool"),
        NodePath.join(root, "node_modules", "tool"),
        ...(process.getuid?.() === 0 ? ["--cap-add", "ALL"] : []),
        "--die-with-parent",
        "--",
        ...argv
      ])
  })
})

describe("an unconfined run with protected paths", () => {
  /** A real program standing where the mechanism would: it records its arguments and runs the tool after `--`. */
  const standIn = async (): Promise<{ readonly facts: ExecSandbox.Host; readonly seen: () => string }> => {
    const file = NodePath.join(outside, "bwrap")
    const record = NodePath.join(outside, "seen.txt")
    await Fs.writeFile(
      file,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
      { mode: 0o755 }
    )
    return { facts: linux(file), seen: () => NodeFs.readFileSync(record, "utf8") }
  }

  it.skipIf(process.platform === "win32")(
    "starts the tool through the mechanism, with each path protected",
    async () => {
      const { facts, seen } = await standIn()
      const exit = await run(unconfined(["node_modules/tool", "node_modules/absent"]), "echo ran", facts)
      expect(Exit.isSuccess(exit) && exit.value.stdout).toBe("ran\n")
      expect(seen()).toContain(`--ro-bind\n${NodePath.join(root, "node_modules", "tool")}\n`)
      expect(seen()).not.toContain("absent")
      expect(seen()).toContain("--\n/bin/sh\n-c\necho ran\n")
    }
  )

  it.skipIf(process.platform === "win32")("reports the tool's own argv when the run fails", async () => {
    const { facts } = await standIn()
    const error = failure(await run(unconfined(["node_modules/tool"]), "echo no >&2; exit 3", facts))
    expect(error.code).toBe("exit_status")
    expect(error.exitCode).toBe(3)
    expect(error.argv).toEqual(["/bin/sh", "-c", "echo no >&2; exit 3"])
    expect(error.stderr).toContain("no")
  })

  it.skipIf(process.platform === "win32")("runs the tool directly when the request protects nothing", async () => {
    const { facts, seen } = await standIn()
    const exit = await run(unconfined(), "echo ran", facts)
    expect(Exit.isSuccess(exit) && exit.value.stdout).toBe("ran\n")
    expect(() => seen()).toThrow()
    // A workspace that declared no mechanism and a target that opted out are the same run.
    const declared = await run({ ...unconfined(), policy: undefined, mechanism: Sandbox.None() }, "echo ran", facts)
    expect(Exit.isSuccess(declared)).toBe(true)
  })

  const enforced = ExecSandbox.writeProtectionRefusal(ExecSandbox.host()) === undefined

  it.skipIf(!enforced)("cannot write below a protected path, and writes everywhere else as before", async () => {
    const script =
      "echo beside > beside.txt && mkdir -p node_modules/.cache && echo state > node_modules/.cache/state" +
      " && cat node_modules/tool/program && echo link > node_modules/tool/native"
    const error = failure(await run(unconfined(["node_modules/tool"]), script))
    expect(error.stderr).toContain("Read-only file system")
    expect(error.argv).toEqual(["/bin/sh", "-c", script])
    expect(NodeFs.existsSync(NodePath.join(root, "node_modules", "tool", "native"))).toBe(false)
    expect(await Fs.readFile(NodePath.join(root, "beside.txt"), "utf8")).toBe("beside\n")
    expect(await Fs.readFile(NodePath.join(root, "node_modules", ".cache", "state"), "utf8")).toBe("state\n")
    // Unprotected, the same write lands.
    expect(Exit.isSuccess(await run(unconfined(), "echo link > node_modules/tool/native"))).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "node_modules", "tool", "native"), "utf8")).toBe("link\n")
  })
})
