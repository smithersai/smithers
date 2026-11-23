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
import { spawn, spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type * as Executor from "../src/Executor.ts"
import * as CacheEvidence from "../src/internal/CacheEvidence.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as KernelProbe from "./helpers/KernelProbe.ts"
import { selfSignalling, signalling, survivedTimer } from "./helpers/SignalStorm.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

/** The host's tracer, when it has one that can trace a process here. */
const host = ObservedReads.observer(ExecSandbox.host())
const tracedIt = it.skipIf("reason" in host)
/**
 * The recorder a build here records with, as a failure memo names it:
 * `smthrs-observe` and its digest where the package holds one that runs
 * here and `SMTHRS_OBSERVE_WITH` does not ask for strace, else strace.
 */
const recorderHere = (): string => {
  const used = ObservedReads.observer({ ...ExecSandbox.host(), supervisor: ObservedReads.supervisorPath() })
  return "supervisor" in used && used.supervisor === true ? ObservedReads.recorder() : "strace"
}
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

/** Programs outside a run: UDP on a loopback port, a datagram socket path, an abstract name; each answers `ok`. */
const outsideServer = String.raw`
import json, os, select, socket, sys
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
u.bind(("127.0.0.1", 0))
path = os.path.join(sys.argv[1], "outside.sock")
p = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
p.bind(path)
name = "smthrs-outside-%d" % os.getpid()
a = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
a.bind("\0" + name)
print(json.dumps({"port": u.getsockname()[1], "path": path, "name": name}), flush=True)
while True:
    for s in select.select([u, p, a], [], [])[0]:
        data, sender = s.recvfrom(64)
        if sender:
            s.sendto(b"ok", sender)
`

/** A step that sends to {@link outsideServer} one way (`python3 send.py <way>`), and passes on its answer. */
const sender = String.raw`
import ctypes, json, socket, struct, sys
way = sys.argv[1]
outside = json.load(open("outside.json"))
to = ("127.0.0.1", outside["port"])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(10)
if way == "sendto":
    s.sendto(b"q", to)
elif way == "sendmsg":
    s.sendmsg([b"q"], [], 0, to)
elif way == "sendmmsg":
    # A sockaddr_in: the family in the machine's order, the port and the address in the network's.
    address = ctypes.create_string_buffer(struct.pack("=H", socket.AF_INET) + struct.pack("!H4s8x", to[1], socket.inet_aton(to[0])))
    data = ctypes.create_string_buffer(b"q")
    iov = ctypes.create_string_buffer(struct.pack("PN", ctypes.addressof(data), 1))
    header = struct.pack("PI4xPNPNi4xI4x", ctypes.addressof(address), 16, ctypes.addressof(iov), 1, 0, 0, 0, 0)
    vector = ctypes.create_string_buffer(header * 2)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.sendmmsg.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint, ctypes.c_int]
    if libc.sendmmsg(s.fileno(), ctypes.addressof(vector), 2, 0) != 2:
        sys.exit(2)
    s.recv(64)
elif way == "connected":
    s.connect(to)
    s.send(b"q")
elif way in ("path", "abstract"):
    u = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    u.sendto(b"q", outside["path"] if way == "path" else "\0" + outside["name"])
    sys.exit(0)
elif way == "netlink":
    n = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0)
    # RTM_GETLINK, a dump of the machine's interfaces, to the kernel (pid 0).
    n.sendto(struct.pack("=IHHII", 32, 18, 0x301, 1, 0) + struct.pack("=BxHiII", 0, 0, 0, 0, 0), (0, 0))
    sys.exit(0 if len(n.recv(65536)) > 0 else 1)
sys.exit(0 if s.recv(64) == b"ok" else 1)
`

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
  /** Paths the check declares as files of the workspace apart from: none unless given. */
  readonly exclude?: ReadonlyArray<string>
  readonly observe?: boolean | { readonly ignore?: ReadonlyArray<string>; readonly quiet?: ReadonlyArray<string> }
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
  const declared = {
    sandbox: "none" as const,
    data: [settings.exclude === undefined ? S.glob("**") : S.glob("**", { exclude: settings.exclude })]
  }
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
    reasons.splice(0, reasons.length, ...summary.results.map((result) => result.notReused))
    summaries.push(summary)
    return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
  }
  /** Why each target of the last run was not reused, in the run's order. */
  const reasons: Array<string | undefined> = []
  /** Every run's summary, in order. */
  const summaries: Array<Executor.Summary> = []
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
    ReadonlyArray<{
      readonly label: string
      readonly output: ReadonlyArray<string>
      readonly build?: string
      readonly recorder?: string
    }>
  > => {
    const directory = Path.join(root, ".flows", "evidence")
    const names = await Fs.readdir(directory).catch(() => [])
    return Promise.all(names.map(async (name) => JSON.parse(await Fs.readFile(Path.join(directory, name), "utf8"))))
  }
  /** What a run's traces left behind: nothing, once the run is over. */
  const traceFiles = async (): Promise<ReadonlyArray<string>> =>
    (await Fs.readdir(Path.join(root, ".flows", "tmp")).catch(() => [])).filter((name) => name.startsWith("reads-"))
  return { base, root, write, run, node, logs, reasons, summaries, tracer, attempts, traceFiles }
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
    expect(declared.observed?.quiet).toEqual([])
    expect(declared.observed?.key).not.toBe(original.observed?.key)
    expect(original.observed?.quiet).toEqual([])
    const quiet = await (await fixture({ observe: { quiet: ["asks.commit=1"] } })).node("check")
    expect(quiet.observed?.quiet).toEqual(["asks.commit=1"])
    expect(quiet.observed?.ignore).toEqual([])
    expect(quiet.observed?.key).not.toBe(original.observed?.key)
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

  tracedIt("trusts what an earlier build measured outside the workspace while it is the same file", async () => {
    const { base, reasons, root, run, write } = await fixture()
    expect(await run()).toEqual({ check: "ran" })
    const file = Path.join(root, ".flows", "observed-digests.json")
    const kept = JSON.parse(await Fs.readFile(file, "utf8")) as {
      readonly digests: Array<[string, string, string]>
    }
    // The program the check runs is kept; nothing of the workspace is.
    const cat = kept.digests.find(([path]) => path.endsWith("/cat"))!
    expect(cat[2]).toMatch(/^f:[0-9a-f]{64}:x$/)
    expect(kept.digests.filter(([path]) => path.startsWith(`${base}/`))).toEqual([])
    // A file the check declares and never reads changed, so its record is held against what it read.
    await write("docs/readme.md", "changed\n")
    expect(await run()).toEqual({ check: "hit" })
    // Told that `cat` held something else, the next build believes it, as it would have measured it again: the
    // file's size, times and inode are the same.
    cat[2] = `f:${"0".repeat(64)}:x`
    await Fs.writeFile(file, JSON.stringify(kept))
    await write("docs/readme.md", "changed again\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(reasons).toEqual([`${cat[0]} changed`])
  })

  posixIt("fails the build, and stores nothing, when smthrs-observe stops before the step ends", async () => {
    const { base, run, write } = await fixture()
    const stopping = Path.join(base, "tools", "smthrs-observe")
    // Stands where smthrs-observe does: runs the command, and writes the first line of a trace and not the last.
    await write(
      stopping,
      "#!/bin/sh\ntrace=$1\nshift 2\necho \"1 +++ smthrs-observe 1 +++\" > \"$trace\"\nexec \"$@\"\n",
      0o755
    )
    const services = { ...executionServicesLive, observer: () => ({ tracer: stopping, supervisor: true as const }) }
    await expect(run(["check"], services)).rejects.toThrow(
      "//:check: smthrs-observe stopped before the step ended, so its run says nothing about the step"
    )
    // Nothing was stored: the step runs, under strace, as if it never had.
    expect(await run()).toEqual({ check: "ran" })
  })

  tracedIt("fails the build when the step kills smthrs-observe", async () => {
    const supervisor = ObservedReads.supervisorPath(process.platform, process.arch, {
      SMTHRS_OBSERVE_WITH: "smthrs-observe"
    })
    if (supervisor === undefined) return
    // The step kills its parent only when that is the recorder: a step whose recorder is already gone is adopted by
    // the nearest subreaper, which can be the session's own service manager.
    const { run } = await fixture({
      check:
        "p=$PPID; c=$(ps -o comm= -p \"$p\"); case \"${c##*/}\" in smthrs-observe) kill -9 \"$p\";; *) echo \"the parent $p is ${c:-gone}, not smthrs-observe: nothing is killed\" >&2; exit 97;; esac; /bin/cat input.txt > /dev/null"
    })
    const services = { ...executionServicesLive, observer: () => ({ tracer: supervisor, supervisor: true as const }) }
    await expect(run(["check"], services)).rejects.toThrow("smthrs-observe stopped before the step ended")
  })

  tracedIt(
    "runs again without the recording a step whose signals come faster than a recorded call completes",
    async () => {
      const supervisor = ObservedReads.supervisorPath(process.platform, process.arch, {
        SMTHRS_OBSERVE_WITH: "smthrs-observe"
      })
      if (supervisor === undefined) return
      // A timer, to a handler, while the program asks for a file: unrecorded, it ends with this timer.
      const timer = survivedTimer()
      const { logs, run, write } = await fixture({
        check: `/usr/bin/python3 storm.py ${timer} input.txt && /bin/cat input.txt > /dev/null`
      })
      await write("storm.py", signalling)
      const services = { ...executionServicesLive, observer: () => ({ tracer: supervisor, supervisor: true as const }) }
      expect(await run(["check"], services)).toEqual({ check: "ran" })
      expect(logs).toContain(
        `//:check  its recording was ended: ${ObservedReads.signalStorm}; it runs again without it`
      )
      expect(logs).toContain(`//:check  not cached: ${ObservedReads.signalStorm}, so it ran without the recording`)
    },
    120_000
  )

  tracedIt(
    "says in one line that a step ran slower recorded when its recording stopped it many times for signals",
    async () => {
      const supervisor = ObservedReads.supervisorPath(process.platform, process.arch, {
        SMTHRS_OBSERVE_WITH: "smthrs-observe"
      })
      if (supervisor === undefined) return
      // 12,000 signals it sends itself: 12,000 stops, each a round trip to the recorder.
      const { logs, run, write } = await fixture({
        check: "/usr/bin/python3 self-signalling.py 12000 && /bin/cat input.txt > /dev/null"
      })
      await write("self-signalling.py", selfSignalling)
      const services = { ...executionServicesLive, observer: () => ({ tracer: supervisor, supervisor: true as const }) }
      expect(await run(["check"], services)).toEqual({ check: "ran" })
      expect(logs.filter((line) => line.includes("for signals"))).toEqual([
        expect.stringMatching(
          /^\/\/:check {2}its recording stopped it [\d,]+ times for signals, so it ran slower than it does unrecorded$/
        )
      ])
      // The run ended recorded, so it is stored as any other.
      expect(await run(["check"], services)).toEqual({ check: "hit" })
    },
    120_000
  )

  // uv fills its cache so: it makes a directory under a temporary name and each directory of the package in it as
  // `pkg/`, with a slash at the end, writes the package's files, moves the directory into place, then reads them.
  // The step made all of it, so none of it is an input. smthrs-observe wrote `mkdir("pkg/")` as failing, the
  // move then did not carry the files, and every uv step ran at every commit: `.../RECORD changed while it ran`.
  tracedIt(
    "is stored when it read a file it made in a directory it named with a slash at the end, then moved",
    async () => {
      const uv = [
        "set -e",
        "/bin/mkdir -p cache/archive",
        "/bin/mkdir cache/.tmp \"cache/.tmp/pkg/\"",
        "echo one > cache/.tmp/pkg/RECORD",
        "/bin/mv cache/.tmp cache/archive/one",
        "/bin/cat cache/archive/one/pkg/RECORD input.txt > /dev/null"
      ].join("\n")
      const { reasons, run, write } = await fixture({ check: uv })
      expect(await run()).toEqual({ check: "ran" })
      await write("docs/readme.md", "changed\n")
      expect([await run(), reasons]).toEqual([{ check: "hit" }, [undefined]])
    }
  )

  // tokio, and so uv, waits for a child by polling its pidfd and then reaping it without blocking, and panics when
  // it cannot reap it yet. A tracer reaps a traced child that ended before its parent can, so a step running uv
  // failed at random while it was recorded and ran unrecorded for a day. This program fails as tokio does, and waits
  // for its children as tokio does on a kernel without pidfds.
  tracedIt("passes recorded when it waits for its children as tokio does", async () => {
    const reaping = [
      "import errno, os, select, signal, sys",
      "for i in range(1000):",
      "    pid = os.fork()",
      "    if pid == 0:",
      "        signal.signal(signal.SIGUSR1, lambda *a: None)",
      "        os._exit(0)",
      "    try:",
      "        fd = os.pidfd_open(pid)",
      "    except OSError as error:",
      "        if error.errno != errno.ENOSYS: raise",
      "        os.waitpid(pid, 0)",
      "        continue",
      "    poll = select.poll()",
      "    poll.register(fd, select.POLLIN)",
      "    poll.poll()",
      "    if os.waitpid(pid, os.WNOHANG)[0] == 0: sys.exit('pidfd is ready to read, the process should have exited')",
      "    os.close(fd)"
    ].join("\n")
    const { run, write } = await fixture({ check: "/usr/bin/python3 reaping.py && /bin/cat input.txt > /dev/null" })
    await write("reaping.py", `${reaping}\n`)
    expect(await run()).toEqual({ check: "ran" })
    await write("docs/readme.md", "changed\n")
    expect(await run()).toEqual({ check: "hit" })
  }, 120_000)

  // A program of many threads ends while its threads are asking about files: Go's tools do at every exit. The
  // tracer then writes lines for calls it could not follow, each for a thread killed where it stopped. Here a
  // process of twenty-five threads is killed three times. The step still passes, and its result is stored.
  tracedIt("is stored when a program ended while its threads were in the middle of calls", async () => {
    // The process is killed a moment after the last of its threads says it is asking about files.
    const threads = [
      "const { Worker, isMainThread, parentPort } = require(\"node:worker_threads\")",
      "const fs = require(\"node:fs\")",
      "if (isMainThread) {",
      "  let asking = 0",
      "  const started = () => {",
      "    asking += 1",
      "    if (asking === 24) setTimeout(() => process.kill(process.pid, \"SIGKILL\"), 100)",
      "  }",
      "  for (let index = 0; index < 24; index += 1) new Worker(__filename).on(\"message\", started)",
      "} else {",
      "  fs.statSync(\"input.txt\")",
      "  parentPort.postMessage(\"asking\")",
      "  for (;;) fs.statSync(\"input.txt\")",
      "}"
    ].join("\n")
    const { logs, reasons, run, write } = await fixture({
      check: `for round in 1 2 3; do '${process.execPath}' threads.cjs; done; /bin/cat input.txt > /dev/null`
    })
    await write("threads.cjs", threads)
    expect(await run()).toEqual({ check: "ran" })
    expect(logs.filter((line) => line.includes("cannot be read"))).toEqual([])
    // On a failure the build's own lines say why the step ran: why it was not stored, or what changed.
    expect(await run(), logs.join("\n")).toEqual({ check: "hit" })
    await write("docs/readme.md", "changed\n")
    expect(await run(), logs.join("\n")).toEqual({ check: "hit" })
    await write("input.txt", "pass, changed\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(reasons).toEqual(["input.txt changed"])
  }, 120_000)

  // A CI runner's script starts a job by removing the state an earlier run of the job left and making it again.
  // The directory changed while the step ran, and the step is what changed it.
  tracedIt("runs again when it cannot verify a directory it listed before replacing it", async () => {
    const { logs, root, run, write } = await fixture({
      check: ["/bin/rm -rf left", "/bin/mkdir -p left/temp", "/bin/ls left/temp", "/bin/cat input.txt > /dev/null"]
        .join("\n")
    })
    // What the earlier run left: a directory with an empty one in it.
    await Fs.mkdir(Path.join(root, "left", "temp"), { recursive: true })
    expect(await run()).toEqual({ check: "ran" })
    expect(logs.filter((line) => line.includes("changed while it ran"))).toEqual([])
    expect(await run(), logs.join("\n")).toEqual({ check: "ran" })
    expect(logs).toContain("//:check  runs again: left changed")
  })

  tracedIt("reuses an empty directory it removed from an earlier run and recreated", async () => {
    const { logs, root, run, write } = await fixture({
      check: ["set -e", "/bin/rmdir left", "/bin/mkdir left", "/bin/ls left", "/bin/cat input.txt > /dev/null"].join(
        "\n"
      )
    })
    await Fs.mkdir(Path.join(root, "left"))
    expect(await run()).toEqual({ check: "ran" })
    expect(await run(), logs.join("\n")).toEqual({ check: "hit" })
    await write("input.txt", "pass, changed\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(logs).toContain("//:check  runs again: input.txt changed")
    await write("left/regular.txt", "prevents rmdir\n")
    expect(await run()).toEqual({ check: "failed" })
    expect(logs).toContain("//:check  runs again: left gained or lost an entry")
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
    const { logs, reasons, run, write } = await fixture()
    expect(await run()).toEqual({ check: "ran" })
    // A first run has no stored result to say anything about.
    expect(reasons).toEqual([undefined])
    await write("tests/a.test", "changed\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(logs).toContain("//:check  runs again: tests/a.test changed")
    // The run's record says so too, on the target's row.
    expect(reasons).toEqual(["tests/a.test changed"])
    expect(await run()).toEqual({ check: "hit" })
    expect(reasons).toEqual([undefined])
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
    const { attempts, logs, reasons, run, write } = await fixture()
    expect(await run()).toEqual({ check: "ran" })
    await write("input.txt", "fail\n")
    expect(await run()).toEqual({ check: "failed" })
    // A failure after a change names the change.
    expect(reasons).toEqual(["input.txt changed"])
    expect(logs).toContain("//:check  failed while its reads were recorded; it runs again without the recording")
    expect(await attempts()).toEqual([])
    // The passing run's record still answers once the file is as that run read it.
    await write("input.txt", "pass\n")
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

  tracedIt("leaves out what a program it starts with a quiet word reads", async () => {
    // The command asks a program marked by the word for a value, as a CI runner's text asks git for the commit.
    const asking = "/bin/sh -c '/bin/cat volatile.txt > /dev/null' asks.commit=1; /bin/cat input.txt > /dev/null"
    const quiet = await fixture({ check: asking, observe: { quiet: ["asks.commit=1"] } })
    expect(await quiet.run()).toEqual({ check: "ran" })
    await quiet.write("volatile.txt", "2\n")
    expect(await quiet.run()).toEqual({ check: "hit" })
    await quiet.write("input.txt", "pass, changed\n")
    expect(await quiet.run()).toEqual({ check: "ran" })
    const loud = await fixture({ check: asking })
    expect(await loud.run()).toEqual({ check: "ran" })
    await loud.write("volatile.txt", "2\n")
    expect(await loud.run()).toEqual({ check: "ran" })
  })

  tracedIt("is not traced for a day once it passed only untraced", async () => {
    // The command refuses to run while it is recorded (traced, or under a filter of its calls), as a debugger or a
    // privileged program does.
    const refusing = "if /bin/grep -q -e '^TracerPid:[[:space:]]*[1-9]' -e '^Seccomp_filters:[[:space:]]*[1-9]' " +
      "/proc/self/status; then exit 1; fi\n" +
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
    // It names the build and the recorder the run failed under.
    expect(remembered[0]).toMatchObject({ build: expect.stringMatching(/./), recorder: recorderHere() })
    // The next runs are keyed by the declared inputs, as any other shell test.
    expect(await run()).toEqual({ check: "ran" })
    expect(logs.some((line) => line.startsWith("//:check  its reads are not recorded: it passed, but failed while")))
      .toBe(true)
    expect(logs).toContainEqual(expect.stringContaining(
      "they are recorded again a day after that run, or by another build of Smithers build or another recorder."
    ))
    expect(await run()).toEqual({ check: "hit" })
    await write("docs/readme.md", "changed\n")
    expect(await run()).toEqual({ check: "ran" })
  })

  // A recorder fixed by an upgrade, and a build fixed by one, still waited a day.
  tracedIt("records again once under another build or another recorder, and not again under the same", async () => {
    const refusing = "if /bin/grep -q -e '^TracerPid:[[:space:]]*[1-9]' -e '^Seccomp_filters:[[:space:]]*[1-9]' " +
      "/proc/self/status; then exit 1; fi\n" +
      "/bin/cat input.txt > /dev/null"
    const { attempts, logs, root, run, write } = await fixture({ check: refusing })
    const failedRecorded = "//:check  failed while its reads were recorded; it runs again without the recording"
    expect(await run()).toEqual({ check: "ran" })
    const [first] = await attempts()
    const recorder = recorderHere()
    expect(first).toMatchObject({ recorder })
    const evidence = Path.join(root, ".flows", "evidence")
    const [name] = await Fs.readdir(evidence)
    for (
      const other of [
        { ...first, build: "another build" },
        { ...first, recorder: recorder === "strace" ? "smthrs-observe:another" : "strace" },
        { ...first, build: undefined, recorder: undefined }
      ]
    ) {
      await Fs.writeFile(Path.join(evidence, name!), JSON.stringify(other))
      // A change the declared inputs see, so the run is not answered by its plain result.
      await write("input.txt", `pass ${logs.length}\n`)
      const before = logs.length
      expect(await run()).toEqual({ check: "ran" })
      expect(logs.slice(before)).toContain(failedRecorded)
      expect((await attempts())[0]).toMatchObject({ build: first!.build, recorder })
    }
    await write("input.txt", "pass again\n")
    const before = logs.length
    expect(await run()).toEqual({ check: "ran" })
    expect(logs.slice(before)).not.toContain(failedRecorded)
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
    // The first run changed input.txt in place without a prior record; the second measures it before starting.
    expect(await run()).toEqual({ check: "ran" })
    expect(await run()).toEqual({ check: "hit" })
  })

  tracedIt("is reused after a run that filled a directory, moved it into place and read it there", async () => {
    // What `uv`, `go mod download` and `pnpm` do with their caches.
    const staging = [
      "/bin/mkdir -p stage/pkg",
      "/bin/cat input.txt > stage/pkg/RECORD",
      "/bin/mv stage unpacked",
      "/bin/cat unpacked/pkg/RECORD > /dev/null"
    ].join("\n")
    const { logs, root, run, write } = await fixture({ check: staging })
    expect(await run()).toEqual({ check: "ran" })
    expect(logs.filter((line) => line.includes("not cached"))).toEqual([])
    expect(await run()).toEqual({ check: "hit" })
    // What it moved into place is its own product: a fresh checkout without it is answered too.
    await Fs.rm(Path.join(root, "unpacked"), { recursive: true })
    expect(await run()).toEqual({ check: "hit" })
    await write("input.txt", "pass, changed\n")
    expect(await run()).toEqual({ check: "ran" })
  })

  tracedIt("is reused when it finds a file it rewrites as an earlier run found it", async () => {
    // What mypy does with `.mypy_cache/cache.db`, which a cache step puts back from one entry at every commit:
    // reads it and writes it again. `scratch` is a file it makes when it is missing.
    const rewriting = [
      "/bin/cat input.txt > /dev/null",
      "/bin/mkdir -p cache",
      "if [ -f cache/db ]; then /bin/cat cache/db > /dev/null; fi",
      "/bin/date +%s%N >> cache/db",
      "if [ ! -f scratch ]; then echo made > scratch; fi",
      "if [ ! -f ../outside/scratch ]; then echo made > ../outside/scratch; fi"
    ].join("\n")
    const { root, run, write, reasons } = await fixture({ check: rewriting })
    // `scratch` and the file outside the workspace are gone again before each run.
    const putBack = async (): Promise<void> => {
      await write("cache/db", "the entry\n")
      await Fs.rm(Path.join(root, "scratch"), { force: true })
      await Fs.rm(Path.join(root, "..", "outside", "scratch"), { force: true })
    }
    await Fs.mkdir(Path.join(root, "..", "outside"))
    await putBack()
    expect(await run()).toEqual({ check: "ran" })
    await putBack()
    await write("input.txt", "pass, changed\n")
    expect(await run()).toEqual({ check: "ran" })
    // As the cache step puts it back again: what the run read is what the earlier run read.
    await putBack()
    expect(await run()).toEqual({ check: "hit" })
    // Another entry is another input.
    await write("cache/db", "another entry\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(reasons).toEqual(["cache/db changed"])
  })

  tracedIt("does not reuse a step that rewrote a file it read when a later run holds what it left (u2)", async () => {
    const rewrite = [
      "read -r line < data.txt",
      "printf 'xx\\n' > data.txt",
      "[ \"$line\" = ok ]"
    ].join("\n")
    const { run, write } = await fixture({ check: rewrite })
    await write("data.txt", "ok\n")
    expect(await run()).toEqual({ check: "ran" })
    // data.txt now holds `xx` (what the step left): reusing it would be a stale pass.
    expect(await run()).toEqual({ check: "failed" })
    // Putting `ok` back lets the second successful run measure what it found; the next run with `ok` hits.
    await write("data.txt", "ok\n")
    expect(await run()).toEqual({ check: "ran" })
    await write("data.txt", "ok\n")
    expect(await run()).toEqual({ check: "hit" })
    // Still fails when a later commit holds `xx`.
    await write("data.txt", "xx\n")
    expect(await run()).toEqual({ check: "failed" })
  })

  tracedIt("runs again when a directory a step only stated gains or loses a subdirectory (u3)", async () => {
    const checkNlink = "python3 -c 'import os, sys; sys.exit(0 if os.stat(\"nl\").st_nlink == 3 else 1)'"
    const { reasons, root, run } = await fixture({ check: checkNlink })
    await Fs.mkdir(Path.join(root, "nl", "s1"), { recursive: true })
    expect(await run()).toEqual({ check: "ran" })
    expect(await run()).toEqual({ check: "hit" })
    await Fs.mkdir(Path.join(root, "nl", "s2"))
    expect(await run()).toEqual({ check: "failed" })
    expect(reasons).toEqual(["nl gained or lost a subdirectory"])
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
    const refusing = "if /bin/grep -q -e '^TracerPid:[[:space:]]*[1-9]' -e '^Seccomp_filters:[[:space:]]*[1-9]' " +
      "/proc/self/status; then exit 1; fi"
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

  // Linux connects the unspecified address, `::` or `0.0.0.0`, to this machine itself (measured on nyc-01: both reach
  // a server listening on `::`). A run that reaches its own server there reached nothing outside it.
  tracedIt("is stored when it reaches its own dual-stack server through wildcard and loopback addresses", async () => {
    const serving = `${process.execPath} -e "` +
      "const net = require('net'); const server = net.createServer((s) => s.end('ok')).listen(0, '::', async () => {" +
      " const port = server.address().port;" +
      " for (const host of ['::', '::1', '0.0.0.0', '127.0.0.1']) await new Promise((done, fail) => net.connect(port, host)" +
      ".on('data', done).on('error', fail));" +
      " server.close() })" +
      `"`
    const { run } = await fixture({ check: serving })
    expect(await run()).toEqual({ check: "ran" })
    expect(await run()).toEqual({ check: "hit" })
  })

  tracedIt("stores nothing for a run that reached a program outside it on ::", async () => {
    const server = Net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "::", resolve))
    try {
      const port = (server.address() as Net.AddressInfo).port
      const connecting =
        `${process.execPath} -e "require('net').connect(${port}, '::').on('connect', function () { this.end() })"`
      const { logs, run } = await fixture({ check: connecting })
      expect(await run()).toEqual({ check: "ran" })
      expect(logs).toContain(`//:check  not cached: it reached a program outside the run on local port ${port}`)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  tracedIt("stores nothing for a run that sent to a program outside it, by any call that sends", async () => {
    // Programs outside the run, as a server on the machine is: UDP on a loopback port, a datagram socket path, and
    // an abstract name. Each answers `ok`.
    const where = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-outside-")))
    temporary.push(where)
    const server = spawn("python3", ["-c", outsideServer, where], { stdio: ["ignore", "pipe", "inherit"] })
    try {
      const outside = JSON.parse(
        await new Promise<string>((resolve) => server.stdout.once("data", (data) => resolve(String(data))))
      ) as { readonly port: number; readonly path: string; readonly name: string }
      const local = `it reached a program outside the run on local port ${outside.port}`
      const ways: ReadonlyArray<readonly [string, string]> = [
        ["sendto", local],
        ["sendmsg", local],
        ["sendmmsg", local],
        // A connected datagram socket: its connect is what the run reached.
        ["connected", local],
        ["path", `it reached a program outside the run through the socket "${outside.path}"`],
        ["abstract", `it reached a program outside the run through the socket @"${outside.name}"`]
      ]
      for (const [way, reason] of ways) {
        const { logs, run, write } = await fixture({ check: `python3 send.py ${way}` })
        await write("send.py", sender)
        await write("outside.json", JSON.stringify(outside))
        expect([way, await run()]).toEqual([way, { check: "ran" }])
        expect([way, logs]).toEqual([way, expect.arrayContaining([`//:check  not cached: ${reason}`])])
      }
      // The kernel's own netlink end answers with the machine's state, as /proc does: the run is stored.
      const kernel = await fixture({ check: "python3 send.py netlink" })
      await kernel.write("send.py", sender)
      await kernel.write("outside.json", JSON.stringify(outside))
      expect(await kernel.run()).toEqual({ check: "ran" })
      expect(await kernel.run()).toEqual({ check: "hit" })
    } finally {
      server.kill()
    }
  })

  tracedIt("gives no run an io_uring, and a step that needs one takes its plain run's verdict", async () => {
    // The kernel takes a ring's requests from memory the step can change after any recorder read it: no run has one.
    const needing = "python3 -c 'import ctypes, sys; libc = ctypes.CDLL(None, use_errno=True); " +
      "sys.exit(0 if libc.syscall(425, 4, ctypes.create_string_buffer(120)) >= 0 else 1)'"
    const { logs, run, summaries } = await fixture({ check: needing })
    expect(await run()).toEqual({ check: "ran" })
    // It fails recorded, passes plain, and the plain run is the verdict: nothing is stored, and the line names why.
    expect(logs).toContain(
      "//:check  failed while its reads were recorded, where it asked for io_uring, which a recorded step does not " +
        "get; it runs again without the recording"
    )
    expect(summaries[0]!.results[0]!.notStored).toBe(
      "it passed, but failed while its reads were recorded, where it asked for io_uring, which a recorded step does " +
        "not get"
    )
    expect(await run()).toEqual({ check: "ran" })
    expect(summaries[1]!.results[0]!.status).toBe("ran")
    // node's libuv sets up rings at every start, and runs on without them: its step is stored.
    const node = await fixture({ check: `${process.execPath} -e "require('fs').readFileSync('input.txt')"` })
    expect(await node.run()).toEqual({ check: "ran" })
    expect(node.summaries[0]!.results[0]!.notStored).toBeUndefined()
    expect(await node.run()).toEqual({ check: "hit" })
  })

  tracedIt("stores nothing for a run whose connection ended before the recorder looked at it", async () => {
    // A server outside the run that ends each connection at once. The step stays out of the kernel, where the recorder
    // could ask its socket, until the connection is over both ways, and asks next with a lookup.
    const server = Net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as Net.AddressInfo).port
      const connecting = "python3 -c 'import os, socket, time\n" +
        "def spin():\n    end = time.perf_counter() + 0.3\n    while time.perf_counter() < end: pass\n" +
        `s = socket.socket(); s.connect(("127.0.0.1", ${port})); spin(); s.shutdown(socket.SHUT_RDWR); s.close()\n` +
        "spin(); os.stat(\"input.txt\")'"
      const { logs, run } = await fixture({ check: connecting })
      expect(await run()).toEqual({ check: "ran" })
      expect(logs).toContain(`//:check  not cached: it reached a program outside the run on local port ${port}`)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  tracedIt("runs without the recording for a day after a run that reached outside it", async () => {
    const server = Net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as Net.AddressInfo).port
      const connecting =
        `${process.execPath} -e "require('net').connect(${port}, '127.0.0.1').on('connect', function () { this.end() })"\n` +
        "case \"$(/bin/cat input.txt)\" in *fail*) exit 1 ;; esac"
      const { base, logs, root, run, tracer, write } = await fixture({ check: connecting })
      const reason = `it reached a program outside the run on local port ${port}`
      expect(await run()).toEqual({ check: "ran" })
      const evidence = Path.join(root, ".flows", "evidence")
      const [name] = (await Fs.readdir(evidence)).filter((entry) => entry.endsWith(".outside.json"))
      const file = Path.join(evidence, name!)
      const remembered = JSON.parse(await Fs.readFile(file, "utf8")) as { readonly at: number }
      expect(remembered).toEqual({
        format: "smthrs-reached-outside/1",
        at: expect.any(Number),
        label: "//:check",
        reason
      })
      // A tracer that says when it is started: the next run starts none, and stores nothing as before.
      const marker = Path.join(base, "traced")
      const telling = await tracer(`: > ${marker}\n"$@"`)
      expect(await run(["check"], telling)).toEqual({ check: "ran" })
      expect(NodeFs.existsSync(marker)).toBe(false)
      expect(logs).toContain(
        `//:check  not cached: ${reason}, when its reads were last recorded; they are recorded again a day after that run`
      )
      // The run is the verdict, recorded or not.
      await write("input.txt", "fail\n")
      expect(await run(["check"], telling)).toEqual({ check: "failed" })
      expect(NodeFs.existsSync(marker)).toBe(false)
      await write("input.txt", "pass\n")
      // A day after the recorded run its reads are recorded again.
      await Fs.writeFile(file, JSON.stringify({ ...remembered, at: remembered.at - CacheEvidence.attemptMemoryMs }))
      expect(await run(["check"], telling)).toEqual({ check: "ran" })
      expect(NodeFs.existsSync(marker)).toBe(true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  tracedIt("records a run that reached outside it again when that could not be remembered", async () => {
    const server = Net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as Net.AddressInfo).port
      const connecting =
        `${process.execPath} -e "require('net').connect(${port}, '127.0.0.1').on('connect', function () { this.end() })"`
      const { logs, root, run, write } = await fixture({ check: connecting })
      // The place it is remembered is taken by a file.
      await write(Path.join(root, ".flows", "evidence"), "in the way\n")
      expect(await run()).toEqual({ check: "ran" })
      expect(await run()).toEqual({ check: "ran" })
      const line = `//:check  not cached: it reached a program outside the run on local port ${port}`
      expect(logs.filter((entry) => entry === line).length).toBe(2)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  tracedIt("names the run of a step it does not record", async () => {
    const { run, summaries } = await fixture()
    // A test run with no recording, and a build that is never stored, as a job's cache step is.
    expect(await run(["plain", "setup"])).toEqual({ plain: "ran", setup: "ran" })
    for (const result of summaries[0]!.results) {
      expect(Object.keys(result.parts?.ms ?? {}), result.label).toEqual(["step"])
      expect(result.parts!.ms["step"]!, result.label).toBeGreaterThan(0)
      // The step is the target's time: nothing of it is left unnamed but the scheduling around it.
      expect(result.parts!.ms["step"]!, result.label).toBeLessThanOrEqual(result.durationMs + 1)
    }
  })

  tracedIt("says what each part of its run took", async () => {
    const { run, summaries, write } = await fixture()
    expect(await run()).toEqual({ check: "ran" })
    const first = summaries[0]!
    const ran = first.results[0]!.parts!
    // The command, reading what it read and storing the record are timed; so is the look at the records before.
    expect(Object.keys(ran.ms).sort()).toEqual(["check", "keep", "reads", "step", "store"])
    for (const ms of Object.values(ran.ms)) expect(ms).toBeGreaterThanOrEqual(0)
    expect(ran.ms["step"]).toBeGreaterThan(0)
    expect(ran.ms["reads"]).toBeGreaterThan(0)
    // The parts are within the target's own time.
    expect(Object.values(ran.ms).reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(first.results[0]!.durationMs + 1)
    // Linux says what the command's processes used.
    expect(ran.cpuMs?.["step"]).toBeGreaterThan(0)
    expect(Object.keys(first.parts!.ms)).toContain("answer")
    // A run answered from its record ran no command and read no trace.
    expect(await run()).toEqual({ check: "hit" })
    expect(summaries[1]!.results[0]!.parts).toBeUndefined()
    expect(Object.keys(summaries[1]!.parts!.ms)).toContain("answer")
    // One that has to run again says what holding its record against the files took.
    await write("input.txt", "pass, changed\n")
    expect(await run()).toEqual({ check: "ran" })
    expect(summaries[2]!.results[0]!.parts!.ms["check"]).toBeGreaterThanOrEqual(0)
  })
})

/**
 * A job as a CI runs it: four steps, each after the one before, in one
 * checkout. `install` and `build` leave files the later steps read; `lint`
 * and `test` leave none. Every step notes that it ran in the build's own
 * cache directory, which no record holds.
 */
const job = async (
  settings: { readonly shared?: boolean; readonly install?: string | ((outside: string) => string) } = {}
) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-observed-job-")))
  // A directory that is neither in the workspace nor temporary, as a home directory is.
  const outside = await Fs.realpath(await Fs.mkdtemp("/var/tmp/smithers-observed-outside-"))
  temporary.push(base, outside)
  const root = Path.join(base, "ws")
  const write = async (name: string, text: string, mode = 0o644): Promise<void> => {
    const file = Path.isAbsolute(name) ? name : Path.join(root, name)
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, text, { mode })
    await Fs.chmod(file, mode)
  }
  await write("lock.txt", "locked 1\n")
  await write("registry.cfg", "registry 1\n")
  await write("src/a.txt", "source 1\n")
  await write("tests/t.txt", "test 1\n")
  await write("lint.cfg", "lint 1\n")
  await write("docs/readme.md", "nothing reads this\n")
  await write(".flows/runs.log", "")
  const files = settings.shared === true ? S.Filegroup({ srcs: [S.glob("**")] }) : S.glob("**")
  const step = (name: string, shell: string, after: ReadonlyArray<unknown>, observe = true) =>
    S.Shell.Test({
      sandbox: "none",
      shell: `echo ${name} >> .flows/runs.log\n${shell}`,
      observe,
      data: [files, ...after] as never
    })
  const installing = "/bin/cat registry.cfg > /dev/null\n/bin/mkdir -p deps\n/bin/cat lock.txt > deps/installed.txt"
  const install = step(
    "install",
    typeof settings.install === "function" ? settings.install(outside) : settings.install ?? installing,
    []
  )
  const build = step("build", "/bin/cat deps/installed.txt src/a.txt > deps/built.txt", [install])
  const lint = step("lint", "/bin/cat lint.cfg src/a.txt > /dev/null", [build])
  const test = step(
    "test",
    "case \"$(/bin/cat tests/t.txt)\" in *fail*) exit 1 ;; esac\n/bin/cat deps/built.txt > /dev/null",
    [lint]
  )
  // A target keyed by its declared files, which waits for the build as the test does.
  const after = step("after", "/bin/cat deps/built.txt > /dev/null", [build], false)
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("observed-job", {
      repository: "git+https://example.invalid/observed-job.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{
      file: "PACKAGE.ts",
      packagePath: "",
      value: S.Package({
        targets: {
          ...(settings.shared === true ? { files: files as never } : {}),
          install,
          build,
          lint,
          test,
          after
        }
      })
    }]
  })
  const environment = {
    PATH: [
      Path.join(base, "tools"),
      ...("tracer" in host ? [Path.dirname(host.tracer)] : []),
      "/usr/bin",
      "/bin"
    ].join(Path.delimiter)
  }
  const logs: Array<string> = []
  const options = (names: ReadonlyArray<string>) => ({
    index,
    cacheDirectory: ".flows",
    verb: "auto" as const,
    patterns: names.map((name) => `//:${name}`),
    environment,
    log: (line: string) => {
      logs.push(line)
    }
  })
  const reasons: Record<string, string | undefined> = {}
  const unstored: Record<string, string | undefined> = {}
  /** What each step of the last run spent its time on, where the run timed any part. */
  const spent: Record<string, Executor.Parts | undefined> = {}
  /** Plans and executes the named targets; answers each step's status by name. */
  const run = async (
    names: ReadonlyArray<string> = ["test"],
    services: ExecutionServices = executionServicesLive
  ): Promise<Record<string, string>> => {
    const summary = await withPath(environment.PATH, async () =>
      Effect.runPromise(
        executeEffect(await plan(options(names)), options(names)).pipe(
          Effect.provideService(ExecutionServices, services)
        )
      ))
    for (const name of Object.keys(reasons)) delete reasons[name]
    for (const name of Object.keys(unstored)) delete unstored[name]
    for (const name of Object.keys(spent)) delete spent[name]
    const steps = summary.results.filter((result) => result.target === "Shell.Test")
    for (const result of steps) {
      const name = result.label.split(":")[1]!
      if (result.parts !== undefined) spent[name] = result.parts
      if (result.notReused !== undefined) reasons[name] = result.notReused
      if (result.notStored !== undefined) unstored[name] = result.notStored
    }
    return Object.fromEntries(steps.map((result) => [result.label.split(":")[1]!, result.status]))
  }
  /** The steps that ran since the last call, in the order they ran. */
  const ran = async (): Promise<ReadonlyArray<string>> => {
    const log = Path.join(root, ".flows", "runs.log")
    const names = (await Fs.readFile(log, "utf8")).split("\n").filter((name) => name !== "")
    await Fs.writeFile(log, "")
    return names
  }
  /** What a fresh checkout is: nothing a step wrote is there. */
  const checkout = (): Promise<void> => Fs.rm(Path.join(root, "deps"), { recursive: true, force: true })
  const exists = (name: string): boolean => NodeFs.existsSync(Path.join(root, name))
  const read = (name: string): string => NodeFs.readFileSync(Path.join(root, name), "utf8")
  /** The archives kept beside the cache, by name. */
  const kept = async (): Promise<ReadonlyArray<string>> =>
    (await Fs.readdir(Path.join(root, ".flows", "kept")).catch(() => [])).filter((name) => name.endsWith(".tar")).sort()
  return { base, outside, root, write, run, ran, checkout, exists, read, kept, logs, reasons, spent, unstored }
}

const all = (status: string) => ({ install: status, build: status, lint: status, test: status })

/**
 * Two steps and a file both the checkout and the first step hold: `write`
 * copies a setting from outside the workspace over `answer.txt`, and `check`
 * passes while `answer.txt` holds `one`.
 */
const rewriting = async () => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-observed-rewrite-")))
  const outside = await Fs.realpath(await Fs.mkdtemp("/var/tmp/smithers-observed-setting-"))
  temporary.push(base, outside)
  const root = Path.join(base, "ws")
  await Fs.mkdir(root, { recursive: true })
  const setting = Path.join(outside, "setting.txt")
  const answer = Path.join(root, "answer.txt")
  await Fs.writeFile(setting, "one\n")
  await Fs.writeFile(answer, "one\n")
  const write = S.Shell.Test({
    sandbox: "none",
    shell: `/bin/cat ${setting} > answer.txt`,
    observe: true,
    data: [S.glob("**")]
  })
  const check = S.Shell.Test({
    sandbox: "none",
    shell: "/bin/grep -q one answer.txt",
    observe: true,
    data: [S.glob("**"), write]
  })
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("observed-rewrite", {
      repository: "git+https://example.invalid/observed-rewrite.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { write, check } }) }]
  })
  const environment = {
    PATH: [...("tracer" in host ? [Path.dirname(host.tracer)] : []), "/usr/bin", "/bin"].join(Path.delimiter)
  }
  const reasons: Record<string, string | undefined> = {}
  const options = {
    index,
    cacheDirectory: ".flows",
    verb: "auto" as const,
    patterns: ["//:check"],
    environment,
    log: () => undefined
  }
  const run = async (): Promise<Record<string, string>> => {
    const summary = await withPath(environment.PATH, async () =>
      Effect.runPromise(
        executeEffect(await plan(options), options).pipe(
          Effect.provideService(ExecutionServices, executionServicesLive)
        )
      ))
    for (const name of Object.keys(reasons)) delete reasons[name]
    for (const result of summary.results) {
      if (result.notReused !== undefined) reasons[result.label.split(":")[1]!] = result.notReused
    }
    return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
  }
  return { answer, reasons, run, setting }
}

describe("a job of observed steps", () => {
  tracedIt("runs no step in a fresh checkout while every step would read what it read", async () => {
    const { checkout, exists, ran, run, write } = await job()
    expect(await run()).toEqual(all("ran"))
    expect(await ran()).toEqual(["install", "build", "lint", "test"])
    // With what the steps left still in place.
    expect(await run()).toEqual(all("hit"))
    // In a fresh checkout: nothing is installed or built, and nothing needs to be.
    await checkout()
    expect(await run()).toEqual(all("hit"))
    await write("docs/readme.md", "changed\n")
    await write("docs/new.md", "new\n")
    expect(await run()).toEqual(all("hit"))
    expect(await ran()).toEqual([])
    expect(exists("deps")).toBe(false)
  })

  tracedIt("puts back what the steps before left when a step after them runs, and runs only that step", async () => {
    const { checkout, exists, kept, logs, ran, read, reasons, run, spent, write } = await job()
    expect(await run()).toEqual(all("ran"))
    await ran()
    // What the install and the build left is kept beside the cache; the lint and the test left nothing.
    expect(await kept()).toHaveLength(2)
    await checkout()
    // Only the test reads this file. It runs, and finds what the install and the build left: neither ran.
    await write("tests/t.txt", "test 2\n")
    expect(await run()).toEqual({ install: "hit", build: "hit", lint: "hit", test: "ran" })
    expect(await ran()).toEqual(["test"])
    expect(reasons).toEqual({ test: "tests/t.txt changed" })
    // The step that ran says what putting those files back took; the steps that did not run timed nothing.
    expect(Object.keys(spent)).toEqual(["test"])
    expect(spent["test"]?.ms["putBack"]).toBeGreaterThan(0)
    expect([read("deps/installed.txt"), read("deps/built.txt")]).toEqual(["locked 1\n", "locked 1\nsource 1\n"])
    expect(logs).toContain("//:install  what it left is put back for //:test")
    expect(logs).toContain("//:build  what it left is put back for //:test")
    // The test read what was put back as what those steps wrote: a fresh checkout is answered whole.
    await checkout()
    expect(await run()).toEqual(all("hit"))
    expect(exists("deps")).toBe(false)
    // Both states now have their records.
    await write("tests/t.txt", "test 1\n")
    expect(await run()).toEqual(all("hit"))
    expect(await ran()).toEqual([])
  })

  // The checkout holds a file, and a step writes over it. In a fresh checkout the file holds the checkout's
  // bytes again, which may be the bytes an older run of that step left. The step after it must not be answered
  // by what it read then: the step that writes the file is answered from another run now, and would write
  // something else.
  tracedIt("is not answered by what a step it reads from left in another of that step's runs", async () => {
    const { answer, reasons, run, setting } = await rewriting()
    expect(await run()).toEqual({ write: "ran", check: "ran" })
    expect(await run()).toEqual({ write: "hit", check: "hit" })
    // Another setting: the file is written anew, and the check fails on it.
    await Fs.writeFile(setting, "two\n")
    expect(await run()).toEqual({ write: "ran", check: "failed" })
    // A fresh checkout with that setting. The file holds `one`, as when the check passed, and the step that
    // writes it is answered from its run with `two`: the check runs on what that run left, and fails.
    await Fs.writeFile(answer, "one\n")
    expect(await run()).toEqual({ write: "hit", check: "failed" })
    // By the time the check is looked at alone, what that run left has been put back for it.
    expect(reasons).toEqual({ check: "answer.txt, which //:write left, changed" })
    expect(NodeFs.readFileSync(answer, "utf8")).toBe("two\n")
    // Back at the first setting, the first records answer, in a fresh checkout too.
    await Fs.writeFile(setting, "one\n")
    await Fs.writeFile(answer, "one\n")
    expect(await run()).toEqual({ write: "hit", check: "hit" })
  })

  tracedIt("fails as the step fails, with what the steps before it left in place", async () => {
    const { checkout, ran, run, write } = await job()
    expect(await run()).toEqual(all("ran"))
    await ran()
    await checkout()
    await write("tests/t.txt", "fail\n")
    expect(await run()).toEqual({ install: "hit", build: "hit", lint: "hit", test: "failed" })
    // Traced, then again untraced: the verdict is the untraced run's.
    expect(await ran()).toEqual(["test", "test"])
  })

  tracedIt("runs a step again when what an earlier step left for it differs", async () => {
    const { checkout, ran, reasons, run, write } = await job()
    expect(await run()).toEqual(all("ran"))
    await ran()
    await checkout()
    await write("lock.txt", "locked 2\n")
    expect(await run()).toEqual({ install: "ran", build: "ran", lint: "hit", test: "ran" })
    // Each step is compared after the steps before it ran: it finds what they left changed.
    expect(reasons).toEqual({
      install: "lock.txt changed",
      build: "deps/installed.txt, which //:install left, changed",
      test: "deps/built.txt, which //:build left, changed"
    })
    expect(await ran()).toEqual(["install", "build", "test"])
    await checkout()
    expect(await run()).toEqual(all("hit"))
    // Back at the first lockfile, the first records answer.
    await write("lock.txt", "locked 1\n")
    expect(await run()).toEqual(all("hit"))
    expect(await ran()).toEqual([])
  })

  tracedIt("runs a step in the middle of a job alone", async () => {
    const { checkout, exists, ran, run, write } = await job()
    expect(await run()).toEqual(all("ran"))
    await ran()
    await checkout()
    await write("lint.cfg", "lint 2\n")
    // What the install and the build left is put back for the lint; the test finds what it read and does not run.
    expect(await run()).toEqual({ install: "hit", build: "hit", lint: "ran", test: "hit" })
    expect(await ran()).toEqual(["lint"])
    expect(exists("deps/built.txt")).toBe(true)
    await checkout()
    expect(await run()).toEqual(all("hit"))
  })

  tracedIt("keeps a step's record when the steps before it ran again and left the same files", async () => {
    const { checkout, ran, reasons, run, write } = await job()
    expect(await run()).toEqual(all("ran"))
    await ran()
    await checkout()
    // The install reads this and writes the same tree: its record is a new one, what it left is not.
    await write("registry.cfg", "registry 2\n")
    // The build finds what it read of the install, so what it left is put back in place of a run.
    expect(await run()).toEqual({ install: "ran", build: "hit", lint: "hit", test: "hit" })
    expect(reasons).toEqual({ install: "registry.cfg changed" })
    expect(await ran()).toEqual(["install"])
    // The build's record names the install's new record, and the test's the build's: a fresh checkout is answered whole.
    await checkout()
    expect(await run()).toEqual(all("hit"))
    expect(await ran()).toEqual([])
  })

  tracedIt("answers a step nothing waits for from its record, whatever it left", async () => {
    const { checkout, ran, run } = await job()
    expect(await run(["build"])).toEqual({ install: "ran", build: "ran" })
    await checkout()
    expect(await run(["build"])).toEqual({ install: "hit", build: "hit" })
    await ran()
    // The whole job after it: the first two steps are answered and what they left is put back for the rest.
    expect(await run()).toEqual({ install: "hit", build: "hit", lint: "ran", test: "ran" })
    expect(await ran()).toEqual(["lint", "test"])
  })

  tracedIt("puts back what a step left for a target that is not observed", async () => {
    const { checkout, exists, ran, run } = await job()
    expect(await run(["after"])).toEqual({ install: "ran", build: "ran", after: "ran" })
    await ran()
    await checkout()
    // The target is answered from its declared files, but nothing says so before its turn: the files are there.
    expect(await run(["after"])).toEqual({ install: "hit", build: "hit", after: "hit" })
    expect(await ran()).toEqual([])
    expect(exists("deps/built.txt")).toBe(true)
  })

  tracedIt("runs a step again when what it left outside the workspace is not as it left it", async () => {
    // The install also puts a program where a home directory keeps them: nothing puts that back.
    const { checkout, logs, outside, ran, reasons, run, write } = await job({
      install: (elsewhere) =>
        `/bin/mkdir -p deps\n/bin/cat lock.txt > deps/installed.txt\n/bin/cat lock.txt > ${elsewhere}/tool`
    })
    expect(await run()).toEqual(all("ran"))
    await ran()
    await checkout()
    // While it is there as the install left it, the kept files stand for the install.
    await write("tests/t.txt", "test 2\n")
    expect(await run()).toEqual({ install: "hit", build: "hit", lint: "hit", test: "ran" })
    await ran()
    await checkout()
    await Fs.rm(Path.join(outside, "tool"))
    await write("tests/t.txt", "test 3\n")
    expect(await run()).toEqual({ install: "ran", build: "hit", lint: "hit", test: "ran" })
    // The record says which path keeps the kept files from standing for the install.
    expect(reasons["install"]).toBe(
      "a step after it runs, and what this one left cannot be put back: " +
        `${Path.join(outside, "tool")}, which it left outside the workspace, is not as it left it`
    )
    expect(await ran()).toEqual(["install", "test"])
    expect(NodeFs.readFileSync(Path.join(outside, "tool"), "utf8")).toBe("locked 1\n")
    expect(logs.filter((line) => line.includes("is not kept"))).toEqual([])
  })

  tracedIt("does not keep what cannot be put back, and runs such a step again", async () => {
    // A link into what the step wrote outside the workspace would lead nowhere on another machine.
    const linking = await job({
      install: (elsewhere) =>
        `/bin/mkdir -p deps ${elsewhere}/store\n/bin/cat lock.txt > ${elsewhere}/store/installed.txt\n` +
        `/bin/ln -s ${elsewhere}/store/installed.txt deps/installed.txt`
    })
    expect(await linking.run()).toEqual(all("ran"))
    expect(linking.logs).toContain(
      `//:install  what it left is not kept: deps/installed.txt is a link to ${linking.outside}/store/installed.txt, ` +
        "which it wrote outside the workspace; it runs again when a step after it runs"
    )
    await linking.ran()
    await linking.checkout()
    await linking.write("tests/t.txt", "test 2\n")
    expect(await linking.run()).toEqual({ install: "ran", build: "hit", lint: "hit", test: "ran" })
    expect(await linking.ran()).toEqual(["install", "test"])
    // Nor is what a step wrote into the repository's own store.
    const storing = await job({
      install: "/bin/mkdir -p deps\n/bin/cat lock.txt > deps/installed.txt\n: > .git/marker"
    })
    await storing.write(".git/HEAD", "ref: refs/heads/main\n")
    expect(await storing.run()).toEqual(all("ran"))
    expect(storing.logs).toContain(
      "//:install  what it left is not kept: it wrote .git/marker, in the repository's own store; " +
        "it runs again when a step after it runs"
    )
  })

  tracedIt("removes what the step removed when it puts back what the step left", async () => {
    // `unlink` removes the name without asking first whether it is there, so the file is nothing the step read.
    const { checkout, exists, ran, run, write } = await job({
      install: "/bin/mkdir -p deps\n/bin/cat lock.txt > deps/installed.txt\n/usr/bin/unlink stale.txt"
    })
    await write("stale.txt", "a file the install removes\n")
    expect(await run()).toEqual(all("ran"))
    expect(exists("stale.txt")).toBe(false)
    await ran()
    // A fresh checkout holds the file again.
    await checkout()
    await write("stale.txt", "a file the install removes\n")
    await write("tests/t.txt", "test 2\n")
    expect(await run()).toEqual({ install: "hit", build: "hit", lint: "hit", test: "ran" })
    expect(await ran()).toEqual(["test"])
    expect(exists("stale.txt")).toBe(false)
  })

  tracedIt("runs the step when its kept files cannot be put back", async () => {
    const { checkout, kept, logs, ran, read, root, run, write } = await job()
    expect(await run()).toEqual(all("ran"))
    await ran()
    await checkout()
    // The archive of what the install left is cut short, as a cache restored in part leaves it.
    const archives = await kept()
    for (const name of archives) {
      const file = Path.join(root, ".flows", "kept", name)
      if ((await Fs.readFile(file)).includes("installed.txt")) await Fs.writeFile(file, "not an archive")
    }
    await write("tests/t.txt", "test 2\n")
    expect(await run()).toEqual({ install: "hit", build: "hit", lint: "hit", test: "ran" })
    expect(logs).toContain("//:install  what it left could not be put back; it runs for //:test")
    expect(await ran()).toEqual(["install", "test"])
    expect(read("deps/built.txt")).toBe("locked 1\nsource 1\n")
  })

  /** The live services with another `tar`, or none. */
  const withTar = (tar: string | undefined): ExecutionServices => ({
    ...executionServicesLive,
    findOnPath: (name, ...rest) =>
      name === "tar" ? Effect.succeed(tar) : executionServicesLive.findOnPath(name, ...rest)
  })

  tracedIt("keeps nothing on a host with no tar, or one whose tar fails, and runs such a step again", async () => {
    const none = await job()
    expect(await none.run(["test"], withTar(undefined))).toEqual(all("ran"))
    expect(await none.kept()).toEqual([])
    await none.ran()
    await none.checkout()
    await none.write("tests/t.txt", "test 2\n")
    expect(await none.run()).toEqual({ install: "ran", build: "ran", lint: "hit", test: "ran" })
    expect(await none.ran()).toEqual(["install", "build", "test"])

    const failing = await job()
    await failing.write(Path.join(failing.base, "tools", "tar"), "#!/bin/sh\nexit 1\n", 0o755)
    expect(await failing.run(["test"], withTar(Path.join(failing.base, "tools", "tar")))).toEqual(all("ran"))
    expect(failing.logs).toContain(
      "//:install  what it left could not be kept; it runs again when a step after it runs"
    )
    expect(await failing.kept()).toEqual([])
    expect(await Fs.readdir(Path.join(failing.root, ".flows", "kept"))).toEqual([])
  })

  tracedIt("runs the step when a host that kept its files has no tar to put them back", async () => {
    const { checkout, logs, ran, run, write } = await job()
    expect(await run()).toEqual(all("ran"))
    await ran()
    await checkout()
    await write("tests/t.txt", "test 2\n")
    expect(await run(["test"], withTar(undefined))).toEqual({ install: "hit", build: "hit", lint: "hit", test: "ran" })
    expect(logs).toContain("//:install  what it left could not be put back; it runs for //:test")
    expect(await ran()).toEqual(["install", "build", "test"])
  })

  tracedIt(
    "puts back nothing from an archive that names a path elsewhere, or whose list of paths cannot be read",
    async () => {
      const { base, checkout, kept, logs, outside, ran, root, run, write } = await job({
        // The install also gives the workspace's own directory a mode, which is one more path it wrote.
        install: "/bin/chmod u+w .\n/bin/mkdir -p deps\n/bin/cat lock.txt > deps/installed.txt"
      })
      expect(await run()).toEqual(all("ran"))
      await ran()
      const directory = Path.join(root, ".flows", "kept")
      const [first, second] = await kept()
      // One archive now holds a file outside the workspace and the temporary directory.
      await write(Path.join(outside, "elsewhere.txt"), "not the run's\n")
      const packed = spawnSync("tar", ["-P", "-cf", Path.join(directory, first!), Path.join(outside, "elsewhere.txt")])
      expect(packed.status).toBe(0)
      // The other's list of the paths its run wrote is no longer one.
      await Fs.writeFile(Path.join(directory, second!.replace(/\.tar$/, ".json")), "not a list")
      await Fs.rm(Path.join(outside, "elsewhere.txt"))
      await checkout()
      await write("tests/t.txt", "test 2\n")
      expect(await run()).toEqual({ install: "hit", build: "hit", lint: "hit", test: "ran" })
      expect(logs).toContain("//:install  what it left could not be put back; it runs for //:test")
      expect(logs).toContain("//:build  what it left could not be put back; it runs for //:test")
      expect(await ran()).toEqual(["install", "build", "test"])
      expect(NodeFs.existsSync(Path.join(outside, "elsewhere.txt"))).toBe(false)
      expect(NodeFs.existsSync(base)).toBe(true)
    }
  )

  tracedIt("runs the step when its kept files cannot be unpacked where they were", async () => {
    const { checkout, logs, ran, read, root, run, write } = await job()
    expect(await run()).toEqual(all("ran"))
    await ran()
    await checkout()
    // A directory nothing can be written in, where the install's files go.
    const locked = Path.join(root, "deps")
    await Fs.mkdir(locked)
    await Fs.chmod(locked, 0o555)
    try {
      await write("tests/t.txt", "test 2\n")
      expect(await run()).toEqual({ install: "hit", build: "hit", lint: "hit", test: "ran" })
      expect(logs).toContain("//:install  what it left could not be put back; it runs for //:test")
      expect((await ran()).at(-1)).toBe("test")
      expect(read("deps/built.txt")).toBe("locked 1\nsource 1\n")
    } finally {
      await Fs.chmod(locked, 0o755)
    }
  })

  tracedIt(
    "fails the step that waits when the files cannot be put back and the step that left them fails now",
    async () => {
      // The install passes once in a checkout: what it keeps in the build's own cache directory is in no record.
      const { checkout, exists, ran, run, write } = await job({
        install:
          "test ! -f .flows/once || exit 1\n: > .flows/once\n/bin/mkdir -p deps\n/bin/cat lock.txt > deps/installed.txt"
      })
      expect(await run()).toEqual(all("ran"))
      await ran()
      await checkout()
      await write("tests/t.txt", "test 2\n")
      expect(await run(["test"], withTar(undefined))).toEqual({
        install: "hit",
        build: "hit",
        lint: "hit",
        test: "failed"
      })
      expect(await ran()).toEqual(["install"])
      expect(exists("deps/installed.txt")).toBe(false)
    }
  )

  tracedIt("keeps only the files of the records it still holds", async () => {
    const { checkout, kept, run, write } = await job()
    expect(await run(["install"])).toEqual({ install: "ran" })
    const first = await kept()
    expect(first).toHaveLength(1)
    // Each lockfile is another record, with its own kept files; a fifth record takes the place of the first.
    for (const lock of [2, 3, 4, 5]) {
      await checkout()
      await write("lock.txt", `locked ${lock}\n`)
      expect(await run(["install"])).toEqual({ install: "ran" })
    }
    const last = await kept()
    expect(last).toHaveLength(ObservedReads.maximumRecords)
    expect(last).not.toContain(first[0])
  })

  // What a step left is put back for a target that waits for it. Where no target waits for a step, in the build
  // or in the declarations, the archive would only be carried from run to run, and what a tool wrote in its own
  // cache while the step ran is most of it.
  tracedIt("keeps nothing of a step that no target waits for, and still answers it from its record", async () => {
    // One step that leaves a file, as a test leaves a report. No target is declared after it.
    const last = await fixture({ check: "/bin/cat input.txt > report.txt" })
    const archives = async (root: string): Promise<ReadonlyArray<string>> =>
      (await Fs.readdir(Path.join(root, ".flows", "kept")).catch(() => [])).sort()
    expect(await last.run()).toEqual({ check: "ran" })
    expect(await archives(last.root)).toEqual([])
    expect(last.logs.filter((line) => line.includes("not kept") || line.includes("could not be kept"))).toEqual([])
    // Its record answers it, in a fresh checkout too, where the file it left is gone.
    await Fs.rm(Path.join(last.root, "report.txt"))
    expect(await last.run()).toEqual({ check: "hit" })
    await last.write("input.txt", "pass, changed\n")
    expect(await last.run()).toEqual({ check: "ran" })
    expect(await archives(last.root)).toEqual([])

    // A step other targets are declared after keeps what it left, also in a build that runs it alone: the build
    // of the others comes later and puts it back.
    const waited = await job()
    expect(await waited.run(["install"])).toEqual({ install: "ran" })
    expect(await waited.kept()).toHaveLength(1)
    await waited.checkout()
    await waited.ran()
    expect(await waited.run()).toEqual({ install: "hit", build: "ran", lint: "ran", test: "ran" })
    expect(await waited.ran()).toEqual(["build", "lint", "test"])
    expect(waited.logs).toContain("//:install  what it left is put back for //:build")
    // The build left a file and the lint and the test wait for it; the test left none and nothing waits for it.
    expect(await waited.kept()).toHaveLength(2)
  })

  // The fourth ship review's xid replay: the recorded run of a step failed once, the plain run passed, and for a
  // day every row of the step read as on a host that cannot record a run.
  tracedIt("says that its recorded run failed where a step another waits for runs unrecorded", async () => {
    // The install refuses to run under a recorder, as a debugger or a privileged program does.
    const refusing = "if /bin/grep -q -e '^TracerPid:[[:space:]]*[1-9]' -e '^Seccomp_filters:[[:space:]]*[1-9]' " +
      "/proc/self/status; then exit 1; fi\n" +
      "/bin/cat registry.cfg > /dev/null\n/bin/mkdir -p deps\n/bin/cat lock.txt > deps/installed.txt"
    const { logs, ran, root, run, unstored } = await job({ install: refusing })
    const before = Date.now()
    expect(await run()).toEqual(all("ran"))
    // The run that found it out says what happened to that run.
    expect(unstored["install"]).toBe("it passed, but failed while its reads were recorded")
    await ran()
    // Every run after it, for a day: the step runs with no record, and its row says why and until when.
    expect((await run())["install"]).toBe("ran")
    const reason = unstored["install"]!
    const said =
      /^its recorded run failed and its plain run passed; it runs unrecorded until (\d{4}-\d\d-\d\d) (\d\d:\d\d) UTC$/
        .exec(reason)
    expect(said, reason).not.toBeNull()
    const until = Date.parse(`${said![1]}T${said![2]}:00Z`)
    // A day after the recorded run that failed, to the minute.
    expect(until).toBeGreaterThanOrEqual(before + CacheEvidence.attemptMemoryMs - 60_000)
    expect(until).toBeLessThanOrEqual(Date.now() + CacheEvidence.attemptMemoryMs)
    expect(await ran()).toContain("install")
    expect(logs).toContain(`//:install  not cached: ${reason}`)
    // The general line is for a host that cannot record a run, and is not said here.
    expect(Object.values(unstored)).not.toContain(
      "a step after it may read what it leaves, and its reads are not recorded"
    )
    // Its plain run is its verdict: when that fails, the step fails and the steps after it do not run.
    await Fs.rm(Path.join(root, "lock.txt"))
    expect(await run()).toEqual({ install: "failed", build: "skipped", lint: "skipped", test: "skipped" })
  })

  tracedIt("is answered whole when its steps share a group of files", async () => {
    const { checkout, ran, run } = await job({ shared: true })
    expect(await run()).toEqual(all("ran"))
    await ran()
    await checkout()
    expect(await run()).toEqual(all("hit"))
    expect(await ran()).toEqual([])
  })

  posixIt("runs every step another waits for on a host that cannot observe a run", async () => {
    const { ran, run, unstored, write } = await job()
    const unobserving: ExecutionServices = {
      ...executionServicesLive,
      observer: () => ({ reason: "strace is not installed" })
    }
    expect(await run(["test"], unobserving)).toEqual(all("ran"))
    const reason = "a step after it may read what it leaves, and its reads are not recorded"
    expect(unstored).toEqual({ install: reason, build: reason, lint: reason })
    // The tree now holds what the steps left, which the last step declares with every other file.
    expect(await run(["test"], unobserving)).toEqual(all("ran"))
    // Only the last step is answered, from the files it declares.
    expect(await run(["test"], unobserving)).toEqual({ install: "ran", build: "ran", lint: "ran", test: "hit" })
    await write("docs/readme.md", "changed\n")
    await ran()
    expect(await run(["test"], unobserving)).toEqual(all("ran"))
    expect(await ran()).toEqual(["install", "build", "lint", "test"])
  })

  // `npm ci` reads an entry of its cache and writes it back at every run. A job that restores the cache from
  // another run's save puts an older entry there before each install.
  tracedIt("answers a locked install whose own cache outside the workspace holds another run's entries", async () => {
    const locked = await job({ install: "npm ci" })
    const entry = Path.join(locked.outside, "cache", "index")
    const caching = `#!/bin/sh\n/bin/cat ${entry} > /dev/null\necho fetched >> ${entry}\n` +
      "/bin/mkdir -p deps\n/bin/cat lock.txt > deps/installed.txt\n"
    await locked.write(Path.join(locked.base, "tools", "npm"), caching, 0o755)
    await locked.write(entry, "saved by another run\n")
    expect(await locked.run()).toEqual(all("ran"))
    expect(locked.unstored).toEqual({})
    // A fresh checkout, and the cache as the other run saved it.
    await locked.checkout()
    await locked.write(entry, "saved by another run\n")
    expect(await locked.run()).toEqual(all("hit"))
    // The same program asked for anything else read and changed the entry: it runs again.
    const open = await job({ install: "npm install" })
    const other = Path.join(open.outside, "cache", "index")
    await open.write(Path.join(open.base, "tools", "npm"), caching.replaceAll(entry, other), 0o755)
    await open.write(other, "saved by another run\n")
    expect(await open.run()).toEqual(all("ran"))
    await open.checkout()
    await open.write(other, "saved by another run\n")
    expect(await open.run()).toEqual({ install: "ran", build: "hit", lint: "hit", test: "hit" })
    expect(open.reasons).toEqual({ install: `${other} changed` })
  })

  tracedIt("allows the locked installer itself to connect while refusing an unlocked install", async () => {
    const server = Net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as Net.AddressInfo).port
      const fetching = `#!${process.execPath}\n` +
        "const fs = require('fs')\n" +
        `require('net').connect(${port}, '127.0.0.1').on('connect', function () {\n` +
        "  this.end()\n" +
        "  fs.mkdirSync('deps', { recursive: true })\n" +
        "  fs.writeFileSync('deps/installed.txt', fs.readFileSync('lock.txt'))\n" +
        "})\n"
      const locked = await job({ install: "npm ci" })
      await locked.write(Path.join(locked.base, "tools", "npm"), fetching, 0o755)
      expect(await locked.run()).toEqual(all("ran"))
      expect(locked.unstored).toEqual({})
      await locked.checkout()
      expect(await locked.run()).toEqual(all("hit"))

      const open = await job({ install: "npm install" })
      await open.write(Path.join(open.base, "tools", "npm"), fetching, 0o755)
      expect(await open.run()).toEqual(all("ran"))
      expect(open.unstored).toEqual({ install: `it reached a program outside the run on local port ${port}` })
      await open.checkout()
      expect(await open.run()).toEqual({ install: "ran", build: "hit", lint: "hit", test: "hit" })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  tracedIt("refuses an arbitrary program a package manager starts that connects outside the run", async () => {
    const server = Net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as Net.AddressInfo).port
      // The package manager's lockfile does not determine which service its arbitrary subprocess contacts.
      const fetching = `#!/bin/sh\n${process.execPath} -e "require('net').connect(${port}, '127.0.0.1')` +
        `.on('connect', function () { this.end() })"\n/bin/mkdir -p deps\n/bin/cat lock.txt > deps/installed.txt\n`
      for (const install of ["npm ci", "npm install"]) {
        const fixture = await job({ install })
        await fixture.write(Path.join(fixture.base, "tools", "npm"), fetching, 0o755)
        expect(await fixture.run()).toEqual(all("ran"))
        expect(fixture.unstored).toEqual({ install: `it reached a program outside the run on local port ${port}` })
        await fixture.checkout()
        expect(await fixture.run()).toEqual({ install: "ran", build: "hit", lint: "hit", test: "hit" })
      }
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
  // `cargo build` downloads the crates Cargo.lock pins. With no Cargo.lock it asks the registry which versions
  // there are and writes one: the same program, the same connection, and nothing fixed what it fetched.
  tracedIt(
    "stores a build that fetches what the lockfile it read pins, and none that writes its lockfile",
    async () => {
      const server = Net.createServer((socket) => socket.end())
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      try {
        const port = (server.address() as Net.AddressInfo).port
        // A build tool: it reads its lockfile, making one when there is none, fetches, and builds what was pinned.
        const cargo = `#!${process.execPath}\n` +
          "const fs = require('fs')\n" +
          "let lock\n" +
          "try { lock = fs.readFileSync('Cargo.lock', 'utf8') } catch { lock = 'chosen now\\n' }\n" +
          `require('net').connect(${port}, '127.0.0.1').on('connect', function () {\n` +
          "  this.end()\n" +
          "  if (!fs.existsSync('Cargo.lock')) fs.writeFileSync('Cargo.lock', lock)\n" +
          "  fs.mkdirSync('deps', { recursive: true })\n" +
          "  fs.writeFileSync('deps/installed.txt', lock)\n" +
          "})\n"
        const locked = await job({ install: "cargo build" })
        await locked.write(Path.join(locked.base, "tools", "cargo"), cargo, 0o755)
        await locked.write("Cargo.lock", "pinned 1\n")
        expect(await locked.run()).toEqual(all("ran"))
        expect(locked.unstored).toEqual({})
        await locked.checkout()
        expect(await locked.run()).toEqual(all("hit"))
        // Another lockfile is another build.
        await locked.write("Cargo.lock", "pinned 2\n")
        expect(await locked.run()).toEqual({ install: "ran", build: "ran", lint: "hit", test: "ran" })
        expect(locked.reasons["install"]).toBe("Cargo.lock changed")
        expect(locked.read("deps/built.txt")).toBe("pinned 2\nsource 1\n")
        // No lockfile: the tool chose, and wrote what it chose.
        const open = await job({ install: "cargo build" })
        await open.write(Path.join(open.base, "tools", "cargo"), cargo, 0o755)
        expect(await open.run()).toEqual(all("ran"))
        expect(open.unstored).toEqual({
          install: `it reached a program outside the run on local port ${port}`
        })
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    }
  )
  // `cargo doc` opens the repository's git store to list a package's files, at every commit, and a note of
  // the compiler it rewrites at every run. A record that held either would never answer another commit. In
  // its home it notes when each crate was last used: the step after it reads that note, never the same twice.
  tracedIt("answers a cargo step at another commit, and none of a program that reads the commit itself", async () => {
    const tool = `#!${process.execPath}\n` +
      "const fs = require('fs')\n" +
      "fs.readFileSync('.git/HEAD')\n" +
      "try { fs.readFileSync('target/.rustc_info.json') } catch {}\n" +
      "fs.mkdirSync('deps', { recursive: true })\n" +
      "fs.mkdirSync('target', { recursive: true })\n" +
      "fs.writeFileSync('target/.rustc_info.json', String(Math.random()))\n" +
      "const note = process.argv[4] + '/.global-cache'\n" +
      "try { fs.readFileSync(note) } catch {}\n" +
      "fs.writeFileSync(note, String(Math.random()))\n" +
      "fs.writeFileSync('deps/installed.txt', fs.readFileSync('lock.txt'))\n"
    const commit = (name: string) => `ref: refs/heads/${name}\n`
    const listing = await job({ install: (home) => `cargo doc --target-dir ${home}` })
    await listing.write(Path.join(listing.base, "tools", "cargo"), tool, 0o755)
    await listing.write(".git/HEAD", commit("one"))
    expect(await listing.run()).toEqual(all("ran"))
    expect(listing.unstored).toEqual({})
    await listing.checkout()
    await listing.write(".git/HEAD", commit("two"))
    expect(await listing.run()).toEqual(all("hit"))
    // `cargo package` writes the commit into what it packs: the same program, and the commit is what it read.
    const pack = async () => {
      const fixture = await job({ install: (home) => `cargo package --target-dir ${home}` })
      await fixture.write(Path.join(fixture.base, "tools", "cargo"), tool, 0o755)
      await fixture.write(".git/HEAD", commit("one"))
      expect(await fixture.run()).toEqual(all("ran"))
      await fixture.checkout()
      return fixture
    }
    const dirty = await pack()
    expect((await dirty.run())["install"]).toBe("ran")
    expect(dirty.reasons["install"]).toBe("target/.rustc_info.json changed")

    const fresh = await pack()
    await Fs.rm(Path.join(fresh.root, "target"), { recursive: true })
    await Fs.unlink(Path.join(fresh.outside, ".global-cache"))
    await fresh.write(".git/HEAD", commit("two"))
    expect((await fresh.run())["install"]).toBe("ran")
    expect(fresh.reasons["install"]).toBe(".git/HEAD changed")
  })
})

describe("a step that reaches a file by other rules than an open's", () => {
  /** Each recorder this host has: strace, and smthrs-observe where the package holds one that runs here. */
  const recorders = (): ReadonlyArray<readonly [string, ExecutionServices]> => {
    const supervisor = ObservedReads.supervisorPath(process.platform, process.arch, {
      SMTHRS_OBSERVE_WITH: "smthrs-observe"
    })
    return [
      ["strace", { ...executionServicesLive, observer: () => host }],
      ...(supervisor === undefined ? [] : [
        [
          "smthrs-observe",
          { ...executionServicesLive, observer: () => ({ tracer: supervisor, supervisor: true as const }) }
        ] as const
      ])
    ]
  }
  const probe = async (way: string) => {
    // The link to `/sub/y.txt` that `in-root-link` leaves is the step's own, not a file the check declares: a
    // declared link must lead inside the workspace by itself.
    const made = await fixture({ check: `python3 probe.py ${way}`, exclude: ["data/root/abs"] })
    await made.write("probe.py", KernelProbe.program)
    for (const [path, text] of KernelProbe.files) {
      if (!text.startsWith("-> ")) await made.write(path, text)
      else {
        await Fs.mkdir(Path.dirname(Path.join(made.root, path)), { recursive: true })
        await Fs.symlink(text.slice(3), Path.join(made.root, path))
      }
    }
    const change = async (): Promise<void> => {
      const [path, text] = KernelProbe.ways[way]!.change
      if (text === undefined) await Fs.rm(Path.join(made.root, path))
      else await made.write(path, text)
    }
    return { ...made, change }
  }

  // openat2 with RESOLVE_IN_ROOT is how filepath-securejoin and libpathrs (runc, containerd, podman) open a file
  // inside a container's root. smthrs-observe wrote `/x.txt` for data/root's `/x.txt`, the machine's root, and the
  // reader of strace's line did too; a RENAME_EXCHANGE was read as a move, so the name moved onto counted as the
  // run's own. Each step was answered from the cache at the commit that changed what it read.
  tracedIt.each([
    "in-root",
    "in-root-up",
    "in-root-made-link",
    "in-root-link",
    "beneath",
    "no-symlinks",
    "exchange",
    "no-replace"
  ])("%s: is reused while what it read holds, and runs again when that changes", async (way) => {
    for (const [recorder, services] of recorders()) {
      const { change, logs, reasons, root, run } = await probe(way)
      const refused = () => logs.filter((line) => line.includes("not cached"))
      expect([recorder, await run(["check"], services), refused()]).toEqual([recorder, { check: "ran" }, []])
      if (way === "exchange") {
        // RENAME_EXCHANGE modifies data/ya.txt in place without a prior record; the second run measures it before starting.
        expect([recorder, await run(["check"], services)]).toEqual([recorder, { check: "ran" }])
      }
      if (way === "in-root-made-link") {
        expect([recorder, await run(["check"], services)]).toEqual([recorder, { check: "ran" }])
        expect(reasons).toEqual(["data/root/abs changed"])
        await Fs.unlink(Path.join(root, "data/root/abs"))
      }
      expect([recorder, await run(["check"], services)]).toEqual([recorder, { check: "hit" }])
      await change()
      expect([recorder, await run(["check"], services)]).toEqual([recorder, { check: "failed" }])
    }
  }, 120_000)

  tracedIt("stores nothing, and says why, when it swaps two directories", async () => {
    for (const [recorder, services] of recorders()) {
      const { change, logs, run } = await probe("exchange-directories")
      expect([recorder, await run(["check"], services)]).toEqual([recorder, { check: "ran" }])
      expect(logs).toContain(
        `//:check  not cached: ${ObservedReads.cannotFollow("renameat2 with RENAME_EXCHANGE of a directory")}`
      )
      expect([recorder, await run(["check"], services)]).toEqual([recorder, { check: "ran" }])
      await change()
      expect([recorder, await run(["check"], services)]).toEqual([recorder, { check: "failed" }])
    }
  }, 120_000)
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

  /**
   * A tracer that writes, after the command, a trace of `count` missing paths, each of `parts` names of `digits`
   * digits.
   */
  const flood = (count: number, digits: number, parts = 1): string => {
    const name = Array.from({ length: parts }, () => `%0${digits}d`).join("/")
    const values = Array.from({ length: parts }, () => "i").join(", ")
    return "\"$@\" || exit $?\n" +
      `awk 'BEGIN { for (i = 0; i < ${count}; i++) printf "1 access(\\"/nonexistent-smithers-observed/${name}\\", ` +
      `F_OK) = -1 ENOENT (No such file or directory)\\n", ${values} }' > "$out"`
  }

  // eliza's `turbo run build` reads 168,803 paths. 170,000 paths are over 500,000 members in one JSON value, more
  // than one cache entry holds: the record is kept in the content store and the entry names it.
  posixIt("stores and reuses a run that read 170,000 paths", async () => {
    const { logs, run, tracer } = await fixture()
    const flooding = await tracer(flood(170000, 8))
    expect(await run(["check"], flooding)).toEqual({ check: "ran" })
    expect(logs.filter((line) => line.includes("not cached") || line.includes("could not store"))).toEqual([])
    expect(await run(["check"], flooding)).toEqual({ check: "hit" })
  })

  // The cache's entries carried to another place without the content store beside them, as a workflow that saves
  // only the entries would: the entry is looked up and its record is not there.
  posixIt("runs and says why when its record is not in the content store, then is answered again", async () => {
    const { logs, root, run, tracer } = await fixture()
    const flooding = await tracer(flood(10, 8))
    expect(await run(["check"], flooding)).toEqual({ check: "ran" })
    expect(await run(["check"], flooding)).toEqual({ check: "hit" })
    await Fs.rm(Path.join(root, ".flows", "cas"), { recursive: true })
    expect(await run(["check"], flooding)).toEqual({ check: "ran" })
    expect(logs).toContain(
      "//:check  runs again: its record of what it read is not in the cache's content store, the cas directory beside " +
        "the cache's entries"
    )
    expect(await run(["check"], flooding)).toEqual({ check: "hit" })
  })

  posixIt("stores nothing when the run read more paths than a record holds, and says how many", async () => {
    const { logs, run, tracer } = await fixture()
    const flooding = await tracer(flood(400_001, 1))
    expect(await run(["check"], flooding)).toEqual({ check: "ran" })
    expect(logs).toContain("//:check  not cached: it read 400,001 paths, more than the 400,000 one record holds")
    expect(logs.filter((line) => line.includes("could not store"))).toEqual([])
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
