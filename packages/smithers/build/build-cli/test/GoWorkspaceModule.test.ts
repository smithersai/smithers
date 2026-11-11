/**
 * A real Go module under real confinement: the gaps VibeLang's dogfood found
 * when its compiler module had to build and test as sandboxed, exactly keyed
 * targets. Every case spawns the host's `go` and, where it says `sandbox: {}`,
 * bubblewrap or seatbelt.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GoCache from "../src/internal/GoCache.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  for (const root of roots) {
    // Go leaves module-cache directories read-only.
    NodeChildProcess.spawnSync("chmod", ["-R", "u+w", root])
    await Fs.rm(root, { recursive: true, force: true })
  }
})

const temporary = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-module-")))
  roots.push(root)
  return root
}

const launcher = PackageTree.findOnPath("go")
const canConfine = process.platform === "darwin" ||
  (process.platform === "linux" && NodeChildProcess.spawnSync("sh", ["-c", "command -v bwrap"]).status === 0)

/** The launcher's own version, `1.26.8`, with GOTOOLCHAIN switching turned off. */
const launcherVersion = launcher === undefined ? undefined : /go version go(\d+\.\d+(?:\.\d+)?)/.exec(
  NodeChildProcess.execFileSync(launcher, ["version"], {
    encoding: "utf8",
    env: { ...process.env, GOTOOLCHAIN: "local" },
    cwd: Os.tmpdir()
  })
)?.[1]

const newer = (left: string, right: string): boolean => {
  const a = left.split(".").map(Number), b = right.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0)
  }
  return false
}

/**
 * A toolchain GOTOOLCHAIN would switch the launcher to, already in the module
 * cache, so selecting it needs no network: `1.27.0` when the launcher is 1.26.
 */
const switchedVersion = await (async (): Promise<string | undefined> => {
  if (launcher === undefined || launcherVersion === undefined) return undefined
  const modcache = NodeChildProcess.execFileSync(launcher, ["env", "GOMODCACHE"], {
    encoding: "utf8",
    env: { ...process.env, GOTOOLCHAIN: "local" },
    cwd: Os.tmpdir()
  }).trim()
  const arch = process.arch === "x64" ? "amd64" : process.arch
  const entries = await Fs.readdir(NodePath.join(modcache, "golang.org")).catch(() => [] as Array<string>)
  return entries
    .flatMap((entry) => {
      const match = new RegExp(`^toolchain@v0\\.0\\.1-go(\\d+\\.\\d+\\.\\d+)\\.${process.platform}-${arch}$`).exec(
        entry
      )
      return match === null ? [] : [match[1]!]
    })
    .filter((version) => newer(version, launcherVersion))
    .sort((left, right) => (newer(left, right) ? -1 : 1))[0]
})()

/**
 * One Go module workspace: `go.mod` at `module` (the root by default), a
 * declared Go toolchain, the host bins the cases name, and `targets` as the
 * root package's target record.
 */
const module = async (
  targets: string,
  options: { readonly module?: string; readonly go?: string; readonly files?: Readonly<Record<string, string>> } = {}
): Promise<string> => {
  const root = await temporary()
  const directory = options.module ?? ""
  const at = (path: string) => [directory, path].filter(Boolean).join("/")
  await write(root, at("go.mod"), `module example.test/probe\n\ngo ${options.go ?? launcherVersion}\n`)
  await write(root, at("go.sum"), "")
  await write(root, at("main.go"), "package main\nfunc main() {}\n")
  await write(
    root,
    at("main_test.go"),
    `package main
import "testing"
func TestProbe(t *testing.T) {}
`
  )
  for (const [path, text] of Object.entries(options.files ?? {})) await write(root, path, text)
  await write(root, "flake.nix", "{}\n")
  await write(root, "flake.lock", "{}\n")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const nix = S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
const go = S.Go.Toolchain({ mod: S.file("//${at("go.mod")}"), sum: S.file("//${
      at("go.sum")
    }"), versions: nix, cgo: false })
export const Workspace = S.Workspace("probe", { repository: "git+https://example.test/probe.git", cache: S.Cache({ directory: ".flows" }), toolchains: [nix, go], host: S.Host({ bins: ["cat", "node"] }) })
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
${targets}
`
  )
  NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
  return root
}

const ran = async (root: string, args: ReadonlyArray<string>, environment = process.env) => {
  const result = await serve(root, args, { environment })
  return { ...result, text: result.logs + result.output }
}

describe.runIf(launcher !== undefined && canConfine)("a Go module under confinement", () => {
  it("admits a Go.Packages closure to a confined shell consumer that names it in data", async () => {
    const root = await module(`const packages = S.Go.Packages({ pkgs: ["./"] })
export const Package = S.Package({ targets: {
  packages,
  consumer: S.Shell.Test({ shell: "cat main.go main_test.go", tools: [S.Host.bin("cat")], data: [packages], sandbox: {} }),
  undeclared: S.Shell.Test({ shell: "cat main.go", tools: [S.Host.bin("cat")], sandbox: {} })
} })`)
    const consumed = await ran(root, ["test", "//:consumer"])
    expect(consumed.exitCode, consumed.text).toBe(0)
    // The closure is the grant, not the package directory: a consumer that
    // does not name it still cannot read the module.
    const undeclared = await ran(root, ["test", "//:undeclared"])
    expect(undeclared.exitCode).toBe(1)
    expect(undeclared.text).toContain("main.go is outside the declared read set")
    // The closure's files key the consumer.
    await Fs.appendFile(NodePath.join(root, "main.go"), "// changed\n")
    expect((await ran(root, ["test", "//:consumer"])).text).toContain("//:consumer  ran")
  }, 240_000)
})

describe.runIf(launcher !== undefined && switchedVersion !== undefined && canConfine)(
  "S.Go.bin as a shell tool",
  () => {
    it.each([["confined", "{}"], ["unconfined", "\"none\""]])(
      "runs the selected SDK, not the launcher, %s",
      async (_name, sandbox) => {
        const root = await module(
          `export const Package = S.Package({ targets: {
  version: S.Shell.Test({
    shell: ${
            JSON.stringify(
              `go version | grep -F "go${switchedVersion} " && test "$(go env GOVERSION)" = go${switchedVersion}`
            )
          },
    tools: [S.Go.bin], data: [S.file("go.mod"), S.file("go.sum")], sandbox: ${sandbox}
  })
} })`,
          { go: switchedVersion! }
        )
        // The launcher stays first on PATH, as it does on a host whose go is a
        // wrapper or an older install: only the declared tool may answer `go`.
        const environment = {
          ...process.env,
          PATH: [NodePath.dirname(launcher!), process.env["PATH"] ?? ""].join(NodePath.delimiter),
          GOTOOLCHAIN: "auto"
        }
        const result = await ran(root, ["test", "//:version"], environment)
        expect(result.exitCode, result.text).toBe(0)
      },
      240_000
    )
  }
)

describe.runIf(canConfine)("a workspace-local host tool", () => {
  it.each([["confined", "{}"], ["unconfined", "\"none\""]])(
    "is the tool a %s command runs, never a later one on PATH",
    async (_name, sandbox) => {
      const root = await temporary()
      await write(root, "package.json", "{\"name\":\"fixture\",\"private\":true}\n")
      await write(
        root,
        "WORKSPACE.ts",
        `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("fixture", { repository: "git+https://example.test/fixture.git", cache: S.Cache({ directory: ".flows" }), host: S.Host({ bins: ["probe-tool"] }) })
`
      )
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  local: S.Shell.Test({ shell: "test \\"$(probe-tool)\\" = workspace-local", tools: [S.Host.bin("probe-tool")], sandbox: ${sandbox} })
} })
`
      )
      // The workspace-local tool comes first on PATH; a system one sits after it.
      const local = NodePath.join(root, ".tools/bin")
      const system = await temporary()
      await write(local, "probe-tool", "#!/bin/sh\necho workspace-local\n")
      await write(system, "probe-tool", "#!/bin/sh\necho system\n")
      await Fs.chmod(NodePath.join(local, "probe-tool"), 0o755)
      await Fs.chmod(NodePath.join(system, "probe-tool"), 0o755)
      NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
      const environment = {
        ...process.env,
        PATH: [local, system, process.env["PATH"] ?? ""].join(NodePath.delimiter)
      }
      const result = await ran(root, ["test", "//:local"], environment)
      expect(result.exitCode, result.text).toBe(0)
    },
    120_000
  )
})

describe("tools a command finds by name", () => {
  const declare = async (tools: string, bins: ReadonlyArray<string>): Promise<{ root: string; system: string }> => {
    const root = await temporary()
    const system = await temporary()
    await write(system, "probe-tool", "#!/bin/sh\necho system\n")
    await Fs.chmod(NodePath.join(system, "probe-tool"), 0o755)
    await write(root, "package.json", "{\"name\":\"fixture\",\"private\":true}\n")
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("fixture", { repository: "git+https://example.test/fixture.git", cache: S.Cache({ directory: ".flows" }), host: S.Host({ bins: ${
        JSON.stringify(bins)
      } }) })
`
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { probe: S.Shell.Test({ shell: "probe-tool", tools: ${tools}, sandbox: "none" }) } })
`
    )
    NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
    return { root, system }
  }

  it("refuses two tools with one name and different executables", async () => {
    const { root, system } = await declare(
      `[S.Host.bin("probe-tool"), S.Host.bin("probe-tool", { env: "PROBE_TOOL" })]`,
      ["probe-tool"]
    )
    const local = NodePath.join(await temporary(), "probe-tool")
    await Fs.writeFile(local, "#!/bin/sh\necho local\n", { mode: 0o755 })
    const environment = {
      ...process.env,
      PATH: [system, process.env["PATH"] ?? ""].join(NodePath.delimiter),
      PROBE_TOOL: local
    }
    const result = await ran(root, ["test", "//:probe"], environment)
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain("two tools are named \"probe-tool\"")
    // The same executable named twice is one tool.
    const same = await ran(root, ["test", "//:probe"], {
      ...environment,
      PROBE_TOOL: NodePath.join(system, "probe-tool")
    })
    expect(same.exitCode, same.text).toBe(0)
  }, 120_000)

  it("refuses a tool whose name is not a command name", async () => {
    const { root, system } = await declare(`[S.Host.bin("bin/probe-tool", { env: "PROBE_TOOL" })]`, ["bin/probe-tool"])
    const result = await ran(root, ["test", "//:probe"], {
      ...process.env,
      PROBE_TOOL: NodePath.join(system, "probe-tool")
    })
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain("is not a command name")
  }, 120_000)
})

describe.runIf(launcher !== undefined && canConfine)("a nested Go module", () => {
  it("builds, tests and downloads in the module's directory", async () => {
    const root = await module(
      `export const Package = S.Package({ targets: {
  binary: S.Go.Binary({ pkg: "example.test/probe", out: "bin/probe", offline: true, sandbox: {} }),
  download: S.Go.ModDownload({ mod: S.file("//mod/go.mod"), sum: S.file("//mod/go.sum"), outDirs: [".gomodcache"], sandbox: {} })
} })`,
      {
        module: "mod",
        files: {
          "mod/PACKAGE.ts": `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  tests: S.Go.Test({ pkgs: ["./..."], offline: true, sandbox: {} }),
  local: S.Go.Binary({ pkg: "./", out: "bin/local", offline: true, sandbox: {} })
} })
`
        }
      }
    )
    const binary = await ran(root, ["build", "//:binary"])
    expect(binary.exitCode, binary.text).toBe(0)
    expect((await Fs.stat(NodePath.join(root, "bin/probe"))).isFile()).toBe(true)
    const local = await ran(root, ["build", "//mod:local"])
    expect(local.exitCode, local.text).toBe(0)
    expect((await Fs.stat(NodePath.join(root, "mod/bin/local"))).isFile()).toBe(true)
    const tests = await ran(root, ["test", "//mod:tests"])
    expect(tests.exitCode, tests.text).toBe(0)
    // A module with no requirements has nothing to fetch; go says so from
    // inside the module rather than "no modules specified" from the root.
    const download = await ran(root, ["build", "//:download"])
    expect(download.text).toContain("go: no module dependencies to download")
    expect(download.exitCode, download.text).toBe(0)
  }, 240_000)
})

describe.runIf(launcher !== undefined && canConfine)("Go.ModDownload of a module with nothing to fetch", () => {
  const targets =
    `const modules = S.Go.ModDownload({ mod: S.file("go.mod"), sum: S.file("go.sum"), outDirs: [".gomodcache"], sandbox: {} })
export const Package = S.Package({ targets: {
  modules,
  binary: S.Go.Binary({ pkg: "./", out: "bin/probe", offline: true, data: [modules], sandbox: {} })
} })`

  it("succeeds with an empty module cache, restores it, and feeds an offline build", async () => {
    const root = await module(targets)
    const first = await ran(root, ["build", "//:modules"])
    expect(first.exitCode, first.text).toBe(0)
    expect(first.text).toContain("//:modules  ran")
    expect(await Fs.readdir(NodePath.join(root, ".gomodcache"))).toEqual([])
    await Fs.rm(NodePath.join(root, ".gomodcache"), { recursive: true })
    const again = await ran(root, ["build", "//:modules"])
    expect(again.exitCode, again.text).toBe(0)
    expect(again.text).toContain("//:modules  hit")
    expect((await Fs.stat(NodePath.join(root, ".gomodcache"))).isDirectory()).toBe(true)
    const binary = await ran(root, ["build", "//:binary"])
    expect(binary.exitCode, binary.text).toBe(0)
  }, 240_000)
})

describe.runIf(launcher !== undefined && canConfine)("Go.Binary keys", () => {
  it("do not change when only a test file changes", async () => {
    const root = await module(`export const Package = S.Package({ targets: {
  binary: S.Go.Binary({ pkg: "./", out: "bin/probe", offline: true, sandbox: {} }),
  tests: S.Go.Test({ pkgs: ["./"], offline: true, sandbox: {} })
} })`)
    expect((await ran(root, ["build", "//:binary"])).exitCode).toBe(0)
    expect((await ran(root, ["test", "//:tests"])).exitCode).toBe(0)
    await Fs.appendFile(NodePath.join(root, "main_test.go"), "// test edit\n")
    expect((await ran(root, ["build", "//:binary"])).text).toContain("//:binary  hit")
    // The test target still keys on its test files.
    expect((await ran(root, ["test", "//:tests"])).text).toContain("//:tests  ran")
  }, 240_000)
})

describe.runIf(launcher !== undefined && canConfine)("offline Go rules", () => {
  it("keep the declared GOFLAGS and add -mod=readonly", async () => {
    const root = await module(
      `export const Package = S.Package({ targets: {
  filtered: S.Go.Test({ pkgs: ["./"], offline: true, env: { GOFLAGS: "-run=^TestProbe$ -p=2 -trimpath" }, sandbox: {} }),
  vendor: S.Go.Test({ pkgs: ["./"], offline: true, env: { GOFLAGS: "-mod=mod -run=^TestProbe$" }, sandbox: {} })
} })`,
      {
        files: {
          "filter_test.go":
            "package main\nimport \"testing\"\nfunc TestMustBeFiltered(t *testing.T) { t.Fatal(\"SELECTOR_IGNORED\") }\n"
        }
      }
    )
    const filtered = await ran(root, ["test", "//:filtered"])
    expect(filtered.exitCode, filtered.text).toBe(0)
    expect(filtered.text).not.toContain("SELECTOR_IGNORED")
    // offline means the module graph cannot change; a declared -mod=mod says it may.
    const vendor = await ran(root, ["test", "//:vendor"])
    expect(vendor.exitCode).toBe(1)
    expect(vendor.text).toContain("offline")
    expect(vendor.text).toContain("-mod=mod")
  }, 240_000)
})

describe.runIf(launcher !== undefined && canConfine)("confined Go actions", () => {
  it("share the workspace's compile cache between actions", async () => {
    const root = await module(
      `const test = (name: string) => S.Go.Test({ pkgs: ["./"], offline: true, env: { PROBE: name }, sandbox: {} })
export const Package = S.Package({ targets: { a: test("a"), b: test("b") } })`
    )
    expect((await ran(root, ["test", "//:a"])).exitCode).toBe(0)
    const compiled = await GoCache.entries(root, ".flows")
    expect(compiled.length).toBeGreaterThan(0)
    const before = new Set(compiled.map((entry) => entry.path))
    expect((await ran(root, ["test", "//:b"])).exitCode).toBe(0)
    // b compiles nothing a already compiled: it adds only its own test result.
    const added = (await GoCache.entries(root, ".flows")).filter((entry) => !before.has(entry.path))
    expect(added.length).toBeLessThan(compiled.length / 4)
  }, 240_000)
})
