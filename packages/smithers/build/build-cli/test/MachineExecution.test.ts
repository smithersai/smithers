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
const tracing = ObservedReads.observer(ExecSandbox.host())
const tracedIt = it.skipIf("reason" in tracing)
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

/** The bubblewrap of this host that gives a command a `/tmp` of its own, when it has one. */
const mount = await Machine.mounting(process.env, "/var/tmp")
const mountedIt = it.skipIf(!("bwrap" in mount))
const tracedMountedIt = it.skipIf("reason" in tracing || !("bwrap" in mount))
/** A host that records reads and has `make`, a build tool that compares the times of files. */
const tracedMakeIt = it.skipIf("reason" in tracing || !NodeFs.existsSync("/usr/bin/make"))
/** The directory that bubblewrap is in, for a build that is to find it on `PATH`. */
const mounts: ReadonlyArray<string> = "bwrap" in mount ? [Path.dirname(mount.bwrap)] : []

const fixture = async (
  targets: (base: string) => Targets,
  host?: { readonly home: string; readonly kept: string | undefined },
  tools: ReadonlyArray<string> = []
) => {
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
  const kept = host?.kept ?? Path.join(base, "machines")
  const environment: Record<string, string> = {
    PATH: [...tools, ...("tracer" in tracing ? [Path.dirname(tracing.tracer)] : []), "/usr/bin", "/bin"].join(
      Path.delimiter
    ),
    HOME: host?.home ?? Path.join(base, "home"),
    // A host that names no directory for machines keeps them where a person's build keeps them.
    ...(host !== undefined && host.kept === undefined ? {} : { [Machine.holdingVariable]: kept })
  }
  await Fs.mkdir(environment["HOME"]!, { recursive: true })
  const logs: Array<string> = []
  /** Why each target that failed did, by name. */
  const failures = new Map<string, string>()
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
      for (const result of summary.results) {
        if (result.error !== undefined) failures.set(result.label.split(":")[1]!, result.error)
      }
      return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
    } finally {
      process.env["PATH"] = previous
    }
  }
  /** The names of the machines a run made, from what the run said. */
  const made = (): ReadonlyArray<string> =>
    logs.flatMap((line) => /^smthrs: machine (.+) has a fresh checkout/.exec(line)?.[1] ?? []).sort()
  return { base, root, write, run, logs, made, kept, environment, failures }
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

  posixIt("are each told a configuration, data and state directory in their own home", async () => {
    // A tool keeps its settings where these name; a host's own would be shared by every machine.
    const writes = [
      "for d in \"$XDG_CONFIG_HOME\" \"$XDG_DATA_HOME\" \"$XDG_STATE_HOME\"; do",
      "case \"$d\" in \"$HOME\"/*) ;; *) exit 1 ;; esac",
      "test ! -e \"$d/seen\" && mkdir -p \"$d\" && touch \"$d/seen\" || exit 1",
      "done"
    ].join("\n")
    const { run } = await fixture(() => ({ toola: on("toola", writes), toolb: on("toolb", `${writes}\n# b`) }))
    expect(await run(["toola", "toolb"], untraced)).toEqual({ toola: "ran", toolb: "ran" })
  })

  posixIt("are gone when the build ends, with what was left where they are kept", async () => {
    const { environment, kept, run } = await fixture(() => ({
      locked: on("locked", "mkdir -p ~/go/pkg/mod/x && : > ~/go/pkg/mod/x/file && chmod -R a-w ~/go")
    }))
    expect(await run(["locked"], untraced)).toEqual({ locked: "ran" })
    expect(NodeFs.existsSync(Machine.holding(await Fs.realpath(Path.dirname(kept) + "/ws"), environment))).toBe(false)
  })
})

describe("where a machine's checkout is", () => {
  posixIt("is under no directory a tool skips the configuration of a project under, by default", async () => {
    // Biome 2.6.6 skips every nested biome.json of a project under a directory named .cache, so a lint the CI passes
    // failed on a machine kept under ~/.cache/smthrs/machines. This tool refuses such a path as Biome misreads it.
    const home = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-machine-home-")))
    temporary.push(home)
    const refuses = [
      "case \"$PWD\" in */.cache/*|*/.output/*|*/node_modules/*|*/.git/*) echo \"misread under $PWD\" >&2; exit 1;; esac",
      `case "$PWD" in ${home}/.local/state/smthrs/machines/*) ;; *) echo "not kept in the state directory" >&2; exit 1;; esac`
    ].join("\n")
    const { failures, root, run } = await fixture(() => ({ lint: on("lint", refuses) }), { home, kept: undefined })
    // What a build kept in the old place is removed.
    const former = Machine.formerHolding(root, { HOME: home })!
    await Fs.mkdir(Path.join(`${former}.gone-1-00000000`, "job"), { recursive: true })
    await Fs.mkdir(Path.join(former, "job"), { recursive: true })
    expect(await run(["lint"], untraced)).toEqual({ lint: "ran" })
    expect(failures).toEqual(new Map())
    expect(await Fs.readdir(Path.dirname(former))).toEqual([])
  })
})

describe("the /tmp of a machine", () => {
  mountedIt("is the machine's own: two machines each find it empty, and the targets of one share it", async () => {
    // Two jobs of a workflow never share a `/tmp`: each of these passes on a runner of its own.
    const seen = `/tmp/smithers-machine-seen-${process.pid}`
    const { logs, run } = await fixture(
      () => {
        const first = on("a", `test ! -e ${seen} && touch ${seen} && echo t > /tmp/first`)
        return {
          first,
          // What a target writes to `/tmp` is in the machine's temporary directory, by either name.
          second: on("a", `grep -q t /tmp/first && grep -q t "$TMPDIR/first" && test -e ${seen}`, [first]),
          other: on("b", `test ! -e ${seen} && touch ${seen} && test ! -e /tmp/first # b`)
        }
      },
      undefined,
      mounts
    )
    expect(await run(["second", "other"], untraced)).toEqual({ first: "ran", second: "ran", other: "ran" })
    // Nothing of it reached this host's own `/tmp`.
    expect(NodeFs.existsSync(seen)).toBe(false)
    expect(logs.some((line) => line.includes("share this host's /tmp"))).toBe(false)
  })

  tracedMountedIt(
    "is read through the machine: a target is answered while what it read there is as it was",
    async () => {
      const note = `/tmp/smithers-machine-note-${process.pid}`
      const { made, run, write } = await fixture(
        () => {
          const writes = on("job", `echo one > ${note}`)
          return { writes, reads: on("job", `grep -q one ${note} && grep -q a a.txt`, [writes]) }
        },
        undefined,
        mounts
      )
      expect(await run(["reads"])).toEqual({ writes: "ran", reads: "ran" })
      expect(made()).toEqual(["job"])
      // Both are answered, and no machine is made: the record names the note from the machine, not from this host.
      expect(await run(["reads"])).toEqual({ writes: "hit", reads: "hit" })
      expect(made()).toEqual(["job"])
      // The reader has to run: the note is kept with what the writer left, and put back in the temporary
      // directory of the reader's machine. The writer does not run.
      await write("a.txt", "a, changed\n")
      expect(await run(["reads"])).toEqual({ writes: "hit", reads: "ran" })
      expect(made()).toEqual(["job", "job"])
      expect(NodeFs.existsSync(note)).toBe(false)
    }
  )

  tracedMountedIt(
    "is the machine's own when the build keeps its machines under /tmp, which stay in sight",
    async () => {
      // A program that works in a temporary directory keeps its machines there, as a replay does: a target's own
      // checkout and home then lie under the host's `/tmp`.
      const under = await Fs.realpath(await Fs.mkdtemp(Path.join("/tmp", "smithers-machine-kept-")))
      temporary.push(under)
      const seen = `/tmp/smithers-machine-kept-seen-${process.pid}`
      const { made, run } = await fixture(
        () => {
          const first = on("a", `test ! -e ${seen} && touch ${seen} && echo built > out.txt && : > ~/.mark`)
          return {
            first,
            second: on("a", `test -e ${seen} && grep -q built out.txt && test -e ~/.mark`, [first]),
            other: on("b", `test ! -e ${seen} && touch ${seen} && test ! -e ~/.mark # b`)
          }
        },
        { home: Path.join(under, "home"), kept: Path.join(under, "machines") },
        mounts
      )
      expect(await run(["second", "other"])).toEqual({ first: "ran", second: "ran", other: "ran" })
      expect(NodeFs.existsSync(seen)).toBe(false)
      // What the targets read of their machine was read where it is: all three are answered, and no machine is made.
      expect(await run(["second", "other"])).toEqual({ first: "hit", second: "hit", other: "hit" })
      expect(made()).toEqual(["a", "b"])
    }
  )

  posixIt("is this host's where the host gives no other, and the build says so once", async () => {
    // A bubblewrap the host refuses, first on PATH, as in a container that lets no process make a mount.
    const refused = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-machine-bwrap-")))
    temporary.push(refused)
    await Fs.writeFile(Path.join(refused, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    // The targets still have a `TMPDIR` of their machine's own.
    const { logs, run } = await fixture(
      () => ({
        one: on("a", "test -d \"$TMPDIR\" && test \"$TMPDIR\" != /tmp"),
        two: on("b", "test -d \"$TMPDIR\" # b")
      }),
      undefined,
      [refused]
    )
    // Observed where this host has a tracer: what the targets read is recorded with `/tmp` as the host has it.
    expect(await run(["one", "two"])).toEqual({ one: "ran", two: "ran" })
    expect(logs.filter((line) => line.includes("share this host's /tmp"))).toEqual([
      `smthrs: the targets of a machine share this host's /tmp: ${refused}/bwrap cannot give a process a mount of ` +
      "its own on this host; TMPDIR is still each machine's own"
    ])
  })
})

describe("a build told that two machines never share a /tmp", () => {
  posixIt("runs the targets of one machine on a host that gives no other /tmp, and fails the rest", async () => {
    const refused = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-machine-bwrap-")))
    temporary.push(refused)
    await Fs.writeFile(Path.join(refused, "bwrap"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    const { environment, failures, logs, run } = await fixture(
      () => {
        const first = on("a", "echo built > out.txt")
        const second = on("a", "grep -q built out.txt", [first])
        // It waits for the first machine's targets, so that machine is the one that has the host's `/tmp`.
        return { first, second, other: on("b", "true # b", [second]), alone: on("c", "true # c") }
      },
      undefined,
      [refused]
    )
    environment[Machine.ownTmpVariable] = "required"
    const reason = `${refused}/bwrap cannot give a process a mount of its own on this host`
    // The targets of the first machine run. The other machine would find what the first left in `/tmp`.
    expect(await run(["other"], untraced)).toEqual({ first: "ran", second: "ran", other: "failed" })
    expect(failures.get("other")).toContain(Machine.sharedRefusal("b", "a", reason))
    expect(logs).toContain(
      `smthrs: this host gives a machine no /tmp of its own: ${reason}; the targets of one machine run here`
    )
    // A build that runs one machine alone passes there.
    expect(await run(["alone"], untraced)).toEqual({ alone: "ran" })
  })

  mountedIt("changes nothing on a host that gives each machine a /tmp of its own", async () => {
    const { environment, run } = await fixture(
      () => ({ one: on("a", "test ! -e /tmp/mark && touch /tmp/mark"), two: on("b", "test ! -e /tmp/mark # b") }),
      undefined,
      mounts
    )
    environment[Machine.ownTmpVariable] = "required"
    expect(await run(["one", "two"], untraced)).toEqual({ one: "ran", two: "ran" })
  })
})

describe("what a target on a machine keeps in the cache directory", () => {
  posixIt("is in the workspace's cache directory, and is there for the next build's machine", async () => {
    // What a cache step does: it saves under the directory the declaration names, and a later run restores it.
    const store = "{smthrs:cache-directory}/store"
    const { root, run } = await fixture(() => ({
      saves: on("job", `mkdir -p "${store}" && test ! -e "${store}/saved" && echo saved > "${store}/saved"`),
      restores: on("later", `grep -q saved "${store}/saved"`)
    }))
    expect(await run(["saves"], untraced)).toEqual({ saves: "ran" })
    // The machine is gone, and what it kept is not.
    expect(await Fs.readFile(Path.join(root, ".flows", "store", "saved"), "utf8")).toBe("saved\n")
    expect(await run(["restores"], untraced)).toEqual({ restores: "ran" })
  })
})

describe("the targets of one machine", () => {
  posixIt("share its tree, its home and its temporary directory, one at a time and in order", async () => {
    const { run } = await fixture(() => {
      const first = on("job", "echo built > out.txt && echo tool > ~/.tool && echo t > \"$TMPDIR/t\" && sleep 0.3")
      return {
        first,
        second: on("job", "grep -q built out.txt && grep -q tool ~/.tool && grep -q t \"$TMPDIR/t\"", [first]),
        // A target that sets TMPDIR itself still finds its machine's temporary directory, by the machine's own name.
        named: S.Shell.Test({
          shell: "test \"$TMPDIR\" = /nowhere && grep -q t \"$SMTHRS_MACHINE_TMP/t\"",
          env: { TMPDIR: "/nowhere" },
          machine: "job",
          sandbox: "none",
          data: [S.glob("**"), first] as never
        }),
        // Two targets of one machine that do not wait for each other still never run at once.
        busy: on("busy", "test ! -e busy.lock && : > busy.lock && sleep 0.4 && rm busy.lock"),
        also: on("busy", "test ! -e busy.lock && : > busy.lock && sleep 0.4 && rm busy.lock # also")
      }
    })
    expect(await run(["second", "named", "busy", "also"], untraced, 4)).toEqual({
      first: "ran",
      second: "ran",
      named: "ran",
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

  // What `zig build` does in a fresh checkout: it makes `.zig-cache/h` and opens a manifest there to read and
  // write, making it if it is not there. The manifest was recorded as a file the run read, so in the next fresh
  // checkout the step ran again: `.zig-cache/h/<digest> is gone`.
  tracedIt(
    "is answered in a fresh checkout after it opened a file, to read or to make, in a directory it made",
    async () => {
      const { logs, run, write } = await fixture(() => ({
        build: on(
          "job",
          "mkdir -p .cache/h && : 1<> .cache/h/manifest && echo built >> .cache/h/manifest && grep -q a a.txt"
        )
      }))
      expect(await run(["build"])).toEqual({ build: "ran" })
      logs.length = 0
      expect(await run(["build"])).toEqual({ build: "hit" })
      expect(logs.filter((line) => line.includes("runs again"))).toEqual([])
      await write("a.txt", "a, changed\n")
      expect(await run(["build"])).toEqual({ build: "ran" })
      expect(logs).toContain("//:build  runs again: a.txt changed")
    }
  )

  tracedIt("finds what an answered step of its machine left, put back in the machine's tree", async () => {
    const { logs, made, root, run, write } = await fixture(() => {
      const install = on("job", "mkdir -p deps && cp a.txt deps/a")
      return {
        install,
        test: on("job", "grep -q a deps/a && grep -q b b.txt", [install]),
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

  // The machines of this fixture are kept beside the temporary directory, as a runner keeps them under its home.
  // The third ship review's blocker 2: there every step of a generated CI ran again, because what a step left in
  // its machine's temporary directory was never kept.
  tracedIt(
    "finds what an answered step left in its machine's home, put back on a machine that starts empty",
    async () => {
      const { logs, root, run, write } = await fixture(() => {
        const tool = on("job", "mkdir -p ~/bin && printf '#!/bin/sh\\nexit 0\\n' > ~/bin/tool && chmod +x ~/bin/tool")
        return { tool, uses: on("job", "~/bin/tool && grep -q b b.txt", [tool]) }
      })
      expect(await run(["uses"])).toEqual({ tool: "ran", uses: "ran" })
      expect(await run(["uses"])).toEqual({ tool: "hit", uses: "hit" })
      // A machine starts with an empty home. The tool is kept with what its step left, and put back, as a program
      // that can run, for the step that needs it.
      await write("b.txt", "b, changed\n")
      expect(await run(["uses"])).toEqual({ tool: "hit", uses: "ran" })
      expect(logs).toContain("//:tool  what it left is put back for //:uses")
      // The files kept from the home are lost: the step runs in their place.
      const kept = Path.join(root, ".flows/kept")
      const lose = async (suffix: string): Promise<void> => {
        for (const name of await Fs.readdir(kept)) if (name.endsWith(suffix)) await Fs.rm(Path.join(kept, name))
      }
      await lose(".machine.tar")
      logs.length = 0
      await write("b.txt", "b, changed again\n")
      expect((await run(["uses"]))["uses"]).toBe("ran")
      expect(logs).toContain("//:tool  what it left could not be put back; it runs for //:uses")
      // Every kept file is lost: the step is not answered, and its row says why.
      await lose("")
      logs.length = 0
      await write("b.txt", "b, changed once more\n")
      expect(await run(["uses"])).toEqual({ tool: "ran", uses: "ran" })
      expect(logs).toContain(
        "//:tool  runs again: a step after it runs, and what this one left cannot be put back: " +
          "the files kept for it are not in the cache directory"
      )
    }
  )

  tracedIt(
    "finds what an answered step left in its machine's temporary directory, put back on a machine that starts empty",
    async () => {
      const { logs, run, write } = await fixture(() => {
        const fetch = on("job", "echo fetched > \"$TMPDIR/fetched\" && : > \"$TMPDIR/old\" && rm \"$TMPDIR/old\"")
        return { fetch, uses: on("job", "grep -q fetched \"$TMPDIR/fetched\" && grep -q b b.txt", [fetch]) }
      })
      expect(await run(["uses"])).toEqual({ fetch: "ran", uses: "ran" })
      expect(await run(["uses"])).toEqual({ fetch: "hit", uses: "hit" })
      await write("b.txt", "b, changed\n")
      expect(await run(["uses"])).toEqual({ fetch: "hit", uses: "ran" })
      expect(logs).toContain("//:fetch  what it left is put back for //:uses")
    }
  )

  tracedIt(
    "puts back what a step left in its home and temporary directory where machines are kept elsewhere",
    async () => {
      // What a runner does between two runs, on another host: another checkout, another home, machines kept under
      // that home, and the cache directory carried over.
      const targets = () => {
        const install = on(
          "job",
          "mkdir deps ~/bin \"$TMPDIR/state\" && cp a.txt deps/a && echo tool > ~/bin/tool && " +
            "echo done > \"$TMPDIR/state/outcome\""
        )
        return {
          install,
          test: on(
            "job",
            "grep -q a deps/a && grep -q tool ~/bin/tool && grep -q done \"$TMPDIR/state/outcome\" && grep -q b b.txt",
            [install]
          )
        }
      }
      const first = await fixture(targets)
      expect(await first.run(["test"])).toEqual({ install: "ran", test: "ran" })
      const second = await fixture(targets)
      expect(second.kept).not.toBe(first.kept)
      await Fs.cp(Path.join(first.root, ".flows"), Path.join(second.root, ".flows"), { recursive: true })
      expect(await second.run(["test"])).toEqual({ install: "hit", test: "hit" })
      await second.write("b.txt", "b, changed\n")
      expect(await second.run(["test"])).toEqual({ install: "hit", test: "ran" })
      expect(second.logs).toContain("//:install  what it left is put back for //:test")
    }
  )

  // The third ship review's blocker 3: what a reused step built was put back with the times of the run it was
  // kept from, older than the sources of a checkout made now, so `make -q` said it was out of date.
  tracedMakeIt(
    "puts back what a step built as if the step had just run: a check that it is up to date passes",
    async () => {
      const { failures, logs, run, write } = await fixture(() => {
        const build = on("job", "make out")
        return { build, check: on("job", "cat b.txt > /dev/null && make -q out", [build]) }
      })
      await write("Makefile", "out: in\n\tcp in out\n")
      await write("in", "1\n")
      expect(await run(["check"])).toEqual({ build: "ran", check: "ran" })
      // Only the check reads the changed file. The build is answered, and `out` is put back newer than `in`.
      await write("b.txt", "b, changed\n")
      expect(await run(["check"]), failures.get("check")).toEqual({ build: "hit", check: "ran" })
      expect(logs).toContain("//:build  what it left is put back for //:check")
    }
  )

  tracedMakeIt("puts back a build of two stages in their order, each newer than what it was built from", async () => {
    const { failures, run, write } = await fixture(() => {
      const first = on("job", "make a.o")
      const second = on("job", "make b", [first])
      // The object is newer than its source, and the program newer than the object, as after a build.
      const newer = "make -q b && test a.o -nt a.c && test b -nt a.o"
      return { first, second, check: on("job", `cat b.txt > /dev/null && ${newer}`, [second]) }
    })
    await write("Makefile", "a.o: a.c\n\tcp a.c a.o\nb: a.o\n\tcp a.o b\n")
    await write("a.c", "1\n")
    expect(await run(["check"])).toEqual({ first: "ran", second: "ran", check: "ran" })
    await write("b.txt", "b, changed\n")
    expect(await run(["check"]), failures.get("check")).toEqual({ first: "hit", second: "hit", check: "ran" })
  })

  tracedMakeIt("keeps the order of a step's files when the step took longer than putting them back", async () => {
    const { failures, run, write } = await fixture(() => {
      // One step builds both, a while apart, and touches a file between them that is no part of the build.
      const build = on("job", "make a.o && sleep 0.4 && : > between && sleep 0.4 && make b")
      const newer = "make -q b && test a.o -nt a.c && test between -nt a.o && test b -nt between"
      return { build, check: on("job", `cat b.txt > /dev/null && ${newer}`, [build]) }
    })
    await write("Makefile", "a.o: a.c\n\tcp a.c a.o\nb: a.o\n\tcp a.o b\n")
    await write("a.c", "1\n")
    expect(await run(["check"])).toEqual({ build: "ran", check: "ran" })
    await write("b.txt", "b, changed\n")
    expect(await run(["check"]), failures.get("check")).toEqual({ build: "hit", check: "ran" })
  })

  tracedIt("leaves out of its record what the declaration names under the machine's temporary directory", async () => {
    // What Node does: a step fills a cache of compiled code under TMPDIR, with other bytes on every run, and the
    // step after it reads that cache and nothing of it decides its result.
    const { logs, run } = await fixture(() => {
      const setup = S.Shell.Build({
        shell:
          "mkdir -p .flows/ci \"$TMPDIR/compiled\" && : > .flows/ci/setup && date +%s%N > \"$TMPDIR/compiled/code\"",
        outFiles: ["//.flows/ci/setup"],
        cache: false,
        machine: "job",
        sandbox: "none",
        data: []
      })
      const reads = (ignore: ReadonlyArray<string>) =>
        S.Shell.Test({
          shell: `cat "$TMPDIR/compiled/code" > /dev/null && grep -q a a.txt # ${ignore.length}`,
          machine: "job",
          sandbox: "none",
          observe: { ignore },
          data: [S.glob("**"), setup]
        })
      return { setup, left: reads(["$TMPDIR/compiled"]), kept: reads([]) }
    })
    expect(await run(["left", "kept"])).toEqual({ setup: "ran", left: "ran", kept: "ran" })
    logs.length = 0
    expect(await run(["left", "kept"])).toEqual({ setup: "ran", left: "hit", kept: "ran" })
    expect(logs).toContain("//:kept  runs again: /smthrs-machine/tmp/compiled/code changed")
  })

  tracedIt("is answered in another checkout that restored the cache, and its files are put back there", async () => {
    // What a CI machine does between two runs: a fresh checkout somewhere, and the cache directory carried over.
    const targets = () => {
      const install = on("job", "mkdir -p deps && cp a.txt deps/a && test ! -e ~/.toolrc && : > ~/.seen && rm ~/.seen")
      // `mkdir -p` looks at every directory above the one it makes, the one the machines are kept in among them.
      const scratch = "mkdir -p ~/.work/x \"$TMPDIR/work/x\" && rm -r ~/.work \"$TMPDIR/work\""
      return {
        install,
        test: on("job", `${scratch} && grep -q a deps/a && grep -q b b.txt && test ! -e ~/.toolrc`, [install])
      }
    }
    const first = await fixture(targets)
    const shared = { home: first.environment["HOME"]!, kept: first.kept }
    expect(await first.run(["test"])).toEqual({ install: "ran", test: "ran" })
    const second = await fixture(targets, shared)
    expect(second.root).not.toBe(first.root)
    await Fs.cp(Path.join(first.root, ".flows"), Path.join(second.root, ".flows"), { recursive: true })
    expect(await second.run(["test"])).toEqual({ install: "hit", test: "hit" })
    expect(second.made()).toEqual([])
    // Only the test reads the changed file: what the install left in the first checkout's machine is put back here.
    await second.write("b.txt", "b, changed\n")
    expect(await second.run(["test"])).toEqual({ install: "hit", test: "ran" })
    expect(second.logs).toContain("//:install  what it left is put back for //:test")
  })
})
