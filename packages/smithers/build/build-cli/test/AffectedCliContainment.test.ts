import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

it.each(["environment", "cancellation"])(
  "forwards the embedding caller's %s into affected discovery",
  async (fault) => {
    const root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "smithers-m2-affected-cli-")))
    const signal = fault === "cancellation" ? AbortSignal.abort(new Error("caller cancelled discovery")) : undefined
    const environment = { ...process.env, PATH: root }
    try {
      await Fs.writeFile(
        join(root, "WORKSPACE.ts"),
        `
import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})
`
      )
      await Fs.writeFile(
        join(root, "PACKAGE.ts"),
        `
import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { files: S.Filegroup({ srcs: [S.file("input.txt")] }) } })
`
      )
      let output = ""
      let exitCode = 0
      await makeCli({ signal, environment }).serve(
        ["affected", "test", "//...", "--list", "--workspace", root, "--json"],
        {
          stdout: (text) => {
            output += text
          },
          exit: (code) => {
            exitCode = code
          }
        }
      )
      expect(exitCode, output).toBe(1)
      expect(output).toContain(fault === "cancellation" ? "caller cancelled discovery" : "git rev-parse failed")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  }
)
