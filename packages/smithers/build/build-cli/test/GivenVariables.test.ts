/**
 * A shell test held to its declared files that is given variables of the
 * host whose values differ from one run to the next, end to end.
 *
 * Every case plans real targets through the PACKAGE.ts surface in a real
 * directory, and the last one executes them with real commands in the host's
 * own read sandbox. The variable stands for the commit a CI run is for: one
 * run is given one value, the next run another.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const posixIt = it.skipIf(process.platform === "win32")
/** True when this host can hold a test to the files it declares. */
const bubblewrap = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout.trim()
const confines = process.platform === "darwin" || bubblewrap !== ""
const confinedIt = it.skipIf(!confines)

/** A commit id, a run's number, and a name that tells as much as the commit's. */
const commit = "SMTHRS_GIVEN_COMMIT"
const number = "SMTHRS_GIVEN_NUMBER"
const event = "SMTHRS_GIVEN_EVENT"
const id = (digit: string): string => digit.repeat(40)

/** Runs `body` with the host's variables set as given; `undefined` unsets one. */
const given = async <A>(values: Readonly<Record<string, string | undefined>>, body: () => Promise<A>): Promise<A> => {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
  const set = (all: Readonly<Record<string, string | undefined>>): void => {
    for (const [name, value] of Object.entries(all)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  set(values)
  try {
    return await body()
  } finally {
    set(previous)
  }
}

const fixture = async () => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-given-variables-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  const write = async (name: string, text: string): Promise<void> => {
    const file = Path.join(root, name)
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, text)
  }
  await write("src/input.txt", "pass\n")
  await write("src/more.txt", "nothing of a run\n")
  // A test of the workspace that reads the variable from its own code.
  await write("test/own.sh", `test -n "$${commit}"\n`)
  // One that reads what the command works out from the variable.
  await write("event/read.sh", `test -n "$${event}"\n`)
  await write("links/real.txt", "pass\n")
  await Fs.symlink("real.txt", Path.join(root, "links", "to"))
  // It passes only where one of the two commits is in its environment, and names no variable.
  const finds = `/usr/bin/env | /bin/grep -q -e =${id("a")} -e =${id("b")}`
  const held = (shell: string, data: string, open = false) =>
    S.Shell.Test({
      shell,
      data: [S.glob(data)],
      given: { env: [commit, number], names: [event] },
      ...(open ? { sandbox: "none" as const } : {})
    })
  const files = S.Filegroup({ srcs: [S.glob("src/*.txt")] })
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("given-variables", {
      repository: "git+https://example.invalid/given-variables.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{
      file: "PACKAGE.ts",
      packagePath: "",
      value: S.Package({
        targets: {
          files,
          plain: held(`/bin/cat src/input.txt > /dev/null && ${finds}`, "src/*.txt"),
          again: held(`/bin/cat src/more.txt > /dev/null && ${finds}`, "src/*.txt"),
          named: held(`/bin/cat src/input.txt > /dev/null; test -n "$${commit}"`, "src/*.txt"),
          own: held("/bin/sh test/own.sh", "test/*.sh"),
          told: held("/bin/sh event/read.sh || true", "event/*.sh"),
          linked: S.Shell.Test({
            shell: "/bin/cat links/to > /dev/null",
            data: [S.link("links/to")],
            given: { env: [commit, number] }
          }),
          open: held("/bin/cat src/input.txt > /dev/null", "src/*.txt", true),
          after: S.Shell.Test({
            shell: "/bin/cat src/input.txt > /dev/null",
            data: [files],
            given: { env: [commit, number] }
          })
        }
      })
    }]
  })
  // The read sandbox is found on the search path, where the host has it.
  const environment = {
    PATH: [...(bubblewrap === "" ? [] : [Path.dirname(bubblewrap)]), "/usr/bin", "/bin"].join(Path.delimiter)
  }
  const label = (name: string): string => `//:${name}`
  const options = (names: ReadonlyArray<string>) => ({
    index,
    cacheDirectory: ".flows",
    verb: "auto" as const,
    patterns: names.map(label),
    environment,
    log: () => undefined
  })
  const onPath = async <A>(body: () => Promise<A>): Promise<A> => given({ PATH: environment.PATH }, body)
  /** Plans the named targets together; answers each one's node by name. */
  const nodes = async (names: ReadonlyArray<string>) => {
    const planned = await onPath(() => plan(options(names)))
    return Object.fromEntries(names.map((name) => [name, planned.nodes.get(label(name))!]))
  }
  /** Plans and executes the named targets; answers each one's status by name. */
  const run = async (names: ReadonlyArray<string>): Promise<Record<string, string>> => {
    const summary = await onPath(async () =>
      Effect.runPromise(
        executeEffect(await plan(options(names)), options(names)).pipe(
          Effect.provideService(ExecutionServices, executionServicesLive)
        )
      )
    )
    return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
  }
  return { nodes, run, write }
}

const all = ["plain", "again", "named", "own", "told", "linked", "open", "after"] as const

describe("a test held to its declared files that is given variables of the run", () => {
  posixIt("has their values in its key only when its command or a declared file names one", async () => {
    const { nodes } = await fixture()
    const first = await given({ [commit]: id("a"), [number]: "7" }, () => nodes(all))
    const second = await given({ [commit]: id("b"), [number]: "8" }, () => nodes(all))
    for (const name of all) {
      expect(first[name]?.refusal, name).toBeUndefined()
      // Every one of them is given the values, whatever its key holds.
      expect([first[name]?.env[commit], first[name]?.env[number]], name).toEqual([id("a"), "7"])
      expect([second[name]?.env[commit], second[name]?.env[number]], name).toEqual([id("b"), "8"])
    }
    const moved = (name: string): boolean => first[name]?.keyPreview !== second[name]?.keyPreview
    // No declared file and no command names a variable: the same key at another commit, for both tests that
    // declare the same files.
    expect([moved("plain"), moved("again")]).toEqual([false, false])
    // The command names one. A declared file names one. A declared file names what the command works out from
    // one. Each has every value in its key.
    expect([moved("named"), moved("own"), moved("told")]).toEqual([true, true, true])
  })

  posixIt("has their values in its key where the declared files are not all it can read", async () => {
    const { nodes } = await fixture()
    const names = ["linked", "open", "after"]
    const first = await given({ [commit]: id("a"), [number]: "7" }, () => nodes(names))
    const second = await given({ [commit]: id("b"), [number]: "7" }, () => nodes(names))
    // A symbolic link among the files, no read sandbox, and a dependency whose outputs it may read.
    for (const name of names) expect(second[name]?.keyPreview, name).not.toBe(first[name]?.keyPreview)
  })

  posixIt(
    "keys a variable the host does not set apart from one it sets, only for a test that could read it",
    async () => {
      const { nodes } = await fixture()
      const unset = await given({ [commit]: undefined, [number]: undefined }, () => nodes(["plain", "own"]))
      const set = await given({ [commit]: id("a"), [number]: "7" }, () => nodes(["plain", "own"]))
      expect(unset["plain"]?.env[commit]).toBeUndefined()
      expect(set["plain"]?.keyPreview).toBe(unset["plain"]?.keyPreview)
      expect(set["own"]?.keyPreview).not.toBe(unset["own"]?.keyPreview)
    }
  )

  posixIt("looks at the files as they are when it plans", async () => {
    const { nodes, write } = await fixture()
    const before = await given({ [commit]: id("a") }, () => nodes(["plain"]))
    // A declared file now reads the variable from its own code.
    await write("src/more.txt", `uses ${commit}\n`)
    const named = await given({ [commit]: id("a") }, () => nodes(["plain"]))
    const moved = await given({ [commit]: id("b") }, () => nodes(["plain"]))
    expect(named["plain"]?.keyPreview).not.toBe(before["plain"]?.keyPreview)
    expect(moved["plain"]?.keyPreview).not.toBe(named["plain"]?.keyPreview)
  })

  confinedIt(
    "runs with the values, is reused at another commit when it names none, and runs again when it names one",
    async () => {
      const { run } = await fixture()
      const names = ["plain", "own"]
      // Both find the commit: one in its environment by value, the other by the name its own file reads.
      expect(await given({ [commit]: id("a"), [number]: "7" }, () => run(names))).toEqual({ plain: "ran", own: "ran" })
      expect(await given({ [commit]: id("a"), [number]: "7" }, () => run(names))).toEqual({ plain: "hit", own: "hit" })
      // Another commit and another run: only the test whose file names the variable runs again.
      expect(await given({ [commit]: id("b"), [number]: "8" }, () => run(names))).toEqual({ plain: "hit", own: "ran" })
      // Given no commit at all, the test that looks for one in its environment has nothing stored and fails.
      await Fs.rm(Path.join(temporary[0]!, "ws", ".flows"), { recursive: true, force: true })
      expect(await given({ [commit]: undefined, [number]: undefined }, () => run(["plain"]))).toEqual({
        plain: "failed"
      })
    },
    120_000
  )
})
