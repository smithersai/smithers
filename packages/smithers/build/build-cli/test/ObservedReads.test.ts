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
    const record = (
      lines: ReadonlyArray<string>,
      ignore: ReadonlyArray<string> = [],
      startedMs = Date.now() + 60_000
    ) => ObservedReads.record(ObservedReads.read(() => lines, root), { root, ignore, startedMs })
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
    expect(rows(record(filled, [], 0))).toEqual({ reads: [], lists: [] })
    // The same file read with no move before it is somebody else's, changed during the run.
    expect(record([open(root, "cache/pkg/RECORD")], [], 0)).toEqual({
      refusal: "cache/pkg/RECORD changed while it ran"
    })
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
    const { record, root } = await setup()
    // The run began before the file was last written, and the run did not write it.
    expect(record([open(root, "src/a.txt")], [], Date.now() - 60_000))
      .toEqual({ refusal: "src/a.txt changed while it ran" })
    expect(record([`100 getdents64(3<${root}/src>, 0x55 /* 4 entries */, 32768) = 100`], [], Date.now() - 60_000))
      .toEqual({ refusal: "src changed while it ran" })
    expect(record([open(root, "src/a.txt"), open(root, "src/a.txt", "O_RDWR")], [], Date.now() - 60_000))
      .toEqual({ reads: [["src/a.txt", ObservedReads.measure(Path.join(root, "src", "a.txt"))]], lists: [] })
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

describe("the stored records", () => {
  const one: ObservedReads.Record = { reads: [["a", "-"], ["b", "f:00", "-"]], lists: [["d", "00", ["x"]]] }

  it("keeps the newest records that fit", () => {
    const stored = ObservedReads.store(one, [])
    expect(stored).toEqual({ kind: "observed", format: ObservedReads.format, records: [one] })
    expect(ObservedReads.decode(stored)).toEqual([one])
    const many = ObservedReads.store(one, Array.from({ length: 6 }, () => one))
    expect(many?.records.length).toBe(ObservedReads.maximumRecords)
    const large: ObservedReads.Record = {
      reads: Array.from({ length: 150_000 }, (_, index) => [`${"long-directory-name/".repeat(4)}${index}`, "-"]),
      lists: []
    }
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(ObservedReads.maximumBytes)
    expect(ObservedReads.store(large, [one])).toBeUndefined()
    const half: ObservedReads.Record = { reads: large.reads.slice(0, 90_000), lists: [] }
    expect(ObservedReads.store(half, [half, one])?.records).toEqual([half])
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
        { ...stored, records: [{ reads: [], lists: [["d", "00", [1]]] }] }
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
