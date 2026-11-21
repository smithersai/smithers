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
import { signalling, survivedTimer, ticking } from "./helpers/SignalStorm.ts"

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
          const call = kind === "open" || kind === "write"
            ? "openat"
            : kind === "change"
            ? "fchmodat"
            : kind === "chdir"
            ? "chdir"
            : "newfstatat"
          const target = name === "access-file" ? "file" : name
          const flags = kind === "open" ? "O_RDONLY" : kind === "write" ? "O_WRONLY" : ""
          // The first line of the kind says what was there; a link's own look is the one that does not follow it.
          const line = of(call, target).find((candidate) =>
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

/**
 * A seccomp program that answers EPERM to `pidfd_getfd` (call 438 on x86_64
 * and aarch64) and lets every other call through, as Docker's default profile
 * does in a container without CAP_SYS_PTRACE.
 */
const refusingPidfdGetfd = (): Buffer => {
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
    instruction(0x15, 0, 1, 438), // pidfd_getfd?
    instruction(0x06, 0, 0, 0x00050000 | 1), // answer EPERM
    instruction(0x06, 0, 0, 0x7fff0000) // let it through
  ])
}

/** Runs `argv` under bubblewrap with that program loaded, the whole file system in sight. */
const refusing = async (argv: ReadonlyArray<string>) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-refused-")))
  temporary.push(base)
  const filter = Path.join(base, "filter.bpf")
  await Fs.writeFile(filter, refusingPidfdGetfd())
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

  refusable("makes a run that binds a socket unrecorded, rather than lose the bind", async () => {
    const script = "require('node:net').createServer().listen(0, '127.0.0.1', function () { this.close() })"
    const run = await refusing([supervisor!, "trace", "--", process.execPath, "-e", script])
    expect(run.status, run.stderr).toBe(0)
    const lines = NodeFs.readFileSync(Path.join(run.base, "trace"), "utf8").split("\n").filter((line) => line !== "")
    expect(lines.filter((line) => line.includes(" bind("))).toEqual([])
    expect(lines.at(-2)).toMatch(
      /^\d+ \+\+\+ unrecorded: this machine refuses pidfd_getfd, which reads a socket the run bound; a container allows it with CAP_SYS_PTRACE \+\+\+$/
    )
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
      const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-observe-ticking-")))
      temporary.push(base)
      const script = Path.join(base, "ticking.py")
      await Fs.writeFile(script, ticking)
      const trace = Path.join(base, "trace")
      const run = spawnSync(supervisor!, [trace, "--", "python3", script, "1", script], {
        encoding: "utf8",
        timeout: 60_000
      })
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toBe("done\n")
      const lines = NodeFs.readFileSync(trace, "utf8").split("\n")
      const counted = lines.map((line) => /^\d+ \+\+\+ signal stops: (\d+) \+\+\+$/.exec(line)?.[1]).find((n) =>
        n !== undefined
      )
      // A second of a timer every 200 microseconds: about 5,000, however busy the machine.
      expect(Number(counted)).toBeGreaterThan(1_000)
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
