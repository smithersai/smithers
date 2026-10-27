import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"
import { createGenerateCli } from "../src/cli/Generate.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const workspace = async (renderers: number) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-generate-ci-"))
  roots.push(root)
  await mkdir(join(root, "node_modules/@smthrs"), { recursive: true })
  await symlink(
    dirname(createRequire(import.meta.url).resolve("@smthrs/targets/package.json")),
    join(root, "node_modules/@smthrs/targets"),
    "dir"
  )
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "ci-fixture", type: "module", packageManager: "pnpm@11.25.0" })
  )
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await writeFile(
    join(root, "WORKSPACE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("ci-fixture", {
  repository: "https://example.invalid/ci-fixture",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=22.19.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})
`
  )
  await writeFile(
    join(root, "PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
const workflow = S.Github.Workflow({ name: "ci", on: { push: { branches: ["main"] } }, run: [] })
export const Package = S.Package({ targets: {
  workflow,
  ${
      Array.from({ length: renderers }, (_, index) =>
        `render${index}: S.Github.CiGen({ workflows: [workflow], changes: [".github/workflows/**"] })`).join(
          ",\n  "
        )
    }
} })
`
  )
  return root
}

const invoke = async (root: string, ...args: Array<string>) => {
  let output = ""
  let diagnostics = ""
  const codes: Array<number> = []
  const terminal = {
    isTTY: false,
    columns: 80,
    write: (text: string) => {
      diagnostics += text
    }
  }
  await createGenerateCli({ environment: {}, stdout: terminal, stderr: terminal, exit: (code) => codes.push(code) })
    .serve(["ci", "--workspace", root, "--json", ...args], {
      stdout: (text) => {
        output += text
      },
      exit: (code) => {
        codes.push(code)
      }
    })
  return { output, codes, diagnostics }
}

it("generate ci renders the declared CiGen even beside an inert Workflow", async () => {
  const root = await workspace(1)
  const binary = spawnSync(process.execPath, [
    fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url)),
    "generate",
    "ci",
    "--workspace",
    root,
    "--json"
  ], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, NODE_OPTIONS: process.env.NODE_OPTIONS },
    encoding: "utf8",
    timeout: 45_000
  })
  expect(binary.status, binary.stdout + binary.stderr).toBe(0)
  expect(JSON.parse(binary.stdout)).toMatchObject({ ok: true })
  const generated = await readFile(join(root, ".github/workflows/ci.yml"), "utf8")
  const result = await invoke(root)
  expect(result.codes, result.output + result.diagnostics).not.toContain(1)
  expect(JSON.parse(result.output)).toMatchObject({ ok: true })
  const yaml = await readFile(join(root, ".github/workflows/ci.yml"), "utf8")
  expect(yaml).toMatch(/^name: "?ci"?$/m)
  expect(yaml).toContain("main")
  expect(yaml).toBe(generated)
})

it("generate ci preserves the public GithubCiGen renderer", async () => {
  const root = await workspace(0)
  await writeFile(
    join(root, "PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
const node = S.CiToolchain.Node({ release: "26.4.0" })
const unit = S.Shell.Test({ shell: "true" })
const render = S.GithubCiGen({ mode: "write", jobs: [{
  id: "test", runsOn: "ubuntu-latest",
  toolchain: S.CiToolchain.Needs({ runtimes: [node] }),
  steps: [{ name: "Tests", verb: S.Verb.Test, pattern: "//:unit" }]
}] })
export const Package = S.Package({ targets: { unit, render } })
`
  )
  const result = await invoke(root)
  expect(result.codes, result.output + result.diagnostics).not.toContain(1)
  expect(JSON.parse(result.output)).toMatchObject({ ok: true })
  expect(await readFile(join(root, ".github/workflows/ci.yml"), "utf8")).toContain("CI")
})

it("generate ci refuses an inert Workflow as the only target or an explicit selection", async () => {
  const root = await workspace(0)
  for (const args of [[], ["--target", "//:workflow"]]) {
    const result = await invoke(root, ...args)
    expect(result.codes).toContain(1)
    expect(result.output).toContain("generator_missing")
    expect(result.output).toContain("S.Github.CiGen")
  }
})

it("generate ci requires a renderer label when several match and plans without writing", async () => {
  const root = await workspace(2)
  const ambiguous = await invoke(root)
  expect(ambiguous.codes).toContain(2)
  expect(ambiguous.output).toContain("//:render0, //:render1")
  const planned = await invoke(root, "--target", "//:render1", "--plan")
  expect(planned.codes, planned.output).toEqual([])
  await expect(readFile(join(root, ".github/workflows/ci.yml"))).rejects.toMatchObject({ code: "ENOENT" })
})
