import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { layer } from "../../src/cli/Host.vibe"
import { parts } from "../../src/cli/parts.ts"
import { exitCodes } from "../../src/contract/Command.ts"
import { Inventory, ownWorkspace as workspaceIn } from "../../src/contract/Inventory.ts"
import type { Failure } from "../../src/contract/Parts.ts"
import { generatedMark } from "../../src/native/index.ts"
import { run as generic } from "../../src/replay/index.ts"
import { inProcess } from "../cli/inProcess.vibe"
import { bin, changed, head, type Outcome, read, recorder, snapshot, spawn, temporary } from "../cli/repo.ts"
import { ciFiles, ownPackage, ownWorkspace, refusedAt, repository } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })))

const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

const run = async (args: ReadonlyArray<string>, root: string): Promise<Outcome> => {
  const sink = recorder()
  const code = await inProcess(args, root, parts, sink.service as never, environment)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

const already = (file: string): string =>
  `the repository already builds with Smithers build (${file}); there is nothing to convert\n`

describe("smithers-ci on a repository with its own Smithers workspace", { timeout: 300_000 }, () => {
  it("apply exits 3 with one line and writes nothing, as a process", async () => {
    const root = keep(repository({ ...ciFiles, "WORKSPACE.ts": ownWorkspace, "PACKAGE.ts": ownPackage }))
    const before = snapshot(root)
    const outcome = await spawn(bin, ["apply"], root)
    expect(outcome).toEqual({
      code: exitCodes.unsupported,
      stdout: "",
      stderr: `smithers-ci: inventory: ${already("WORKSPACE.ts")}`
    })
    expect(changed(before, snapshot(root))).toEqual([])
    expect(read(`${root}/PACKAGE.ts`)).toBe(ownPackage)
  })

  it("apply refuses it wherever its workspace is, and a replay never generates for it", async () => {
    for (const file of ["WORKSPACE.ts", ".smithers/WORKSPACE.ts"]) {
      const root = keep(repository({ ...ciFiles, [file]: ownWorkspace, "PACKAGE.ts": ownPackage }))
      const before = snapshot(root)
      expect(await run(["apply"], root)).toEqual({
        code: exitCodes.unsupported,
        stdout: "",
        stderr: `smithers-ci: inventory: ${already(file)}`
      })
      // The repository depends on no smthrs, so its own targets cannot be replayed either.
      const where = file === "WORKSPACE.ts" ? "the repository root" : ".smithers or the repository root"
      for (const args of [["--commits", "1"], ["replay", "--commits", "1"]]) {
        const outcome = await run(args, root)
        expect(outcome.code).toBe(exitCodes.unsupported)
        expect(outcome.stdout).toBe("")
        expect(
          outcome.stderr.trimEnd().endsWith(
            `smithers-ci: replay: ${
              refusedAt(
                head(root).slice(0, 7),
                "(install)",
                `no node_modules/.bin/smthrs in ${where} after the install; the repository must depend on @smthrs/cli`
              )
            }`
          ),
          outcome.stderr
        ).toBe(true)
      }
      expect(changed(before, snapshot(root))).toEqual([])
    }
  })

  it("is refused by the replay that generates targets, should it be asked", async () => {
    const root = keep(repository({ ...ciFiles, "WORKSPACE.ts": ownWorkspace, "PACKAGE.ts": ownPackage }))
    const attempt = Effect.runPromise(
      Effect.provide(generic({ root, commits: 1, modes: ["normal"] }, parts), layer(environment))
    )
    const failure = await attempt.then(
      () => undefined,
      (cause: { readonly message: string }) => JSON.parse(JSON.stringify(cause)) as Failure
    )
    expect(failure).toEqual({ code: "unsupported", part: "replay", message: already("WORKSPACE.ts").trimEnd() })
  })

  it("says so in the inventory", async () => {
    const root = keep(repository({ ...ciFiles, "WORKSPACE.ts": ownWorkspace }))
    const outcome = await run(["inventory", "--json"], root)
    expect(outcome.code, outcome.stderr).toBe(exitCodes.ok)
    const inventory = Schema.decodeUnknownSync(Inventory)(JSON.parse(outcome.stdout))
    expect(workspaceIn(inventory)).toBe("WORKSPACE.ts")
    expect(inventory.unsupported).toEqual([{ feature: "smithers-build", detail: "WORKSPACE.ts" }])
  })
})

describe("smithers-ci on a repository without a workspace of its own", { timeout: 300_000 }, () => {
  it("refuses --targets instead of ignoring it", async () => {
    const root = keep(repository(ciFiles))
    for (const args of [["--commits", "1", "--targets", "//:a"], ["replay", "--commits", "1", "--targets", "//:a"]]) {
      expect(await run(args, root)).toEqual({
        code: exitCodes.unsupported,
        stdout: "",
        stderr:
          "smithers-ci: replay: --targets names Smithers build patterns, and this repository has no Smithers workspace of its own (.smithers/WORKSPACE.ts or WORKSPACE.ts)\n"
      })
    }
  })
})

describe("smithers-ci on a repository it converted", { timeout: 300_000 }, () => {
  it("is not refused: the workspace it generated is its own to write again", async () => {
    const root = keep(repository(ciFiles))
    expect((await run(["apply"], root)).code).toBe(exitCodes.ok)
    for (const file of [".smithers/WORKSPACE.ts", "PACKAGE.ts"]) {
      expect(read(`${root}/${file}`).startsWith(generatedMark), file).toBe(true)
    }
    const inventory = Schema.decodeUnknownSync(Inventory)(JSON.parse((await run(["inventory", "--json"], root)).stdout))
    expect(workspaceIn(inventory)).toBeUndefined()
    const again = await run(["apply"], root)
    expect(again.code, again.stderr).toBe(exitCodes.ok)
  })
})

describe("smithers-ci on a repository with a build file it did not write", { timeout: 300_000 }, () => {
  it("never writes a generated file over it, in the repository or in a replay's copy", async () => {
    const root = keep(repository({ ...ciFiles, "PACKAGE.ts": ownPackage }))
    const before = snapshot(root)
    const kept = "PACKAGE.ts was not written by smithers-ci and would be replaced\n"
    for (const args of [["apply"], ["--commits", "1"]]) {
      expect(await run(args, root)).toEqual({
        code: exitCodes.unsupported,
        stdout: "",
        stderr: `smithers-ci: generate: ${kept}`
      })
    }
    const replay = await run(["replay", "--commits", "1"], root)
    expect(replay.code).toBe(exitCodes.unsupported)
    expect(replay.stderr).toBe(`smithers-ci: replay: ${kept}`)
    expect(changed(before, snapshot(root))).toEqual([])
  })
})
