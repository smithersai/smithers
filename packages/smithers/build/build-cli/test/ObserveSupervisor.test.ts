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
import { spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"

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

describe("smthrs-observe and signals", () => {
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
