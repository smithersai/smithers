/**
 * `Docs.Check` end to end: a temp workspace with one agent-written page, its
 * inputs, and a Filegroup of references, driven through the CLI verbs.
 *
 * The four verdicts are exercised in the order a writer meets them: no stamp
 * yet (`missing`), stamped and green (fresh), an input edited (`stale`, the
 * moved path named), the page edited by hand (`modified`), then re-stamped
 * and green again. A reference reached only through the Filegroup proves the
 * closure follows target edges, not just declared files.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("docs-check", {
  repository: "git+https://example.invalid/docs-check.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

const packageModule = `import { Smithers as S } from "@smthrs/targets"
const references = S.Filegroup({ srcs: [S.glob("//references/**")] })
export const Package = S.Package({
  targets: {
    fresh: S.Docs.Check({
      stamp: S.file("//pages/intro/stamp.json"),
      output: S.file("//docs/intro.mdx"),
      inputs: [S.file("//pages/intro/brief.md"), S.glob("//src/**/*.ts"), references],
      producer: "fake-model prompts/reference.md",
    }),
  },
})
`

const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docs-check-")))
  temporaryDirectories.push(root)
  await write(root, "package.json", `{ "name": "docs-check", "private": true }\n`)
  await write(root, "yarn.lock", "")
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "PACKAGE.ts", packageModule)
  await write(root, "pages/intro/brief.md", "Explain Flow.make to a first-time reader.\n")
  await write(root, "src/Flow.ts", "export const make = () => 1\n")
  await write(root, "src/Action.ts", "export const make = () => 2\n")
  await write(root, "references/style.md", "Use the active voice.\n")
  await write(root, "docs/intro.mdx", "# Flow.make\n\nBuilds a flow.\n")
  return root
}

const stampOf = async (root: string) =>
  JSON.parse(await Fs.readFile(NodePath.join(root, "pages", "intro", "stamp.json"), "utf8")) as {
    readonly format: number
    readonly producer: string | null
    readonly output: { readonly path: string; readonly digest: string | null }
    readonly closure: string
    readonly inputs: ReadonlyArray<{ readonly path: string; readonly digest: string | null }>
  }

describe("Docs.Check through the CLI", () => {
  it("reports missing, stamps under docs --write, then reports stale and modified by path", async () => {
    const root = await fixture()

    const missing = await serve(root, ["lint", "//:fresh"])
    expect(missing.exitCode).toBe(1)
    expect(missing.logs).toContain("docs/intro.mdx has no stamp at pages/intro/stamp.json")

    const stamped = await serve(root, ["docs", "//:fresh", "--write"])
    expect(stamped.exitCode, stamped.logs).toBe(0)
    const stamp = await stampOf(root)
    expect(stamp.format).toBe(1)
    expect(stamp.producer).toBe("fake-model prompts/reference.md")
    expect(stamp.output.path).toBe("docs/intro.mdx")
    expect(stamp.inputs.map((file) => file.path)).toEqual([
      "pages/intro/brief.md",
      "references/style.md",
      "src/Action.ts",
      "src/Flow.ts"
    ])
    expect(stamp.inputs.every((file) => typeof file.digest === "string")).toBe(true)

    const fresh = await serve(root, ["lint", "//:fresh"])
    expect(fresh.exitCode, fresh.logs).toBe(0)
    const plainDocs = await serve(root, ["docs", "//:fresh"])
    expect(plainDocs.exitCode, plainDocs.logs).toBe(0)
    expect(await stampOf(root)).toEqual(stamp)

    await write(root, "src/Flow.ts", "export const make = () => 3\n")
    const stale = await serve(root, ["lint", "//:fresh"])
    expect(stale.exitCode).toBe(1)
    expect(stale.logs).toContain("docs/intro.mdx is stale: input src/Flow.ts changed")
    await write(root, "src/Flow.ts", "export const make = () => 1\n")

    await write(root, "references/style.md", "Use the passive voice.\n")
    const staleReference = await serve(root, ["ci", "//..."])
    expect(staleReference.exitCode).toBe(1)
    expect(staleReference.logs).toContain("input references/style.md changed")
    await write(root, "references/style.md", "Use the active voice.\n")

    await write(root, "src/Glue.ts", "export const glue = true\n")
    const added = await serve(root, ["lint", "//:fresh"])
    expect(added.exitCode).toBe(1)
    expect(added.logs).toContain("input src/Glue.ts was added")
    await Fs.rm(NodePath.join(root, "src", "Glue.ts"))

    await write(root, "docs/intro.mdx", "# Flow.make\n\nBuilds a flow. Edited by hand.\n")
    const modified = await serve(root, ["lint", "//:fresh"])
    expect(modified.exitCode).toBe(1)
    expect(modified.logs).toContain("docs/intro.mdx was edited after pages/intro/stamp.json was written")

    const restamped = await serve(root, ["docs", "//:fresh", "--write"])
    expect(restamped.exitCode, restamped.logs).toBe(0)
    expect((await stampOf(root)).output.digest).not.toBe(stamp.output.digest)
    const green = await serve(root, ["ci", "//..."])
    expect(green.exitCode, green.logs).toBe(0)
  })

  it("refuses to stamp a page that does not exist", async () => {
    const root = await fixture()
    await Fs.rm(NodePath.join(root, "docs", "intro.mdx"))
    const result = await serve(root, ["docs", "//:fresh", "--write"])
    expect(result.exitCode).toBe(1)
    expect(result.logs).toContain("docs/intro.mdx is missing")
  })
})
