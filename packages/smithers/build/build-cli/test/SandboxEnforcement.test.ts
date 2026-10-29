/**
 * Enforcement, end to end, on the host's own mechanism.
 *
 * Every case here spawns a real tool under the real confinement (bubblewrap
 * on Linux, seatbelt on macOS) through the `PACKAGE.ts` surface, and asserts
 * the kernel's answer: an undeclared read is missing or refused, an undeclared
 * write fails, egress is closed, and a host that cannot enforce a declared
 * confinement fails the target closed instead of running it unconfined.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { openPackageIndex } from "../src/Cli.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { dockerAvailable } from "./helpers/DockerProbe.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspaceModule = (extra = ""): string =>
  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
${extra}
})
`

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const commitAll = (root: string): void => {
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
}

const temporaryWorkspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-sandbox-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "")
  return root
}

/** Runs `body` with `PATH` reduced to one directory holding only the named tools. */
const withBarePath = async <A>(tools: ReadonlyArray<string>, body: () => Promise<A>): Promise<A> => {
  const bin = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-bare-bin-"))
  temporaryDirectories.push(bin)
  for (const tool of tools) {
    const found = NodeChildProcess.execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim()
    await Fs.symlink(found, NodePath.join(bin, NodePath.basename(tool)))
  }
  const previous = process.env["PATH"]
  process.env["PATH"] = bin
  try {
    return await body()
  } finally {
    process.env["PATH"] = previous
  }
}

const native = process.platform === "darwin" || process.platform === "linux"
const hasBwrap = process.platform !== "linux" ||
  NodeChildProcess.spawnSync("sh", ["-c", "command -v bwrap"]).status === 0
const hasDocker = native && dockerAvailable()

describe.runIf(native)("sandbox enforcement", () => {
  it("is enforced on this host: a Linux runner without bwrap is a red run, not a warning", () => {
    expect(hasBwrap).toBe(true)
  })

  it("denies an undeclared read and admits a declared one", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "secret.txt", "s3cret")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const undeclared = S.Shell.Run({ shell: "cat secret.txt" })
const declared = S.Shell.Run({ shell: "cat secret.txt", data: [S.file("secret.txt")] })
export const Package = S.Package({ targets: { undeclared, declared } })
`
    )
    commitAll(root)
    const refused = await serve(root, ["//:undeclared"])
    expect(refused.exitCode).toBe(1)
    expect(refused.logs).toMatch(/secret\.txt/)
    expect(refused.logs).toMatch(
      /sandbox: secret\.txt is outside the declared read set|Operation not permitted|No such file/
    )
    const admitted = await serve(root, ["//:declared"])
    expect(admitted.exitCode, admitted.logs).toBe(0)
  })

  it("seals an empty scratch result cache without exposing or changing real cached results", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "out.txt", "unchanged")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const check = S.Shell.Diff({ shell: "test -d .flows/cache && test ! -e .flows/cache/canary", changes: ["out.txt"] })
const tamper = S.Shell.Diff({ shell: "printf tampered > .flows/cache/canary", changes: ["out.txt"] })
export const Package = S.Package({ targets: { check, tamper } })
`
    )
    commitAll(root)
    await write(root, ".flows/cache/canary", "real cached result")
    const checked = await serve(root, ["//:check"])
    expect(checked.exitCode, checked.logs).toBe(0)
    const refused = await serve(root, ["//:tamper"])
    expect(refused.exitCode).toBe(1)
    expect(refused.logs).toMatch(/Operation not permitted|Read-only file system/)
    expect(await Fs.readFile(NodePath.join(root, ".flows/cache/canary"), "utf8")).toBe("real cached result")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("unchanged")
  })

  it.each(["real", "scratch"])("admits only the declared dependency installation in the %s tree", async (tree) => {
    const root = await temporaryWorkspace()
    const installation = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-installed-"))
    temporaryDirectories.push(installation)
    await write(installation, "node_modules/fixture.txt", "dependency\n")
    await write(installation, "private.txt", "private sibling")
    await Fs.symlink(NodePath.join(installation, "node_modules"), NodePath.join(root, "node_modules"), "dir")
    await Fs.symlink(installation, NodePath.join(root, "leak"), "dir")
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "out.txt", "unchanged")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const read = S.Shell.${tree === "scratch" ? "Diff" : "Run"}({
  shell: "grep -qx dependency node_modules/fixture.txt",
  ${tree === "scratch" ? "changes: [\"out.txt\"]," : ""}
})
const leak = S.Shell.Run({ shell: "cat leak/private.txt", data: [S.file("leak/private.txt")] })
export const Package = S.Package({ targets: { read, leak } })
`
    )
    commitAll(root)
    const admitted = await serve(root, ["//:read"])
    expect(admitted.exitCode, admitted.logs).toBe(0)
    const refused = await serve(root, ["//:leak"])
    expect(refused.exitCode).toBe(1)
    expect(refused.output + refused.logs).toMatch(/outside|symlink/)
    expect(refused.output + refused.logs).not.toContain("private sibling")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("unchanged")
  })

  it("does not admit a linked installation without a dependency declaration", async () => {
    const root = await temporaryWorkspace()
    const installation = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-undeclared-install-"))
    temporaryDirectories.push(installation)
    await write(installation, "fixture.txt", "dependency\n")
    await Fs.symlink(installation, NodePath.join(root, "node_modules"), "dir")
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("no-node-dependencies", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [S.Rust.Toolchain({
    workspace: S.file("//Cargo.toml"), toolchain: S.file("//rust-toolchain.toml"), lockfile: S.file("//Cargo.lock")
  })]
})
`
    )
    await write(root, "Cargo.toml", "[workspace]\nmembers = []\nresolver = \"3\"\n")
    await write(root, "Cargo.lock", "version = 4\n")
    await write(root, "rust-toolchain.toml", "[toolchain]\nchannel = \"1.98.0\"\n")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { read: S.Shell.Run({ shell: "cat node_modules/fixture.txt" }) } })
`
    )
    commitAll(root)
    const refused = await serve(root, ["//:read"])
    expect(refused.exitCode).toBe(1)
    expect(refused.logs).toContain("resolves outside")
  })

  it.each(["Run", "Diff"])("refuses a dependency installation replaced after planning a %s", async (rule) => {
    const root = await temporaryWorkspace()
    const external = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-replaced-install-"))
    temporaryDirectories.push(external)
    await write(root, "node_modules/fixture.txt", "approved")
    await write(external, "fixture.txt", "unapproved host data")
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(root, "out.txt", "unchanged")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { read: S.Shell.${rule}({
  shell: "cat node_modules/fixture.txt", ${rule === "Diff" ? "changes: [\"out.txt\"]" : ""}
}) } })
`
    )
    commitAll(root)
    const index = await openPackageIndex({ workspace: root })
    const options = { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: ["//:read"], readCache: false }
    const planned = await PackageExec.plan(options)
    await Fs.rename(NodePath.join(root, "node_modules"), NodePath.join(root, "previous-installation"))
    await Fs.symlink(external, NodePath.join(root, "node_modules"), "dir")
    const summary = await PackageExec.execute(planned, options)
    expect(summary.ok).toBe(false)
    expect(summary.results.find((entry) => entry.label === "//:read")?.error).toContain("resolves outside")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("unchanged")
  })

  it("denies an undeclared write and admits a declared output directory", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const undeclared = S.Shell.Run({ shell: "printf pwned > note.txt" })
const declared = S.Shell.Build({ shell: "mkdir -p out && printf ok > out/note.txt", outDirs: ["out"] })
export const Package = S.Package({ targets: { undeclared, declared } })
`
    )
    commitAll(root)
    const refused = await serve(root, ["//:undeclared"])
    expect(refused.exitCode).toBe(1)
    expect(refused.logs).toMatch(/note\.txt/)
    expect(refused.logs).toMatch(
      /sandbox: note\.txt is outside the declared write set|Operation not permitted|Read-only file system/
    )
    await expect(Fs.access(NodePath.join(root, "note.txt"))).rejects.toThrow()
    const admitted = await serve(root, ["//:declared"])
    expect(admitted.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out", "note.txt"), "utf8")).toBe("ok")
  })

  it("closes egress by default and opens it under { network: true }", async () => {
    const server = NodeHttp.createServer((_request, response) => response.end("ok"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    try {
      const root = await temporaryWorkspace()
      await write(root, "WORKSPACE.ts", workspaceModule())
      await write(
        root,
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const fetchCommand = "curl -sf --max-time 5 http://127.0.0.1:${port}/ > /dev/null"
const confined = S.Shell.Run({ shell: fetchCommand })
const networked = S.Shell.Run({ shell: fetchCommand, sandbox: { network: true } })
export const Package = S.Package({ targets: { confined, networked } })
`
      )
      commitAll(root)
      const confined = await serve(root, ["//:confined"])
      expect(confined.exitCode).toBe(1)
      const networked = await serve(root, ["//:networked"])
      expect(networked.exitCode).toBe(0)
    } finally {
      server.close()
    }
  })

  it("scrubs the real home and temp directory out of the confinement", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const probe = S.Shell.Run({ shell: ${
        JSON.stringify(
          `test "$HOME" != ${
            JSON.stringify(Os.homedir())
          } && test -d "$TMPDIR" && printf x > "$TMPDIR/scratch" && printf y > "$HOME/.probe"`
        )
      } })
export const Package = S.Package({ targets: { probe } })
`
    )
    commitAll(root)
    const probed = await serve(root, ["//:probe"])
    expect(probed.exitCode).toBe(0)
    await expect(Fs.access(NodePath.join(Os.homedir(), ".probe"))).rejects.toThrow()
  })

  it("fails closed when the declared mechanism is missing from the host", async () => {
    const root = await temporaryWorkspace()
    await write(
      root,
      "WORKSPACE.ts",
      workspaceModule(`  sandboxes: S.Sandboxes({ default: S.Sandbox.Docker({ image: "alpine:3.20" }) }),`)
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const confined = S.Shell.Run({ shell: "true" })
const open = S.Shell.Run({ shell: "true", sandbox: "none" })
export const Package = S.Package({ targets: { confined, open } })
`
    )
    commitAll(root)
    const { planned, refused, opened } = await withBarePath(["sh", "true", "git"], async () => ({
      planned: await serve(root, ["//:confined", "--plan"]),
      refused: await serve(root, ["//:confined"]),
      opened: await serve(root, ["//:open"])
    }))
    expect(planned.exitCode).toBe(0)
    expect(planned.output).toMatch(/sandboxEnforced:\s*false/)
    expect(refused.exitCode).toBe(1)
    expect(refused.logs).toContain("cannot be enforced")
    expect(refused.logs).toContain("docker is not on PATH")
    expect(refused.logs).toContain("sandbox: \"none\"")
    expect(refused.logs).not.toContain("unenforced")
    expect(opened.exitCode).toBe(0)
  })

  it("reports enforcement truthfully in the plan", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule())
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const confined = S.Shell.Run({ shell: "true", sandbox: {} })
const open = S.Shell.Run({ shell: "true", sandbox: "none" })
export const Package = S.Package({ targets: { confined, open } })
`
    )
    commitAll(root)
    const confined = await serve(root, ["//:confined", "--plan"])
    expect(confined.exitCode).toBe(0)
    expect(confined.output).toMatch(/sandboxEnforced:\s*true/)
    const open = await serve(root, ["//:open", "--plan"])
    expect(open.exitCode).toBe(0)
    expect(open.output).toMatch(/sandboxEnforced:\s*false/)
  })
})

describe.runIf(native && hasDocker)("docker mechanism", () => {
  it("runs a confined target in the declared image with the declared set mounted", async () => {
    const root = await temporaryWorkspace()
    await write(
      root,
      "WORKSPACE.ts",
      workspaceModule(`  sandboxes: S.Sandboxes({ default: S.Sandbox.Docker({ image: "alpine:3.20" }) }),`)
    )
    await write(root, "secret.txt", "s3cret")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const declared = S.Shell.Run({ shell: "cat secret.txt && cat /etc/alpine-release", data: [S.file("secret.txt")] })
const undeclared = S.Shell.Run({ shell: "cat secret.txt" })
const egress = S.Shell.Run({ shell: "wget -q -T 3 -O /dev/null http://example.com/", data: [] })
export const Package = S.Package({ targets: { declared, undeclared, egress } })
`
    )
    commitAll(root)
    const admitted = await serve(root, ["//:declared"])
    expect(admitted.exitCode, admitted.logs).toBe(0)
    const refused = await serve(root, ["//:undeclared"])
    expect(refused.exitCode).toBe(1)
    const closed = await serve(root, ["//:egress"])
    expect(closed.exitCode).toBe(1)
  }, 180_000)
})
