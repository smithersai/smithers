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
const hasDocker = NodeChildProcess.spawnSync("sh", ["-c", "command -v docker && docker info"], { stdio: "ignore" })
  .status === 0

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
