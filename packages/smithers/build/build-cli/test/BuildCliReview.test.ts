import { Smithers as S } from "@smthrs/targets"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as AnvilExec from "../src/AnvilExec.ts"
import * as HostProbes from "../src/internal/HostProbes.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import { writeExecutable } from "./helpers/Executable.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})
const temporary = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-cli-review-")))
  roots.push(root)
  return root
}

describe("workspace-relative changed paths", () => {
  it.each([false, true])("scopes paths to a nested workspace (head=%s)", async (head) => {
    const root = await temporary()
    await write(root, "sub/pkg/a.txt", "initial")
    await write(root, "pkg/a.txt", "outside")
    const jj = (...args: Array<string>) =>
      execFileSync("jj", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    jj("git", "init", "--colocate", root)
    jj("describe", "-m", "initial")
    jj("new")
    const base = jj("log", "-r", "@-", "--no-graph", "-T", "commit_id")
    await write(root, "sub/pkg/a.txt", "changed")
    await write(root, "pkg/a.txt", "outside changed")
    if (head) {
      jj("describe", "-m", "tracked changes")
      jj("new")
    }
    await write(root, "sub/pkg/new.txt", "untracked")
    await write(root, "outside.txt", "outside untracked")
    expect(await Affected.changedPaths(Path.join(root, "sub"), { base, ...(head ? { head: "HEAD" } : {}) }))
      .toEqual(head ? ["pkg/a.txt"] : ["pkg/a.txt", "pkg/new.txt"])
  })
})

describe("affected lockfile selection", () => {
  const index = (root: string) =>
    PackageIndex.make({
      root,
      workspace: S.Workspace("fixture", {
        repository: "git+https://example.invalid/fixture.git",
        cache: S.Cache({ directory: ".flows" }),
        runtime: S.Runtime.Node({ version: ">=26.4.0" }),
        packageManager: S.PackageManager.Yarn({ manifest: S.file("//package.json"), lockfile: S.file("//yarn.lock") }),
        nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
      }),
      factory: undefined,
      packages: ["pkg", "other"].map((packagePath) => ({
        file: `${packagePath}/PACKAGE.ts`,
        packagePath,
        value: S.Package({ targets: { sources: S.Filegroup({ srcs: [S.glob("src/**")] }) } })
      }))
    })
  it.each([
    "clock.ts",
    "code-block.test.tsx",
    "resource-locks.ts",
    "locksmith.ts",
    "lockfile-notes.md",
    "pnpm-lock.yaml.bak",
    "yarn.lock.old",
    "go.sum.backup",
    "bun.lockb.notes"
  ])(
    "keeps ordinary %s changes in their owning package",
    async (name) => {
      const root = await temporary()
      const file = `pkg/src/${name}`
      await write(root, file, "source")
      const result = Affected.select(index(root), ["//..."], [file], { explain: true })
      expect(result).toMatchObject({
        conservative: false,
        globalInputs: [],
        targets: [{ label: "//pkg:sources", reasons: [file] }]
      })
      expect(result.targets).toHaveLength(1)
    }
  )
  it.each([
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "Cargo.lock",
    "flake.lock",
    "go.sum",
    "custom.lock",
    ".lock"
  ])("keeps %s conservative", async (name) => {
    const root = await temporary()
    const file = `pkg/${name}`
    await write(root, file, "lockfile")
    expect(Affected.select(index(root), ["//..."], [file])).toMatchObject({
      conservative: true,
      globalInputs: [file],
      targets: [{ label: "//other:sources" }, { label: "//pkg:sources" }]
    })
  })
})

describe("Anvil planning environment", () => {
  const environmentOf = (root: string, tag: string) => ({
    PATH: [Path.join(root, "bin"), Path.dirname(process.execPath)].join(Path.delimiter),
    TOOL_TAG: tag
  })
  const tool = async (root: string, suffix = "") =>
    writeExecutable(
      Path.join(root, "bin", "anvil"),
      "#!/usr/bin/env node\n" +
        "require(\"node:fs\").appendFileSync(" + JSON.stringify(Path.join(root, "probes.jsonl")) +
        ", JSON.stringify({ tag: process.env.TOOL_TAG, secret: process.env.CACHE_WRITE_SECRET !== undefined }) + \"\\n\");\n" +
        "console.log(\"anvil 1.0.0\");\n" + suffix
    )
  it("resolves the injected PATH and separates probe environments", async () => {
    const root = await temporary()
    const path = await tool(root)
    const probes = HostProbes.make()
    const first = await AnvilExec.resolveAnvil(probes, environmentOf(root, "one"))
    expect(first).toMatchObject({ ok: true, path })
    await AnvilExec.resolveAnvil(probes, environmentOf(root, "one"))
    await AnvilExec.resolveAnvil(probes, environmentOf(root, "two"))
    expect(
      (await Fs.readFile(Path.join(root, "probes.jsonl"), "utf8")).trim().split("\n").map((row) => JSON.parse(row))
    )
      .toEqual([{ tag: "one", secret: false }, { tag: "two", secret: false }])
    expect(await AnvilExec.resolveAnvil(probes, { PATH: root }))
      .toMatchObject({ ok: false, identity: { tag: "Anvil", absent: true } })
    const spec = await AnvilExec.serviceSpec({
      label: "//:fork",
      cwd: root,
      environment: environmentOf(root, "one"),
      probes,
      attrs: { forkUrl: S.Secret("RPC"), forkBlockNumber: "latest", port: 8545 }
    })
    expect(spec).toMatchObject({
      argv: [path, "--host", "127.0.0.1", "--port", "8545", "--fork-url", "{secret-url:RPC}"]
    })
  })
  it("withholds credentials and rekeys replaced executable bytes at the same version", async () => {
    const root = await temporary()
    await tool(root)
    await write(root, "package.json", "{}")
    await write(root, "yarn.lock", "")
    const packageJson = S.file("//package.json")
    const workspace = S.Workspace("fixture", {
      repository: "git+https://example.invalid/fixture.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ version: ">=26.4.0" }),
      packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
      nodeModules: S.Npm.NodeModules({ packageJson }),
      host: S.Host({ bins: ["anvil"] }),
      sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
    })
    const index = PackageIndex.make({
      root,
      workspace,
      factory: undefined,
      packages: [{
        file: "PACKAGE.ts",
        packagePath: "",
        value: S.Package({
          targets: {
            fork: S.Anvil.Fork({ forkUrl: S.Secret("RPC"), forkBlockNumber: "latest", port: 8545 })
          }
        })
      }]
    })
    const options = {
      index,
      cacheDirectory: ".flows",
      patterns: ["//:fork"],
      verb: "run" as const,
      environment: { ...environmentOf(root, "plan"), CACHE_WRITE_SECRET: "fixture-secret" },
      remoteCache: {
        endpoint: "https://cache.example.invalid",
        enabled: false,
        credentials: { _tag: "shared" as const, tokenEnv: "CACHE_WRITE_SECRET" },
        readToken: () => undefined,
        writeToken: () => undefined,
        publishNamespace: undefined
      }
    }
    const before = (await PackageExec.plan(options)).nodes.get("//:fork")!
    expect(before.refusal).toBeUndefined()
    await tool(root, "// changed executable bytes\n")
    const after = (await PackageExec.plan(options)).nodes.get("//:fork")!
    expect(after.refusal).toBeUndefined()
    expect(after.keyPreview).not.toEqual(before.keyPreview)
    expect(
      (await Fs.readFile(Path.join(root, "probes.jsonl"), "utf8")).trim().split("\n").map((row) => JSON.parse(row))
    )
      .toEqual([{ tag: "plan", secret: false }, { tag: "plan", secret: false }])
  })
})
