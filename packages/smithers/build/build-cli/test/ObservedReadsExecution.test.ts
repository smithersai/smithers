/**
 * A shell test that asks to be observed, end to end.
 *
 * Every case plans and executes real targets through the PACKAGE.ts surface.
 * The check is a real shell command: it reads a file, lists a directory and
 * reads what it finds there, and looks for a file that may be missing. The
 * tracer is the host's own `strace`, so the cases that need it run on Linux
 * hosts that have it. A host without a tracer, and a tracer that fails, are
 * supplied through the execution services.
 */
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
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
 * The check: fails when `input.txt` holds `fail`, reads every file in
 * `tests`, and reads `optional.cfg` when there is one.
 */
const check = [
  "case \"$(/bin/cat input.txt)\" in *fail*) exit 1 ;; esac",
  "for file in tests/*; do /bin/cat \"$file\" > /dev/null || exit 1; done",
  "if [ -f optional.cfg ]; then /bin/cat optional.cfg > /dev/null; fi"
].join("\n")

interface FixtureOptions {
  readonly check?: string
  readonly observe?: boolean | { readonly ignore: ReadonlyArray<string> }
}

const fixture = async (settings: FixtureOptions = {}) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-observed-run-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  const write = async (name: string, text: string, mode = 0o644): Promise<void> => {
    const file = Path.isAbsolute(name) ? name : Path.join(root, name)
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, text, { mode })
    await Fs.chmod(file, mode)
  }
  await write("input.txt", "pass\n")
  await write("tests/a.test", "a\n")
  await write("docs/readme.md", "nothing reads this\n")
  await write("volatile.txt", "1\n")
  const declared = { sandbox: "none" as const, data: [S.glob("**")] }
  // A step that always runs before the test, as an install does.
  const setup = S.Shell.Build({
    shell: "mkdir -p .flows/ci && : > .flows/ci/setup",
    outFiles: ["//.flows/ci/setup"],
    cache: false,
    sandbox: "none",
    data: []
  })
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("observed", {
      repository: "git+https://example.invalid/observed.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{
      file: "PACKAGE.ts",
      packagePath: "",
      value: S.Package({
        targets: {
          check: S.Shell.Test({ ...declared, shell: settings.check ?? check, observe: settings.observe ?? true }),
          setup,
          second: S.Shell.Test({
            sandbox: "none",
            data: [S.glob("**"), setup],
            shell: "/bin/cat input.txt > /dev/null",
            observe: true
          }),
          plain: S.Shell.Test({ ...declared, shell: "/bin/cat input.txt > /dev/null", observe: false })
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
  const node = async (name: string) => (await plan(options([name]))).nodes.get(label(name))!
  /** Plans and executes the named targets; answers each one's status by name. */
  const run = async (
    names: ReadonlyArray<string> = ["check"],
    services: ExecutionServices = executionServicesLive
  ): Promise<Record<string, string>> => {
    const summary = await withPath(environment.PATH, async () =>
      Effect.runPromise(
        executeEffect(await plan(options(names)), options(names)).pipe(
          Effect.provideService(ExecutionServices, services)
        )
      ))
    return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
  }
  /** A program that stands where the tracer does and runs `body` with the command in `"$@"` and the trace file in `$out`. */
  const tracer = async (body: string): Promise<ExecutionServices> => {
    const file = Path.join(base, "tools", "tracer")
    await write(
      file,
      "#!/bin/sh\nwhile [ \"$1\" != \"-o\" ]; do shift; done\nout=\"$2\"\n" +
        `while [ "$1" != "--" ]; do shift; done\nshift\n${body}\n`,
      0o755
    )
    return { ...executionServicesLive, observer: () => ({ tracer: file }) }
  }
  const attempts = async (): Promise<
    ReadonlyArray<{ readonly label: string; readonly output: ReadonlyArray<string> }>
  > => {
    const directory = Path.join(root, ".flows", "evidence")
    const names = await Fs.readdir(directory).catch(() => [])
    return Promise.all(names.map(async (name) => JSON.parse(await Fs.readFile(Path.join(directory, name), "utf8"))))
  }
  /** What a run's traces left behind: nothing, once the run is over. */
  const traceFiles = async (): Promise<ReadonlyArray<string>> =>
    (await Fs.readdir(Path.join(root, ".flows", "tmp")).catch(() => [])).filter((name) => name.startsWith("reads-"))
  return { root, write, run, node, logs, tracer, attempts, traceFiles }
}

describe("a plan", () => {
  posixIt("keys an observed test by its declaration, apart from the files it declares", async () => {
    const { node, write } = await fixture()
    const original = await node("check")
    expect(original.refusal).toBeUndefined()
    expect(original.cacheable).toBe(true)
    expect(original.observed?.ignore).toEqual([])
    expect((await node("plain")).observed).toBeUndefined()
    await write("docs/readme.md", "changed\n")
    await write("input.txt", "pass, changed\n")
    const edited = await node("check")
    expect(edited.keyPreview).not.toBe(original.keyPreview)
    expect(edited.observed?.key).toBe(original.observed?.key)
    // Another command is another declaration.
    expect((await node("second")).observed?.key).not.toBe(original.observed?.key)
    // So is another search path: it decides which programs and files a run looks for.
    const elsewhere = await withPath(
      `${process.env["PATH"]}${Path.delimiter}/nonexistent-smithers-observed-bin`,
      () => node("check")
    )
    expect(elsewhere.observed?.key).not.toBe(original.observed?.key)
    // A search path that names a directory of the workspace names the same one in any checkout.
    const one = await fixture()
    const other = await fixture()
    const local = (root: string): string =>
      `${Path.join(root, "node_modules", ".bin")}${Path.delimiter}${process.env["PATH"]}`
    const inOne = await withPath(local(one.root), () => one.node("check"))
    const inOther = await withPath(local(other.root), () => other.node("check"))
    expect(inOne.observed?.key).not.toBe(original.observed?.key)
    expect(inOther.observed?.key).toBe(inOne.observed?.key)
    const ignoring = await fixture({ observe: { ignore: ["volatile.txt"] } })
    const declared = await ignoring.node("check")
    expect(declared.observed?.ignore).toEqual(["volatile.txt"])
    expect(declared.observed?.key).not.toBe(original.observed?.key)
  })
})

describe("an observed test", () => {
  tracedIt("is answered from the cache while everything it read is unchanged", async () => {
    const { logs, run, traceFiles, write } = await fixture()
    expect(await run()).toEqual({ check: "ran" })
    expect(await run()).toEqual({ check: "hit" })
    // A file it declares and never reads does not rerun it.
    await write("docs/readme.md", "changed\n")
    await write("docs/new.md", "new\n")
    expect(await run()).toEqual({ check: "hit" })
    expect(logs.filter((line) => line.includes("runs again"))).toEqual([])
    expect(await traceFiles()).toEqual([])
    // A test that does not ask to be observed is keyed by all it declares.
    expect(await run(["plain"])).toEqual({ plain: "ran" })
    expect(await run(["plain"])).toEqual({ plain: "hit" })
    await write("docs/readme.md", "changed again\n")
    expect(await run(["plain"])).toEqual({ plain: "ran" })
  })

  tracedIt("is answered from the cache after a step it depends on ran again", async () => {
    const { run, write } = await fixture()
    expect(await run(["second"])).toEqual({ setup: "ran", second: "ran" })
    await write("docs/readme.md", "changed\n")
    expect(await run(["second"])).toEqual({ setup: "ran", second: "hit" })
    await write("input.txt", "pass, changed\n")
    expect(await run(["second"])).toEqual({ setup: "ran", second: "ran" })
  })

  tracedIt("runs again when a file it read changes", async () => {
    const { logs, run, write } = await fixture()
    expect(await run()).toEqual({ check: "ran" })
    await write("tests/a.test", "changed\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(logs).toContain("//:check  runs again: tests/a.test changed")
    expect(await run()).toEqual({ check: "hit" })
    // Both states now have a record, so going back is answered too.
    await write("tests/a.test", "a\n")
    expect(await run()).toEqual({ check: "hit" })
  })

  tracedIt("runs again when a directory it listed gains a file", async () => {
    const { logs, run, write } = await fixture()
    expect(await run()).toEqual({ check: "ran" })
    await write("tests/b.test", "b\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(logs).toContain("//:check  runs again: tests gained or lost an entry")
    expect(await run()).toEqual({ check: "hit" })
  })

  tracedIt("runs again when a path it found missing now exists", async () => {
    const { logs, run, write } = await fixture()
    expect(await run()).toEqual({ check: "ran" })
    await write("optional.cfg", "now here\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(logs).toContain("//:check  runs again: optional.cfg now exists")
    expect(await run()).toEqual({ check: "hit" })
  })

  tracedIt("fails when its command fails, and stores nothing", async () => {
    const { attempts, logs, run, write } = await fixture()
    await write("input.txt", "fail\n")
    expect(await run()).toEqual({ check: "failed" })
    expect(logs).toContain("//:check  failed while its reads were recorded; it runs again without the recording")
    expect(await attempts()).toEqual([])
    await write("input.txt", "pass\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(await run()).toEqual({ check: "hit" })
  })

  tracedIt("leaves out the paths its declaration ignores", async () => {
    const reading = "/bin/cat input.txt volatile.txt > /dev/null"
    const ignoring = await fixture({ check: reading, observe: { ignore: ["volatile.txt"] } })
    expect(await ignoring.run()).toEqual({ check: "ran" })
    await ignoring.write("volatile.txt", "2\n")
    expect(await ignoring.run()).toEqual({ check: "hit" })
    const strict = await fixture({ check: reading })
    expect(await strict.run()).toEqual({ check: "ran" })
    await strict.write("volatile.txt", "2\n")
    expect(await strict.run()).toEqual({ check: "ran" })
  })

  tracedIt("is not traced for a day once it passed only untraced", async () => {
    // The command refuses to run under a tracer, as a debugger or a privileged program does.
    const refusing = "if /bin/grep -q '^TracerPid:[[:space:]]*[1-9]' /proc/self/status; then exit 1; fi\n" +
      "/bin/cat input.txt > /dev/null"
    const { attempts, logs, run, write } = await fixture({ check: refusing })
    expect(await run()).toEqual({ check: "ran" })
    expect(
      logs.some((line) =>
        line.startsWith(
          "//:check  not cached: it passed, but failed while its reads were recorded; the failed run's output is in .flows/evidence/"
        )
      )
    ).toBe(true)
    const remembered = await attempts()
    expect(remembered.map((attempt) => attempt.label)).toEqual(["//:check"])
    // The next runs are keyed by the declared inputs, as any other shell test.
    expect(await run()).toEqual({ check: "ran" })
    expect(logs.some((line) => line.startsWith("//:check  its reads are not recorded: it passed, but failed while")))
      .toBe(true)
    expect(await run()).toEqual({ check: "hit" })
    await write("docs/readme.md", "changed\n")
    expect(await run()).toEqual({ check: "ran" })
  })

  tracedIt("gives its command the signals a plain run has", async () => {
    // A command that passes only when no signal is ignored, as none is when nothing traces it.
    const unignored = "/bin/grep -q '^SigIgn:[[:space:]]*0000000000000000$' /proc/self/status\n" +
      "/bin/cat input.txt > /dev/null"
    const { logs, run } = await fixture({ check: unignored })
    expect(await run()).toEqual({ check: "ran" })
    expect(logs.filter((line) => line.includes("failed while its reads were recorded"))).toEqual([])
    expect(await run()).toEqual({ check: "hit" })
  })

  tracedIt("is reused after a run that changed the mode and the time of a file it read", async () => {
    const marking = "/bin/chmod +x input.txt\n/usr/bin/touch input.txt\n/bin/cat input.txt > /dev/null"
    const { logs, run } = await fixture({ check: marking })
    expect(await run()).toEqual({ check: "ran" })
    expect(logs.filter((line) => line.includes("not cached"))).toEqual([])
    expect(await run()).toEqual({ check: "hit" })
  })

  tracedIt("ends when its command ends, and stops a process the command left running", async () => {
    const leaving = "sleep 600 > /dev/null 2>&1 &\necho $! > left.pid\n/bin/cat input.txt > /dev/null"
    const { root, run, traceFiles } = await fixture({ check: leaving })
    const started = Date.now()
    expect(await run()).toEqual({ check: "ran" })
    expect(Date.now() - started).toBeLessThan(110_000)
    const left = Number(await Fs.readFile(Path.join(root, "left.pid"), "utf8"))
    expect(() => process.kill(left, 0)).toThrow()
    expect(await traceFiles()).toEqual([])
    expect(await run()).toEqual({ check: "hit" })
  })

  tracedIt("is traced again when the failed attempt could not be remembered", async () => {
    const refusing = "if /bin/grep -q '^TracerPid:[[:space:]]*[1-9]' /proc/self/status; then exit 1; fi"
    const { logs, root, run, write } = await fixture({ check: refusing })
    // The place attempts are remembered is taken by a file.
    await write(Path.join(root, ".flows", "evidence"), "in the way\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(await run()).toEqual({ check: "ran" })
    expect(logs.filter((line) => line.includes("failed while its reads were recorded; it runs again")).length).toBe(2)
  })

  tracedIt("stores nothing for a run that reached a program outside it", async () => {
    const server = Net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as Net.AddressInfo).port
      const connecting =
        `${process.execPath} -e "require('net').connect(${port}, '127.0.0.1').on('connect', function () { this.end() })"`
      const { logs, run } = await fixture({ check: connecting })
      expect(await run()).toEqual({ check: "ran" })
      expect(logs).toContain(`//:check  not cached: it reached a program outside the run on local port ${port}`)
      expect(await run()).toEqual({ check: "ran" })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe("a host that cannot observe a run", () => {
  posixIt("keys the test by its declared inputs and says so once", async () => {
    const { logs, run, write } = await fixture()
    const unobserving: ExecutionServices = {
      ...executionServicesLive,
      observer: () => ({ reason: "strace is not installed" })
    }
    expect(await run(["check", "second"], unobserving)).toEqual({ check: "ran", second: "ran", setup: "ran" })
    expect(logs.filter((line) => line.includes("reads are not observed"))).toEqual([
      "smthrs: reads are not observed on this host: strace is not installed; " +
      "a target that asks for it is keyed by its declared inputs"
    ])
    expect(await run(["check", "second"], unobserving)).toEqual({ check: "hit", second: "hit", setup: "ran" })
    await write("docs/readme.md", "changed\n")
    expect(await run(["check"], unobserving)).toEqual({ check: "ran" })
  })
})

describe("a tracer that fails", () => {
  posixIt("stores nothing when it leaves no trace", async () => {
    const { logs, run, tracer, traceFiles } = await fixture()
    const silent = await tracer("exec \"$@\"")
    expect(await run(["check"], silent)).toEqual({ check: "ran" })
    expect(logs).toContain("//:check  not cached: its trace is empty")
    expect(await run(["check"], silent)).toEqual({ check: "ran" })
    expect(await traceFiles()).toEqual([])
  })

  posixIt("stores nothing when its trace cannot be read", async () => {
    const { logs, run, tracer, traceFiles } = await fixture()
    const blocking = await tracer("rm -f \"$out\"\nmkdir \"$out\"\nexec \"$@\"")
    expect(await run(["check"], blocking)).toEqual({ check: "ran" })
    expect(logs.some((line) => line.startsWith("//:check  not cached: what it read could not be recorded: "))).toBe(
      true
    )
    expect(await traceFiles()).toEqual([])
  })

  posixIt("stores nothing when the run read more than a record holds", async () => {
    const { logs, run, tracer } = await fixture()
    const flooding = await tracer(
      "\"$@\" || exit $?\n" +
        "awk 'BEGIN { for (i = 0; i < 110000; i++) printf \"1 access(\\\"/nonexistent-smithers-observed/%0110d\\\", F_OK) = " +
        "-1 ENOENT (No such file or directory)\\n\", i }' > \"$out\""
    )
    expect(await run(["check"], flooding)).toEqual({ check: "ran" })
    expect(logs).toContain("//:check  not cached: it read more paths than one record holds")
  })

  posixIt("removes the trace of a run that failed", async () => {
    const { run, tracer, traceFiles, write } = await fixture()
    const leaving = await tracer(": > \"$out\"\nexec \"$@\"")
    await write("input.txt", "fail\n")
    expect(await run(["check"], leaving)).toEqual({ check: "failed" })
    expect(await traceFiles()).toEqual([])
    expect(NodeFs.existsSync("/nonexistent-smithers-observed")).toBe(false)
  })
})
