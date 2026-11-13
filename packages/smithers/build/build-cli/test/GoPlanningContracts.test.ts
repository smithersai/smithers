import { Smithers as S } from "@smthrs/targets"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as GoExec from "../src/GoExec.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const workspace = S.Workspace("go-contracts", {
  repository: "git+https://example.invalid/go-contracts.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: S.file("//package.json"), lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})
const context: GoExec.Context = {
  root: Os.tmpdir(),
  packagePath: "pkg",
  workspace,
  environment: { PATH: "/selected/bin" }
}
describe("Go planning contracts", () => {
  it.each([0, -1, NaN, Infinity, -Infinity])(
    "rejects invalid probe timeout %s before process dispatch",
    async (timeoutMs) => {
      const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "go-invalid-deadline-"))
      try {
        const marker = NodePath.join(root, "dispatched")
        const binary = await writeExecutable(
          NodePath.join(root, "go"),
          `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "dispatched")
process.exit(1)
`
        )
        await expect(GoExec.planRule("Go.Packages", { pkgs: ["./..."] }, { ...context, root, timeoutMs }, binary))
          .rejects.toThrow("Go probe timeoutMs must be positive and finite")
        expect(await Fs.access(marker).then(() => true, () => false)).toBe(false)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }
  )

  it.each(
    [
      [[], ["pkg/lint.yml"], []],
      [["generated.go", "//shared/generated.go"], ["pkg/lint.yml"], ["pkg/generated.go", "shared/generated.go"]]
    ] as const
  )("plans lint with declared changes %j", async (changes, readSet, writeSet) => {
    const attrs = {
      pkgs: ["./...", "//shared/...", "example.org/module"],
      config: S.file("lint.yml"),
      version: "2.4.0",
      changes,
      env: { CUSTOM: "kept" },
      cgo: false,
      goos: "linux",
      goarch: "arm64"
    }
    const planned = await GoExec.planRule("Go.Lint", attrs, context, "/selected/bin/go")
    expect(planned).toEqual({
      cwd: ".",
      argv: [
        "/selected/bin/go",
        "run",
        "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@2.4.0",
        "run",
        "--config",
        "pkg/lint.yml",
        ...(changes.length === 0 ? [] : ["--fix"]),
        "./pkg/...",
        "./shared/...",
        "example.org/module"
      ],
      env: { CUSTOM: "kept", CGO_ENABLED: "0", GOOS: "linux", GOARCH: "arm64" },
      outDirs: [],
      readSet,
      writeSet
    })
  })

  it.each([
    ["requires nothing", "", [".gomodcache"]],
    ["only mentions a requirement in a comment", "// require example.org/dependency v1.0.0\n", [".gomodcache"]],
    ["requires a module", "\nrequire example.org/dependency v1.0.0\n", undefined],
    ["requires a block of modules", "\nrequire (\n\texample.org/dependency v1.0.0\n)\n", undefined],
    ["is missing", undefined, undefined]
  ])("admits an empty module cache only when go.mod %s", async (_, requirements, expected) => {
    const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "go-download-contract-"))
    try {
      if (requirements !== undefined) {
        await Fs.writeFile(NodePath.join(root, "go.mod"), `module example.org/probe\n\ngo 1.21\n${requirements}`)
      }
      const planned = await GoExec.planRule(
        "Go.ModDownload",
        { outDirs: [".gomodcache"] },
        { ...context, root, packagePath: "" },
        "/selected/bin/go"
      )
      expect(planned.outDirs).toEqual([".gomodcache"])
      expect(planned.emptyOutDirs).toEqual(expected)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it("uses the declared module fetch cache only for an offline plan", async () => {
    const download = S.Go.ModDownload({
      mod: S.file("//go.mod"),
      sum: S.file("//go.sum"),
      outDirs: ["//cache/modules"]
    })
    const attrs = {
      pkgs: ["./..."],
      config: S.file("lint.yml"),
      version: "2.4.0",
      data: [download],
      env: { CUSTOM: "kept", GOFLAGS: "-tags=custom" }
    }
    const online = await GoExec.planRule("Go.Lint", attrs, context, "/selected/bin/go")
    const offline = await GoExec.planRule("Go.Lint", { ...attrs, offline: true }, context, "/selected/bin/go")
    expect(online.env).toEqual({ CUSTOM: "kept", GOFLAGS: "-tags=custom" })
    // targets/docs/guides/go.md: offline appends -mod=readonly to the declared GOFLAGS.
    expect(offline.env).toEqual({
      CUSTOM: "kept",
      GOFLAGS: "-tags=custom -mod=readonly",
      GOPROXY: "off",
      GOMODCACHE: "cache/modules"
    })
    expect(offline.argv).toEqual(online.argv)
    expect(offline.readSet).toEqual(["pkg/lint.yml"])
  })
})
