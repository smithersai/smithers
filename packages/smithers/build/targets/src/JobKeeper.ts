/**
 * One process namespace for a job, so that what a step leaves running lives
 * until the job's last step has ended, as on a GitHub runner.
 *
 * A CI runner starts each step of a job as its own process, and a program a
 * step starts and does not wait for (`python3 -m http.server &`, `redis-server
 * --daemonize yes`) keeps running: the job's next step can talk to it, and the
 * runner ends it when the job is complete. Here the job's steps all start in
 * one process namespace, held by a keeper. The keeper runs as the second
 * process of the namespace, through bubblewrap's `--unshare-pid` (its owner
 * builds that command, with the job's mounts), and listens on a socket in a
 * directory of the job's own. A step is started by the client: it hands the
 * keeper its command, its environment and its directory, passes on what the
 * step prints, and exits as the step's command exits. What the step left
 * running stays in the namespace, where no process outside it can see it, and
 * no program of it can leave it however it detaches. When the job ends its
 * owner ends the namespace, and the kernel ends every process in it.
 *
 * The client also says which processes the step left running: those alive
 * once its command ended that are neither older than the step nor started by
 * a program that is, so that a server's own worker never counts for a later
 * step. Where it left one, the step ends once the job's processes have used
 * no CPU for a tenth of a second, or after ten seconds: a server it started
 * has finished starting, as a runner's time between two steps lets it, and
 * the next step finds it listening. A recorder that keeps following what the step left (`smthrs-observe`,
 * strace) stays alive itself: it writes the command's exit status to the file
 * the request names (`done`), and the step ends then.
 *
 * Both programs are JavaScript text that `node -e` runs, so an installed
 * package needs no file beside this module.
 *
 * @since 0.1.0
 */

import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"

/**
 * The name of the keeper's socket, in the job's directory. Both sides use it
 * relative to that directory, so a deep directory never makes the socket's
 * path too long for the kernel.
 *
 * @category constants
 * @since 0.1.0
 */
export const socketName = "keeper.sock"

/**
 * The frames both sides write: a type byte, the body's length as four bytes
 * (big-endian), and the body. The client sends `R` (the request, JSON) and
 * `K` (a signal to pass on); the keeper sends `O` and `E` (what the step
 * printed) and `X` (JSON: its exit code, its signal, and what it left).
 */
const frames = String.raw`
const frame = (socket, type, payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const head = Buffer.alloc(5)
  head.write(type, 0, "latin1")
  head.writeUInt32BE(body.length, 1)
  socket.write(Buffer.concat([head, body]))
}
const reader = (each) => {
  let held = Buffer.alloc(0)
  return (chunk) => {
    held = Buffer.concat([held, chunk])
    while (held.length >= 5 && held.length >= 5 + held.readUInt32BE(1)) {
      const length = held.readUInt32BE(1)
      each(held.toString("latin1", 0, 1), held.subarray(5, 5 + length))
      held = held.subarray(5 + length)
    }
  }
}
`

/**
 * The keeper: `node -e keeperProgram`, started in the job's directory as the
 * second process of a namespace of its own. It serves each step that asks.
 *
 * @category constants
 * @since 0.1.0
 */
export const keeperProgram = String.raw`"use strict"
const net = require("node:net")
const fs = require("node:fs")
const spawn = require("node:child_process").spawn
${frames}
const self = process.pid
// Every process of the namespace but its first and the keeper, by its parent; a process that has ended is none.
const alive = () => {
  const found = new Map()
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === 1 || pid === self) continue
    try {
      const stat = fs.readFileSync("/proc/" + entry + "/stat", "latin1")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      if (fields[0] !== "Z" && fields[0] !== "X") found.set(pid, Number(fields[1]))
    } catch {}
  }
  return found
}
// The CPU time every process of the namespace but the keeper has used, in clock ticks.
const cpuOf = () => {
  let used = 0
  for (const pid of alive().keys()) {
    try {
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "latin1")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      used += Number(fields[11]) + Number(fields[12])
    } catch {}
  }
  return used
}
const commandOf = (pid) => {
  try {
    return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0").filter((word) => word !== "").join(" ").slice(0, 200)
  } catch {
    return ""
  }
}
// What a step left: alive now, not alive before it, and not started by a process that was.
const leftSince = (before) => {
  const now = alive()
  const older = (pid) => {
    for (let parent = now.get(pid), steps = 0; parent !== undefined && steps < 4096; parent = now.get(parent), steps++) {
      if (before.has(parent)) return true
    }
    return false
  }
  return [...now.keys()].filter((pid) => !before.has(pid) && !older(pid))
}
const serve = (socket) => {
  let child
  let settled = false
  let answered = false
  const read = reader((type, body) => {
    if (type === "R" && child === undefined && !answered) start(JSON.parse(body.toString("utf8")))
    else if (type === "K" && child !== undefined && child.pid !== undefined) {
      try {
        process.kill(-child.pid, body.toString("latin1"))
      } catch {}
    }
  })
  socket.on("data", read)
  socket.on("error", () => {})
  // A client that went away before its step ended takes the step with it.
  socket.on("close", () => {
    if (!answered && child !== undefined && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {}
    }
  })
  const start = (request) => {
    const before = alive()
    let last = Date.now()
    let ended = 0
    let forwarding = true
    const forward = (type) => (chunk) => {
      last = Date.now()
      if (forwarding) frame(socket, type, chunk)
    }
    const answer = (result) => {
      if (answered) return
      answered = true
      forwarding = false
      frame(socket, "X", JSON.stringify(result))
      socket.end()
    }
    // Once the command has ended, what it printed is passed on, and then what it left is settled: a process that
    // ends within a moment, as the last of a pipeline does, was not left.
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      const at = Date.now()
      const drained = () => {
        if (ended < 2 && Date.now() - last < 50 && Date.now() - at < 2000) return setTimeout(drained, 10)
        forwarding = false
        const until = Date.now() + 300
        const settle = () => {
          const left = leftSince(before)
          if (left.length > 0 && Date.now() < until) return setTimeout(settle, 20)
          const done = () => answer({ code, signal, left: left.map((pid) => ({ pid, command: commandOf(pid) })) })
          if (left.length === 0) return done()
          // What it left is let finish starting, as a runner's time between two steps lets it: a server listens
          // before the next step asks it. It has once the CPU time of every process of the job stops growing.
          let last = -1
          let still = 0
          const started = Date.now()
          const quiet = () => {
            const used = cpuOf()
            still = used === last ? still + 1 : 0
            last = used
            if (still >= 5 || Date.now() - started > 10000) return done()
            setTimeout(quiet, 20)
          }
          quiet()
        }
        settle()
      }
      drained()
    }
    try {
      child = spawn(request.argv[0], request.argv.slice(1), {
        cwd: request.cwd,
        env: request.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"]
      })
    } catch (error) {
      frame(socket, "E", "smthrs: " + String(error && error.message) + "\n")
      return answer({ code: 127, signal: null, left: [] })
    }
    child.stdout.on("data", forward("O"))
    child.stderr.on("data", forward("E"))
    child.stdout.on("end", () => ended++)
    child.stderr.on("end", () => ended++)
    child.on("error", (error) => {
      frame(socket, "E", "smthrs: " + request.argv[0] + ": " + String(error && error.message) + "\n")
      if (!settled) {
        settled = true
        answer({ code: error && error.code === "ENOENT" ? 127 : 126, signal: null, left: [] })
      }
    })
    child.on("exit", (code, signal) => finish(code, signal))
    // A recorder that keeps following what the command left writes the command's exit status to the file named.
    if (typeof request.done === "string" && request.done !== "") {
      const look = () => {
        if (settled) return
        let text = ""
        try {
          text = fs.readFileSync(request.done, "utf8")
        } catch {}
        const code = /^[0-9]+/.exec(text)
        if (code === null) return setTimeout(look, 10)
        // A recorder with nothing left to follow ends at once: its own end comes with its whole record.
        setTimeout(() => finish(Number(code[0]), null), 100)
      }
      look()
    }
  }
}
try {
  fs.rmSync(${JSON.stringify(socketName)}, { force: true })
} catch {}
// An owner that holds the keeper's input open owns the job: once that input closes, however the owner ended, the
// keeper ends, and the namespace with every process of the job. Bubblewrap's --die-with-parent misses an owner that
// dies before bubblewrap has asked to die with it.
try {
  const input = fs.fstatSync(0)
  if (input.isFIFO() || input.isSocket()) {
    process.stdin.on("data", () => {})
    process.stdin.on("end", () => process.exit(0))
    process.stdin.on("error", () => process.exit(0))
  }
} catch {}
net.createServer(serve).listen(${JSON.stringify(socketName)})
`

/**
 * The client: `node -e clientProgram <directory> <left> <done> -- <command>`,
 * started as the step. It connects to the keeper in `directory`, hands it the
 * command, its own environment and its working directory, prints what the
 * step prints, writes what it left to the file `left` as JSON (when not
 * empty), and exits as the command exits: with its code, or by its signal.
 * A signal it is sent goes on to the step. `NODE_OPTIONS` is the step's, not
 * the client's: {@link client} keeps it in `SMTHRS_STEP_NODE_OPTIONS`.
 *
 * @category constants
 * @since 0.1.0
 */
export const clientProgram = String.raw`"use strict"
const net = require("node:net")
const fs = require("node:fs")
${frames}
const [directory, leftFile, done, , ...argv] = process.argv.slice(1)
const env = { ...process.env }
delete env.SMTHRS_STEP_NODE_OPTIONS
if (process.env.SMTHRS_STEP_NODE_OPTIONS !== undefined) env.NODE_OPTIONS = process.env.SMTHRS_STEP_NODE_OPTIONS.slice(1)
const cwd = process.cwd()
process.chdir(directory)
const socket = net.connect(${JSON.stringify(socketName)})
let result
const write = (stream, body) => {
  if (!stream.write(body)) {
    socket.pause()
    stream.once("drain", () => socket.resume())
  }
}
socket.on("connect", () => frame(socket, "R", JSON.stringify({ argv, env, cwd, done })))
socket.on("data", reader((type, body) => {
  if (type === "O") write(process.stdout, body)
  else if (type === "E") write(process.stderr, body)
  else if (type === "X") result = JSON.parse(body.toString("utf8"))
}))
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
  process.on(signal, () => {
    if (!socket.destroyed) frame(socket, "K", signal)
  })
}
let ended = false
const end = (error) => {
  if (ended) return
  ended = true
  if (result === undefined) {
    process.stderr.write("smthrs: the job's keeper ended before the step did" + (error ? ": " + error.message : "") + "\n")
    process.exitCode = 125
    return
  }
  if (leftFile !== "") fs.writeFileSync(leftFile, JSON.stringify(result.left))
  if (result.signal !== null) {
    process.stdout.write("", () => process.stderr.write("", () => {
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) process.removeAllListeners(signal)
      process.kill(process.pid, result.signal)
    }))
    return
  }
  process.exitCode = result.code
}
socket.on("error", end)
socket.on("close", () => end())
`

/**
 * The shell that starts the client with the step's `NODE_OPTIONS` set aside,
 * so that a step that sets it, as `--require ./setup.js`, changes nothing of
 * the client: `$1` is Node, and the rest the client's arguments.
 */
const clientShell = [
  "node=$1",
  "shift",
  "if [ \"${NODE_OPTIONS+set}\" = set ]; then SMTHRS_STEP_NODE_OPTIONS=\"x$NODE_OPTIONS\"; export SMTHRS_STEP_NODE_OPTIONS; fi",
  "unset NODE_OPTIONS",
  "exec \"$node\" -e \"$0\" \"$@\""
].join("\n")

/**
 * The argv that runs the keeper; its owner starts it in the job's directory,
 * inside a process namespace of its own ({@link namespaced}).
 *
 * @throws {never}
 * @category rendering
 * @since 0.1.0
 */
export const keeper = (node: string): readonly [string, ...Array<string>] => [node, "-e", keeperProgram]

/**
 * The argv that runs `argv` as a step of the job whose keeper listens in
 * `directory`. With `left`, the client writes there, as JSON, what the step
 * left running ({@link Left}). With `done`, the step has ended once that
 * file holds its exit status, as a recorder that keeps following what the
 * step left writes it.
 *
 * @throws {never}
 * @category rendering
 * @since 0.1.0
 */
export const client = (
  node: string,
  directory: string,
  argv: ReadonlyArray<string>,
  options: { readonly left?: string | undefined; readonly done?: string | undefined } = {}
): readonly [string, ...Array<string>] => [
  "/bin/sh",
  "-c",
  clientShell,
  clientProgram,
  node,
  directory,
  options.left ?? "",
  options.done ?? "",
  "--",
  ...argv
]

/**
 * The bubblewrap argv that runs `argv` as the second process of a process
 * namespace of its own, with `/proc` showing that namespace alone, and every
 * path of the host where it is but what `binds` puts elsewhere. The namespace
 * ends, and every process in it, when this bubblewrap's parent does or when
 * the bubblewrap is killed.
 *
 * @throws {never}
 * @category rendering
 * @since 0.1.0
 */
export const namespaced = (
  bwrap: string,
  binds: ReadonlyArray<string>,
  argv: ReadonlyArray<string>
): readonly [string, ...Array<string>] => [
  bwrap,
  "--dev-bind",
  "/",
  "/",
  ...binds,
  "--unshare-pid",
  "--proc",
  "/proc",
  "--die-with-parent",
  "--",
  ...argv
]

/**
 * A process a step left running: its id in the job's namespace and its
 * command line, cut to 200 characters.
 *
 * @category models
 * @since 0.1.0
 */
export interface Left {
  readonly pid: number
  readonly command: string
}

/**
 * What the client wrote to its `left` file: the processes the step left
 * running, or none when the file is missing or holds anything else.
 *
 * @throws {never}
 * @category parsing
 * @since 0.1.0
 */
export const leftIn = (text: string | undefined): ReadonlyArray<Left> => {
  if (text === undefined) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is Left =>
        typeof entry === "object" && entry !== null && typeof entry.pid === "number" &&
        typeof entry.command === "string"
      )
      : []
  } catch {
    return []
  }
}

/**
 * What a step left running, as its client wrote it to `file`, which is then
 * removed: none when the client wrote nothing, as when the keeper ended first.
 *
 * @category parsing
 * @since 0.1.0
 */
export const leftAt = async (file: string): Promise<ReadonlyArray<Left>> => {
  const text = await Fs.readFile(file, "utf8").catch(() => undefined)
  await Fs.rm(file, { force: true })
  return leftIn(text)
}

/**
 * Ends `left`, what a step left running, in the job whose keeper listens in
 * `directory`: a step of the job kills them, so the ids name them in its
 * namespace. Resolves once that step has ended.
 *
 * @category running
 * @since 0.1.0
 */
export const end = (node: string, directory: string, left: ReadonlyArray<Left>): Promise<void> =>
  new Promise((resolve) => {
    // The shell's own `kill`: the step needs no `PATH`.
    const argv = client(node, directory, [
      "/bin/sh",
      "-c",
      "kill -KILL \"$@\"",
      "kill",
      ...left.map((each) => String(each.pid))
    ])
    execFile(argv[0], argv.slice(1), { env: {} }, () => resolve())
  })
