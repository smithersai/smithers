/**
 * An uncached `S.Shell.Build` with no declared output, through the real CLI:
 * it is an action that runs on every invocation, and a target that depends on
 * it runs after it.
 */
import * as NodeChildProcess from "node:child_process"
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

const temporary = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

describe("an uncached Shell.Build with no output", () => {
  it("runs on every invocation, before the test that depends on it", async () => {
    const root = await temporary("smthrs-uncached-build-")
    const log = NodePath.join(await temporary("smthrs-uncached-build-log-"), "setup.log")
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("uncached", {
  repository: "git+https://example.invalid/uncached.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["sh"] })
})
`
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const a = S.Shell.Build({ shell: ${JSON.stringify(`printf 'ran\\n' >> '${log}'`)}, cache: false, sandbox: "none" })
const b = S.Shell.Test({ shell: ${JSON.stringify(`test -s '${log}'`)}, sandbox: "none", data: [a] })
export const Package = S.Package({ targets: { a, b } })
`
    )
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")

    const planned = await serve(root, ["ci", "//...", "--plan"])
    expect(planned.exitCode, planned.logs).toBe(0)
    const planOf = (label: string): string => {
      const start = planned.output.indexOf(`- label: "${label}"`)
      expect(start, planned.output).toBeGreaterThanOrEqual(0)
      const next = planned.output.indexOf("- label: ", start + 1)
      return planned.output.slice(start, next === -1 ? undefined : next)
    }
    expect(planOf("//:a")).toContain("target: Shell.Build")
    expect(planOf("//:a")).toContain("declaredOutputs: null")
    expect(planOf("//:a")).toContain("cacheable: false")
    expect(planOf("//:a")).toContain("wouldRun: true")
    expect(planOf("//:b")).toContain("target: Shell.Test")
    await expect(Fs.stat(log)).rejects.toThrow()

    const first = await serve(root, ["ci", "//..."])
    expect(first.exitCode, first.logs).toBe(0)
    expect(first.logs).toContain("//:a  ran")
    expect(first.logs).toContain("//:b  ran")
    expect(await Fs.readFile(log, "utf8")).toBe("ran\n")

    // The build is never stored, so the second run executes it again. The
    // test is keyed by the build's declaration, which did not change, so its
    // verdict is answered from the cache.
    const second = await serve(root, ["ci", "//..."])
    expect(second.exitCode, second.logs).toBe(0)
    expect(second.logs).toContain("//:a  ran")
    expect(second.logs).toContain("//:b  hit")
    expect(await Fs.readFile(log, "utf8")).toBe("ran\nran\n")
  })
})
