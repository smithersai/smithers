/**
 * Package-mode execution of the resolver, bundler, and service lanes through
 * the real CLI against real processes:
 *
 * - services: a consumer acquires its Serve target (readiness gated), runs
 *   raced against the service's health, and releases it on success, on
 *   failure, and on a readiness timeout; a Serve root runs foreground until
 *   interrupted; Serve targets are never scheduled as ordinary nodes.
 * - closure keying: a Shell.Test keyed on an ImportClosure re-keys when a
 *   file inside the closure changes and stays a hit when a file outside it
 *   changes; S.Test over Files.difference reports the leftover set, caches
 *   its verdict, and fails closed on a dynamic import.
 * - bundler: resolve and build through the workspace's own rsbuild, the
 *   build keyed on the resolved graph digest (a universe edit that leaves
 *   the graph unchanged replays the build). The dispatched workspace links
 *   in this package's own `@rsbuild/core` devDependency, so the lane runs
 *   on a clean checkout.
 */
import * as Reference from "@smthrs/targets/Reference"
import * as Effect from "effect/Effect"
import * as NodeChildProcess from "node:child_process"
import { existsSync } from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import { createRequire } from "node:module"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import type * as AgentSession from "../src/AgentSession.ts"
import { graphKeySentinel, keyMaterialWithGraph } from "../src/PackageExec.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const fixtureServer = NodePath.resolve(import.meta.dirname, "fixtures/service-supervisor/server.mjs")
const rsbuildFixture = NodePath.resolve(import.meta.dirname, "fixtures/rsbuild-mini")

const workspaceModule = (): string =>
  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const commitAll = (root: string): void => {
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
}

const temporaryWorkspace = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-lane-exec-"))))

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no port assigned")))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })

const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port })
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => resolve(false))
  })

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`)
}

/** A failed `pgrep`: a spawn errno, a signal, or an unexpected exit status. */
type ProbeFailure = Error & {
  readonly status?: number | null | undefined
  readonly signal?: NodeJS.Signals | null | undefined
}

/**
 * Pids of live processes whose command line carries the marker.
 *
 * pgrep exits 0 having named matches and 1 having found none. Every other
 * outcome — a missing binary, a signal, an unexpected status — is a failed
 * inspection, and answering it with "no matches" would let a teardown
 * assertion pass while the service is still running, so it throws instead.
 */
const probeProcesses = (command: string, marker: string): Array<number> => {
  try {
    return NodeChildProcess.execFileSync(command, ["-f", marker], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(Number)
  } catch (error) {
    const failure = error as ProbeFailure
    if (failure.status === 1 && (failure.signal === null || failure.signal === undefined)) return []
    throw new Error(`${command} -f ${marker} could not inspect processes`, { cause: error })
  }
}

const pgrep = (marker: string): Array<number> => probeProcesses("pgrep", marker)

/**
 * A process the marker probe must be able to see, alive for the whole file.
 *
 * An absence assertion with no positive observation cannot tell a service
 * that was torn down from a probe that matches nothing at all, so every
 * teardown check re-proves the probe against this control.
 */
const probeControlMarker = `lane-exec-probe-control-${process.pid}-${Math.random().toString(36).slice(2)}`
let probeControl: NodeChildProcess.ChildProcess | undefined

beforeAll(async () => {
  probeControl = NodeChildProcess.spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", probeControlMarker],
    { stdio: "ignore" }
  )
  await waitFor(async () => pgrep(probeControlMarker).length > 0, 30_000)
})

afterAll(() => {
  probeControl?.kill("SIGKILL")
})

/** Asserts the marker names no process, with the probe proven live. */
const expectNoProcesses = (marker: string): void => {
  expect(pgrep(marker)).toHaveLength(0)
  expect(pgrep(probeControlMarker)).not.toHaveLength(0)
}

/** Waits for the marker to name no process, with the probe proven live after. */
const waitForNoProcesses = async (marker: string, timeoutMs: number): Promise<void> => {
  await waitFor(async () => pgrep(marker).length === 0, timeoutMs)
  expect(pgrep(probeControlMarker)).not.toHaveLength(0)
}

const marker = (): string => `lane-exec-${process.pid}-${Math.random().toString(36).slice(2)}`

/** A node one-liner that GETs one URL and exits 0 on a 2xx answer. */
const probeCommand = (url: string): string =>
  `${process.execPath} -e "fetch('${url}').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"`

/** A fixture-server Serve declaration; `extra` joins the server's argv. */
const serveDeclaration = (port: number, mark: string, extra: string, probes: string): string =>
  `S.Shell.Serve({
  shell: ${JSON.stringify(`${process.execPath} ${fixtureServer} --port ${port} --marker ${mark} ${extra}`)},
  ${probes}
})`

describe("services edge", () => {
  it("refuses a service consumer that did not explicitly declare its network posture", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${serveDeclaration(port, mark, "", `readiness: { port: ${port} }`)}
const probe = S.Shell.Test({ shell: "true", services: [svc] })
export const Package = S.Package({ targets: { svc, probe } })
`
    )
    commitAll(root)
    const { exitCode, output } = await serve(root, ["//:probe", "--plan"])
    expect(exitCode).toBe(0)
    expect(output).toContain("services require an explicit sandbox network declaration")
    expectNoProcesses(mark)
  })

  it("accepts an explicit unsandboxed service consumer", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${serveDeclaration(port, mark, "", `readiness: { port: ${port} }`)}
const probe = S.Shell.Test({ shell: "true", services: [svc], sandbox: "none" })
export const Package = S.Package({ targets: { svc, probe } })
`
    )
    commitAll(root)
    const { exitCode, output } = await serve(root, ["//:probe", "--plan"])
    expect(exitCode).toBe(0)
    expect(output).not.toContain("services require an explicit sandbox network declaration")
    expect(output).not.toContain("refusal:")
    expectNoProcesses(mark)
  })

  it("acquires the service before the consumer, gates on readiness, and releases it after success", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${serveDeclaration(port, mark, "--delay-listen 500", `readiness: { port: ${port} }`)}
const probe = S.Shell.Test({ shell: ${
        JSON.stringify(probeCommand(`http://127.0.0.1:${port}/health`))
      }, services: [svc], sandbox: { network: true } })
export const Package = S.Package({ targets: { svc, probe } })
`
    )
    commitAll(root)
    const started = Date.now()
    const { exitCode, logs } = await serve(root, ["//:probe"])
    expect(logs).toContain("//:probe  service //:svc: ready")
    expect(logs).toContain("//:probe  ran")
    expect(exitCode).toBe(0)
    // The server delayed listen by 500ms; the probe only passed because
    // acquisition waited for readiness.
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    await waitForNoProcesses(mark, 10_000)
  }, 60_000)

  it("releases the service when the consumer fails", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${serveDeclaration(port, mark, "", `readiness: { port: ${port} }`)}
const probe = S.Shell.Test({ shell: "exit 3", services: [svc], sandbox: { network: true } })
export const Package = S.Package({ targets: { svc, probe } })
`
    )
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:probe"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("//:probe  service //:svc: ready")
    expect(logs).toContain("//:probe  failed")
    expect(logs).toContain("exit 3")
    await waitForNoProcesses(mark, 10_000)
  }, 60_000)

  it("fails the consumer with a typed readiness timeout carrying the tail, and tears the service down", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${
        serveDeclaration(
          port,
          mark,
          "--delay-listen 30000",
          `readiness: { http: "http://127.0.0.1:${port}/health", timeout: "1s" }`
        )
      }
const probe = S.Shell.Test({ shell: "true", services: [svc], sandbox: { network: true } })
export const Package = S.Package({ targets: { svc, probe } })
`
    )
    commitAll(root)
    const { exitCode, logs } = await serve(root, ["//:probe"])
    expect(exitCode).toBe(1)
    expect(logs).toContain("//:probe  failed")
    expect(logs).toContain("service //:svc readiness-timeout")
    expect(logs).toContain("was not ready within 1000ms")
    expect(logs).not.toContain("//:probe  service //:svc: ready")
    await waitForNoProcesses(mark, 10_000)
  }, 60_000)

  it("fails a running consumer when the service turns unhealthy, killing the consumer", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    const consumerMark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    // The consumer wedges the server (every later /health answers 500) and
    // then sleeps far longer than the health contract takes to trip.
    const consumer =
      `${process.execPath} -e "fetch('http://127.0.0.1:${port}/wedge').then(() => setTimeout(() => {}, 60000))" ${consumerMark}`
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${
        serveDeclaration(
          port,
          mark,
          "",
          `readiness: { http: "http://127.0.0.1:${port}/health", timeout: "10s" },
  health: { interval: "150ms", failures: 2 }`
        )
      }
const probe = S.Shell.Test({ shell: ${JSON.stringify(consumer)}, services: [svc], sandbox: { network: true } })
export const Package = S.Package({ targets: { svc, probe } })
`
    )
    commitAll(root)
    const started = Date.now()
    const { exitCode, logs } = await serve(root, ["//:probe"])
    expect(exitCode).toBe(1)
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(logs).toContain("//:probe  failed")
    expect(logs).toContain("service //:svc unhealthy")
    expect(logs).toContain("2 consecutive health probes")
    expect(logs).toContain("answered 500")
    expect(logs).toContain("wedged: answering 500 from now on")
    await waitFor(async () => pgrep(mark).length === 0 && pgrep(consumerMark).length === 0, 15_000)
    expect(pgrep(probeControlMarker)).not.toHaveLength(0)
  }, 90_000)

  it.skipIf(PackageTree.findOnPath("go") === undefined).each(["interrupt", "health"] as const)(
    "waits for write-set restoration after consumer %s",
    async (failure) => {
      const root = await temporaryWorkspace()
      const port = await freePort()
      const mark = marker()
      await write(
        root,
        "WORKSPACE.ts",
        workspaceModule().replace(
          "  nodeModules:",
          `
  toolchains: [S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), cgo: false,
    versions: S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") }) })],
  nodeModules:`
        )
      )
      await write(root, "go.mod", "module example.test/cleanup\n\ngo 1.18\n")
      await write(root, "go.sum", "")
      await write(root, "flake.nix", "{}")
      await write(root, "flake.lock", "{}")
      await write(root, "generate.go", `package cleanup\n//go:generate ${process.execPath} consumer.mjs\n`)
      await write(root, ".gitignore", ".flows\n.env\n")
      await write(root, "out.txt", "original tracked")
      await write(root, ".env", "original ignored")
      await write(
        root,
        "consumer.mjs",
        `
import { writeFileSync } from "node:fs"
writeFileSync("out.txt", "changed tracked")
writeFileSync(".env", "changed ignored")
console.error("consumer-wrote")
${failure === "health" ? `await fetch("http://127.0.0.1:${port}/wedge")` : ""}
setInterval(() => {}, 1000)
`
      )
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const svc = ${
          serveDeclaration(
            port,
            mark,
            "",
            `
  readiness: { http: "http://127.0.0.1:${port}/health", timeout: "10s" },
  health: { interval: "150ms", failures: 2 }`
          )
        }
const change = S.Go.Generate({ pkgs: ["."], data: [S.file("//consumer.mjs")],
  changes: ["out.txt"], services: [svc], sandbox: "none" })
export const Package = S.Package({ targets: { svc, change } })
`
      )
      commitAll(root)
      const controller = new AbortController()
      const revertIgnored = PackageTree.revertIgnored
      const reverting: Array<Promise<boolean>> = []
      let stashDirectory: string | undefined
      let restored = false
      const revert = vi.spyOn(PackageTree, "revertIgnored").mockImplementation((snapshot, path) => {
        stashDirectory = snapshot.stash.directory
        const pending = (async () => {
          // Hold the revert long enough for the service scope to close first.
          await new Promise((resolve) => setTimeout(resolve, 1000))
          const result = await revertIgnored(snapshot, path)
          restored = true
          return result
        })()
        reverting.push(pending)
        return pending
      })
      try {
        const result = await serve(root, ["//:change", "--write"], {
          signal: controller.signal,
          onLog: (line) => {
            if (failure === "interrupt" && line.includes("consumer-wrote")) controller.abort()
          }
        })
        expect(result.exitCode).toBe(1)
        expect(result.logs, result.output).toContain("consumer-wrote")
        if (failure === "health") expect(result.logs).toContain("service //:svc unhealthy")
        expect(restored).toBe(true)
        expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("original tracked")
        expect(await Fs.readFile(NodePath.join(root, ".env"), "utf8")).toBe("original ignored")
        expect(stashDirectory).toBeDefined()
        expect(existsSync(stashDirectory!)).toBe(false)
        expectNoProcesses(mark)
      } finally {
        // Drain the intentionally delayed cleanup even on the pre-fix failure.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        await Promise.allSettled(reverting)
        revert.mockRestore()
      }
    },
    60_000
  )

  it("runs a Serve root in the foreground until interrupted, then applies the stop contract", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const svc = ${
        serveDeclaration(port, mark, "", `readiness: { port: ${port} }, stop: { signal: "SIGTERM", grace: "5s" }`)
      }
export const Package = S.Package({ targets: { svc } })
`
    )
    commitAll(root)
    const controller = new AbortController()
    let ready = false
    const running = serve(root, ["//:svc"], {
      signal: controller.signal,
      onLog: (line) => {
        if (line.includes("//:svc  ready (pid")) ready = true
      }
    })
    await waitFor(async () => ready, 15_000)
    expect(await portOpen(port)).toBe(true)
    expect(pgrep(mark).length).toBeGreaterThan(0)
    controller.abort(new Error("smithers build interrupted by SIGINT"))
    const { exitCode, logs } = await running
    expect(logs).toContain("//:svc  ready (pid")
    expect(logs).toContain("//:svc  stopped")
    expect(exitCode).toBe(1)
    await waitForNoProcesses(mark, 10_000)
    expect(await portOpen(port)).toBe(false)
  }, 60_000)

  it("never schedules a Serve target as an ordinary node; its data edges hoist onto the consumer", async () => {
    const root = await temporaryWorkspace()
    const port = await freePort()
    const mark = marker()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "assets/a.txt", "a")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const assets = S.Filegroup({ srcs: S.glob(["assets/**"]) })
const svc = ${serveDeclaration(port, mark, "", `readiness: { port: ${port} }, data: [assets]`)}
const probe = S.Shell.Test({ shell: "true", services: [svc], sandbox: { network: true } })
export const Package = S.Package({ targets: { assets, svc, probe } })
`
    )
    commitAll(root)
    const { exitCode, output } = await serve(root, ["//:probe", "--plan"])
    expect(exitCode).toBe(0)
    // The consumer's execution edges name the service's data producer, not
    // the service; the plan never lists the service as work.
    expect(output).toMatch(/label: "\/\/:probe"[\s\S]*?dependencies\[1\]: "\/\/:assets"/)
    expect(output).toContain("label: \"//:assets\"")
    expect(output).not.toContain("\"//:svc\"")
    expectNoProcesses(mark)
  }, 60_000)
})

describe("closure keying", () => {
  it("keys a Shell.Test on the resolved closure: an edit inside re-keys, an edit outside stays a hit", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "src/a.ts", `import { b } from "./b"\nexport const a = b + 1\n`)
    await write(root, "src/b.ts", `export const b = 1\n`)
    await write(root, "src/unrelated.ts", `export const u = 1\n`)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const closure = S.ImportClosure({ entries: S.glob(["src/a.ts"]) })
const t = S.Shell.Test({ shell: "true", data: [closure] })
export const Package = S.Package({ targets: { closure, t } })
`
    )
    commitAll(root)
    const first = await serve(root, ["//:t"])
    expect(first.exitCode).toBe(0)
    expect(first.logs).toContain("//:closure  closure: 2 files, 0 packages, 0 unresolved, 0 dynamic")
    expect(first.logs).toContain("//:t  ran")
    const second = await serve(root, ["//:t"])
    expect(second.logs).toContain("//:t  hit")
    await write(root, "src/b.ts", `export const b = 2\n`)
    const inside = await serve(root, ["//:t"])
    expect(inside.logs).toContain("//:t  ran")
    await write(root, "src/unrelated.ts", `export const u = 2\n`)
    const outside = await serve(root, ["//:t"])
    expect(outside.logs).toContain("//:t  hit")
  }, 60_000)

  it(
    "checks Files.difference against a closure: leftover named, verdict cached, dynamic import fails closed",
    async () => {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(root, "src/a.ts", `import { b } from "./b"\nexport const a = b + 1\n`)
      await write(root, "src/b.ts", `export const b = 1\n`)
      await write(root, "src/unrelated.ts", `export const u = 1\n`)
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["src/**"]) })
const closure = S.ImportClosure({ entries: S.glob(["src/a.ts"]) })
const dead = S.Test({ expect: S.Files.difference(srcs, closure.files), toBe: "empty" })
export const Package = S.Package({ targets: { srcs, closure, dead } })
`
      )
      commitAll(root)
      const red = await serve(root, ["//:dead"])
      expect(red.exitCode).toBe(1)
      expect(red.logs).toContain("//:dead  failed")
      expect(red.logs).toContain("1 of 3 file(s) in the left set are missing from the right set")
      expect(red.logs).toContain("leftover: src/unrelated.ts")
      await Fs.rm(NodePath.join(root, "src/unrelated.ts"))
      const green = await serve(root, ["//:dead"])
      expect(green.exitCode).toBe(0)
      expect(green.logs).toContain("//:dead  difference empty: 2 left, 2 right")
      expect(green.logs).toContain("//:dead  ran")
      const again = await serve(root, ["//:dead"])
      expect(again.logs).toContain("//:dead  hit")
      await write(root, "src/a.ts", `import { b } from "./b"\nexport const a = () => import(b ? "./x" : "./y")\n`)
      const closed = await serve(root, ["//:dead"])
      expect(closed.exitCode).toBe(1)
      expect(closed.logs).toContain("fails closed")
      expect(closed.logs).toContain("dynamic: src/a.ts ->")
    },
    60_000
  )
})

describe("bundler build key template", () => {
  it("substitutes the graph key into the attrs reference and the dependency row", () => {
    const template = {
      body: { target: "Bundler.Rspack.build" },
      inputs: {
        attrs: { graph: { _tag: "Target", key: graphKeySentinel }, environment: "web" },
        dependencies: [{ label: "//:graph", key: graphKeySentinel }, { label: "//:cfg", key: "abc" }],
        toolchain: []
      },
      layers: [],
      capabilities: ["fs:read"]
    }
    const substituted = keyMaterialWithGraph(template, "bundler-graph:deadbeef")
    expect(substituted.inputs).toEqual({
      attrs: { graph: { _tag: "Target", key: "bundler-graph:deadbeef" }, environment: "web" },
      dependencies: [{ label: "//:graph", key: "bundler-graph:deadbeef" }, { label: "//:cfg", key: "abc" }],
      toolchain: []
    })
    // The template itself is untouched.
    expect((template.inputs.dependencies[0] as { readonly key: string }).key).toBe(graphKeySentinel)
  })
})

/**
 * The node_modules tree the bundler fixture links in so the dispatched
 * workspace provides its own `@rsbuild/core`.
 *
 * The default is this package's own resolved copy of the devDependency, so
 * the cases run on a clean checkout; `SMTHRS_RSBUILD_MODULES` names another
 * workspace's node_modules instead. Failing to resolve either one means a
 * broken install, not a reason to skip.
 */
const resolveModulesSource = (): string => {
  const override = process.env["SMTHRS_RSBUILD_MODULES"]
  if (override !== undefined && override !== "") {
    if (!existsSync(NodePath.join(override, "@rsbuild", "core"))) {
      throw new Error(`SMTHRS_RSBUILD_MODULES=${override} provides no @rsbuild/core`)
    }
    return override
  }
  // <modules>/@rsbuild/core/package.json -> <modules>
  return NodePath.resolve(createRequire(import.meta.url).resolve("@rsbuild/core/package.json"), "../../..")
}

const modulesSource = resolveModulesSource()

describe("bundler dispatch", () => {
  it("resolves and builds through the workspace bundler, keyed on the graph digest", async () => {
    const root = await temporaryWorkspace()
    await Fs.cp(rsbuildFixture, root, { recursive: true })
    await Fs.symlink(modulesSource, NodePath.join(root, "node_modules"), "dir")
    await write(root, ".gitignore", "node_modules\ndist\n.flows\n")
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["src/**"]) })
const rspack = S.Bundler.Rspack({ config: S.file("//rsbuild.config.mjs") })
const graph = rspack.resolve({ entries: ["main.ts"], universe: [srcs] })
const build = rspack.build({ environment: "web", mode: "development", graph, outDirs: ["dist"] })
const dead = S.Test({ expect: S.Files.difference(srcs, graph.files), toBe: "empty" })
export const Package = S.Package({ targets: { srcs, graph, build, dead } })
`
    )
    commitAll(root)
    const first = await serve(root, ["//:build"])
    expect(first.logs).toContain("//:graph  ran")
    expect(first.logs).toMatch(/\/\/:graph {2}graph: \d+ modules, 2 workspace files, 0 packages/)
    expect(first.logs).toContain("//:build  ran")
    expect(first.exitCode).toBe(0)
    const bundle = await Fs.readFile(NodePath.join(root, "dist", "static", "js", "index.js"), "utf8")
    expect(bundle).toContain("rsbuild-mini")

    // Warm: both replay. The build's execution key carried the graph digest
    // on the cold run too, so the digest-keyed plan of the warm run hits.
    const second = await serve(root, ["//:build"])
    expect(second.logs).toContain("//:graph  hit")
    expect(second.logs).toContain("//:build  hit")

    // A universe edit that leaves the resolved graph unchanged re-resolves
    // (the resolve keys on the universe) but replays the build (keyed on the
    // graph digest): the caching win the spec names.
    await write(root, "src/extra.ts", `export const extra = 1\n`)
    const third = await serve(root, ["//:build"])
    expect(third.logs).toContain("//:graph  ran")
    expect(third.logs).toContain("//:build  hit")

    // The unreached file is exactly the difference the dead-code test reports.
    const dead = await serve(root, ["//:dead"])
    expect(dead.exitCode).toBe(1)
    expect(dead.logs).toContain("leftover: src/extra.ts")

    // An edit inside the graph changes the digest and re-keys the build.
    await write(root, "src/dep.ts", `export const greet = (name: string): string => \`hi \${name}\`\n`)
    const fourth = await serve(root, ["//:build"])
    expect(fourth.logs).toContain("//:graph  ran")
    expect(fourth.logs).toContain("//:build  ran")
    expect(await Fs.readFile(NodePath.join(root, "dist", "static", "js", "index.js"), "utf8")).toContain("hi ")
  }, 600_000)
})

describe("agent MCP session forwarding", () => {
  it.each(["Diff", "Pr"] as const)("forwards declared servers through Agent.%s session counting", async (flavor) => {
    const root = await temporaryWorkspace()
    const server = NodeHttp.createServer((_request, response) => response.end("ok"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("no port assigned")
    const mcp = [Reference.Mcp.Http("issues", `http://127.0.0.1:${address.port}/mcp`)]
    const opened: Array<ReadonlyArray<Reference.McpHttp> | undefined> = []
    let runs = 0
    const factory: AgentSession.SessionFactory = {
      open: (_ref, declared) => {
        opened.push(declared)
        return Effect.succeed({
          identity: "recording",
          run: () =>
            Effect.sync(() => {
              runs += 1
              return { findings: [], edits: [], note: undefined }
            })
        })
      }
    }
    const selection = vi.spyOn(AgentFake, "sessionFactoryFromEnvironment").mockReturnValue(factory)
    try {
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(root, "prompt.md", "Inspect the declared issues server.\n")
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const agent = S.Agent.${flavor}({
  prompt: S.file("//prompt.md"), data: [], changes: ["out/**"], gates: [], maxRounds: 1,
  mcp: [S.Mcp.Http("issues", ${JSON.stringify(mcp[0]!.url)})],
})
export const Package = S.Package({ targets: { agent } })
`
      )
      commitAll(root)
      const result = await serve(root, ["//:agent"])
      expect(opened, result.output + result.logs).toEqual([mcp])
      expect(runs).toBe(1)
      if (flavor === "Diff") expect(result.exitCode).toBe(0)
      else {
        // PR publication is unavailable in this binding, after the session runs.
        expect(result.exitCode).toBe(1)
        expect(result.logs).toContain("PR settle refused")
      }
    } finally {
      selection.mockRestore()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})

describe("process probes", () => {
  it("throws on a failed process inspection instead of reporting an absence", () => {
    expect(() => probeProcesses("pgrep-does-not-exist", probeControlMarker)).toThrow(
      /could not inspect processes/
    )
  })
})
