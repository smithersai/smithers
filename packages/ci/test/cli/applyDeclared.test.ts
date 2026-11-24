/**
 * What `apply` holds Smithers build to when it asks for a plan of the files it would write, on the person's own
 * machine and in no jail: no build file of the repository's own is in the copy it plans, so no code of the
 * repository runs; it is started with what a step gets of the machine and nothing else of the person's; it is
 * given a time to answer in; and a plan that fails for a reason that is not its targets' fails `apply`, where
 * leaving the job out would write a fault of this machine into the repository's CI.
 *
 * Each `smthrs` here is a script that says what it was started with and answers as the case needs.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { declarationNames, declaredRefusal, declares } from "../../src/apply/index.vibe"
import { refusals, refusedTargets } from "../../src/apply/Planned.vibe"
import { parts } from "../../src/cli/parts.vibe"
import { ci } from "../../src/contract/Inventory.vibe"
import type { Failure, GeneratedFile } from "../../src/contract/Parts.vibe"
import { commit, git, remove, temporary } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  ...["good", "bad"].flatMap((name) => [
    `  ${name}:`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    `      - run: echo ${name}`
  ]),
  ""
].join("\n")

const repository = (files: Readonly<Record<string, string>> = {}): string => {
  const root = temporary("apply-declared")
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "base", { ".github/workflows/ci.yml": workflow, ...files })
  return root
}

/** The files `apply` would write for the repository at `root`, from its working tree, with nothing of it run. */
const generated = (root: string): Promise<ReadonlyArray<GeneratedFile>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const split = yield* parts.decomposeStatic!(root, ci(yield* parts.read(root)))
      return yield* parts.files(split, {})
    }).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<ReadonlyArray<GeneratedFile>>
  )

/**
 * A `smthrs` that keeps, for each time it is started, its arguments (`args-N`), its environment (`env-N`) and the
 * files of the directory it runs in (`files-N`), then runs `answers[N - 1]`, or the last of them.
 */
const scripted = (...answers: ReadonlyArray<string>) => {
  const directory = temporary("apply-declared-smthrs")
  made.push(directory)
  const command = join(directory, "smthrs")
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      `d=${JSON.stringify(directory)}`,
      "n=$(($(cat \"$d/count\" 2>/dev/null || echo 0) + 1))",
      "echo \"$n\" > \"$d/count\"",
      "printf '%s\\n' \"$@\" > \"$d/args-$n\"",
      "env > \"$d/env-$n\"",
      "find . -path ./.git -prune -o -type f -print | sort > \"$d/files-$n\"",
      ...answers.map((answer, index) => `[ "$n" -eq ${index + 1} ] && { ${answer}; }`),
      answers.at(-1) ?? "exit 0",
      ""
    ].join("\n")
  )
  chmodSync(command, 0o755)
  const kept = (name: string): string => readFileSync(join(directory, name), "utf8")
  return {
    command,
    started: (): number => existsSync(join(directory, "count")) ? Number(kept("count")) : 0,
    args: (start: number): ReadonlyArray<string> => kept(`args-${start}`).trim().split("\n"),
    env: (start: number): string => kept(`env-${start}`),
    files: (start: number): ReadonlyArray<string> => kept(`files-${start}`).trim().split("\n")
  }
}

const refuse = (message: string): string => `echo '${JSON.stringify({ code: "ci_failed", message })}'; exit 1`

const asked = (command: string, root: string, files: ReadonlyArray<GeneratedFile>, limit?: string) =>
  Effect.runPromise(
    refusals([command], root, files, limit as never).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<
      ReadonlyArray<{ readonly job: string; readonly reasons: ReadonlyArray<{ readonly detail: string }> }>,
      Failure
    >
  )

const failure = (work: Promise<unknown>): Promise<Failure | undefined> =>
  work.then(() => undefined, (cause: Failure) => cause)

describe("a build file Smithers build reads", () => {
  it("is one named as a declaration, in any directory, and no file named in another case", () => {
    for (const name of declarationNames) {
      expect(declares(name), name).toBe(true)
      expect(declares(`a/b/${name}`), name).toBe(true)
      expect(declares(`a/${name}/index.ts`), name).toBe(false)
      expect(declares(`a/${name.toLowerCase()}`), name).toBe(false)
    }
    expect(declarationNames).toEqual(expect.arrayContaining(["PACKAGE.ts", "PACKAGE.vibe", "FACTORY.ts", "BUILD.ts"]))
    for (const extension of ["ts", "vibe", "smithers", "js", "mjs", "cjs", "mts", "cts", "jsx", "tsx"]) {
      expect(declares(`.smithers/config.${extension}`)).toBe(true)
    }
    expect(declares(".smithers/config.json")).toBe(false)
    expect(declares("my.smithers/config.ts")).toBe(false)
    expect(declares("scripts/build.ts")).toBe(false)
    expect(declares("src/MY_PACKAGE.ts")).toBe(false)
  })

  it("is named in the refusal: one, several, and the first five of many", () => {
    expect(declaredRefusal(["tools/PACKAGE.ts"])).toBe(
      "tools/PACKAGE.ts is a build file smithers-ci did not write, and Smithers build would run it on this machine "
        + "to plan the generated files: nothing of the repository is run to write its files, so remove it to have "
        + "apply write its files"
    )
    expect(declaredRefusal(["a/PACKAGE.ts", "FACTORY.ts"])).toBe(
      "a/PACKAGE.ts, FACTORY.ts are build files smithers-ci did not write, and Smithers build would run them on this "
        + "machine to plan the generated files: nothing of the repository is run to write its files, so remove them "
        + "to have apply write its files"
    )
    const many = ["1", "2", "3", "4", "5", "6", "7"].map((name) => `${name}/PACKAGE.ts`)
    expect(declaredRefusal(many)).toContain(
      "1/PACKAGE.ts, 2/PACKAGE.ts, 3/PACKAGE.ts, 4/PACKAGE.ts, 5/PACKAGE.ts and 2 more are"
    )
  })
})

describe("Smithers build's refusal of the targets it was asked to plan", () => {
  it("is the error it printed as JSON, and nothing else it may print", () => {
    expect(refusedTargets("noise\n{\"code\":\"ci_failed\",\"message\":\"link_input_refused: docs/x\"}\n")).toBe(
      "link_input_refused: docs/x"
    )
    expect(
      refusedTargets(
        "{\"code\":\"ci_failed\",\"message\":\"\u001b[31mlink_input_refused\u001b[0m: docs/x\"}\n" +
          "(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n"
      )
    ).toBe("link_input_refused: docs/x")
    // A program that could not start, or was stopped, prints no error of Smithers build's.
    for (const printed of ["", "Killed\n", "sh: 1: node: not found\n", "Error: boom\n    at main (x.js:1:1)\n"]) {
      expect(refusedTargets(printed), printed).toBeUndefined()
    }
    // Smithers build's own error for a fault of this machine is no word about the targets.
    for (
      const message of [
        "ENOSPC: no space left on device, write",
        "could not write the cache: No space left on device",
        "x".repeat(340) + " ENOSPC",
        "EMFILE: too many open files",
        "EACCES: permission denied, mkdir '/x'",
        "JavaScript heap out of memory"
      ]
    ) expect(refusedTargets(JSON.stringify({ code: "ci_failed", message })), message).toBeUndefined()
  })
})

describe("the copy Smithers build plans", { timeout: 300_000 }, () => {
  it("reports both a missing host Git and an unreadable HEAD before planning", async () => {
    const source = repository()
    const files = await generated(source)
    const smthrs = scripted("exit 0")
    expect(await failure(asked(smthrs.command, join(source, "absent"), files))).toMatchObject({
      code: "command-failed",
      message: expect.stringContaining("could not run git")
    })
    const empty = temporary("apply-empty")
    made.push(empty)
    git(empty, "init", "--quiet")
    expect(await failure(asked(smthrs.command, empty, files))).toMatchObject({
      code: "command-failed",
      message: expect.stringContaining("git rev-parse failed")
    })
    expect(smthrs.started()).toBe(0)
  })

  it("stops the plan, before Smithers build is started, for a build file of the repository's own", async () => {
    const root = repository({
      "tools/PACKAGE.ts": "throw new Error(\"run\")\n",
      "lib/deep/PACKAGE.vibe": "throw new Error(\"run\")\n",
      ".smithers/FACTORY.ts": "throw new Error(\"run\")\n",
      "scripts/build.ts": "export {}\n"
    })
    const smthrs = scripted("exit 0")
    expect(await failure(asked(smthrs.command, root, await generated(root)))).toEqual({
      code: "unsupported",
      part: "generate",
      message: declaredRefusal([".smithers/FACTORY.ts", "lib/deep/PACKAGE.vibe", "tools/PACKAGE.ts"])
    })
    expect(smthrs.started()).toBe(0)
    expect(git(root, "status", "--porcelain")).toBe("")
  })

  it("checks committed, staged and working declarations even with only foreign-host targets", async () => {
    const root = repository({ "sub/PACKAGE.ts": "", ".gitignore": ".smithers/config.*\n" })
    const other = process.platform === "darwin" ? "linux" : "darwin"
    const files = (await generated(root)).map((file) =>
      file.path === ".smithers/WORKSPACE.smithers"
        ? { ...file, content: file.content.replaceAll("S.Shell.Test({\n", `S.Shell.Test({\n  hosts: ["${other}"],\n`) }
        : file
    )
    const smthrs = scripted("exit 1")
    mkdirSync(join(root, ".smithers"), { recursive: true })
    writeFileSync(join(root, ".smithers/config.ts"), "")
    writeFileSync(join(root, "sub/BUILD.ts"), "")
    git(root, "add", "sub/BUILD.ts")
    expect(await failure(asked(smthrs.command, root, files))).toMatchObject({
      code: "unsupported",
      message: declaredRefusal([".smithers/config.ts", "sub/BUILD.ts", "sub/PACKAGE.ts"])
    })
    for (const file of [".smithers/config.ts", "sub/BUILD.ts", "sub/PACKAGE.ts"]) rmSync(join(root, file))
    expect(await asked(smthrs.command, root, files)).toEqual([])
    expect(smthrs.started()).toBe(0)
  })

  it("holds no build file the working tree no longer holds, though the commit does", async () => {
    // The person removed them, as the refusal asks, and has not committed: the plan is of the files they have.
    const root = repository({
      "PACKAGE.ts": "throw new Error(\"run\")\n",
      "tools/PACKAGE.ts": "throw new Error(\"run\")\n",
      "tools/notes.txt": "kept\n"
    })
    rmSync(join(root, "PACKAGE.ts"))
    rmSync(join(root, "tools/PACKAGE.ts"))
    const smthrs = scripted("exit 0")
    expect(await asked(smthrs.command, root, await generated(root))).toEqual([])
    expect(smthrs.started()).toBe(1)
    expect(smthrs.files(1)).toContain("./tools/notes.txt")
    expect(smthrs.files(1)).toContain("./.smithers/WORKSPACE.smithers")
    expect(smthrs.files(1).filter((file) => file.endsWith("PACKAGE.ts"))).toEqual([])
  })

  it("still holds a build file the working tree has as a link to nowhere, and stops for it", async () => {
    const root = repository({ "tools/PACKAGE.ts": "throw new Error(\"run\")\n" })
    rmSync(join(root, "tools/PACKAGE.ts"))
    symlinkSync("nowhere", join(root, "tools/PACKAGE.ts"))
    const smthrs = scripted("exit 0")
    expect(await failure(asked(smthrs.command, root, await generated(root)))).toMatchObject({
      code: "unsupported",
      message: declaredRefusal(["tools/PACKAGE.ts"])
    })
    expect(smthrs.started()).toBe(0)
  })

  it("holds the generated files an earlier apply committed, which are no build file of the repository's own", async () => {
    const root = repository()
    const files = await generated(root)
    for (const file of files.filter((one) => one.written !== false)) {
      mkdirSync(join(root, file.path, ".."), { recursive: true })
      writeFileSync(join(root, file.path), file.content)
    }
    commit(root, "applied")
    const smthrs = scripted("exit 0")
    expect(await asked(smthrs.command, root, await generated(root))).toEqual([])
    expect(smthrs.started()).toBe(1)
  })
})

describe("Smithers build, as apply starts it", { timeout: 300_000 }, () => {
  it("is asked for the generated targets by name, with what a step gets of the machine and a home of its own", async () => {
    const root = repository()
    const smthrs = scripted("exit 0")
    process.env["SMITHERS_CI_TEST_SECRET"] = "a token of the person's"
    try {
      expect(await asked(smthrs.command, root, await generated(root))).toEqual([])
    } finally {
      delete process.env["SMITHERS_CI_TEST_SECRET"]
    }
    expect(smthrs.started()).toBe(1)
    const args = smthrs.args(1)
    expect(args[0]).toBe("ci")
    expect(args).not.toContain("//...")
    const labels = args.filter((arg) => arg.startsWith("//"))
    expect(labels.some((label) => label.includes("ci.yml-good"))).toBe(true)
    expect(labels.some((label) => label.includes("ci.yml-bad"))).toBe(true)
    const otherHost = process.platform === "win32" ? "linux" : "win32"
    const baseFiles = await generated(root)
    const crossHost = baseFiles.map((file) =>
      file.path === ".smithers/WORKSPACE.smithers"
        ? {
          ...file,
          content: file.content.replace(
            "const step0 = S.Shell.Test({\n",
            `const step0 = S.Shell.Test({\n  hosts: ["${otherHost}"],\n`
          )
        }
        : file
    )
    expect(await asked(smthrs.command, root, crossHost)).toEqual([])
    const filteredLabels = smthrs.args(2).filter((arg) => arg.startsWith("//"))
    expect(filteredLabels.length).toBe(labels.length - 1)
    const withoutWorkspace = baseFiles.filter((file) => file.path !== ".smithers/WORKSPACE.smithers")
    expect(await asked(smthrs.command, root, withoutWorkspace)).toEqual([])
    expect(args).toEqual(expect.arrayContaining(["--plan", "--format", "json", "--workspace", "--cache-dir"]))
    const env = smthrs.env(1)
    expect(env).not.toContain("SMITHERS_CI_TEST_SECRET")
    expect(env).not.toContain("a token of the person's")
    expect(env).toMatch(/^PATH=/m)
    expect(env).toMatch(/^HOME=.*smithers-ci-plan-.*\/home$/m)
    expect(env).toMatch(/^NODE_COMPILE_CACHE=.*smithers-ci-plan-/m)
  })

  it("fails apply when it does not answer in time, and is stopped", async () => {
    const root = repository()
    const smthrs = scripted("exec sleep 300")
    const started = Date.now()
    expect(await failure(asked(smthrs.command, root, await generated(root), "400 millis"))).toEqual({
      code: "command-failed",
      part: "cli",
      message: "Smithers build did not plan the generated files within 400ms, so nothing is written"
    })
    expect(Date.now() - started).toBeLessThan(120_000)
  })

  it("fails apply, and leaves no job out, when the plan of every target fails for a fault of this machine", async () => {
    const root = repository()
    const files = await generated(root)
    const full = scripted(refuse("ENOSPC: no space left on device, write"))
    expect(await failure(asked(full.command, root, files))).toEqual({
      code: "command-failed",
      part: "cli",
      message: "Smithers build could not plan the generated files, so nothing is written: ENOSPC: no space left on "
        + "device, write"
    })
    // It is not asked again, job by job: the fault is no job's.
    expect(full.started()).toBe(1)
    const stopped = scripted("echo Killed; exit 137")
    expect(await failure(asked(stopped.command, root, files))).toMatchObject({
      code: "command-failed",
      message: "Smithers build could not plan the generated files, so nothing is written: Killed"
    })
  })

  it("fails apply when the plan of one job's targets fails for a fault of this machine", async () => {
    // The plan of every target is refused; asked job by job, the first plans and the disk is full for the second.
    const root = repository()
    const smthrs = scripted(refuse("link_input_refused: [docs/x]"), "exit 0", refuse("ENOSPC: no space left on device"))
    const found = await failure(asked(smthrs.command, root, await generated(root)))
    expect(found).toMatchObject({ code: "command-failed", part: "cli" })
    expect(found?.message).toMatch(
      /^Smithers build could not plan the targets of ci\.yml:(good|bad), so nothing is written: ENOSPC: no space left/
    )
    expect(smthrs.started()).toBe(3)
  })

  it("leaves out the job whose targets it refuses, and every job for a refusal none meets alone", async () => {
    const root = repository()
    const files = await generated(root)
    const one = scripted(refuse("link_input_refused: [docs/x]"), "exit 0", refuse("link_input_refused: [docs/y]"))
    const found = await asked(one.command, root, files)
    expect(found).toHaveLength(1)
    expect(found[0]?.reasons).toEqual([{ feature: "build-refused", detail: "link_input_refused: [docs/y]" }])
    // Each job is asked for with its own targets alone.
    expect(one.args(2).filter((arg) => arg.startsWith("//")).length)
      .toBeLessThan(one.args(1).filter((arg) => arg.startsWith("//")).length)
    const together = scripted(refuse("duplicate_output: two targets write out/x"), "exit 0")
    expect((await asked(together.command, root, files)).map((entry) => [entry.job, entry.reasons[0]?.detail]).sort())
      .toEqual([
        ["ci.yml:bad", "duplicate_output: two targets write out/x"],
        ["ci.yml:good", "duplicate_output: two targets write out/x"]
      ])
  })
})
