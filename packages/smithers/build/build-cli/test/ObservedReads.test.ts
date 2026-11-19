/**
 * What a run read: the trace reader, the record it becomes, and the check
 * that answers whether the run would read the same again.
 *
 * The trace lines are the tracer's own output format, as `strace -f -y`
 * printed it for real commands. Records are measured on real directories.
 * `ObservedReadsExecution.test.ts` runs the real tracer end to end.
 */
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

const directory = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-observed-reads-")))
  temporary.push(root)
  return root
}

const read = (text: string, cwd = "/w"): ObservedReads.Trace => ObservedReads.read(() => text.split("\n"), cwd)

const paths = (map: ReadonlyMap<string, number>): ReadonlyArray<string> => [...map.keys()].sort()

describe("the tracer command", () => {
  it("runs the command under the tracer and names the trace file", () => {
    const argv = ObservedReads.command("/usr/bin/strace", "/tmp/t.trace", ["/bin/sh", "-c", "true"])
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(argv.slice(3)).toEqual(["smthrs-observe", "/usr/bin/strace", "/tmp/t.trace", "/bin/sh", "-c", "true"])
    const script = argv[2]!
    expect(script).toContain("'-f'")
    expect(script).toContain("'--seccomp-bpf'")
    expect(script).toContain("'inject=io_uring_setup:error=ENOSYS'")
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
    expect(ObservedReads.observer({ platform: "linux", executable: () => tracer })).toEqual({ tracer })
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

describe("reading a trace", () => {
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
      "/proc/self/exe",
      "/w/a.txt",
      "/w/dir/child",
      "/w/other/in-other",
      "/w/other/plain",
      "/w/sub",
      "/w/sub/rel.txt",
      "/w/third/rl",
      "/w/third/still-third",
      "/w/third/sx"
    ])
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

  it("notes each program a run starts and each one it looks for", () => {
    const trace = read([
      "100 execve(\"./run.sh\", [\"./run.sh\"], 0x7ffd0 /* 3 vars */) = 0",
      "100 execve(\"/usr/local/bin/tool\", [\"tool\"], 0x7ffd0 /* 3 vars */) = -1 ENOENT (No such file or directory)",
      "100 execveat(AT_FDCWD</w>, \"tool\", [\"tool\"], 0x7ffd0 /* 3 vars */, 0) = 0"
    ].join("\n"))
    expect(paths(trace.started)).toEqual(["/w/./run.sh", "/w/tool"])
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

  it("stores nothing for a run that changed its view of the file system", () => {
    expect(read("100 chroot(\"/w/jail\")                = 0").refusals).toEqual(["it changed its root directory"])
    expect(read("100 mount(\"none\", \"/mnt\", \"tmpfs\", 0, NULL) = 0").refusals)
      .toEqual(["it changed its view of the file system"])
    expect(read("100 pivot_root(\".\", \".\")             = 0").refusals)
      .toEqual(["it changed its view of the file system"])
    expect(read("100 setns(5</proc/1/ns/mnt>, CLONE_NEWNS) = 0").refusals)
      .toEqual(["it changed its view of the file system"])
    expect(read("100 setns(5</proc/1/ns/mnt>, CLONE_NEWNS) = -1 EPERM (Operation not permitted)").refusals)
      .toEqual([])
    expect(read("100 mount(\"none\", \"/mnt\", \"tmpfs\", 0, NULL) = -1 EPERM (Operation not permitted)").refusals)
      .toEqual([])
    expect(read("100 io_uring_setup(256, {flags=0, sq_thread_cpu=0}) = 4<anon_inode:[io_uring]>").refusals)
      .toEqual(["it read through io_uring, which a trace does not show"])
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
    const answered = read("100 stat(\"/w/unknown\", {st_mode=S_IFREG|0644, ...}) = ?")
    expect(paths(answered.found)).toEqual(["/w/unknown"])
    const wrote = read("100 unlink(\"/w/unknown\") = ?")
    expect([...wrote.changed]).toEqual(["/w/unknown"])
    expect(paths(wrote.made)).toEqual([])
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
      // Read and then rewritten: compared with what the run left.
      open(root, "src/b.txt"),
      open(root, "src/b.txt", "O_WRONLY|O_TRUNC"),
      // Removed without ever being read, and made at the top of the file system: neither is an input.
      `100 unlink("${root}/src/scratch.tmp") = 0`,
      "100 mkdir(\"/smithers-observed-reads-made\", 0777) = 0"
    ]))
    const cache = ObservedReads.measure(Path.join(root, "src", "cache.json"))
    expect(stored.reads).toEqual([
      ["src", "d"],
      ["src/b.txt", ObservedReads.measure(Path.join(root, "src", "b.txt"))],
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
    // With nothing mounted the same names are the host's own, where there is no such directory: the run read what
    // nobody can find again, and stores nothing.
    expect(recorded(lines)).toEqual({ refusal: "/shared was removed while it ran" })
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
        reads: [["src/a.txt", ObservedReads.measure(Path.join(root, "src", "a.txt"))]],
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
    expect(ObservedReads.decode(ObservedReads.store(record, []))).toEqual([record])
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
    expect(ObservedReads.changed(record, root)).toBe("node_modules/pkg/index.js changed")
    // A step answered from the record this run read it under does not make a changed file its own.
    const all = (label: string): ReadonlySet<string> => new Set([label === "//:install" ? "install-1" : "build-1"])
    expect(ObservedReads.changed(record, root, undefined, undefined, all)).toBe("node_modules/pkg/index.js changed")
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
    expect(ObservedReads.changed(record, root)).toBe("node_modules is gone")
    expect(ObservedReads.changed(record, root, undefined, undefined, answered({ "//:install": "install-1" })))
      .toBe("src/generated.js is gone")
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
    expect(ObservedReads.changed(record, root, undefined, undefined, both)).toBe("src/generated.js changed")
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
    expect(ObservedReads.decode(ObservedReads.store(stored, []))).toEqual([stored])
    const wrong = { ...stored, variables: [["COMMIT"]] }
    expect(ObservedReads.decode({ kind: "observed", format: ObservedReads.format, records: [wrong] })).toEqual([])
    const noList = { ...stored, variables: "COMMIT" }
    expect(ObservedReads.decode({ kind: "observed", format: ObservedReads.format, records: [noList] })).toEqual([])
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

  it("keeps the newest records that fit", () => {
    const stored = ObservedReads.store(one, [])
    expect(stored).toEqual({ kind: "observed", format: ObservedReads.format, records: [one] })
    expect(ObservedReads.decode(stored)).toEqual([one])
    expect(ObservedReads.decode(ObservedReads.store(full, [one]))).toEqual([full, one])
    const many = ObservedReads.store(one, Array.from({ length: 6 }, (_, index) => ({ ...one, id: `other-${index}` })))
    expect(many?.records.length).toBe(ObservedReads.maximumRecords)
    // A run that read what an earlier run read takes that record's place.
    expect(ObservedReads.store(one, [full, { ...one }])?.records).toEqual([one, full])
    const large: ObservedReads.Record = {
      reads: Array.from({ length: 150_000 }, (_, index) => [`${"long-directory-name/".repeat(4)}${index}`, "-"]),
      lists: [],
      id: "large"
    }
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(ObservedReads.maximumBytes)
    expect(ObservedReads.store(large, [one])).toBeUndefined()
    const half: ObservedReads.Record = { reads: large.reads.slice(0, 90_000), lists: [], id: "half" }
    expect(ObservedReads.store(half, [{ ...half, id: "half-again" }, one])?.records).toEqual([half])
  })

  const digest = "a".repeat(64)

  it("keeps what says that a record's files are kept, also when the record moves", () => {
    const kept = { archive: digest, outside: [["/home/u/bin/tool", "f:00:x"]], gone: ["stale.txt"] } as const
    const holding: ObservedReads.Record = { ...full, kept }
    expect(ObservedReads.decode(ObservedReads.store(holding, []))).toEqual([holding])
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

  it("moves a record to the new records of the steps it read from", () => {
    // No step it read from stored a new record.
    expect(ObservedReads.anchored(full, () => undefined)).toBeUndefined()
    expect(ObservedReads.anchored(full, () => "i1")).toBeUndefined()
    expect(ObservedReads.anchored(one, () => "i9")).toBeUndefined()
    const moved = ObservedReads.anchored(full, (label) => label === "//:install" ? "i2" : undefined)!
    const { id, ...body } = moved
    expect(body).toEqual({ reads: [], lists: full.lists, from: [["//:install", "i2"]], given: full.given, left: true })
    expect(id).toBe(ObservedReads.idOf(body))
    expect(ObservedReads.decode(ObservedReads.store(moved, []))).toEqual([moved])
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
    ) expect(ObservedReads.decode(other)).toEqual([])
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
