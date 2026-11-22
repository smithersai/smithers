/**
 * What a run read: the trace reader, the record it becomes, and the check
 * that answers whether the run would read the same again.
 *
 * The trace lines are the tracer's own output format, as `strace -f -y`
 * printed it for real commands. Records are measured on real directories.
 * `ObservedReadsExecution.test.ts` runs the real tracer end to end.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as RecordStore from "../src/internal/RecordStore.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const directory = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-observed-reads-")))
  temporary.push(root)
  return root
}

const read = (text: string, cwd = "/w"): ObservedReads.Trace => ObservedReads.read(() => text.split("\n"), cwd)

const paths = (map: ReadonlyMap<string, number>): ReadonlyArray<string> => [...map.keys()].sort()

/** Stores records in a content store of a new directory and reads them back, as a build does. */
const roundTrip = async (stored: ObservedReads.Stored | undefined): Promise<ReadonlyArray<ObservedReads.Record>> => {
  const cas = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-records-"))
  try {
    return await RecordStore.load(cas, await RecordStore.save(cas, stored!))
  } finally {
    await Fs.rm(cas, { recursive: true, force: true })
  }
}

/** A record as it comes back: its paths sorted. */
const inStoredOrder = (record: ObservedReads.Record): ObservedReads.Record => {
  const byPath = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): number =>
    (a[0] as string) < (b[0] as string) ? -1 : (a[0] as string) > (b[0] as string) ? 1 : 0
  return {
    ...record,
    reads: [...record.reads].sort(byPath),
    lists: [...record.lists].sort(byPath),
    ...(record.given === undefined ? {} : { given: [...record.given].sort(byPath) })
  }
}

describe("the tracer command", () => {
  it("runs the command under the tracer and names the trace file", () => {
    const argv = ObservedReads.command("/usr/bin/strace", "/tmp/t.trace", ["/bin/sh", "-c", "true"])
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(argv.slice(3)).toEqual(["smthrs-observe", "/usr/bin/strace", "/tmp/t.trace", "end", "/bin/sh", "-c", "true"])
    // A step of a job that keeps what it leaves running: the tracer follows it after the step has ended.
    expect(ObservedReads.command("/usr/bin/strace", "/tmp/t.trace", ["true"], true).slice(3, 7)).toEqual([
      "smthrs-observe",
      "/usr/bin/strace",
      "/tmp/t.trace",
      "keep"
    ])
    expect(ObservedReads.commandFor({ tracer: "/o", supervisor: true }, "/tmp/t.trace", ["true"], true)).toEqual([
      "/o",
      "--keep",
      "/tmp/t.trace",
      "--",
      "true"
    ])
    const script = argv[2]!
    expect(script).toContain("'-f'")
    expect(script).toContain("'--seccomp-bpf'")
    expect(script).toContain("'inject=io_uring_setup:error=ENOSYS'")
    expect(script).toContain("'inject=pidfd_open:error=ENOSYS'")
    expect(script).toContain("getdents64")
    expect(script).toContain("-o \"$out\" --")
  })

  const tracing = async (body: string): Promise<{ readonly tracer: string; readonly trace: string }> => {
    const root = await directory()
    const tracer = Path.join(root, "tracer")
    // Stands where the tracer does: drops the tracer's own flags and runs `body` with the command in `"$@"`.
    await Fs.writeFile(tracer, `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\n${body}\n`, { mode: 0o755 })
    return { tracer, trace: Path.join(root, "trace") }
  }
  const run = (argv: ReadonlyArray<string>) =>
    spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 110_000 })

  it.skipIf(process.platform === "win32")("exits as the command exits and leaves no status file", async () => {
    const { trace, tracer } = await tracing("exec \"$@\"")
    const passed = run(ObservedReads.command(tracer, trace, ["/bin/sh", "-c", "echo out; echo err >&2"]))
    expect([passed.status, passed.stdout, passed.stderr]).toEqual([0, "out\n", "err\n"])
    expect(run(ObservedReads.command(tracer, trace, ["/bin/sh", "-c", "exit 7"])).status).toBe(7)
    expect(NodeFs.existsSync(`${trace}.status`)).toBe(false)
  })

  it.skipIf(process.platform === "win32")("exits as the tracer exits when the command never ran", async () => {
    const { trace, tracer } = await tracing("exit 9")
    expect(run(ObservedReads.command(tracer, trace, ["/bin/sh", "-c", "exit 0"])).status).toBe(9)
    expect(run(ObservedReads.command(Path.join(tracer, "missing"), trace, ["/bin/sh", "-c", "exit 0"])).status)
      .toBe(127)
  })

  it.skipIf(process.platform === "win32")("ends when the command ends, even while the tracer goes on", async () => {
    // A tracer that outlives the command, as one does while a process the command left is still running.
    const { trace, tracer } = await tracing("\"$@\"\nexec sleep 600")
    const started = Date.now()
    expect(run(ObservedReads.command(tracer, trace, ["/bin/sh", "-c", "exit 4"])).status).toBe(4)
    expect(Date.now() - started).toBeLessThan(120_000)
    expect(NodeFs.existsSync(`${trace}.status`)).toBe(false)
    // A tracer that had to be stopped may have lost its last lines, so its trace stores nothing.
    const cut = ObservedReads.read(ObservedReads.linesOf(trace), "/w")
    expect(cut.refusals).toContain(
      "its trace holds a line that cannot be read: the tracer was stopped before it wrote its last lines"
    )
  })
})

describe("finding the tracer", () => {
  const program = async (body: string): Promise<string> => {
    const file = Path.join(await directory(), "strace")
    await Fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }

  it("says why a host that is not Linux cannot observe", () => {
    expect(ObservedReads.observer({ platform: "darwin", executable: () => "/usr/bin/strace" }))
      .toEqual({ reason: "reads cannot be observed on darwin" })
  })

  it("says the tracer is missing", () => {
    expect(ObservedReads.observer({ platform: "linux", executable: () => undefined }))
      .toEqual({ reason: "strace is not installed" })
  })

  it.skipIf(process.platform === "win32")("answers with a tracer that traces a process", async () => {
    const tracer = await program("exit 0")
    expect(ObservedReads.observer({ platform: "linux", executable: () => tracer, guard: undefined })).toEqual({
      tracer
    })
  })

  it.skipIf(process.platform === "win32")("runs strace's command through the guard, which must work too", async () => {
    // Stands where strace does: runs what follows `--`.
    const tracer = await program(
      "[ \"$1\" = -V ] && exit 0\nwhile [ \"$1\" != \"--\" ]; do shift; done\nshift\nexec \"$@\""
    )
    const guard = await program("[ \"$1 $2\" = \"--guard --\" ] || exit 9\nshift 2\nexec \"$@\"")
    expect(ObservedReads.observer({ platform: "linux", executable: () => tracer, guard })).toEqual({ tracer, guard })
    expect(ObservedReads.commandFor({ tracer, guard }, "/t/trace", ["true"]))
      .toEqual(ObservedReads.command(tracer, "/t/trace", [guard, "--guard", "--", "true"]))
    // A step of a job that keeps what it leaves running runs without it.
    expect(ObservedReads.commandFor({ tracer, guard }, "/t/trace", ["true"], true))
      .toEqual(ObservedReads.command(tracer, "/t/trace", ["true"], true))
    const refusing = await program("echo 'smthrs-observe: this machine refuses the filter' >&2\nexit 126")
    expect(ObservedReads.observer({ platform: "linux", executable: () => tracer, guard: refusing })).toEqual({
      reason:
        "strace cannot see every call here without smthrs-observe --guard: smthrs-observe: this machine refuses the filter"
    })
    // Unless given, the guard is the smthrs-observe this package holds, whichever recorder is asked for.
    const held = ObservedReads.supervisorPath(process.platform, process.arch, { SMTHRS_OBSERVE_WITH: "smthrs-observe" })
    expect(ObservedReads.observer({ platform: "linux", executable: () => tracer }))
      .toEqual(held === undefined ? { tracer } : { tracer, guard: held })
  })

  it.skipIf(process.platform === "win32")("repeats what a tracer that cannot trace said", async () => {
    const forbidden = await program("echo 'strace: ptrace(PTRACE_SEIZE): Operation not permitted' >&2; exit 1")
    expect(ObservedReads.observer({ platform: "linux", executable: () => forbidden })).toEqual({
      reason: "strace cannot trace a process on this host: strace: ptrace(PTRACE_SEIZE): Operation not permitted"
    })
    const silent = await program("exit 1")
    expect(ObservedReads.observer({ platform: "linux", executable: () => silent }))
      .toEqual({ reason: "strace cannot trace a process on this host" })
    expect(ObservedReads.observer({ platform: "linux", executable: () => Path.join(silent, "not-a-program") }))
      .toEqual({ reason: "strace cannot trace a process on this host" })
  })
})

describe("the program a step runs under where nothing keeps what it leaves running", () => {
  it.skipIf(process.platform === "win32")("is smthrs-observe where it answers --reap, asked once", async () => {
    const root = await directory()
    const asked = Path.join(root, "asked")
    const answering = Path.join(root, "answering")
    await Fs.writeFile(
      answering,
      `#!/bin/sh\necho "$*" >> '${asked}'\n[ "$1" = --probe ] && [ "$2" = --reap ] && exit 0\nexit 125\n`,
      { mode: 0o755 }
    )
    // One built before it could reap refuses `--probe --reap` with its usage line, though it would record a command
    // into a file named `--reap` when asked `--reap -- true`.
    const older = Path.join(root, "older")
    await Fs.writeFile(
      older,
      "#!/bin/sh\n[ \"$2\" = -- ] && exec \"$3\"\necho 'usage: smthrs-observe <trace file> -- <command>' >&2\nexit 125\n",
      { mode: 0o755 }
    )
    expect(ObservedReads.reaperPath(answering)).toBe(answering)
    expect(ObservedReads.reaperPath(answering)).toBe(answering)
    expect(NodeFs.readFileSync(asked, "utf8")).toBe("--probe --reap\n")
    expect(ObservedReads.reaperPath(older)).toBeUndefined()
    expect(ObservedReads.reaperPath(Path.join(root, "none"))).toBeUndefined()
    expect(ObservedReads.reaped(["sh", "-c", "exit 0"], answering)).toEqual([
      answering,
      "--reap",
      "--",
      "sh",
      "-c",
      "exit 0"
    ])
    expect(ObservedReads.reaped(["sh", "-c", "exit 0"], undefined)).toEqual(["sh", "-c", "exit 0"])
  })

  it("is the one this package built for the host, whether or not it records", () => {
    const built = ObservedReads.supervisorPath(process.platform, process.arch, {})
    expect(ObservedReads.reaperPath()).toBe(built === undefined ? undefined : ObservedReads.reaperPath(built))
  })
})

describe("picking the recorder", () => {
  const built = Path.resolve(import.meta.dirname, "..", "native", "out", `linux-${process.arch}`, "smthrs-observe")
  const asked = { SMTHRS_OBSERVE_WITH: "smthrs-observe" }

  it("runs a command under smthrs-observe or under strace", () => {
    expect(
      ObservedReads.commandFor({ tracer: "/x/smthrs-observe", supervisor: true }, "/t/trace", ["sh", "-c", "true"])
    )
      .toEqual(["/x/smthrs-observe", "/t/trace", "--", "sh", "-c", "true"])
    expect(ObservedReads.commandFor({ tracer: "/usr/bin/strace" }, "/t/trace", ["true"]))
      .toEqual(ObservedReads.command("/usr/bin/strace", "/t/trace", ["true"]))
  })

  it("finds smthrs-observe only on Linux, for x86_64 and aarch64 unless strace is asked for", () => {
    expect(ObservedReads.supervisorPath("darwin", "arm64", asked)).toBeUndefined()
    expect(ObservedReads.supervisorPath("linux", "ia32", asked)).toBeUndefined()
    expect(ObservedReads.supervisorPath("linux", "x64", { SMTHRS_OBSERVE_WITH: "strace" })).toBeUndefined()
    expect(ObservedReads.supervisorPath("linux", "arm64", { SMTHRS_OBSERVE_WITH: "strace" })).toBeUndefined()
  })

  const builtArm64 = Path.resolve(import.meta.dirname, "..", "native", "out", "linux-arm64", "smthrs-observe")
  it.skipIf(!NodeFs.existsSync(builtArm64))(
    "records with the one this package built on aarch64 when no recorder is asked for",
    () => {
      expect(ObservedReads.supervisorPath("linux", "arm64", {})).toBe(builtArm64)
    }
  )

  it.skipIf(process.platform !== "linux" || !NodeFs.existsSync(built))("finds the one this package built", () => {
    expect(ObservedReads.supervisorPath("linux", process.arch, asked)).toBe(built)
    expect(ObservedReads.observer({ platform: "linux", executable: () => undefined, supervisor: built }))
      .toEqual({ tracer: built, supervisor: true })
    // Another recorder is another tool: a key names the program's digest.
    const named = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `const m = await import(${
        JSON.stringify(Path.resolve(import.meta.dirname, "..", "src", "internal", "ObservedReads.ts"))
      }); console.log(m.recorder(), m.recorderKey().recorder)`
    ], { encoding: "utf8", env: { ...process.env, ...asked } })
    expect(named.stdout.trim()).toMatch(/^smthrs-observe:[0-9a-f]{64} smthrs-observe:[0-9a-f]{64}$/)
    // This process records with what the program picks here: on x86_64 the one built, unless strace is asked for.
    const here = ObservedReads.supervisorPath()
    const used = here === undefined
      ? "strace"
      : `smthrs-observe:${createHash("sha256").update(NodeFs.readFileSync(here)).digest("hex")}`
    expect([ObservedReads.recorder(), ObservedReads.recorderKey()])
      .toEqual([used, here === undefined ? {} : { recorder: used }])
  })

  it.skipIf(process.platform !== "linux" || process.arch !== "x64" || !NodeFs.existsSync(built))(
    "records with the one this package built on x86_64 when no recorder is asked for",
    () => {
      expect(ObservedReads.supervisorPath("linux", "x64", {})).toBe(built)
    }
  )

  it.skipIf(process.platform === "win32")(
    "records with strace where smthrs-observe was built before it could keep a program a step leaves",
    async () => {
      const root = await directory()
      // As such a build answers: `--probe` alone, and a usage error for `--probe --keep`.
      const older = Path.join(root, "smthrs-observe")
      await Fs.writeFile(
        older,
        "#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --probe ] && exit 0\necho 'usage: smthrs-observe <trace file> -- <command>' >&2\nexit 125\n",
        { mode: 0o755 }
      )
      const tracer = Path.join(root, "strace")
      await Fs.writeFile(tracer, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      expect(
        ObservedReads.observer({ platform: "linux", executable: () => tracer, supervisor: older, guard: undefined })
      )
        .toEqual({
          tracer,
          why: "smthrs-observe was built before it could follow a program a step leaves running: build it again"
        })
      // One built from this package's source answers both ways.
      if (process.platform === "linux" && NodeFs.existsSync(built)) {
        expect(spawnSync(built, ["--probe", "--keep"]).status).toBe(spawnSync(built, ["--probe"]).status)
        expect(spawnSync(built, ["--probe", "--other"]).status).toBe(125)
      }
    }
  )

  it.skipIf(process.platform === "win32")("records with strace where smthrs-observe cannot listen", async () => {
    const root = await directory()
    const refusing = Path.join(root, "smthrs-observe")
    await Fs.writeFile(refusing, "#!/bin/sh\nexit 126\n", { mode: 0o755 })
    expect(ObservedReads.observer({ platform: "linux", executable: () => undefined, supervisor: refusing }))
      .toEqual({ reason: "smthrs-observe cannot run here, and strace is not installed" })
    const tracer = Path.join(root, "strace")
    await Fs.writeFile(tracer, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    // strace records, and the answer says why smthrs-observe does not.
    expect(
      ObservedReads.observer({ platform: "linux", executable: () => tracer, supervisor: refusing, guard: undefined })
    )
      .toEqual({ tracer, why: "smthrs-observe cannot run here" })
  })

  it.skipIf(process.platform === "win32")(
    "says why strace records where smthrs-observe is built for the host",
    async () => {
      const root = await directory()
      const tracer = Path.join(root, "strace")
      await Fs.writeFile(tracer, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      const refusing = Path.join(root, "smthrs-observe")
      const said = "smthrs-observe cannot run here: this machine refuses pidfd_getfd: Operation not permitted"
      await Fs.writeFile(refusing, `#!/bin/sh\necho '${said}' >&2\necho 'more' >&2\nexit 126\n`, { mode: 0o755 })
      // The first line smthrs-observe printed when it refused, over why the host would have none.
      expect(
        ObservedReads.observer({
          platform: "linux",
          executable: () => tracer,
          supervisor: refusing,
          unsupervised: "not asked",
          guard: undefined
        })
      ).toEqual({ tracer, why: said })
      const missing = "this installation of @smthrs/build-cli holds no smthrs-observe for linux-x64"
      expect(
        ObservedReads.observer({ platform: "linux", executable: () => tracer, unsupervised: missing, guard: undefined })
      )
        .toEqual({ tracer, why: missing })
      expect(ObservedReads.observer({ platform: "linux", executable: () => undefined, unsupervised: missing }))
        .toEqual({ reason: `${missing}, and strace is not installed` })
      // Where none is built for the host, strace alone is named.
      expect(ObservedReads.observer({ platform: "linux", executable: () => tracer, guard: undefined })).toEqual({
        tracer
      })
    }
  )

  it("says why a machine smthrs-observe is built for has none", () => {
    expect(ObservedReads.unsupervised("darwin", "arm64", {})).toBeUndefined()
    expect(ObservedReads.unsupervised("linux", "ia32", {})).toBeUndefined()
    expect(ObservedReads.unsupervised("linux", "riscv64", { SMTHRS_OBSERVE_WITH: "strace" })).toBeUndefined()
    expect(ObservedReads.unsupervised("linux", "x64", { SMTHRS_OBSERVE_WITH: "strace" }))
      .toBe("SMTHRS_OBSERVE_WITH=strace asks for strace")
    expect(ObservedReads.unsupervised("linux", "arm64", { SMTHRS_OBSERVE_WITH: "strace" }))
      .toBe("SMTHRS_OBSERVE_WITH=strace asks for strace")
  })

  for (const arch of ["x64", "arm64"]) {
    const held = Path.resolve(import.meta.dirname, "..", "native", "out", `linux-${arch}`, "smthrs-observe")
    it.skipIf(NodeFs.existsSync(held))(`says this installation holds none for linux-${arch}`, () => {
      expect(ObservedReads.unsupervised("linux", arch, {}))
        .toBe(`this installation of @smthrs/build-cli holds no smthrs-observe for linux-${arch}`)
      expect(ObservedReads.unsupervised("linux", arch, asked))
        .toBe(`this installation of @smthrs/build-cli holds no smthrs-observe for linux-${arch}`)
    })
    it.skipIf(!NodeFs.existsSync(held))(`says nothing where this installation holds one for linux-${arch}`, () => {
      expect(ObservedReads.unsupervised("linux", arch, {})).toBeUndefined()
    })
  }

  it("names the recorder a run's summary gives", () => {
    expect(ObservedReads.recorderOf({ tracer: "/x/smthrs-observe", supervisor: true }))
      .toEqual({ name: "smthrs-observe" })
    expect(ObservedReads.recorderOf({ tracer: "/usr/bin/strace" })).toEqual({ name: "strace" })
    expect(ObservedReads.recorderOf({ tracer: "/usr/bin/strace", why: "SMTHRS_OBSERVE_WITH=strace asks for strace" }))
      .toEqual({ name: "strace", why: "SMTHRS_OBSERVE_WITH=strace asks for strace" })
    expect(ObservedReads.recorderOf({ reason: "strace is not installed" }))
      .toEqual({ name: "none", why: "strace is not installed" })
  })

  it.skipIf(process.platform === "win32")(
    "says why smthrs-observe cannot run when nothing else can record",
    async () => {
      const root = await directory()
      const refusing = Path.join(root, "smthrs-observe")
      const why = "smthrs-observe cannot run here: this machine refuses its system-call filter: Operation not permitted"
      await Fs.writeFile(refusing, `#!/bin/sh\necho '${why}' >&2\nexit 126\n`, { mode: 0o755 })
      expect(ObservedReads.observer({ platform: "linux", executable: () => undefined, supervisor: refusing }))
        .toEqual({ reason: `${why}, and strace is not installed` })
      const forbidden = Path.join(root, "strace")
      await Fs.writeFile(
        forbidden,
        "#!/bin/sh\necho 'strace: ptrace(PTRACE_SEIZE): Operation not permitted' >&2\nexit 1\n",
        {
          mode: 0o755
        }
      )
      expect(ObservedReads.observer({ platform: "linux", executable: () => forbidden, supervisor: refusing })).toEqual({
        reason:
          `${why}, and strace cannot trace a process on this host: strace: ptrace(PTRACE_SEIZE): Operation not permitted`
      })
    }
  )
})

describe("reading a trace", () => {
  it("keeps a file that a call asking for a directory found in place of one", () => {
    // rmdir of a file, unlinkat with AT_REMOVEDIR, chdir to a file and an open with O_DIRECTORY each answer ENOTDIR
    // from the last name of the path: the file is there, and the run reads it next.
    const trace = read([
      "100 rmdir(\"src/a\") = -1 ENOTDIR (Not a directory)",
      "100 unlinkat(AT_FDCWD</w>, \"src/b\", AT_REMOVEDIR) = -1 ENOTDIR (Not a directory)",
      "100 chdir(\"/w/src/c\") = -1 ENOTDIR (Not a directory)",
      "100 openat(AT_FDCWD</w>, \"src/d\", O_RDONLY|O_DIRECTORY|O_CLOEXEC) = -1 ENOTDIR (Not a directory)",
      "100 openat2(AT_FDCWD</w>, \"src/e\", {flags=O_RDONLY|O_DIRECTORY, mode=0, resolve=0}, 24) = -1 ENOTDIR (Not a directory)",
      // A name above the last that is no directory: the path is missing.
      "100 unlink(\"src/a/x\") = -1 ENOTDIR (Not a directory)",
      "100 openat(AT_FDCWD</w>, \"src/a/y\", O_RDONLY) = -1 ENOTDIR (Not a directory)",
      "100 rmdir(\"src/a/z\") = -1 ENOENT (No such file or directory)",
      "100 +++ exited with 0 +++",
      ""
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.found)).toEqual(["/w/src/a", "/w/src/b", "/w/src/c", "/w/src/d", "/w/src/e"])
    expect(paths(trace.missing)).toEqual(["/w/src/a/x", "/w/src/a/y", "/w/src/a/z"])
  })

  it("sorts each open by what the run learned from it", () => {
    const trace = read([
      "100 execve(\"/bin/sh\", [\"sh\", \"-c\", \"x\"], 0x7ffd0 /* 3 vars */) = 0",
      "100 openat(AT_FDCWD</w>, \"a.txt\", O_RDONLY|O_CLOEXEC) = 3</w/a.txt>",
      "100 openat(AT_FDCWD</w>, \"gone.txt\", O_RDONLY) = -1 ENOENT (No such file or directory)",
      "100 openat(AT_FDCWD</w>, \"out.txt\", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3</w/out.txt>",
      "100 openat(AT_FDCWD</w>, \"new.txt\", O_WRONLY|O_CREAT|O_EXCL, 0666) = 3</w/new.txt>",
      "100 openat(AT_FDCWD</w>, \"log.txt\", O_WRONLY|O_CREAT|O_APPEND, 0666) = 3</w/log.txt>",
      "100 openat(AT_FDCWD</w>, \"db\", O_RDWR) = 3</w/db>",
      "100 openat(AT_FDCWD</w>, \"locked\", O_WRONLY) = -1 EACCES (Permission denied)",
      "100 openat(AT_FDCWD</w>, \"nolog\", O_WRONLY|O_APPEND) = -1 ENOENT (No such file or directory)",
      "100 open(\"/abs/legacy\", O_RDONLY) = 3</abs/legacy>",
      "100 creat(\"by-creat\", 0644)          = 4</w/by-creat>",
      "100 openat2(AT_FDCWD</w>, \"two\", {flags=O_RDONLY|O_CLOEXEC, mode=0, resolve=0}, 24) = 5</w/two>",
      "100 openat(AT_FDCWD</w>, NULL, O_RDONLY) = -1 EFAULT (Bad address)",
      "100 open(\"bare\") = 3",
      "100 +++ exited with 0 +++",
      "100 --- SIGCHLD {si_signo=SIGCHLD} ---",
      ""
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.found)).toEqual([
      "/abs/legacy",
      "/bin/sh",
      "/w/a.txt",
      "/w/bare",
      "/w/db",
      "/w/locked",
      "/w/two"
    ])
    expect(paths(trace.missing)).toEqual(["/w/gone.txt", "/w/nolog"])
    // A name that could not be made was missing its directory, and that is what the run learned.
    const unmade = read([
      "100 openat(AT_FDCWD</w>, \"nodir/new.txt\", O_WRONLY|O_CREAT|O_TRUNC, 0666) = -1 ENOENT (No such file or directory)",
      "100 openat(AT_FDCWD</w>, \"noexcl/new.txt\", O_WRONLY|O_CREAT|O_EXCL, 0666) = -1 ENOENT (No such file or directory)",
      "100 openat(AT_FDCWD</w>, \"nolog/a.log\", O_WRONLY|O_CREAT|O_APPEND, 0666) = -1 ENOENT (No such file or directory)",
      "100 openat(AT_FDCWD</w>, \"nodb/db\", O_RDWR|O_CREAT, 0666) = -1 ENOENT (No such file or directory)",
      "100 creat(\"nocreat/f\", 0644)        = -1 ENOENT (No such file or directory)",
      "100 symlink(\"target\", \"/w/nolink/l\") = -1 ENOENT (No such file or directory)",
      "100 openat(AT_FDCWD</w>, \"plain-missing\", O_WRONLY|O_TRUNC) = -1 ENOENT (No such file or directory)",
      "100 openat(AT_FDCWD</w>, \"db-missing\", O_RDWR) = -1 ENOENT (No such file or directory)"
    ].join("\n"))
    expect(paths(unmade.missing)).toEqual([
      "/w/db-missing",
      "/w/nocreat",
      "/w/nocreat/f",
      "/w/nodb",
      "/w/nodb/db",
      "/w/nodir",
      "/w/nodir/new.txt",
      "/w/noexcl",
      "/w/noexcl/new.txt",
      "/w/nolink",
      "/w/nolink/l",
      "/w/nolog",
      "/w/nolog/a.log",
      "/w/plain-missing"
    ])
    expect(paths(trace.emptied)).toEqual(["/w/by-creat", "/w/out.txt"])
    expect(paths(trace.made)).toEqual(["/w/new.txt"])
    expect([...trace.changed].sort()).toEqual(["/w/by-creat", "/w/db", "/w/log.txt", "/w/new.txt", "/w/out.txt"])
    expect(paths(trace.started)).toEqual(["/bin/sh"])
    // The line a path first appears on orders what happened to it.
    expect(trace.found.get("/w/a.txt")).toBe(2)
    expect(trace.emptied.get("/w/out.txt")).toBe(4)
  })

  it("follows the working directory of each call", () => {
    const trace = read([
      "100 chdir(\"sub\")                      = 0",
      "100 stat(\"rel.txt\", {st_mode=S_IFREG|0644, st_size=1, ...}) = 0",
      "100 access(\"nope\", F_OK)              = -1 ENOENT (No such file or directory)",
      "100 fchdir(5</w/other>)               = 0",
      "100 lstat(\"in-other\", {st_mode=S_IFREG|0644, ...}) = 0",
      "100 newfstatat(AT_FDCWD, \"plain\", {st_mode=S_IFREG|0644, ...}, 0) = 0",
      "100 newfstatat(3</w/a.txt>, \"\", {st_mode=S_IFREG|0644, ...}, AT_EMPTY_PATH) = 0",
      "100 newfstatat(1<pipe:[123]>, \"\", {st_mode=S_IFIFO|0600, ...}, AT_EMPTY_PATH) = 0",
      "100 statx(AT_FDCWD</w/third>, \"sx\", AT_STATX_SYNC_AS_STAT, STATX_ALL, {stx_mask=STATX_ALL, ...}) = 0",
      "100 faccessat2(AT_FDCWD</w/third>, \"fa\", R_OK, AT_EACCESS) = -1 ENOTDIR (Not a directory)",
      "100 readlinkat(AT_FDCWD</w/third>, \"rl\", \"target\", 4096) = 6",
      "100 readlink(\"/proc/self/exe\", \"/usr/bin/node\", 4096) = 13",
      "100 faccessat(7</w/dir>, \"child\", F_OK) = 0",
      "100 chdir(\"/missing\")                 = -1 ENOENT (No such file or directory)",
      "100 stat(\"still-third\", {st_mode=S_IFREG|0644, ...}) = 0",
      "100 fchdir(8</w/gone>)                = -1 EBADF (Bad file descriptor)"
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.found)).toEqual([
      "/w/a.txt",
      "/w/dir/child",
      "/w/other/plain",
      "/w/sub",
      "/w/sub/rel.txt",
      "/w/third/still-third",
      "/w/third/sx"
    ])
    // A lookup that does not follow a link at the end read the name, not what a link there leads to.
    expect(paths(trace.unfollowed!)).toEqual(["/proc/self/exe", "/w/other/in-other", "/w/third/rl"])
    expect(paths(trace.missing)).toEqual(["/missing", "/w/sub/nope", "/w/third/fa"])
  })

  it("stores nothing when a relative path has no known directory", () => {
    const trace = read([
      "100 fchdir(9)                         = 0",
      "100 stat(\"lost\", {st_mode=S_IFREG|0644, ...}) = 0",
      "100 openat(5, \"under-unknown\", O_RDONLY) = 3"
    ].join("\n"))
    expect(trace.refusals).toEqual([
      "its trace does not say which directory \"lost\" was read from",
      "its trace does not say which directory \"under-unknown\" was read from"
    ])
  })

  it("notes each directory a run lists", () => {
    const trace = read([
      "100 getdents64(3</w/dir>, 0x55d0 /* 3 entries */, 32768) = 80",
      "100 getdents64(3</w/dir>, 0x55d0 /* 0 entries */, 32768) = 0",
      "100 getdents(4</w/old (deleted)>, 0x55d0 /* 0 entries */, 32768) = 0"
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.listed)).toEqual(["/w/dir", "/w/old"])
    expect(read("100 getdents64(3, 0x55d0 /* 3 entries */, 32768) = 80").refusals)
      .toEqual(["its trace does not name a directory it listed"])
  })

  // click's tests make a directory named with a newline. strace -y escapes a descriptor's path as it does a quoted
  // string, and `<` and `>` too; smthrs-observe writes it the same way (`\x3c` for `<`).
  it("reads the path of a descriptor as the tracer escapes it", () => {
    const trace = read([
      "100 getdents64(3</w/a\\nb\\\"c\\74d\\76e\\\\f>, 0x55d0 /* 2 entries */, 32768) = 48",
      "100 getdents64(0</w/g\\x3ch\\x3e\\ti>, {...}, 32768) = 0"
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.listed)).toEqual(["/w/a\nb\"c<d>e\\f", "/w/g<h>\ti"])
    // An escape no tracer writes names no path.
    expect(read("100 getdents64(3</w/bad\\q>, 0x55d0 /* 2 entries */, 32768) = 48").refusals)
      .toEqual(["its trace does not name a directory it listed"])
  })

  it("notes each program a run starts and each one it looks for", () => {
    const trace = read([
      "100 execve(\"./run.sh\", [\"./run.sh\"], 0x7ffd0 /* 3 vars */) = 0",
      "100 execve(\"/usr/local/bin/tool\", [\"tool\"], 0x7ffd0 /* 3 vars */) = -1 ENOENT (No such file or directory)",
      "100 execveat(AT_FDCWD</w>, \"tool\", [\"tool\"], 0x7ffd0 /* 3 vars */, 0) = 0"
    ].join("\n"))
    expect(paths(trace.started)).toEqual(["/w/run.sh", "/w/tool"])
    expect(paths(trace.missing)).toEqual(["/usr/local/bin/tool"])
  })

  it("separates what a run made from what it changed or removed", () => {
    const trace = read([
      "100 mkdir(\"/w/d1\", 0777)              = 0",
      "100 mkdir(\"/w/exists\", 0777)          = -1 EEXIST (File exists)",
      "100 mkdirat(AT_FDCWD</w>, \"d2/sub\", 0777) = -1 ENOENT (No such file or directory)",
      "100 unlink(\"/w/tmp1\")                 = 0",
      "100 unlinkat(AT_FDCWD</w>, \"tmp2\", 0) = -1 ENOENT (No such file or directory)",
      "100 rmdir(\"/w/d3\")                    = 0",
      "100 truncate(\"/w/t\", 0)               = 0",
      "100 symlink(\"target\", \"/w/ln\")        = 0",
      "100 symlinkat(\"target\", AT_FDCWD</w>, \"ln2\") = 0",
      "100 rename(\"/w/from\", \"/w/to\")        = 0",
      "100 renameat(AT_FDCWD</w>, \"f2\", AT_FDCWD</w>, \"t2\") = 0",
      "100 renameat2(AT_FDCWD</w>, \"f3\", AT_FDCWD</w>, \"t3\", RENAME_NOREPLACE) = -1 ENOENT (No such file or directory)",
      "100 link(\"/w/orig\", \"/w/hard\")        = 0",
      "100 link(\"/w/orig-gone\", \"/w/hard-gone\") = -1 ENOENT (No such file or directory)",
      "100 linkat(AT_FDCWD</w>, \"o2\", AT_FDCWD</w>, \"h2\", 0) = 0",
      "100 linkat(AT_FDCWD</w>, \"o3\", AT_FDCWD</w>, \"h3\", 0) = -1 EEXIST (File exists)"
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.made)).toEqual(["/w/d1", "/w/h2", "/w/hard", "/w/ln", "/w/ln2", "/w/t2", "/w/to"])
    expect([...trace.changed].sort()).toEqual([
      "/w/d1",
      "/w/d3",
      "/w/f2",
      "/w/from",
      "/w/h2",
      "/w/hard",
      "/w/ln",
      "/w/ln2",
      "/w/o2",
      "/w/orig",
      "/w/t",
      "/w/t2",
      "/w/tmp1",
      "/w/to"
    ])
    expect(paths(trace.found)).toEqual(["/w/exists", "/w/f2", "/w/from", "/w/h3", "/w/o2", "/w/o3", "/w/orig"])
    expect(paths(trace.missing)).toEqual([
      "/w/d2",
      "/w/d2/sub",
      "/w/f3",
      "/w/hard-gone",
      "/w/orig-gone",
      "/w/t3",
      "/w/tmp2"
    ])
  })

  it("counts a new mode, owner or time as the run's own change", () => {
    const trace = read([
      "100 chmod(\"/w/a\", 0755)               = 0",
      "100 fchmodat(AT_FDCWD</w>, \"b\", 0755)  = 0",
      "100 fchmodat2(AT_FDCWD</w>, \"c\", 0755, AT_SYMLINK_NOFOLLOW) = 0",
      "100 fchmod(3</w/d>, 0644)              = 0",
      "100 chown(\"/w/e\", 1000, 1000)         = 0",
      "100 lchown(\"/w/f\", 1000, 1000)        = 0",
      "100 fchownat(AT_FDCWD</w>, \"g\", 1000, 1000, 0) = 0",
      "100 fchown(4</w/h>, 1000, 1000)        = 0",
      "100 utime(\"/w/i\", NULL)               = 0",
      "100 utimes(\"/w/j\", NULL)              = 0",
      "100 futimesat(AT_FDCWD</w>, \"k\", NULL) = 0",
      "100 utimensat(AT_FDCWD</w>, \"l\", NULL, 0) = 0",
      "100 utimensat(5</w/m>, NULL, [UTIME_NOW, UTIME_NOW], 0) = 0",
      "100 chmod(\"/w/gone\", 0755)            = -1 ENOENT (No such file or directory)",
      "100 chown(\"/w/kept\", 0, 0)            = -1 EPERM (Operation not permitted)",
      "100 fchmod(6<pipe:[77]>, 0644)         = 0"
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect([...trace.changed].sort()).toEqual("abcdefghijklm".split("").map((name) => `/w/${name}`))
    expect(paths(trace.missing)).toEqual(["/w/gone"])
    expect(paths(trace.found)).toEqual(["/w/kept"])
    expect(paths(trace.made)).toEqual([])
  })

  it("stores nothing for a run that reached a program or a network outside it", () => {
    const address = (text: string): string => `100 connect(3<socket:[9]>, ${text}, 16) = 0`
    const own = read([
      "100 bind(3<socket:[1]>, {sa_family=AF_UNIX, sun_path=\"/tmp/own.sock\"}, 110) = 0",
      "100 bind(4<socket:[2]>, {sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr(\"127.0.0.1\")}, 16) = 0",
      "100 bind(5<socket:[3]>, {sa_family=AF_NETLINK, nl_pid=0, nl_groups=00000000}, 12) = 0",
      "100 bind(6<socket:[4]>, {sa_family=AF_INET, sin_port=htons(9), sin_addr=inet_addr(\"0.0.0.0\")}, 16) = -1 EADDRINUSE (Address already in use)",
      address("{sa_family=AF_UNIX, sun_path=\"/tmp/own.sock\"}"),
      address("{sa_family=AF_INET, sin_port=htons(8080), sin_addr=inet_addr(\"127.0.0.1\")}"),
      address("{sa_family=AF_NETLINK, nl_pid=0, nl_groups=00000000}"),
      "100 connect(3<socket:[9]>, {sa_family=AF_UNIX, sun_path=\"/var/run/nscd/socket\"}, 110) = -1 ENOENT (No such file or directory)",
      "100 connect(3<socket:[9]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(\"93.184.216.34\")}, 16) = -1 ECONNREFUSED (Connection refused)"
    ].join("\n"))
    expect(own.refusals).toEqual([])

    expect(read(address("{sa_family=AF_UNIX, sun_path=\"/run/daemon.sock\"}")).refusals)
      .toEqual(["it reached a program outside the run through the socket \"/run/daemon.sock\""])
    expect(read(address("{sa_family=AF_UNIX, sun_path=@\"abstract\"}")).refusals)
      .toEqual(["it reached a program outside the run through the socket @\"abstract\""])
    expect(read(address("{sa_family=AF_UNIX}")).refusals)
      .toEqual(["it reached a program outside the run through the socket it was given"])
    expect(read(address("{sa_family=AF_INET, sin_port=htons(5432), sin_addr=inet_addr(\"127.0.0.1\")}")).refusals)
      .toEqual(["it reached a program outside the run on local port 5432"])
    expect(
      read(address(
        "{sa_family=AF_INET6, sin6_port=htons(6379), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, \"::1\", &sin6_addr), sin6_scope_id=0}"
      )).refusals
    ).toEqual(["it reached a program outside the run on local port 6379"])
    expect(read(address("{sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(\"93.184.216.34\")}")).refusals)
      .toEqual(["it opened a network connection (to 93.184.216.34 port 443)"])
    expect(
      read(
        "100 connect(3<socket:[9]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr(\"93.184.216.34\")}, 16) = -1 EINPROGRESS (Operation now in progress)"
      ).refusals
    ).toEqual(["it opened a network connection (to 93.184.216.34 port 443)"])
    // The line names the program that connected, also when a process it started did, and only the first connection.
    expect(
      read([
        "100 execve(\"/usr/bin/uv\", [\"uv\", \"run\"], 0x7ffc /* 9 vars */) = 0",
        "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 101",
        "101 connect(3<socket:[9]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), inet_pton(AF_INET6, \"2a04:4e42::223\", &sin6_addr), sin6_scope_id=0}, 28) = 0",
        "100 connect(4<socket:[10]>, {sa_family=AF_INET, sin_port=htons(80), sin_addr=inet_addr(\"93.184.216.34\")}, 16) = 0"
      ].join("\n")).refusals
    ).toEqual(["it opened a network connection (uv to 2a04:4e42::223 port 443)"])
    expect(read("100 connect(3<socket:[9]>, {sa_family=AF_INET, sin_addr=0x7f}, 16) = 0").refusals)
      .toEqual(["it opened a network connection (to an address the trace does not show)"])
    // A server the run started on a port the system chose answers any local port.
    expect(
      read([
        "100 bind(4<socket:[2]>, {sa_family=AF_INET, sin_port=htons(0), sin_addr=inet_addr(\"127.0.0.1\")}, 16) = 0",
        address("{sa_family=AF_INET, sin_port=htons(40123), sin_addr=inet_addr(\"127.0.0.1\")}")
      ].join("\n")).refusals
    ).toEqual([])
    expect(read("100 connect(3<socket:[9]>) = 0").refusals).toEqual([])
  })

  it("takes what the run wrote in a directory along when the run moves the directory", () => {
    const trace = read([
      "100 mkdir(\"/w/stage\", 0777)                                            = 0",
      "100 mkdir(\"/w/stage/inner\", 0777)                                      = 0",
      "100 openat(AT_FDCWD</w>, \"stage/inner/new.txt\", O_WRONLY|O_CREAT|O_EXCL, 0666) = 3",
      "100 openat(AT_FDCWD</w>, \"stage/inner/emptied.txt\", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3",
      "100 openat(AT_FDCWD</w>, \"stage/appended.txt\", O_WRONLY|O_APPEND)        = 3",
      "100 openat(AT_FDCWD</w>, \"stage/only-read.txt\", O_RDONLY)                = 3",
      "100 rename(\"/w/stage\", \"/w/middle\")                                   = 0",
      "100 renameat2(AT_FDCWD</w>, \"middle\", AT_FDCWD</w>, \"final\", RENAME_NOREPLACE) = 0",
      "100 rename(\"/w/final\", \"/w/final\")                                    = 0",
      "100 rename(\"/w/absent\", \"/w/elsewhere\")                               = -1 ENOENT (No such file or directory)",
      "100 linkat(AT_FDCWD</w>, \"final\", AT_FDCWD</w>, \"linked\", 0)          = 0"
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.made).filter((path) => path.startsWith("/w/final"))).toEqual([
      "/w/final",
      "/w/final/inner",
      "/w/final/inner/new.txt"
    ])
    expect(paths(trace.emptied)).toEqual([
      "/w/final/inner/emptied.txt",
      "/w/middle/inner/emptied.txt",
      "/w/stage/inner/emptied.txt"
    ])
    expect([...trace.changed].filter((path) => path.startsWith("/w/final")).sort()).toEqual([
      "/w/final",
      "/w/final/appended.txt",
      "/w/final/inner",
      "/w/final/inner/emptied.txt",
      "/w/final/inner/new.txt"
    ])
    // A link to a directory's name moves nothing, and a file the run only read stays somebody else's.
    expect([...trace.changed].filter((path) => path.startsWith("/w/linked"))).toEqual(["/w/linked"])
    expect(paths(trace.made)).not.toContain("/w/elsewhere")
  })

  it("reads how many times the recorder stopped the run for signals", () => {
    const counted = read(
      ["100 +++ smthrs-observe 1 +++", "100 +++ signal stops: 21345 +++", "100 +++ complete +++"].join("\n")
    )
    expect(counted.signalStops).toBe(21_345)
    expect(read(["100 +++ smthrs-observe 1 +++", "100 +++ complete +++"].join("\n")).signalStops).toBeUndefined()
  })

  it("reads an install that links thousands of files into thousands of directories it made, in time", () => {
    const lines: Array<string> = []
    for (let index = 0; index < 60_000; index += 1) lines.push(`100 mkdir("/w/env/d${index}", 0777) = 0`)
    for (let index = 0; index < 60_000; index += 1) {
      lines.push(`100 linkat(AT_FDCWD</w>, "cache/f${index}", AT_FDCWD</w>, "env/d${index}/f", 0) = 0`)
    }
    // A move onto a directory the run made, or onto one above it, takes it away from those the run made.
    lines.push(
      `100 rename("/w/other", "/w/env/d7") = 0`,
      `100 openat(AT_FDCWD</w>, "env/d7/lock", O_RDONLY|O_CREAT, 0666) = 3`,
      `100 openat(AT_FDCWD</w>, "env/d8/lock", O_RDONLY|O_CREAT, 0666) = 3`,
      `100 rename("/w/next", "/w/env") = 0`,
      `100 openat(AT_FDCWD</w>, "env/d9/lock", O_RDONLY|O_CREAT, 0666) = 3`
    )
    const began = performance.now()
    const trace = read(lines.join("\n"))
    // Searching every directory made at every link took 26 s here, on the build server.
    expect(performance.now() - began).toBeLessThan(10_000)
    expect(trace.refusals).toEqual([])
    expect(["/w/env/d7/lock", "/w/env/d8/lock", "/w/env/d9/lock"].map((path) => trace.made.has(path))).toEqual([
      false,
      true,
      false
    ])
  })

  it("reads an install that unpacks thousands of packages in directories it made and moves each into place, in time", () => {
    // `bun install` makes the directories of node_modules and keeps them, and unpacks each package in a directory
    // it made and renames that into its cache: at eliza's 78e44531, 3,335 such moves among 84,999 directories made.
    const lines: Array<string> = []
    for (let index = 0; index < 60_000; index += 1) {
      lines.push(`100 mkdirat(AT_FDCWD</w>, "modules/d${index}", 0777) = 0`)
    }
    for (let index = 0; index < 6_000; index += 1) {
      lines.push(
        `100 mkdirat(AT_FDCWD</w>, "tmp/p${index}", 0777) = 0`,
        `100 mkdirat(AT_FDCWD</w>, "tmp/p${index}/lib", 0777) = 0`,
        `100 renameat2(AT_FDCWD</w>, "tmp/p${index}", AT_FDCWD</w>, "cache/p${index}", 0) = 0`
      )
    }
    lines.push(
      `100 mkdirat(AT_FDCWD</w>, "tmp/kept", 0777) = 0`,
      `100 mkdirat(AT_FDCWD</w>, "tmp/kept/lib", 0777) = 0`,
      `100 openat(AT_FDCWD</w>, "tmp/kept/lib/lock", O_RDONLY|O_CREAT, 0666) = 3`,
      `100 openat(AT_FDCWD</w>, "modules/d9/lock", O_RDONLY|O_CREAT, 0666) = 3`,
      `100 openat(AT_FDCWD</w>, "tmp/p7/lib/lock", O_RDONLY|O_CREAT, 0666) = 3`
    )
    const began = performance.now()
    const trace = read(lines.join("\n"))
    // Searching every directory made at every move took 39 s here, on the build server.
    expect(performance.now() - began).toBeLessThan(10_000)
    expect(trace.refusals).toEqual([])
    // A directory the run moved away is no longer one it made, nor is anything that was under it.
    expect(["/w/tmp/kept/lib/lock", "/w/modules/d9/lock", "/w/tmp/p7/lib/lock"].map((path) => trace.made.has(path)))
      .toEqual([true, true, false])
  })

  it("leaves out what a quiet process and the processes it starts read, and keeps what they write", () => {
    const quiet = (text: string, words: ReadonlyArray<string>): ObservedReads.Trace =>
      ObservedReads.read(() => text.split("\n"), "/w", words)
    const text = [
      "100 execve(\"/bin/bash\", [\"bash\", \"-c\", \"x\"], 0x7ffd0 /* 3 vars */) = 0",
      "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 101",
      "101 execve(\"/usr/bin/git\", [\"git\", \"-c\", \"asks.commit=1\", \"rev-parse\", \"HEAD\"], 0x7ffd0 /* 3 vars */) = 0",
      "101 openat(AT_FDCWD</w>, \".git/HEAD\", O_RDONLY) = 3</w/.git/HEAD>",
      "101 openat(AT_FDCWD</w>, \".git/packed-refs\", O_RDONLY) = -1 ENOENT (No such file or directory)",
      "101 getdents64(3</w/.git/refs>, 0x55 /* 4 entries */, 32768) = 112",
      "101 openat(AT_FDCWD</w>, \"asked.log\", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 4</w/asked.log>",
      "101 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 102",
      "102 execve(\"/usr/bin/cat\", [\"cat\", \".git/refs/heads/main\"], 0x7ffd0 /* 3 vars */) = 0",
      "102 openat(AT_FDCWD</w>, \".git/refs/heads/main\", O_RDONLY) = 3</w/.git/refs/heads/main>",
      "102 +++ exited with 0 +++",
      "101 +++ exited with 0 +++",
      // The process id comes round again for a process the command itself starts: its reads are the run's.
      "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 101",
      "101 execve(\"/usr/bin/git\", [\"git\", \"log\", \"-1\"], 0x7ffd0 /* 3 vars */) = 0",
      "101 openat(AT_FDCWD</w>, \".git/HEAD\", O_RDONLY) = 3</w/.git/HEAD>",
      "100 openat(AT_FDCWD</w>, \"a.txt\", O_RDONLY) = 3</w/a.txt>"
    ].join("\n")
    const hushed = quiet(text, ["asks.commit=1"])
    expect(hushed.refusals).toEqual([])
    expect(paths(hushed.found)).toEqual(["/bin/bash", "/usr/bin/git", "/w/.git/HEAD", "/w/a.txt"])
    // The command's own git found HEAD after the quiet one: the read is placed where the command made it.
    expect(hushed.found.get("/w/.git/HEAD")).toBe(15)
    expect(paths(hushed.missing)).toEqual([])
    expect(paths(hushed.listed)).toEqual([])
    expect(paths(hushed.started)).toEqual(["/bin/bash", "/usr/bin/git"])
    expect(paths(hushed.made)).toEqual([])
    expect([...hushed.changed]).toEqual(["/w/asked.log"])
    // Without the word, every read is the run's.
    const loud = quiet(text, [])
    expect(paths(loud.found)).toEqual([
      "/bin/bash",
      "/usr/bin/cat",
      "/usr/bin/git",
      "/w/.git/HEAD",
      "/w/.git/refs/heads/main",
      "/w/a.txt"
    ])
    expect(paths(loud.missing)).toEqual(["/w/.git/packed-refs"])
    expect(paths(loud.listed)).toEqual(["/w/.git/refs"])
    expect(loud.found.get("/w/.git/HEAD")).toBe(4)
  })

  it("places a call that found a name the run made where nothing was after the making", () => {
    const stat = "{st_mode=S_IFDIR|0755, st_size=4096, ...}"
    const trace = read([
      // Two threads: one makes the directory while the other asks about it, and the answer says it is there.
      "100 mkdir(\"/w/made\", 0777 <unfinished ...>",
      "101 stat(\"/w/made\",  <unfinished ...>",
      "100 <... mkdir resumed>)              = 0",
      `101 <... stat resumed>${stat})        = 0`,
      // Two threads make the same directory: the one that loses learns it is there.
      "100 mkdir(\"/w/raced\", 0777 <unfinished ...>",
      "101 mkdir(\"/w/raced\", 0777 <unfinished ...>",
      "100 <... mkdir resumed>)              = 0",
      "101 <... mkdir resumed>)              = -1 EEXIST (File exists)",
      // Found before the making began: it was there, and something else took it away.
      `100 stat("/w/before", ${stat})        = 0`,
      "100 mkdir(\"/w/before\", 0777)        = 0",
      // Found, removed by the run and made again: what was found was not the run's.
      "100 mkdir(\"/w/again\", 0777 <unfinished ...>",
      "101 stat(\"/w/again\",  <unfinished ...>",
      "100 <... mkdir resumed>)              = 0",
      `101 <... stat resumed>${stat})        = 0`,
      "100 rmdir(\"/w/again\")               = 0",
      // A move replaces what was there, so it says nothing about what was.
      "100 rename(\"/w/from\", \"/w/moved\" <unfinished ...>",
      "101 stat(\"/w/moved\",  <unfinished ...>",
      "100 <... rename resumed>)             = 0",
      `101 <... stat resumed>${stat})        = 0`,
      // A link to a file only succeeds where nothing was.
      "100 link(\"/w/from\", \"/w/linked\" <unfinished ...>",
      "101 stat(\"/w/linked\",  <unfinished ...>",
      "100 <... link resumed>)               = 0",
      `101 <... stat resumed>${stat})        = 0`
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.found)).toEqual(["/w/again", "/w/before", "/w/from", "/w/moved"])
    expect(paths(trace.made)).toEqual(["/w/again", "/w/before", "/w/linked", "/w/made", "/w/moved", "/w/raced"])
  })

  it("counts a name the run found missing and then opened to write as one it made", () => {
    const trace = read([
      "100 openat(AT_FDCWD</w>, \"index\", O_RDONLY) = -1 ENOENT (No such file or directory)",
      "100 openat(AT_FDCWD</w>, \"index\", O_WRONLY|O_CREAT|O_APPEND, 0666) = 3",
      "100 openat(AT_FDCWD</w>, \"index\", O_RDONLY) = 3",
      // Opened the same way with nothing known about it before: it may have been there.
      "100 openat(AT_FDCWD</w>, \"log\", O_WRONLY|O_CREAT|O_APPEND, 0666) = 3",
      // Found missing and opened to write without making it: the call says it was there by then.
      "100 openat(AT_FDCWD</w>, \"other\", O_RDONLY) = -1 ENOENT (No such file or directory)",
      "100 openat(AT_FDCWD</w>, \"other\", O_WRONLY) = 3",
      "100 openat(AT_FDCWD</w>, \"both\", O_RDONLY) = -1 ENOENT (No such file or directory)",
      "100 openat(AT_FDCWD</w>, \"both\", O_RDWR|O_CREAT, 0666) = 3"
    ].join("\n"))
    expect(paths(trace.made)).toEqual(["/w/both", "/w/index"])
    expect(paths(trace.missing)).toEqual(["/w/both", "/w/index", "/w/other"])
    expect([...trace.changed].sort()).toEqual(["/w/both", "/w/index", "/w/log", "/w/other"])
  })

  // What zig does in the cache directory it makes in a fresh checkout, and SQLite with a new database: the file
  // is opened to read and write, and made if it is not there, with nothing asked about it first.
  it("takes a name opened to read or made, in a directory the run made, for one the run made", () => {
    const open = (directory: string, name: string): string =>
      `100 openat(7<${directory}>, "${name}", O_RDWR|O_CREAT|O_CLOEXEC, 0666) = 10<${directory}/${name}>`
    const trace = read([
      "100 mkdirat(AT_FDCWD</w>, \".cache\", 0777) = 0",
      "100 mkdir(\"/w/.cache/h\", 0777)       = 0",
      open("/w/.cache/h", "manifest"),
      // A directory that was there may hold a file from before the run.
      "100 mkdir(\"/w/kept\", 0777)           = -1 EEXIST (File exists)",
      open("/w/kept", "manifest"),
      open("/w", "plain"),
      // A file the call could not open is no file the run made.
      "100 mkdir(\"/w/locked\", 0777)         = 0",
      "100 openat(7</w/locked>, \"manifest\", O_RDWR|O_CREAT, 0666) = -1 EACCES (Permission denied)",
      // A directory moved onto the one the run made brings its own files, from before the run.
      "100 mkdir(\"/w/swapped\", 0777)        = 0",
      "100 mkdir(\"/w/swapped/in\", 0777)     = 0",
      "100 rename(\"/w/old\", \"/w/swapped\") = 0",
      open("/w/swapped", "manifest"),
      open("/w/swapped/in", "manifest"),
      "100 mkdir(\"/w/replaced\", 0777)       = 0",
      "100 renameat(AT_FDCWD</w>, \"old2\", AT_FDCWD</w>, \"replaced\") = 0",
      open("/w/replaced", "manifest"),
      // So does a directory the run removed and something else put back, and one the run moved away.
      "100 mkdir(\"/w/removed\", 0777)        = 0",
      "100 rmdir(\"/w/removed\")              = 0",
      open("/w/removed", "manifest"),
      "100 mkdir(\"/w/moved\", 0777)          = 0",
      "100 rename(\"/w/moved\", \"/w/elsewhere\") = 0",
      open("/w/moved", "manifest")
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.found)).toEqual([
      "/w/kept",
      "/w/kept/manifest",
      "/w/locked/manifest",
      "/w/moved",
      "/w/moved/manifest",
      "/w/old",
      "/w/old2",
      "/w/plain",
      "/w/removed/manifest",
      "/w/replaced/manifest",
      "/w/swapped/in/manifest",
      "/w/swapped/manifest"
    ])
    expect(paths(trace.made)).toContain("/w/.cache/h/manifest")
    expect([...trace.changed]).toContain("/w/.cache/h/manifest")
  })

  // What go does with an entry of the cache it makes in an empty home: the file is opened to write, and made if
  // it is not there, with nothing asked about it first. A later `go` of the same run reads it.
  it("takes a name opened to write or made, in a directory the run made, for one the run made", () => {
    const write = (directory: string, name: string): string =>
      `100 openat(AT_FDCWD</w>, "${directory}/${name}", O_WRONLY|O_CREAT|O_CLOEXEC, 0666) = 10<${directory}/${name}>`
    const reads = (directory: string, name: string): string =>
      `101 openat(AT_FDCWD</w>, "${directory}/${name}", O_RDONLY|O_CLOEXEC) = 10<${directory}/${name}>`
    const trace = read([
      "100 mkdir(\"/w/home/go-build\", 0777) = 0",
      "100 mkdir(\"/w/home/go-build/00\", 0777) = 0",
      write("/w/home/go-build/00", "entry-a"),
      reads("/w/home/go-build/00", "entry-a"),
      // A directory that was there may hold an entry from before the run.
      "100 mkdir(\"/w/home/go-build/01\", 0777) = -1 EEXIST (File exists)",
      write("/w/home/go-build/01", "entry-a"),
      reads("/w/home/go-build/01", "entry-a"),
      // An entry the call could not open is none the run made.
      "100 mkdir(\"/w/home/go-build/02\", 0777) = 0",
      "100 openat(AT_FDCWD</w>, \"/w/home/go-build/02/entry-a\", O_WRONLY|O_CREAT, 0666) = -1 EACCES (Permission denied)",
      // A directory the run removed is no longer the one it made.
      "100 mkdir(\"/w/home/go-build/03\", 0777) = 0",
      "100 rmdir(\"/w/home/go-build/03\") = 0",
      write("/w/home/go-build/03", "entry-a")
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.made)).toContain("/w/home/go-build/00/entry-a")
    expect(paths(trace.made)).not.toContain("/w/home/go-build/01/entry-a")
    expect(paths(trace.made)).not.toContain("/w/home/go-build/02/entry-a")
    expect(paths(trace.made)).not.toContain("/w/home/go-build/03/entry-a")
    expect([...trace.changed]).toContain("/w/home/go-build/01/entry-a")
    expect(paths(trace.found)).toContain("/w/home/go-build/02/entry-a")
  })

  it("stores nothing for a run that changed its view of the file system", () => {
    const refused = ObservedReads.cannotFollow
    expect(read("100 chroot(\"/w/jail\")                = 0").refusals).toEqual([refused("chroot")])
    expect(read("100 mount(\"none\", \"/mnt\", \"tmpfs\", 0, NULL) = 0").refusals).toEqual([refused("mount")])
    expect(read("100 pivot_root(\".\", \".\")             = 0").refusals).toEqual([refused("pivot_root")])
    expect(read("100 setns(5</proc/1/ns/mnt>, CLONE_NEWNS) = 0").refusals).toEqual([refused("setns")])
    expect(read("100 setns(5</proc/1/ns/mnt>, CLONE_NEWNS) = -1 EPERM (Operation not permitted)").refusals)
      .toEqual([])
    expect(read("100 mount(\"none\", \"/mnt\", \"tmpfs\", 0, NULL) = -1 EPERM (Operation not permitted)").refusals)
      .toEqual([])
    expect(read("100 io_uring_setup(256, {flags=0, sq_thread_cpu=0}) = 4<anon_inode:[io_uring]>").refusals)
      .toEqual([refused("io_uring")])
    // A namespace of its own, or a working directory or descriptors of its own.
    expect(read("100 unshare(CLONE_NEWUSER|CLONE_NEWNS) = 0").refusals).toEqual(["it made a namespace of its own"])
    expect(read("100 unshare(CLONE_NEWUSER) = -1 EPERM (Operation not permitted)").refusals).toEqual([])
    const own = read([
      "100 clone(child_stack=0x1, flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_THREAD) = 101",
      "101 unshare(CLONE_FS|CLONE_FILES) = 0",
      "101 chdir(\"sub\") = 0",
      "100 open(\"a.txt\", O_RDONLY) = 3",
      "101 open(\"b.txt\", O_RDONLY) = 3"
    ].join("\n"))
    expect(paths(own.found)).toEqual(["/w/a.txt", "/w/sub", "/w/sub/b.txt"])
    // A call strace names by number: one that names no file, one that does, one past the table.
    expect(read("100 syscall_0x1ce(0, 0, 0) = 0").refusals).toEqual([])
    expect(read("100 syscall_0x1d0(0xffffffffffffff9c, 0x7f, 0, 0x7f, 0, 0) = -1 ENODATA (No data)").refusals)
      .toEqual([refused("getxattrat")])
    expect(read("100 syscall_0x1d8(0) = -1 ENOSYS (Function not implemented)").refusals)
      .toEqual([refused("a system call it does not know, numbered 472")])
    expect(read("100 syscall_0x14(0) = 0").refusals).toEqual([])
    // A flag the table does not follow, and one it does.
    expect(read("100 linkat(AT_FDCWD</w>, \"a\", AT_FDCWD</w>, \"b\", AT_SYMLINK_NOFOLLOW) = -1 EINVAL (Bad)").refusals)
      .toEqual([refused("linkat with AT_SYMLINK_NOFOLLOW")])
    expect(read("100 openat2(AT_FDCWD</w>, \"a\", {flags=O_RDONLY|0x4, resolve=0}, 24) = 3</w/a>").refusals)
      .toEqual([refused("openat2 with 0x4")])
    expect(read("100 openat2(AT_FDCWD</w>, \"a\", {resolve=0}, 24) = 3</w/a>").refusals).toEqual([])
    // A call the table does not hold names no file.
    expect(read("100 close(3) = 0").refusals).toEqual([])
    // A socket's path: there or not, as the failed call says; not asked about where the call says nothing of it, or
    // where the trace does not know the directory a relative one is in.
    const sockets = read([
      "100 connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path=\"gone\"}, 7) = -1 ENOENT (No such file or directory)",
      "100 connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path=\"/w/file\"}, 10) = -1 ECONNREFUSED (Refused)",
      "100 connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path=\"/w/locked\"}, 12) = -1 EACCES (Permission denied)",
      "100 bind(3<socket:[1]>, {sa_family=AF_UNIX, sun_path=\"/w/taken\"}, 11) = -1 EADDRINUSE (Address in use)",
      "100 bind(3<socket:[1]>, {sa_family=AF_UNIX, sun_path=\"/w/denied\"}, 12) = -1 EACCES (Permission denied)",
      "100 bind(3<socket:[1]>, {sa_family=AF_UNIX, sun_path=\"/w/mine\"}, 10) = 0",
      "200 connect(3<socket:[1]>, {sa_family=AF_UNIX, sun_path=\"rel\"}, 6) = -1 ENOENT (No such file or directory)"
    ].join("\n"))
    expect([paths(sockets.found), paths(sockets.missing), paths(sockets.made)])
      .toEqual([["/w/file", "/w/taken"], ["/w/gone"], ["/w/mine"]])
    // A name made where none was, by its own call.
    expect(paths(read("100 mknodat(AT_FDCWD</w>, \"fifo\", S_IFIFO|0644) = 0").made)).toEqual(["/w/fifo"])
    // An extended attribute, a file system's numbers, a watch: each looks the path up.
    expect(paths(
      read([
        "100 getxattr(\"x\", \"user.a\", NULL, 0) = -1 ENODATA (No data available)",
        "100 statfs(\"y\", {...}) = 0",
        "100 inotify_add_watch(3, \"z\", IN_ALL_EVENTS) = 1",
        "100 lsetxattr(\"x\", \"user.a\", \"v\", 1, 0) = 0",
        "100 removexattrat(AT_FDCWD</w>, \"x\", 0, \"user.a\") = 0"
      ].join("\n")).found
    )).toEqual(["/w/x", "/w/y", "/w/z"])
    expect(
      read("100 io_uring_setup(256, {flags=0}) = -1 ENOSYS (Function not implemented) (INJECTED)").refusals
    ).toEqual([])
  })

  it("joins a call another process interrupted, and gives each process its own directory", () => {
    const trace = read([
      "100 openat(AT_FDCWD</w>, \"slow.txt\", O_RDONLY <unfinished ...>",
      "100 <... openat resumed>)               = 3</w/slow.txt>",
      // A thread shares its directory with the process that made it; a forked process gets a copy.
      "100 clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_THREAD, child_tid=0x7f} => {parent_tid=[101]}, 88) = 101",
      "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD <unfinished ...>",
      "102 chdir(\"/w/child\")                  = 0",
      "100 <... clone resumed>, child_tidptr=0x7f) = 102",
      "102 stat(\"in-child\", {st_mode=S_IFREG|0644, ...}) = 0",
      "101 chdir(\"/w/thread\")                 = 0",
      "100 stat(\"in-thread\", {st_mode=S_IFREG|0644, ...}) = 0",
      "100 vfork( <unfinished ...>",
      "103 stat(\"from-vfork\", {st_mode=S_IFREG|0644, ...}) = 0",
      "100 <... vfork resumed>)                = 103",
      "100 fork()                             = 104",
      "104 access(\"from-fork\", F_OK)          = 0",
      "100 clone(child_stack=NULL, flags=SIGCHLD) = -1 EAGAIN (Resource temporarily unavailable)",
      "100 getdents64(5</w/dir>,  <unfinished ...>",
      "100 <... getdents64 resumed>0x7685 /* 2 entries */, 32768) = 48",
      "104 openat(AT_FDCWD</w/thread>, \"killed.txt\", O_RDONLY <unfinished ...>",
      "104 +++ killed by SIGKILL +++"
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.found)).toEqual([
      "/w/child",
      "/w/child/in-child",
      "/w/slow.txt",
      "/w/thread",
      "/w/thread/from-fork",
      "/w/thread/from-vfork",
      "/w/thread/in-thread",
      "/w/thread/killed.txt"
    ])
    expect(trace.found.get("/w/slow.txt")).toBe(1)
    expect(paths(trace.listed)).toEqual(["/w/dir"])
  })

  it("reads a trace the supervisor wrote only when its last line came last, and holds what it could not see", () => {
    const lines = [
      "100 +++ smthrs-observe 1 +++",
      "100 openat(AT_FDCWD, \"/w/a\", O_RDONLY) = 0",
      "100 execve(\"/usr/bin/cat\", [\"cat\"], 0x0 /* vars */) = ?",
      "100 execve(\"/usr/bin/cat\", [\"cat\"], 0x0 /* vars */) = 0",
      "100 +++ complete +++"
    ]
    const whole = read(lines.join("\n"))
    expect(whole.refusals).toEqual([])
    expect(paths(whole.found)).toEqual(["/usr/bin/cat", "/w/a"])
    expect(paths(whole.started)).toEqual(["/usr/bin/cat"])
    // Cut short: the last line is missing, or a line comes after it.
    expect(read(lines.slice(0, -1).join("\n")).refusals).toEqual(["its trace was cut short"])
    expect(read([...lines, "100 openat(AT_FDCWD, \"/w/b\", O_RDONLY) = 0"].join("\n")).refusals)
      .toEqual(["its trace was cut short"])
    // What the supervisor could not see is why the run stores nothing.
    expect(
      read([...lines.slice(0, -1), "100 +++ unrecorded: it made a namespace of its own +++", lines.at(-1)].join("\n"))
        .refusals
    ).toEqual(["it made a namespace of its own"])
    // A trace strace wrote has neither line.
    expect(read(lines.slice(1, -1).join("\n")).refusals).toEqual([])
  })

  it("stores nothing when a line of the trace cannot be followed", () => {
    expect(read("not a trace line").refusals).toEqual([
      "its trace holds a line that cannot be read: not a trace line",
      "its trace is empty"
    ])
    expect(read("").refusals).toEqual(["its trace is empty"])
    expect(read("100 something else").refusals)
      .toEqual(["its trace holds a line that cannot be read: something else"])
    expect(read("100 <... openat resumed>) = 3").refusals)
      .toEqual(["its trace resumes a call it never started: <... openat resumed>) = 3"])
    expect(read("100 openat(AT_FDCWD</w>, \"cut-sho\"..., O_RDONLY) = 3").refusals)
      .toEqual(["its trace holds a path that cannot be read: \"cut-sho\"..."])
    expect(read("100 stat(\"bad\\q\", {st_mode=S_IFREG|0644, ...}) = 0").refusals)
      .toEqual(["its trace holds a path that cannot be read: \"bad\\q\""])
    expect(read("100 stat(\", {st_mode=S_IFREG|0644, ...}) = 0").refusals.length).toBe(1)
    expect(read("100 stat(\"\\\") = 0").refusals).toEqual(["its trace holds a path that cannot be read: \"\\\""])
    // A call the tracer printed without its arguments names no path.
    const bare = read(
      ["100 openat() = -1 EFAULT (Bad address)", "100 unlink(NULL) = -1 EFAULT (Bad address)"].join("\n")
    )
    expect(bare.refusals).toEqual([])
    expect(paths(bare.found)).toEqual([])
    // A process that was unknown when its first call appeared has no directory to read from.
    expect(read(["100 stat(\"/a\", {...}) = 0", "777 stat(\"rel\", {...}) = 0"].join("\n")).refusals)
      .toEqual(["its trace does not say which directory \"rel\" was read from"])
    // A call that ended with its process still has its path; one cut before its name has nothing.
    expect(paths(read("100 unfinished-without-call <unfinished ...>").found)).toEqual([])
  })

  // The lines strace 6.8 wrote for a program of seventeen threads that ended, or started another program, while
  // sixteen of them asked about files.
  it("leaves out a call a thread was killed before, and keeps one it was killed in", () => {
    const trace = read([
      "100 openat(AT_FDCWD</w>, \"read.txt\", O_RDONLY|O_CLOEXEC) = 3</w/read.txt>",
      // Killed where it stopped before a call: the tracer could not ask which call, and the call never ran.
      "101 ???( <unfinished ...>",
      "102 newfstatat(AT_FDCWD</w>, \"asked.txt\",  <unfinished ...>",
      "101 <... ??? resumed>)              = ?",
      "102 <... newfstatat resumed>)       = ? <unavailable>",
      "103 ???( <detached ...>",
      // Killed inside a call: the call began, and nobody saw its answer.
      "104 openat(AT_FDCWD</w>, \"opened.txt\", O_RDONLY|O_CLOEXEC <detached ...>",
      "105 openat(AT_FDCWD</w>, \"begun.txt\", O_RDONLY|O_CLOEXEC <unfinished ...>",
      "105 <... openat resumed> <detached ...>",
      "106 newfstatat(AT_FDCWD</w>, \"cut.txt\",  <unfinished ...>",
      "106 <... newfstatat resumed> <unfinished ...>) = ?",
      "107 openat(AT_FDCWD</w>, \"late.txt\", O_RDONLY|O_CLOEXEC <unfinished ...>",
      "107 <... openat resumed>)           = -1 (errno 18446744073709551359)",
      // Killed before a call whose path the tracer could no longer read: an address stands where the path was.
      "108 newfstatat(AT_FDCWD</w>, 0x1c2e122eccd0,  <unfinished ...>",
      "108 <... newfstatat resumed>)       = ?",
      "109 openat(AT_FDCWD</w>, 0x1c2e122ecd00, O_RDONLY|O_CLOEXEC <detached ...>",
      // An address that is no memory of the process: the call fails on it and opens nothing.
      "100 openat(AT_FDCWD</w>, 0xdeadbeef, O_RDONLY) = -1 EFAULT (Bad address)",
      // A file opened to write with no answer is not a file the run is known to have made.
      "110 openat(AT_FDCWD</w>, \"new.txt\", O_WRONLY|O_CREAT|O_EXCL, 0644 <unfinished ...>",
      "110 <... openat resumed>)           = ? <unavailable>"
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.found)).toEqual([
      "/w/asked.txt",
      "/w/begun.txt",
      "/w/cut.txt",
      "/w/late.txt",
      "/w/opened.txt",
      "/w/read.txt"
    ])
    expect(paths(trace.made)).toEqual([])
    expect([...trace.changed]).toEqual(["/w/new.txt"])
  })

  it("stores nothing when a call that succeeded names its path by an address", () => {
    expect(read("100 openat(AT_FDCWD</w>, 0x1c2e122eccd0, O_RDONLY) = 3").refusals)
      .toEqual(["its trace holds a path that cannot be read: 0x1c2e122eccd0"])
  })

  // strace 6.8 with its seccomp filter, when a thread other than the first starts a program: it takes the first
  // call of the new program for the answer of the call that started it, and writes no line for that call.
  it("stores nothing when the tracer lost its place at a program a thread started", () => {
    const start = [
      "100 execve(\"/w/first\", [\"first\"], 0x7ffe73c01cc8 /* 21 vars */) = 0",
      "100 clone(child_stack=0x2e2ca7c36000, flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS, tls=0x2e2ca7cfc090) = 108",
      "100 newfstatat(AT_FDCWD</w>, \"first-was-in.txt\",  <unfinished ...>",
      "108 execve(\"/bin/true\", [\"true\"], 0x2e2ca8002090 /* 0 vars */ <unfinished ...>",
      // The tracer names the thread by the process it became: the answer is on a line of the process.
      "100 +++ superseded by execve in pid 108 +++"
    ]
    const lost = read([
      ...start,
      "100 <... execve resumed>)           = -1 (errno 18446744073709551595)",
      "100 openat(AT_FDCWD</w>, \"/etc/ld.so.cache\", O_RDONLY|O_CLOEXEC) = 3</etc/ld.so.cache>"
    ].join("\n"))
    expect(lost.refusals).toEqual(["the tracer lost its place when a thread started /bin/true"])
    // The same program when the tracer kept its place: the first call of the new program has its line.
    const kept = read([
      ...start,
      "100 <... execve resumed>)           = 0",
      "100 access(\"/etc/ld.so.preload\", R_OK) = -1 ENOENT (No such file or directory)"
    ].join("\n"))
    expect(kept.refusals).toEqual([])
    expect(paths(kept.started)).toEqual(["/bin/true", "/w/first"])
    expect(paths(kept.missing)).toEqual(["/etc/ld.so.preload"])
    expect(paths(kept.found)).toEqual(["/bin/true", "/w/first", "/w/first-was-in.txt"])
    // A thread that took the place of the process with no call of its own open answers nothing.
    expect(
      read([
        "100 execve(\"/w/first\", [\"first\"], 0x7ffe73c01cc8 /* 21 vars */) = 0",
        "100 +++ superseded by execve in pid 108 +++",
        "100 <... execve resumed>)           = 0"
      ].join("\n")).refusals
    ).toEqual(["its trace resumes a call it never started: <... execve resumed>)           = 0"])
    expect(read("100 execve(\"/bin/true\", [\"true\"], 0x2e2ca8002090 /* 0 vars */) = 12").refusals)
      .toEqual(["the tracer lost its place when a thread started /bin/true"])
    expect(read("100 execveat(AT_FDCWD</w>, NULL, [\"true\"], NULL, 0) = 12").refusals)
      .toEqual(["the tracer lost its place when a thread started a program"])
    // A program that started, one that did not, and one whose thread ended in the call are all the call's own.
    expect(
      read([
        "100 execve(\"/bin/true\", [\"true\"], 0x2e2ca8002090 /* 0 vars */) = 0",
        "100 execve(\"/bin/none\", [\"none\"], 0x2e2ca8002090 /* 0 vars */) = -1 ENOENT (No such file or directory)",
        "100 execve(\"/bin/true\", [\"true\"], 0x2e2ca8002090 /* 0 vars */ <unfinished ...>",
        "100 <... execve resumed>)           = ?"
      ].join("\n")).refusals
    ).toEqual([])
  })

  it("keeps a call its process never finished when the process id comes round again", () => {
    const trace = read([
      "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD, child_tidptr=0x7f) = 101",
      "101 chdir(\"/w/first\")                  = 0",
      "101 openat(AT_FDCWD</w/first>, \"cut.txt\", O_RDONLY <unfinished ...>",
      "101 +++ killed by SIGKILL +++",
      "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD, child_tidptr=0x7f) = 101",
      "101 openat(AT_FDCWD</w>, \"second.txt\", O_RDONLY <unfinished ...>",
      "101 <... openat resumed>)               = 3</w/second.txt>"
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.found)).toEqual(["/w/first", "/w/first/cut.txt", "/w/second.txt"])
  })

  it("reads a path as the tracer escaped it", () => {
    const trace = read(
      "100 stat(\"/w/q\\\"uote\\\\back\\n\\t\\r\\v\\f\\a\\b\\e\\303\\251\\x41, >x\", {st_mode=S_IFREG|0644, ...}) = 0"
    )
    expect(trace.refusals).toEqual([])
    expect(paths(trace.found)).toEqual(["/w/q\"uote\\back\n\t\r\v\f\u0007\b\u001bé" + "A, >x"])
    // A tracer told to print bytes as they are leaves a letter outside ASCII unescaped, beside an escape.
    const plain = read("100 stat(\"/w/caf\u00e9\\n\", {st_mode=S_IFREG|0644, ...}) = 0")
    expect(plain.refusals).toEqual([])
    expect(paths(plain.found)).toEqual(["/w/caf\u00e9\n"])
    // A directory whose name holds `>,`: the descriptor's path ends at the `>` before a comma and a space.
    const odd = read("100 openat(7</w/a>,b>, \"x\", O_RDONLY) = 3\n100 fchdir(7</w/a>,>) = 0")
    expect(odd.refusals).toEqual([])
    expect(paths(odd.found)).toEqual(["/w/a>,b/x"])
    const answered = read("100 stat(\"/w/unknown\", {st_mode=S_IFREG|0644, ...}) = ?")
    expect(paths(answered.found)).toEqual(["/w/unknown"])
    const wrote = read("100 unlink(\"/w/unknown\") = ?")
    expect([...wrote.changed]).toEqual(["/w/unknown"])
    expect(paths(wrote.made)).toEqual([])
  })

  it("reads every escape a tracer writes, and refuses a path with one it cannot read", () => {
    // A character the tracer left as it is beside an escape, and an octal escape of one digit in the middle and
    // at the end.
    const short = read("100 stat(\"/w/\u00e9\\\\\\1z\\7\", {st_mode=S_IFREG|0644, ...}) = 0")
    expect(short.refusals).toEqual([])
    expect(paths(short.found)).toEqual(["/w/\u00e9\\\u0001z\u0007"])
    // A string with no escape is itself.
    expect(paths(read("100 stat(\"/w/plain, name\", {st_mode=S_IFREG|0644, ...}) = 0").found))
      .toEqual(["/w/plain, name"])
    // No escape starts with these, and a string cannot end in the middle of one.
    for (const bad of ["\\q", "\\xZZ", "\\x4", "\\"]) {
      const argument = `"/w/a${bad}"`
      expect(read(`100 chdir(${argument}) = 0`).refusals)
        .toEqual([`its trace holds a path that cannot be read: ${argument}`])
    }
  })

  it("reads a descriptor's path to the mark that closes it, whatever the path holds", () => {
    // A path may hold the mark itself, and the mark before a comma.
    const trace = read([
      "100 openat(3</w/a>b>,c>, \"x\", O_RDONLY) = 4</w/a>b>,c/x>",
      "100 getdents64(4</w/dir>>, 0x55d0 /* 3 entries */, 32768) = 80",
      "100 fchdir(5</w/last>)                 = 0"
    ].join("\n"))
    expect(trace.refusals).toEqual([])
    expect(paths(trace.found)).toContain("/w/a>b>,c/x")
    expect(paths(trace.listed)).toEqual(["/w/dir>"])
  })
})

describe("measuring", () => {
  it("says what is at a path", async () => {
    const root = await directory()
    await Fs.writeFile(Path.join(root, "file.txt"), "content")
    await Fs.writeFile(Path.join(root, "tool"), "content", { mode: 0o755 })
    await Fs.mkdir(Path.join(root, "dir"))
    await Fs.symlink("file.txt", Path.join(root, "link"))
    const file = ObservedReads.measure(Path.join(root, "file.txt"))
    expect(file).toMatch(/^f:[0-9a-f]{64}$/)
    expect(ObservedReads.measure(Path.join(root, "tool"))).toBe(`${file}:x`)
    expect(ObservedReads.measure(Path.join(root, "dir"))).toBe("d")
    expect(ObservedReads.measure(Path.join(root, "link"))).toBe("l:file.txt")
    expect(ObservedReads.measure(Path.join(root, "missing"))).toBe("-")
    expect(ObservedReads.measure(Path.join(root, "file.txt", "below"))).toBe("-")
    await Fs.writeFile(Path.join(root, "file.txt"), "changed")
    expect(ObservedReads.measure(Path.join(root, "file.txt"))).not.toBe(file)
  })

  it.skipIf(process.platform === "win32")("names what is neither a file, a directory nor a link", () => {
    expect(ObservedReads.measure("/dev/null")).toMatch(/^o:\d+$/)
  })

  it("says so when a path cannot be read", () => {
    const refused: ObservedReads.Io = {
      ...ObservedReads.defaultIo,
      lstat: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" })
      }
    }
    expect(ObservedReads.measure("/anything", refused)).toBe("!EACCES")
    const broken: ObservedReads.Io = {
      ...ObservedReads.defaultIo,
      lstat: () => {
        throw new Error("no code")
      }
    }
    expect(ObservedReads.measure("/anything", broken)).toBe("!EIO")
  })

  it("digests a directory's names apart from the run's own", async () => {
    const root = await directory()
    await Fs.writeFile(Path.join(root, "a"), "")
    await Fs.writeFile(Path.join(root, "b"), "")
    const both = ObservedReads.listing(root, [])
    expect(both).toMatch(/^[0-9a-f]{64}$/)
    expect(ObservedReads.listing(root, ["b"])).not.toBe(both)
    await Fs.writeFile(Path.join(root, "c"), "")
    expect(ObservedReads.listing(root, ["c"])).toBe(both)
    expect(ObservedReads.listing(Path.join(root, "a"), [])).toBeUndefined()
  })

  it("remembers a digest while the file's status stays the same", async () => {
    const root = await directory()
    const file = Path.join(root, "file.txt")
    await Fs.writeFile(file, "one")
    let reads = 0
    const counting: ObservedReads.Io = {
      ...ObservedReads.defaultIo,
      readFile: (path) => {
        reads += 1
        return ObservedReads.defaultIo.readFile(path)
      }
    }
    // A file changed moments ago is read every time.
    const fresh = ObservedReads.remembering(counting)
    const first = fresh(file)
    expect(fresh(file)).toBe(first)
    expect(reads).toBe(2)
    // One that has settled is read once.
    const later = ObservedReads.remembering(counting, () => Date.now() + 60_000)
    expect(later(file)).toBe(first)
    expect(later(file)).toBe(first)
    expect(reads).toBe(3)
    await Fs.writeFile(file, "two, longer")
    expect(later(file)).not.toBe(first)
    expect(reads).toBe(4)
    expect(later(Path.join(root, "missing"))).toBe("-")
    expect(later(root)).toBe("d")
  })

  it("keeps what it measured for the next build, and reads again a file that changed since", async () => {
    const root = await directory()
    const tool = Path.join(root, "tool")
    const other = Path.join(root, "other")
    const gone = Path.join(root, "gone")
    await Fs.writeFile(tool, "tool")
    await Fs.writeFile(other, "other")
    await Fs.writeFile(gone, "gone")
    let reads = 0
    const counting: ObservedReads.Io = {
      ...ObservedReads.defaultIo,
      readFile: (path) => {
        reads += 1
        return ObservedReads.defaultIo.readFile(path)
      }
    }
    const settled = () => Date.now() + 60_000
    const kept = Path.join(root, "cache", "digests.json")
    const first: ObservedReads.Digests = new Map()
    const measured = ObservedReads.remembering(counting, settled, first)
    const states = [tool, other, gone].map(measured)
    // Used again, `tool` is the last used, so it is the one kept when one is.
    expect(measured(tool)).toBe(states[0])
    expect(reads).toBe(3)
    ObservedReads.saveDigests(kept, first, (path) => path !== other)
    // The next build reads neither file it measured, and does not hold one it was not given.
    const next = ObservedReads.loadDigests(kept)
    expect([...next.keys()].sort()).toEqual([gone, tool])
    const again = ObservedReads.remembering(counting, settled, next)
    expect([tool, gone].map(again)).toEqual([states[0], states[2]])
    expect(reads).toBe(3)
    expect(again(other)).toBe(states[1])
    expect(reads).toBe(4)
    // A file that changed is read again.
    await Fs.writeFile(gone, "changed")
    expect(again(gone)).not.toBe(states[2])
    expect(reads).toBe(5)
    ObservedReads.saveDigests(kept, first, () => true, 1)
    expect([...ObservedReads.loadDigests(kept).keys()]).toEqual([tool])
    // What no build wrote is no memory.
    for (
      const text of [
        "not json",
        JSON.stringify({ format: "other", digests: [] }),
        JSON.stringify({ format: "smthrs-digests/1" })
      ]
    ) {
      await Fs.writeFile(kept, text)
      expect(ObservedReads.loadDigests(kept).size).toBe(0)
    }
    await Fs.writeFile(
      kept,
      JSON.stringify({ format: "smthrs-digests/1", digests: [[tool, "1", "f:x"], [tool, 2, "f:y"], "z"] })
    )
    expect([...ObservedReads.loadDigests(kept)]).toEqual([[tool, ["1", "f:x"]]])
    expect(ObservedReads.loadDigests(Path.join(root, "absent.json")).size).toBe(0)
    // A build that measured nothing to keep leaves no file, and no directory, where there was none.
    const none = Path.join(root, "unused", "digests.json")
    ObservedReads.saveDigests(none, new Map([[other, ["1", "f:x"]]]), () => false)
    await expect(Fs.stat(Path.dirname(none))).rejects.toMatchObject({ code: "ENOENT" })
    // One that had a file replaces it, so what it no longer keeps is gone.
    ObservedReads.saveDigests(kept, new Map(), () => true)
    expect(ObservedReads.loadDigests(kept).size).toBe(0)
  })
})

describe("recording what a run read", () => {
  const setup = async () => {
    const base = await directory()
    const root = Path.join(base, "ws")
    await Fs.mkdir(Path.join(root, "src"), { recursive: true })
    await Fs.writeFile(Path.join(root, "src", "a.txt"), "a")
    await Fs.writeFile(Path.join(root, "src", "b.txt"), "b")
    const outside = Path.join(base, "outside.txt")
    await Fs.writeFile(outside, "outside")
    /** A record of a run that began after everything in the fixture was written. */
    /** The record without its id, which is a digest of the rest. */
    const record = (
      lines: ReadonlyArray<string>,
      ignore: ReadonlyArray<string> = [],
      startedMs = Date.now() + 60_000,
      producers: ReadonlyArray<ObservedReads.Producer> = []
    ) => {
      const value = ObservedReads.record(ObservedReads.read(() => lines, root), { root, ignore, startedMs, producers })
      if ("refusal" in value) return value
      const { id, ...rest } = value
      expect(id).toBe(ObservedReads.idOf(rest))
      return rest
    }
    const rows = (value: ReturnType<typeof record>) => {
      if ("refusal" in value) throw new Error(value.refusal)
      return value
    }
    return { base, root, outside, record, rows }
  }
  const open = (root: string, name: string, flags = "O_RDONLY"): string =>
    `100 openat(AT_FDCWD<${root}>, ${JSON.stringify(name)}, ${flags}) = 3`
  const absent = (root: string, name: string): string =>
    `100 openat(AT_FDCWD<${root}>, ${JSON.stringify(name)}, O_RDONLY) = -1 ENOENT (No such file or directory)`

  it("asks for the status of each path once while it reads a trace", async () => {
    const { outside, root } = await setup()
    const asked = new Map<string, number>()
    const io: ObservedReads.Io = {
      ...ObservedReads.defaultIo,
      lstat: (path) => {
        asked.set(path, (asked.get(path) ?? 0) + 1)
        return ObservedReads.defaultIo.lstat(path)
      }
    }
    const lines = [
      open(root, "src/a.txt"),
      open(root, "src/b.txt"),
      open(root, "src/a.txt"),
      `100 openat(AT_FDCWD, ${JSON.stringify(outside)}, O_RDONLY) = 3`,
      absent(root, "src/none.txt")
    ]
    const value = ObservedReads.record(ObservedReads.read(() => lines, root), {
      root,
      ignore: [],
      startedMs: Date.now() + 60_000,
      io,
      // A file outside the workspace is measured with the reading's own view of the file system too.
      outside: ObservedReads.remembering(io, () => Date.now() + 60_000)
    })
    if ("refusal" in value) throw new Error(value.refusal)
    expect(value.reads.map(([path]) => path)).toEqual([outside, "src/a.txt", "src/b.txt", "src/none.txt"])
    // Resolving each path, measuring it and checking that it did not change while the run ran take one answer.
    expect([...asked].filter(([, count]) => count > 1)).toEqual([])
    expect(asked.get(Path.join(root, "src", "a.txt"))).toBe(1)
    expect(asked.get(outside)).toBe(1)
  })

  it("takes a file the run moved into place inside a directory for the run's own", async () => {
    const { record, root, rows } = await setup()
    // What a package manager leaves: a directory filled under one name and moved to another.
    await Fs.mkdir(Path.join(root, "cache", "pkg"), { recursive: true })
    await Fs.writeFile(Path.join(root, "cache", "pkg", "RECORD"), "written by the run")
    const filled = [
      `100 mkdir("${root}/.tmp1", 0777) = 0`,
      `100 mkdir("${root}/.tmp1/pkg", 0777) = 0`,
      open(root, ".tmp1/pkg/RECORD", "O_WRONLY|O_CREAT|O_EXCL"),
      `100 rename("${root}/.tmp1", "${root}/cache") = 0`,
      open(root, "cache/pkg/RECORD")
    ]
    // The run began before the file was written, and the run wrote it: it is the run's product, not something it read.
    expect(rows(record(filled, [], 0))).toEqual({ reads: [], lists: [], left: true })
    // The same file read with no move before it is somebody else's, changed during the run.
    expect(record([open(root, "cache/pkg/RECORD")], [], 0)).toEqual({
      refusal: "cache/pkg/RECORD changed while it ran"
    })
  })

  it("holds a file the run found and changed as the run left it or as it found it", async () => {
    const { root } = await setup()
    // What mypy does with a cache a cache step put back: reads it, then writes it again.
    const db = Path.join(root, "cache.db")
    await Fs.writeFile(db, "as put back")
    const found = ObservedReads.measure(db)
    await Fs.writeFile(db, "as the run left it")
    const left = ObservedReads.measure(db)
    const lines = [open(root, "cache.db", "O_RDWR"), open(root, "src/a.txt")]
    const observed = (given?: ReadonlyMap<string, string>) => {
      const value = ObservedReads.record(ObservedReads.read(() => lines, root), {
        root,
        ignore: [],
        startedMs: Date.now() + 60_000,
        ...(given === undefined ? {} : { found: given })
      })
      if ("refusal" in value) throw new Error(value.refusal)
      return value
    }
    const stored = observed(new Map([[db, found]]))
    expect(stored.reads).toEqual([["cache.db", left, found], ["src/a.txt", ObservedReads.measure(`${root}/src/a.txt`)]])
    // The next run finds the file as this one found it: nothing it reads changed.
    await Fs.writeFile(db, "as put back")
    expect(ObservedReads.changed(stored, root)).toBeUndefined()
    // Or as this one left it, as before.
    await Fs.writeFile(db, "as the run left it")
    expect(ObservedReads.changed(stored, root)).toBeUndefined()
    await Fs.writeFile(db, "another")
    expect(ObservedReads.changed(stored, root)).toBe("cache.db changed")
    // Measured as it is now, or not measured, or gone before the run: what the run left is all it is held to,
    // and the row still marks a file the run changes, to be measured before the next run.
    await Fs.writeFile(db, "as the run left it")
    expect(observed(new Map([[db, left]])).reads[0]).toEqual(["cache.db", left, left])
    expect(observed().reads[0]).toEqual(["cache.db", left, left])
    expect(observed(new Map([[db, "-"]])).reads[0]).toEqual(["cache.db", left, left])
    // A file the run only read is held as it is, whatever was measured.
    expect(observed(new Map([[`${root}/src/a.txt`, found]])).reads[1]).toHaveLength(2)
  })

  it("takes a file the run moved into place for the run's own however the run spelled its directory", async () => {
    const { record, root, rows } = await setup()
    // What uv leaves in its cache: it names each directory it makes with a slash at the end, `pkg/`.
    await Fs.mkdir(Path.join(root, "cache", "pkg"), { recursive: true })
    await Fs.writeFile(Path.join(root, "cache", "pkg", "RECORD"), "written by the run")
    await Fs.writeFile(Path.join(root, "cache", "pkg", "WHEEL"), "written by the run")
    await Fs.writeFile(Path.join(root, "cache", "pkg", "METADATA"), "written by the run")
    const filled = [
      `100 mkdir("${root}/.tmp1", 0777) = 0`,
      `100 mkdir("${root}/.tmp1/pkg/", 0777) = 0`,
      open(root, `${root}/.tmp1/pkg/RECORD`, "O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC"),
      open(root, `${root}/.tmp1//pkg/WHEEL`, "O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC"),
      open(root, ".tmp1/./pkg/METADATA", "O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC"),
      `100 rename("${root}/.tmp1", "${root}/cache") = 0`,
      open(root, "cache/pkg/RECORD"),
      open(root, "cache/pkg/WHEEL"),
      open(root, "cache/pkg/METADATA")
    ]
    expect(rows(record(filled, [], 0))).toEqual({ reads: [], lists: [], left: true })
    // Each spelling names the one path the kernel resolves.
    const trace = ObservedReads.read(() => filled, root)
    expect([...trace.made.keys()].filter((path) => path.startsWith(`${root}/cache`)).sort()).toEqual([
      `${root}/cache`,
      `${root}/cache/pkg`,
      `${root}/cache/pkg/METADATA`,
      `${root}/cache/pkg/RECORD`,
      `${root}/cache/pkg/WHEEL`
    ])
    expect([...ObservedReads.read(() => [`100 mkdir("/", 0777) = -1 EEXIST (File exists)`], root).found.keys()])
      .toEqual(["/"])
    expect([...ObservedReads.read(() => [`100 openat(AT_FDCWD</>, "/.", O_RDONLY) = 3`], root).found.keys()])
      .toEqual(["/"])
    expect([...ObservedReads.read(() => [open(root, "src/.")], root).found.keys()]).toEqual([`${root}/src`])
  })

  it("keeps a name the run found missing and then made a link apart from where the link leads", async () => {
    const { record, root, rows } = await setup()
    // What an install does for each program of a package: asks whether the link is there, then makes it.
    await Fs.mkdir(Path.join(root, "bin"))
    await Fs.symlink("../src/a.txt", Path.join(root, "bin", "tool"))
    const stored = rows(record([
      `100 mkdir("${root}/bin", 0777) = 0`,
      `100 lstat("${root}/bin/tool", 0x7ffd) = -1 ENOENT (No such file or directory)`,
      `100 symlink("../src/a.txt", "${root}/bin/tool") = 0`,
      `100 openat(AT_FDCWD<${root}>, "index", O_RDONLY) = -1 ENOENT (No such file or directory)`
    ]))
    // The link is the run's own, missing before and as the run left it now; the file it leads to was never looked at.
    expect(stored).toEqual({ reads: [["bin/tool", "l:../src/a.txt", "-"], ["index", "-"]], lists: [], left: true })
    await Fs.rm(Path.join(root, "bin"), { recursive: true })
    expect(ObservedReads.changed(stored, root)).toBeUndefined()
  })

  it("holds each path the run found, each it found missing, and each listing", async () => {
    const { outside, record, root, rows } = await setup()
    const stored = rows(record([
      open(root, "src/a.txt"),
      absent(root, "src/missing.txt"),
      absent(root, "nowhere/below/it.txt"),
      open(root, outside),
      `100 getdents64(3<${root}/src>, 0x55 /* 4 entries */, 32768) = 100`,
      `100 newfstatat(AT_FDCWD<${root}>, ".", {st_mode=S_IFDIR|0755, ...}, 0) = 0`,
      "100 openat(AT_FDCWD</proc/self>, \"/proc/self/maps\", O_RDONLY) = 3",
      "100 readlink(\"/proc/self/exe\", \"/usr/bin/node\", 4096) = 13"
    ]))
    expect(stored.reads).toEqual([
      [outside, ObservedReads.measure(outside)],
      [".", "d"],
      ["nowhere/below/it.txt", "-"],
      ["src", "d"],
      ["src/a.txt", ObservedReads.measure(Path.join(root, "src", "a.txt"))],
      ["src/missing.txt", "-"]
    ])
    expect(stored.lists).toEqual([["src", ObservedReads.listing(Path.join(root, "src"), []), []]])
    expect(ObservedReads.changed(stored, root)).toBeUndefined()

    // A changed file, a path that now exists, a new entry in a listed directory.
    await Fs.writeFile(Path.join(root, "src", "a.txt"), "changed")
    expect(ObservedReads.changed(stored, root)).toBe("src/a.txt changed")
    await Fs.writeFile(Path.join(root, "src", "a.txt"), "a")
    await Fs.writeFile(Path.join(root, "src", "missing.txt"), "now here")
    expect(ObservedReads.changed(stored, root)).toBe("src/missing.txt now exists")
    await Fs.rm(Path.join(root, "src", "missing.txt"))
    await Fs.writeFile(Path.join(root, "src", "c.txt"), "new")
    expect(ObservedReads.changed(stored, root)).toBe("src gained or lost an entry")
    await Fs.rm(Path.join(root, "src", "c.txt"))
    await Fs.rm(outside)
    expect(ObservedReads.changed(stored, root)).toBe(`${outside} is gone`)
    await Fs.writeFile(outside, "outside")
    expect(ObservedReads.changed(stored, root, ObservedReads.remembering())).toBeUndefined()
  })

  it("measures a path outside the workspace as its caller says, and a path inside it itself", async () => {
    const { outside, root } = await setup()
    const asked: Array<string> = []
    const trace = ObservedReads.read(() => [open(root, outside), open(root, "src/a.txt")], root)
    const options = { root, ignore: [], startedMs: Date.now() + 60_000 }
    // A build remembers what it measured of a tool: it is asked for the path outside, and its answer is the record's.
    const remembered = ObservedReads.record(trace, {
      ...options,
      outside: (path) => {
        asked.push(path)
        return "f:remembered"
      }
    })
    expect(asked).toEqual([outside])
    expect("refusal" in remembered ? [] : remembered.reads).toEqual([
      [outside, "f:remembered"],
      ["src/a.txt", ObservedReads.measure(Path.join(root, "src", "a.txt"))]
    ])
    // With nobody to ask, every path is measured where it is.
    const plain = ObservedReads.record(trace, options)
    expect("refusal" in plain ? [] : plain.reads[0]).toEqual([outside, ObservedReads.measure(outside)])
  })

  it("holds the commit's own files first, then the workspace's smallest, and reads no more once one differs", async () => {
    const { outside, record, root, rows } = await setup()
    await Fs.writeFile(Path.join(root, "src", "large.txt"), "l".repeat(4096))
    await Fs.writeFile(Path.join(root, "src", "small.txt"), "s")
    await Fs.writeFile(Path.join(root, "src", "own.txt"), "o".repeat(8192))
    const stored = rows(record([
      open(root, outside),
      open(root, "src/large.txt"),
      open(root, "src/small.txt"),
      open(root, "src/own.txt"),
      absent(root, "src/missing.txt")
    ]))
    /** The paths that were measured, in order. */
    const measured: Array<string> = []
    const measuring = (path: string): string => {
      measured.push(Path.relative(root, path))
      return ObservedReads.measure(path)
    }
    const held = (own?: (path: string) => boolean): string | undefined => {
      measured.length = 0
      return ObservedReads.changed(stored, root, measuring, ObservedReads.defaultIo, undefined, {}, own)
    }
    // Nothing differs: every path is measured, the workspace's before the one outside it, the smallest first.
    expect(held()).toBeUndefined()
    expect(measured).toEqual(["src/missing.txt", "src/small.txt", "src/large.txt", "src/own.txt", "../outside.txt"])
    // Every file differs. The first one found is named, and nothing after it is read.
    for (const name of ["src/large.txt", "src/small.txt", "src/own.txt"]) {
      await Fs.appendFile(Path.join(root, name), "changed")
    }
    await Fs.appendFile(outside, "changed")
    expect(held()).toBe("src/small.txt changed")
    expect(measured).toEqual(["src/missing.txt", "src/small.txt"])
    // A caller that knows the commit's own files has them held first: the tools and packages are never read.
    expect(held((path) => path === "src/own.txt")).toBe("src/own.txt changed")
    expect(measured).toEqual(["src/own.txt"])
  })

  it("asks nothing of the other paths when one of the commit's own files differs", async () => {
    const { outside, record, root, rows } = await setup()
    await Fs.writeFile(Path.join(root, "src", "own.txt"), "own")
    const stored = rows(record([open(root, outside), open(root, "src/a.txt"), open(root, "src/own.txt")]))
    await Fs.appendFile(Path.join(root, "src", "own.txt"), "changed")
    const asked: Array<string> = []
    const io: ObservedReads.Io = {
      ...ObservedReads.defaultIo,
      lstat: (path) => {
        asked.push(Path.relative(root, path))
        return ObservedReads.defaultIo.lstat(path)
      }
    }
    const own = (path: string): boolean => path === "src/own.txt"
    expect(ObservedReads.changed(stored, root, ObservedReads.measure, io, undefined, {}, own)).toBe(
      "src/own.txt changed"
    )
    // Only the commit's own file is sized; the workspace's other files and the tools outside it are not.
    expect(asked).toEqual(["src/own.txt"])
  })

  it("leaves out what the run made, and accepts a path it found missing and then made", async () => {
    const { record, root, rows } = await setup()
    await Fs.writeFile(Path.join(root, "src", "out.txt"), "output")
    await Fs.writeFile(Path.join(root, "src", "cache.json"), "{}")
    await Fs.mkdir(Path.join(root, "dist"))
    await Fs.writeFile(Path.join(root, "dist", "bundle.js"), "bundle")
    const stored = rows(record([
      // Written first, read later: the run's own product.
      open(root, "src/out.txt", "O_WRONLY|O_CREAT|O_TRUNC, 0666"),
      open(root, "src/out.txt"),
      // Found missing, then made: either state is the run's own doing.
      absent(root, "src/cache.json"),
      open(root, "src/cache.json", "O_WRONLY|O_CREAT|O_EXCL, 0666"),
      // A directory the run made and then listed is its own.
      `100 mkdir("${root}/dist", 0777) = 0`,
      `100 getdents64(3<${root}/dist>, 0x55 /* 3 entries */, 32768) = 80`,
      // A directory it lists and writes into is compared without the names it wrote.
      `100 getdents64(3<${root}/src>, 0x55 /* 4 entries */, 32768) = 100`,
      // Read and then rewritten: compared with what the run left, and marked as a file the run changes.
      open(root, "src/b.txt"),
      open(root, "src/b.txt", "O_WRONLY|O_TRUNC"),
      // Removed without ever being read, and made at the top of the file system: neither is an input.
      `100 unlink("${root}/src/scratch.tmp") = 0`,
      "100 mkdir(\"/smithers-observed-reads-made\", 0777) = 0"
    ]))
    const cache = ObservedReads.measure(Path.join(root, "src", "cache.json"))
    const rewritten = ObservedReads.measure(Path.join(root, "src", "b.txt"))
    expect(stored.reads).toEqual([
      ["src", "d"],
      ["src/b.txt", rewritten, rewritten],
      ["src/cache.json", cache, "-"]
    ])
    expect(stored.lists).toEqual([
      ["src", ObservedReads.listing(Path.join(root, "src"), ["b.txt", "cache.json", "out.txt", "scratch.tmp"]), [
        "b.txt",
        "cache.json",
        "out.txt",
        "scratch.tmp"
      ]]
    ])
    // A fresh checkout, without what the run wrote, still matches.
    await Fs.rm(Path.join(root, "src", "cache.json"))
    await Fs.rm(Path.join(root, "src", "out.txt"))
    await Fs.rm(Path.join(root, "dist"), { recursive: true })
    expect(ObservedReads.changed(stored, root)).toBeUndefined()
    await Fs.writeFile(Path.join(root, "src", "cache.json"), "{\"other\":true}")
    expect(ObservedReads.changed(stored, root)).toBe("src/cache.json changed")
  })

  it("keeps a path found missing that something else made", async () => {
    const { record, root, rows } = await setup()
    const stored = rows(record([absent(root, "src/a.txt")]))
    expect(stored.reads).toEqual([["src/a.txt", "-"]])
    expect(ObservedReads.changed(stored, root)).toBe("src/a.txt now exists")
  })

  it("follows links and parent steps the way the kernel does", async () => {
    const { base, record, root, rows } = await setup()
    await Fs.mkdir(Path.join(base, "real", "deep"), { recursive: true })
    await Fs.writeFile(Path.join(base, "real", "beside.txt"), "beside")
    await Fs.symlink(Path.join(base, "real", "deep"), Path.join(root, "into"))
    await Fs.symlink("src/a.txt", Path.join(root, "alias"))
    const stored = rows(record([
      // `into/..` is the parent of where the link points, not of the link.
      open(root, "into/../beside.txt"),
      open(root, "alias"),
      open(root, "./src/../src/b.txt"),
      open(root, "/")
    ]))
    expect(stored.reads.map((row) => row[0])).toEqual([
      "/",
      Path.join(base, "real", "beside.txt"),
      "alias",
      "into",
      "src/a.txt",
      "src/b.txt"
    ])
    expect(stored.reads.find((row) => row[0] === "alias")).toEqual(["alias", "l:src/a.txt"])
    // Pointing the link elsewhere changes what the run would read.
    await Fs.rm(Path.join(root, "alias"))
    await Fs.symlink("src/b.txt", Path.join(root, "alias"))
    expect(ObservedReads.changed(stored, root)).toBe("alias changed")
  })

  describe("an openat2 with RESOLVE flags", () => {
    /** A tree to walk: `r` holds files, a directory, and links of each kind. */
    const tree = async () => {
      const made = await setup()
      const r = Path.join(made.root, "r")
      await Fs.mkdir(Path.join(r, "sub"), { recursive: true })
      await Fs.writeFile(Path.join(r, "x.txt"), "ok")
      await Fs.writeFile(Path.join(r, "sub", "y.txt"), "ok")
      await Fs.symlink("/sub/y.txt", Path.join(r, "abs"))
      await Fs.symlink("../../../x.txt", Path.join(r, "sub", "up"))
      await Fs.symlink("sub/y.txt", Path.join(r, "rel"))
      await Fs.symlink(Path.join(made.root, "src", "a.txt"), Path.join(r, "far"))
      await Fs.symlink("loop", Path.join(r, "loop"))
      const at2 = (path: string, resolve: string, answer: string, flags = "O_RDONLY", base = `3<${r}>`): string =>
        `100 openat2(${base}, ${JSON.stringify(path)}, {flags=${flags}, resolve=${resolve}}, 24) = ${answer}`
      const opened = (path: string): string => `4<${Path.join(r, path)}>`
      const names = (stored: ReturnType<typeof made.rows>) => stored.reads.map((row) => row[0])
      return { ...made, r, at2, opened, names }
    }

    it("walks the path as the kernel does, inside the directory it starts from", async () => {
      const { at2, names, opened, record, root, rows, r } = await tree()
      const stored = rows(record([
        // `/x.txt` inside r is r/x.txt; `..` at r stays at r.
        at2("/x.txt", "RESOLVE_IN_ROOT", opened("x.txt")),
        at2("../../x.txt", "RESOLVE_IN_ROOT", opened("x.txt")),
        // An absolute link leads from r; a relative one from where it is; `..` past r stays at r.
        at2("abs", "RESOLVE_IN_ROOT|RESOLVE_NO_MAGICLINKS", opened("sub/y.txt"), "O_RDONLY|O_CLOEXEC"),
        at2("rel", "RESOLVE_IN_ROOT", opened("sub/y.txt")),
        at2("sub/up", "RESOLVE_IN_ROOT|RESOLVE_CACHED", opened("x.txt")),
        // With no RESOLVE_IN_ROOT, an absolute path and an absolute link start from the machine's root.
        at2(Path.join(root, "src", "b.txt"), "RESOLVE_NO_XDEV", `4<${root}/src/b.txt>`),
        at2("far", "RESOLVE_NO_XDEV", `4<${root}/src/a.txt>`),
        // Not followed at the end, a link is what the call opened.
        at2("rel", "RESOLVE_IN_ROOT", opened("rel"), "O_RDONLY|O_NOFOLLOW|O_PATH")
      ]))
      expect(names(stored)).toEqual([
        "r/abs",
        "r/far",
        "r/rel",
        "r/sub",
        "r/sub/up",
        "r/sub/y.txt",
        "r/x.txt",
        "src/a.txt",
        "src/b.txt"
      ])
      expect(stored.reads.find((row) => row[0] === "r/sub")).toEqual(["r/sub", "d"])
      expect(ObservedReads.changed(stored, root)).toBeUndefined()
      // What the walk read decides the file: the file itself, a link on the way, a directory made a link.
      await Fs.writeFile(Path.join(r, "sub", "y.txt"), "bad!")
      expect(ObservedReads.changed(stored, root)).toBe("r/sub/y.txt changed")
      await Fs.writeFile(Path.join(r, "sub", "y.txt"), "ok")
      await Fs.rm(Path.join(r, "abs"))
      await Fs.symlink("/x.txt", Path.join(r, "abs"))
      expect(ObservedReads.changed(stored, root)).toBe("r/abs changed")
    })

    it("notes what the walk read up to where the call failed", async () => {
      const { at2, names, opened, record, rows } = await tree()
      const failed = (error: string): string => `-1 ${error} (failed)`
      expect(names(rows(record([
        // RESOLVE_BENEATH: an absolute path, a `..` out of r, and an absolute link all end the walk.
        at2("/x.txt", "RESOLVE_BENEATH", failed("EXDEV")),
        at2("../x.txt", "RESOLVE_BENEATH", failed("EXDEV")),
        at2("abs", "RESOLVE_BENEATH", failed("EXDEV")),
        at2("sub/../x.txt", "RESOLVE_BENEATH", opened("x.txt")),
        // RESOLVE_NO_SYMLINKS ends at the first link, and a link to itself at the kernel's limit.
        at2("rel", "RESOLVE_NO_SYMLINKS", failed("ELOOP")),
        at2("loop", "RESOLVE_IN_ROOT", failed("ELOOP")),
        // A file is no directory to walk on from.
        at2("x.txt/y", "RESOLVE_IN_ROOT", failed("ENOTDIR")),
        // A name missing on the way, or at the end.
        at2("none/y", "RESOLVE_IN_ROOT", failed("ENOENT")),
        at2("gone.txt", "RESOLVE_IN_ROOT", failed("ENOENT"))
      ])))).toEqual(["r/abs", "r/gone.txt", "r/loop", "r/none", "r/rel", "r/sub", "r/x.txt"])
    })

    it("counts what the call wrote as the run's own, and the names it walked by as read", async () => {
      const { at2, names, opened, r, record, rows } = await tree()
      await Fs.writeFile(Path.join(r, "sub", "made.txt"), "the run's")
      await Fs.writeFile(Path.join(r, "sub", "kept.txt"), "the run's")
      const stored = rows(record([
        at2("sub/made.txt", "RESOLVE_IN_ROOT", opened("sub/made.txt"), "O_WRONLY|O_CREAT|O_EXCL"),
        at2("sub/kept.txt", "RESOLVE_IN_ROOT", opened("sub/kept.txt"), "O_WRONLY|O_CREAT|O_TRUNC"),
        at2("x.txt", "RESOLVE_IN_ROOT", opened("x.txt"), "O_RDWR"),
        at2("sub/y.txt", "RESOLVE_IN_ROOT", opened("sub/y.txt"), "O_WRONLY"),
        // A write the kernel refused wrote nothing; an unnamed file names no file.
        at2("sub/no.txt", "RESOLVE_IN_ROOT", "-1 EACCES (Permission denied)", "O_WRONLY|O_CREAT"),
        at2("sub", "RESOLVE_IN_ROOT", "4</nowhere/#1 (deleted)>", "O_RDWR|O_TMPFILE")
      ]))
      expect(names(stored)).toEqual(["r/sub", "r/x.txt"])
      expect(stored.reads.find((row) => row[0] === "r/x.txt")).toHaveLength(3)
    })

    it("leaves out what a quiet process and an ignored directory walked", async () => {
      const { at2, opened, r, root } = await tree()
      const lines = [
        `100 execve("/bin/tool", ["tool", "--quiet"], 0x0 /* 0 vars */) = 0`,
        at2("x.txt", "RESOLVE_IN_ROOT", opened("x.txt")),
        at2("sub/y.txt", "RESOLVE_IN_ROOT", opened("sub/y.txt")).replace(/^100/, "200")
      ]
      const quiet = ObservedReads.record(ObservedReads.read(() => lines, root, ["--quiet"]), {
        root,
        ignore: [Path.join(r, "sub")],
        startedMs: Date.now() + 60_000
      })
      if ("refusal" in quiet) throw new Error(quiet.refusal)
      expect(quiet.reads.map((row) => row[0]).filter((path) => path.startsWith("r"))).toEqual([])
    })

    it("stores nothing when the walk cannot be followed, or ends elsewhere than the call's answer", async () => {
      const { at2, opened, record, r } = await tree()
      const refusal = (line: string) => record([line])
      expect(refusal(at2("x.txt", "RESOLVE_IN_ROOT|0x40", opened("x.txt")))).toEqual({
        refusal: ObservedReads.cannotFollow("openat2 with 0x40")
      })
      expect(refusal(at2("self/cwd", "RESOLVE_IN_ROOT", "4</w>", "O_RDONLY", "3</proc>"))).toEqual({
        refusal: ObservedReads.cannotFollow("openat2 with RESOLVE flags through /proc/self")
      })
      expect(refusal("100 openat2(3</r>, 0x7ffc, {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = -1 EFAULT (Bad)"))
        .toEqual({ refusal: "its trace holds a path that cannot be read: 0x7ffc" })
      expect(refusal(at2("x.txt", "RESOLVE_IN_ROOT", "4", "O_RDONLY", "3"))).toEqual({
        refusal: "its trace does not say which directory \"x.txt\" was read from"
      })
      expect(refusal(at2("x.txt", "RESOLVE_IN_ROOT", "4"))).toEqual({
        refusal: "its trace does not say which file \"x.txt\" opened"
      })
      expect(refusal(at2("x.txt", "RESOLVE_IN_ROOT", opened("sub/y.txt")))).toEqual({
        refusal: "its trace does not say where x.txt led"
      })
      expect(refusal(at2("../x.txt", "RESOLVE_BENEATH", opened("x.txt")))).toEqual({
        refusal: "its trace does not say where ../x.txt led"
      })
      // A path from a directory so deep that the two are longer than a call takes cannot be measured again; one the
      // call failed on for its length read nothing.
      const deep = `/${"d".repeat(4090)}`
      expect(refusal(at2("x.txt", "RESOLVE_IN_ROOT", `4<${deep}/x.txt>`, "O_RDONLY", `3<${deep}>`))).toEqual({
        refusal: ObservedReads.cannotFollow("a path longer than 4095 bytes")
      })
      expect(record([at2("x".repeat(4100), "RESOLVE_IN_ROOT", "-1 ENAMETOOLONG (File name too long)")]))
        .not.toHaveProperty("refusal")
      // So for any path a run read or wrote from such a directory.
      expect(record([`100 openat(3<${deep}>, "x.txt", O_RDONLY) = 4<${deep}/x.txt>`])).toEqual({
        refusal: ObservedReads.cannotFollow("a path longer than 4095 bytes")
      })
      expect(record([`100 openat(3<${deep}>, "x.txt", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 4<${deep}/x.txt>`])).toEqual({
        refusal: ObservedReads.cannotFollow("a path longer than 4095 bytes")
      })
      // A file the call opened and the run then removed was read, and is gone.
      expect(refusal(at2("removed.txt", "RESOLVE_IN_ROOT", opened("removed.txt")))).toEqual({
        refusal: "r/removed.txt was removed while it ran"
      })
      // With no RESOLVE flag, or none named, openat2 is an open; a line with no flags names none.
      expect(record([at2(`${r}/x.txt`, "0", "4")])).not.toHaveProperty("refusal")
      expect(record([`100 openat2(3<${r}>, "x.txt") = -1 EINVAL (Invalid argument)`])).not.toHaveProperty("refusal")
      expect(record([`100 openat2(3<${r}>, "x.txt", {resolve=RESOLVE_IN_ROOT}, 24) = ${opened("x.txt")}`]))
        .not.toHaveProperty("refusal")
    })
  })

  it("holds a link the run looked at without following it, wherever it leads", async () => {
    const { record, root, rows } = await setup()
    await Fs.symlink("nowhere", Path.join(root, "dangling"))
    const stored = rows(record([
      `100 newfstatat(AT_FDCWD<${root}>, "dangling", {st_mode=S_IFLNK|0777, ...}, AT_SYMLINK_NOFOLLOW) = 0`,
      `100 readlinkat(AT_FDCWD<${root}>, "dangling", "nowhere", 4096) = 7`
    ]))
    expect(stored.reads).toEqual([["dangling", "l:nowhere"]])
    await Fs.rm(Path.join(root, "dangling"))
    await Fs.symlink("elsewhere", Path.join(root, "dangling"))
    expect(ObservedReads.changed(stored, root)).toBe("dangling changed")
  })

  describe("a renameat2 with flags", () => {
    const rename = (root: string, from: string, to: string, flags: string, answer = "0"): string =>
      `100 renameat2(AT_FDCWD<${root}>, ${JSON.stringify(from)}, AT_FDCWD<${root}>, ${
        JSON.stringify(to)
      }, ${flags}) = ${answer}`

    it("reads both names RENAME_EXCHANGE swaps, and counts both as written", async () => {
      const { record, root, rows } = await setup()
      const stored = rows(record([
        rename(root, "src/a.txt", "src/b.txt", "RENAME_EXCHANGE"),
        open(root, "src/a.txt"),
        rename(root, "src/a.txt", "src/b.txt", "RENAME_EXCHANGE")
      ]))
      expect(stored.reads.map((row) => row.slice(0, 1))).toEqual([["src/a.txt"], ["src/b.txt"]])
      // What the run read under a.txt was b.txt's.
      await Fs.writeFile(Path.join(root, "src", "b.txt"), "bad!")
      expect(ObservedReads.changed(stored, root)).toBe("src/b.txt changed")
      // A swap that failed found both names missing.
      expect(rows(record([rename(root, "src/no", "src/none", "RENAME_EXCHANGE", "-1 ENOENT (No such file)")])).reads)
        .toEqual([["src/no", "-"], ["src/none", "-"]])
    })

    it("stores nothing when RENAME_EXCHANGE swapped a directory, or a flag is unknown", async () => {
      const { record, root } = await setup()
      await Fs.mkdir(Path.join(root, "other"))
      expect(record([rename(root, "src", "other", "RENAME_EXCHANGE")])).toEqual({
        refusal: ObservedReads.cannotFollow("renameat2 with RENAME_EXCHANGE of a directory")
      })
      // A name gone by the end may have been a directory.
      expect(record([rename(root, "src/a.txt", "src/gone", "RENAME_EXCHANGE")])).toEqual({
        refusal: ObservedReads.cannotFollow("renameat2 with RENAME_EXCHANGE of a directory")
      })
      expect(record([rename(root, "/dev/shm/a", "src/b.txt", "RENAME_EXCHANGE")])).toEqual({
        refusal: ObservedReads.cannotFollow("renameat2 with RENAME_EXCHANGE of a directory")
      })
      expect(record([rename(root, "src/a.txt", "src/b.txt", "RENAME_EXCHANGE|0x8")])).toEqual({
        refusal: ObservedReads.cannotFollow("renameat2 with 0x8")
      })
    })

    it("reads the name RENAME_NOREPLACE found there, and makes the one it did not", async () => {
      const { record, root, rows } = await setup()
      const stored = rows(record([
        rename(root, "src/a.txt", "src/b.txt", "RENAME_NOREPLACE", "-1 EEXIST (File exists)"),
        rename(root, "src/a.txt", "src/c.txt", "RENAME_NOREPLACE|RENAME_WHITEOUT"),
        rename(root, "src/c.txt", "src/d.txt", "0"),
        // A line with no flags moves as renameat does.
        `100 renameat2(AT_FDCWD<${root}>, "src/d.txt", AT_FDCWD<${root}>, "src/e.txt") = 0`
      ]))
      expect(stored.reads.map((row) => row[0])).toEqual(["src/a.txt", "src/b.txt"])
    })
  })

  it("reads a path the run named under a mounted directory where that directory really is", async () => {
    // A run on a machine finds the machine's temporary directory at `/shared`: what it named there is the machine's.
    const { base, outside, root } = await setup()
    const own = Path.join(base, "own")
    await Fs.mkdir(Path.join(own, "deep"), { recursive: true })
    await Fs.writeFile(Path.join(own, "note"), "note")
    await Fs.writeFile(Path.join(own, "run.sh"), `#!${outside}\n`, { mode: 0o755 })
    // A link in the mounted directory that names it by the name the run knows, and one that leads out of it.
    await Fs.symlink("/shared/note", Path.join(own, "again"))
    await Fs.symlink("../../.." + outside, Path.join(own, "deep", "out"))
    const recorded = (lines: ReadonlyArray<string>, mounts?: ReadonlyArray<readonly [string, string]>) =>
      ObservedReads.record(ObservedReads.read(() => lines, root), {
        root,
        ignore: [],
        startedMs: Date.now() + 60_000,
        ...(mounts === undefined ? {} : { mounts })
      })
    const read = (lines: ReadonlyArray<string>, mounts: ReadonlyArray<readonly [string, string]>) => {
      const value = recorded(lines, mounts)
      if ("refusal" in value) throw new Error(value.refusal)
      return value.reads.map((row) => row[0])
    }
    const lines = [
      `100 openat(AT_FDCWD<${root}>, "/shared/note", O_RDONLY) = 3`,
      `100 openat(AT_FDCWD<${root}>, "/shared", O_RDONLY|O_DIRECTORY) = 3`,
      `100 openat(AT_FDCWD<${root}>, "/shared/again", O_RDONLY) = 3`,
      `100 openat(AT_FDCWD<${root}>, "/shared/deep/out", O_RDONLY) = 3`,
      // Above the mounted directory is what is above the name the run knows it by, not above where it is.
      `100 openat(AT_FDCWD<${root}>, "/shared/..${outside}", O_RDONLY) = 3`,
      `100 openat(AT_FDCWD<${root}>, "/shared/none", O_RDONLY) = -1 ENOENT (No such file or directory)`,
      `100 execve("/shared/run.sh", ["run.sh"], 0x7ffd /* 3 vars */) = 0`
    ]
    const placed = read(lines, [["/shared", own]])
    for (const name of ["note", "again", "deep/out", "none", "run.sh"]) expect(placed).toContain(Path.join(own, name))
    expect(placed).toContain(own)
    // The file outside is one path, by the link, by the way up, and as the script's interpreter.
    expect(placed.filter((path) => path === outside)).toEqual([outside])
    expect(placed.some((path) => path.startsWith("/shared"))).toBe(false)
    // A directory mounted below another, looked at without following it: the name is where its own mount says.
    const inner = Path.join(base, "inner")
    await Fs.mkdir(inner)
    expect(read([
      `100 newfstatat(AT_FDCWD<${root}>, "/shared/inner", {st_mode=S_IFDIR|0755, ...}, AT_SYMLINK_NOFOLLOW) = 0`,
      `100 newfstatat(AT_FDCWD<${root}>, "/shared/gone", {...}, AT_SYMLINK_NOFOLLOW) = -1 ENOENT (No such file)`
    ], [["/shared/inner", inner], ["/shared", own]])).toEqual([inner, Path.join(own, "gone")])
    // With nothing mounted the same names are the host's own, where there is no such directory: the run read what
    // nobody can find again, and stores nothing.
    expect(recorded(lines)).toEqual({ refusal: "/shared was removed while it ran" })
  })

  it("stores nothing when a path the run reached is longer than the system can look at", async () => {
    const { root } = await setup()
    // A step that entered directories one name at a time past PATH_MAX and made a link there: the reader joins the
    // path, and the host refuses to look at it. Here the host's answer for one path stands in for that.
    const long = Path.join(root, "src", "a.txt")
    const io: ObservedReads.Io = {
      ...ObservedReads.defaultIo,
      lstat: (path) => {
        if (path === long) throw Object.assign(new Error("name too long"), { code: "ENAMETOOLONG" })
        return ObservedReads.defaultIo.lstat(path)
      }
    }
    const observed = ObservedReads.observe(ObservedReads.read(() => [open(root, "src/a.txt")], root), {
      root,
      ignore: [],
      startedMs: Date.now() + 60_000,
      io
    })
    expect(observed).toEqual({
      refusal: "it reached src/a.txt…, a path longer than this system can look at"
    })
    // Read as it is, the same trace is stored.
    expect(
      ObservedReads.observe(ObservedReads.read(() => [open(root, "src/a.txt")], root), {
        root,
        ignore: [],
        startedMs: Date.now() + 60_000
      })
    ).not.toHaveProperty("refusal")
  })

  it("stores nothing for a path that passes through links without end", async () => {
    const { record, root } = await setup()
    await Fs.symlink("loop-b", Path.join(root, "loop-a"))
    await Fs.symlink("loop-a", Path.join(root, "loop-b"))
    expect(record([open(root, "loop-a/file")])).toEqual({
      refusal: `${root}/loop-a/file passes through too many symbolic links`
    })
    expect(record([`100 unlink("${root}/loop-a/file") = 0`])).toEqual({
      refusal: `${root}/loop-a passes through too many symbolic links`
    })
    expect(record([`100 truncate("${root}/loop-a", 0) = 0`])).toEqual({
      refusal: `${root}/loop-a passes through too many symbolic links`
    })
  })

  it.skipIf(process.platform !== "linux")("leaves out a link the kernel's own file system holds", async () => {
    const { record, root, rows } = await setup()
    await Fs.symlink("/dev/stdout", Path.join(root, "out"))
    expect(rows(record([open(root, "out")])).reads).toEqual([["out", "l:/dev/stdout"]])
  })

  it("leaves out the paths a declaration ignores and the kernel's own", async () => {
    const { record, root, rows } = await setup()
    const stored = rows(record(
      [
        open(root, "src/a.txt"),
        open(root, "src/b.txt"),
        `100 getdents64(3<${root}/src>, 0x55 /* 4 entries */, 32768) = 100`,
        "100 openat(AT_FDCWD</sys/fs>, \"/sys/fs/cgroup/memory.max\", O_RDONLY) = 3",
        "100 openat(AT_FDCWD</dev>, \"/dev/null\", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3",
        "100 openat(AT_FDCWD</dev>, \"/dev/null\", O_RDWR) = 3"
      ],
      [Path.join(root, "src")]
    ))
    expect(stored).toEqual({ reads: [], lists: [] })
  })

  it("stores nothing when a path it read was changed or removed by something else", async () => {
    const { record, root, rows } = await setup()
    // The run began before the file was last written, and the run did not write it.
    expect(record([open(root, "src/a.txt")], [], Date.now() - 60_000))
      .toEqual({ refusal: "src/a.txt changed while it ran" })
    expect(record([`100 getdents64(3<${root}/src>, 0x55 /* 4 entries */, 32768) = 100`], [], Date.now() - 60_000))
      .toEqual({ refusal: "src changed while it ran" })
    // A directory the run listed, removed and made again is the run's own change, as a CI runner's script does
    // with the state an earlier run left: it is compared with what the run left there.
    const remade = rows(record(
      [
        `100 getdents64(3<${root}/src>, 0x55 /* 4 entries */, 32768) = 100`,
        `100 unlinkat(AT_FDCWD<${root}>, "src", AT_REMOVEDIR) = 0`,
        `100 mkdir("${root}/src", 0777) = 0`
      ],
      [],
      Date.now() - 60_000
    ))
    expect(remade.lists.map(([path, , own]) => [path, own])).toEqual([["src", []]])
    expect(record([open(root, "src/a.txt"), open(root, "src/a.txt", "O_RDWR")], [], Date.now() - 60_000))
      .toEqual({
        reads: [["src/a.txt", ...Array(2).fill(ObservedReads.measure(Path.join(root, "src", "a.txt")))]],
        lists: [],
        left: true
      })
    await Fs.rm(Path.join(root, "src", "b.txt"))
    expect(record([open(root, "src/b.txt")])).toEqual({ refusal: "src/b.txt was removed while it ran" })
    // A path the run itself removed is compared as the run left it: gone.
    expect(record([open(root, "src/b.txt"), `100 unlink("${root}/src/b.txt") = 0`]))
      .toEqual({ reads: [["src/b.txt", "-"]], lists: [] })
    // A listed directory that is gone by the end has no listing to compare.
    expect(record([
      `100 getdents64(3<${root}/gone>, 0x55 /* 2 entries */, 32768) = 48`,
      `100 rmdir("${root}/gone") = 0`
    ])).toEqual({ reads: [["gone", "-"]], lists: [] })
  })

  it("repeats why a trace cannot be trusted", async () => {
    const { record } = await setup()
    expect(record(["garbage"])).toEqual({ refusal: "its trace holds a line that cannot be read: garbage" })
  })

  it.skipIf(process.platform === "win32")("counts the programs the kernel starts for a script", async () => {
    const { base, record, root, rows } = await setup()
    const interpreter = Path.join(base, "interpreter")
    await Fs.writeFile(interpreter, "#!/bin/sh\n", { mode: 0o755 })
    await Fs.writeFile(Path.join(root, "run.sh"), `#! ${interpreter} -x\n`, { mode: 0o755 })
    await Fs.writeFile(Path.join(root, "loop.sh"), `#!${root}/loop.sh\n`, { mode: 0o755 })
    await Fs.writeFile(Path.join(root, "relative.sh"), "#!sh\n", { mode: 0o755 })
    await Fs.writeFile(Path.join(root, "plain.bin"), "no interpreter line", { mode: 0o755 })
    const stored = rows(record([
      `100 execve("${root}/run.sh", ["run.sh"], 0x7ffd /* 3 vars */) = 0`,
      `100 execve("${root}/loop.sh", ["loop.sh"], 0x7ffd /* 3 vars */) = 0`,
      `100 execve("${root}/relative.sh", ["relative.sh"], 0x7ffd /* 3 vars */) = 0`,
      `100 execve("${root}/plain.bin", ["plain.bin"], 0x7ffd /* 3 vars */) = 0`
    ]))
    const read = stored.reads.map((row) => row[0])
    expect(read).toContain(interpreter)
    expect(read).toContain("run.sh")
    // `/bin/sh` is what starts the interpreter; on most hosts it is a link.
    expect(read.some((path) => path === "/bin/sh" || path === "/usr/bin/sh" || path === "/bin")).toBe(true)
    // A program that is gone by the end of the run names nothing, and the run stores nothing.
    expect(record([`100 execve("${root}/vanished", ["vanished"], 0x7ffd /* 3 vars */) = ?`]))
      .toEqual({ refusal: "vanished was removed while it ran" })
  })

  it.skipIf(process.platform !== "linux")("counts the loader a linked program names", async () => {
    const { record, rows } = await setup()
    const stored = rows(record([`100 execve("${process.execPath}", ["node"], 0x7ffd /* 3 vars */) = 0`]))
    expect(stored.reads.some((row) => /ld-linux|ld-musl|ld\.so/.test(row[0]))).toBe(true)
  })

  it("reads no loader from a file that only starts like a program", async () => {
    const { record, root, rows } = await setup()
    // A 64-bit header whose program headers do not name a loader, and one too short to hold any.
    const header = Buffer.alloc(200)
    header.writeUInt32BE(0x7f454c46, 0)
    header[4] = 2
    header[5] = 1
    header.writeBigUInt64LE(64n, 0x20)
    header.writeUInt16LE(56, 0x36)
    header.writeUInt16LE(2, 0x38)
    header.writeUInt32LE(1, 64)
    header.writeUInt32LE(3, 120)
    header.writeBigUInt64LE(100_000n, 128)
    header.writeBigUInt64LE(10n, 152)
    await Fs.writeFile(Path.join(root, "static.bin"), header, { mode: 0o755 })
    const far = Buffer.from(header)
    far.writeUInt16LE(9, 0x38)
    await Fs.writeFile(Path.join(root, "far.bin"), far, { mode: 0o755 })
    const stored = rows(record([
      `100 execve("${root}/static.bin", ["static.bin"], 0x7ffd /* 3 vars */) = 0`,
      `100 execve("${root}/far.bin", ["far.bin"], 0x7ffd /* 3 vars */) = 0`
    ]))
    expect(stored.reads.map((row) => row[0])).toEqual(["far.bin", "static.bin"])
  })
})

describe("what a run read that an earlier step wrote", () => {
  /** A workspace after an install step: a tree it made, a file it wrote beside the sources, and one it rewrote. */
  const installed = async () => {
    const root = Path.join(await directory(), "ws")
    const write = async (name: string, text: string): Promise<void> => {
      await Fs.mkdir(Path.dirname(Path.join(root, name)), { recursive: true })
      await Fs.writeFile(Path.join(root, name), text)
    }
    await write("src/a.txt", "a")
    await write("src/generated.js", "generated")
    await write("node_modules/pkg/index.js", "package")
    await write("lock.json", "lock")
    await write("stamp.txt", "stamp")
    const install: ObservedReads.Producer = {
      label: "//:install",
      id: "install-1",
      made: new Set([Path.join(root, "node_modules")]),
      touched: new Set([Path.join(root, "node_modules"), Path.join(root, "stamp.txt")])
    }
    const build: ObservedReads.Producer = {
      label: "//:build",
      id: "build-1",
      made: new Set(),
      touched: new Set([Path.join(root, "src/generated.js"), Path.join(root, "stamp.txt")])
    }
    const unused: ObservedReads.Producer = { label: "//:unused", id: "unused-1", made: new Set(), touched: new Set() }
    const open = (name: string): string => `100 openat(AT_FDCWD<${root}>, ${JSON.stringify(name)}, O_RDONLY) = 3`
    const list = (name: string): string =>
      `100 getdents64(3<${Path.join(root, name)}>, 0x55 /* 4 entries */, 32768) = 100`
    const observe = (lines: ReadonlyArray<string>, producers: ReadonlyArray<ObservedReads.Producer>) => {
      const observed = ObservedReads.observe(ObservedReads.read(() => lines, root), {
        root,
        ignore: [],
        startedMs: Date.now() + 60_000,
        producers
      })
      if ("refusal" in observed) throw new Error(observed.refusal)
      return observed
    }
    const state = (name: string): string => ObservedReads.measure(Path.join(root, name))
    return { root, write, install, build, unused, open, list, observe, state }
  }

  // `cargo doc` then `cargo test` on same-file with its Cargo.lock committed: the test ran at every commit with
  // `~/.cargo/.global-cache, which //:ci.yml-test-2 left, changed`, cargo's note of when each crate was last used.
  it("holds none of what a build tool reads of its own bookkeeping, left by the step before it", async () => {
    const { observe, root, write } = await installed()
    await write("home/.cargo/.global-cache", "used at 1")
    await write("target/.rustc_info.json", "{\"b\":1,\"a\":2}")
    await write("target/debug/liba.rlib", "built")
    const doc: ObservedReads.Producer = {
      label: "//:doc",
      id: "doc-1",
      made: new Set(),
      touched: new Set(
        ["home/.cargo/.global-cache", "target/.rustc_info.json", "target/debug/liba.rlib"].map((name) =>
          Path.join(root, name)
        )
      )
    }
    await write("bin/cargo", "tool")
    await write("bin/make", "tool")
    const reads = (program: string) => [
      `100 execve("${root}/bin/${program}", ["${program}", "test"], 0x7ffc /* 9 vars */) = 0`,
      `100 openat(AT_FDCWD<${root}>, "home/.cargo/.global-cache", O_RDONLY) = 3`,
      `100 openat(AT_FDCWD<${root}>, "target/.rustc_info.json", O_RDONLY) = 3`,
      `100 openat(AT_FDCWD<${root}>, "target/debug/liba.rlib", O_RDONLY) = 3`
    ]
    const given = (program: string) => observe(reads(program), [doc]).record.given?.map(([path]) => path)
    // What the step before built is read as ever: only cargo's own notes are left out.
    expect(given("cargo")).toEqual(["target/debug/liba.rlib"])
    expect(given("make")).toEqual([
      "home/.cargo/.global-cache",
      "target/.rustc_info.json",
      "target/debug/liba.rlib"
    ])
    // The step before ran again and left its notes with other bytes: cargo's record still holds.
    const record = observe(reads("cargo"), [doc]).record
    await write("home/.cargo/.global-cache", "used at 2")
    await write("target/.rustc_info.json", "{\"a\":2,\"b\":1}")
    expect(ObservedReads.changed(record, root)).toBeUndefined()
    await write("target/debug/liba.rlib", "built again")
    expect(ObservedReads.changed(record, root)).toBe("target/debug/liba.rlib, which //:doc left, changed")
  })

  it("records each such path with the step it came from", async () => {
    const { build, install, list, observe, open, root, state, unused } = await installed()
    const { record } = observe([
      open("src/a.txt"),
      open("lock.json"),
      open("node_modules/pkg/index.js"),
      `100 openat(AT_FDCWD<${root}>, "node_modules/pkg/missing.js", O_RDONLY) = -1 ENOENT (No such file or directory)`,
      open("src/generated.js"),
      // Both steps wrote it: the last one to write it is the one it came from.
      open("stamp.txt"),
      list("."),
      list("src"),
      list("node_modules")
    ], [install, unused, build])
    expect(record.from).toEqual([["//:install", "install-1"], ["//:build", "build-1"]])
    expect(record.given).toEqual([
      ["node_modules", "d", 0],
      ["node_modules/pkg/index.js", state("node_modules/pkg/index.js"), 0],
      ["src/generated.js", state("src/generated.js"), 1],
      ["stamp.txt", state("stamp.txt"), 1]
    ])
    expect(record.reads).toEqual([
      [".", "d"],
      ["lock.json", state("lock.json")],
      ["node_modules/pkg/missing.js", "-"],
      ["src", "d"],
      ["src/a.txt", state("src/a.txt")]
    ])
    // A directory a step made is compared whole; in any other, the names a step added are checked one by one.
    expect(record.lists).toEqual([
      [".", ObservedReads.listing(root, ["node_modules", "stamp.txt"]), [], [["node_modules", 0], ["stamp.txt", 1]]],
      ["node_modules", ObservedReads.listing(Path.join(root, "node_modules"), []), []],
      ["src", ObservedReads.listing(Path.join(root, "src"), ["generated.js"]), [], [["generated.js", 1]]]
    ])
    expect(record.left).toBeUndefined()
    const { id, ...body } = record
    expect(id).toBe(ObservedReads.idOf(body))
    expect(await roundTrip(ObservedReads.store(record, []))).toEqual([inStoredOrder(record)])
  })

  it("records a run that depends on no step, or read nothing of one, as before", async () => {
    const { install, list, observe, open, state } = await installed()
    const plain = { reads: [["lock.json", state("lock.json")], ["src", "d"]], lists: [["src", expect.any(String), []]] }
    expect(observe([open("lock.json"), list("src")], []).record).toEqual({ ...plain, id: expect.any(String) })
    expect(observe([open("lock.json"), list("src")], [install]).record).toEqual({ ...plain, id: expect.any(String) })
    // The root directory is listed like any other.
    expect(observe(["100 getdents64(3</>, 0x55 /* 20 entries */, 32768) = 600"], [install]).record).toEqual({
      reads: [["/", "d"]],
      lists: [["/", ObservedReads.listing("/", []), []]],
      id: expect.any(String)
    })
    // A path the trace says was listed that is no directory has no listing to compare.
    expect(observe([list("lock.json")], [install]).record).toEqual({
      reads: [["lock.json", state("lock.json")]],
      lists: [],
      id: expect.any(String)
    })
  })

  it("says what the run wrote, and whether any of it is still there", async () => {
    const { observe, open, root, write } = await installed()
    await write("out/built.txt", "built")
    await write("out/sub/deep.txt", "deep")
    const wrote = observe([
      open("src/a.txt"),
      `100 mkdir("${root}/out", 0777) = 0`,
      `100 openat(AT_FDCWD<${root}>, "out/built.txt", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3`,
      `100 openat(AT_FDCWD<${root}>, "src/a.txt", O_WRONLY|O_APPEND) = 3`,
      "100 openat(AT_FDCWD</dev>, \"/dev/null\", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3",
      "100 mkdir(\"/dev/shm/smithers-observed\", 0777) = 0",
      `100 unlink("${root}/out/removed.txt") = 0`
    ], [])
    expect([...wrote.made]).toEqual([Path.join(root, "out")])
    expect([...wrote.touched].sort()).toEqual([
      Path.join(root, "out"),
      Path.join(root, "out/built.txt"),
      Path.join(root, "out/removed.txt"),
      Path.join(root, "src/a.txt")
    ])
    expect(wrote.record.left).toBe(true)
    // A run whose every written path is gone again, or is the build's own, left nothing.
    const cleaned = observe([
      `100 openat(AT_FDCWD<${root}>, "out/temporary.txt", O_WRONLY|O_CREAT|O_EXCL, 0666) = 3`,
      `100 unlink("${root}/out/temporary.txt") = 0`
    ], [])
    expect(cleaned.record.left).toBeUndefined()
    const ignoring = ObservedReads.observe(
      ObservedReads.read(
        () => [`100 openat(AT_FDCWD<${root}>, "out/built.txt", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3`],
        root
      ),
      { root, ignore: [Path.join(root, "out")], startedMs: Date.now() + 60_000 }
    )
    expect(ignoring).toEqual({
      record: { reads: [], lists: [], id: expect.any(String) },
      made: new Set(),
      touched: new Set()
    })
  })

  it("holds while each such path is as the run read it", async () => {
    const { build, install, list, observe, open, root, write } = await installed()
    const { record } = observe(
      [open("node_modules/pkg/index.js"), open("src/generated.js"), list("."), list("src"), list("node_modules")],
      [install, build]
    )
    expect(ObservedReads.changed(record, root)).toBeUndefined()
    await write("node_modules/pkg/index.js", "another package")
    expect(ObservedReads.changed(record, root)).toBe("node_modules/pkg/index.js, which //:install left, changed")
    // A step answered from the record this run read it under does not make a changed file its own.
    const all = (label: string): ReadonlySet<string> => new Set([label === "//:install" ? "install-1" : "build-1"])
    expect(ObservedReads.changed(record, root, undefined, undefined, all)).toBe(
      "node_modules/pkg/index.js, which //:install left, changed"
    )
    await write("node_modules/pkg/index.js", "package")
    // A step answered from another of its runs would write other files than this run read: what is at the paths
    // now, the same bytes or not, is not what the run would find.
    const other = (label: string): ReadonlySet<string> => new Set([label === "//:install" ? "install-2" : "build-1"])
    expect(ObservedReads.changed(record, root, undefined, undefined, other))
      .toBe("//:install is answered from another of its runs")
    expect(ObservedReads.changed(record, root, undefined, undefined, () => new Set()))
      .toBe("//:install is answered from another of its runs")
    // Among several records of the step, the one this run read under is enough.
    const several = (label: string): ReadonlySet<string> =>
      new Set(label === "//:install" ? ["install-2", "install-1"] : ["build-1"])
    expect(ObservedReads.changed(record, root, undefined, undefined, several)).toBeUndefined()
    await write("node_modules/other.js", "new")
    expect(ObservedReads.changed(record, root)).toBe("node_modules gained or lost an entry")
    await Fs.rm(Path.join(root, "node_modules/other.js"))
    await write("unrelated.txt", "new")
    expect(ObservedReads.changed(record, root)).toBe(". gained or lost an entry")
  })

  it("holds while such a path is missing and its step is answered from the record the run read it under", async () => {
    const { build, install, list, observe, open, root, write } = await installed()
    const { record } = observe(
      [open("node_modules/pkg/index.js"), open("src/generated.js"), list("."), list("src"), list("node_modules")],
      [install, build]
    )
    const answered = (ids: { readonly [label: string]: string }) => (label: string): ReadonlySet<string> | undefined =>
      ids[label] === undefined ? undefined : new Set([ids[label]])
    const both = answered({ "//:install": "install-1", "//:build": "build-1" })
    // A fresh checkout: nothing a step wrote is there.
    await Fs.rm(Path.join(root, "node_modules"), { recursive: true })
    await Fs.rm(Path.join(root, "src/generated.js"))
    await Fs.rm(Path.join(root, "stamp.txt"))
    expect(ObservedReads.changed(record, root, undefined, undefined, both)).toBeUndefined()
    // No step is answered, one is, or one is answered from another record: the path is gone.
    expect(ObservedReads.changed(record, root)).toBe("node_modules, which //:install left, is gone")
    expect(ObservedReads.changed(record, root, undefined, undefined, answered({ "//:install": "install-1" })))
      .toBe("src/generated.js, which //:build left, is gone")
    expect(
      ObservedReads.changed(
        record,
        root,
        undefined,
        undefined,
        answered({ "//:install": "install-2", "//:build": "build-1" })
      )
    ).toBe("//:install is answered from another of its runs")
    // A name a step added that the run listed and never opened is checked the same way.
    await write("src/generated.js", "generated")
    await Fs.mkdir(Path.join(root, "node_modules/pkg"), { recursive: true })
    await write("node_modules/pkg/index.js", "package")
    expect(ObservedReads.changed(record, root)).toBe("stamp.txt is gone")
    expect(ObservedReads.changed(record, root, undefined, undefined, both)).toBeUndefined()
    const nested = observe([list("src")], [build]).record
    await Fs.rm(Path.join(root, "src/generated.js"))
    expect(ObservedReads.changed(nested, root)).toBe("src/generated.js is gone")
    expect(ObservedReads.changed(nested, root, undefined, undefined, both)).toBeUndefined()
    // A path the run found missing below a tree a step made is missing in a fresh checkout too.
    const probing = observe([
      `100 openat(AT_FDCWD<${root}>, "node_modules/pkg/missing.js", O_RDONLY) = -1 ENOENT (No such file or directory)`
    ], [install]).record
    await Fs.rm(Path.join(root, "node_modules"), { recursive: true })
    expect(ObservedReads.changed(probing, root)).toBeUndefined()
    // What a step wrote where something already was is still an input when it changes.
    await write("src/generated.js", "written by hand")
    expect(ObservedReads.changed(record, root, undefined, undefined, both)).toBe(
      "src/generated.js, which //:build left, changed"
    )
  })

  it("keeps the names the run itself added apart from the names a step added", async () => {
    const { build, list, observe, open, root, state, write } = await installed()
    await write("src/own.txt", "written by the run")
    // The run read a file the build wrote, then removed it; and it added a file of its own beside the sources.
    const { record } = observe([
      open("src/generated.js"),
      list("src"),
      `100 openat(AT_FDCWD<${root}>, "src/own.txt", O_WRONLY|O_CREAT|O_EXCL, 0666) = 3`,
      `100 unlink("${root}/stamp.txt") = 0`,
      open("stamp.txt")
    ], [build])
    await Fs.rm(Path.join(root, "stamp.txt"))
    const again = observe([
      open("stamp.txt"),
      `100 unlink("${root}/stamp.txt") = 0`,
      list("src"),
      `100 openat(AT_FDCWD<${root}>, "src/own.txt", O_WRONLY|O_CREAT|O_EXCL, 0666) = 3`
    ], [build]).record
    expect(record.lists).toEqual([
      ["src", ObservedReads.listing(Path.join(root, "src"), ["own.txt", "generated.js"]), ["own.txt"], [[
        "generated.js",
        0
      ]]]
    ])
    expect(again.given).toEqual([["stamp.txt", "-", 0]])
    expect(again.reads).toEqual([["src", "d"]])
    expect(ObservedReads.changed(again, root)).toBeUndefined()
    // The build ran again and wrote the file the run had removed: the run would find it again.
    await write("stamp.txt", "stamp")
    expect(ObservedReads.changed(again, root)).toBe("stamp.txt now exists")
    expect(state("src/own.txt")).toMatch(/^f:/)
  })
})

describe("what a run left behind", () => {
  /** A workspace beside a temporary directory and a home, each with something a run could have written. */
  const places = async () => {
    const base = await directory()
    const root = Path.join(base, "ws")
    const temp = Path.join(base, "tmp")
    const home = Path.join(base, "home")
    const write = async (file: string, text = "x"): Promise<string> => {
      await Fs.mkdir(Path.dirname(file), { recursive: true })
      await Fs.writeFile(file, text)
      return file
    }
    await write(Path.join(root, "src/a.txt"))
    const made = (path: string): string => `100 mkdir("${path}", 0777) = 0`
    const filled = (path: string): string =>
      `100 openat(AT_FDCWD<${root}>, "${path}", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3`
    const observe = (
      lines: ReadonlyArray<string>,
      limits?: typeof ObservedReads.keptLimits,
      temporary: ReadonlyArray<string> = [temp]
    ) => {
      const observed = ObservedReads.observe(ObservedReads.read(() => lines, root), {
        root,
        ignore: [Path.join(root, ".flows")],
        startedMs: Date.now() + 60_000,
        temporary,
        limits
      })
      if ("refusal" in observed) throw new Error(observed.refusal)
      return observed
    }
    return { root, temp, home, write, made, filled, observe }
  }

  it("keeps the file a run wrote through a link it found", async () => {
    const { observe, root, write } = await places()
    await write(Path.join(root, "target.txt"), "before")
    await Fs.symlink("target.txt", Path.join(root, "latest"))
    const observed = observe([`100 openat(AT_FDCWD<${root}>, "latest", O_WRONLY|O_TRUNC) = 3`])
    expect(observed.left).toEqual({ keep: ["latest", "target.txt"], gone: [], outside: [] })
  })

  it.skipIf(process.platform !== "linux")(
    "reads a link into a process's own output once and writes through it",
    async () => {
      const { observe, root } = await places()
      await Fs.symlink("/dev/stdout", Path.join(root, "out"))
      const observed = observe([
        `100 openat(AT_FDCWD<${root}>, "out", O_RDONLY) = 3`,
        `100 openat(AT_FDCWD<${root}>, "out", O_WRONLY) = 3`
      ])
      // The link is the run's to read, and what it leads to is the process's own output, which nothing keeps.
      expect(observed.record.reads).toEqual([["out", "l:/dev/stdout", "l:/dev/stdout"]])
      expect(observed.left).toEqual({ keep: ["out"], gone: [], outside: [] })
    }
  )

  it("reads a run that wrote below a directory it then put a file in place of", async () => {
    const { filled, made, observe, root, write } = await places()
    await write(Path.join(root, "out"), "a file now")
    const observed = observe([
      made(`${root}/out`),
      filled("out/part.txt"),
      `100 openat(AT_FDCWD<${root}>, "out/part.txt", O_RDONLY) = -1 ENOTDIR (Not a directory)`
    ])
    expect(observed.record.reads).toEqual([])
    expect(observed.left).toEqual({ keep: ["out"], gone: [], outside: [] })
  })

  // `bun install` writes each package in a directory of its own and moves that directory away, so most paths it
  // wrote are gone when its trace is read: 266,467 of them at eliza's 78e44531, each asked for with an error as its
  // answer (about 20 µs in Node, against 1.3 µs for a status).
  it("asks for no path below a directory that is not there", async () => {
    const { filled, made, root, write } = await places()
    await write(Path.join(root, "out/kept.txt"))
    const lines = [made(`${root}/out`), filled("out/kept.txt"), made(`${root}/unpacked`)]
    for (let index = 0; index < 1_000; index += 1) lines.push(filled(`unpacked/lib/f${index}`))
    lines.push(`100 rename("${root}/unpacked", "${root}/../moved") = 0`)
    const asked: Array<string> = []
    const io: ObservedReads.Io = {
      ...ObservedReads.defaultIo,
      lstat: (path) => {
        asked.push(path)
        return ObservedReads.defaultIo.lstat(path)
      }
    }
    const observed = ObservedReads.observe(ObservedReads.read(() => lines, root), {
      root,
      ignore: [],
      startedMs: Date.now() + 60_000,
      io
    })
    if ("refusal" in observed) throw new Error(observed.refusal)
    expect(observed.left).toEqual({ keep: ["out", "out/kept.txt"], gone: ["unpacked"], outside: [] })
    expect(asked.filter((path) => path.startsWith(`${root}/unpacked/`))).toEqual([])
  })

  // An install makes node_modules, links each package into it and reads it back: what it made there is its own and
  // is not resolved again. A link it made there leads out, and what lies behind the link is read.
  describe("what a run made in a directory it made", () => {
    const link = (root: string, target: string, name: string): string =>
      `100 symlink(${JSON.stringify(target)}, "${root}/${name}") = 0`
    const reads = (root: string, name: string): string => `100 openat(AT_FDCWD<${root}>, "${name}", O_RDONLY) = 3`

    it("is its own, and what a link it made there leads to is read", async () => {
      const { made, observe, root, write } = await places()
      await write(Path.join(root, "packages/core/package.json"), "{}")
      await write(Path.join(root, "cache/index.js"), "fetched")
      await write(Path.join(root, "node_modules/pkg/index.js"), "fetched")
      await Fs.symlink("../packages/core", Path.join(root, "node_modules/core"))
      const observed = observe([
        made(`${root}/node_modules`),
        made(`${root}/node_modules/pkg`),
        `100 linkat(AT_FDCWD<${root}>, "cache/index.js", AT_FDCWD<${root}>, "node_modules/pkg/index.js", 0) = 0`,
        link(root, "../packages/core", "node_modules/core"),
        reads(root, "node_modules/pkg/index.js"),
        `100 getdents64(3</${root.slice(1)}/node_modules/pkg>, 0x0 /* 1 entries */, 32768) = 24`,
        reads(root, "node_modules/core/package.json")
      ])
      expect(observed.record.reads.map(([path]) => path)).toEqual(["cache/index.js", "packages/core/package.json"])
    })

    it("reads where a link it made leads at the end, after it pointed the link elsewhere", async () => {
      const { made, observe, root, write } = await places()
      await write(Path.join(root, "a.txt"), "a")
      await write(Path.join(root, "b.txt"), "b")
      await Fs.mkdir(Path.join(root, "out"))
      await Fs.symlink("../b.txt", Path.join(root, "out/current"))
      const observed = observe([
        made(`${root}/out`),
        link(root, "../a.txt", "out/current"),
        reads(root, "out/current"),
        `100 unlink("${root}/out/current") = 0`,
        link(root, "../b.txt", "out/current"),
        reads(root, "out/current")
      ])
      expect(observed.record.reads.map(([path]) => path)).toEqual(["b.txt"])
    })

    it("reads what a link it made there leads to outside the workspace", async () => {
      const { made, observe, root, temp, write } = await places()
      const outside = await write(Path.join(temp, "tool/config.json"), "{}")
      await Fs.mkdir(Path.join(root, "out"))
      await Fs.symlink(outside, Path.join(root, "out/config.json"))
      const observed = observe([
        made(`${root}/out`),
        link(root, outside, "out/config.json"),
        // Opened to make it if need be: the open goes through the link.
        `100 openat(AT_FDCWD<${root}>, "out/config.json", O_RDONLY|O_CREAT, 0666) = 3`,
        reads(root, "out/config.json")
      ])
      expect(observed.record.reads.map(([path]) => path)).toEqual([outside])
    })

    it("reads what another thread found there before the run made it, took it away and made it again", async () => {
      const { made, observe, root } = await places()
      await Fs.mkdir(Path.join(root, "out/again"), { recursive: true })
      const stat = "{st_mode=S_IFDIR|0755, st_size=4096, ...}"
      const observed = observe([
        made(`${root}/out`),
        `100 mkdir("${root}/out/again", 0777 <unfinished ...>`,
        `101 stat("${root}/out/again",  <unfinished ...>`,
        "100 <... mkdir resumed>)              = 0",
        `101 <... stat resumed>${stat})        = 0`,
        `100 rmdir("${root}/out/again")        = 0`,
        made(`${root}/out/again`)
      ])
      expect(observed.record.reads.map(([path]) => path)).toEqual(["out/again"])
    })

    it("makes nothing of a link whose name its trace does not give", () => {
      const trace = ObservedReads.read(() => ["100 symlink(\"target\", 0x7ffd1234) = 0"], "/w")
      expect(trace.refusals).toEqual(["its trace holds a path that cannot be read: 0x7ffd1234"])
      expect([...(trace.plainMade ?? [])]).toEqual([])
    })

    it("reads a file of a directory it did not make, though an earlier step made it", async () => {
      const { filled, made, observe, root, write } = await places()
      await write(Path.join(root, "dist/earlier.js"), "built before")
      await write(Path.join(root, "dist/mine.js"), "built now")
      const observed = observe([filled("dist/mine.js"), reads(root, "dist/mine.js"), reads(root, "dist/earlier.js")])
      // What it wrote is its own wherever it is.
      expect(observed.record.reads.map(([path]) => path)).toEqual(["dist/earlier.js"])
      // In a directory the run made, all is its own.
      const own = observe([made(`${root}/dist`), filled("dist/mine.js"), reads(root, "dist/mine.js")])
      expect(own.record.reads).toEqual([])
    })
  })

  // `npm ci` reads an entry of its cache index and writes it back with another time at every run. A CI job that
  // restores that cache from another run's save would find the entry changed at every commit.
  it("leaves out of what it read the cache a locked install writes outside the workspace", async () => {
    const { home, observe, root, temp, write } = await places()
    const index = await write(Path.join(home, ".npm/_cacache/index-v5/03/af/entry"), "old")
    // A machine's home can lie in a temporary directory: the cache there is the install's own as well.
    const machine = await write(Path.join(temp, "machine/home/.npm/_cacache/index-v5/23/91/entry"), "old")
    const blob = await write(Path.join(home, ".npm/_cacache/content-v2/blob"), "tarball")
    const setting = await write(Path.join(home, ".npmrc"), "registry")
    const lock = await write(Path.join(root, "package-lock.json"), "{}")
    const rewrites = (pid: number, file: string): string =>
      `${pid} openat(AT_FDCWD<${root}>, "${file}", O_RDWR|O_CREAT, 0666) = 3<${file}>`
    const reads = (pid: number, file: string): string =>
      `${pid} openat(AT_FDCWD<${root}>, "${file}", O_RDONLY) = 3<${file}>`
    const install = observe([
      "100 execve(\"/bin/sh\", [\"npm\", \"ci\"], 0x7ffc /* 9 vars */) = 0",
      reads(100, setting),
      reads(100, blob),
      rewrites(100, index),
      rewrites(100, machine),
      rewrites(100, lock)
    ]).record
    /** The paths of a record that are in the home directory, the temporary directory or the workspace. */
    const read = (record: ObservedReads.Record): ReadonlyArray<string> =>
      record.reads.map(([path]) => path).filter((path) =>
        path.startsWith(`${home}/`) || path === machine || !path.startsWith("/")
      )
    // The entry it rewrote is not there. What it only read is, and so is a file of the workspace it rewrote.
    expect(read(install)).toEqual([blob, setting, "package-lock.json"])
    // The same calls by a program that is no locked install: the entry is something the run read and changed.
    const other = observe([
      "100 execve(\"/bin/sh\", [\"npm\", \"install\"], 0x7ffc /* 9 vars */) = 0",
      reads(100, setting),
      reads(100, blob),
      rewrites(100, index),
      rewrites(100, machine),
      rewrites(100, lock)
    ]).record
    expect(read(other)).toEqual([blob, index, setting, machine, "package-lock.json"].sort())
  })

  it("is told apart by where it is: kept in the workspace and the temporary directory, checked anywhere else", async () => {
    const { filled, home, made, observe, root, temp, write } = await places()
    await write(Path.join(root, "node_modules/pkg/index.js"), "package")
    await write(Path.join(root, "node_modules/.bin/placeholder"))
    await Fs.symlink("../pkg/index.js", Path.join(root, "node_modules/.bin/pkg"))
    await Fs.symlink("/usr/bin/env", Path.join(root, "node_modules/.bin/env"))
    await write(Path.join(root, ".flows/cache/entry"))
    await write(Path.join(temp, "state/env"), "A=1")
    await write(Path.join(home, "bin/tool"), "tool")
    await write(Path.join(home, ".npm/_cacache/blob"), "fetched")
    await write(Path.join(home, ".npm/_cacache/later"), "fetched later")
    const observed = observe([
      made(`${root}/node_modules`),
      made(`${root}/node_modules/pkg`),
      filled("node_modules/pkg/index.js"),
      made(`${root}/node_modules/.bin`),
      `100 symlink("../pkg/index.js", "${root}/node_modules/.bin/pkg") = 0`,
      `100 symlink("/usr/bin/env", "${root}/node_modules/.bin/env") = 0`,
      filled(".flows/cache/entry"),
      filled(`${temp}/state/env`),
      filled(`${temp}/state/removed-again`),
      `100 unlink("${temp}/state/removed-again") = 0`,
      `100 unlink("${root}/src/stale.txt") = 0`,
      `100 unlink("${home}/old") = 0`,
      `100 chmod("${root}", 0755) = 0`,
      filled(`${home}/bin/tool`),
      "100 openat(AT_FDCWD</dev>, \"/dev/null\", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3",
      "100 unlink(\"/dev/shm/gone\") = 0",
      // A package manager that installs what a lockfile pins fills its own cache.
      `100 unlink("${root}/.flows/cache/old") = 0`,
      "100 execve(\"/bin/sh\", [\"npm\", \"ci\"], 0x7ffc /* 9 vars */) = 0",
      made(`${home}/.npm`),
      made(`${home}/.npm/_cacache`),
      filled(`${home}/.npm/_cacache/blob`),
      // What another process puts into the cache the install made is the cache's too.
      `200 openat(AT_FDCWD<${root}>, "${home}/.npm/_cacache/later", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3`
    ])
    expect(observed.record.left).toBe(true)
    expect(observed.left).toEqual({
      keep: [
        `${temp}/state/env`,
        "node_modules",
        "node_modules/.bin",
        "node_modules/.bin/env",
        "node_modules/.bin/pkg",
        "node_modules/pkg",
        "node_modules/pkg/index.js"
      ],
      gone: [`${temp}/state/removed-again`, "src/stale.txt"],
      outside: [[`${home}/bin/tool`, ObservedReads.measure(`${home}/bin/tool`)]]
    })
    // With no temporary directory named, what is there is somewhere else like any other place.
    const elsewhere = observe([filled(`${temp}/state/env`)], undefined, [])
    expect(elsewhere.left).toEqual({ keep: [], gone: [], outside: [[`${temp}/state/env`, expect.any(String)]] })
  })

  it("is nothing for a run that wrote nothing that is still there", async () => {
    const { filled, observe, root } = await places()
    expect(observe([filled("out.txt"), `100 unlink("${root}/out.txt") = 0`]).left).toBeUndefined()
    expect(observe([`100 chmod("${root}", 0755) = 0`]).left).toBeUndefined()
  })

  it("is not kept when a step cannot be given it back whole", async () => {
    const { filled, home, made, observe, root, temp, write } = await places()
    // A link into what the run wrote outside the workspace.
    await write(Path.join(home, "store/pkg/index.js"))
    await Fs.symlink(Path.join(home, "store/pkg"), Path.join(root, "linked"))
    expect(
      observe([
        made(`${home}/store`),
        made(`${home}/store/pkg`),
        filled(`${home}/store/pkg/index.js`),
        `100 symlink("${home}/store/pkg", "${root}/linked") = 0`
      ]).left
    ).toEqual({ refusal: `linked is a link to ${home}/store/pkg, which it wrote outside the workspace` })
    // A file in the repository's own store.
    await write(Path.join(root, ".git/hooks/pre-commit"))
    expect(observe([filled(".git/hooks/pre-commit")]).left).toEqual({
      refusal: "it wrote .git/hooks/pre-commit, in the repository's own store"
    })
    // More than the limits allow: paths, bytes, paths outside, and paths removed.
    await write(Path.join(root, "one"), "12345")
    await write(Path.join(root, "two"), "12345")
    await write(Path.join(temp, "three"))
    await write(Path.join(home, "four"))
    await write(Path.join(home, "five"))
    const few = { paths: 1, bytes: 100, outside: 1 }
    expect(observe([filled("one"), filled("two")], few).left).toEqual({ refusal: "it left too much to keep" })
    expect(observe([filled("one"), filled("two")], { ...few, paths: 9, bytes: 9 }).left).toEqual({
      refusal: "it left too much to keep"
    })
    expect(observe([filled(`${home}/four`), filled(`${home}/five`)], few).left).toEqual({
      refusal: "it left too many files outside the workspace to keep"
    })
    expect(
      observe([filled("one"), `100 unlink("${root}/gone-1") = 0`, `100 unlink("${root}/gone-2") = 0`], few).left
    ).toEqual({ refusal: "it left too much to keep" })
    expect(observe([filled("one"), filled(`${temp}/three`), filled(`${home}/four`)], { ...few, paths: 2 }).left)
      .toEqual({ keep: [`${temp}/three`, "one"], gone: [], outside: [[`${home}/four`, expect.any(String)]] })
  })

  it.skipIf(process.platform === "win32")("leaves out a socket or a pipe a process left", async () => {
    const { filled, observe, root } = await places()
    const pipe = Path.join(root, "pipe")
    expect(spawnSync("mkfifo", [pipe]).status).toBe(0)
    await Fs.writeFile(Path.join(root, "out.txt"), "x")
    expect(observe([`100 mknod("${pipe}", S_IFIFO|0644) = 0`, filled("pipe"), filled("out.txt")]).left).toEqual({
      keep: ["out.txt"],
      gone: [],
      outside: []
    })
  })

  it("puts a run's files back as if the run had just ended, in the order it wrote them", () => {
    const second = 1_000_000_000n
    const now = 5_000n * second
    const after = now - 40_000_000n
    // A run whose files span less time than the putting back took: one offset for all, the newest at `now`.
    const quick = [100n * second, 100n * second + 7n, 100n * second + 30_000_000n]
    expect(ObservedReads.putBackTimes(quick, after, now)).toEqual([now - 30_000_000n, now - 29_999_993n, now])
    // A run that took a minute: its files keep their order, each distinct time in a place of its own after
    // `after`, and files written at one time stay at one time.
    const long = [160n * second, 100n * second, 130n * second, 100n * second]
    const moved = ObservedReads.putBackTimes(long, after, now)
    expect(moved).toEqual([now, now - 26_666_666n, now - 13_333_333n, now - 26_666_666n])
    expect(moved.every((time) => time > after && time <= now)).toBe(true)
    // One file, and one time for several, is the time now.
    expect(ObservedReads.putBackTimes([7n], after, now)).toEqual([now])
    expect(ObservedReads.putBackTimes([7n, 7n], after, now)).toEqual([now, now])
    expect(ObservedReads.putBackTimes([], after, now)).toEqual([])
    // A clock that went back leaves no room: every file is as new as now, and none is in the future.
    expect(ObservedReads.putBackTimes([1n, 2n], now, now - 5n)).toEqual([now - 5n, now - 5n])
    // The archive of another host whose clock is ahead: still the newest at `now`.
    expect(ObservedReads.putBackTimes([now + 9n, now + 4n], after, now)).toEqual([now, now - 5n])
  })

  it("stands for its run while what the run left outside the workspace is as it left it", async () => {
    const { home, write } = await places()
    const tool = await write(Path.join(home, "bin/tool"), "tool")
    const stored: ObservedReads.Record = {
      reads: [],
      lists: [],
      left: true,
      id: "1",
      kept: { archive: "a".repeat(64), outside: [[tool, ObservedReads.measure(tool)]], gone: [] }
    }
    expect(ObservedReads.outsideHolds(stored)).toBe(true)
    expect(ObservedReads.outsideChanged(stored)).toBeUndefined()
    expect(ObservedReads.outsideHolds({ reads: [], lists: [], id: "2" })).toBe(true)
    await Fs.writeFile(tool, "another tool")
    expect(ObservedReads.outsideHolds(stored)).toBe(false)
    await Fs.rm(tool)
    expect(ObservedReads.outsideHolds(stored, () => "-")).toBe(false)
  })

  it("puts back only names in the workspace or under a temporary directory", () => {
    const temporary = ["/tmp", "/var/folders/x"]
    for (
      const name of ["node_modules", "node_modules/pkg/index.js", "/tmp/state/env", "/var/folders/x/a", ".gitignore"]
    ) {
      expect([name, ObservedReads.keptName(name, temporary)]).toEqual([name, true])
    }
    for (
      const name of [
        "",
        "../outside",
        "a/../../b",
        ".git",
        ".git/config",
        "a//b",
        "a\0b",
        "/etc/passwd",
        "/tmp",
        "/tmp/../etc/passwd",
        "/tmpx/a",
        "/home/u/.ssh/authorized_keys"
      ]
    ) expect([name, ObservedReads.keptName(name, temporary)]).toEqual([name, false])
  })
})

describe("a package manager that installs what a lockfile pins", () => {
  it("is known by its command line", () => {
    const locked = [
      "npm ci",
      "npm clean-install --ignore-scripts",
      "npm install-clean",
      "npm ic",
      "/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci",
      "env node /opt/npm.js ci",
      "pnpm install --frozen-lockfile",
      "pnpm i --frozen-lockfile --ignore-scripts",
      "pnpm ci",
      "node /home/u/.cache/corepack/pnpm/9.0.0/bin/pnpm.cjs install --frozen-lockfile",
      "corepack pnpm install --frozen-lockfile",
      "yarn install --frozen-lockfile",
      "yarn --immutable",
      "yarnpkg install --immutable",
      "bun install --frozen-lockfile",
      "bun ci",
      "uv sync --locked",
      "uv sync --frozen --no-default-groups",
      "uv run --locked --group dev tox run",
      "uv run --frozen pytest",
      "pip install --require-hashes -r requirements.txt",
      "python3 -m pip install --require-hashes -r requirements.txt",
      "pip3 install -r requirements.txt --require-hashes",
      "go mod download",
      "cargo fetch --locked",
      "deno install --frozen"
    ]
    const open = [
      "npm install",
      "npm run ci",
      "npm",
      "node ci",
      "node",
      "pnpm install",
      "pnpm exec --frozen-lockfile tsc",
      "yarn install",
      "yarn run --immutable",
      "bun install",
      "bun x --frozen-lockfile cowsay",
      "uv sync",
      "uv run pytest --locked",
      "uv run --group dev --locked pytest",
      "uv pip install --locked x",
      "pip install -r requirements.txt",
      "python3 -m venv --require-hashes install",
      "go test ./...",
      "go mod tidy",
      "cargo test --locked",
      "deno install",
      "curl --frozen-lockfile https://example.com",
      ""
    ]
    for (const line of locked) expect([line, ObservedReads.lockedInstall(line.split(" "))]).toEqual([line, true])
    for (const line of open) expect([line, ObservedReads.lockedInstall(line.split(" "))]).toEqual([line, false])
    expect(ObservedReads.lockedInstall([])).toBe(false)
  })

  const remote = (pid: number): string =>
    `${pid} connect(3<socket:[9]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("104.16.4.34")}, 16) = 0`
  const start = (pid: number, ...argv: ReadonlyArray<string>): string =>
    `${pid} execve(${JSON.stringify(`/usr/bin/${argv[0]}`)}, [${
      argv.map((word) => JSON.stringify(word)).join(", ")
    }], 0x7ffc /* 9 vars */) = 0`

  it("may open a connection, and so may the processes it starts", () => {
    expect(read([start(100, "npm", "ci"), remote(100)].join("\n")).refusals).toEqual([])
    // The kernel starts `node` for the script, and the install goes on under the same process.
    expect(
      read([start(100, "npm", "ci"), start(100, "node", "/usr/lib/node_modules/npm/bin/npm-cli.js", "ci"), remote(100)]
        .join("\n")).refusals
    ).toEqual([])
    // A thread that resolves a name, a script of a package, and what that script starts.
    expect(
      read([
        start(100, "npm", "ci"),
        "100 clone(child_stack=0x7f, flags=CLONE_VM|CLONE_FS|CLONE_THREAD) = 101",
        "101 connect(3<socket:[9]>, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr(\"127.0.0.53\")}, 16) = 0",
        "101 connect(4<socket:[10]>, {sa_family=AF_UNIX, sun_path=\"/var/run/nscd/socket\"}, 110) = 0",
        "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 102",
        start(102, "sh", "-c", "node install.js"),
        "102 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 103",
        start(103, "node", "install.js"),
        remote(103)
      ].join("\n")).refusals
    ).toEqual([])
    expect(read([start(100, "/usr/bin/env", "FOO=1", "npm", "ci"), remote(100)].join("\n")).refusals).toEqual([
      "it opened a network connection (env to 104.16.4.34 port 443)"
    ])
  })

  it("is told apart in what it wrote, with what a process it started wrote and what it moved", () => {
    const trace = read([
      "100 openat(AT_FDCWD</w>, \"before.txt\", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3",
      start(100, "npm", "ci"),
      "100 mkdir(\"/home/u/.npm/_cacache/tmp/a1\", 0777) = 0",
      "100 openat(AT_FDCWD</w>, \"/home/u/.npm/_cacache/tmp/a1/blob\", O_WRONLY|O_CREAT|O_EXCL, 0666) = 3",
      "100 rename(\"/home/u/.npm/_cacache/tmp/a1\", \"/home/u/.npm/_cacache/content/a1\") = 0",
      "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 102",
      "102 openat(AT_FDCWD</w>, \"node_modules/pkg/built.node\", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3",
      start(100, "node", "after.js"),
      "100 openat(AT_FDCWD</w>, \"after.txt\", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3",
      "100 unlink(\"/w/before.txt\") = 0",
      "100 rmdir(\"/w/missing\") = -1 ENOENT (No such file or directory)"
    ].join("\n"))
    expect([...trace.fetched].sort()).toEqual([
      "/home/u/.npm/_cacache/content/a1",
      "/home/u/.npm/_cacache/content/a1/blob",
      "/home/u/.npm/_cacache/tmp/a1",
      "/home/u/.npm/_cacache/tmp/a1/blob",
      "/w/node_modules/pkg/built.node"
    ])
    expect([...trace.removed].sort()).toEqual(["/home/u/.npm/_cacache/tmp/a1", "/w/before.txt"])
  })

  it("stops being one when it goes on to run another program", () => {
    // `uv run` installs, then becomes the command it was given.
    const running = [start(100, "uv", "run", "--locked", "tox", "run"), remote(100), start(100, "tox", "run")]
    expect(read(running.join("\n")).refusals).toEqual([])
    expect(read([...running, remote(100)].join("\n")).refusals).toEqual([
      "it opened a network connection (tox to 104.16.4.34 port 443)"
    ])
    // What the command starts is the command's, not the install's.
    expect(
      read([
        ...running,
        "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 104",
        start(104, "pip", "install", "mypy"),
        remote(104)
      ].join("\n")).refusals
    ).toEqual(["it opened a network connection (pip to 104.16.4.34 port 443)"])
    // A process the install started before that stays the install's.
    expect(
      read([
        start(100, "uv", "run", "--locked", "tox"),
        "100 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = 105",
        start(100, "tox"),
        start(105, "git", "fetch"),
        remote(105)
      ].join("\n")).refusals
    ).toEqual([])
  })

  it("is not known from a command line the trace cut short, or from a start that failed", () => {
    expect(
      read([
        "100 execve(\"/usr/bin/npm\", [\"npm\", \"ci\"...], 0x7ffc /* 9 vars */) = 0",
        remote(100)
      ].join("\n")).refusals
    ).toEqual(["it opened a network connection (npm to 104.16.4.34 port 443)"])
    expect(
      read(["100 execve(\"/usr/bin/npm\", 0x55d0, 0x7ffc /* 9 vars */) = 0", remote(100)].join("\n")).refusals
    ).toEqual(["it opened a network connection (npm to 104.16.4.34 port 443)"])
    expect(
      read([
        "100 execve(\"/usr/local/bin/npm\", [\"npm\", \"ci\"], 0x7ffc /* 9 vars */) = -1 ENOENT (No such file or directory)",
        remote(100)
      ].join("\n")).refusals
    ).toEqual(["it opened a network connection (to 104.16.4.34 port 443)"])
    expect(
      read([
        "100 execveat(AT_FDCWD</w>, \"/usr/bin/npm\", [\"npm\", \"ci\"], 0x7ffc /* 9 vars */, 0) = 0",
        remote(100)
      ].join("\n")).refusals
    ).toEqual([])
  })
})

describe("a build tool that fetches what a lockfile pins", () => {
  const remote = (pid: number): string =>
    `${pid} connect(3<socket:[9]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("151.101.2.137")}, 16) = 0`
  const start = (pid: number, ...argv: ReadonlyArray<string>): string =>
    `${pid} execve(${JSON.stringify(`/usr/bin/${argv[0]}`)}, [${
      argv.map((word) => JSON.stringify(word)).join(", ")
    }], 0x7ffc /* 9 vars */) = 0`
  const open = (pid: number, path: string, flags = "O_RDONLY|O_CLOEXEC"): string =>
    `${pid} openat(AT_FDCWD</w/crate>, ${JSON.stringify(path)}, ${flags}) = 3`
  const thread = (pid: number, child: number): string =>
    `${pid} clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD, stack=0x7f}, 88) = ${child}`
  const process = (pid: number, child: number): string =>
    `${pid} clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = ${child}`
  const refusals = (...lines: ReadonlyArray<string>): ReadonlyArray<string> =>
    read(lines.join("\n"), "/w/crate").refusals
  const unpinned = "it opened a network connection (cargo to 151.101.2.137 port 443), " +
    "with no Cargo.lock to say what it fetches"

  it("is known by its command line", () => {
    const cargo = {
      pins: ["Cargo.lock"],
      rewrites: ["Cargo.lock"],
      own: /\/\.git(?:\/|$)|\/\.rustc_info\.json$|\/\.global-cache(?:-journal)?$/
    }
    const go = { pins: ["go.sum"], rewrites: ["go.sum", "go.mod", "go.work.sum", "go.work"] }
    for (
      const line of [
        "cargo test",
        "cargo t --all-features",
        "cargo +nightly build --release",
        "/home/u/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/cargo doc --verbose",
        "cargo --locked check",
        "cargo metadata --format-version 1",
        "cargo fetch"
      ]
    ) expect([line, ObservedReads.lockedBuild(line.split(" "))]).toEqual([line, cargo])
    for (const line of ["go test ./...", "/usr/local/go/bin/go build -v ./...", "go vet ./..."]) {
      expect([line, ObservedReads.lockedBuild(line.split(" "))]).toEqual([line, go])
    }
    for (
      const line of [
        "cargo install ripgrep",
        "cargo update",
        "cargo publish",
        "cargo package",
        "cargo generate-lockfile",
        // A flag that takes a value: the value is read as the command, and it is none.
        "cargo --config net.retry=3 test",
        "cargo",
        "cargo --version",
        "go get example.com/x",
        "go run example.com/x@latest",
        "go install example.com/x@latest",
        "go mod tidy",
        "go list -m -u all",
        "rustc src/lib.rs",
        "npm test",
        ""
      ]
    ) expect([line, ObservedReads.lockedBuild(line.split(" "))]).toEqual([line, undefined])
    expect(ObservedReads.lockedBuild([])).toBeUndefined()
  })

  it("may open a connection once it has read its lockfile, and so may its threads", () => {
    expect(refusals(start(100, "cargo", "test"), open(100, "Cargo.lock"), remote(100), remote(100))).toEqual([])
    // The rustup link starts the toolchain's cargo, which reads the lockfile of the workspace above it.
    expect(
      refusals(
        start(100, "cargo", "test"),
        start(100, "/home/u/.rustup/toolchains/stable/bin/cargo", "test"),
        open(100, "/w/Cargo.lock"),
        thread(100, 101),
        remote(101)
      )
    ).toEqual([])
    expect(
      refusals(start(100, "go", "test", "./..."), open(100, "/w/crate/go.sum"), thread(100, 101), remote(101))
    ).toEqual([])
  })

  it("stores nothing when no lockfile said what to fetch", () => {
    // No lockfile: cargo chooses versions and writes one.
    expect(
      refusals(
        start(100, "cargo", "build"),
        "100 openat(AT_FDCWD</w/crate>, \"Cargo.lock\", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)",
        remote(100),
        open(100, "Cargo.lock", "O_RDWR|O_CREAT|O_CLOEXEC, 0666")
      )
    ).toEqual([unpinned])
    // A lockfile of some other crate, such as one a registry unpacked, is not this build's.
    expect(
      refusals(start(100, "cargo", "build"), open(100, "/home/u/.cargo/registry/src/x-1.0.0/Cargo.lock"), remote(100))
    ).toEqual([unpinned])
    // A lockfile the run itself wrote first was chosen by the run.
    expect(
      refusals(
        open(100, "Cargo.lock", "O_WRONLY|O_CREAT|O_TRUNC, 0666"),
        start(100, "cargo", "build"),
        open(100, "Cargo.lock"),
        remote(100)
      )
    ).toEqual([unpinned])
    // A command that chooses versions, and a tool started where the trace does not say.
    expect(refusals(start(100, "cargo", "update"), open(100, "Cargo.lock"), remote(100))).toEqual([
      "it opened a network connection (cargo to 151.101.2.137 port 443)"
    ])
    expect(refusals(start(100, "sh"), start(200, "cargo", "test"), open(200, "/w/crate/Cargo.lock"), remote(200)))
      .toEqual(["it opened a network connection (cargo to 151.101.2.137 port 443)"])
  })

  it("stores nothing when the lockfile it read was written afterwards", () => {
    expect(
      refusals(
        start(100, "cargo", "test"),
        open(100, "Cargo.lock"),
        remote(100),
        open(100, "Cargo.lock", "O_WRONLY|O_CREAT|O_TRUNC, 0666")
      )
    ).toEqual([
      "it opened a network connection (cargo to 151.101.2.137 port 443), and wrote Cargo.lock: " +
      "no lockfile fixed what it fetched"
    ])
    // `go` with `-mod=mod` adds what it chose to go.mod.
    expect(
      refusals(
        start(100, "go", "build", "-mod=mod", "./..."),
        open(100, "go.sum"),
        remote(100),
        "100 rename(\"/w/crate/go.mod.tmp\", \"/w/crate/go.mod\") = 0"
      )
    ).toEqual([
      "it opened a network connection (go to 151.101.2.137 port 443), and wrote go.mod: " +
      "no lockfile fixed what it fetched"
    ])
  })

  it("leaves out what cargo itself reads to list a package's files and to remember the compiler", () => {
    // `cargo doc` opens the repository's store, as it does at every commit, and its own note of the compiler.
    const store = [
      "100 statx(AT_FDCWD</w/crate>, \"/w/crate/.git\", AT_STATX_SYNC_AS_STAT, STATX_ALL, {stx_mode=S_IFDIR|0775}) = 0",
      open(100, "/w/crate/.git/HEAD"),
      "100 openat(AT_FDCWD</w/crate>, \"/w/crate/.git/commondir\", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)",
      open(100, "/w/crate/.git/index"),
      "100 openat(AT_FDCWD</w/crate>, \"/w/crate/.git/objects/pack\", O_RDONLY|O_DIRECTORY) = 10",
      "100 getdents64(10</w/crate/.git/objects/pack>, 0x55 /* 4 entries */, 32768) = 120",
      open(100, "/w/crate/target/.rustc_info.json"),
      open(100, "/w/home/.cargo/.global-cache", "O_RDWR|O_CREAT|O_CLOEXEC, 0644"),
      open(100, "/w/home/.cargo/.global-cache-journal"),
      // A write that failed is a look at the path.
      "100 openat(AT_FDCWD</w/crate>, \"/w/crate/.git/index.lock\", O_WRONLY|O_CREAT|O_EXCL, 0666) = -1 EACCES (Permission denied)"
    ]
    const rest = [
      open(100, "/w/crate/.gitignore"),
      open(100, "/w/crate/src/lib.rs"),
      "100 openat(AT_FDCWD</w/crate>, \"/w/crate/.github\", O_RDONLY|O_DIRECTORY) = 11",
      "100 getdents64(11</w/crate/.github>, 0x55 /* 3 entries */, 32768) = 80"
    ]
    const seen = (...lines: ReadonlyArray<string>) => {
      const trace = read(lines.join("\n"), "/w/crate")
      return {
        found: [...trace.found.keys()].filter((path) => path.startsWith("/w/")).sort(),
        missing: [...trace.missing.keys()].sort(),
        listed: [...trace.listed.keys()].sort()
      }
    }
    expect(seen(start(100, "cargo", "doc", "--verbose"), thread(100, 101), ...store, ...rest)).toEqual({
      found: ["/w/crate/.github", "/w/crate/.gitignore", "/w/crate/src/lib.rs"],
      missing: [],
      listed: ["/w/crate/.github"]
    })
    // A thread of cargo is cargo.
    expect(
      seen(start(100, "cargo", "doc"), thread(100, 101), open(101, "/w/crate/.git/HEAD"), open(101, "/w/crate/a.rs"))
        .found
    ).toEqual(["/w/crate/a.rs"])
    // The same reads by a program cargo started, by `cargo package`, which writes the commit into what it
    // packs, and by any other program are reads.
    const all = {
      found: [
        "/w/crate/.git",
        "/w/crate/.git/HEAD",
        "/w/crate/.git/index",
        "/w/crate/.git/index.lock",
        "/w/crate/.git/objects/pack",
        "/w/crate/target/.rustc_info.json",
        "/w/home/.cargo/.global-cache",
        "/w/home/.cargo/.global-cache-journal"
      ],
      missing: ["/w/crate/.git/commondir"],
      listed: ["/w/crate/.git/objects/pack"]
    }
    const child = store.map((line) => line.replace(/^100 /, "102 "))
    expect(
      seen(
        start(100, "cargo", "test"),
        process(100, 102),
        start(102, "build-script-build"),
        ...child
      )
    )
      .toEqual(all)
    expect(seen(start(100, "cargo", "package"), ...store)).toEqual(all)
    expect(seen(start(100, "git", "status"), ...store)).toEqual(all)
  })

  it("covers the tool alone: not a program it starts, and not the program it becomes", () => {
    // A test that reaches the network.
    expect(
      refusals(
        start(100, "cargo", "test"),
        open(100, "Cargo.lock"),
        remote(100),
        process(100, 102),
        start(102, "/w/crate/target/debug/deps/t-0a1b"),
        remote(102)
      )
    ).toEqual(["it opened a network connection (t-0a1b to 151.101.2.137 port 443)"])
    // A process it started before it started a thread under the same number, as a process id comes round.
    expect(
      refusals(
        start(100, "cargo", "test"),
        open(100, "Cargo.lock"),
        thread(100, 102),
        start(100, "sh"),
        process(100, 102),
        remote(102)
      )
    ).toEqual(["it opened a network connection (sh to 151.101.2.137 port 443)"])
    // `cargo run` becomes the program it built.
    expect(
      refusals(
        start(100, "cargo", "run"),
        open(100, "Cargo.lock"),
        remote(100),
        start(100, "/w/crate/target/debug/app"),
        remote(100)
      )
    ).toEqual(["it opened a network connection (app to 151.101.2.137 port 443)"])
    // A socket of the machine is no registry.
    expect(
      refusals(
        start(100, "cargo", "test"),
        open(100, "Cargo.lock"),
        "100 connect(4<socket:[10]>, {sa_family=AF_UNIX, sun_path=\"/run/daemon.sock\"}, 110) = 0"
      )
    ).toEqual(["it reached a program outside the run through the socket \"/run/daemon.sock\""])
  })
})

describe("a tool's own notes", () => {
  const start = (pid: number, path: string, ...argv: ReadonlyArray<string>): string =>
    `${pid} execve(${JSON.stringify(path)}, [${
      argv.map((word) => JSON.stringify(word)).join(", ")
    }], 0x7ffc /* 9 vars */) = 0`
  const open = (pid: number, path: string, flags = "O_RDONLY|O_CLOEXEC"): string =>
    `${pid} openat(AT_FDCWD</w>, ${JSON.stringify(path)}, ${flags}) = 3`
  const thread = (pid: number, child: number): string =>
    `${pid} clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD, stack=0x7f}, 88) = ${child}`
  const process = (pid: number, child: number): string =>
    `${pid} clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|SIGCHLD) = ${child}`
  const note = "/w/node_modules/.pnpm-workspace-state-v1.json"
  const found = (...lines: ReadonlyArray<string>): ReadonlyArray<string> =>
    paths(read(lines.join("\n")).found).filter((path) => path.startsWith("/w/"))

  it("are pnpm's note of when it last checked node_modules, under any of its commands", () => {
    const pnpm = /\/node_modules\/\.pnpm-workspace-state-v1\.json$/
    for (
      const line of [
        "pnpm run check",
        "pnpm lint",
        "/usr/local/bin/pnpm --filter app test",
        "node /home/u/.local/bin/pnpm run check",
        "/usr/bin/env node /home/u/.cache/node/corepack/v1/pnpm/11.25.0/bin/pnpm.cjs exec tsc",
        "pnpm install --frozen-lockfile"
      ]
    ) expect([line, ObservedReads.bookkeeping(line.split(" "))]).toEqual([line, pnpm])
    for (const line of ["npm run check", "yarn check", "pnpm-native run check", "node", "node -e 1"]) {
      expect([line, ObservedReads.bookkeeping(line.split(" "))]).toEqual([line, undefined])
    }
    expect(ObservedReads.bookkeeping([])).toBeUndefined()
  })

  // pnpm 11.25 runs `pnpm run format && pnpm run types`: the first installs, as no install step ran, and writes the
  // time into its note; the second reads the note. Counted, `types` ran at every commit for that time alone.
  it("leaves out what pnpm itself reads of its note, and counts what anything else reads", () => {
    const corepack = [
      start(100, "/home/u/.local/bin/pnpm", "pnpm", "run", "types"),
      start(100, "/home/u/.local/node/bin/node", "node", "/home/u/.local/bin/pnpm", "run", "types"),
      open(100, "/w/package.json")
    ]
    expect(found(...corepack, open(100, note), thread(100, 101), open(101, note))).toEqual(["/w/package.json"])
    // No note yet: pnpm looked for it, which is no input either.
    expect(
      read(
        [
          ...corepack,
          `100 openat(AT_FDCWD</w>, ${
            JSON.stringify(note)
          }, O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)`
        ].join("\n")
      ).missing.size
    ).toBe(0)
    // The script pnpm starts, a program the script becomes, and any other program did read it.
    expect(
      found(...corepack, process(100, 102), start(102, "/usr/bin/sh", "sh", "-c", "cat note"), open(102, note))
    ).toEqual([note, "/w/package.json"])
    expect(found(...corepack, start(100, "/usr/bin/node", "node", "types.js"), open(100, note))).toEqual([
      note,
      "/w/package.json"
    ])
    expect(found(start(100, "/usr/bin/cat", "cat", note), open(100, note))).toEqual([note])
    // Every other file pnpm reads in node_modules is an input.
    expect(found(...corepack, open(100, "/w/node_modules/.modules.yaml"))).toEqual([
      "/w/node_modules/.modules.yaml",
      "/w/package.json"
    ])
  })
})

describe("the variables of the host a run could have used", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567"
  const values = { COMMIT: commit, RUN: "1658821493", ATTEMPT: "1", UNSET: undefined }
  const held = (...names: ReadonlyArray<keyof typeof values>) =>
    names.map((name) => [name, ObservedReads.heldAs(values[name])])

  /** A workspace that is a git repository which ignores `node_modules`, and a way to record a run in it. */
  const places = async (repository = true) => {
    const base = await directory()
    const root = Path.join(base, "ws")
    const write = async (file: string, text: string | Buffer = "x"): Promise<string> => {
      const path = Path.resolve(root, file)
      await Fs.mkdir(Path.dirname(path), { recursive: true })
      await Fs.writeFile(path, text)
      return path
    }
    await write(".gitignore", "node_modules\ndist\n")
    if (repository) expect(spawnSync("git", ["-C", root, "init", "--quiet"]).status).toBe(0)
    const open = (name: string): string => `100 openat(AT_FDCWD<${root}>, ${JSON.stringify(name)}, O_RDONLY) = 3`
    const filled = (name: string): string =>
      `100 openat(AT_FDCWD<${root}>, ${JSON.stringify(name)}, O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3`
    const observe = (
      lines: ReadonlyArray<string>,
      variables: Partial<ObservedReads.Variables> = {},
      io?: ObservedReads.Io
    ) => {
      const observed = ObservedReads.observe(ObservedReads.read(() => lines, root), {
        root,
        ignore: [],
        startedMs: Date.now() + 60_000,
        io,
        variables: { values, text: "npm test", ...variables }
      })
      if ("refusal" in observed) throw new Error(observed.refusal)
      return observed.record
    }
    return { base, root, write, open, filled, observe }
  }

  it("holds no variable for a run that shows no use of one", async () => {
    const { observe, open, root, write } = await places()
    await write("src/a.js", "module.exports = 1\n")
    const record = observe([open("src/a.js")])
    expect(record.variables).toBeUndefined()
    // A record with no variable has the id it had before records held any.
    expect(record.id).toBe(ObservedReads.idOf({ reads: record.reads, lists: record.lists }))
    // Whatever the variables hold at the next run, the record answers.
    expect(ObservedReads.changed(record, root, undefined, undefined, undefined, { COMMIT: "another" })).toBeUndefined()
    expect(ObservedReads.changed(record, root)).toBeUndefined()
  })

  it("holds a variable whose name is in the command's own text", async () => {
    const { observe, open, root, write } = await places()
    await write("src/a.js")
    const record = observe([open("src/a.js")], { text: "echo \"$COMMIT\" \"${UNSET-}\" && npm test" })
    expect(record.variables).toEqual(held("COMMIT", "UNSET"))
    expect(record.id).not.toBe(ObservedReads.idOf({ reads: record.reads, lists: record.lists }))
    const now = (given: ObservedReads.Variables["values"]) =>
      ObservedReads.changed(record, root, undefined, undefined, undefined, given)
    expect(now(values)).toBeUndefined()
    // A variable the run never showed it used may hold anything.
    expect(now({ ...values, RUN: "2" })).toBeUndefined()
    expect(now({ ...values, COMMIT: commit.replace("0", "f") })).toBe("the variable COMMIT has another value")
    expect(now({ ...values, UNSET: "" })).toBe("the variable UNSET has another value")
    // A caller that gives no value says the variable is not set.
    expect(ObservedReads.changed(record, root)).toBe("the variable COMMIT has another value")
    // A record never shows a value.
    expect(JSON.stringify(record)).not.toContain(commit)
    expect(ObservedReads.heldAs(undefined)).toBe("-")
    expect(ObservedReads.heldAs("")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("holds a variable whose name is in a file of the workspace the run read, and not one in a file git ignores", async () => {
    const { base, observe, open, write } = await places()
    await write("test/a.test.js", "expect(process.env.COMMIT).toMatchSnapshot()\n")
    await write("src/b.js", "module.exports = 2\n")
    // A tool holds many names it never acts on: an installed package, a build product.
    await write("node_modules/tool/index.js", "const run = process.env.RUN\n")
    await write("dist/app.js", "process.env.RUN\n")
    // A file of two-byte characters, as a script written on Windows is.
    await write("tools/attempt.ps1", Buffer.from("echo $env:ATTEMPT", "utf16le"))
    // A file outside the workspace is not the workspace's text.
    const outside = Path.join(base, "outside.js")
    await Fs.writeFile(outside, "process.env.RUN\n")
    const reads = ["test/a.test.js", "src/b.js", "node_modules/tool/index.js", "dist/app.js", outside].map(open)
    expect(observe(reads).variables).toEqual(held("COMMIT"))
    expect(observe([...reads, open("tools/attempt.ps1")]).variables).toEqual(held("ATTEMPT", "COMMIT"))
    // A file the run only asked about is read all the same when its state is measured.
    expect(
      observe([`100 newfstatat(AT_FDCWD<${Path.join(base, "ws")}>, "test/a.test.js", {st_mode=S_IFREG}, 0) = 0`])
        .variables
    ).toEqual(held("COMMIT"))
    // The one who asks git may be another.
    expect(observe(reads, { ignored: (paths) => new Set(paths) }).variables).toBeUndefined()
    expect(observe(reads, { ignored: () => new Set() }).variables).toEqual(held("COMMIT", "RUN"))
  })

  it("takes every file of the workspace for its own where git cannot say", async () => {
    const { observe, open, root, write } = await places(false)
    await write("node_modules/tool/index.js", "process.env.RUN\n")
    expect(observe([open("node_modules/tool/index.js")]).variables).toEqual(held("RUN"))
    expect(ObservedReads.ignoredByGit(root)([Path.join(root, "node_modules/tool/index.js")])).toEqual(new Set())
    const tracked = await places()
    const installed = await tracked.write("node_modules/tool/index.js")
    const own = await tracked.write("src/a.js")
    expect(ObservedReads.ignoredByGit(tracked.root)([installed, own])).toEqual(new Set([installed]))
    expect(ObservedReads.ignoredByGit(tracked.root)([own])).toEqual(new Set())
  })

  it("holds a variable whose value is in a file the run wrote and left", async () => {
    const { filled, observe, write } = await places()
    await write("out/version.txt", `built from ${commit}\n`)
    await write("out/short.txt", `v1.2.3-${commit.slice(0, 7)}\n`)
    await write("out/run.json", `{"run":${values.RUN}}`)
    // Seven characters of the commit inside a longer run of digits are another number.
    await write("out/other.txt", `a${commit.slice(0, 7)}9 ${commit.slice(0, 7)}f 1\n`)
    await Fs.mkdir(Path.join(Path.dirname(await write("out/keep", "")), "empty"))
    const made = `100 mkdir("out", 0777) = 0`
    expect(observe([made, filled("out/other.txt")]).variables).toBeUndefined()
    expect(observe([made, filled("out/version.txt")]).variables).toEqual(held("COMMIT"))
    expect(observe([made, filled("out/short.txt")]).variables).toEqual(held("COMMIT"))
    expect(observe([made, filled("out/run.json"), filled("out/other.txt")]).variables).toEqual(held("RUN"))
    // A directory holds no text, and a variable already found is not looked for again.
    expect(observe([made, `100 mkdir("out/empty", 0777) = 0`, filled("out/run.json")], { text: "echo $RUN" }).variables)
      .toEqual(held("RUN"))
    // A value of one character is in every file: only its name shows a run used it.
    expect(observe([made, filled("out/other.txt")], { values: { ATTEMPT: "1" } }).variables).toBeUndefined()
  })

  it("asks git first which files count when there is much to search, and searches only those", async () => {
    const { observe, open, root, write } = await places()
    // A tool's cache in the workspace, which git leaves out, holds a name; the run's own script holds another.
    const cache = await write("dist/cache.bin", Buffer.concat([Buffer.alloc(9 * 1024 * 1024, 120), Buffer.from("RUN")]))
    const script = await write("src/run.sh", "echo $COMMIT\n")
    const plain = await write("src/plain.txt", "nothing here\n")
    await write("src/listed/a.txt")
    const asked: Array<ReadonlyArray<string>> = []
    const ignored = (paths: ReadonlyArray<string>): ReadonlySet<string> => {
      asked.push([...paths].sort())
      return ObservedReads.ignoredByGit(root)(paths)
    }
    const lines = [
      open("dist/cache.bin"),
      open("src/run.sh"),
      open("src/plain.txt"),
      open("src/listed"),
      `100 openat(AT_FDCWD<${root}>, "src/absent.txt", O_RDONLY) = -1 ENOENT (No such file or directory)`
    ]
    const record = observe(lines, { ignored, searchFirstAbove: 8 * 1024 * 1024 })
    // The name in the cache says nothing, as before; the one in the script does.
    expect(record.variables).toEqual(held("COMMIT"))
    // Git was asked once, before the search, about every file of the workspace the run read.
    expect(asked).toEqual([[cache, plain, script].sort()])
    // Below the size, git is asked only about the files that held a name, after the search.
    asked.length = 0
    await write("dist/cache.bin", "RUN")
    expect(observe(lines, { ignored, searchFirstAbove: 8 * 1024 * 1024 }).variables).toEqual(held("COMMIT"))
    expect(asked).toEqual([[cache, script].sort()])
    await write("dist/cache.bin", "nothing")
    asked.length = 0
    expect(observe(lines, { ignored, searchFirstAbove: 8 * 1024 * 1024 }).variables).toEqual(held("COMMIT"))
    expect(asked).toEqual([[script]])
  })

  it("searches what the run left as bytes, and reads no file too small to hold a value", async () => {
    const { filled, observe, write } = await places()
    const tiny = await write("out/tiny.txt", "abc")
    await write("out/run.bin", Buffer.concat([Buffer.from([0, 255, 7]), Buffer.from(values.RUN), Buffer.from([0])]))
    await write("out/wide.txt", "日本語のパスです\n")
    const made = `100 mkdir("out", 0777) = 0`
    const read: Array<string> = []
    const io: ObservedReads.Io = {
      ...ObservedReads.defaultIo,
      readFile: (path) => {
        read.push(path)
        return ObservedReads.defaultIo.readFile(path)
      }
    }
    // Three bytes hold neither the commit's seven characters nor the run's ten: the file is not read.
    expect(observe([made, filled("out/tiny.txt")], {}, io).variables).toBeUndefined()
    expect(read).not.toContain(tiny)
    // A value among bytes that are no text is found as it is in text.
    expect(observe([made, filled("out/run.bin")], {}, io).variables).toEqual(held("RUN"))
    // A file is read one byte to a character: a value of wider characters is never in one, as before.
    expect(observe([made, filled("out/wide.txt")], { values: { WIDE: "日本語のパスです" } }, io).variables)
      .toBeUndefined()
  })

  it("does not look in what a locked install fetched, and takes a file it cannot read to hold every value", async () => {
    const { base, filled, observe, root, write } = await places()
    const fetched = await write("node_modules/pkg/sha.txt", commit)
    const npm = await write(Path.join(base, "tools", "npm"), "#!/bin/sh\n")
    const install = [
      `100 execve("${npm}", ["npm", "ci"], 0x7ffd0 /* 3 vars */) = 0`,
      `100 mkdir("node_modules", 0777) = 0`,
      `100 mkdir("node_modules/pkg", 0777) = 0`,
      filled("node_modules/pkg/sha.txt")
    ]
    expect(observe(install).variables).toBeUndefined()
    // The same file written by any other program is the run's own writing.
    expect(observe(install.slice(1)).variables).toEqual(held("COMMIT"))
    const unreadable: ObservedReads.Io = {
      ...ObservedReads.defaultIo,
      readFile: (path) => {
        if (path === fetched) throw new Error("EACCES")
        return ObservedReads.defaultIo.readFile(path)
      }
    }
    expect(observe(install.slice(1), {}, unreadable).variables).toEqual(held("COMMIT", "RUN"))
    expect(root).toBe(Path.dirname(Path.dirname(Path.dirname(fetched))))
  })

  it("hears a value the run prints, also when it is cut in two, and sees one passed to a program", () => {
    const listener = ObservedReads.listening(values)
    listener.hear(Buffer.from(`ok 1\nbuild ${commit.slice(0, 20)}`))
    expect([...listener.names]).toEqual([])
    listener.hear(Buffer.from(`${commit.slice(20)} done\n`))
    expect([...listener.names]).toEqual(["COMMIT"])
    // The short form of a commit, cut after its first characters.
    const short = ObservedReads.listening(values)
    short.hear(Buffer.from(`at ${commit.slice(0, 3)}`))
    short.hear(Buffer.from(`${commit.slice(3, 7)}\n`))
    expect([...short.names]).toEqual(["COMMIT"])
    // A line that starts a program holds its arguments. Any other line of a trace is a path.
    const trace = ObservedReads.listening(values)
    const lines = [
      `100 openat(AT_FDCWD</w>, "/w/${values.RUN}.txt", O_RDONLY) = 3`,
      `100 execve("/usr/bin/git", ["git", "show", "${commit}"], 0x7ffd0 /* 3 vars */) = 0`,
      `100 execve("/usr/bin/true", ["true"], 0x7ffd0 /* 3 vars */) = 0`
    ]
    expect([...trace.lines(() => lines)()]).toEqual(lines)
    expect([...trace.names]).toEqual(["COMMIT"])
    // With nothing long enough to look for, nothing is kept of what goes by.
    const none = ObservedReads.listening({ ATTEMPT: "1", UNSET: undefined })
    none.hear(Buffer.from("1"))
    expect([...none.lines(() => lines)()]).toEqual(lines)
    expect([...none.names]).toEqual([])
  })

  it("takes what the run showed from whoever listened to it", async () => {
    const { observe, open, write } = await places()
    await write("src/a.js")
    expect(observe([open("src/a.js")], { shown: new Set(["RUN"]) }).variables).toEqual(held("RUN"))
  })

  it("finds a value whole, or a commit by its first seven characters where no other digit touches them", () => {
    expect(ObservedReads.holdsValue(`x${commit}y`, commit)).toBe(true)
    expect(ObservedReads.holdsValue(`sha ${commit.slice(0, 7)}.`, commit)).toBe(true)
    expect(ObservedReads.holdsValue(commit.slice(0, 7), commit)).toBe(true)
    expect(ObservedReads.holdsValue(`${commit.slice(0, 7)}8`, commit)).toBe(false)
    expect(ObservedReads.holdsValue(`c${commit.slice(0, 7)}`, commit)).toBe(false)
    expect(ObservedReads.holdsValue(`c${commit.slice(0, 7)} ${commit.slice(0, 7)}`, commit)).toBe(true)
    // Only an id written as a commit is has a short form.
    expect(ObservedReads.holdsValue("run 1658821", "1658821493")).toBe(false)
    expect(ObservedReads.holdsValue("run 1658821493", "1658821493")).toBe(true)
    expect(ObservedReads.holdsValue("12345", "12345")).toBe(false)
    expect(ObservedReads.minimumValueLength).toBe(6)
    expect(ObservedReads.holdsName("a COMMIT b", "COMMIT")).toBe(true)
    expect(ObservedReads.holdsName("a C\0O\0M\0M\0I\0T\0", "COMMIT")).toBe(true)
    expect(ObservedReads.holdsName("a COMMI b", "COMMIT")).toBe(false)
  })

  it("finds the names a text holds together as it finds each alone", () => {
    // Names that overlap, that start inside one another, that a pattern would read as more than text, and one
    // character long: looked for together, each is found exactly where it is found alone.
    const names = [
      "JAVA_HOME",
      "JAVA_HOME_11_X64",
      "HOME",
      "XGIT",
      "GITHUB",
      "A.B",
      "C+",
      "(D)",
      "E|F",
      "[G]",
      "$",
      "Q",
      "RUN\\ID"
    ]
    const wide = (text: string): string => [...text].join("\0")
    const texts = [
      "",
      "nothing of note",
      "export JAVA_HOME_11_X64=/opt",
      "XGITHUB",
      "a HOM b",
      "AxB C (D E|F [G] costs $1",
      "A.B and C+ and (D) and E|F and [G] and RUN\\ID",
      "Q",
      `binary ${wide("JAVA_HOME")} text`,
      `binary ${wide("XGITHUB")} and HOME`,
      "a zero byte \0 and no name",
      `${wide("Q")} ${wide("$")}`,
      "J\0A\0V\0A"
    ]
    const together = ObservedReads.heldNames(names)
    for (const text of texts) {
      expect(together(text)).toEqual(names.filter((name) => ObservedReads.holdsName(text, name)))
    }
    expect(together("export JAVA_HOME_11_X64=/opt")).toEqual(["JAVA_HOME", "JAVA_HOME_11_X64", "HOME"])
    expect(together("XGITHUB")).toEqual(["XGIT", "GITHUB"])
    // No name to look for, no text read.
    expect(ObservedReads.heldNames([])("JAVA_HOME")).toEqual([])
  })

  it("keeps the variables of a record when it moves, and stores them", async () => {
    const stored: ObservedReads.Record = {
      reads: [],
      lists: [],
      from: [["//:install", "i1"]],
      given: [["node_modules/a.js", "f:00", 0]],
      variables: [["COMMIT", ObservedReads.heldAs(commit)]],
      id: "1"
    }
    const moved = ObservedReads.anchored(stored, () => "i2")
    expect(moved?.variables).toEqual(stored.variables)
    expect(moved?.id).toBe(ObservedReads.idOf({ ...stored, from: [["//:install", "i2"]] }))
    expect(await roundTrip(ObservedReads.store(stored, []))).toEqual([stored])
    expect(ObservedReads.asRecord({ ...stored, variables: [["COMMIT"]] })).toBeUndefined()
    expect(ObservedReads.asRecord({ ...stored, variables: "COMMIT" })).toBeUndefined()
  })
})

describe("the stored records", () => {
  const one: ObservedReads.Record = { reads: [["a", "-"], ["b", "f:00", "-"]], lists: [["d", "00", ["x"]]], id: "1" }
  const full: ObservedReads.Record = {
    reads: [],
    lists: [["d", "00", [], [["made-by-a-step", 0]]]],
    from: [["//:install", "i1"]],
    given: [["node_modules/a.js", "f:00", 0]],
    left: true,
    id: "2"
  }

  it("keeps the newest records that fit", async () => {
    const stored = ObservedReads.store(one, [])
    expect(stored).toEqual({ kind: "observed", format: ObservedReads.format, records: [one] })
    expect(await roundTrip(stored)).toEqual([one])
    expect(await roundTrip(ObservedReads.store(full, [one]))).toEqual([full, one])
    const many = ObservedReads.store(one, Array.from({ length: 6 }, (_, index) => ({ ...one, id: `other-${index}` })))
    expect(many?.records.length).toBe(ObservedReads.maximumRecords)
    // A run that read what an earlier run read takes that record's place.
    expect(ObservedReads.store(one, [full, { ...one }])?.records).toEqual([one, full])
    // A record holds 400,000 paths at most, however long they are; one over is not stored.
    const most: ObservedReads.Record = {
      reads: Array.from({ length: ObservedReads.maximumPaths - 2 }, (_, index) => [`${index}`, "-"]),
      lists: [["d", "00", []]],
      given: [["node_modules/a.js", "f:00", 0]],
      from: [["//:install", "i1"]],
      id: "most"
    }
    expect(ObservedReads.pathsOf(most)).toBe(ObservedReads.maximumPaths)
    expect(ObservedReads.store(most, [one])?.records).toEqual([most, one])
    const over = { ...most, reads: [...most.reads, ["one-more", "-"] as const], id: "over" }
    expect(ObservedReads.store(over, [one])).toBeUndefined()
  })

  const digest = "a".repeat(64)

  it("keeps what says that a record's files are kept, also when the record moves", async () => {
    const kept = { archive: digest, outside: [["/home/u/bin/tool", "f:00:x"]], gone: ["stale.txt"] } as const
    const holding: ObservedReads.Record = { ...full, kept }
    expect(await roundTrip(ObservedReads.store(holding, []))).toEqual([holding])
    // The kept files are named by the id the record had, so a record under a new id still finds them.
    expect(ObservedReads.anchored(holding, () => "i2")?.kept).toEqual(kept)
    expect(ObservedReads.anchored(full, () => "i2")?.kept).toBeUndefined()
    // The id of a record does not say whether its files are kept.
    const { id: _, kept: __, ...body } = holding
    const { id: ___, ...same } = full
    expect(ObservedReads.idOf(body)).toBe(ObservedReads.idOf(same))
  })

  it("names a record by a digest of what it holds", () => {
    const { id: _, ...body } = full
    const id = ObservedReads.idOf(body)
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(ObservedReads.idOf({ ...body })).toBe(id)
    expect(ObservedReads.idOf({ ...body, from: [["//:install", "i2"]] })).not.toBe(id)
    expect(ObservedReads.idOf({ reads: body.reads, lists: body.lists })).not.toBe(id)
    const { left: __, ...kept } = body
    expect(ObservedReads.idOf(kept)).not.toBe(id)
  })

  it("moves a record to the new records of the steps it read from", async () => {
    // No step it read from stored a new record.
    expect(ObservedReads.anchored(full, () => undefined)).toBeUndefined()
    expect(ObservedReads.anchored(full, () => "i1")).toBeUndefined()
    expect(ObservedReads.anchored(one, () => "i9")).toBeUndefined()
    const moved = ObservedReads.anchored(full, (label) => label === "//:install" ? "i2" : undefined)!
    const { id, ...body } = moved
    expect(body).toEqual({ reads: [], lists: full.lists, from: [["//:install", "i2"]], given: full.given, left: true })
    expect(id).toBe(ObservedReads.idOf(body))
    expect(await roundTrip(ObservedReads.store(moved, []))).toEqual([moved])
    // A record of a run that left nothing stays one.
    const { left: _, ...plain } = full
    expect(ObservedReads.anchored(plain, () => "i2")?.left).toBeUndefined()
    // A record that names a step and read no file of it holds none after the move either.
    const { given: __, ...bare } = full
    expect(ObservedReads.anchored(bare, () => "i2")?.given).toEqual([])
  })

  it("reads nothing from another shape", () => {
    const stored = ObservedReads.store(one, [])
    for (
      const other of [
        undefined,
        null,
        "text",
        { kind: "shell-test" },
        { ...stored, format: "smthrs-observed-reads/0" },
        { ...stored, records: "none" },
        { ...stored, records: [null] },
        { ...stored, records: ["text"] },
        { ...stored, records: [{ reads: "none", lists: [] }] },
        { ...stored, records: [{ reads: [], lists: "none" }] },
        { ...stored, records: [{ reads: [["only-a-path"]], lists: [] }] },
        { ...stored, records: [{ reads: [["a", 1]], lists: [] }] },
        { ...stored, records: [{ reads: ["a"], lists: [] }] },
        { ...stored, records: [{ reads: [], lists: [["d", "00"]] }] },
        { ...stored, records: [{ reads: [], lists: ["d"] }] },
        { ...stored, records: [{ reads: [], lists: [[1, "00", []]] }] },
        { ...stored, records: [{ reads: [], lists: [["d", 0, []]] }] },
        { ...stored, records: [{ reads: [], lists: [["d", "00", "x"]] }] },
        { ...stored, records: [{ reads: [], lists: [["d", "00", [1]]] }] },
        { ...stored, records: [{ reads: [], lists: [] }] },
        { ...stored, records: [{ reads: [], lists: [], id: 1 }] },
        { ...stored, records: [{ ...full, left: false }] },
        { ...stored, records: [{ ...full, from: "none" }] },
        { ...stored, records: [{ ...full, from: [["//:install"]] }] },
        { ...stored, records: [{ ...full, from: [["//:install", 1]] }] },
        { ...stored, records: [{ ...full, given: "none" }] },
        { ...stored, records: [{ ...full, given: [["node_modules/a.js", "f:00"]] }] },
        { ...stored, records: [{ ...full, given: [["node_modules/a.js", "f:00", 1]] }] },
        { ...stored, records: [{ ...full, given: [["node_modules/a.js", "f:00", -1]] }] },
        { ...stored, records: [{ ...full, given: [["node_modules/a.js", "f:00", 0.5]] }] },
        { ...stored, records: [{ ...full, given: [[1, "f:00", 0]] }] },
        { ...stored, records: [{ ...full, given: [["node_modules/a.js", 0, 0]] }] },
        { ...stored, records: [{ ...full, lists: [["d", "00", [], "x"]] }] },
        { ...stored, records: [{ ...full, lists: [["d", "00", [], [["x"]]]] }] },
        { ...stored, records: [{ ...full, lists: [["d", "00", [], [[1, 0]]]] }] },
        { ...stored, records: [{ ...full, lists: [["d", "00", [], [["x", 3]]]] }] },
        { ...stored, records: [{ ...full, lists: [["d", "00", [], [], "more"]] }] },
        { ...stored, records: [{ ...full, kept: "yes" }] },
        { ...stored, records: [{ ...full, kept: null }] },
        { ...stored, records: [{ ...full, kept: { archive: "../x", outside: [], gone: [] } }] },
        { ...stored, records: [{ ...full, kept: { archive: 1, outside: [], gone: [] } }] },
        { ...stored, records: [{ ...full, kept: { archive: digest, outside: "none", gone: [] } }] },
        { ...stored, records: [{ ...full, kept: { archive: digest, outside: [["/a"]], gone: [] } }] },
        { ...stored, records: [{ ...full, kept: { archive: digest, outside: [["/a", 1]], gone: [] } }] },
        { ...stored, records: [{ ...full, kept: { archive: digest, outside: [], gone: "none" } }] },
        { ...stored, records: [{ ...full, kept: { archive: digest, outside: [], gone: [1] } }] }
      ]
    ) {
      // An entry of another shape names no record; a record of another shape is none.
      const entry = other as { readonly kind?: unknown; readonly format?: unknown; readonly records?: unknown }
      const records = entry?.records
      if (
        entry?.kind === "observed" && entry.format === ObservedReads.format && Array.isArray(records) &&
        typeof records[0] === "object" && records[0] !== null
      ) {
        expect(ObservedReads.asRecord(records[0])).toBeUndefined()
      } else expect(RecordStore.references(other)).toEqual([])
    }
  })
})

describe("the paths a record leaves out", () => {
  it("resolves the cache directory and each declared path", async () => {
    const base = await directory()
    const root = Path.join(base, "ws")
    const home = Path.join(base, "home")
    await Fs.mkdir(Path.join(root, ".flows"), { recursive: true })
    await Fs.mkdir(Path.join(base, "real-logs"), { recursive: true })
    await Fs.mkdir(home)
    await Fs.symlink(Path.join(base, "real-logs"), Path.join(home, "logs"))
    expect(ObservedReads.ignored(root, home, ".flows", ["~/logs", "~", "tmp/scratch", "/var/absolute"])).toEqual([
      Path.join(root, ".flows"),
      Path.join(base, "real-logs"),
      home,
      Path.join(root, "tmp", "scratch"),
      "/var/absolute"
    ])
    // `$TMPDIR` is the run's temporary directory: the one it is given, or the host's.
    const temporary = Path.join(base, "tmp")
    expect(ObservedReads.ignored(root, home, ".flows", ["$TMPDIR/node-compile-cache", "$TMPDIR"], temporary)).toEqual([
      Path.join(root, ".flows"),
      Path.join(temporary, "node-compile-cache"),
      temporary
    ])
    expect(ObservedReads.ignored(root, home, ".flows", ["$TMPDIR/x", "$TMPDIRECTORY"])).toEqual([
      Path.join(root, ".flows"),
      Path.join(Os.tmpdir(), "x"),
      Path.join(root, "$TMPDIRECTORY")
    ])
  })
})

describe("the mark a run begins at", () => {
  it("is later than every file written before it, also in the same tick", async () => {
    const root = await directory()
    // A build puts back what an earlier step left and starts the next step at once: the same tick, often.
    for (let round = 0; round < 200; round += 1) {
      const before = Path.join(root, `put-back-${round}`)
      NodeFs.writeFileSync(before, "what an earlier step left")
      const started = ObservedReads.markStart(Path.join(root, "trace"))
      expect(started, `round ${round}`).toBeGreaterThan(NodeFs.lstatSync(before).ctimeMs)
      expect(started).toBe(NodeFs.statSync(Path.join(root, "trace")).ctimeMs)
    }
    // Where the clock does not move within the time allowed, the first time is the mark.
    const trace = Path.join(root, "still")
    expect(ObservedReads.markStart(trace, 0)).toBe(NodeFs.statSync(trace).ctimeMs)
  })
})

describe("the lines of a trace file", () => {
  it("reads a large file a block at a time, with or without a last line break", async () => {
    const root = await directory()
    const file = Path.join(root, "t.trace")
    const line = `100 stat("/w/${"x".repeat(900)}", {st_mode=S_IFREG|0644, ...}) = 0`
    NodeFs.writeFileSync(file, `${Array.from({ length: 3000 }, () => line).join("\n")}\nlast`)
    const lines = [...ObservedReads.linesOf(file)()]
    expect(lines.length).toBe(3001)
    expect(lines[0]).toBe(line)
    expect(lines.at(-1)).toBe("last")
    NodeFs.writeFileSync(file, "one\ntwo\n")
    expect([...ObservedReads.linesOf(file)()]).toEqual(["one", "two"])
    expect(() => [...ObservedReads.linesOf(Path.join(root, "missing"))()]).toThrow()
  })
})
