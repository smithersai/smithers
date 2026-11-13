/**
 * The inert `--plan` report of cargo targets.
 *
 * A cargo node that runs one command reports it as `argv`; a node whose lane
 * runs one command per crate has no single argv, so the report lists every
 * command instead. Either way the reader sees exactly what would run.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const rust = S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.91" })
export const Workspace = S.Workspace("cargo-report", {
  repository: "git+https://example.invalid/cargo.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [rust],
  host: S.Host({ bins: ["cargo"] })
})
`

const appsPackage = `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: S.glob(["**", "!target/**"]) })
const crates = S.Cargo.AppSet({ manifests: S.glob(["*/Cargo.toml"]) })
const format = S.Cargo.Fmt({ crates, data: [srcs] })
export const Package = S.Package({ targets: { format, srcs } })
`

const manifest = (name: string): string => `[package]\nname = ${JSON.stringify(name)}\nversion = "0.1.0"\n`

const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-cargo-report-")))
  temporaryDirectories.push(root)
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "Cargo.toml", "[workspace]\nmembers = []\n")
  await write(root, "apps/PACKAGE.ts", appsPackage)
  await write(root, "apps/alpha/Cargo.toml", manifest("app-alpha"))
  await write(root, "apps/beta/Cargo.toml", manifest("app-beta"))
  return root
}

const cargo = PackageTree.findOnPath("cargo")

describe.skipIf(cargo === undefined)("the cargo plan report", () => {
  it("lists every per-crate command of a lane that has no single argv", async () => {
    const root = await fixture()
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const report = await PackageExec.run({
      index: PackageIndex.make(loaded),
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: ["//apps:format"],
      plan: true
    })
    const format = report.targets.find((target) => target.label === "//apps:format")!
    expect(format.rule).toBe("Cargo.Fmt")
    expect(format).not.toHaveProperty("argv")
    expect(format.commands?.map((command) => command[0])).toEqual([cargo, cargo])
    expect(format.commands?.map((command) => command.slice(1))).toEqual([
      ["fmt", "--manifest-path", "apps/alpha/Cargo.toml", "--all", "--", "--check"],
      ["fmt", "--manifest-path", "apps/beta/Cargo.toml", "--all", "--", "--check"]
    ])
    // A target with no cargo lane reports no command list at all.
    const srcs = report.targets.find((target) => target.label === "//apps:srcs")!
    expect(srcs).not.toHaveProperty("commands")
  })
})
