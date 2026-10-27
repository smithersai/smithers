import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-value-cli-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", "{}\n")
  await write(root, "yarn.lock", "")
  await write(root, "input.txt", "first")
  await write(root, "apps/demo/Cargo.toml", "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("value-targets", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  sources: S.Filegroup({ srcs: [S.file("input.txt")] }),
  apps: S.Cargo.AppSet({ manifests: S.glob("apps/*/Cargo.toml") })
} })
`
  )
  return root
}

it("runs Cargo.AppSet as an inert value without Cargo or a cached verdict", async () => {
  const root = await fixture()
  for (let invocation = 0; invocation < 2; invocation++) {
    const result = await serve(root, ["//:apps", "--format", "json"], { environment: { PATH: "" } })
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      results: [{ label: "//:apps", status: "ran" }]
    })
    expect(await Fs.readFile(NodePath.join(root, "apps/demo/Cargo.toml"), "utf8"))
      .toBe("[package]\nname = \"demo\"\nversion = \"0.1.0\"\n")
    expect(await Fs.readdir(NodePath.join(root, "apps/demo"))).toEqual(["Cargo.toml"])
  }
})

it("reports Filegroup cache hits, changed-member misses and --no-cache through the CLI", async () => {
  const root = await fixture()
  const run = async (status: "ran" | "hit", flags: ReadonlyArray<string> = []) => {
    const result = await serve(root, ["//:sources", "--format", "json", ...flags])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      results: [{ label: "//:sources", status }]
    })
  }
  await run("ran")
  await run("hit")
  await write(root, "input.txt", "second")
  await run("ran")
  await run("hit")
  await run("ran", ["--no-cache"])
  await run("hit")
})
