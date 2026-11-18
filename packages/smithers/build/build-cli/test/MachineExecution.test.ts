/**
 * Targets that name a machine, end to end.
 *
 * Every case plans and executes real targets through the PACKAGE.ts surface,
 * in a real git checkout, with real shell commands. The cases that need a
 * record of what a run read use the host's own `strace` and run on Linux
 * hosts that have it. A host without a tracer is supplied through the
 * execution services.
 */
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Machine.remove(root)))
})

/** The host's tracer, when it has one that can trace a process here. */
const host = ObservedReads.observer(ExecSandbox.host())
const tracedIt = it.skipIf("reason" in host)
const posixIt = it.skipIf(process.platform === "win32")
/** A host that cannot record what a run reads, as macOS is. */
const untraced: ExecutionServices = {
  ...executionServicesLive,
  observer: () => ({ reason: "strace is not installed" })
}

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Machine", "-c", "user.email=machine@example.invalid", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

type Targets = Parameters<typeof S.Package>[0]["targets"]

/** A shell test on a machine, observed. */
const on = (machine: string, shell: string, data: ReadonlyArray<unknown> = []) =>
  S.Shell.Test({
    shell,
    machine,
    sandbox: "none",
    observe: true,
    data: [S.glob("**"), ...data] as never
  })

const fixture = async (targets: (base: string) => Targets) => {
  // Beside the temporary directory, as a user's cache directory is: what a run leaves in a machine's home is then
  // left outside the workspace and the temporary directory.
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-machine-run-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  const write = async (name: string, text: string): Promise<void> => {
    const file = Path.isAbsolute(name) ? name : Path.join(root, name)
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, text)
  }
  await Fs.mkdir(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  await write(".gitignore", ".flows\nnode_modules\n")
  await write("shared.txt", "ok\n")
  await write("a.txt", "a\n")
  await write("b.txt", "b\n")
  await write("docs/readme.md", "nothing reads this\n")
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "one")
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("machines", {
      repository: "git+https://example.invalid/machines.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: targets(base) }) }]
  })
  const kept = Path.join(base, "machines")
  const environment: Record<string, string> = {
    PATH: [...("tracer" in host ? [Path.dirname(host.tracer)] : []), "/usr/bin", "/bin"].join(Path.delimiter),
    HOME: Path.join(base, "home"),
    [Machine.holdingVariable]: kept
  }
  await Fs.mkdir(environment["HOME"]!)
  const logs: Array<string> = []
  const options = (names: ReadonlyArray<string>, jobs: number) => ({
    index,
    cacheDirectory: ".flows",
    verb: "auto" as const,
    patterns: names.map((name) => `//:${name}`),
    environment,
    jobs,
    log: (line: string) => {
      logs.push(line)
    }
  })
  /** Plans and executes the named targets; answers each one's status by name, and the first line of each failure. */
  const run = async (
    names: ReadonlyArray<string>,
    services: ExecutionServices = executionServicesLive,
    jobs = 1
  ): Promise<Record<string, string>> => {
    const previous = process.env["PATH"]
    process.env["PATH"] = environment["PATH"]
    try {
      const summary = await Effect.runPromise(
        executeEffect(await plan(options(names, jobs)), options(names, jobs)).pipe(
          Effect.provideService(ExecutionServices, services)
        )
      )
      return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
    } finally {
      process.env["PATH"] = previous
    }
  }
  /** The names of the machines a run made, from what the run said. */
  const made = (): ReadonlyArray<string> =>
    logs.flatMap((line) => /^smthrs: machine (.+) has a fresh checkout/.exec(line)?.[1] ?? []).sort()
  return { base, root, write, run, logs, made, kept, environment }
}

describe("targets on two machines", () => {
  posixIt("never see what the other wrote, in the tree, the home or the temporary directory", async () => {
    // The second ship review's blockers 2 and 4: on a CI system each of these jobs passes on a runner of its own.
    const { made, root, run, write } = await fixture(() => ({
      mutate: on("mutate", "echo bad > shared.txt && touch leftover.flag"),
      pristine: on("pristine", "grep -q ok shared.txt && test ! -e leftover.flag"),
      homea: on("homea", "test ! -e ~/.seen && touch ~/.seen && test ! -e \"$TMPDIR/seen\" && touch \"$TMPDIR/seen\""),
      homeb: on(
        "homeb",
        "test ! -e ~/.seen && touch ~/.seen && test ! -e \"$TMPDIR/seen\" && touch \"$TMPDIR/seen\" # b"
      )
    }))
    const all = ["mutate", "pristine", "homea", "homeb"]
    expect(await run(all, untraced)).toEqual({ mutate: "ran", pristine: "ran", homea: "ran", homeb: "ran" })
    expect(made()).toEqual(all.toSorted())
    // Nothing reached the workspace, and a second build starts as the first did.
    expect(await Fs.readFile(Path.join(root, "shared.txt"), "utf8")).toBe("ok\n")
    expect(NodeFs.existsSync(Path.join(root, "leftover.flag"))).toBe(false)
    expect(git(root, "status", "--porcelain")).toBe("")
    // On a host that records no reads a target is keyed by the files it declares.
    expect(await run(all, untraced, 4)).toEqual({ mutate: "hit", pristine: "hit", homea: "hit", homeb: "hit" })
    await write("shared.txt", "ok, changed\n")
    expect(await run(all, untraced, 4)).toEqual({ mutate: "ran", pristine: "ran", homea: "ran", homeb: "ran" })
  })

  posixIt("are gone when the build ends, with what was left where they are kept", async () => {
    const { environment, kept, run } = await fixture(() => ({
      locked: on("locked", "mkdir -p ~/go/pkg/mod/x && : > ~/go/pkg/mod/x/file && chmod -R a-w ~/go")
    }))
    expect(await run(["locked"], untraced)).toEqual({ locked: "ran" })
    expect(NodeFs.existsSync(Machine.holding(await Fs.realpath(Path.dirname(kept) + "/ws"), environment))).toBe(false)
  })
})

describe("the targets of one machine", () => {
  posixIt("share its tree, its home and its temporary directory, one at a time and in order", async () => {
    const { run } = await fixture(() => {
      const first = on("job", "echo built > out.txt && echo tool > ~/.tool && echo t > \"$TMPDIR/t\" && sleep 0.3")
      return {
        first,
        second: on("job", "grep -q built out.txt && grep -q tool ~/.tool && grep -q t \"$TMPDIR/t\"", [first]),
        // Two targets of one machine that do not wait for each other still never run at once.
        busy: on("busy", "test ! -e busy.lock && : > busy.lock && sleep 0.4 && rm busy.lock"),
        also: on("busy", "test ! -e busy.lock && : > busy.lock && sleep 0.4 && rm busy.lock # also")
      }
    })
    expect(await run(["second", "busy", "also"], untraced, 4)).toEqual({
      first: "ran",
      second: "ran",
      busy: "ran",
      also: "ran"
    })
  })

  posixIt("run in a fresh checkout: a repository of its own, and nothing the workspace ignores", async () => {
    const { root, run, write } = await fixture(() => ({
      status: on("status", "test -z \"$(git status --porcelain)\" && test \"$(git log --format=%s)\" = one"),
      installed: on("installed", "test ! -e node_modules && test \"$(basename \"$PWD\")\" = ws"),
      commits: on("commits", "git -c user.name=m -c user.email=m@example.invalid commit -qam two --allow-empty"),
      // git looks for no repository above the copy, and a path of the workspace is the copy's.
      above: on("above", "cd .. && ! git rev-parse --git-dir 2>/dev/null"),
      edited: on("edited", "grep -q 'not committed' a.txt")
    }))
    await write("node_modules/dep/index.js", "module.exports = 1\n")
    await write("a.txt", "a, edited and not committed\n")
    expect(await run(["status", "installed", "commits", "above", "edited"], untraced)).toEqual({
      // The working tree's own change is in the copy, so the copy is not clean either.
      status: "failed",
      installed: "ran",
      commits: "ran",
      above: "ran",
      edited: "ran"
    })
    expect(git(root, "log", "--format=%s")).toBe("one")
  })

  posixIt("start their home from the directory the variable names", async () => {
    const { base, environment, run, write } = await fixture(() => ({
      home: on("home", "grep -q hooks ~/.gitconfig && test ! -e ~/.other")
    }))
    await write(Path.join(base, "template", ".gitconfig"), "[core]\n\thooksPath = ~/hooks\n")
    environment[Machine.homeVariable] = Path.join(base, "template")
    expect(await run(["home"], untraced)).toEqual({ home: "ran" })
  })

  posixIt("keep what a build target makes for the targets there that wait for it", async () => {
    const { root, run } = await fixture(() => {
      const setup = S.Shell.Build({
        shell: "mkdir -p .flows/ci dist && : > .flows/ci/setup && echo built > dist/out",
        outFiles: ["//.flows/ci/setup"],
        cache: false,
        machine: "job",
        sandbox: "none",
        data: []
      })
      const broken = S.Shell.Build({
        shell: "exit 3",
        outFiles: ["//.flows/ci/broken"],
        cache: false,
        machine: "other",
        sandbox: "none",
        data: []
      })
      return { setup, uses: on("job", "grep -q built dist/out", [setup]), broken }
    })
    expect(await run(["uses", "broken"], untraced)).toEqual({ setup: "ran", uses: "ran", broken: "failed" })
    expect(NodeFs.existsSync(Path.join(root, "dist"))).toBe(false)
    // It always runs: what it built is on no machine of the next build.
    expect(await run(["uses"], untraced)).toEqual({ setup: "ran", uses: "hit" })
  })
})

describe("an observed target on a machine", () => {
  tracedIt("is answered from the cache with no machine made, while what it read is unchanged", async () => {
    const { logs, made, run, write } = await fixture(() => ({
      reads: on("reads", "grep -q a a.txt && test ! -e ~/.seen && touch ~/.seen && : > \"$TMPDIR/scratch\"")
    }))
    expect(await run(["reads"])).toEqual({ reads: "ran" })
    expect(made()).toEqual(["reads"])
    logs.length = 0
    // What the workspace ignores is on no machine, so it changes nothing; neither does a file the run never read.
    await write("node_modules/dep/index.js", "module.exports = 1\n")
    await write("docs/readme.md", "changed\n")
    expect(await run(["reads"])).toEqual({ reads: "hit" })
    expect(made()).toEqual([])
    await write("a.txt", "a, changed\n")
    expect(await run(["reads"])).toEqual({ reads: "ran" })
    expect(logs).toContain("//:reads  runs again: a.txt changed")
    expect(made()).toEqual(["reads"])
  })

  tracedIt("finds what an answered step of its machine left, put back in the machine's tree", async () => {
    const { logs, made, root, run, write } = await fixture(() => {
      const install = on("job", "mkdir -p deps && cp a.txt deps/a && echo fetched > \"$TMPDIR/fetched\"")
      return {
        install,
        test: on("job", "grep -q a deps/a && grep -q b b.txt && grep -q fetched \"$TMPDIR/fetched\"", [install]),
        // Another machine waits for the install and reads nothing of it.
        after: on("after", "test ! -e deps && grep -q nothing docs/readme.md", [install])
      }
    })
    const all = ["test", "after"]
    expect(await run(all)).toEqual({ install: "ran", test: "ran", after: "ran" })
    logs.length = 0
    // Only the test reads the changed file: the install is answered, and what it left is put back for the test.
    await write("b.txt", "b, changed\n")
    expect(await run(all)).toEqual({ install: "hit", test: "ran", after: "hit" })
    expect(logs).toContain("//:install  what it left is put back for //:test")
    expect(made()).toEqual(["job"])
    expect(NodeFs.existsSync(Path.join(root, "deps"))).toBe(false)
    // The install reads the changed file: both run, on one machine.
    logs.length = 0
    await write("a.txt", "a, changed\n")
    expect(await run(all)).toEqual({ install: "ran", test: "ran", after: "hit" })
    expect(await run(all)).toEqual({ install: "hit", test: "hit", after: "hit" })
    // Only the other machine's target reads the changed file: nothing of the install is put back for it.
    logs.length = 0
    await write("docs/readme.md", "nothing reads this, but one target\n")
    expect(await run(all)).toEqual({ install: "hit", test: "hit", after: "ran" })
    expect(made()).toEqual(["after"])
    expect(logs.filter((line) => line.includes("put back"))).toEqual([])
  })

  tracedIt("runs again when its home is not as its run left it and a target after it runs", async () => {
    const { run, write } = await fixture(() => {
      const tool = on("job", "mkdir -p ~/bin && printf '#!/bin/sh\\nexit 0\\n' > ~/bin/tool && chmod +x ~/bin/tool")
      return { tool, uses: on("job", "~/bin/tool && grep -q b b.txt", [tool]) }
    })
    expect(await run(["uses"])).toEqual({ tool: "ran", uses: "ran" })
    expect(await run(["uses"])).toEqual({ tool: "hit", uses: "hit" })
    // A machine starts with an empty home, so the tool is installed again for the step that needs it.
    await write("b.txt", "b, changed\n")
    expect(await run(["uses"])).toEqual({ tool: "ran", uses: "ran" })
  })
})
