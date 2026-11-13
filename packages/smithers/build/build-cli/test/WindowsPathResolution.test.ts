/**
 * PATH resolution for a Windows host, computed from a POSIX one.
 *
 * The advisory `package suites (windows-latest)` row failed 61 of its 67
 * targets with `{"code":"spawn_failed","argv":["pnpm","exec","vitest",…],
 * "stderr":"spawn pnpm ENOENT"}`. Old-style rules build a literal argv whose
 * first element is the manager executable name, `pnpm`, and libuv's own PATH
 * walk appends only `.com` and `.exe` — deliberately, because a batch file is
 * not an executable image. pnpm installs as `pnpm.cmd`, so the walk found
 * nothing and every rule that spawns the manager died before its tool ran.
 *
 * The fix belongs to the spawn boundary, which is the one place both the
 * sentinel path (`S.PackageManager.bin` → `PackageTree.findOnPath`) and the
 * literal-argv path reach. These tests pin both halves of it. No Windows host
 * is available here, so `platform`, `PATHEXT`, and `PATH` are injected and the
 * fixture directory holds a real `pnpm.CMD`; that is the proof, and a green
 * Windows row is the confirmation.
 */
import * as Exec from "@smthrs/targets/Exec"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"

let bin: string

const comspec = "C:\\WINDOWS\\system32\\cmd.exe"

/** A Windows environment naming the fixture directory, as a runner's would. */
const windowsEnvironment = (): Record<string, string> => ({
  PATH: bin,
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: comspec
})

beforeEach(async () => {
  bin = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-winbin-")))
})

afterEach(async () => {
  await Fs.rm(bin, { recursive: true, force: true })
})

describe("windows path resolution", () => {
  it("resolves the manager to the .CMD shim libuv would never find", async () => {
    const shim = NodePath.join(bin, "pnpm.CMD")
    await Fs.writeFile(shim, "@echo off\n", { mode: 0o755 })
    expect(PackageTree.findOnPath("pnpm", windowsEnvironment(), { platform: "win32" })).toBe(shim)
    expect(PackageTree.findAllOnPath("pnpm", windowsEnvironment(), { platform: "win32" })).toEqual([shim])
  })

  /**
   * The shim is run through `ComSpec`, not handed to `spawn`: Node has refused
   * `.bat` and `.cmd` without a shell since the v18 hardening, and a shell
   * that quotes for us is a shell that decides our quoting. The line is built
   * here — every argument quoted for the CRT parser, the whole line wrapped
   * for `/s` — and passed through verbatim.
   */
  it("spawns the shim through ComSpec with the argv quoted exactly", async () => {
    const shim = NodePath.join(bin, "pnpm.CMD")
    await Fs.writeFile(shim, "@echo off\n", { mode: 0o755 })
    expect(
      Exec.spawnShape(["pnpm", "exec", "vitest", "run", "--coverage.enabled=false"], {
        platform: "win32",
        env: windowsEnvironment()
      })
    ).toEqual({
      file: comspec,
      args: ["/d", "/s", "/c", `""${shim}" "exec" "vitest" "run" "--coverage.enabled=false""`],
      windowsVerbatimArguments: true
    })
  })

  it("hands a resolved executable image straight to the host, with no shell", async () => {
    const image = NodePath.join(bin, "tsc.EXE")
    await Fs.writeFile(image, "MZ", { mode: 0o755 })
    expect(Exec.spawnShape(["tsc", "-p", "tsconfig.json"], { platform: "win32", env: windowsEnvironment() }))
      .toEqual({ file: image, args: ["-p", "tsconfig.json"], windowsVerbatimArguments: false })
  })

  /**
   * POSIX must be byte-identical to what it was before Windows was in the
   * matrix: one candidate name matched exactly, no `PATHEXT`, no folding, and
   * `argv[0]` spawned as declared.
   */
  it("leaves POSIX exactly as it was", async () => {
    const shim = NodePath.join(bin, "pnpm.CMD")
    await Fs.writeFile(shim, "#!/bin/sh\n", { mode: 0o755 })
    const environment = windowsEnvironment()
    expect(PackageTree.findOnPath("pnpm", environment, { platform: "linux" })).toBeUndefined()
    expect(PackageTree.findOnPath("pnpm.CMD", environment, { platform: "linux" })).toBe(shim)
    expect(PackageTree.findAllOnPath("pnpm", environment, { platform: "darwin" })).toEqual([])
    expect(Exec.spawnShape(["pnpm", "exec", "vitest"], { platform: "linux", env: environment }))
      .toEqual({ file: "pnpm", args: ["exec", "vitest"], windowsVerbatimArguments: false })
  })

  it("keeps the ambient-platform default, which is this host's own answer", async () => {
    const tool = NodePath.join(bin, "host-tool")
    await Fs.writeFile(tool, "#!/bin/sh\n", { mode: 0o755 })
    const expected = process.platform === "win32" ? undefined : tool
    expect(PackageTree.findOnPath("host-tool", { PATH: bin })).toBe(expected)
    expect(PackageTree.findOnPath("host-tool", { PATH: bin }, {})).toBe(expected)
  })

  /**
   * A resolved shim becomes probe input as well as spawn input, so the probe
   * goes through the same shape. This asserts the ordinary interpreter probe
   * is untouched by that; the shim branch is the Windows answer above.
   */
  /**
   * The probe runs a resolved shim through `ComSpec` exactly as the spawn
   * would. A POSIX script stands in for `cmd.exe` and echoes the line it got.
   */
  it.runIf(process.platform !== "win32")("probes a Windows shim through ComSpec", async () => {
    const shim = NodePath.join(bin, "tool.cmd")
    const shell = NodePath.join(bin, "cmd.sh")
    await Fs.writeFile(shim, "#!/bin/sh\nprintf direct\n", { mode: 0o755 })
    await Fs.writeFile(shell, "#!/bin/sh\nprintf '%s|' \"$@\"\n", { mode: 0o755 })
    const environment = { ...windowsEnvironment(), ComSpec: shell }
    expect(await PackageTree.probeCommand(shim, ["--version"], { environment, platform: "win32" })).toEqual({
      exitCode: 0,
      output: `/d|/s|/c|""${shim}" "--version""|`
    })
    expect(await PackageTree.probeCommand(shim, ["--version"], { environment, platform: "linux" })).toEqual({
      exitCode: 0,
      output: "direct"
    })
  })

  it("still probes an ordinary executable through the unchanged path", async () => {
    const probe = await PackageTree.probeCommand(process.execPath, ["-e", "process.stdout.write('ok')"])
    expect(probe).toEqual({ exitCode: 0, output: "ok" })
  })
})

it("plans the Windows POSIX shell as a measured host executable", async () => {
  await Fs.writeFile(
    NodePath.join(bin, "WORKSPACE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("windows-shell", {
  repository: "git+https://example.invalid/windows-shell.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: S.file("//package.json"), lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})`
  )
  await Fs.writeFile(
    NodePath.join(bin, "PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  check: S.Shell.Test({ shell: "printf portable" })
} })`
  )
  const shell = NodePath.join(bin, "sh.exe")
  await Fs.writeFile(NodePath.join(bin, "package.json"), "{}")
  await Fs.writeFile(NodePath.join(bin, "yarn.lock"), "")
  await Fs.copyFile(process.execPath, shell)
  const loaded = await PackageLoader.load(await PackageDiscovery.discover(bin))
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" })
    const options = {
      index: PackageIndex.make(loaded),
      cacheDirectory: ".flows",
      verb: "test" as const,
      patterns: ["//:check"],
      plan: true as const,
      environment: { ...process.env, PATH: bin, PATHEXT: ".EXE" }
    }
    const plan = await PackageExec.plan(options)
    const node = plan.nodes.get("//:check")!
    expect(node.refusal).toBeUndefined()
    expect(node.argv).toEqual([shell, "-c", "printf portable"])
    expect(JSON.stringify(node.keyMaterial)).toContain(
      createHash("sha256").update(await Fs.readFile(shell)).digest("hex")
    )
    await Fs.rm(shell)
    const absent = await PackageExec.plan(options)
    expect(absent.nodes.get("//:check")!.refusal).toMatch(/sh.*not present on PATH/)
  } finally {
    Object.defineProperty(process, "platform", platform)
  }
})
