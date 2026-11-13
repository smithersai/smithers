/**
 * Planner edges a whole plan reaches: a resolved Nix closure and mise
 * launcher, inputs that cannot be read, and the identity of a script whose
 * interpreter comes from PATH.
 */
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  binaryIdentity,
  installationDependencies,
  planEffect,
  PlanningServices,
  planningServicesLive
} from "../src/internal/PackagePlanner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import type { PackageNode } from "../src/PackageExec.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await Fs.chmod(Path.join(root, "src"), 0o755).catch(() => undefined)
    await Fs.rm(root, { recursive: true, force: true })
  }
})

const temporary = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-planner-edges-")))
  roots.push(root)
  return root
}

/** A workspace with `extra` Workspace fields and one `command` target. */
const fixture = async (
  target: string,
  files: Readonly<Record<string, string>> = {},
  extra = "",
  preamble = ""
) => {
  const root = await temporary()
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("planner-edges", {
 repository: "git+https://example.invalid/planner-edges.git", cache: S.Cache({ directory: ".flows" }), ${extra}
})\n`
  )
  await write(root, "package.json", "{\"name\":\"planner-edges\",\"private\":true}\n")
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"\n${preamble}\n` +
      `export const Package = S.Package({ targets: { command: ${target} } })\n`
  )
  for (const [path, value] of Object.entries(files)) await write(root, path, value)
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  return { root, options: { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: ["//:command"] } }
}

describe("a resolved Nix environment", () => {
  it("binds the closure's PATH and variables into the planned node", async () => {
    const { root, options } = await fixture(
      "S.Shell.Test({ shell: \"true\", sandbox: \"none\" })",
      { "environment.nix": "{}\n" },
      "environment: S.Nix.Environment({ file: S.file(\"//environment.nix\") }),"
    )
    const bin = Path.join(root, "closure", "bin")
    await Fs.mkdir(bin, { recursive: true })
    const closure = {
      storePath: Path.join(root, "closure"),
      hash: "0".repeat(32),
      path: [bin],
      variables: { CLOSURE_MARK: "from-nix" },
      closure: [Path.join(root, "closure")],
      nix: { executable: "nix", version: "nix (Nix) 2.99.0" },
      system: "x86_64-linux",
      inputs: []
    }
    const services = { ...planningServicesLive, resolveNixEnvironment: () => Effect.succeed(closure) }
    const plan = await Effect.runPromise(
      planEffect({ ...options, environment: { PATH: "/usr/bin:/bin" } }).pipe(
        Effect.provideService(PlanningServices, services)
      )
    )
    const node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.nixEnvironment).toEqual({
      storePath: closure.storePath,
      hash: closure.hash,
      closure: closure.closure,
      path: [bin],
      variables: { CLOSURE_MARK: "from-nix" }
    })
  })
})

describe("a resolved mise launcher", () => {
  it("measures the mise found on PATH with its declared pin", async () => {
    const { root, options } = await fixture(
      "S.Shell.Test({ bin: S.Mise.bin(\"go\") })",
      { "mise.toml": "[tools]\ngo = \"1.26.0\"\n" },
      "toolchains: [S.Mise({ config: S.file(\"//mise.toml\") })],"
    )
    const bin = Path.join(root, "host-bin")
    await write(root, "host-bin/mise", "#!/bin/sh\necho \"2099.1.1 linux-x64\"\n")
    await Fs.chmod(Path.join(bin, "mise"), 0o755)
    const plan = await PackageExec.plan({ ...options, environment: { PATH: `${bin}:/usr/bin:/bin` } })
    const node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.argv).toEqual([Path.join(bin, "mise")])
    expect((node.keyMaterial.inputs as { readonly toolchain?: unknown }).toolchain).toMatchObject([{
      resolution: {
        tag: "MiseBin",
        name: "go",
        pinned: "1.26.0",
        path: Path.join(bin, "mise"),
        probe: { exitCode: 0, output: "2099.1.1 linux-x64\n" }
      },
      binary: { _tag: "Executable", source: "{smthrs:root}/host-bin/mise" }
    }])
  })
})

describe("declared inputs that cannot be keyed", () => {
  it("names S.link for an S.file that is a link to a directory", async () => {
    const { root, options } = await fixture(
      "S.Shell.Test({ shell: \"true\", sandbox: \"none\", data: [S.file(\"linked\")] })",
      { "real/inside.txt": "inside\n" }
    )
    await Fs.symlink("real", Path.join(root, "linked"))
    await expect(PackageExec.plan(options)).rejects.toMatchObject({
      _tag: "smithers-build/PackageError",
      code: "link_input_refused",
      path: "linked",
      message: expect.stringContaining(
        "S.file(\"linked\"): linked is a symbolic link to a directory; declare the link itself with S.link(\"linked\")"
      )
    })
  })

  it("keeps the read error for an S.file that is a directory", async () => {
    const { root, options } = await fixture(
      "S.Shell.Test({ shell: \"true\", sandbox: \"none\", data: [S.file(\"real\")] })",
      { "real/inside.txt": "inside\n" }
    )
    await expect(PackageExec.plan(options)).rejects.toThrow(
      `declared input is not a regular file: ${Path.join(root, "real")}`
    )
  })

  it("keeps the read error for an S.file that is a link to itself", async () => {
    const { root, options } = await fixture(
      "S.Shell.Test({ shell: \"true\", sandbox: \"none\", data: [S.file(\"loop\")] })"
    )
    await Fs.symlink("loop", Path.join(root, "loop"))
    // The link resolves nowhere, so it is not reported as a link to a directory.
    await expect(PackageExec.plan(options)).rejects.toMatchObject({ code: "ELOOP", path: Path.join(root, "loop") })
  })

  it("keeps the read error for an S.file under a directory it cannot search", async () => {
    const { root, options } = await fixture(
      "S.Shell.Test({ shell: \"true\", sandbox: \"none\", data: [S.file(\"src/locked.txt\")] })",
      { "src/locked.txt": "locked\n" }
    )
    await Fs.chmod(Path.join(root, "src"), 0o000)
    await expect(PackageExec.plan(options)).rejects.toMatchObject({
      code: "EACCES",
      path: Path.join(root, "src", "locked.txt")
    })
  })

  it("refuses a workspace-root install with no manifest", async () => {
    const { root, options } = await fixture(
      "S.Shell.Test({ shell: \"true\", sandbox: \"none\", data: [S.nodeModules(\"//\")] })",
      { "yarn.lock": "" }
    )
    await Fs.rm(Path.join(root, "package.json"))
    await expect(PackageExec.plan(options)).rejects.toMatchObject({
      code: "install_identity_missing",
      path: "package.json",
      message: expect.stringContaining("S.nodeModules(\"//\"): the workspace root has no package.json")
    })
  })

  it("refuses a workspace-root install with no lockfile", async () => {
    const { options } = await fixture(
      "S.Shell.Test({ shell: \"true\", sandbox: \"none\", data: [S.nodeModules(\"//\")] })"
    )
    await expect(PackageExec.plan(options)).rejects.toMatchObject({
      code: "install_identity_missing",
      path: ".",
      message: expect.stringContaining("S.nodeModules(\"//\"): the workspace root has no lockfile (")
    })
  })

  it("passes a glob member's read failure through unchanged", async () => {
    const { root, options } = await fixture(
      "S.Shell.Test({ shell: \"true\", sandbox: \"none\", data: [S.glob(\"src/**\")] })",
      { "src/secret.txt": "secret\n" }
    )
    await Fs.chmod(Path.join(root, "src", "secret.txt"), 0o000)
    await expect(PackageExec.plan(options)).rejects.toMatchObject({
      code: "EACCES",
      path: Path.join(root, "src", "secret.txt")
    })
  })
})

describe("binaryIdentity without per-plan caches", () => {
  it("identifies an env shebang script and the interpreter PATH selects", async () => {
    const root = await temporary()
    await write(root, "bin/tool", "#!/usr/bin/env interp --flag\necho tool\n")
    await write(root, "path/interp", "#!/bin/sh\nexec cat\n")
    await Fs.chmod(Path.join(root, "bin/tool"), 0o755)
    await Fs.chmod(Path.join(root, "path/interp"), 0o755)
    const identity = await binaryIdentity(
      { root, toolBytes: new Map(), environment: { PATH: Path.join(root, "path") } },
      Path.join(root, "bin/tool")
    )
    expect(identity).toMatchObject({
      _tag: "Executable",
      source: "{smthrs:root}/bin/tool",
      interpreters: [
        { _tag: "Executable", source: "/usr/bin/env" },
        {
          _tag: "Executable",
          source: "{smthrs:root}/path/interp",
          interpreters: [{ _tag: "Executable", source: "/bin/sh" }]
        }
      ]
    })
  })
})

describe("installationDependencies", () => {
  it("collects installs through planned nodes and skips labels with no node", () => {
    const node = (rule: string, dependencies: ReadonlyArray<string>) =>
      ({ rule, dependencies }) as unknown as PackageNode
    const nodes = new Map<string, PackageNode>([
      ["//:b-install", node("Install", ["//:lib"])],
      ["//:lib", node("Shell.Build", ["//:a-install", "//:unplanned"])],
      ["//:a-install", node("Install", [])]
    ])
    expect(installationDependencies(["//:b-install", "//:unplanned", "//:lib"], nodes)).toEqual([
      "//:a-install",
      "//:b-install"
    ])
  })
})
