import { describe, expect, it } from "vitest"
import * as Agent from "../src/AgentTarget.ts"
import * as Bundler from "../src/BundlerTarget.ts"
import * as Cargo from "../src/Cargo.ts"
import * as Foundry from "../src/Foundry.ts"
import * as NewPackage from "../src/NewPackage.ts"
import * as Owners from "../src/Owners.ts"
import * as Reference from "../src/Reference.ts"
import * as Shell from "../src/Shell.ts"
import * as S from "../src/Smithers.ts"
import * as Target from "../src/Target.ts"
import { plannedArgv, plannedCalls } from "./plan.ts"

const manifest = S.file("package.json")
const build = S.Shell.Build({ shell: "true", outDirs: ["dist"] })

describe("package-executor declarations require their owning executor", () => {
  const cases: ReadonlyArray<readonly [string, () => Target.AnyTarget]> = [
    ["Cargo.Fetch", () => Cargo.Fetch({ outDirs: [".cargo"] })],
    ["Cargo.Build", () => Cargo.Build({ workspace: true, data: [] })],
    ["Cargo.Test", () => Cargo.Test({ workspace: true, data: [] })],
    ["Cargo.Nextest", () => Cargo.Nextest({ workspace: true, data: [] })],
    ["Cargo.Deny", () => Cargo.Deny({ config: S.file("deny.toml") })],
    ["Cargo.Clippy", () => Cargo.Clippy({ workspace: true, data: [] })],
    ["Cargo.Fmt", () => Cargo.Fmt({ workspace: true, changes: ["src/**"] })],
    ["Go.Test", () => S.Go.Test({ pkgs: ["./..."] })],
    ["Go.Binary", () => S.Go.Binary({ pkg: "./cmd/tool", out: "bin/tool" })],
    ["Go.ModDownload", () => S.Go.ModDownload({ mod: S.file("go.mod"), sum: S.file("go.sum"), outDirs: [".go"] })],
    ["Go.Lint", () => S.Go.Lint({ config: S.file("lint.yml"), version: "1", pkgs: ["./..."] })],
    ["Go.Fuzz", () => S.Go.Fuzz({ pkg: ".", fuzz: "FuzzDecode", time: "1s" })],
    ["Copy", () => S.Copy({ from: manifest, to: "out/package.json" })],
    ["Literal", () => S.Literal({ path: "out/value", content: "value" })],
    ["Overlay", () => S.Overlay({ base: build, replace: { "package.json": manifest } })],
    ["Markdown.CodeBlocks", () => S.Markdown.CodeBlocks({ file: S.file("README.md"), lang: ["ts"] })],
    ["Npm.Pack", () => S.Npm.Pack({ manifest })],
    ["Npm.Publish", () => S.Npm.Publish({ pack: build, gates: [] })],
    ["Npm.Published", () => S.Npm.Published({ manifest })],
    [
      "Changesets.Version",
      () => S.Changesets.Version({ config: S.file(".changeset/config.json"), changes: ["package.json"] })
    ],
    ["Git.Commit", () => S.Git.Commit({ gates: [], message: "chore: check" })],
    ["Git.Pr", () => S.Git.Pr({ gates: [] })],
    ["Github.Workflow", () => S.Github.Workflow({ name: "test", on: { push: { branches: ["main"] } }, run: [] })],
    ["Github.CiGen", () => S.Github.CiGen({ workflows: [] })],
    ["Github.Pr", () => S.Github.Pr({ gates: [] })],
    ["Github.Pages", () => S.Github.Pages({ site: build })],
    ["Github.Release", () => S.Github.Release({ manifest, notes: "release", gates: [] })],
    ["Docker.Serve", () => S.Docker.Serve({ image: "postgres:18" })],
    ["Docker.Service", () => S.Docker.Service({ image: "postgres:18" })],
    ["Memory.Retain", () => S.Memory.Retain({ source: Reference.gitCommit("HEAD"), tags: ["tested"] })],
    ["Owners.Codeowners", () => Owners.Codeowners({ org: "example" })],
    ["Owners.Tree", () => Owners.Tree({})],
    ["Cron", () => S.Cron({ schedule: "0 0 * * *", run: [build] })]
  ]
  it.each(cases)("%s explicitly refuses a bare flow host", (name, make) => {
    expect(plannedCalls(make())).toEqual([
      { action: "smithers-build/not-implemented", payload: { target: name } }
    ])
  })
})

describe("Foundry plans the requested forge operation", () => {
  it("builds with declared skips and defaults to no skips", () => {
    expect(plannedArgv(Foundry.Build({ outDirs: ["out"], skip: ["test"] }))).toEqual([
      Shell.toolToken(Reference.hostBin("forge")),
      "build",
      "test"
    ])
    expect(plannedArgv(Foundry.Build({ outDirs: ["out"] }))).toEqual([
      Shell.toolToken(Reference.hostBin("forge")),
      "build"
    ])
  })
  it("tests and format-checks without writing", () => {
    expect(plannedArgv(Foundry.Test({}))).toEqual([Shell.toolToken(Reference.hostBin("forge")), "test"])
    expect(plannedArgv(Foundry.Fmt({ changes: ["src/**"] }))).toEqual([
      Shell.toolToken(Reference.hostBin("forge")),
      "fmt",
      "--check"
    ])
  })
})

it("plans bundler graph resolution against the declared config and entries", () => {
  const calls = plannedCalls(
    Bundler.Rspack({ config: S.file("//rspack.config.ts") }).resolve({ entries: ["src/index.ts"], universe: [] })
  )
  expect(calls).toEqual([{
    action: "smithers-build/bundler-resolve",
    payload: { configPath: "rspack.config.ts", entries: ["src/index.ts"], mode: "development" }
  }])
})

it("plans agent lint over the declared prompt, diff and repair paths", () => {
  const calls = plannedCalls(Agent.Lint({ prompt: S.file("review.md"), data: [S.gitDiff()], fixes: ["src/**"] }))
  expect(calls[0]?.action).toBe("smithers-build/agent-lint")
  expect(calls[0]?.payload).toMatchObject({ promptPath: "review.md", fixes: ["src/**"], mode: "check" })
})

it("plans a new package with the declared license and TypeScript parent", () => {
  const calls = plannedCalls(NewPackage.NewPackage({ license: "MIT", tsconfigExtends: "../../base.json" }))
  expect(calls).toEqual([{
    action: "smithers-build/scaffold-package",
    payload: { directory: "packages", version: "0.1.0", license: "MIT", fields: {}, tsconfigExtends: "../../base.json" }
  }])
})
