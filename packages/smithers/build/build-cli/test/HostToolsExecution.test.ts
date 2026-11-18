/**
 * A shell target finds the host's tools by name, end to end.
 *
 * Each case builds a home directory with real directories and links, puts one
 * of its tool directories on `PATH`, and runs a `Shell` target through the
 * `PACKAGE.ts` surface under the host's own confinement. The tool answers
 * inside the target, the rest of the home stays unreadable, and the target's
 * key follows the tools its command names.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { openPackageIndex } from "../src/Cli.ts"
import * as HostTools from "../src/internal/HostTools.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const temporary = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

const program = async (path: string, body: string): Promise<void> => {
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/** A home with a Node-shaped installation per version, a Volta-shaped shim, and a file no target may read. */
const home = async (): Promise<string> => {
  const directory = await temporary("smthrs-tools-home-")
  for (const version of ["20", "22"]) {
    const prefix = NodePath.join(directory, `.local/node-${version}`)
    await program(NodePath.join(prefix, "bin/node"), `echo node-${version}`)
    await program(
      NodePath.join(prefix, "lib/node_modules/npm/bin/npm-cli.js"),
      `echo npm-of-${version} $(cat "$(dirname "$(readlink -f "$0")")/../lib/cli.txt")`
    )
    await write(prefix, "lib/node_modules/npm/lib/cli.txt", "cli")
    await write(prefix, "lib/node_modules/npm/package.json", JSON.stringify({ name: "npm" }))
    await Fs.symlink("../lib/node_modules/npm/bin/npm-cli.js", NodePath.join(prefix, "bin/npm"))
  }
  await program(
    NodePath.join(directory, ".volta/bin/volta-shim"),
    "exec \"$HOME/.volta/tools/image/node/$(cat \"$HOME/.volta/tools/user/platform.json\")/bin/node\""
  )
  await Fs.symlink("volta-shim", NodePath.join(directory, ".volta/bin/voltanode"))
  await write(directory, ".volta/tools/user/platform.json", "22.1.0")
  await program(NodePath.join(directory, ".volta/tools/image/node/22.1.0/bin/node"), "echo node-volta")
  // A program whose interpreter this machine does not have.
  await Fs.mkdir(NodePath.join(directory, "odd/bin"), { recursive: true })
  await Fs.writeFile(NodePath.join(directory, "odd/bin/oddtool"), "#!/usr/bin/env no-such-interpreter-here\n", {
    mode: 0o755
  })
  await write(directory, ".secret", "private")
  return directory
}

const workspace = async (targets: string, sandboxes = ""): Promise<string> => {
  const root = await temporary("smthrs-tools-ws-")
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
${sandboxes}
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { ${targets} } })\n`
  )
  NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
  NodeChildProcess.execFileSync("git", ["-C", root, "add", "-A"])
  NodeChildProcess.execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=t@t.t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init"
  ])
  return root
}

const systemPath = "/usr/bin:/bin"

/** Runs `body` with the process's `HOME` and `PATH` set, as a person's shell would have them. */
const withHome = async <A>(
  directory: string,
  tools: ReadonlyArray<string>,
  body: () => Promise<A>
): Promise<A> => {
  const previous = { HOME: process.env["HOME"], PATH: process.env["PATH"] }
  // The sandbox's own program keeps the place this machine has it.
  const mechanism = NodeChildProcess.spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout.trim()
  const mechanismPath = mechanism === "" || mechanism.startsWith("/usr/") ? "" : `:${NodePath.dirname(mechanism)}`
  process.env["HOME"] = directory
  process.env["PATH"] = [...tools.map((tool) => NodePath.join(directory, tool)), systemPath].join(":") + mechanismPath
  try {
    return await body()
  } finally {
    process.env["HOME"] = previous.HOME
    process.env["PATH"] = previous.PATH
  }
}

const keyOf = async (root: string, label: string): Promise<string> => {
  const index = await openPackageIndex({ workspace: root })
  const planned = await PackageExec.plan({
    index,
    cacheDirectory: ".flows",
    verb: "auto" as const,
    // Every target of the package, so two shell targets share one reading of PATH.
    patterns: ["//..."],
    readCache: false
  })
  return JSON.stringify(planned.nodes.get(label)!.keyMaterial)
}

const native = process.platform === "darwin" || process.platform === "linux"

describe.runIf(native)("a shell target and the tools on PATH", () => {
  it("runs a tool under the home directory that the command does not name first, with its install root", async () => {
    const directory = await home()
    const root = await workspace(`
      tools: S.Shell.Run({ shell: "bash -e -c 'node; npm'" }),
      secret: S.Shell.Run({ shell: "cat ${directory}/.secret" })
    `)
    await withHome(directory, [".local/node-22/bin"], async () => {
      const ran = await serve(root, ["//:tools"])
      expect(ran.exitCode, ran.logs).toBe(0)
      expect(ran.logs).toContain("node-22")
      expect(ran.logs).toContain("npm-of-22 cli")
      const secret = await serve(root, ["//:secret"])
      expect(secret.exitCode).toBe(1)
      expect(secret.logs).not.toContain("private")
    })
  })

  it("runs a version manager's shim, which finds its home under the run's private one", async () => {
    const directory = await home()
    const root = await workspace(`shim: S.Shell.Run({ shell: "voltanode" })`)
    await withHome(directory, [".volta/bin"], async () => {
      const ran = await serve(root, ["//:shim"])
      expect(ran.exitCode, ran.logs).toBe(0)
      expect(ran.logs).toContain("node-volta")
    })
  })

  it("keys a target by the tools its command names: another version or another default is another key", async () => {
    const directory = await home()
    const root = await workspace(`
      test: S.Shell.Test({ shell: "bash -e -c 'cd . && npm test'" }),
      other: S.Shell.Test({ shell: "true" }),
      computed: S.Shell.Test({ shell: '"$TOOL" build' })
    `)
    const withNode = (version: string) =>
      withHome(directory, [`.local/node-${version}/bin`, ".volta/bin", "odd/bin"], () => keyOf(root, "//:test"))
    const twenty = await withNode("20")
    expect(await withNode("20")).toBe(twenty)
    const twentyTwo = await withNode("22")
    expect(twentyTwo).not.toBe(twenty)
    // The tool the text names is keyed by its bytes, through the shell that runs it.
    expect(twenty).toContain(NodePath.join(directory, ".local/node-20/lib/node_modules/npm/bin/npm-cli.js"))
    expect(twentyTwo).toContain(NodePath.join(directory, ".local/node-22/lib/node_modules/npm/bin/npm-cli.js"))
    // A target whose text names none of them keeps its key when the tools on PATH change.
    const other = (version: string) =>
      withHome(directory, [`.local/node-${version}/bin`], () => keyOf(root, "//:other"))
    expect(await other("22")).toBe(await other("20"))
    // The file that chooses a shim's version is keyed by its bytes.
    await write(directory, ".volta/tools/user/platform.json", "20.0.0")
    expect(await withNode("22")).not.toBe(twentyTwo)
  })

  it("plans a command that names a program it cannot identify, and leaves that program to the run", async () => {
    const directory = await home()
    const root = await workspace(`odd: S.Shell.Test({ shell: "true && oddtool" })`)
    await withHome(directory, ["odd/bin"], async () => {
      expect(await keyOf(root, "//:odd")).toContain("true && oddtool")
    })
  })

  it("leads a failure with the name of the tool that is not installed", async () => {
    const directory = await home()
    const root = await workspace(`missing: S.Shell.Run({ shell: "bash -e -c 'no-such-tool-here --version'" })`)
    await withHome(directory, [".local/node-22/bin"], async () => {
      const ran = await serve(root, ["//:missing"])
      expect(ran.exitCode).toBe(1)
      expect(ran.logs).toContain(
        "no-such-tool-here: not found. No directory on PATH holds no-such-tool-here; " +
          "install it or add its directory to PATH (exit 127)"
      )
    })
  })

  it("leaves the tools to the image when the workspace confines with Docker", async () => {
    const directory = await home()
    const root = await workspace(
      `test: S.Shell.Test({ shell: "npm test" })`,
      `sandboxes: S.Sandboxes({ default: S.Sandbox.Docker({ image: "node:22" }) }),`
    )
    await withHome(directory, [".local/node-22/bin"], async () => {
      const index = await openPackageIndex({ workspace: root })
      const planned = await PackageExec.plan({
        index,
        cacheDirectory: ".flows",
        verb: "auto" as const,
        patterns: ["//:test"],
        readCache: false
      })
      const node = planned.nodes.get("//:test")!
      expect(node.hostTools).toBeUndefined()
      expect(JSON.stringify(node.keyMaterial)).not.toContain("ToolVersions")
    })
  })
})

describe("the tools of an environment", () => {
  it("are those of its PATH, under its HOME or this machine's", async () => {
    const directory = await home()
    const root = await temporary("smthrs-tools-ws-")
    const searchPath = NodePath.join(directory, ".volta/bin")
    const inHome = await HostTools.resolve(root, { PATH: searchPath, HOME: directory })
    expect(inHome.reads).toEqual([NodePath.join(directory, ".volta")])
    expect(inHome.privateLinks).toEqual([{ path: "home/.volta", target: NodePath.join(directory, ".volta") }])
    expect(inHome.selections).toEqual([[
      NodePath.join(directory, ".volta/tools/user/platform.json"),
      expect.stringMatching(/^[0-9a-f]{64}$/)
    ]])
    // With no HOME the machine's own home is the one credentials and shims are measured against.
    const elsewhere = await HostTools.resolve(root, { PATH: searchPath })
    expect(elsewhere.reads).toEqual([NodePath.join(directory, ".volta")])
    expect(elsewhere.privateLinks).toEqual([])
    expect(await HostTools.resolve(root, {})).toEqual({ reads: [], links: [], privateLinks: [], selections: [] })
  })
})
