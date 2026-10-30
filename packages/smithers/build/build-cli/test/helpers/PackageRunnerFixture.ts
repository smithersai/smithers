import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach } from "vitest"
import * as PackageDiscovery from "../../src/PackageDiscovery.ts"
import * as PackageExec from "../../src/PackageExec.ts"
import { PackageIndex } from "../../src/PackageIndex.ts"
import * as PackageLoader from "../../src/PackageLoader.ts"
import { write } from "./WriteFile.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})
export const runnerFixture = async (
  source: string,
  files: Readonly<Record<string, string>> = {},
  workspaceExtra = "",
  nodeRuntime = true
) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-runner-boundary-")))
  roots.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
${nodeRuntime ? "const packageJson = S.file(\"//package.json\")" : ""}
export const Workspace = S.Workspace("host-boundary", {
  repository: "git+https://example.invalid/host-boundary.git",
  cache: S.Cache({ directory: ".flows" }),
  ${
      nodeRuntime ?
        `runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),` :
        ""
    }
  host: S.Host({ bins: ["sh"] }),
  ${workspaceExtra}
})`
  )
  await write(root, "package.json", "{\"name\":\"host-boundary\",\"private\":true}\n")
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  await write(root, "PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"\n${source}`)
  for (const [path, value] of Object.entries(files)) await write(root, path, value)
  execFileSync("jj", ["git", "init", "--colocate", root], { stdio: "ignore" })
  execFileSync("jj", ["describe", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  execFileSync("jj", ["new", "-m", ""], { cwd: root, stdio: "ignore" })
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  const options = { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: ["//:command"] }
  return { root, options, plan: await PackageExec.plan(options) }
}
