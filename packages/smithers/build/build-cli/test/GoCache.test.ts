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
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const temporary = async (prefix: string): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  roots.push(root)
  return root
}

const action = (shard: string, fill: string): string => `${shard}/${shard}${fill.repeat(62)}-a`
const output = (shard: string, fill: string): string => `${shard}/${shard}${fill.repeat(62)}-d`

describe("the owned Go compile cache", () => {
  it("puts GOCACHE inside the workspace cache directory for every spawned tool", () => {
    expect(GoCache.directory("/work", "./.flows/")).toBe(NodePath.join("/work", ".flows", "go-build"))
    expect(GoCache.spawnEnvironment({ CGO_ENABLED: "0" }, "/work", ".flows")).toEqual({
      CGO_ENABLED: "0",
      GOCACHE: NodePath.join("/work", ".flows", "go-build")
    })
  })

  it("leaves a GOCACHE the target declared for itself", () => {
    expect(GoCache.spawnEnvironment({ GOCACHE: "/declared" }, "/work", ".flows")).toEqual({ GOCACHE: "/declared" })
  })

  it("reports an absent cache as empty without creating it", async () => {
    const root = await temporary("smthrs-go-cache-")
    expect(await GoCache.status(root, ".flows")).toEqual({
      directory: NodePath.join(root, ".flows", "go-build"),
      exists: false,
      entries: 0,
      bytes: 0
    })
    await expect(Fs.stat(NodePath.join(root, ".flows"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("counts compile results and nothing else go keeps beside them", async () => {
    const root = await temporary("smthrs-go-cache-")
    const cache = ".flows/go-build"
    await write(root, `${cache}/${action("ab", "0")}`, "v1 action\n")
    await write(root, `${cache}/${output("cd", "1")}`, "object")
    // go's own bookkeeping, its fuzz corpus, and files that are not in the
    // shard a compile result lives in.
    await write(root, `${cache}/README`, "This directory holds cached build artifacts")
    await write(root, `${cache}/trim.txt`, "1700000000")
    await write(root, `${cache}/fuzz/example.test/FuzzValue/seed`, "go test fuzz v1")
    await write(root, `${cache}/ab/notes.txt`, "stray")
    await write(root, `${cache}/ab/${"cd"}${"0".repeat(62)}-a`, "wrong shard")
    await write(root, `${cache}/abc/${"abc"}${"0".repeat(61)}-a`, "wrong shard width")
    await Fs.symlink(
      NodePath.join(root, cache, action("ab", "0")),
      NodePath.join(root, cache, "ab", `ab${"f".repeat(62)}-d`)
    )
    const listed = await GoCache.entries(root, ".flows")
    expect(listed.map((entry) => NodePath.relative(NodePath.join(root, cache), entry.path))).toEqual([
      action("ab", "0"),
      output("cd", "1")
    ])
    expect(await GoCache.status(root, ".flows")).toMatchObject({ exists: true, entries: 2, bytes: 16 })
  })

  it("refuses a cache directory that is a link out of the workspace", async () => {
    const root = await temporary("smthrs-go-cache-")
    const outside = await temporary("smthrs-go-cache-outside-")
    await write(outside, action("ab", "0"), "another machine's cache")
    await Fs.mkdir(NodePath.join(root, ".flows"))
    await Fs.symlink(outside, NodePath.join(root, ".flows", "go-build"))
    await expect(GoCache.entries(root, ".flows")).rejects.toThrow("not a plain directory")
  })

  it("refuses a cache directory that is a file", async () => {
    const root = await temporary("smthrs-go-cache-")
    await write(root, ".flows", "a file where the cache directory belongs")
    await expect(GoCache.entries(root, ".flows")).rejects.toThrow("not a plain directory")
  })

  it.runIf(process.getuid?.() !== 0)(
    "surfaces a cache directory it may not read instead of calling it empty",
    async () => {
      const root = await temporary("smthrs-go-cache-")
      await Fs.mkdir(NodePath.join(root, ".flows"))
      await Fs.chmod(NodePath.join(root, ".flows"), 0o000)
      try {
        await expect(GoCache.status(root, ".flows")).rejects.toMatchObject({ code: "EACCES" })
      } finally {
        await Fs.chmod(NodePath.join(root, ".flows"), 0o700)
      }
    }
  )
})

const hasGo = PackageTree.findOnPath("go") !== undefined

describe.runIf(hasGo)("a Go target's compile cache", () => {
  it("fills the workspace's cache, not the host's, and cache status measures it", async () => {
    const root = await temporary("smthrs-go-cache-run-")
    const host = await temporary("smthrs-go-cache-host-")
    await write(root, "go.mod", "module example.test/owned\n\ngo 1.24\n")
    await write(root, "go.sum", "")
    await write(root, "lib/lib.go", "package lib\nfunc Value() string { return \"ok\" }\n")
    await write(
      root,
      "lib/lib_test.go",
      "package lib\nimport \"testing\"\nfunc TestValue(t *testing.T) { if Value() != \"ok\" { t.Fatal(Value()) } }\n"
    )
    await write(root, "flake.nix", "{}\n")
    await write(root, "flake.lock", "{}\n")
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const nix = S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
const go = S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: nix, cgo: false })
export const Workspace = S.Workspace("owned", { repository: "git+https://example.test/owned.git", cache: S.Cache({ directory: ".flows" }), toolchains: [nix, go] })
`
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  test: S.Go.Test({ pkgs: ["./lib"] }),
  shell: S.Shell.Test({ shell: ${JSON.stringify(`test "$GOCACHE" = '${GoCache.directory(root, ".flows")}'`)} }),
  declared: S.Shell.Test({ shell: "test \\"$GOCACHE\\" = /declared/by/the/target", env: { GOCACHE: "/declared/by/the/target" } }),
  control: S.Shell.Test({ shell: "test \\"$GOCACHE\\" = /somewhere/else" })
} })
`
    )
    NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
    // The host names its own compile cache; the target must not compile into it.
    const environment = { ...process.env, GOCACHE: GoCache.directory(host, ".flows") }
    const before = await serve(root, ["cache", "status", "--format", "json"], { environment })
    expect(JSON.parse(before.output).goBuild, before.output + before.logs).toMatchObject({
      exists: false,
      entries: 0,
      bytes: 0
    })
    const tested = await serve(root, ["//:test"], { environment })
    expect(tested.exitCode, tested.logs + tested.output).toBe(0)
    expect(tested.logs).toContain("//:test  ran")
    const owned = await GoCache.entries(root, ".flows")
    expect(owned.length).toBeGreaterThan(0)
    expect(await GoCache.entries(host, ".flows")).toEqual([])
    // A shell command that runs go compiles into the same cache, a
    // declaration that names its own keeps it, and the comparison can fail.
    for (const label of ["//:shell", "//:declared"]) {
      const ran = await serve(root, [label], { environment })
      expect(ran.exitCode, ran.logs).toBe(0)
    }
    expect((await serve(root, ["//:control"], { environment })).exitCode).toBe(1)
    const after = await serve(root, ["cache", "status", "--format", "json"], { environment })
    expect(JSON.parse(after.output).goBuild).toEqual({
      directory: NodePath.join(root, ".flows", "go-build"),
      exists: true,
      entries: owned.length,
      bytes: owned.reduce((sum, entry) => sum + entry.bytes, 0)
    })
  }, 120_000)
})
