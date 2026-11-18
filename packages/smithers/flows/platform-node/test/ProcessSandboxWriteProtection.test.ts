/**
 * Write protection: a run that keeps the whole host and cannot write the
 * paths it is told to hold still.
 *
 * Fake host facts check the argv on any platform. The enforcement cases start
 * the host's own bubblewrap, so they run on Linux hosts that let it start.
 */
import { spawnSync } from "node:child_process"
import NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const temporary: Array<string> = []
afterEach(() => {
  for (const directory of temporary.splice(0)) NodeFs.rmSync(directory, { recursive: true, force: true })
})

const scratch = (): string => {
  const parent = process.env.SMITHERS_TEST_SCRATCH ?? NodeOs.tmpdir()
  NodeFs.mkdirSync(parent, { recursive: true })
  const directory = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(parent, "smthrs-write-protection-")))
  temporary.push(directory)
  return directory
}

/** A Linux host that has bubblewrap and every path but the ones under `/missing`. */
const linux: ProcessSandbox.Host = {
  platform: "linux",
  executable: (name) => `/usr/bin/${name}`,
  exists: (path) => !path.startsWith("/missing"),
  isDirectory: () => true,
  uid: 1000,
  gid: 1000
}

/** A real program at a new path that prints `stderr` and exits with `code`. */
const program = (stderr: string, code: number): string => {
  const file = NodePath.join(scratch(), "bwrap")
  NodeFs.writeFileSync(file, `#!/bin/sh\nprintf '%s' '${stderr}' >&2\nexit ${code}\n`, { mode: 0o755 })
  return file
}

describe("the write-protected argv", () => {
  it("binds the host as it is, then each existing path read-only over itself", () => {
    expect(
      ProcessSandbox.writeProtected(["/ws/node_modules/.pnpm", "/missing/tree", "/ws/pkg/tool"], ["tool", "x"], linux)
    )
      .toEqual([
        "/usr/bin/bwrap",
        "--dev-bind",
        "/",
        "/",
        "--ro-bind",
        "/ws/pkg/tool",
        "/ws/pkg/tool",
        "--ro-bind",
        "/ws/node_modules/.pnpm",
        "/ws/node_modules/.pnpm",
        "--die-with-parent",
        "--",
        "tool",
        "x"
      ])
  })

  it("binds a path once when another protected path holds it", () => {
    const argv = ProcessSandbox.writeProtected(["/ws/tree/unit", "/ws/tree"], ["tool"], linux)!
    expect(argv.filter((argument) => argument === "--ro-bind").length).toBe(1)
    expect(argv).toContain("/ws/tree")
    expect(argv).not.toContain("/ws/tree/unit")
  })

  it("asks for no namespace beyond the mounts and sets no environment: network and processes are the host's", () => {
    const argv = ProcessSandbox.writeProtected(["/ws/tree"], ["tool"], linux)!
    expect(argv.some((argument) => argument.startsWith("--unshare") || argument === "--setenv")).toBe(false)
    expect(argv).not.toContain("--tmpfs")
  })

  it("keeps a root caller's capabilities, which bubblewrap would otherwise drop", () => {
    const argv = ProcessSandbox.writeProtected(["/ws/tree"], ["tool"], { ...linux, uid: 0 })!
    expect(argv.slice(argv.indexOf("--cap-add"), argv.indexOf("--cap-add") + 2)).toEqual(["--cap-add", "ALL"])
    expect(ProcessSandbox.writeProtected(["/ws/tree"], ["tool"], linux)).not.toContain("--cap-add")
  })

  it("answers nothing on a host with no mechanism", () => {
    expect(ProcessSandbox.writeProtected(["/ws/tree"], ["tool"], { ...linux, platform: "darwin" })).toBeUndefined()
    expect(ProcessSandbox.writeProtected(["/ws/tree"], ["tool"], { ...linux, executable: () => undefined }))
      .toBeUndefined()
  })
})

describe("why a host cannot write-protect", () => {
  it("names the platform when it is not Linux", () => {
    expect(ProcessSandbox.writeProtectionRefusal({ ...linux, platform: "darwin" })).toBe(
      "write protection needs bubblewrap, which runs only on Linux; this host is darwin"
    )
  })

  it("names the missing program", () => {
    expect(ProcessSandbox.writeProtectionRefusal({ ...linux, executable: () => undefined })).toBe(
      "write protection needs bubblewrap, and bwrap is not on PATH (install the bubblewrap package)"
    )
  })

  it("answers nothing once the program starts", () => {
    const executable = program("", 0)
    expect(ProcessSandbox.writeProtectionRefusal({ ...linux, executable: () => executable })).toBeUndefined()
  })

  it("answers the program's own first line when it refuses to start", () => {
    const executable = program("bwrap: setting up uid map: Permission denied\nsecond line", 1)
    expect(ProcessSandbox.writeProtectionRefusal({ ...linux, executable: () => executable })).toBe(
      "bubblewrap could not start on this host: bwrap: setting up uid map: Permission denied"
    )
  })

  it("answers the host's error when the program cannot be run at all", () => {
    const executable = NodePath.join(scratch(), "bwrap")
    expect(ProcessSandbox.writeProtectionRefusal({ ...linux, executable: () => executable })).toMatch(
      /^bubblewrap could not start on this host: .*ENOENT/
    )
  })
})

const real = ProcessSandbox.host()
const enforced = ProcessSandbox.writeProtectionRefusal(real) === undefined

describe.skipIf(!enforced)("a write-protected run on this host", () => {
  const run = (paths: ReadonlyArray<string>, cwd: string, script: string, env: NodeJS.ProcessEnv = process.env) => {
    const [command, ...args] = ProcessSandbox.writeProtected(paths, ["/bin/sh", "-c", script], real)!
    return spawnSync(command!, args, { cwd, env, encoding: "utf8" })
  }

  it("refuses a write below a protected path and lets every other write reach the host", () => {
    const base = scratch()
    NodeFs.mkdirSync(NodePath.join(base, "tree", "unit"), { recursive: true })
    NodeFs.writeFileSync(NodePath.join(base, "tree", "unit", "program"), "bytes\n")
    NodeFs.mkdirSync(NodePath.join(base, "tree", ".state"))
    const outcome = run(
      [NodePath.join(base, "tree", "unit")],
      base,
      "echo side > tree/.state/cache && echo out > beside.txt && cat tree/unit/program && echo link > tree/unit/native"
    )
    expect(outcome.status).not.toBe(0)
    expect(outcome.stdout).toBe("bytes\n")
    expect(outcome.stderr).toContain("Read-only file system")
    expect(NodeFs.existsSync(NodePath.join(base, "tree", "unit", "native"))).toBe(false)
    // A tool's own state beside the protected unit, and a file in the workspace, are written as before.
    expect(NodeFs.readFileSync(NodePath.join(base, "tree", ".state", "cache"), "utf8")).toBe("side\n")
    expect(NodeFs.readFileSync(NodePath.join(base, "beside.txt"), "utf8")).toBe("out\n")
  })

  it("refuses a hard link, a rename and a removal inside a protected path", () => {
    const base = scratch()
    NodeFs.mkdirSync(NodePath.join(base, "unit"))
    NodeFs.writeFileSync(NodePath.join(base, "unit", "program"), "bytes\n")
    // The link is between two names in the protected path, so only its read-only mount can refuse it.
    for (const script of ["ln unit/program unit/native", "mv unit/program unit/renamed", "rm unit/program"]) {
      const outcome = run([NodePath.join(base, "unit")], base, script)
      expect(outcome.status).not.toBe(0)
      expect(outcome.stderr).toContain("Read-only file system")
    }
    expect(NodeFs.readdirSync(NodePath.join(base, "unit"))).toEqual(["program"])
  })

  it("makes each protected path a mount of its own, so a hard link out of it is a cross-device link", () => {
    const base = scratch()
    NodeFs.mkdirSync(NodePath.join(base, "unit"))
    NodeFs.writeFileSync(NodePath.join(base, "unit", "program"), "bytes\n")
    const outcome = run([NodePath.join(base, "unit")], base, "ln unit/program copy")
    expect(outcome.status).not.toBe(0)
    expect(outcome.stderr).toContain("cross-device link")
    // Unwrapped, the same link is made.
    expect(spawnSync("/bin/sh", ["-c", "ln unit/program copy"], { cwd: base }).status).toBe(0)
  })

  it("sets no_new_privs, which an unwrapped run does not have", () => {
    const base = scratch()
    const flag = (text: string): string | undefined => /NoNewPrivs:\s*(\d)/.exec(text)?.[1]
    expect(flag(run([base], base, "cat /proc/self/status").stdout)).toBe("1")
  })

  it("keeps the working directory, the environment and the exit status of the program", () => {
    const base = scratch()
    const outcome = run([base], base, "pwd && printf '%s\\n' \"$HOME\" \"$MARK\" && exit 7", {
      ...process.env,
      MARK: "kept"
    })
    expect(outcome.status).toBe(7)
    expect(outcome.stdout).toBe(`${base}\n${process.env["HOME"]}\nkept\n`)
  })
})
