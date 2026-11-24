/**
 * `smthrs-observe` against the kernel: each kind of call it writes a line for,
 * made by a real program on real files, and the answer the line gives held
 * against the answer the program got.
 *
 * A line's answer is read from the file system just before the call goes on.
 * The reader asks one thing of it: for a call that looks at a path, whether
 * the path was there; for a call that makes a name, whether the name was
 * made. Those must agree with the kernel's answer. Where the kernel gave
 * another error for a path that was there (`EINVAL` from `readlink` on a
 * file, `EACCES` past a closed directory), the line must still say the path
 * was there or that it could not be looked at, never that it was missing.
 */
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { spawn, spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as Races from "./helpers/Races.ts"
import { selfSignalling, signalling, survivedTimer } from "./helpers/SignalStorm.ts"

const temporary: Array<string> = []
afterEach(async () => {
  for (const root of temporary.splice(0)) {
    await Fs.chmod(Path.join(root, "w", "closed"), 0o755).catch(() => undefined)
    await Fs.rm(root, { recursive: true, force: true })
  }
})

const supervisor = ObservedReads.supervisorPath(process.platform, process.arch, {
  SMTHRS_OBSERVE_WITH: "smthrs-observe"
})
const supervised = it.skipIf(supervisor === undefined || process.getuid?.() === 0)

/** The program: makes each call on the names below `root` and prints what the kernel answered, one JSON line each. */
const program = String.raw`
import * as fs from "node:fs"
import * as net from "node:net"
import { spawnSync } from "node:child_process"
const root = process.argv[2]
const at = (name) => root + "/" + name
const answers = []
const call = (kind, name, body) => {
  try { body(); answers.push({ kind, name, code: "0" }) } catch (error) { answers.push({ kind, name, code: error.code }) }
}
call("open", "file", () => fs.closeSync(fs.openSync(at("file"), "r")))
call("open", "missing", () => fs.openSync(at("missing"), "r"))
call("open", "file/below", () => fs.openSync(at("file/below"), "r"))
call("open", "closed/inner", () => fs.openSync(at("closed/inner"), "r"))
call("open", "link", () => fs.closeSync(fs.openSync(at("link"), "r")))
call("open", "dangling", () => fs.openSync(at("dangling"), "r"))
call("create", "file", () => fs.openSync(at("file"), "wx"))
call("create", "fresh", () => fs.closeSync(fs.openSync(at("fresh"), "wx")))
call("create", "nowhere/new", () => fs.openSync(at("nowhere/new"), "wx"))
call("write", "file", () => fs.closeSync(fs.openSync(at("file"), "w")))
call("write", "written", () => fs.closeSync(fs.openSync(at("written"), "a")))
call("look", "file", () => fs.statSync(at("file")))
call("look", "missing", () => fs.statSync(at("missing")))
call("look", "dangling", () => fs.statSync(at("dangling")))
call("lookLink", "dangling", () => fs.lstatSync(at("dangling")))
call("look", "access-file", () => fs.accessSync(at("file")))
call("look", "access-missing", () => fs.accessSync(at("access-missing")))
call("readlink", "link", () => fs.readlinkSync(at("link")))
call("readlink", "file", () => fs.readlinkSync(at("file")))
call("mkdir", "made", () => fs.mkdirSync(at("made")))
call("mkdir", "made", () => fs.mkdirSync(at("made")))
call("mkdir", "nowhere/made", () => fs.mkdirSync(at("nowhere/made")))
// A name with a slash at its end, as uv makes each directory of a package it unpacks: only a directory is made there.
call("mkdir", "slashed/", () => fs.mkdirSync(at("slashed/")))
call("mkdir", "nowhere/slashed/", () => fs.mkdirSync(at("nowhere/slashed/")))
call("create", "slashed-file/", () => fs.openSync(at("slashed-file/"), "wx"))
call("symlink", "slashed-soft/", () => fs.symlinkSync("file", at("slashed-soft/")))
call("rename", "slashed/", () => fs.renameSync(at("slashed/"), at("moved-dir/")))
call("rename", "plain", () => fs.renameSync(at("plain"), at("plain-dir/")))
call("rename", "fresh", () => fs.renameSync(at("fresh"), at("moved")))
call("rename", "absent", () => fs.renameSync(at("absent"), at("anywhere")))
call("rename", "other", () => fs.renameSync(at("other"), at("target")))
call("link", "file", () => fs.linkSync(at("file"), at("hard")))
call("link", "file", () => fs.linkSync(at("file"), at("target")))
call("symlink", "soft", () => fs.symlinkSync("file", at("soft")))
call("symlink", "soft", () => fs.symlinkSync("file", at("soft")))
call("remove", "hard", () => fs.unlinkSync(at("hard")))
call("remove", "hard", () => fs.unlinkSync(at("hard")))
call("remove", "made", () => fs.rmdirSync(at("made")))
call("change", "moved", () => fs.chmodSync(at("moved"), 0o600))
call("change", "gone-change", () => fs.chmodSync(at("gone-change"), 0o600))
call("list", "listed", () => fs.readdirSync(at("listed")))
call("chdir", "listed", () => process.chdir(at("listed")))
call("chdir", "no-dir", () => process.chdir(at("no-dir")))
call("exec", "tool", () => { const r = spawnSync(at("tool"), ["word"]); if (r.error) throw r.error })
call("exec", "no-tool", () => { const r = spawnSync(at("no-tool"), ["word"]); if (r.error) throw r.error })
await new Promise((resolve) => {
  const socket = net.connect(at("no-socket"))
  socket.on("error", (error) => { answers.push({ kind: "connect", name: "no-socket", code: error.code }); resolve() })
  socket.on("connect", () => { answers.push({ kind: "connect", name: "no-socket", code: "0" }); socket.end(); resolve() })
})
await new Promise((resolve) => {
  const server = net.createServer((socket) => socket.end()).listen(at("socket"), () => {
    const socket = net.connect(at("socket"), () => {
      answers.push({ kind: "connect", name: "socket", code: "0" })
      socket.end()
      server.close(resolve)
    })
  })
})
for (const answer of answers) console.log(JSON.stringify(answer))
`

/** The calls the program made, as the kernel answered them, and the trace smthrs-observe wrote of them. */
const recorded = async () => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-calls-")))
  temporary.push(base)
  const root = Path.join(base, "w")
  await Fs.mkdir(Path.join(root, "closed"), { recursive: true })
  await Fs.mkdir(Path.join(root, "listed"))
  await Fs.writeFile(Path.join(root, "file"), "file\n")
  await Fs.writeFile(Path.join(root, "other"), "other\n")
  await Fs.writeFile(Path.join(root, "plain"), "plain\n")
  await Fs.writeFile(Path.join(root, "target"), "target\n")
  await Fs.writeFile(Path.join(root, "closed", "inner"), "inner\n")
  await Fs.writeFile(Path.join(root, "tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  await Fs.symlink("file", Path.join(root, "link"))
  await Fs.symlink("nothing", Path.join(root, "dangling"))
  await Fs.chmod(Path.join(root, "closed"), 0o000)
  const script = Path.join(base, "calls.mjs")
  await Fs.writeFile(script, program)
  const trace = Path.join(base, "trace")
  const run = spawnSync(supervisor!, [trace, "--", process.execPath, script, root], { encoding: "utf8" })
  expect(run.status, run.stderr).toBe(0)
  const answers = run.stdout.trim().split("\n").map((line) =>
    JSON.parse(line) as { readonly kind: string; readonly name: string; readonly code: string }
  )
  return { answers, lines: NodeFs.readFileSync(trace, "utf8").split("\n"), root }
}

/** The answer a line gives, after its last `) = `: `0`, `?` or an error's name. */
const answerOf = (line: string): string => {
  const answer = line.slice(line.lastIndexOf(") = ") + 4)
  return answer.startsWith("-1 ") ? answer.split(" ")[1]! : answer
}

/** Whether an answer says the path was missing, as the reader reads it. */
const missing = (code: string): boolean => code === "ENOENT" || code === "ENOTDIR"

describe("smthrs-observe", () => {
  supervised("gives each call the answer the kernel gave it", async () => {
    const { answers, lines, root } = await recorded()
    const quoted = (name: string): string => JSON.stringify(Path.join(root, name))
    /** The lines of one call, in order: those that name the path, made by the call `name` writes. */
    const of = (call: string, name: string): ReadonlyArray<string> =>
      lines.filter((line) => line.includes(` ${call}(`) && line.includes(quoted(name)))
    const taken = new Map<string, number>()
    /** The next line of a call: the program makes some calls twice. */
    const next = (call: string, name: string): string => {
      const key = `${call} ${name}`
      const index = taken.get(key) ?? 0
      taken.set(key, index + 1)
      const line = of(call, name)[index]
      expect(line, `a ${call} line for ${name}`).toBeDefined()
      return line!
    }
    for (const { code, kind, name } of answers) {
      switch (kind) {
        case "open":
        case "write":
        case "look":
        case "lookLink":
        case "readlink":
        case "change":
        case "chdir": {
          const call = kind === "open" || kind === "write" ? "openat" : kind === "chdir" ? "chdir" : "newfstatat"
          const target = name === "access-file" ? "file" : name
          const flags = kind === "open" ? "O_RDONLY" : kind === "write" ? "O_WRONLY" : ""
          // A change is written by the call's own name: node's chmod is `chmod` on x86_64 and `fchmodat` on aarch64.
          const candidates = kind === "change" ? [...of("chmod", target), ...of("fchmodat", target)] : of(call, target)
          // The first line of the kind says what was there; a link's own look is the one that does not follow it.
          const line = candidates.find((candidate) =>
            candidate.includes(flags) && (kind !== "lookLink" || candidate.includes("NOFOLLOW"))
          )
          expect(line, `${kind} ${name}`).toBeDefined()
          expect(missing(answerOf(line!)), `${kind} ${name}: ${line} against ${code}`).toBe(missing(code))
          break
        }
        case "create":
        case "mkdir":
        case "symlink":
        case "link": {
          const call = kind === "create"
            ? "openat"
            : kind === "mkdir"
            ? "mkdirat"
            : kind === "symlink"
            ? "symlinkat"
            : "linkat"
          const line = kind === "create"
            ? of(call, name).find((candidate) => candidate.includes("O_EXCL"))!
            : next(call, name)
          // Made where the kernel made it, and not made where it refused.
          expect(answerOf(line) === "0", `${kind} ${name}: ${line} against ${code}`).toBe(code === "0")
          break
        }
        case "rename": {
          const line = next("renameat2", name)
          expect(answerOf(line) === "0", `${kind} ${name}: ${line} against ${code}`).toBe(code === "0")
          break
        }
        case "remove": {
          const line = next("unlinkat", name)
          expect(missing(answerOf(line)), `${kind} ${name}: ${line} against ${code}`).toBe(missing(code))
          break
        }
        case "list": {
          expect(lines.some((line) => line.includes(` getdents64(0<${Path.join(root, name)}>`))).toBe(true)
          break
        }
        case "exec": {
          const tried = of("execve", name)
          if (code === "0") {
            // Looked at and started with no answer, then started, once a later stop showed it running.
            expect(tried.map(answerOf)).toEqual(["?", "0"])
          } else expect(tried.map(answerOf)).toEqual([code])
          break
        }
        case "connect": {
          const line = lines.find((candidate) => candidate.includes(" connect(") && candidate.includes(quoted(name)))!
          expect(answerOf(line) === "0", `${kind} ${name}: ${line} against ${code}`).toBe(code === "0")
          break
        }
        default:
          throw new Error(`no check for ${kind}`)
      }
    }
    // A name that was there before a call wrote it is one the run found.
    const target = lines.findIndex((line) => line.includes(` renameat2(`) && line.includes(quoted("target")))
    expect(lines[target - 1]).toContain(`newfstatat(AT_FDCWD, ${quoted("target")}, {...}, AT_SYMLINK_NOFOLLOW) = 0`)
    // The run's socket is bound, as its copy of the socket says at the end.
    expect(lines.some((line) => line.includes(" bind(") && line.includes(quoted("socket")) && line.endsWith(" = 0")))
      .toBe(true)
    // The first and last lines say the trace is whole.
    expect(lines[0]).toMatch(/^\d+ \+\+\+ smthrs-observe 1 \+\+\+$/)
    expect(lines.filter((line) => line !== "").at(-1)).toMatch(/^\d+ \+\+\+ complete \+\+\+$/)
    expect(ObservedReads.read(() => lines, root).refusals).toEqual([])
  })
})

/**
 * A program that listens on a loopback port, closes it, and listens on it
 * again, itself and in a process it starts, as eliza's build lock takes and
 * gives back a port (`packages/scripts/with-package-build-lock.ts`). The
 * kernel frees a port when its last socket closes; the copy the recorder
 * takes of a bound socket must not keep it taken.
 */
const relisten = String.raw`
import * as net from "node:net"
import { spawnSync } from "node:child_process"
const listen = (port) => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once("error", reject)
  server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(server))
})
const close = (server) => new Promise((resolve) => server.close(resolve))
const answer = (promise) => promise.then(async (server) => { await close(server); return "0" }, (error) => error.code)
const refused = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port })
  socket.on("error", (error) => resolve(error.code))
  socket.on("connect", () => { socket.destroy(); resolve("0") })
})
const first = await listen(0)
const port = first.address().port
await close(first)
const again = await answer(listen(port))
const connect = await refused(port)
const other = spawnSync(process.execPath, ["--input-type=module", "-e",
  "import * as net from 'node:net'; const s = net.createServer(); s.once('error', (e) => { console.log(e.code) });" +
  " s.listen({ host: '127.0.0.1', port: " + port + ", exclusive: true }, () => { console.log('0'); s.close() })"],
  { encoding: "utf8" }).stdout.trim()
console.log(JSON.stringify({ port, again, connect, other }))
`

describe("smthrs-observe and sockets", () => {
  supervised("identifies UDP binds, connects and addressed sends as the same local transport", async () => {
    const script = `
import socket
with socket.socket(type=socket.SOCK_DGRAM) as receiver, socket.socket(type=socket.SOCK_DGRAM) as sender:
    receiver.bind(("127.0.0.1", 0))
    peer = receiver.getsockname()
    sender.sendto(b"a", peer)
    sender.connect(peer)
    sender.send(b"b")
    assert [receiver.recv(1), receiver.recv(1)] == [b"a", b"b"]
    print(peer[1])
`
    const { base, lines, run } = await record("local-udp", () => ["python3", "-c", script])
    const port = run.stdout.trim()
    const peer = lines.filter((line) => line.includes(`sin_port=htons(${port})`))
    for (const call of ["bind", "sendto", "connect"]) {
      expect(peer.some((line) => line.includes(` ${call}(`) && line.includes(" /* smthrs: udp */"))).toBe(true)
    }
    const reads = ObservedReads.read(() => lines, base)
    expect(reads.bound?.has(`udp:inet:${port}:127.0.0.1`)).toBe(true)
    expect(reads.outside).toEqual([])
  })

  supervised("frees a port the run closed, for the run itself and a process it starts", async () => {
    const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-sockets-")))
    temporary.push(base)
    const script = Path.join(base, "relisten.mjs")
    await Fs.writeFile(script, relisten)
    const trace = Path.join(base, "trace")
    const plain = spawnSync(process.execPath, [script], { encoding: "utf8" })
    const run = spawnSync(supervisor!, [trace, "--", process.execPath, script], { encoding: "utf8" })
    expect(run.status, run.stderr).toBe(0)
    const unrecorded = JSON.parse(plain.stdout) as { readonly port: number }
    const answers = JSON.parse(run.stdout) as { readonly port: number }
    // The same answers as unrecorded: listening again works, in the run and in a process it started, and a
    // connection to the closed port is refused.
    expect({ ...unrecorded, port: 0 }).toEqual({ port: 0, again: "0", connect: "ECONNREFUSED", other: "0" })
    expect({ ...answers, port: 0 }).toEqual({ port: 0, again: "0", connect: "ECONNREFUSED", other: "0" })
    // Each bind is still written as made, and the trace is whole.
    const lines = NodeFs.readFileSync(trace, "utf8").split("\n")
    const binds = lines.filter((line) => line.includes(" bind(") && line.includes("127.0.0.1") && line.endsWith(" = 0"))
    expect(binds.length).toBeGreaterThanOrEqual(3)
    expect(lines.filter((line) => line !== "").at(-1)).toMatch(/^\d+ \+\+\+ complete \+\+\+$/)
  })
})

/** bubblewrap, which can load a system-call filter of a test's own around a program. */
const bwrap = (() => {
  const found = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout.trim()
  return found === "" ? undefined : found
})()

/** `pidfd_getfd`, numbered alike on x86_64 and aarch64. */
const pidfdGetfd = 438
/** `process_vm_readv`, which reads every path a call names from the caller's memory. */
const processVmReadv = process.arch === "arm64" ? 270 : 310

/**
 * A seccomp program that answers EPERM to one call (`pidfd_getfd` unless
 * another is named) and lets every other call through, as Docker's default
 * profile does in a container without CAP_SYS_PTRACE.
 */
const refusingCall = (call: number): Buffer => {
  const instruction = (code: number, jt: number, jf: number, k: number) => {
    const bytes = Buffer.alloc(8)
    bytes.writeUInt16LE(code, 0)
    bytes[2] = jt
    bytes[3] = jf
    bytes.writeUInt32LE(k >>> 0, 4)
    return bytes
  }
  return Buffer.concat([
    instruction(0x20, 0, 0, 0), // load the call's number
    instruction(0x15, 0, 1, call), // the call refused?
    instruction(0x06, 0, 0, 0x00050000 | 1), // answer EPERM
    instruction(0x06, 0, 0, 0x7fff0000) // let it through
  ])
}

/** Runs `argv` under bubblewrap with that program loaded, the whole file system in sight. */
const refusing = async (argv: ReadonlyArray<string>, call = pidfdGetfd) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-refused-")))
  temporary.push(base)
  const filter = Path.join(base, "filter.bpf")
  await Fs.writeFile(filter, refusingCall(call))
  const descriptor = NodeFs.openSync(filter, "r")
  try {
    const run = spawnSync(bwrap!, ["--dev-bind", "/", "/", "--seccomp", "3", "--", ...argv], {
      encoding: "utf8",
      cwd: base,
      stdio: ["ignore", "pipe", "pipe", descriptor]
    })
    return { base, ...run }
  } finally {
    NodeFs.closeSync(descriptor)
  }
}

const refusable = it.skipIf(supervisor === undefined || bwrap === undefined || process.getuid?.() === 0)

describe("smthrs-observe where pidfd_getfd is refused", () => {
  refusable("says on probing that it cannot run, and why", async () => {
    const probe = await refusing([supervisor!, "--probe"])
    expect(probe.status, probe.stderr).toBe(126)
    expect(probe.stderr.trim()).toBe(
      "smthrs-observe cannot run here: this machine refuses pidfd_getfd, which reads a socket a step binds: " +
        "Operation not permitted; a container allows it with CAP_SYS_PTRACE"
    )
    // Where nothing refuses it, it answers 0 and says nothing.
    const plain = spawnSync(supervisor!, ["--probe"], { encoding: "utf8" })
    expect([plain.status, plain.stderr]).toEqual([0, ""])
  })

  // The recorder takes its listener from the filtered process with pidfd_getfd: refused, the command runs with no
  // filter, as it would unrecorded, and the trace says why.
  refusable("runs the command unrecorded, and says why, rather than not at all", async () => {
    const script = "require('node:net').createServer().listen(0, '127.0.0.1', function () { this.close() })"
    const run = await refusing([supervisor!, "trace", "--", process.execPath, "-e", script])
    expect(run.status, run.stderr).toBe(0)
    const lines = NodeFs.readFileSync(Path.join(run.base, "trace"), "utf8").split("\n").filter((line) => line !== "")
    expect(lines.filter((line) => line.includes(" bind("))).toEqual([])
    expect(lines.at(-2)).toMatch(
      /^\d+ \+\+\+ unrecorded: this machine refuses pidfd_getfd, which the recorder takes its own listener with; a container allows it with CAP_SYS_PTRACE \+\+\+$/
    )
    const failing = await refusing([supervisor!, "trace", "--", "sh", "-c", "exit 3"])
    expect(failing.status).toBe(3)
    expect(lines.at(-1)).toMatch(/^\d+ \+\+\+ complete \+\+\+$/)
  })
})

/**
 * A shell sets its handlers without `SA_RESTART`, so a signal that came while
 * one of its calls waited for the supervisor would cut that call short where
 * it never would unrecorded: `fork` would fail ("Cannot fork"), and `[ -f x ]`
 * would be false for a file that is there. Background jobs that end send the
 * shell `SIGCHLD` all the time.
 */
const shell = (base: string, script: string, traced: boolean) => {
  const command = traced ? [supervisor!, Path.join(base, "trace"), "--", "sh", "-c", script] : ["sh", "-c", script]
  const done = spawnSync(command[0]!, command.slice(1), { cwd: base, encoding: "utf8", timeout: 20_000 })
  return { status: done.status, stdout: done.stdout, stderr: done.stderr }
}

const signalRoot = async () => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-signals-")))
  temporary.push(base)
  await Fs.writeFile(Path.join(base, "x"), "")
  return base
}

/**
 * A program that asks for one file a hundred times each way, then asks
 * again after a name changed, after the file is gone, and from a process it
 * starts: as a compiler looks up the same header in every search path.
 */
const asking = String.raw`
import * as fs from "node:fs"
import { spawnSync } from "node:child_process"
const [file, made] = process.argv.slice(2)
for (let i = 0; i < 100; i++) fs.statSync(file)
for (let i = 0; i < 100; i++) fs.closeSync(fs.openSync(file, "r"))
fs.mkdirSync(made)
fs.statSync(file)
fs.statSync(file)
fs.rmSync(file)
for (let i = 0; i < 3; i++) try { fs.statSync(file) } catch {}
spawnSync(process.execPath, ["-e", "try { require('node:fs').statSync(" + JSON.stringify(file) + ") } catch {}"])
`

describe("smthrs-observe and names a line cannot hold", () => {
  supervised("writes the path of a directory it lists so that the reader reads it back", async () => {
    const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-names-")))
    temporary.push(base)
    // As click's tests make one: a directory whose name holds a newline, and every character a path is closed with.
    const odd = Path.join(base, "my\ndir \"<odd>\\")
    await Fs.mkdir(odd)
    await Fs.writeFile(Path.join(odd, "file"), "file\n")
    const trace = Path.join(base, "trace")
    const script =
      "require('node:fs').readdirSync(process.argv[1]); require('node:fs').utimesSync(process.argv[1], 1, 1)"
    const run = spawnSync(supervisor!, [trace, "--", process.execPath, "-e", script, odd], { encoding: "utf8" })
    expect(run.status, run.stderr).toBe(0)
    const read = ObservedReads.read(() => NodeFs.readFileSync(trace, "utf8").split("\n"), base)
    expect(read.refusals).toEqual([])
    expect(read.listed.has(odd)).toBe(true)
  })
})

/**
 * npm makes its cache's directories with node's recursive mkdir, many at once
 * on the thread pool. A thread asks for `c/t0/a/b1` while `c/t0/a` is
 * missing; another makes `c/t0/a` before that call runs, and the call then
 * makes `b1`. The answer read at the stop said the directory was missing, so
 * no line said the run made `b1`, and the step read as one that found it
 * missing: at the next commit, with npm's cache kept, `b1` "now exists" and
 * `npm ci` ran again (about one run in ten of the generated job).
 */
const racing = String.raw`
import { mkdir } from "node:fs/promises"
const root = process.argv[2]
for (let i = 0; i < 40; i++) {
  await Promise.all(Array.from({ length: 16 }, (_, k) => mkdir(root + "/c/t" + i + "/a/b" + k, { recursive: true })))
}
`

/** strace where the host has it: it writes the answer each call got, so it must agree. */
const strace = ObservedReads.observer({ ...ExecSandbox.host(), supervisor: undefined })
const straced = it.skipIf(!("tracer" in strace) || "supervisor" in strace)

/** Records `racing` with a recorder, and says which directories it made that the record does not hold as made. */
const race = async (recorder: { readonly tracer: string; readonly supervisor?: true }) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-racing-")))
  temporary.push(base)
  const root = Path.join(base, "w")
  await Fs.mkdir(root)
  const script = Path.join(base, "racing.mjs")
  await Fs.writeFile(script, racing)
  const trace = Path.join(base, "trace")
  // When the run began, as the file system's clock tells it, a tick after the script was written.
  await new Promise((resolve) => setTimeout(resolve, 20))
  await Fs.writeFile(Path.join(base, "mark"), "")
  const startedMs = NodeFs.statSync(Path.join(base, "mark")).ctimeMs
  const [program, ...rest] = ObservedReads.commandFor(recorder, trace, [process.execPath, script, root])
  const run = spawnSync(program!, rest, { encoding: "utf8", env: { ...process.env, UV_THREADPOOL_SIZE: "16" } })
  expect(run.status, run.stderr).toBe(0)
  const read = ObservedReads.read(() => NodeFs.readFileSync(trace, "utf8").split("\n"), root)
  expect(read.refusals).toEqual([])
  const made = NodeFs.readdirSync(Path.join(root, "c"), { recursive: true, encoding: "utf8" }).map((name) =>
    Path.join(root, "c", name)
  )
  expect(made).toHaveLength(40 * 18)
  const observed = ObservedReads.observe(read, { root: base, ignore: [], startedMs })
  if ("refusal" in observed) throw new Error(observed.refusal)
  return {
    unmade: made.filter((directory) => !read.made.has(directory)),
    // A directory the run found missing and then made holds in either state: none is held as missing alone.
    missingAlone: observed.record.reads.filter((row) => row[0].startsWith("w/c") && row.length === 2)
  }
}

describe("smthrs-observe and names made by threads at once", () => {
  supervised("says the run made each directory it made, though another thread made the one it goes in", async () => {
    expect(await race({ tracer: supervisor!, supervisor: true })).toEqual({ unmade: [], missingAlone: [] })
  })

  straced("says the same as strace, which writes the answer each call got", async () => {
    expect(await race(strace as { readonly tracer: string })).toEqual({ unmade: [], missingAlone: [] })
  })
})

describe("smthrs-observe and questions asked again", () => {
  supervised("writes a question once until something could answer it otherwise", async () => {
    const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-again-")))
    temporary.push(base)
    const file = Path.join(base, "file")
    await Fs.writeFile(file, "file\n")
    const script = Path.join(base, "asking.mjs")
    await Fs.writeFile(script, asking)
    const trace = Path.join(base, "trace")
    const run = spawnSync(supervisor!, [trace, "--", process.execPath, script, file, Path.join(base, "made")], {
      encoding: "utf8"
    })
    expect(run.status, run.stderr).toBe(0)
    const lines = NodeFs.readFileSync(trace, "utf8").split("\n").filter((line) => line.includes(JSON.stringify(file)))
    const program = Number(lines[0]!.split(" ")[0])
    const of = (pid: number, call: string) =>
      lines
        // `rmSync` looks at the file without following a link first: another question, with lines of its own.
        .filter((line) => line.startsWith(`${pid} ${call}(`) && !line.includes("AT_SYMLINK_NOFOLLOW"))
        .map((line) => line.slice(line.lastIndexOf(") = ") + 4))
    // Found once, found again after a directory was made, missing once after the file was removed.
    expect(of(program, "newfstatat")).toEqual(["0", "0", "-1 ENOENT (No such file or directory)"])
    expect(of(program, "openat").filter((answer) => answer === "0")).toEqual(["0"])
    // Another process asks for itself.
    const other = [...new Set(lines.map((line) => Number(line.split(" ")[0])))].filter((pid) => pid !== program)
    expect(other.flatMap((pid) => of(pid, "newfstatat"))).toEqual(["-1 ENOENT (No such file or directory)"])
    // What the reader keeps is what every question would have given it: found, then missing after the run removed it.
    const read = ObservedReads.read(() => NodeFs.readFileSync(trace, "utf8").split("\n"), base)
    expect(read.refusals).toEqual([])
    expect(read.found.has(file)).toBe(true)
  })
})

/**
 * A program of forty-eight threads that each ask for a file by a relative name, killed while they ask: as a test
 * runner kills its workers. A thread killed while its call waits for the recorder takes the call with it.
 */
const killedMidCall = String.raw`
import os, signal, threading, time
ready = threading.Barrier(49)
def ask():
    ready.wait()
    while True: os.stat("file")
for _ in range(48): threading.Thread(target=ask, daemon=True).start()
ready.wait()
time.sleep(0.002)
os.kill(os.getpid(), signal.SIGKILL)
`

describe("smthrs-observe and threads killed in the middle of calls", () => {
  supervised("writes nothing of a call whose thread was killed while it waited", async () => {
    const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-killed-")))
    temporary.push(base)
    await Fs.writeFile(Path.join(base, "file"), "file\n")
    await Fs.writeFile(Path.join(base, "killed.py"), killedMidCall)
    const trace = Path.join(base, "trace")
    const rounds = "for round in $(seq 40); do python3 killed.py; done; true"
    const run = spawnSync(supervisor!, [trace, "--", "/bin/sh", "-c", rounds], { cwd: base, encoding: "utf8" })
    expect(run.status, run.stderr).toBe(0)
    const lines = NodeFs.readFileSync(trace, "utf8").split("\n")
    // No line that a reader cannot place: every line it wrote names its directory.
    expect(lines.filter((line) => line.includes("EBADF"))).toEqual([])
    expect(ObservedReads.read(() => lines, base).refusals).toEqual([])
  }, 120_000)
})

/**
 * A program that asks what its standard input and output are, by descriptor, while both are pipes: as Node does on
 * every `fs.fstatSync`, and as `id -u` does where the C library makes `fstat` a `newfstatat` with an empty path
 * (glibc 2.33 to 2.38, as Debian 12 has). The descriptor names no file, so the call looks at no file.
 */
const describesPipes = String.raw`
import * as fs from "node:fs"
fs.fstatSync(0)
fs.fstatSync(1)
fs.closeSync(fs.openSync(process.argv[2], "r"))
`

describe("smthrs-observe and a descriptor that names no file", () => {
  supervised("writes nothing a reader cannot place for a look at a pipe by its descriptor", async () => {
    const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-pipes-")))
    temporary.push(base)
    await Fs.writeFile(Path.join(base, "pipes.mjs"), describesPipes)
    await Fs.writeFile(Path.join(base, "read"), "read\n")
    const trace = Path.join(base, "trace")
    const node = JSON.stringify(process.execPath)
    const run = spawnSync(supervisor!, [trace, "--", "/bin/sh", "-c", `echo in | ${node} pipes.mjs read | cat`], {
      cwd: base,
      encoding: "utf8"
    })
    expect(run.status, run.stderr).toBe(0)
    const lines = NodeFs.readFileSync(trace, "utf8").split("\n")
    expect(lines.filter((line) => line.includes("EBADF"))).toEqual([])
    const read = ObservedReads.read(() => lines, base)
    expect(read.refusals).toEqual([])
    // What the program read by name is still recorded.
    expect(read.found.has(Path.join(base, "read"))).toBe(true)
  }, 60_000)
})

describe("smthrs-observe and signals faster than a call", () => {
  supervised("stops a run whose signals come faster than a recorded call completes, and says so", async () => {
    const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-storm-")))
    temporary.push(base)
    const script = Path.join(base, "storm.py")
    await Fs.writeFile(script, signalling)
    // Unrecorded, the program ends with this timer.
    const timer = String(survivedTimer())
    const trace = Path.join(base, "trace")
    const started = Date.now()
    const run = spawnSync(supervisor!, [trace, "--", "python3", script, timer, script], {
      encoding: "utf8",
      timeout: 30_000
    })
    // Recorded, it would never end: the recorder stops it, writes why, and ends its trace.
    expect(run.error).toBeUndefined()
    expect(run.status).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(20_000)
    const lines = NodeFs.readFileSync(trace, "utf8").split("\n")
    expect(ObservedReads.read(() => lines, base).refusals).toContain(ObservedReads.signalStorm)
    expect(lines.filter((line) => line !== "").at(-1)).toMatch(/^\d+ \+\+\+ complete \+\+\+$/)
    // A timer of 100 microseconds is no storm: the run ends recorded, as it ends unrecorded.
    const calm = spawnSync(supervisor!, [trace, "--", "python3", script, "100", script], {
      encoding: "utf8",
      timeout: 60_000
    })
    expect(calm.status, calm.stderr).toBe(0)
    expect(calm.stdout).toBe("done\n")
    expect(NodeFs.readFileSync(trace, "utf8")).not.toContain(ObservedReads.signalStorm)
  }, 120_000)

  supervised(
    "counts the signal stops of a run in its trace, and writes none for a run that took no signal",
    async () => {
      const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-self-signalling-")))
      temporary.push(base)
      const script = Path.join(base, "self-signalling.py")
      await Fs.writeFile(script, selfSignalling)
      const trace = Path.join(base, "trace")
      const run = spawnSync(supervisor!, [trace, "--", "python3", script, "3000"], {
        encoding: "utf8",
        timeout: 60_000
      })
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toBe("done\n")
      const lines = NodeFs.readFileSync(trace, "utf8").split("\n")
      const counted = lines.map((line) => /^\d+ \+\+\+ signal stops: (\d+) \+\+\+$/.exec(line)?.[1]).find((n) =>
        n !== undefined
      )
      // One stop for each signal it sent itself, and any the program's start took.
      expect(Number(counted)).toBeGreaterThanOrEqual(3_000)
      expect(Number(counted)).toBeLessThan(3_100)
      expect(ObservedReads.read(() => lines, base).signalStops).toBe(Number(counted))
      const quiet = spawnSync(supervisor!, [trace, "--", "/bin/cat", script], { encoding: "utf8", timeout: 60_000 })
      expect(quiet.status, quiet.stderr).toBe(0)
      const plain = NodeFs.readFileSync(trace, "utf8")
      expect(plain).not.toContain("signal stops")
      expect(ObservedReads.read(() => plain.split("\n"), base).signalStops).toBeUndefined()
    },
    120_000
  )

  supervised("stops such a run within a bound on a machine that takes its signal stops slowly", async () => {
    const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-slow-storm-")))
    temporary.push(base)
    const script = Path.join(base, "storm.py")
    await Fs.writeFile(script, signalling)
    const timer = String(survivedTimer())
    // One processor this test may use, shared with five busy loops: the program and the recorder get a sixth of
    // it, and the recorder takes signal stops a few times more slowly. A rule of so many stops a second never ended
    // this run. With this timer the program ends unrecorded on a processor of its own (the test above).
    const cpu = /^Cpus_allowed_list:\s*(\d+)/m.exec(NodeFs.readFileSync("/proc/self/status", "utf8"))![1]!
    const busy = [0, 1, 2, 3, 4].map(() =>
      spawn("taskset", ["-c", cpu, "sh", "-c", "while :; do :; done"], { stdio: "ignore" })
    )
    try {
      const trace = Path.join(base, "trace")
      const started = Date.now()
      const run = spawnSync("taskset", ["-c", cpu, supervisor!, trace, "--", "python3", script, timer, script], {
        encoding: "utf8",
        timeout: 90_000
      })
      expect(run.error).toBeUndefined()
      expect(run.status).not.toBe(0)
      expect(Date.now() - started).toBeLessThan(10_000)
      const lines = NodeFs.readFileSync(trace, "utf8").split("\n")
      expect(ObservedReads.read(() => lines, base).refusals).toContain(ObservedReads.signalStorm)
    } finally {
      for (const loop of busy) loop.kill("SIGKILL")
    }
  }, 240_000)
})

/**
 * A parent that waits for each child as tokio, and so uv, does: it polls the child's pidfd, then reaps it without
 * blocking. tokio panics when the child cannot be reaped then (`pidfd is ready to read, the process should have
 * exited`). Each child sets a handler without `SA_RESTART`, so smthrs-observe traces it.
 */
const reaping = String.raw`
import os, select, signal, sys
early = 0
for i in range(int(sys.argv[1])):
    pid = os.fork()
    if pid == 0:
        signal.signal(signal.SIGUSR1, lambda *a: None)
        os._exit(0)
    fd = os.pidfd_open(pid)
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    poll.poll()
    if os.waitpid(pid, os.WNOHANG)[0] == 0:
        early += 1
        os.waitpid(pid, 0)
    os.close(fd)
print(early, "not reaped when their pidfd was ready")
`
const pidfds = spawnSync("python3", ["-c", "import os; os.pidfd_open"]).status === 0
const reapingIt = it.skipIf(supervisor === undefined || process.getuid?.() === 0 || !pidfds)

describe("smthrs-observe and signals", () => {
  reapingIt("lets a parent reap a traced child as soon as the child's pidfd says it ended", async () => {
    const base = await signalRoot()
    const script = Path.join(base, "reaping.py")
    await Fs.writeFile(script, reaping)
    const plain = spawnSync("python3", [script, "300"], { encoding: "utf8" })
    expect([plain.status, plain.stdout]).toEqual([0, "0 not reaped when their pidfd was ready\n"])
    const traced = spawnSync(supervisor!, [Path.join(base, "trace"), "--", "python3", script, "300"], {
      encoding: "utf8"
    })
    expect([traced.status, traced.stdout]).toEqual([0, "0 not reaped when their pidfd was ready\n"])
  }, 60_000)

  supervised("never lets a signal cut short a call it would not cut short unrecorded", async () => {
    const base = await signalRoot()
    const script = [
      "i=0; n=0",
      "while [ $i -lt 40 ]; do",
      "  ( : ) &",
      "  if [ -f x ]; then n=$((n+1)); fi",
      "  if command -v ls > /dev/null; then n=$((n+1)); fi",
      "  i=$((i+1))",
      "done",
      "wait; echo $n"
    ].join("\n")
    const wrong: Array<ReturnType<typeof shell>> = []
    for (let run = 0; run < 300; run++) {
      const done = shell(base, script, true)
      if (done.status !== 0 || done.stdout !== "80\n" || done.stderr !== "") wrong.push(done)
    }
    expect(wrong).toEqual([])
  }, 180_000)

  supervised("lets a signal cut short a call that waits in the kernel, as it does unrecorded", async () => {
    const base = await signalRoot()
    expect(spawnSync("mkfifo", [Path.join(base, "fifo")]).status).toBe(0)
    const script = "trap 'echo trapped' USR1; (sleep 0.3; kill -USR1 $$) & exec 3< fifo; echo opened"
    const plain = shell(base, script, false)
    expect(plain.stderr).toContain("Interrupted system call")
    expect(shell(base, script, true)).toEqual(plain)
  }, 60_000)
})

describe("smthrs-observe --keep, for a step whose job keeps what it leaves running", () => {
  supervised("ends the step with its command, and follows what it left until that ends", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "observe-keep-")))
    temporary.push(root)
    await Fs.writeFile(Path.join(root, "first"), "1\n")
    await Fs.writeFile(Path.join(root, "later"), "2\n")
    const trace = Path.join(root, "trace")
    // The command reads `first`, leaves a program that reads `later` once told to, and exits 3.
    const script = `cat ${root}/first > /dev/null; ` +
      `(while [ ! -e ${root}/go ]; do sleep 0.05; done; cat ${root}/later > /dev/null) & exit 3`
    const started = Date.now()
    const child = spawn(supervisor!, ["--keep", trace, "--", "sh", "-c", script], { detached: true, stdio: "ignore" })
    child.unref()
    // The command's status comes once it has ended, beside a sealed trace of everything so far.
    while (!NodeFs.existsSync(`${trace}.status`)) {
      if (Date.now() - started > 20_000) throw new Error("no status")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(NodeFs.readFileSync(`${trace}.status`, "utf8")).toMatch(/^3 \d+\n$/)
    expect(ObservedReads.whole(trace)).toBe(true)
    const own = NodeFs.readFileSync(trace, "utf8")
    const opened = (name: string) => new RegExp(`openat\\([^\\n]*"${root}/${name}", O_RDONLY`)
    expect(own).toMatch(opened("first"))
    expect(own).not.toMatch(opened("later"))
    // What it left reads `later`: the lines come after the trace, and a request has them all written first.
    await Fs.writeFile(Path.join(root, "go"), "")
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await ObservedReads.askFlush(trace, 10_000)).toBe(true)
    expect(NodeFs.readFileSync(`${trace}.kept`, "utf8")).toMatch(opened("later"))
    // Once nothing it followed is left, it answers every request.
    while (!NodeFs.readFileSync(`${trace}.answered`, "utf8").startsWith("9223372036854775807")) {
      if (Date.now() - started > 20_000) throw new Error("it did not end")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(NodeFs.readFileSync(trace, "utf8")).toBe(own)
  }, 60_000)

  // A shell's `trap` sets a handler with no SA_RESTART, and the supervisor seizes each process that does: its serving
  // thread asks the main thread to, and waits holding the lock the main thread takes at every tick to write what the
  // command left. Each waited for the other, and every recorded thread waited in its call for good: shadcn-ui/ui's
  // tests, whose next server and vitest workers set handlers, made no progress for ten minutes.
  supervised("follows what it left while that starts thousands of programs that set handlers", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "observe-keep-handlers-")))
    temporary.push(root)
    const trace = Path.join(root, "trace")
    const shells = "for i in $(seq 500); do /bin/sh -c 'trap : USR1'; done"
    const script = `(for j in 1 2 3 4; do (${shells}) & done; wait; touch ${root}/finished) > /dev/null 2>&1 & exit 0`
    const started = Date.now()
    const child = spawn(supervisor!, ["--keep", trace, "--", "sh", "-c", script], { detached: true, stdio: "ignore" })
    child.unref()
    try {
      // Unrecorded, the 2,000 shells take about a second here; recorded, about as long.
      while (!NodeFs.existsSync(Path.join(root, "finished"))) {
        if (Date.now() - started > 60_000) throw new Error("what the command left made no progress")
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      // Once nothing it followed is left, it answers every request, and ends.
      const ended = () =>
        NodeFs.existsSync(`${trace}.answered`) &&
        NodeFs.readFileSync(`${trace}.answered`, "utf8").startsWith("9223372036854775807")
      while (!ended()) {
        if (Date.now() - started > 60_000) throw new Error("it did not end")
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        // Ended already.
      }
    }
  }, 120_000)
})

describe("smthrs-observe --reap, for a step whose job has nothing to keep what it leaves running", () => {
  const reaps = it.skipIf(supervisor === undefined)
  /** The programs of this user whose whole command line is `line`. */
  const alive = (line: string): ReadonlyArray<string> =>
    spawnSync("pgrep", ["-u", String(process.getuid?.()), "-x", "-f", line], { encoding: "utf8" }).stdout
      .split("\n").filter((pid) => pid !== "")

  reaps("ends what the command left however it detached, once it ended, and answers its exit", () => {
    const seconds = 61_000 + (process.pid % 900)
    const script = [
      `nohup sleep ${seconds} > /dev/null 2>&1 &`,
      `setsid -f sleep ${seconds + 1} > /dev/null 2>&1 < /dev/null`,
      // A double fork into a session of its own, as a daemon does.
      `sh -c 'setsid sh -c "sleep ${seconds + 2} > /dev/null 2>&1 < /dev/null &" &'`,
      `for i in $(seq 1 50); do pgrep -x -f 'sleep ${seconds + 2}' > /dev/null && break; sleep 0.1; done`,
      "exit 3"
    ].join("\n")
    const run = spawnSync(supervisor!, ["--reap", "--", "/bin/sh", "-c", script], {
      encoding: "utf8",
      timeout: 120_000
    })
    expect(run.status).toBe(3)
    for (const line of [`sleep ${seconds}`, `sleep ${seconds + 1}`, `sleep ${seconds + 2}`]) {
      expect(alive(line)).toEqual([])
    }
  })

  reaps("passes a signal on to the command, and says why a command cannot start", async () => {
    const child = spawn(supervisor!, ["--reap", "--", "sleep", "600"], { stdio: "ignore" })
    const ended = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
    await new Promise((resolve) => setTimeout(resolve, 300))
    child.kill("SIGTERM")
    expect(await ended).toBe(128 + 15)
    const missing = spawnSync(supervisor!, ["--reap", "--", "/no/such/program"], { encoding: "utf8" })
    expect([missing.status, missing.stderr]).toEqual([
      127,
      "smthrs-observe: /no/such/program: No such file or directory\n"
    ])
    expect(spawnSync(supervisor!, ["--probe", "--reap"]).status).toBe(0)
    const bare = spawnSync(supervisor!, ["--reap", "--"], { encoding: "utf8" })
    expect([bare.status, bare.stderr]).toEqual([125, "usage: smthrs-observe --reap -- <command> [<argument>...]\n"])
  })
})

/** How many times each race case runs under each recorder: `SMTHRS_RACE_RUNS`, or 3. */
const raceRuns = Number(process.env["SMTHRS_RACE_RUNS"] ?? 3)

/** Why a race case may store nothing: what its calls did cannot be known, and the run says so. */
const unknowable = [
  /was made and removed by calls of the run at the same moment, so which call did what cannot be known$/,
  /^a thread changed its process's working directory while another thread named a path from it/,
  /^a program it connected to started while it connected/
]

describe("recorders and threads that change the same names at once", () => {
  const recorders = [
    ["smthrs-observe", supervisor === undefined ? undefined : { tracer: supervisor, supervisor: true as const }],
    ["strace", "tracer" in strace && !("supervisor" in strace) ? { tracer: strace.tracer } : undefined]
  ] as const
  for (const [label, recorder] of recorders) {
    for (const [name, fresh] of Races.cases) {
      it.skipIf(recorder === undefined || !Races.runnable() || process.getuid?.() === 0)(
        `${label}, ${name}: a record it stores says only what the run did`,
        async () => {
          const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-races-")))
          temporary.push(base)
          for (let run = 0; run < raceRuns; run += 1) {
            const raced = await Races.raceOnce(name, fresh, recorder!, base)
            expect(raced.status, raced.stderr).toBe(0)
            if (raced.refusal !== undefined) {
              // Strace can see the exclusive-open path being replaced before it can be measured.
              const exclusiveLinkReplaced = label === "strace" && name === "exclusive" &&
                raced.refusal.startsWith(Path.join(base, "exclusive-")) &&
                raced.refusal.endsWith("/ws/s was replaced while it was used")
              expect(exclusiveLinkReplaced || unknowable.some((reason) => reason.test(raced.refusal!)), raced.refusal)
                .toBe(true)
              continue
            }
            expect(raced).toEqual({ status: 0 })
          }
        },
        600_000
      )
    }
  }
})

describe("smthrs-observe, for a run of many threads", () => {
  /** Starts 10,000 threads that each look at a file once, then one that looks 50,000 times; says so, then waits. */
  const manyThreads = String.raw`
import os, sys, threading, time
path, ready, go = sys.argv[1:4]
for _ in range(20):
    batch = [threading.Thread(target=os.stat, args=(path,)) for _ in range(500)]
    for t in batch: t.start()
    for t in batch: t.join()
def late():
    for _ in range(50000): os.stat(path)
t = threading.Thread(target=late)
t.start(); t.join()
open(ready, "w").write("ready")
while not os.path.exists(go): time.sleep(0.01)
`

  // The supervisor learns each thread's process from /proc/<thread>/status once, and keeps it. A thread that ended kept
  // its place in that table, and a thread whose places were all taken was not kept: each of its calls read the
  // file again, 9 million reads in shadcn-ui/ui's tests.
  supervised("reads which process a thread is in once, however many threads came before it", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "observe-threads-")))
    temporary.push(root)
    await Fs.writeFile(Path.join(root, "many.py"), manyThreads)
    await Fs.writeFile(Path.join(root, "looked"), "x")
    const [ready, go] = [Path.join(root, "ready"), Path.join(root, "go")]
    const child = spawn(
      supervisor!,
      [Path.join(root, "trace"), "--", "python3", Path.join(root, "many.py"), Path.join(root, "looked"), ready, go],
      { stdio: "ignore" }
    )
    const ended = new Promise((resolve) => child.on("exit", resolve))
    const started = Date.now()
    while (!NodeFs.existsSync(ready)) {
      if (Date.now() - started > 120_000) throw new Error("the program did not get through its threads")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // The reads the supervisor made: one for each thread that started, and others, but none for each call.
    const reads = Number(/^syscr: (\d+)$/m.exec(NodeFs.readFileSync(`/proc/${child.pid}/io`, "utf8"))![1])
    await Fs.writeFile(go, "")
    await ended
    // 10,023 here: one for each of the 10,001 threads. Before, 60,022: the late thread read it at each of its calls.
    expect(reads).toBeLessThan(20_000)
  }, 180_000)
})

/** The lines of a trace file. */
const linesOf = (file: string): ReadonlyArray<string> => NodeFs.readFileSync(file, "utf8").split("\n")

/** Records `argv` in a new directory; answers the directory, the run and the trace's lines. */
const record = async (
  label: string,
  argv: (base: string) => ReadonlyArray<string>,
  prepare: (base: string) => Promise<void> = () => Promise.resolve(),
  cwd?: (base: string) => string
) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), `smthrs-observe-${label}-`)))
  temporary.push(base)
  await prepare(base)
  const trace = Path.join(base, "trace")
  const run = spawnSync(supervisor!, [trace, "--", ...argv(base)], { encoding: "utf8", cwd: cwd?.(base) ?? base })
  expect(run.status, run.stderr).toBe(0)
  return { base, run, lines: linesOf(trace) }
}

/** Waits until `done`, or throws `what` after `limitMs`. */
const until = async (done: () => boolean, what: string, limitMs = 30_000): Promise<void> => {
  const started = Date.now()
  while (!done()) {
    if (Date.now() - started > limitMs) throw new Error(what)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Whether a kept step's recorder has ended: it answers every request. */
const keptEnded = (trace: string): boolean =>
  NodeFs.existsSync(`${trace}.answered`) &&
  NodeFs.readFileSync(`${trace}.answered`, "utf8").startsWith("9223372036854775807")

describe("smthrs-observe --keep, for what a step left running after its trace was sealed", () => {
  supervised("makes an empty continuation readable when the command exits", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "observe-keep-idle-")))
    temporary.push(root)
    const trace = Path.join(root, "trace")
    const result = spawnSync(supervisor!, ["--keep", trace, "--", "true"], { encoding: "utf8" })
    expect(result.status, result.stderr).toBe(0)
    const step = ObservedReads.keptStep("idle", "step", root, trace, true)
    expect(await step.flush()).toBe(true)
    expect([...step.after()]).toEqual([])
  })

  supervised("records a daemon's repeated lookup once in each acknowledged window", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "observe-keep-repeat-")))
    temporary.push(root)
    const trace = Path.join(root, "trace")
    const input = Path.join(root, "input")
    await Fs.writeFile(input, "hello")
    const script = `
import os, sys
r, w = os.pipe()
if os.fork():
    os.close(w)
    os.read(r, 1)
    os._exit(0)
os.stat(sys.argv[1])
os.write(w, b"r")
while os.read(0, 1):
    os.stat(sys.argv[1])
    os.stat(sys.argv[1])
    os.write(1, b"r")
`
    const child = spawn(supervisor!, ["--keep", trace, "--", "python3", "-c", script, input], {
      stdio: ["pipe", "pipe", "ignore"]
    })
    let replies = 0
    child.stdout.on("data", (chunk: Buffer) => replies += chunk.length)
    const lookups = (file: string) =>
      linesOf(file).filter((line) => line.includes(` newfstatat(AT_FDCWD, ${JSON.stringify(input)},`))
    try {
      await until(() => NodeFs.existsSync(`${trace}.status`), "no status")
      expect(lookups(trace)).toHaveLength(1)
      for (const count of [1, 2]) {
        child.stdin.write("r")
        await until(() => replies === count, "no lookup reply")
        expect(await ObservedReads.askFlush(trace, 10_000)).toBe(true)
        expect(lookups(`${trace}.kept`)).toHaveLength(count)
      }
    } finally {
      child.stdin.end()
      await until(() => keptEnded(trace), "daemon did not end")
    }
  })

  // A reason the run cannot be recorded was written only with the sealed trace. One made after (a kept program that
  // makes a namespace, uses a ring, or changes a name its line does not say) reached no file, and the steps after
  // were stored as recorded.
  supervised("writes a refusal a kept program causes after the seal beside the lines it follows", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "observe-keep-refusal-")))
    temporary.push(root)
    const trace = Path.join(root, "trace")
    // CLONE_NEWNS: the kernel refuses it without rights, and the recorder is told of the call all the same.
    const unshare = "import ctypes; ctypes.CDLL(None, use_errno=True).unshare(0x20000)"
    const script = `(while [ ! -e ${root}/go ]; do sleep 0.05; done; python3 -c '${unshare}') > /dev/null 2>&1 & exit 0`
    const child = spawn(supervisor!, ["--keep", trace, "--", "sh", "-c", script], { detached: true, stdio: "ignore" })
    child.unref()
    try {
      await until(() => NodeFs.existsSync(`${trace}.status`), "no status")
      expect(ObservedReads.whole(trace)).toBe(true)
      expect(NodeFs.readFileSync(trace, "utf8")).not.toContain("unrecorded")
      await Fs.writeFile(Path.join(root, "go"), "")
      await until(() => keptEnded(trace), "it did not end")
      expect(await ObservedReads.askFlush(trace, 10_000)).toBe(true)
      expect(NodeFs.readFileSync(`${trace}.kept`, "utf8")).toMatch(
        /^\d+ \+\+\+ unrecorded: it made a namespace of its own \+\+\+$/m
      )
      // The reader holds the steps after to it.
      const served = ObservedReads.servedBy(() => linesOf(trace), () => linesOf(`${trace}.kept`), root)
      expect(served.refusals).toContain("it made a namespace of its own")
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        // Ended already.
      }
    }
  }, 60_000)

  // A write of the kept lines that failed was not noticed: the lines were freed and the request answered, so a reader
  // was told lines were on disk that were not.
  supervised("answers no request while kept lines are unwritten, and says they were lost once it can", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "observe-keep-lost-")))
    temporary.push(root)
    await Fs.writeFile(Path.join(root, "later"), "2\n")
    const trace = Path.join(root, "trace")
    // A directory where the kept lines go: every write of them fails.
    await Fs.mkdir(`${trace}.kept`)
    const script = `(while [ ! -e ${root}/go ]; do sleep 0.05; done; cat ${root}/later > /dev/null; ` +
      `while [ ! -e ${root}/end ]; do sleep 0.05; done) > /dev/null 2>&1 & exit 0`
    const child = spawn(supervisor!, ["--keep", trace, "--", "sh", "-c", script], { detached: true, stdio: "ignore" })
    child.unref()
    try {
      await until(() => NodeFs.existsSync(`${trace}.status`), "no status")
      await Fs.writeFile(Path.join(root, "go"), "")
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await ObservedReads.askFlush(trace, 1_000)).toBe(false)
      expect(NodeFs.existsSync(`${trace}.answered`)).toBe(false)
      // Once the lines can be written the loss is: the request is answered, and the reader refuses what followed.
      await Fs.rmdir(`${trace}.kept`)
      expect(await ObservedReads.askFlush(trace, 10_000)).toBe(true)
      const lost = "the recorder could not write every line of what the step left running"
      expect(NodeFs.readFileSync(`${trace}.kept`, "utf8")).toContain(`+++ unrecorded: ${lost} +++`)
      expect(ObservedReads.servedBy(() => linesOf(trace), () => linesOf(`${trace}.kept`), root).refusals).toContain(
        lost
      )
      await Fs.writeFile(Path.join(root, "end"), "")
      await until(() => keptEnded(trace), "it did not end")
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        // Ended already.
      }
    }
  }, 60_000)

  // The loss was said through the reasons the recorder keeps, each written once. After a second failed write the
  // reason was one it had written already, so nothing was new: while what the step left made no further call, the
  // file was never written to again, and no request was answered for as long as the recorder ran.
  supervised("says a second loss of kept lines too, though what the step left makes no further call", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "observe-keep-lost-again-")))
    temporary.push(root)
    await Fs.writeFile(Path.join(root, "later"), "2\n")
    const trace = Path.join(root, "trace")
    const kept = `${trace}.kept`
    // What the step leaves waits in an open of each FIFO in turn, and makes no call while it waits.
    const told = ["first", "second", "end"].map((name) => Path.join(root, name))
    for (const fifo of told) expect(spawnSync("mkfifo", [fifo]).status).toBe(0)
    const tell = (fifo: string) => Fs.writeFile(fifo, "\n")
    await Fs.mkdir(kept)
    const reads = `cat ${root}/later > /dev/null`
    const script = `(read a < ${told[0]}; ${reads}; read b < ${told[1]}; ${reads}; read c < ${told[2]})` +
      " > /dev/null 2>&1 & exit 0"
    const child = spawn(supervisor!, ["--keep", trace, "--", "sh", "-c", script], { detached: true, stdio: "ignore" })
    child.unref()
    const lost = "+++ unrecorded: the recorder could not write every line of what the step left running +++"
    const said = () => NodeFs.readFileSync(kept, "utf8").split(lost).length - 1
    try {
      await until(() => NodeFs.existsSync(`${trace}.status`), "no status")
      // The first loss, said once the lines can be written.
      await tell(told[0]!)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await ObservedReads.askFlush(trace, 1_000)).toBe(false)
      await Fs.rmdir(kept)
      expect(await ObservedReads.askFlush(trace, 10_000)).toBe(true)
      expect(said()).toBe(1)
      // The second: the file is a directory again while the lines of the second read are made.
      await Fs.rename(kept, `${kept}.first`)
      await Fs.mkdir(kept)
      await tell(told[1]!)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await ObservedReads.askFlush(trace, 1_000)).toBe(false)
      await Fs.rmdir(kept)
      expect(await ObservedReads.askFlush(trace, 10_000)).toBe(true)
      expect(said()).toBe(1)
      await tell(told[2]!)
      await until(() => keptEnded(trace), "it did not end")
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        // Ended already.
      }
    }
  }, 60_000)
})

describe("smthrs-observe and a socket bound to a port the kernel chooses", () => {
  /**
   * Listens on port 0 of `host`, then connects to the port given (one nothing of the run listens on). That
   * connection is dropped, not ended: the test that listens there waits for this program, and answers nothing.
   */
  const chosen = String.raw`
import * as net from "node:net"
const [host, outside] = process.argv.slice(2)
const server = net.createServer((socket) => socket.end())
await new Promise((resolve) => server.listen({ host, port: 0 }, resolve))
const port = server.address().port
await new Promise((resolve) => net.connect({ host, port }, function () { this.end(); resolve() }))
await new Promise((resolve) => {
  const socket = net.connect({ host, port: Number(outside) })
  socket.on("error", resolve)
  socket.on("connect", () => { socket.destroy(); resolve() })
})
server.close()
console.log(port)
`
  // The line said `htons(0)`, as the call asked, and a reader that saw one such bind could no longer tell a
  // connection to the run's own port from one to a database of the machine: it let every local port by.
  for (const [host, field] of [["127.0.0.1", "sin_port"], ["::1", "sin6_port"]] as const) {
    supervised(
      `writes the port the kernel chose for ${host}, so a reader knows the run's port from another`,
      async () => {
        // A program outside the run, listening on a port of its own.
        const other = (await import("node:net")).createServer((socket) => socket.end())
        await new Promise<void>((resolve) => other.listen({ host, port: 0 }, resolve))
        const outside = (other.address() as { readonly port: number }).port
        try {
          const { base, lines, run } = await record(
            "chosen",
            (at) => [process.execPath, Path.join(at, "chosen.mjs"), host, String(outside)],
            (at) => Fs.writeFile(Path.join(at, "chosen.mjs"), chosen)
          )
          const port = Number(run.stdout.trim())
          const binds = lines.filter((line) => line.includes(" bind("))
          expect(
            binds.some((line) => line.includes(`${field}=htons(${port})`) && line.endsWith(" = 0")),
            binds.join("\n")
          )
            .toBe(true)
          expect(binds.filter((line) => line.includes("htons(0)"))).toEqual([])
          const read = ObservedReads.read(() => lines, base)
          expect(read.bound?.has(`tcp:${field === "sin_port" ? "inet" : "inet6"}:${port}:${host}`)).toBe(true)
          // Its own port is the run's; the other one is a program outside it, and the run is refused for it alone.
          expect(read.refusals).toEqual([`it reached a program outside the run on local port ${outside}`])
          expect(read.outside).toEqual([`it reached a program outside the run on local port ${outside}`])
        } finally {
          await new Promise((resolve) => other.close(resolve))
        }
      }
    )
  }

  // Linux connects `0.0.0.0` to the machine itself, and the reader reads it so. The recorder did not, wrote a refused
  // connection there as answered, and the run read as one that reached a program outside it.
  supervised("writes a connection to 0.0.0.0 that nothing answered as refused", async () => {
    const refused = "const net = require('node:net'); const s = net.createServer(); s.listen(0, '127.0.0.1', () => {" +
      " const port = s.address().port; s.close(() => net.connect(port, '0.0.0.0').on('error', (e) => console.log(e.code))) })"
    const { base, lines, run } = await record("unspecified", () => [process.execPath, "-e", refused])
    expect(run.stdout.trim()).toBe("ECONNREFUSED")
    const connects = lines.filter((line) => line.includes(" connect(") && line.includes("inet_addr(\"0.0.0.0\")"))
    expect(connects.map(answerOf)).toEqual(["ECONNREFUSED"])
    expect(ObservedReads.read(() => lines, base).outside).toEqual([])
  })
})

describe("smthrs-observe and the descriptors it holds itself", () => {
  /** Binds 1,600 netlink sockets and fails 1,600 binds to a taken port, then binds one more socket. */
  const binds = String.raw`
import socket
held = socket.socket()
held.bind(("127.0.0.1", 0))
held.listen()
taken = held.getsockname()[1]
failed = 0
for _ in range(1600):
    route = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0)
    route.bind((0, 0))
    route.close()
    again = socket.socket()
    try:
        again.bind(("127.0.0.1", taken))
    except OSError:
        failed += 1
    again.close()
last = socket.socket()
last.bind(("127.0.0.1", 0))
print(taken, last.getsockname()[1], failed)
`
  // The recorder kept a copy of every socket a bind named until the socket said it was bound: a netlink socket (the C
  // library binds one for each getaddrinfo) and a bind that failed never say so, so their copies were held for the
  // whole run. Past its own limit each of its opens failed, and it read the failures as answers: bind lines were
  // lost, and the trace was still sealed whole.
  supervised("lets go of a socket that will never say it is bound, under a limit of 256 descriptors", async () => {
    const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-binds-")))
    temporary.push(base)
    await Fs.writeFile(Path.join(base, "binds.py"), binds)
    const trace = Path.join(base, "trace")
    // The hard limit too: the recorder raises its own to the most it may have.
    const run = spawnSync(
      "sh",
      ["-c", "ulimit -n 256 && exec \"$@\"", "sh", supervisor!, trace, "--", "python3", Path.join(base, "binds.py")],
      { encoding: "utf8" }
    )
    expect(run.status, run.stderr).toBe(0)
    const [taken, last, failed] = run.stdout.trim().split(" ").map(Number)
    expect(failed).toBe(1600)
    const lines = linesOf(trace)
    expect(lines.filter((line) => line.includes("unrecorded"))).toEqual([])
    expect(lines.filter((line) => line !== "").at(-1)).toMatch(/^\d+ \+\+\+ complete \+\+\+$/)
    // The two binds that were made, each with its port; none of those that failed, and none of a netlink socket.
    const written = lines.filter((line) => line.includes(" bind("))
    expect(written.map((line) => /htons\((\d+)\)/.exec(line)?.[1]).map(Number)).toEqual([taken, last])
    expect(written.every((line) => line.endsWith(" = 0"))).toBe(true)
  }, 120_000)

  supervised("starts the command with the limit of descriptors it was given itself", async () => {
    const run = spawnSync("sh", [
      "-c",
      "ulimit -S -n 300 && exec \"$@\"",
      "sh",
      supervisor!,
      "/dev/null",
      "--",
      "sh",
      "-c",
      "ulimit -S -n"
    ], {
      encoding: "utf8"
    })
    expect(run.stdout.trim()).toBe("300")
  })
})

describe("smthrs-observe and openat2 with RESOLVE_* flags", () => {
  /** Opens `argv[2]` (a directory), then makes one openat2 from it for each `flags:path` word after. */
  const resolving = String.raw`
import ctypes, os, struct, sys
libc = ctypes.CDLL(None, use_errno=True)
directory = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
for word in sys.argv[2:]:
    flags, path = word.split(":", 1)
    how = struct.pack("QQQ", int(flags, 8), 0o644 if int(flags, 8) & os.O_CREAT else 0, 0x08)  # RESOLVE_BENEATH
    fd = libc.syscall(437, directory, os.fsencode(path), how, 24)
    print(path[:20], "0" if fd >= 0 else os.strerror(ctypes.get_errno()))
    if fd >= 0: os.close(fd)
`
  const made = (NodeFs.constants.O_WRONLY | NodeFs.constants.O_CREAT | NodeFs.constants.O_EXCL).toString(8)
  /** A path as the recorder writes it between `<` and `>`. */
  const angled = (path: string): string =>
    path.replace(/["\\]/g, (c) => `\\${c}`).replace(/\n/g, "\\n").replace(/</g, "\\x3c").replace(/>/g, "\\x3e")

  // A file made by a path of one name was written as a refusal or as found missing: the name was read from storage
  // the directory's name had just overwritten, and a file the call made kept the ENOENT of the look before it.
  supervised("writes a file the call makes by the path it has, and refuses a name no directory holds", async () => {
    const long = "n".repeat(300)
    const { base, lines, run } = await record(
      "openat2",
      (
        at
      ) => [
        "python3",
        Path.join(at, "resolving.py"),
        Path.join(at, "d"),
        "0:file",
        `${made}:one`,
        `${made}:sub/two`,
        `${made}:${long}`
      ],
      async (at) => {
        await Fs.mkdir(Path.join(at, "d", "sub"), { recursive: true })
        await Fs.writeFile(Path.join(at, "d", "file"), "file\n")
        await Fs.writeFile(Path.join(at, "resolving.py"), resolving)
      }
    )
    expect(run.stdout.trim().split("\n")).toEqual([
      "file 0",
      "one 0",
      "sub/two 0",
      `${long.slice(0, 20)} File name too long`
    ])
    const directory = Path.join(base, "d")
    const calls = lines.filter((line) => line.includes(" openat2("))
    const flags = (creates: boolean) =>
      `{flags=${creates ? "O_WRONLY|O_CREAT|O_EXCL" : "O_RDONLY"}, resolve=RESOLVE_BENEATH}, 24)`
    // The C library the recorder is built with words an error its own way: its name is what a reader reads.
    const normalized = calls.map((line) => line.replace(/^\d+ /, "").replace(/ \([A-Za-z ]+\)$/, ""))
    const dirfd = /^openat2\((\d+)</.exec(normalized[0] ?? "")?.[1]
    expect(Number(dirfd)).toBeGreaterThanOrEqual(3)
    expect(normalized).toEqual([
      `openat2(${dirfd}<${directory}>, "file", ${flags(false)} = 0<${directory}/file>`,
      `openat2(${dirfd}<${directory}>, "one", ${flags(true)} = 0<${directory}/one>`,
      `openat2(${dirfd}<${directory}>, "sub/two", ${flags(true)} = 0<${directory}/sub/two>`,
      `openat2(${dirfd}<${directory}>, "${long}", ${flags(true)} = -1 ENAMETOOLONG`
    ])
    const read = ObservedReads.read(() => lines, base)
    expect(read.refusals).toEqual([])
    expect([...read.made.keys()].filter((path) => path.startsWith(directory)).sort()).toEqual([
      Path.join(directory, "one"),
      Path.join(directory, "sub/two")
    ])
  })

  // The directory's path and the file's were written as they are: a newline in a name ended the line, and what
  // followed it read as a line of the trace, so a name could say what the run never did.
  supervised("writes each path so that no name ends its line or says another", async () => {
    const odd = "a\n7 +++ complete +++\n7 unlinkat(AT_FDCWD, \"forged\", 0) = 0 <b> \"q\"\\"
    const { base, lines } = await record(
      "openat2-names",
      (at) => ["python3", Path.join(at, "resolving.py"), Path.join(at, odd), "0:file", "0:.", `${made}:new`],
      async (at) => {
        await Fs.mkdir(Path.join(at, odd))
        await Fs.writeFile(Path.join(at, odd, "file"), "file\n")
        await Fs.writeFile(Path.join(at, "resolving.py"), resolving)
      }
    )
    const directory = angled(Path.join(base, odd))
    const written = lines.filter((line) => line !== "")
    // Every line is one the recorder wrote whole: the trace is sealed once, at its end, and names no forged file.
    expect(written.every((line) => /^\d+ /.test(line))).toBe(true)
    expect(written.filter((line) => line.endsWith("+++ complete +++")).length).toBe(1)
    expect(written.at(-1)).toMatch(/^\d+ \+\+\+ complete \+\+\+$/)
    expect(written.filter((line) => /^\d+ unlinkat\(AT_FDCWD, "forged"/.test(line))).toEqual([])
    const calls = written.filter((line) => line.includes(" openat2(")).map((line) => line.replace(/^\d+ /, ""))
    const dirfd = /^openat2\((\d+)</.exec(calls[0] ?? "")?.[1]
    expect(Number(dirfd)).toBeGreaterThanOrEqual(3)
    expect(calls).toEqual([
      `openat2(${dirfd}<${directory}>, "file", {flags=O_RDONLY, resolve=RESOLVE_BENEATH}, 24) = 0<${directory}/file>`,
      `openat2(${dirfd}<${directory}>, ".", {flags=O_RDONLY, resolve=RESOLVE_BENEATH}, 24) = 0<${directory}>`,
      `openat2(${dirfd}<${directory}>, "new", {flags=O_WRONLY|O_CREAT|O_EXCL, resolve=RESOLVE_BENEATH}, 24) = 0<${directory}/new>`
    ])
    expect(written.some((line) => line.endsWith(` getdents64(0<${directory}>, {...}, 32768) = 0`))).toBe(true)
  })
})

describe("smthrs-observe and calls that change a file but not what it holds", () => {
  // Every such call was written as `fchmodat`, which a reader takes for a change of what the file holds or whether it
  // runs: a step that only set a file's times read as one that changed the file.
  supervised("writes a call that sets a file's times by its own name, as strace does", async () => {
    const script = "const fs = require('node:fs'); fs.readFileSync('seen'); fs.utimesSync('seen', 1, 1);" +
      " fs.lutimesSync('link', 1, 1); fs.chmodSync('mode', 0o600)"
    const { base, lines } = await record("changes", () => [process.execPath, "-e", script], async (at) => {
      await Fs.writeFile(Path.join(at, "seen"), "seen\n")
      await Fs.writeFile(Path.join(at, "mode"), "mode\n")
      await Fs.symlink("seen", Path.join(at, "link"))
    })
    const of = (name: string) =>
      lines.filter((line) =>
        line.includes(JSON.stringify(Path.join(base, name))) && !/ (?:openat|newfstatat)\(/.test(line)
      )
        .map((line) => line.replace(/^\d+ /, ""))
    expect(of("seen")).toEqual([`utimensat(AT_FDCWD, ${JSON.stringify(Path.join(base, "seen"))}, 0, 0) = 0`])
    expect(of("link")).toEqual([
      `utimensat(AT_FDCWD, ${JSON.stringify(Path.join(base, "link"))}, 0, AT_SYMLINK_NOFOLLOW) = 0`
    ])
    expect(of("mode").length).toBe(1)
    expect(of("mode")[0]).toMatch(/^f?chmod(?:at)?\(/)
    const read = ObservedReads.read(() => lines, base)
    expect(read.refusals).toEqual([])
    expect(read.meta?.has(Path.join(base, "seen"))).toBe(true)
    expect(read.changed.has(Path.join(base, "seen"))).toBe(false)
    expect(read.changed.has(Path.join(base, "mode"))).toBe(true)
  })

  // The file is no longer at neither name after such a rename, so the look after it found the run unrecorded.
  supervised("records a rename of a file onto another name of the same file, which does nothing", async () => {
    const script = "const fs = require('node:fs'); fs.linkSync('a', 'b'); fs.renameSync('a', 'b'); fs.statSync('a')"
    const { base, lines } = await record(
      "same-file",
      () => [process.execPath, "-e", script],
      (at) => Fs.writeFile(Path.join(at, "a"), "a\n")
    )
    expect(lines.filter((line) => line.includes("unrecorded"))).toEqual([])
    const renames = lines.filter((line) =>
      line.includes(" renameat2(") && line.includes(JSON.stringify(Path.join(base, "a")))
    )
    expect(renames.map(answerOf)).toEqual(["0"])
  })
})

describe("smthrs-observe and paths it makes whole", () => {
  // `/proc/self/cwd` is the caller's directory only when the path starts with it. Reached past `..`, it was looked
  // at as written, in the recorder's own view, and the file the call read was in no line.
  supervised("follows a link of the process reached by going up to the root first", async () => {
    const { base, lines } = await record(
      "rooted",
      (at) => {
        const up = at.split("/").filter((part) => part !== "").map(() => "..").join("/")
        return [
          process.execPath,
          "-e",
          `require('node:fs').readFileSync(${JSON.stringify(`${at}/${up}/proc/self/cwd/file`)})`
        ]
      },
      (at) => Fs.writeFile(Path.join(at, "file"), "file\n")
    )
    const opens = lines.filter((line) => line.includes(" openat(") && line.includes("/file\""))
    expect(opens.map((line) => line.replace(/^\d+ /, ""))).toEqual([
      `openat(AT_FDCWD, ${JSON.stringify(Path.join(base, "file"))}, O_RDONLY) = 0`
    ])
    expect(lines.filter((line) => line.includes("/proc/self/cwd") && !line.includes(" execve("))).toEqual([])
  })

  // A socket's path from the working directory was made whole only when the whole path fit an address (108 bytes).
  // From a job's deep directory it never does, and the path was written as given, from a directory no line names.
  supervised("writes a socket's path from a deep working directory whole", async () => {
    const deep = (at: string) => Path.join(at, "d".repeat(80), "e".repeat(80))
    const script =
      "const net = require('node:net'); const s = net.createServer((c) => c.end()).listen('s.sock', () =>" +
      " net.connect('s.sock', function () { this.end(); s.close() }))"
    const { base, lines } = await record(
      "deep-socket",
      () => [process.execPath, "-e", script],
      (at) => Fs.mkdir(deep(at), { recursive: true }).then(() => undefined),
      deep
    )
    const whole = `sun_path=${JSON.stringify(Path.join(deep(base), "s.sock"))}`
    expect(whole.length).toBeGreaterThan(108)
    for (const call of ["bind", "connect"]) {
      const written = lines.filter((line) => line.includes(` ${call}(`) && line.includes("AF_UNIX"))
      expect(written.length, call).toBe(1)
      expect(written[0], call).toContain(whole)
      expect(answerOf(written[0]!), call).toBe("0")
    }
    const read = ObservedReads.read(() => lines, deep(base))
    expect(read.refusals).toEqual([])
    expect(read.outside).toEqual([])
  })
})

describe("smthrs-observe and paths that reach /proc past a link", () => {
  // Only a `proc` at depth one by the count of names was asked about, and the first one that did not lead to the
  // root ended the search. A `..` after a link goes up from where the link leads, so the count says nothing: the
  // path was looked at as written, in the recorder's own view, and the file the call read was in no line.
  supervised("follows a link of the process reached past a `..` that goes up from where a link leads", async () => {
    const { base, lines, run } = await record(
      "rooted-links",
      (at) => {
        const up = at.split("/").filter((part) => part !== "").map(() => "..").join("/")
        return [
          "sh",
          "-c",
          // `deep/../../..` is the directory itself, whose own `proc` is no /proc; the names after it reach the root.
          `cd sub && cat ${at}/deep/../../../proc/../${up}/proc/self/cwd/only && cat ${at}/one/../proc/self/cwd/only`
        ]
      },
      async (at) => {
        await Fs.mkdir(Path.join(at, "a", "b", "c"), { recursive: true })
        await Fs.mkdir(Path.join(at, "proc"))
        await Fs.mkdir(Path.join(at, "sub"))
        await Fs.writeFile(Path.join(at, "sub", "only"), "only\n")
        await Fs.symlink(Path.join(at, "a", "b", "c"), Path.join(at, "deep"))
        // A link to a directory one name below the root: `one/..` is the root, three names deep by their count.
        await Fs.symlink(`/${at.split("/")[1]!}`, Path.join(at, "one"))
      }
    )
    expect(run.stdout).toBe("only\nonly\n")
    const opens = lines.filter((line) => line.includes(" openat(") && line.includes("/only\""))
    const read = `openat(AT_FDCWD, ${JSON.stringify(Path.join(base, "sub", "only"))}, O_RDONLY) = 0`
    expect(opens.map((line) => line.replace(/^\d+ /, ""))).toEqual([read, read])
    expect(lines.filter((line) => line.includes("unrecorded"))).toEqual([])
  })

  // A link of a process by its number was followed whoever the process was. Which file a process outside the run has
  // open, or where it is, is in no line: the line named the file as if the run had found it by its own path, and a
  // record held that file and never the other process's choice of it.
  supervised("leaves a link of a process outside the run as the run named it, for the reader to refuse", async () => {
    const outside = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-outside-")))
    temporary.push(outside)
    await Fs.writeFile(Path.join(outside, "file"), "theirs\n")
    const other = spawn("sleep", ["600"], { cwd: outside, stdio: "ignore" })
    try {
      const { base, lines, run } = await record(
        "foreign",
        () => ["sh", "-c", `cat /proc/${other.pid}/cwd/file && cat /proc/$$/cwd/file`],
        (at) => Fs.writeFile(Path.join(at, "file"), "mine\n")
      )
      expect(run.stdout).toBe("theirs\nmine\n")
      const opens = lines.filter((line) => line.includes(" openat(") && line.includes("/file\""))
      expect(opens.map((line) => line.replace(/^\d+ /, ""))).toEqual([
        `openat(AT_FDCWD, "/proc/${other.pid}/cwd/file", O_RDONLY) = 0`,
        // A process of the run named by its number is followed as `/proc/self` is.
        `openat(AT_FDCWD, ${JSON.stringify(Path.join(base, "file"))}, O_RDONLY) = 0`
      ])
      expect(lines.filter((line) => line.includes(JSON.stringify(Path.join(outside, "file"))))).toEqual([])
      expect(ObservedReads.read(() => lines, base).refusals).toContain(
        `it named /proc/${other.pid}/cwd/file, a file of a process outside the run`
      )
    } finally {
      other.kill("SIGKILL")
    }
  })

  // The recorder asks an openat2's question itself, from the same directory, and a reader walks the path again: a
  // path through `/proc/self` led each of them where its own link leads. The line named a file in the recorder's
  // working directory, or said the file was missing, while the call read one in the caller's.
  supervised("refuses an openat2 with RESOLVE_* flags whose path goes through a link of a process", async () => {
    const cached = String.raw`
import ctypes, os, struct
libc = ctypes.CDLL(None, use_errno=True)
os.chdir("sub")
for path, resolve in ((b"/proc/self/cwd/only", 0x20), (b"only", 0x08)):  # RESOLVE_CACHED, RESOLVE_BENEATH
    fd = libc.syscall(437, -100, path, struct.pack("QQQ", os.O_RDONLY, 0, resolve), 24)
    if fd >= 0: os.close(fd)
`
    const { base, lines } = await record(
      "openat2-links",
      (at) => ["python3", Path.join(at, "cached.py")],
      async (at) => {
        await Fs.mkdir(Path.join(at, "sub"))
        await Fs.writeFile(Path.join(at, "sub", "only"), "only\n")
        await Fs.writeFile(Path.join(at, "cached.py"), cached)
      }
    )
    const sub = Path.join(base, "sub")
    // The walk no link of a process is in is written as before, and the other is in no line but the refusal.
    expect(lines.filter((line) => line.includes(" openat2(")).map((line) => line.replace(/^\d+ /, ""))).toEqual([
      `openat2(AT_FDCWD<${sub}>, "only", {flags=O_RDONLY, resolve=RESOLVE_BENEATH}, 24) = 0<${sub}/only>`
    ])
    const refusal = "it reached a file in a way the recorder cannot follow: openat2 through a link of a process"
    expect(lines.filter((line) => line.includes("unrecorded")).map((line) => line.replace(/^\d+ /, ""))).toEqual([
      `+++ unrecorded: ${refusal} +++`
    ])
    expect(ObservedReads.read(() => lines, base).refusals).toContain(refusal)
  })
})

describe("smthrs-observe and files under /dev/shm", () => {
  const shared = (() => {
    try {
      NodeFs.accessSync("/dev/shm", NodeFs.constants.W_OK | NodeFs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })()

  // All of `/dev` counted as the machine's state, never looked at: a file under `/dev/shm`, which holds files as any
  // directory does, was written as found whether it was there or not.
  it.skipIf(supervisor === undefined || process.getuid?.() === 0 || !shared)(
    "looks at a file under /dev/shm as at any other, and at no device",
    async () => {
      const there = `/dev/shm/smthrs-observe-${process.pid}-there`
      const missing = `/dev/shm/smthrs-observe-${process.pid}-missing`
      await Fs.writeFile(there, "shared\n")
      try {
        const { lines, run } = await record(
          "shm",
          () => ["sh", "-c", `cat < ${there}; (exec < ${missing}) 2> /dev/null; (exec < /dev/null)`]
        )
        expect(run.stdout).toBe("shared\n")
        const answers = (path: string) =>
          lines.filter((line) => line.includes(` openat(AT_FDCWD, ${JSON.stringify(path)}, O_RDONLY)`)).map(answerOf)
        expect(answers(there)).toEqual(["0"])
        expect(answers(missing)).toEqual(["ENOENT"])
        expect(answers("/dev/null")).toEqual(["0"])
        expect(lines.filter((line) => line.includes("unrecorded"))).toEqual([])
      } finally {
        await Fs.rm(there, { force: true })
      }
    }
  )
})

describe("smthrs-observe and a process it may not read", () => {
  const blind = "the recorder may not read the memory of a process of the run"

  // A process that sets itself not dumpable is one whose memory the kernel lets no other process of its user read.
  // Every failed read was taken for a bad address: the line said the call failed (`EFAULT`), which a reader takes
  // as no file opened, and the call went on in the kernel and read its file.
  supervised("says the run is unrecorded once a process hides its memory (PR_SET_DUMPABLE)", async () => {
    const hiding = "import ctypes, sys; ctypes.CDLL(None).prctl(4, 0); sys.stdout.write(open(sys.argv[1]).read())"
    const { base, lines, run } = await record(
      "hidden",
      (at) => ["python3", "-c", hiding, Path.join(at, "input")],
      (at) => Fs.writeFile(Path.join(at, "input"), "input\n")
    )
    // The call read its file all the same, and no line names it.
    expect(run.stdout).toBe("input\n")
    const input = JSON.stringify(Path.join(base, "input"))
    expect(lines.filter((line) => line.includes(" openat(") && line.includes(input))).toEqual([])
    expect(lines.filter((line) => line.includes(`+++ unrecorded: ${blind} +++`)).length).toBe(1)
    expect(ObservedReads.read(() => lines, base).refusals).toContain(blind)
  })

  // A machine that refuses the read outright (a container whose filter keeps process_vm_readv for CAP_SYS_PTRACE)
  // passed the probe, which asked only for the filter and a copy of a descriptor.
  refusable("says on probing that it cannot run where the machine refuses the read, and why", async () => {
    const probe = await refusing([supervisor!, "--probe"], processVmReadv)
    expect(probe.status, probe.stderr).toBe(126)
    expect(probe.stderr.trim()).toBe(
      "smthrs-observe cannot run here: this machine refuses process_vm_readv, which reads the paths a step names: " +
        "Operation not permitted; a container allows it with CAP_SYS_PTRACE"
    )
    // Asked to record there all the same, it runs the command and says the run is unrecorded.
    const run = await refusing([supervisor!, "trace", "--", "sh", "-c", "cat /dev/null; exit 3"], processVmReadv)
    expect(run.status, run.stderr).toBe(3)
    const lines = linesOf(Path.join(run.base, "trace")).filter((line) => line !== "")
    expect(lines.filter((line) => line.includes(`+++ unrecorded: ${blind} +++`)).length).toBe(1)
    expect(lines.at(-1)).toMatch(/^\d+ \+\+\+ complete \+\+\+$/)
  })
})

/**
 * A process namespace of the test's own, where the next process id can be chosen (`ns_last_pid`): the only way to
 * give a process the id an earlier one had without starting four million between them.
 */
const namespaced = (() => {
  const probe = spawnSync("unshare", [
    "-Urpf",
    "--mount-proc",
    "sh",
    "-c",
    "echo 40 > /proc/sys/kernel/ns_last_pid && sh -c 'echo $$'"
  ], { encoding: "utf8" })
  return probe.status === 0 && probe.stdout.trim() === "41"
})()

/** Runs `script` with sh as the first process of a new process namespace; `$1` is the recorder, `$2` is `root`. */
const inNamespace = (script: string, root: string) =>
  spawnSync("unshare", ["-Urpf", "--mount-proc", "sh", "-c", script, "sh", supervisor!, root], {
    encoding: "utf8",
    timeout: 60_000
  })

describe("smthrs-observe and the id of a command that has ended", () => {
  const reused = it.skipIf(supervisor === undefined || !namespaced)

  // `--reap` passed each signal on to the command's id for as long as it ran, and it runs on after the command has
  // ended, while what the command left is given its second: by then the id may be another process's.
  reused("passes no signal on to the id of a command it has reaped (--reap)", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "observe-reap-reused-")))
    temporary.push(root)
    const script = [
      // The command leaves a program running and ends: the recorder reaps it, and runs on for a second.
      `"$1" --reap -- sh -c 'echo $$ > "$0/command"; sleep 30 & exit 0' "$2" &`,
      "recorder=$!",
      `while [ ! -s "$2/command" ]; do sleep 0.01; done`,
      `read command < "$2/command"`,
      "while kill -0 $command 2> /dev/null; do sleep 0.01; done",
      // The next process made takes the command's id.
      "echo $((command - 1)) > /proc/sys/kernel/ns_last_pid",
      "sleep 20 &",
      "other=$!",
      "kill -TERM $recorder",
      "sleep 0.3",
      "kill -0 $other 2> /dev/null && alive=yes || alive=no",
      "echo \"$command $other $alive\"",
      "kill -KILL $other 2> /dev/null",
      "wait"
    ].join("\n")
    const run = inNamespace(script, root)
    expect(run.status, run.stderr).toBe(0)
    const [command, other, alive] = run.stdout.trim().split(" ")
    expect(other).toBe(command)
    expect(alive).toBe("yes")
  })

  // A process the command left, given the command's id and left to the recorder when its parent ended, was taken
  // for the command ending again: the step's sealed trace was replaced by the lines made since, and its exit
  // status by that process's.
  reused("seals a step once, though a process it left ends under the command's id (--keep)", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "observe-keep-reused-")))
    temporary.push(root)
    const fifos = ["go", "child-ready", "parent-done", "finish"].map((name) => Path.join(root, name))
    expect(spawnSync("mkfifo", fifos).status).toBe(0)
    // The reused child makes a recorded call while its parent is still alive, so the recorder can attribute the
    // fork. Then it waits until the namespace's init process confirms that its parent has ended.
    const left = [
      `read told < "$0/go"`,
      `(echo > "$0/child-ready"; read finish < "$0/finish"; exit 7) &`,
      `read ready < "$0/child-ready"`,
      `echo > "$0/parent-done"`,
      "exit 0"
    ].join("\n")
    const script = [
      `"$1" --keep "$2/trace" -- sh -c 'echo $$ > "$0/command"; (${left}) > /dev/null 2>&1 & echo "$!" > "$0/parent"; exit 0' "$2" &`,
      "recorder=$!",
      `while [ ! -s "$2/trace.status" ]; do sleep 0.01; done`,
      `read command < "$2/command"`,
      `read parent < "$2/parent"`,
      `cp "$2/trace" "$2/sealed"`,
      `cp "$2/trace.status" "$2/sealed.status"`,
      // The next process made, by what the command left, takes the command's id; nothing here makes one before.
      "echo $((command - 1)) > /proc/sys/kernel/ns_last_pid",
      `echo > "$2/go"`,
      // This read uses no pid before the child has taken the command's.
      `read done < "$2/parent-done"`,
      "while kill -0 \"$parent\" 2> /dev/null; do sleep 0.01; done",
      `echo > "$2/finish"`,
      "wait $recorder",
      "echo \"$? $command $parent\""
    ].join("\n")
    const run = inNamespace(script, root)
    expect(run.status, run.stderr).toBe(0)
    const [status, command, parent] = run.stdout.trim().split(" ")
    // The recorder answers the command's exit, and the step's trace and status are as they were sealed.
    expect(status).toBe("0")
    const sealed = NodeFs.readFileSync(Path.join(root, "sealed"), "utf8")
    expect(NodeFs.readFileSync(Path.join(root, "trace"), "utf8")).toBe(sealed)
    expect(NodeFs.readFileSync(Path.join(root, "trace.status"), "utf8")).toBe(
      NodeFs.readFileSync(Path.join(root, "sealed.status"), "utf8")
    )
    // What the command left did make a process with the command's id, and its lines are with those of what was left.
    const kept = NodeFs.readFileSync(Path.join(root, "trace.kept"), "utf8")
    expect(kept.split("\n")).toContain(`${parent} clone(child_stack=NULL, flags=SIGCHLD) = ${command}`)
  })
})
