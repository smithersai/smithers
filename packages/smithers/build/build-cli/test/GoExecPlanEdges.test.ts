/**
 * Go planning edges against a recording `go` stand-in: list rows that name no
 * import path, a probe environment with unset names, the owned compile cache
 * when the caller supplies no environment, offline fetch edges that name no
 * module download, and patterns that escape a root module.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GoExec from "../src/GoExec.ts"
import * as GoCache from "../src/internal/GoCache.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const workspace = S.Workspace("go-plan-edges", {
  repository: "git+https://example.invalid/go-plan-edges.git",
  cache: S.Cache({ directory: ".flows" })
})

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

interface Call {
  readonly args: ReadonlyArray<string>
  readonly gocache: string | null
  readonly unset: boolean
}

/** A module root with one package `a` and a `go` that answers `list` and logs each call. */
const fixture = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-plan-edges-")))
  roots.push(root)
  await Fs.mkdir(NodePath.join(root, "a"))
  await Fs.writeFile(NodePath.join(root, "a", "a.go"), "package a\n")
  const log = NodePath.join(root, "calls.jsonl")
  const go = await writeExecutable(
    NodePath.join(root, "bin", "go"),
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args,
  gocache: process.env.GOCACHE ?? null,
  unset: !("SMTHRS_UNSET" in process.env)
}) + "\\n")
if (args[0] === "list" && args.includes("-deps")) {
  process.stdout.write(JSON.stringify({ ImportPath: "example.org/m/a", Dir: ${
      JSON.stringify(NodePath.join(root, "a"))
    }, GoFiles: ["a.go"] }))
} else if (args[0] === "list") {
  // A pattern error row carries a directory but no import path.
  process.stdout.write(JSON.stringify({ ImportPath: "example.org/m/a" }) + JSON.stringify({ Dir: "/nowhere" }))
}
`
  )
  const calls = async (): Promise<ReadonlyArray<Call>> =>
    (await Fs.readFile(log, "utf8")).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line))
  return { root, go, calls }
}

const environment = { PATH: process.env["PATH"], SMTHRS_UNSET: undefined }

describe("GoExec.planRule edges", () => {
  it("keeps only rows with an import path and omits unset environment names from the probe", async () => {
    const { root, go, calls } = await fixture()
    const planned = await GoExec.planRule(
      "Go.Packages",
      { pkgs: ["./a"] },
      { root, packagePath: "", workspace, environment },
      go
    )
    expect(planned.readSet).toEqual(["a/a.go"])
    expect(planned.closureIdentity).toMatchObject({ packages: ["example.org/m/a"] })
    const recorded = await calls()
    expect(recorded.map((call) => call.args)).toEqual([
      ["list", "-json", "./a"],
      ["list", "-deps", "-test", "-json", "example.org/m/a"]
    ])
    expect(recorded.every((call) => call.unset && call.gocache === null)).toBe(true)
  })

  it("points the probe at the owned compile cache from the process environment when none is supplied", async () => {
    const { root, go, calls } = await fixture()
    const planned = await GoExec.planRule(
      "Go.Generate",
      { pkgs: ["./a"] },
      { root, packagePath: "", workspace, cacheDirectory: ".flows" },
      go
    )
    // No declared changes: generate writes nothing the plan admits.
    expect(planned).toMatchObject({ argv: [go, "generate", "example.org/m/a"], writeSet: [], readSet: ["a/a.go"] })
    const expected = GoCache.directory(root, ".flows", process.env)
    expect((await calls()).map((call) => call.gocache)).toEqual([expected, expected])
  })

  it("builds a binary whose output names the module directory itself", async () => {
    const { root, go } = await fixture()
    const planned = await GoExec.planRule(
      "Go.Binary",
      { pkg: "./a", out: "." },
      { root, packagePath: "", workspace, environment },
      go
    )
    expect(planned.argv).toEqual([go, "build", "-buildvcs=false", "-o", ".", "./a"])
  })

  it("plans offline without a fetched cache when no data edge is a module download", async () => {
    const planned = await GoExec.planRule(
      "Go.Lint",
      {
        pkgs: ["./..."],
        config: S.file("lint.yml"),
        version: "2.4.0",
        offline: true,
        data: [
          "notes.txt",
          { _tag: "TargetFiles", target: { name: "not a target" } },
          { _tag: "TargetFiles", target: S.Go.Packages({ pkgs: ["./..."] }) }
        ]
      },
      { root: Os.tmpdir(), packagePath: "", workspace, environment },
      "/unused/go"
    )
    expect(planned.refusal).toBeUndefined()
    expect(planned.env).toEqual({ GOPROXY: "off", GOFLAGS: "-mod=readonly" })
  })

  it("refuses a pattern above a module at the workspace root, naming the root as \".\"", async () => {
    await expect(GoExec.planRule(
      "Go.Lint",
      { pkgs: ["./../../outside/..."], config: S.file("lint.yml"), version: "2.4.0" },
      { root: Os.tmpdir(), packagePath: "pkg", workspace, environment },
      "/unused/go"
    )).rejects.toThrow("package pattern \"./../../outside/...\" is outside the module at \".\"")
  })
})
