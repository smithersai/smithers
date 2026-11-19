/**
 * A tool that writes into its own installed directory the first time it runs.
 *
 * Some packages ship a launcher that finds its platform binary in another
 * package and, when its install script never ran, links that binary beside
 * itself on first use. A fresh install is in that state on every CI machine.
 * The link changes an installed tree after the plan measured it, so every
 * result keyed on that tree would be stored under bytes its run did not read.
 *
 * Every case plans and executes real targets through the PACKAGE.ts surface
 * in a real temporary workspace. The package manager, the runtime and the
 * tools are small real programs; the launcher really links, and really falls
 * back when the directory refuses the write. Protection is the host's own
 * bubblewrap, so the cases that need it run on Linux hosts that have it.
 */
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type * as Executor from "../src/Executor.ts"
import {
  executeEffect,
  ExecutionServices,
  executionServicesLive,
  protectedEntries,
  refusedByProtection
} from "../src/internal/PackageRunner.ts"
import { type PackagePlan, plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

/** Whether this host can confine a run under a scratch layer: Linux with bubblewrap. */
const provable = ExecSandbox.enforceable(
  { policy: undefined, reads: [], writes: [], scratch: true },
  ExecSandbox.host()
)
const confinedIt = it.skipIf(!provable)
const linuxIt = it.skipIf(process.platform !== "linux")
/** A user the host refuses a read: root reads a file whatever its mode. */
const unprivilegedIt = it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)

/** The directory holding the host's bubblewrap, when it has one. */
const mechanismDirectory = (process.env["PATH"] ?? "").split(Path.delimiter)
  .find((directory) => Path.isAbsolute(directory) && NodeFs.existsSync(Path.join(directory, "bwrap")))

/** Runs `body` with the process search path set to `path`: a target body resolves its package manager there. */
const withPath = async <A>(path: string, body: () => Promise<A>): Promise<A> => {
  const previous = process.env["PATH"]
  process.env["PATH"] = path
  try {
    return await body()
  } finally {
    process.env["PATH"] = previous
  }
}

/**
 * What the launcher does before its real work: when no binary sits beside it,
 * it links the platform package's. `tolerant` carries on from the platform
 * package when the link is refused, as a launcher built for read-only file
 * systems does; otherwise the refusal is the tool's failure.
 */
const firstUse = (tolerant: boolean): string =>
  "d=./node_modules/formatter\n" +
  "if [ ! -e \"$d/native\" ]; then\n" +
  `  /bin/ln ./node_modules/formatter-linux/native "$d/native"${tolerant ? " 2>/dev/null || true" : " || exit 1"}\n` +
  "fi\n"

interface FixtureOptions {
  /** Whether the launcher carries on when it cannot link; true unless stated. */
  readonly tolerant?: boolean
}

const fixture = async (options: FixtureOptions = {}) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-first-use-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  const tools = Path.join(base, "tools", "bin")
  const write = async (name: string, text: string, mode = 0o644): Promise<void> => {
    const file = Path.isAbsolute(name) ? name : Path.join(root, name)
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, text, { mode })
    await Fs.chmod(file, mode)
  }
  // The manager resolves a tool from the directory it starts in, as `pnpm exec` does.
  await write(
    Path.join(tools, "pnpm"),
    "#!/bin/sh\nif [ \"$1\" = exec ]; then shift; tool=\"$1\"; shift; exec \"./node_modules/.bin/$tool\" \"$@\"; fi\n" +
      "printf '11.21.0\\n'\n",
    0o755
  )
  // The runtime's own test runner runs the files it is handed.
  await write(
    Path.join(tools, "node"),
    "#!/bin/sh\nif [ \"$1\" = --test ]; then shift; exec /bin/sh \"$@\"; fi\nprintf '26.4.0\\n'\n",
    0o755
  )
  await write("package.json", "{\"name\":\"fixture\",\"private\":true}\n")
  await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write("pkg/package.json", "{\"name\":\"pkg\"}\n")
  await write("pkg/source.ts", "export const value = 1\n")
  await write("pkg/config.json", "{}\n")
  // Two installed packages: the launcher's own, and the platform binary it links beside itself.
  await write("pkg/node_modules/formatter-linux/native", "binary\n", 0o755)
  await write("pkg/node_modules/formatter/package.json", "{\"name\":\"formatter\"}\n")
  // What a package manager leaves beside the packages: its own state, and a link to one of them.
  await write("pkg/node_modules/.modules.yaml", "layoutVersion: 5\n")
  await Fs.symlink("formatter", Path.join(root, "pkg/node_modules/linked"))
  // Every tool keeps state of its own under a dot name in the tree, which no key measures.
  const launcher = `#!/bin/sh\n${firstUse(options.tolerant ?? true)}/bin/cat source.ts > /dev/null\n` +
    "/bin/mkdir -p ./node_modules/.tool-state && echo seen > ./node_modules/.tool-state/seen\n"
  for (const tool of ["dprint", "eslint", "vitest", "vibelang"]) {
    await write(`pkg/node_modules/.bin/${tool}`, launcher, 0o755)
  }
  // A test file the runtime's runner executes: it starts the same launcher.
  await write("pkg/first.test.ts", `${firstUse(options.tolerant ?? true)}/bin/cat source.ts > /dev/null\n`)
  const sources = [S.file("source.ts")]
  // A format check that rewrites its sources is never reused, so it runs as the workspace declares: unconfined.
  const fmt = S.Dprint({ sources, deps: [], config: S.file("config.json"), fix: true, cwd: "pkg" })
  const one = S.NodeTest({
    runner: S.testRunner([S.file("first.test.ts")]),
    srcs: sources,
    deps: [],
    cwd: "pkg",
    cache: true
  })
  const targets = {
    fmt,
    // Each consumer finishes after the format check, as most of a workspace does.
    lint: S.EsLint({ sources, deps: [fmt], configs: [S.file("config.json")], maxWarnings: 0, fix: false, cwd: "pkg" }),
    check: S.Typecheck({
      srcs: sources,
      deps: [fmt],
      tsconfig: S.file("config.json"),
      buildMode: false,
      incremental: false,
      cwd: "pkg"
    }),
    one,
    two: S.NodeTest({
      runner: S.testRunner([S.file("first.test.ts")]),
      srcs: sources,
      deps: [one],
      cwd: "pkg",
      cache: true
    }),
    test: S.Vitest({
      tests: [S.file("first.test.ts")],
      sources,
      deps: [one],
      config: S.file("config.json"),
      environment: "node",
      passWithNoTests: false,
      cwd: "pkg"
    }),
    // A declaration that asks for no reuse at all.
    fresh: S.NodeTest({
      runner: S.testRunner([S.file("first.test.ts")]),
      srcs: sources,
      deps: [],
      cwd: "pkg",
      cache: false
    }),
    // A declaration that asks for the host exactly as it is.
    open: S.Vitest({
      tests: [S.file("first.test.ts")],
      sources,
      deps: [],
      config: S.file("config.json"),
      environment: "node",
      passWithNoTests: false,
      sandbox: "none",
      cwd: "pkg"
    })
  }
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("first-use", {
      repository: "git+https://example.invalid/first-use.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ version: ">=26.4.0", executable: Path.join(tools, "node") }),
      packageManager: S.PackageManager.Pnpm({
        manifest: S.file("//package.json"),
        lockfile: S.file("//pnpm-lock.yaml"),
        version: "11.21.0"
      }),
      nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
      // The workspace turned build confinement off, as one that grew up without it does.
      sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
    }),
    factory: undefined,
    packages: [{ file: "pkg/PACKAGE.ts", packagePath: "pkg", value: S.Package({ targets }) }]
  })
  const environment = {
    PATH: [tools, ...(mechanismDirectory === undefined ? [] : [mechanismDirectory])].join(Path.delimiter)
  }
  const logs: Array<string> = []
  /**
   * Plans and executes the named targets under `services`; answers the whole
   * summary. `between` runs after the plan and answers the plan to execute.
   */
  const summarize = async (
    names: ReadonlyArray<string>,
    services: Partial<ExecutionServices> = {},
    between: (planned: PackagePlan) => Promise<PackagePlan> = async (planned) => planned
  ): Promise<Executor.Summary> => {
    const patterns = names.map((name) => `//pkg:${name}`)
    const planned = (): Promise<PackagePlan> =>
      plan({ index, cacheDirectory: ".flows", verb: "auto", patterns, environment })
    return withPath(environment.PATH, async () =>
      Effect.runPromise(
        executeEffect(await between(await planned()), {
          index,
          cacheDirectory: ".flows",
          verb: "auto",
          patterns,
          environment,
          log: (line) => logs.push(line)
        }).pipe(Effect.provideService(ExecutionServices, { ...executionServicesLive, ...services }))
      ))
  }
  const statuses = (summary: Executor.Summary): Record<string, string> =>
    Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
  /** Plans and executes the named targets; answers each one's status by name. */
  const run = async (...names: ReadonlyArray<string>): Promise<Record<string, string>> =>
    statuses(await summarize(names))
  /** Whether the launcher's link reached the real installed tree. */
  const linked = (): boolean => NodeFs.existsSync(Path.join(root, "pkg/node_modules/formatter/native"))
  const notCached = (): ReadonlyArray<string> => logs.filter((line) => line.includes("not cached"))
  /** Whether a tool's own state under a dot name reached the real installed tree. */
  const toolState = (): boolean => NodeFs.existsSync(Path.join(root, "pkg/node_modules/.tool-state/seen"))
  const replan = (names: ReadonlyArray<string>): Promise<PackagePlan> =>
    plan({
      index,
      cacheDirectory: ".flows",
      verb: "auto",
      patterns: names.map((name) => `//pkg:${name}`),
      environment
    })
  return { root, write, run, summarize, statuses, logs, linked, notCached, toolState, replan }
}

/** Host facts that find no sandbox program, as a host without one answers. */
const withoutMechanism: Partial<ExecutionServices> = {
  sandboxHost: () => ({ ...ExecSandbox.host(), executable: () => undefined })
}

const changed = "an installed tree changed after it was planned"
/** Why a target that waits for one whose tree changed stores nothing: that one's key names a tree its run did not read. */
const waited = "the inputs of a target it waits for changed while that one ran"
/** What a line adds on a host with no mechanism to hold a tree. */
const unheld = "; installed trees are not held read-only on this host: " +
  "write protection needs bubblewrap, and bwrap is not on PATH (install the bubblewrap package)"

describe("a tool that links its binary into its installed directory on first use", () => {
  confinedIt("leaves the tree the plan measured, so the next run of the same tree hits", async () => {
    const { run, linked, notCached, toolState } = await fixture()
    // A format check that rewrites its sources is never reused; the lint and the type check that share its launcher are.
    expect(await run("fmt", "lint", "check")).toEqual({ fmt: "ran", lint: "ran", check: "ran" })
    expect(linked()).toBe(false)
    expect(notCached()).toEqual([])
    // The format check ran as the workspace declares, unconfined: its own state in the tree was written as before.
    expect(toolState()).toBe(true)
    expect(await run("fmt", "lint", "check")).toEqual({ fmt: "ran", lint: "hit", check: "hit" })
    expect(linked()).toBe(false)
  })

  confinedIt("answers the second run from the cache where a result is reusable", async () => {
    const { run, linked, notCached } = await fixture()
    expect(await run("one", "test")).toEqual({ one: "ran", test: "ran" })
    expect(linked()).toBe(false)
    expect(notCached()).toEqual([])
    // `one` asserts what it reads (`cache: true`) and nothing confines or observes its run. Built alone it is
    // answered; while `test` waits for it, it runs again, because nothing says what it writes.
    expect(await run("one")).toEqual({ one: "hit" })
    expect(await run("one", "test")).toEqual({ one: "ran", test: "hit" })
  })

  confinedIt("runs a tool that cannot fall back once more with the tree open, and stores nothing", async () => {
    const { summarize, statuses, linked, logs, notCached, run } = await fixture({ tolerant: false })
    const first = await summarize(["one", "two"])
    expect(statuses(first)).toEqual({ one: "ran", two: "ran" })
    // The launcher needed the write, got it on the second try, and the tree is no longer the planned one.
    expect(linked()).toBe(true)
    expect(logs).toContain(
      "//pkg:one  ran again with its installed trees writable: " +
        "the first run failed on the protection that holds them read-only"
    )
    const reason = `not cached: ${changed}: pkg/node_modules unit formatter: native was written`
    // The second target started after the write and is keyed on the tree as it found it; the first one's key is not.
    expect(notCached()).toEqual([`//pkg:one  ${reason}`, `//pkg:two  not cached: ${waited}`])
    expect(first.notStored).toEqual([{ reason: changed, count: 1 }, { reason: waited, count: 1 }])
    expect(Object.fromEntries(first.results.map((result) => [result.label, result.notStored]))).toEqual({
      "//pkg:one": changed,
      "//pkg:two": waited
    })
    // The tree is settled now: this run stores, and the one after it answers `two`.
    const second = await summarize(["one", "two"])
    expect(statuses(second)).toEqual({ one: "ran", two: "ran" })
    expect(second.notStored).toBeUndefined()
    // `one` runs again while `two` waits for it: nothing confines or observes its run.
    expect(await run("one", "two")).toEqual({ one: "ran", two: "hit" })
  })
})

describe("a target that declares sandbox: \"none\"", () => {
  linuxIt("runs on the host as it is: its tool's write lands, and its result is never reused", async () => {
    const { summarize, statuses, linked, notCached } = await fixture()
    const summary = await summarize(["open"])
    expect(statuses(summary)).toEqual({ open: "ran" })
    expect(linked()).toBe(true)
    expect(notCached()).toEqual([])
    expect(summary.notStored).toEqual([
      { reason: "the target declares sandbox: \"none\", so no run of it is confined", count: 1 }
    ])
  })
})

describe("a failure the protection caused", () => {
  it("is read from the tool's own words, in any case, plain or inside a rendered failure", () => {
    for (
      const output of [
        "ln: failed to create hard link 'native': Read-only file system",
        "open /ws/node_modules/tool/cache: read-only file system",
        "Error: EROFS: read-only file system, open '/ws/node_modules/tool/cache'",
        "Error: EXDEV: cross-device link not permitted, link 'a' -> 'b'",
        "ln: failed to create hard link 'copy' => 'unit/program': Invalid cross-device link",
        "sudo: The \"no new privileges\" flag is set, which prevents sudo from running as root.",
        "bwrap: execvp tool: No such file or directory",
        "first line\nbwrap: Can't mount proc on /newroot/proc: Operation not permitted",
        "{\"_tag\":\"smithers-build/ExecError\",\"stderr\":\"bwrap: setting up uid map: Permission denied\\n\"}",
        "{\"stderr\":\"warning\\nbwrap: loopback: Failed RTM_NEWADDR\"}"
      ]
    ) expect(refusedByProtection(output), output).toBe(true)
    for (
      const output of [
        "1 test failed: expected 2 to be 3",
        "error TS2322: Type 'string' is not assignable to type 'number'",
        "cannot find module 'bwrap: helper'",
        "Permission denied"
      ]
    ) expect(refusedByProtection(output), output).toBe(false)
  })
})

describe("the entries of a tree a run finds read-only", () => {
  it("are its real keyed entries: no link, and no state under a dot name", async () => {
    const { root } = await fixture()
    await Fs.mkdir(Path.join(root, "pkg/node_modules/.pnpm/formatter@1"), { recursive: true })
    expect([...protectedEntries(root, ["pkg/node_modules"])].sort()).toEqual([
      "pkg/node_modules/.bin",
      "pkg/node_modules/.pnpm",
      "pkg/node_modules/formatter",
      "pkg/node_modules/formatter-linux"
    ])
  })

  it("are none for a tree that is missing or is itself a link", async () => {
    const { root } = await fixture()
    await Fs.symlink("pkg/node_modules", Path.join(root, "linked-tree"))
    expect(protectedEntries(root, ["absent/node_modules", "linked-tree"])).toEqual([])
  })
})

describe("the results a run does not store", () => {
  confinedIt("are counted by reason: a mode that reuses nothing, and a declaration that asks for none", async () => {
    const { summarize, statuses } = await fixture()
    const summary = await summarize(["fmt", "fresh", "lint"])
    expect(statuses(summary)).toEqual({ fmt: "ran", fresh: "ran", lint: "ran" })
    expect(summary.notStored).toEqual([
      { reason: "fix mode rewrites its sources", count: 1 },
      { reason: "the target declares cache: false", count: 1 }
    ])
    // Neither is news about one run, so no row carries a reason.
    expect(summary.results.map((result) => result.notStored)).toEqual([undefined, undefined, undefined])
  })

  linuxIt("name only the tree when this plan did not measure it", async () => {
    const { summarize, write, notCached, replan } = await fixture()
    // Something else on the host writes into the tree after the plan, and the plan carries no measurement.
    const unmeasured = await summarize(["one"], withoutMechanism, async (planned) => {
      await write("pkg/node_modules/formatter/native", "binary\n", 0o755)
      return { ...planned, installedTrees: new Map() }
    })
    expect(unmeasured.notStored).toEqual([{ reason: changed, count: 1 }])
    expect(notCached()).toEqual([`//pkg:one  not cached: ${changed}: pkg/node_modules${unheld}`])
    // A measurement taken after the change has nothing to compare: the tree is still named.
    const { summarize: again, write: writeAgain, notCached: lines, replan: later } = await fixture()
    await again(["one"], withoutMechanism, async (planned) => {
      await writeAgain("pkg/node_modules/formatter/native", "binary\n", 0o755)
      return { ...planned, installedTrees: (await later(["one"])).installedTrees }
    })
    expect(lines()).toEqual([`//pkg:one  not cached: ${changed}: pkg/node_modules${unheld}`])
    expect((await replan(["one"])).installedTrees.size).toBe(1)
  })

  unprivilegedIt(
    "count a tree that cannot be measured again as changed, and keep the target green",
    async () => {
      const { summarize, statuses, write, notCached } = await fixture()
      // A file appears in the tree after the plan that the check after the run cannot read.
      const summary = await summarize(["one"], withoutMechanism, async (planned) => {
        await write("pkg/node_modules/formatter/unreadable", "bytes\n", 0o000)
        return planned
      })
      expect(statuses(summary)).toEqual({ one: "ran" })
      expect(summary.notStored).toEqual([{ reason: changed, count: 1 }])
      expect(notCached().length).toBe(1)
      expect(notCached()[0]).toContain(
        `//pkg:one  not cached: ${changed}: pkg/node_modules could not be measured again: `
      )
      expect(notCached()[0]).toContain("EACCES")
    }
  )
})

describe("a host that cannot protect an installed tree", () => {
  linuxIt("lets the write land, stores nothing under the planned key, and names what changed", async () => {
    const { summarize, statuses, linked, notCached } = await fixture()
    const first = await summarize(["one", "two"], withoutMechanism)
    expect(statuses(first)).toEqual({ one: "ran", two: "ran" })
    expect(linked()).toBe(true)
    const reason = `not cached: ${changed}: pkg/node_modules unit formatter: native was written${unheld}`
    expect(notCached()).toEqual([`//pkg:one  ${reason}`, `//pkg:two  not cached: ${waited}`])
    expect(first.notStored).toEqual([{ reason: changed, count: 1 }, { reason: waited, count: 1 }])
    // The second run plans the settled tree and stores; the third answers `two`, and runs `one` again for it.
    const second = await summarize(["one", "two"], withoutMechanism)
    expect(statuses(second)).toEqual({ one: "ran", two: "ran" })
    expect(second.notStored).toBeUndefined()
    expect(statuses(await summarize(["one", "two"], withoutMechanism))).toEqual({ one: "ran", two: "hit" })
  })

  confinedIt("runs unprotected when the mechanism is there and cannot start", async () => {
    const { summarize, statuses, linked, notCached } = await fixture()
    const refused: Partial<ExecutionServices> = { writeProtection: () => "user namespaces are not permitted" }
    const first = await summarize(["one", "two"], refused)
    expect(statuses(first)).toEqual({ one: "ran", two: "ran" })
    expect(linked()).toBe(true)
    expect(notCached().length).toBe(2)
    expect(notCached()[0]).toContain(
      "native was written; installed trees are not held read-only on this host: user namespaces are not permitted"
    )
    expect(notCached()[1]).toBe(`//pkg:two  not cached: ${waited}`)
    expect(first.notStored).toEqual([{ reason: changed, count: 1 }, { reason: waited, count: 1 }])
  })
})
