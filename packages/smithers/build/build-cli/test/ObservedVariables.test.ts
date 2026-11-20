/**
 * An observed shell test that is given variables of the host whose values
 * differ from one run to the next, end to end.
 *
 * Every case plans and executes real targets through the PACKAGE.ts surface,
 * in a real git repository, with real commands under the host's own
 * `strace`. The variable stands for the commit a CI run is for: one run is
 * given one value, the next run another.
 */
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

/** The host's tracer, when it has one that can trace a process here. */
const host = ObservedReads.observer(ExecSandbox.host())
const tracedIt = it.skipIf("reason" in host)
const posixIt = it.skipIf(process.platform === "win32")

/** A commit id, and a value too short to look for. */
const commit = "SMTHRS_OBSERVED_COMMIT"
const attempt = "SMTHRS_OBSERVED_ATTEMPT"
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
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-observed-variables-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  const write = async (name: string, text: string): Promise<void> => {
    const file = Path.join(root, name)
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, text)
  }
  // The workspace's own files are the ones git does not ignore. What is installed and what is built is ignored.
  await write(".gitignore", "node_modules\n.flows\nstamp.txt\n")
  expect(spawnSync("git", ["-C", root, "init", "--quiet"]).status).toBe(0)
  await write("input.txt", "pass\n")
  await write("docs/readme.md", "nothing reads this\n")
  // A test of the repository that reads the variable from its own code.
  await write("test/own.sh", `test -n "$${commit}"\n`)
  // A workflow that names the variable its runner sets, and a check that reads it as data and uses no variable.
  await write(".github/workflows/ci.yml", `jobs:\n  a:\n    steps:\n      - run: echo "$${commit}"\n`)
  await write("test/workflows.sh", "/bin/cat .github/workflows/ci.yml > /dev/null\n")
  // Tools: each names the variable in its own code, as many tools hold names they act on only sometimes.
  await write("node_modules/tool/quiet.sh", `test -n "$${commit}"\n`)
  await write("node_modules/tool/print.sh", `/usr/bin/printenv ${commit}\n`)
  await write("node_modules/tool/stamp.sh", `/usr/bin/printenv ${commit} > stamp.txt\n`)
  await write("node_modules/tool/pass.sh", `/bin/echo "$${commit}" > /dev/null\n`)
  await write("node_modules/tool/warn.sh", `/usr/bin/printenv ${commit} >&2\n`)
  const reads = "/bin/cat input.txt > /dev/null"
  const observed = (shell: string) =>
    S.Shell.Test({ sandbox: "none", data: [S.glob("**")], shell, observe: { env: [commit, attempt] } })
  /** An observed test that reads the workflows as data. */
  const reading = (shell: string) =>
    S.Shell.Test({
      sandbox: "none",
      data: [S.glob("**")],
      shell,
      observe: { env: [commit, attempt], readAsData: [".github/workflows"] }
    })
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("observed-variables", {
      repository: "git+https://example.invalid/observed-variables.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{
      file: "PACKAGE.ts",
      packagePath: "",
      value: S.Package({
        targets: {
          plain: observed(reads),
          named: observed(`${reads}; test -n "$${commit}"`),
          own: observed("/bin/sh test/own.sh"),
          quiet: observed("/bin/sh node_modules/tool/quiet.sh"),
          printed: observed("/bin/sh node_modules/tool/print.sh"),
          stamped: observed("/bin/sh node_modules/tool/stamp.sh"),
          passed: observed("/bin/sh node_modules/tool/pass.sh"),
          warned: observed("/bin/sh node_modules/tool/warn.sh"),
          counted: observed(`${reads}; : "\${${attempt}-}"`),
          workflows: reading("/bin/sh test/workflows.sh"),
          workflowsNamed: reading(`/bin/sh test/workflows.sh; test -n "$${commit}"`),
          workflowsOwn: reading("/bin/sh test/workflows.sh; /bin/sh test/own.sh"),
          workflowsUnmarked: observed("/bin/sh test/workflows.sh"),
          // The same variable given the way that always keys on it.
          inherited: S.Shell.Test({
            sandbox: "none",
            data: [S.glob("**")],
            shell: reads,
            observe: true,
            inheritEnv: [commit]
          })
        }
      })
    }]
  })
  const environment = {
    PATH: [...("tracer" in host ? [Path.dirname(host.tracer)] : []), "/usr/bin", "/bin"].join(Path.delimiter)
  }
  const label = (name: string): string => `//:${name}`
  const logs: Array<string> = []
  const options = (names: ReadonlyArray<string>) => ({
    index,
    cacheDirectory: ".flows",
    verb: "auto" as const,
    patterns: names.map(label),
    environment,
    log: (line: string) => {
      logs.push(line)
    }
  })
  const onPath = async <A>(body: () => Promise<A>): Promise<A> => given({ PATH: environment.PATH }, body)
  const node = async (name: string) => (await onPath(() => plan(options([name])))).nodes.get(label(name))!
  /** Plans and executes the named targets; answers each one's status by name. */
  const run = async (
    names: ReadonlyArray<string>,
    services: ExecutionServices = executionServicesLive
  ): Promise<Record<string, string>> => {
    const summary = await onPath(async () =>
      Effect.runPromise(
        executeEffect(await plan(options(names)), options(names)).pipe(
          Effect.provideService(ExecutionServices, services)
        )
      )
    )
    return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
  }
  return { root, write, run, node, logs }
}

const each = (names: ReadonlyArray<string>, status: string): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, status]))

describe("a plan", () => {
  posixIt(
    "gives an observed test the variables it names, and keeps their values out of its declaration's key",
    async () => {
      const { node } = await fixture()
      const first = await given({ [commit]: id("a"), [attempt]: undefined }, () => node("plain"))
      const second = await given({ [commit]: id("b"), [attempt]: "2" }, () => node("plain"))
      expect(first.refusal).toBeUndefined()
      expect(first.observed?.variables).toEqual({ [commit]: id("a"), [attempt]: undefined })
      expect(second.observed?.variables).toEqual({ [commit]: id("b"), [attempt]: "2" })
      // The run is given the value. The declaration's key is the same at every value.
      expect(first.env[commit]).toBe(id("a"))
      expect(second.env[commit]).toBe(id("b"))
      expect(second.observed?.key).toBe(first.observed?.key)
      // The key a host that cannot observe falls back on holds every value.
      expect(second.keyPreview).not.toBe(first.keyPreview)
      // A variable given with `inheritEnv` is part of the declaration's key, as before.
      const kept = await given({ [commit]: id("a") }, () => node("inherited"))
      const moved = await given({ [commit]: id("b") }, () => node("inherited"))
      expect(kept.observed?.variables).toEqual({})
      expect(moved.observed?.key).not.toBe(kept.observed?.key)
    }
  )
})

describe("an observed test given a variable that differs from run to run", () => {
  const used = ["named", "own", "printed", "warned", "stamped", "passed"]
  const unused = ["plain", "quiet"]
  const all = [...unused, ...used]

  tracedIt("is answered at another value when it never used the variable, and runs again when it did", async () => {
    const { logs, root, run } = await fixture()
    expect(await given({ [commit]: id("a") }, () => run(all))).toEqual(each(all, "ran"))
    expect(await given({ [commit]: id("a") }, () => run(all))).toEqual(each(all, "hit"))
    // Another commit. A test that never named the variable is a hit. So is one whose tool holds the name and
    // did nothing with the value that shows.
    expect(await given({ [commit]: id("b") }, () => run(all))).toEqual({ ...each(unused, "hit"), ...each(used, "ran") })
    for (const name of used) {
      expect(logs).toContain(`//:${name}  runs again: the variable ${commit} has another value`)
    }
    expect(logs.filter((line) => line.includes("runs again") && unused.some((name) => line.includes(`//:${name} `))))
      .toEqual([])
    expect(await Fs.readFile(Path.join(root, "stamp.txt"), "utf8")).toBe(`${id("b")}\n`)
    // Each value now has a record.
    expect(await given({ [commit]: id("b") }, () => run(all))).toEqual(each(all, "hit"))
    expect(await given({ [commit]: id("a") }, () => run(all))).toEqual(each(all, "hit"))
  })

  tracedIt("still runs again when a file it read changes, whatever the variable holds", async () => {
    const { run, write } = await fixture()
    expect(await given({ [commit]: id("a") }, () => run(["plain"]))).toEqual({ plain: "ran" })
    await write("docs/readme.md", "changed\n")
    expect(await given({ [commit]: id("b") }, () => run(["plain"]))).toEqual({ plain: "hit" })
    await write("input.txt", "pass, changed\n")
    expect(await given({ [commit]: id("b") }, () => run(["plain"]))).toEqual({ plain: "ran" })
  })

  tracedIt("finds a value too short to look for by its name alone, set or not", async () => {
    const { logs, run } = await fixture()
    expect(await given({ [attempt]: undefined }, () => run(["counted", "plain"]))).toEqual(
      each(["counted", "plain"], "ran")
    )
    expect(await given({ [attempt]: undefined }, () => run(["counted", "plain"]))).toEqual(
      each(["counted", "plain"], "hit")
    )
    expect(await given({ [attempt]: "1" }, () => run(["counted", "plain"]))).toEqual({ counted: "ran", plain: "hit" })
    expect(logs).toContain(`//:counted  runs again: the variable ${attempt} has another value`)
    expect(await given({ [attempt]: "1" }, () => run(["counted", "plain"]))).toEqual({ counted: "hit", plain: "hit" })
  })
})

describe("an observed test that reads the workflows as data", () => {
  // Lead's decision (2026-11-19): a workflow file a step's program reads is read as data. GitHub runs it; the step
  // does not. A runner variable's name in it says nothing of the step, which is still held to its own text and to
  // every other file it read.
  const reused = ["workflows"]
  const again = ["workflowsNamed", "workflowsOwn", "workflowsUnmarked"]
  const all = [...reused, ...again]

  tracedIt(
    "is answered at another commit when nothing it read changed, and runs again when its own text names it",
    async () => {
      const { logs, run } = await fixture()
      expect(await given({ [commit]: id("a") }, () => run(all))).toEqual(each(all, "ran"))
      expect(await given({ [commit]: id("b") }, () => run(all))).toEqual({
        ...each(reused, "hit"),
        ...each(again, "ran")
      })
      // The step's own text names it, a script it runs names it, and a test that does not read the workflows as data
      // counts the workflow's name, as before.
      for (const name of again) {
        expect(logs).toContain(`//:${name}  runs again: the variable ${commit} has another value`)
      }
    }
  )

  tracedIt("runs again when the workflow it read changes", async () => {
    const { logs, run, write } = await fixture()
    expect(await given({ [commit]: id("a") }, () => run(reused))).toEqual(each(reused, "ran"))
    expect(await given({ [commit]: id("b") }, () => run(reused))).toEqual(each(reused, "hit"))
    await write(".github/workflows/ci.yml", `jobs:\n  b:\n    steps:\n      - run: echo "$${commit}"\n`)
    expect(await given({ [commit]: id("b") }, () => run(reused))).toEqual(each(reused, "ran"))
    expect(logs).toContain("//:workflows  runs again: .github/workflows/ci.yml changed")
  })
})

describe("a host that cannot observe a run", () => {
  posixIt("keys the test by every variable it is given", async () => {
    const { run, write } = await fixture()
    const unobserving: ExecutionServices = {
      ...executionServicesLive,
      observer: () => ({ reason: "strace is not installed" })
    }
    expect(await given({ [commit]: id("a") }, () => run(["plain"], unobserving))).toEqual({ plain: "ran" })
    expect(await given({ [commit]: id("a") }, () => run(["plain"], unobserving))).toEqual({ plain: "hit" })
    // Nothing says whether the run used the variable, so another value is another result.
    expect(await given({ [commit]: id("b") }, () => run(["plain"], unobserving))).toEqual({ plain: "ran" })
    expect(await given({ [commit]: id("b") }, () => run(["plain"], unobserving))).toEqual({ plain: "hit" })
    await write("docs/readme.md", "changed\n")
    expect(await given({ [commit]: id("b") }, () => run(["plain"], unobserving))).toEqual({ plain: "ran" })
  })
})
