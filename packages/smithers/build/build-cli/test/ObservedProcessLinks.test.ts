/**
 * A path through a link the kernel makes for a process is recorded as the
 * file it leads to.
 *
 * `/proc/self/cwd/x`, `/proc/self/root/<workspace>/x` and `/proc/self/fd/3/x`
 * name a file of the workspace as surely as `x` does. The fifth ship review's
 * blocker 3: both recorders left every path under `/proc`, `/dev` and `/sys`
 * out of the record, so a step that read a repository file that way was
 * answered from the cache after the file changed.
 *
 * Each case runs a real command under each recorder this host has, on real
 * files, reads its trace as a build does, then changes the file the command
 * read, keeping its size and its name, and asks whether the record still
 * holds.
 */
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const host = ExecSandbox.host()

/** Each recorder this host has: `smthrs-observe` where it runs, and strace. */
const recorders = [
  [
    "smthrs-observe",
    ObservedReads.observer({
      ...host,
      supervisor: ObservedReads.supervisorPath(process.platform, process.arch, {
        SMTHRS_OBSERVE_WITH: "smthrs-observe"
      })
    })
  ],
  ["strace", ObservedReads.observer({ ...host, supervisor: undefined })]
] as const

const python = spawnSync("python3", ["--version"]).status === 0

/** A workspace with `data/x` holding `ok`, and the record of `script` run in it under `recorder`. */
const recorded = async (recorder: ObservedReads.Observer, script: string) => {
  if ("reason" in recorder) throw new Error(recorder.reason)
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-process-links-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  await Fs.mkdir(Path.join(root, "data"), { recursive: true })
  await Fs.writeFile(Path.join(root, "data", "x"), "ok\n")
  await Fs.writeFile(Path.join(root, "data", "y"), "ok\n")
  // The run begins a tick of the file system's clock after the files were written, as a step begins after checkout.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const trace = Path.join(base, "trace")
  await Fs.writeFile(trace, "")
  const startedMs = NodeFs.statSync(trace).ctimeMs
  const argv = ObservedReads.commandFor(recorder, trace, ["/bin/bash", "-c", script])
  const run = spawnSync(argv[0]!, argv.slice(1), { cwd: root, encoding: "utf8", timeout: 60_000 })
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
  const observation = ObservedReads.observe(ObservedReads.read(ObservedReads.linesOf(trace), root), {
    root,
    ignore: [],
    startedMs
  })
  return { root, observation }
}

/** Why the record says the run would read something else now: after `data/x` changed, keeping its size. */
const afterChange = async (root: string, record: ObservedReads.Record): Promise<string | undefined> => {
  await Fs.writeFile(Path.join(root, "data", "x"), "no\n")
  return ObservedReads.changed(record, root)
}

/** The reads of a record, by path. */
const readsOf = (record: ObservedReads.Record): ReadonlyArray<string> => record.reads.map(([path]) => path)

/** Each way a command reaches `data/x` through a link of a process; every one fails before the rule. */
const cases: ReadonlyArray<readonly [name: string, script: string, needsPython: boolean]> = [
  ["a directory descriptor of the shell", "exec 3<data; grep -qx ok /proc/self/fd/3/x", false],
  ["the root of the process", "grep -qx ok \"/proc/self/root$PWD/data/x\"", false],
  ["the working directory of the process", "grep -qx ok /proc/self/cwd/data/x", false],
  ["the working directory of the thread", "grep -qx ok /proc/thread-self/cwd/data/x", false],
  ["/dev/fd of a directory descriptor", "exec 4<data; grep -qx ok /dev/fd/4/x", false],
  ["a `..` right after the link", "grep -qx ok /proc/self/cwd/data/../data/x", false],
  [
    "the working directory of another process of the run",
    "cd data; sleep 30 & cd ..; grep -qx ok /proc/$!/cwd/x; kill $!",
    false
  ],
  [
    "a descriptor of /proc/self used as the base of openat",
    "python3 -c 'import os; d = os.open(\"/proc/self\", os.O_RDONLY); f = os.open(\"cwd/data/x\", os.O_RDONLY, dir_fd=d); assert os.read(f, 3) == b\"ok\\n\"'",
    true
  ]
]

for (const [name, recorder] of recorders) {
  describe.skipIf("reason" in recorder)(`a run recorded with ${name}`, () => {
    for (const [what, script, needsPython] of cases) {
      it.skipIf(needsPython && !python)(`records the file it reached through ${what}`, async () => {
        const { observation, root } = await recorded(recorder, script)
        expect("refusal" in observation ? observation.refusal : undefined).toBeUndefined()
        if ("refusal" in observation) return
        expect(readsOf(observation.record)).toContain("data/x")
        expect(await afterChange(root, observation.record)).toBe("data/x changed")
      })
    }

    it.skipIf(!python)("records the file it reached through a descriptor passed over a socket", async () => {
      // A child opens the directory and passes the descriptor; the parent reads below it through /proc/self/fd.
      const script = [
        "python3 -c '",
        "import os, socket",
        "a, b = socket.socketpair()",
        "if os.fork() == 0:",
        "    d = os.open(\"data\", os.O_RDONLY)",
        "    socket.send_fds(a, [b\"d\"], [d])",
        "    os._exit(0)",
        "os.wait()",
        "_, fds, _, _ = socket.recv_fds(b, 1, 1)",
        "f = os.open(\"/proc/self/fd/%d/x\" % fds[0], os.O_RDONLY)",
        "assert os.read(f, 3) == b\"ok\\n\"",
        "'"
      ].join("\n")
      const { observation, root } = await recorded(recorder, script)
      if (name === "smthrs-observe") {
        // The descriptor is read where the call stops, so the record names the file.
        expect("refusal" in observation ? observation.refusal : undefined).toBeUndefined()
        if ("refusal" in observation) return
        expect(readsOf(observation.record)).toContain("data/x")
        expect(await afterChange(root, observation.record)).toBe("data/x changed")
      } else {
        // strace shows no call that receives a descriptor, so the run stores nothing rather than less.
        expect(observation).toMatchObject({
          refusal: expect.stringMatching(/^its trace does not say where \/proc\/self\/fd\/\d+\/x led$/)
        })
      }
    })

    it("leaves out what the machine is: a read under /proc, /sys or /dev that leads to no file of the run", async () => {
      const { observation } = await recorded(
        recorder,
        "cat /proc/cpuinfo /proc/self/status > /dev/null; ls /proc/self/fd > /dev/null; echo ok | grep -q ok /dev/stdin; " +
          "test -r /sys/kernel; cat /proc/self/cwd/data/y > /dev/null"
      )
      expect("refusal" in observation ? observation.refusal : undefined).toBeUndefined()
      if ("refusal" in observation) return
      const reads = readsOf(observation.record)
      expect(reads).toContain("data/y")
      expect(reads.filter((path) => /^\/(?:proc|sys|dev)(?:\/|$)/.test(path))).toEqual([])
    })

    it("stores nothing when a path goes back up inside /proc before its link", async () => {
      const { observation } = await recorded(recorder, "grep -qx ok /proc/self/../self/cwd/data/x")
      expect(observation).toMatchObject({ refusal: expect.stringContaining("goes back up inside /proc or /dev") })
    })

    it("stores nothing when a link of the workspace leads into a process's own links", async () => {
      for (
        const script of [
          "ln -s /proc/self/cwd here; grep -qx ok here/data/x",
          "ln -s /proc/self/root here; grep -qx ok \"here$PWD/data/x\"",
          "exec 3<data; ln -s /dev/fd/3 here; grep -qx ok here/x",
          "ln -s /proc/self/../self/cwd here; grep -qx ok here/data/x"
        ]
      ) {
        const { observation } = await recorded(recorder, script)
        expect(observation, script).toMatchObject({
          refusal: expect.stringContaining("leads through a link of a process")
        })
      }
    })

    it("adds nothing for a link of the workspace to a descriptor or a program alone", async () => {
      const { observation } = await recorded(
        recorder,
        "ln -s /proc/self/exe me; test -e me; exec 3<data/y; ln -s /dev/fd/3 y; grep -qx ok y"
      )
      expect("refusal" in observation ? observation.refusal : undefined).toBeUndefined()
      if ("refusal" in observation) return
      const reads = readsOf(observation.record)
      expect(reads).toContain("data/y")
      // Never the program that read the trace: the link leads where it led for the run's process.
      expect(reads.filter((path) => /^\/(?:proc|dev)\//.test(path) || path === process.execPath)).toEqual([])
    })
  })
}

/** strace's lines, read as a build reads them. */
const traced = (lines: ReadonlyArray<string>, cwd = "/w"): ObservedReads.Trace => ObservedReads.read(() => lines, cwd)

const pathsOf = (map: ReadonlyMap<string, number>): ReadonlyArray<string> => [...map.keys()].sort()

describe("strace's lines through a link of a process", () => {
  it("follow root and cwd from what the trace says, in the view of the process that named them", () => {
    const trace = traced([
      "100 execve(\"/bin/sh\", [\"sh\"], 0x1 /* 1 vars */) = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/proc/self/cwd/a\", {...}, 0) = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/proc/self/root/etc/b\", {...}, 0) = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/proc/thread-self/cwd/../up\", {...}, 0) = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/proc/self/cwd\", {...}, 0) = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/proc/100/task/100/root\", {...}, 0) = 0",
      "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 101",
      "101 chdir(\"/w/sub\") = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/proc/101/cwd/c\", {...}, 0) = 0",
      "101 newfstatat(AT_FDCWD</w/sub>, \"/proc/100/cwd/d\", {...}, 0) = -1 ENOENT (No such file or directory)",
      "100 clone(child_stack=0x1, flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD) = 102",
      "102 newfstatat(AT_FDCWD</w>, \"/proc/self/cwd/e\", {...}, 0) = 0",
      "100 openat(3</proc/101>, \"cwd/f\", O_RDONLY) = 4</w/sub/f>",
      "100 newfstatat(AT_FDCWD</w>, \"/proc/cpuinfo\", {...}, 0) = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/proc/self/status\", {...}, 0) = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/proc/self/exe\", {...}, 0) = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/proc/self/task/x/cwd\", {...}, 0) = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/dev/null\", {...}, 0) = 0",
      "100 newfstatat(AT_FDCWD</w>, \"/dev/fd/x\", {...}, 0) = 0"
    ])
    expect(trace.refusals).toEqual([])
    expect(pathsOf(trace.found)).toEqual([
      "/",
      "/bin/sh",
      "/dev/fd/x",
      "/dev/null",
      "/etc/b",
      "/proc/cpuinfo",
      "/proc/self/exe",
      "/proc/self/status",
      "/proc/self/task/x/cwd",
      "/up",
      "/w",
      "/w/a",
      "/w/e",
      "/w/sub",
      "/w/sub/c",
      "/w/sub/f"
    ])
    expect(pathsOf(trace.missing)).toEqual(["/w/d"])
    expect(trace.reached).toBeUndefined()
  })

  it("follow a descriptor where the call opened a file and its answer names it", () => {
    const trace = traced([
      "100 openat(AT_FDCWD</w>, \"data\", O_RDONLY) = 3</w/data>",
      "100 dup2(3</w/data>, 5) = 5</w/data>",
      "100 openat(AT_FDCWD</w>, \"/proc/self/fd/3/x\", O_RDONLY) = 4</w/data/x>",
      "100 openat(AT_FDCWD</w>, \"/dev/fd/5/y\", O_RDONLY) = 4</w/data/y>",
      "100 openat(AT_FDCWD</w>, \"/dev/stdin\", O_RDONLY) = 4</w/in>",
      "100 openat(AT_FDCWD</w>, \"/dev/stdout\", O_RDONLY) = 4<pipe:[9]>",
      "100 clone(child_stack=NULL, flags=SIGCHLD) = 101",
      "101 openat(AT_FDCWD</w>, \"/proc/self/fd/3/z\", O_RDONLY) = 6</w/data/z>"
    ])
    expect(trace.refusals).toEqual([])
    // A descriptor alone is a file the run opened where the trace shows it, or no file: it stays as the run named it.
    expect(pathsOf(trace.found)).toEqual([
      "/dev/stdin",
      "/dev/stdout",
      "/w/data",
      "/w/data/x",
      "/w/data/y",
      "/w/data/z"
    ])
    expect(trace.reached).toEqual([
      ["/proc/self/fd/3/x", "/w/data/x", "/w/data/x"],
      ["/dev/fd/5/y", "/w/data/y", "/w/data/y"],
      ["/proc/self/fd/3/z", "/w/data/z", "/w/data/z"]
    ])
  })

  const refusal = (line: string, before: ReadonlyArray<string> = []): ReadonlyArray<string> =>
    traced(["100 execve(\"/bin/sh\", [\"sh\"], 0x1 /* 1 vars */) = 0", ...before, line]).refusals

  it("store nothing where the trace does not say where the link led", () => {
    expect(refusal("100 newfstatat(AT_FDCWD</w>, \"/proc/self/fd/3/x\", {...}, 0) = 0")).toEqual([
      "its trace does not say where /proc/self/fd/3/x led"
    ])
    expect(refusal("100 openat(AT_FDCWD</w>, \"/proc/self/fd/7/x\", O_RDONLY) = 4</w/x>")).toEqual([
      "its trace does not say where /proc/self/fd/7/x led"
    ])
    expect(
      refusal("100 openat(AT_FDCWD</w>, \"/proc/self/fd/3/x\", O_RDONLY) = 4</w/x>", [
        "100 openat(AT_FDCWD</w>, \"/w/p\", O_RDONLY) = 3<pipe:[1]>"
      ])
    ).toEqual(["its trace does not say where /proc/self/fd/3/x led"])
    expect(
      refusal("100 openat(AT_FDCWD</w>, \"/proc/self/fd/3/x\", O_RDONLY) = 4</w/x>", [
        "100 openat(AT_FDCWD</w>, \"/w/gone\", O_RDONLY) = 3</w/gone (deleted)>"
      ])
    ).toEqual(["its trace does not say where /proc/self/fd/3/x led"])
    // The process's directory is not known: a process the trace saw start, never told where it is.
    expect(
      traced([
        "100 execve(\"/bin/sh\", [\"sh\"], 0x1 /* 1 vars */) = 0",
        "100 clone(child_stack=NULL, flags=SIGCHLD) = 101",
        "102 newfstatat(AT_FDCWD</w>, \"/proc/self/cwd/x\", {...}, 0) = 0"
      ]).refusals
    ).toEqual([])
    expect(refusal("100 newfstatat(AT_FDCWD</w>, \"/proc/1/cwd/x\", {...}, 0) = 0")).toEqual([
      "it named /proc/1/cwd/x, a file of a process outside the run"
    ])
  })

  it("store nothing for a path that goes back up before its link", () => {
    for (
      const path of [
        "/proc/self/../1/cwd/x",
        "/proc/../self/cwd",
        "/dev/../proc/self/cwd",
        "/dev/fd/..",
        "/proc/self/task/../cwd",
        "/proc/self/fd/.."
      ]
    ) {
      expect(refusal(`100 newfstatat(AT_FDCWD</w>, "${path}", {...}, 0) = 0`)).toEqual([
        `it named ${path}, which goes back up inside /proc or /dev and cannot be followed as it ran`
      ])
    }
  })

  it("store nothing for a path that loops through the links of a process", () => {
    const loop = `/proc/self/cwd${"/cwd".repeat(50)}`
    expect(refusal(`100 newfstatat(AT_FDCWD</proc/100>, "${loop}", {...}, 0) = 0`, [
      "100 chdir(\"/proc/100\") = 0"
    ])).toEqual([`${loop} passes through too many links`])
  })

  it("are read as written in a trace smthrs-observe wrote, which followed each link at the call", () => {
    const trace = traced([
      "100 +++ smthrs-observe 1 +++",
      "100 newfstatat(AT_FDCWD, \"/proc/self/fd/1\", {...}, 0) = 0",
      "100 +++ complete +++"
    ])
    expect(trace.refusals).toEqual([])
    expect(pathsOf(trace.found)).toEqual(["/proc/self/fd/1"])
  })
})

describe.skipIf(process.platform !== "linux")("a record of a path below a descriptor", () => {
  it("stores nothing when the file the trace placed it at is not the file the call opened", async () => {
    const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-process-links-")))
    temporary.push(base)
    await Fs.mkdir(Path.join(base, "data"))
    await Fs.writeFile(Path.join(base, "data", "x"), "ok\n")
    await Fs.symlink("/sys/class/net", Path.join(base, "net"))
    const observed = (lines: ReadonlyArray<string>) =>
      ObservedReads.observe(traced(lines, base), { root: base, ignore: [], startedMs: Date.now() + 60_000 })
    // The descriptor's number was used again by a call no trace shows: the trace last saw it name another file.
    expect(observed([
      `100 openat(AT_FDCWD<${base}>, "${base}/other", O_RDONLY) = 3<${base}/other>`,
      `100 openat(AT_FDCWD<${base}>, "/proc/self/fd/3/x", O_RDONLY) = 4<${base}/data/x>`,
      `100 openat(AT_FDCWD<${base}>, "/proc/self/fd/3/y", O_RDONLY) = 4<${base}/data/y>`
    ])).toEqual({ refusal: "its trace does not say where /proc/self/fd/3/x led" })
    // Where it last saw it name the directory, the file below is the one the call opened.
    const right = observed([
      `100 openat(AT_FDCWD<${base}>, "data", O_RDONLY) = 3<${base}/data>`,
      `100 openat(AT_FDCWD<${base}>, "/proc/self/fd/3/x", O_RDONLY) = 4<${base}/data/x>`,
      `100 newfstatat(AT_FDCWD<${base}>, "net/lo/address", {...}, 0) = 0`
    ])
    expect("refusal" in right ? right.refusal : undefined).toBeUndefined()
    if (!("refusal" in right)) expect(readsOf(right.record)).toEqual(expect.arrayContaining(["data/x", "net"]))
  })
})
