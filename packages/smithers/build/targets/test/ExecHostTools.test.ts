/**
 * What a confined run is shown of the host's tools: the links a tool on
 * `PATH` is reached through, and a version manager's home under the run's
 * private one.
 *
 * The run cases use a real program standing where the mechanism would, so
 * they hold on every platform; the layouts themselves run under the real
 * mechanisms in `@smthrs/platform-node`.
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

let root: string
let outside: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-host-tools-")))
  outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-host-tools-home-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

const facts = (executable: string): ExecSandbox.Host => ({
  ...ExecSandbox.host(),
  platform: "linux",
  executable: (name) => name === "bwrap" ? executable : undefined
})

describe("host links in a plan", () => {
  it("carries the links a tool is reached through and the private links, and neither when none is asked for", () => {
    const request: ExecSandbox.Request = {
      policy: {},
      reads: [],
      writes: [],
      externalLinks: [{ path: "/opt/link", target: "/opt/real" }],
      privateLinks: [{ path: "home/.volta", target: "/home/u/.volta" }]
    }
    const location = { workspaceRoot: root, cwd: root, tmp: NodePath.join(root, ".tmp") }
    const planned = ExecSandbox.plan(request, location, facts("/usr/bin/bwrap"))
    if (planned === undefined || ExecSandbox.isUnenforceable(planned)) throw new Error("expected a plan")
    expect(planned.externalLinks).toEqual(request.externalLinks)
    expect(planned.privateLinks).toEqual(request.privateLinks)
    const plain = ExecSandbox.plan({ policy: {}, reads: [], writes: [] }, location, facts("/usr/bin/bwrap"))
    if (plain === undefined || ExecSandbox.isUnenforceable(plain)) throw new Error("expected a plan")
    expect(plain.externalLinks).toBeUndefined()
    expect(plain.privateLinks).toBeUndefined()
  })

  it("resolves the tools of a PATH the way the sandbox does", async () => {
    await Fs.mkdir(NodePath.join(outside, "tool/bin"), { recursive: true })
    await Fs.writeFile(NodePath.join(outside, "tool/bin/tool"), "#!/bin/sh\necho tool\n", { mode: 0o755 })
    const found = ExecSandbox.toolchain(NodePath.join(outside, "tool/bin"), root, ExecSandbox.host())
    expect(found.reads).toEqual([NodePath.join(outside, "tool/bin")])
    expect(found.links).toEqual([])
  })
})

describe("a confined run with private links", () => {
  it.skipIf(process.platform === "win32")(
    "finds each link under its private directory before the tool starts",
    async () => {
      // A real program standing where the mechanism would: it runs the tool after `--`.
      const mechanism = NodePath.join(outside, "bwrap")
      await Fs.writeFile(mechanism, "#!/bin/sh\nwhile [ \"$1\" != -- ]; do shift; done\nshift\nexec \"$@\"\n", {
        mode: 0o755
      })
      const volta = NodePath.join(outside, "home/.volta")
      await Fs.mkdir(volta, { recursive: true })
      await Fs.writeFile(NodePath.join(volta, "version"), "22.1.0\n")
      const exit = await Effect.runPromiseExit(
        Exec.run(
          {
            workspaceRoot: root,
            sandbox: {
              policy: {},
              reads: [],
              writes: [],
              privateLinks: [{ path: "home/.volta", target: volta }, { path: "data/mise/deep", target: volta }]
            }
          },
          {
            cwd: ".",
            argv: [
              "/bin/sh",
              "-c",
              "for run in .flows/sandbox/*; do cat \"$run/home/.volta/version\" \"$run/data/mise/deep/version\"; done"
            ],
            env: {},
            secrets: [],
            expectedExitCodes: [0],
            timeoutMs: Exec.defaultTimeoutMs
          }
        ).pipe(Effect.provideService(SandboxHost, facts(mechanism)))
      )
      expect(Exit.isSuccess(exit) && exit.value.stdout).toBe("22.1.0\n22.1.0\n")
      // The private directory, links included, is gone with the run.
      expect(NodeFs.readdirSync(NodePath.join(root, ".flows/sandbox"))).toEqual([])
    }
  )
})
