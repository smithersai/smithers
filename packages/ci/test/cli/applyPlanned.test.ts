/**
 * `apply` never writes a job Smithers build will not run. Before it writes,
 * Smithers build plans the generated files in a copy of the repository; a
 * job it refuses stays in the repository's own workflow and is named in
 * `.smithers/ci/NOT-REPRODUCED.txt` with Smithers build's words, and so is
 * every job that needs it.
 *
 * The refusals are real: a run of the real `smthrs` that refuses a stray
 * `PACKAGE.ts`, and a `smthrs` that refuses as Smithers build does for one
 * job's targets and runs the real one for the rest.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { refusalOf, refusals } from "../../src/apply/Planned.vibe"
import { exitCodes } from "../../src/contract/Command.ts"
import type { Failure, GeneratedFile } from "../../src/contract/Parts.ts"
import { path as targetMapPath } from "../../src/contract/TargetMap.ts"
import { fullDisk, inProcess, noTempDirectory } from "./inProcess.vibe"
import { parts } from "./parts.vibe"
import { bin, commit, git, recorder, remove, spawnWith, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const environment = { HOME: temporary("apply-planned-home"), PATH: process.env["PATH"] }

const smthrs = fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))

const workflow = (jobs: ReadonlyArray<readonly [name: string, command: string, needs?: string]>): string =>
  [
    "name: CI",
    "on: [push]",
    "jobs:",
    ...jobs.flatMap(([name, command, needs]) => [
      `  ${name}:`,
      "    runs-on: ubuntu-latest",
      ...(needs === undefined ? [] : [`    needs: ${needs}`]),
      "    steps:",
      "      - uses: actions/checkout@v4",
      `      - run: ${JSON.stringify(command)}`
    ]),
    ""
  ].join("\n")

const repository = (files: Readonly<Record<string, string>>): string => {
  const root = temporary("apply-planned")
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "base", files)
  return root
}

/**
 * A `smthrs` that refuses, as Smithers build does, a plan of the target `refused`: one that names it, and one of
 * every target (`//...`) while the generated workspace still holds it. It runs the real one otherwise. With
 * `everything`, it refuses every plan of every target.
 */
const refusing = (refused: string, everything = false): string => {
  const directory = mkdtempSync(join(tmpdir(), "apply-planned-smthrs-"))
  made.push(directory)
  const command = join(directory, "smthrs")
  const refuse = `echo '{"code":"ci_failed","message":"link_input_refused: refused for the test [docs/x]"}'; exit 1`
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      `case " $* " in *"${refused}"*) ${refuse};; esac`,
      `case " $* " in *" //... "*) ${
        everything ? refuse : `grep -qs "${refused}" .smithers/WORKSPACE.smithers && { ${refuse}; }`
      };; esac`,
      `exec ${process.execPath} ${smthrs} "$@"`,
      ""
    ].join("\n")
  )
  chmodSync(command, 0o755)
  return command
}

/** The files `apply` would write for the repository at `root`, as its generator makes them. */
const generated = async (root: string): Promise<ReadonlyArray<GeneratedFile>> => {
  const { parts } = await import("../../src/cli/parts.ts")
  const { ci } = await import("../../src/contract/Inventory.ts")
  const program = Effect.gen(function*() {
    const inventory = yield* parts.read(root)
    const split = yield* parts.decompose(root, ci(inventory))
    return yield* parts.files(split, {})
  })
  return await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<
    ReadonlyArray<GeneratedFile>
  >)
}

describe("Smithers build's words for a refusal", () => {
  it("is the message of the error it printed, else the last line it printed", () => {
    expect(refusalOf("noise\n{\"code\":\"ci_failed\",\"message\":\"link_input_refused: docs/x\"}\n")).toBe(
      "link_input_refused: docs/x"
    )
    expect(refusalOf("one\ntwo: broken\n")).toBe("two: broken")
    expect(refusalOf("{\"code\":\"x\"}")).toBe("{\"code\":\"x\"}")
    expect(refusalOf("{ not json")).toBe("{ not json")
    expect(refusalOf("")).toBe("it printed nothing")
  })
})

describe("the jobs Smithers build refuses", { timeout: 600_000 }, () => {
  const jobs = workflow([["good", "echo good"], ["bad", "echo bad"]])

  it("are none when it plans every target, and nothing is written into the repository", async () => {
    const root = repository({ ".github/workflows/ci.yml": jobs })
    const files = await generated(root)
    const found = await Effect.runPromise(
      refusals([process.execPath, smthrs], root, files).pipe(
        Effect.provide(NodeServices.layer)
      ) as Effect.Effect<ReadonlyArray<unknown>, Failure>
    )
    expect(found).toEqual([])
    expect(git(root, "status", "--porcelain")).toBe("")
  })

  it("are each job whose targets it refuses alone, with its words", async () => {
    const root = repository({ ".github/workflows/ci.yml": jobs })
    const files = await generated(root)
    const found = await Effect.runPromise(
      refusals([refusing("ci.yml-bad")], root, files).pipe(
        Effect.provide(NodeServices.layer)
      ) as Effect.Effect<ReadonlyArray<unknown>, Failure>
    )
    expect(found).toEqual([{
      job: "ci.yml:bad",
      reasons: [{ feature: "build-refused", detail: "link_input_refused: refused for the test [docs/x]" }]
    }])
  })

  it("are every job when it refuses them together and plans each alone", async () => {
    const root = repository({ ".github/workflows/ci.yml": jobs })
    const files = await generated(root)
    const found = await Effect.runPromise(
      refusals([refusing("never-a-label", true)], root, files).pipe(
        Effect.provide(NodeServices.layer)
      ) as Effect.Effect<ReadonlyArray<{ readonly job: string }>, Failure>
    )
    expect(found.map((entry) => entry.job).sort()).toEqual(["ci.yml:bad", "ci.yml:good"])
  })

  it("fail as the program's own when the copy cannot be made or written", async () => {
    const root = repository({ ".github/workflows/ci.yml": jobs })
    const files = await generated(root)
    const failing = (faulty: typeof fullDisk) =>
      Effect.runPromise(
        refusals([process.execPath, smthrs], root, files).pipe(
          Effect.provide(faulty),
          Effect.provide(NodeServices.layer)
        ) as Effect.Effect<ReadonlyArray<unknown>, Failure>
      ).then(() => undefined, (cause: Failure) => cause)
    expect(await failing(noTempDirectory)).toMatchObject({
      code: "command-failed",
      part: "cli",
      message: expect.stringContaining("could not make a directory: PermissionDenied")
    })
    expect(await failing(fullDisk)).toMatchObject({
      code: "command-failed",
      part: "cli",
      message: expect.stringMatching(/^could not write the files apply writes into a copy: .*no space left on device/)
    })
  })

  it("are none for files with no target map, or a map with no target", async () => {
    const root = repository({ ".github/workflows/ci.yml": jobs })
    const none = (files: ReadonlyArray<GeneratedFile>) =>
      Effect.runPromise(
        refusals([refusing("never-a-label")], root, files).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<
          ReadonlyArray<unknown>,
          Failure
        >
      )
    expect(await none([])).toEqual([])
    expect(await none([{ path: targetMapPath, content: "{\"version\":1,\"targets\":[]}", written: false }])).toEqual([])
    await expect(none([{ path: targetMapPath, content: "{}", written: false }])).rejects.toMatchObject({
      code: "invalid-document"
    })
  })
})

describe("apply, when Smithers build refuses", { timeout: 600_000 }, () => {
  it("writes every other job, and keeps the refused one and every job that needs it in the repository's workflow", async () => {
    const root = repository({
      ".github/workflows/ci.yml": workflow([["good", "echo good"], ["bad", "echo bad"], ["after", "echo after", "bad"]])
    })
    const sink = recorder()
    const chosen = {
      ...parts,
      planned: (at: string, files: ReadonlyArray<GeneratedFile>) => refusals([refusing("ci.yml-bad")], at, files)
    }
    const code = await inProcess(["apply"], root, chosen, sink.service as never, environment)
    expect(code, sink.stderr()).toBe(0)
    const notes = readFileSync(join(root, ".smithers/ci/NOT-REPRODUCED.txt"), "utf8")
    expect(notes).toContain(
      "- ci.yml:bad: not in this workflow: is refused by Smithers build: link_input_refused: refused for the test "
        + "[docs/x]; the job stays in your CI as it is"
    )
    expect(notes).toContain("- ci.yml:after: not in this workflow: needs ci.yml:bad, which is not replayed")
    const workspace = readFileSync(join(root, ".smithers/WORKSPACE.smithers"), "utf8")
    expect(workspace).toContain("ci.yml-good")
    expect(workspace).not.toContain("ci.yml-bad")
    expect(workspace).not.toContain("ci.yml-after")
    // The repository's own workflow is as it was: the refused jobs still run there.
    expect(git(root, "diff", "--", ".github/workflows/ci.yml")).toBe("")
  })

  it("writes every job when no plan is asked for", async () => {
    const root = repository({ ".github/workflows/ci.yml": workflow([["good", "echo good"]]) })
    const sink = recorder()
    const code = await inProcess(["apply"], root, { ...parts, planned: undefined }, sink.service as never, environment)
    expect(code, sink.stderr()).toBe(0)
    expect(readFileSync(join(root, ".smithers/WORKSPACE.smithers"), "utf8")).toContain("ci.yml-good")
  })

  it("writes nothing, and names each job, when Smithers build refuses every one", async () => {
    // A stray PACKAGE.ts of another tool: Smithers build loads every PACKAGE.ts of the workspace, and refuses this one.
    const root = repository({
      ".github/workflows/ci.yml": workflow([["build", "true"], ["test", "true", "build"]]),
      "tools/PACKAGE.ts": "throw new Error(\"not a Smithers package\")\n"
    })
    const outcome = await spawnWith(bin, ["apply"], root, {})
    expect(outcome.code, outcome.stderr).toBe(exitCodes.unsupported)
    expect(outcome.stderr).toMatch(
      /ci\.yml:build +is refused by Smithers build: module_import_failed: .*not a Smithers package/
    )
    expect(outcome.stderr).toContain("ci.yml:test")
    expect(existsSync(join(root, ".smithers"))).toBe(false)
    expect(git(root, "status", "--porcelain")).toBe("")
  })
})
