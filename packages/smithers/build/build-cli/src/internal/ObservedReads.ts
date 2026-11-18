/**
 * What a run read, and whether it would read the same again.
 *
 * A shell command can open any file it can reach, so its declared inputs are
 * the most it may depend on, not what it does depend on. A target that asks
 * to be observed runs under a system-call trace. The trace names every path
 * the run looked at: each file it opened or asked about, each directory it
 * listed, each path it probed and found missing. The stored result holds
 * those paths and what was there. A later run is answered from the store
 * when every one of them still holds the same thing, whatever else changed.
 *
 * Three rules keep that answer honest:
 *
 * - A path the run made before it looked at it is the run's own product and
 *   never an input. A path it found missing and then made matches when it is
 *   missing again or still as the run left it. Any other path is compared
 *   with what the run left there.
 * - A run whose reads cannot all be known stores nothing: it reached a
 *   program or a network the trace does not cover, changed its own view of
 *   the file system, or left a trace that cannot be read in full.
 * - A file somebody else changed while the run was going stores nothing,
 *   because what the run saw there can no longer be measured.
 *
 * The tracer is `strace` with a seccomp filter, so only the file-system calls
 * stop the process. `io_uring` is refused to the run, as it is in a
 * container: a read submitted through a ring is in no trace. A traced run
 * ends when its command ends, and a process the command left running is
 * stopped, as a sandbox stops it.
 *
 * @since 1.0.0
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import { byCodeUnit } from "./Text.ts"

/**
 * The format tag of a stored set of records; any other tag is ignored.
 *
 * @category constants
 * @since 1.0.0
 */
export const format = "smthrs-observed-reads/1"

/**
 * Records kept for one declaration. A fresh checkout and a tree a run has
 * already been through read differently, and each keeps its own record.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumRecords = 4

/**
 * The largest set of records stored for one declaration, in JSON bytes.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumBytes = 12 * 1024 * 1024

/** Symbolic links one path may pass through before resolving it fails. */
const maximumLinks = 40

/** The system calls a trace stops at. */
const calls: ReadonlyArray<string> = [
  "access",
  "bind",
  "chdir",
  "chmod",
  "chown",
  "chroot",
  "clone",
  "clone3",
  "connect",
  "creat",
  "execve",
  "execveat",
  "faccessat",
  "faccessat2",
  "fchdir",
  "fchmod",
  "fchmodat",
  "fchmodat2",
  "fchown",
  "fchownat",
  "futimesat",
  "fork",
  "getdents",
  "getdents64",
  "io_uring_setup",
  "lchown",
  "link",
  "linkat",
  "lstat",
  "mkdir",
  "mkdirat",
  "mount",
  "newfstatat",
  "open",
  "openat",
  "openat2",
  "pivot_root",
  "readlink",
  "readlinkat",
  "rename",
  "renameat",
  "renameat2",
  "rmdir",
  "setns",
  "stat",
  "statx",
  "symlink",
  "symlinkat",
  "truncate",
  "unlink",
  "unlinkat",
  "utime",
  "utimensat",
  "utimes",
  "vfork"
]

/** What the tracer is always started with, before the trace file and the command. */
const tracerFlags: ReadonlyArray<string> = [
  "-f",
  "-qq",
  "-y",
  "-s",
  "8192",
  "--seccomp-bpf",
  "-e",
  "signal=none",
  "-e",
  `trace=${calls.join(",")}`,
  "-e",
  "inject=io_uring_setup:error=ENOSYS"
]

const quoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * Runs a command under the tracer and ends when the command ends. `$1` is
 * the tracer, `$2` the trace file, and the rest the command.
 *
 * The tracer waits for every process it follows, so a command that leaves
 * one running would hold the run until that process ends. A shell inside the
 * trace writes the command's exit status, and the tracer's process id,
 * beside the trace file the moment the command ends. A watcher then kills
 * any process the tracer still follows a second later: one the tracer let go
 * would keep the tracer's filter and fail every file call. A tracer that has
 * to be killed itself may not have written its last lines, so a line no
 * trace holds is added and the run stores nothing.
 *
 * The watcher is the background job, and the tracer with the command keeps
 * the foreground: a shell makes its background jobs ignore the interrupt and
 * quit signals and gives them no input, and the command would inherit both.
 */
const supervisor = [
  "tracer=$1",
  "out=$2",
  "shift 2",
  "(",
  `  while [ ! -s "$out.status" ]; do sleep 0.1; done`,
  `  read -r status tracing < "$out.status"`,
  "  rounds=0",
  `  while kill -0 "$tracing" 2>/dev/null; do`,
  "    rounds=$((rounds + 1))",
  `    if [ "$rounds" -gt 10 ]; then`,
  `      for left in $(grep -l -s "^TracerPid:[[:space:]]*$tracing\\$" /proc/[0-9]*/status); do`,
  "        left=${left#/proc/}",
  `        kill -KILL "\${left%/status}" 2>/dev/null`,
  "      done",
  "    fi",
  `    if [ "$rounds" -gt 100 ]; then`,
  `      kill -KILL "$tracing" 2>/dev/null`,
  `      echo "the tracer was stopped before it wrote its last lines" >> "$out"`,
  "    fi",
  "    sleep 0.1",
  "  done",
  ") > /dev/null 2>&1 &",
  "watching=$!",
  `"$tracer" ${tracerFlags.map(quoted).join(" ")} -o "$out" -- \\`,
  `  /bin/sh -c '"$@"; status=$?; echo "$status $PPID" > "$0"; exit "$status"' "$out.status" "$@"`,
  "code=$?",
  `kill "$watching" 2>/dev/null`,
  `wait "$watching" 2>/dev/null`,
  `if [ -s "$out.status" ]; then read -r code tracing < "$out.status"; fi`,
  `rm -f "$out.status"`,
  `exit "$code"`
].join("\n")

/**
 * The argv that runs `argv` under the tracer and writes its trace to
 * `traceFile`. It exits as the command exits, and as soon as it does. The
 * command's exit status passes through a file named `traceFile` with
 * `.status` added, which is removed again.
 *
 * @category tracing
 * @since 1.0.0
 */
export const command = (
  tracer: string,
  traceFile: string,
  argv: ReadonlyArray<string>
): ReadonlyArray<string> => ["/bin/sh", "-c", supervisor, "smthrs-observe", tracer, traceFile, ...argv]

/**
 * A host's answer to whether it can observe a run: the tracer's path, or why
 * there is none.
 *
 * @category models
 * @since 1.0.0
 */
export type Observer = { readonly tracer: string } | { readonly reason: string }

/**
 * Finds the tracer on a host and proves it can trace a process here. A
 * container may forbid tracing, and an old tracer lacks the filter.
 *
 * @category tracing
 * @since 1.0.0
 */
export const observer = (host: {
  readonly platform: NodeJS.Platform
  readonly executable: (name: string) => string | undefined
}): Observer => {
  if (host.platform !== "linux") return { reason: `reads cannot be observed on ${host.platform}` }
  const tracer = host.executable("strace")
  if (tracer === undefined) return { reason: "strace is not installed" }
  const probe = spawnSync(tracer, [...tracerFlags, "-o", "/dev/null", "--", tracer, "-V"], {
    encoding: "utf8",
    timeout: 30_000
  })
  if (probe.status === 0) return { tracer }
  // A tracer that could not be started at all said nothing.
  const said = (probe.stderr ?? "").trim().split("\n")[0]!
  return { reason: `strace cannot trace a process on this host${said === "" ? "" : `: ${said}`}` }
}

/**
 * What a trace says a run did, by path. Every path is absolute, written as
 * the run wrote it against its working directory. Each map holds the line of
 * the trace where the path first appears that way.
 *
 * @category models
 * @since 1.0.0
 */
export interface Trace {
  /** Paths the run looked at and found, or whose answer the trace does not hold. */
  readonly found: ReadonlyMap<string, number>
  /** Paths the run looked at and found missing. */
  readonly missing: ReadonlyMap<string, number>
  /** Directories the run listed. */
  readonly listed: ReadonlyMap<string, number>
  /** Names the run made: a directory, a link, a file that had to be new, the new name of a moved file. */
  readonly made: ReadonlyMap<string, number>
  /** Files the run emptied before it wrote them, through any link in the path. */
  readonly emptied: ReadonlyMap<string, number>
  /** Paths the run changed in place, removed or moved away. */
  readonly changed: ReadonlySet<string>
  /** Programs the run started. */
  readonly started: ReadonlyMap<string, number>
  /** Why what the run read cannot all be known, when it cannot. */
  readonly refusals: ReadonlyArray<string>
}

/** Decodes a quoted string as the tracer prints it; `undefined` when it is cut short or malformed. */
const unquote = (text: string): string | undefined => {
  if (!text.startsWith("\"") || !text.endsWith("\"") || text.length < 2) return undefined
  const bytes: Array<number> = []
  const body = text.slice(1, -1)
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!
    if (character !== "\\") {
      for (const byte of Buffer.from(character, "utf8")) bytes.push(byte)
      continue
    }
    index += 1
    const next = body[index]
    const simple = next === undefined ? undefined : escapes[next]
    if (simple !== undefined) {
      bytes.push(simple)
      continue
    }
    const hex = /^x([0-9a-fA-F]{2})/.exec(body.slice(index))
    if (hex !== null) {
      bytes.push(Number.parseInt(hex[1]!, 16))
      index += 2
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(index))
    if (octal === null) return undefined
    bytes.push(Number.parseInt(octal[0], 8) & 0xff)
    index += octal[0].length - 1
  }
  return Buffer.from(bytes).toString("utf8")
}

const escapes: { readonly [character: string]: number } = {
  "\"": 0x22,
  "\\": 0x5c,
  "n": 0x0a,
  "t": 0x09,
  "r": 0x0d,
  "v": 0x0b,
  "f": 0x0c,
  "a": 0x07,
  "b": 0x08,
  "e": 0x1b
}

/** Splits a call's arguments at the commas that are not inside a string, a structure or a descriptor's path. */
const split = (text: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (character === "\"") {
      for (index += 1; index < text.length && text[index] !== "\""; index += 1) {
        if (text[index] === "\\") index += 1
      }
    } else if (character === "<" && depth === 0 && /^(?:\d+|AT_FDCWD)$/.test(text.slice(start, index).trim())) {
      // A descriptor's path ends at the `>` that closes the argument.
      const close = /^>(?:,\s|$)/
      for (index += 1; index < text.length && !close.test(text.slice(index)); index += 1);
    } else if (character === "{" || character === "[" || character === "(") depth += 1
    else if (character === "}" || character === "]" || character === ")") depth -= 1
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index).trim())
      start = index + 1
    }
  }
  const last = text.slice(start).trim()
  if (last !== "" || parts.length > 0) parts.push(last)
  return parts
}

/** The path a descriptor argument names (`3</tmp/x>`), or `undefined` when the tracer printed none. */
const descriptorPath = (argument: string): string | undefined => {
  const match = /^(?:\d+|AT_FDCWD)<(.*)>$/s.exec(argument)
  if (match === null) return undefined
  const path = match[1]!
  return path.startsWith("/") ? path.replace(/ \(deleted\)$/, "") : undefined
}

/** One process's working directory. Threads that share it share the cell. */
interface Cell {
  path: string | undefined
}

const cloneCall = /^(\d+)\s+(?:(clone3?|v?fork)\(|<\.\.\. (clone3?|v?fork) resumed>)/

/** Whether an address a run connected or bound to is on this machine's loopback. */
const loopback = (address: string): boolean =>
  /inet_addr\("127\./.test(address) || /inet_pton\(AF_INET6, "(?:::1|::ffff:127\.[0-9.]+)"/.test(address)

const portOf = (address: string): string | undefined => /sin6?_port=htons\((\d+)\)/.exec(address)?.[1]

/**
 * Reads a trace. `lines` is called twice and gives the trace's lines each
 * time; `cwd` is the directory the traced command started in.
 *
 * A line the reader cannot follow becomes a refusal, never a guess: a path
 * cut short, a relative path whose directory is unknown, a call whose
 * arguments do not parse.
 *
 * @category tracing
 * @since 1.0.0
 */
export const read = (lines: () => Iterable<string>, cwd: string): Trace => {
  const found = new Map<string, number>()
  const missing = new Map<string, number>()
  const listed = new Map<string, number>()
  const made = new Map<string, number>()
  const emptied = new Map<string, number>()
  const changed = new Set<string>()
  const started = new Map<string, number>()
  const refusals = new Set<string>()
  const first = (map: Map<string, number>, path: string, at: number): void => {
    if (!map.has(path)) map.set(path, at)
  }

  // Which line starts each process, and whether it shares its parent's directory.
  const children = new Map<number, { readonly child: number; readonly shared: boolean }>()
  {
    const open = new Map<string, { readonly at: number; readonly text: string }>()
    let at = 0
    for (const line of lines()) {
      at += 1
      const match = cloneCall.exec(line)
      if (match === null) continue
      const pid = match[1]!
      const entered = match[2] !== undefined ? { at, text: line } : open.get(pid)
      if (line.endsWith("<unfinished ...>")) {
        open.set(pid, { at, text: line })
        continue
      }
      open.delete(pid)
      const child = /\)\s+= (\d+)$/.exec(line)
      if (entered === undefined || child === null) continue
      children.set(entered.at, {
        child: Number(child[1]),
        shared: /CLONE_FS|CLONE_THREAD/.test(entered.text) || /CLONE_FS|CLONE_THREAD/.test(line)
      })
    }
  }

  const cells = new Map<number, Cell>()
  const pending = new Map<number, { readonly at: number; readonly text: string }>()
  /** Unix socket paths and loopback ports the run itself listens on. */
  const bound = new Set<string>()
  let ephemeral = false
  let root: number | undefined
  let at = 0

  const handle = (pid: number, name: string, body: string, result: string | undefined, entered: number): void => {
    const cell = cells.get(pid)!
    const args = split(body)
    const failed = result !== undefined && result.startsWith("-1 ")
    const errno = failed ? result.split(" ")[1]! : undefined
    const gone = errno === "ENOENT" || errno === "ENOTDIR"
    const ok = result !== undefined && !failed && result !== "?"

    /** The absolute path an argument names from a directory, or `undefined` when it names none. */
    const pathOf = (argument: string | undefined, base: string | undefined): string | undefined => {
      if (argument === undefined || argument === "NULL") return undefined
      const text = unquote(argument)
      if (text === undefined) {
        refusals.add(`its trace holds a path that cannot be read: ${argument.slice(0, 80)}`)
        return undefined
      }
      if (text.startsWith("/")) return text
      // An empty path names the descriptor itself, which the run already opened.
      if (text === "") return base
      if (base === undefined) {
        refusals.add(`its trace does not say which directory ${JSON.stringify(text)} was read from`)
        return undefined
      }
      return `${base}/${text}`
    }
    /** The directory a descriptor argument stands for. */
    const baseOf = (argument: string | undefined): string | undefined => {
      if (argument === undefined) return undefined
      const named = descriptorPath(argument)
      if (argument.startsWith("AT_FDCWD")) {
        if (named !== undefined) cell.path = named
        return cell.path
      }
      return named
    }
    const looked = (path: string | undefined): void => {
      if (path === undefined) return
      if (gone) first(missing, path, entered)
      else first(found, path, entered)
    }
    /**
     * Notes a write. `creates` says the call would have made the name: when it
     * finds nothing, the directory the name goes in is what was missing.
     */
    const wrote = (path: string | undefined, how: "made" | "emptied" | "changed", creates = false): void => {
      if (path === undefined) return
      if (gone) {
        first(missing, path, entered)
        if (creates) first(missing, NodePath.posix.dirname(path), entered)
        return
      }
      if (failed) return first(found, path, entered)
      changed.add(path)
      if (ok && how !== "changed") first(how === "made" ? made : emptied, path, at)
    }

    switch (name) {
      case "open":
      case "openat":
      case "openat2":
      case "creat": {
        const at2 = name === "openat" || name === "openat2"
        const path = pathOf(args[at2 ? 1 : 0], at2 ? baseOf(args[0]) : cell.path)
        const flags = name === "creat" ? "O_WRONLY|O_CREAT|O_TRUNC" : args[at2 ? 2 : 1] ?? ""
        const creates = /O_CREAT/.test(flags)
        if (creates && /O_EXCL/.test(flags)) wrote(path, "made", true)
        else if (/O_TRUNC/.test(flags)) wrote(path, "emptied", creates)
        // Opened to write without reading: the run learns only that the path can be opened.
        else if (/O_WRONLY/.test(flags)) wrote(path, "changed", creates)
        else {
          looked(path)
          if (/O_RDWR/.test(flags)) wrote(path, "changed", creates)
        }
        return
      }
      case "stat":
      case "lstat":
      case "access":
      case "readlink":
      case "chdir":
      case "chroot": {
        const path = pathOf(args[0], cell.path)
        looked(path)
        if (name === "chdir" && ok) cell.path = path
        if (name === "chroot" && ok) refusals.add("it changed its root directory")
        return
      }
      case "newfstatat":
      case "statx":
      case "faccessat":
      case "faccessat2":
      case "readlinkat":
        return looked(pathOf(args[1], baseOf(args[0])))
      case "fchdir": {
        const path = baseOf(args[0])
        if (ok) cell.path = path
        return
      }
      case "getdents":
      case "getdents64": {
        const path = baseOf(args[0])
        if (path === undefined) refusals.add("its trace does not name a directory it listed")
        else first(listed, path, entered)
        return
      }
      case "execve":
      case "execveat": {
        const path = name === "execve" ? pathOf(args[0], cell.path) : pathOf(args[1], baseOf(args[0]))
        looked(path)
        if (path !== undefined && !failed) first(started, path, entered)
        return
      }
      case "unlink":
      case "rmdir":
      case "truncate":
      // A new mode, owner or time changes when the file last changed, as a write does.
      case "chmod":
      case "chown":
      case "lchown":
      case "utime":
      case "utimes":
        return wrote(pathOf(args[0], cell.path), "changed")
      case "unlinkat":
      case "fchmodat":
      case "fchmodat2":
      case "fchownat":
      case "futimesat":
        return wrote(pathOf(args[1], baseOf(args[0])), "changed")
      case "utimensat":
        // With no path, the descriptor itself is the file.
        return wrote(args[1] === "NULL" ? baseOf(args[0]) : pathOf(args[1], baseOf(args[0])), "changed")
      case "fchmod":
      case "fchown":
        return wrote(baseOf(args[0]), "changed")
      case "mkdir":
        return wrote(pathOf(args[0], cell.path), "made", true)
      case "mkdirat":
        return wrote(pathOf(args[1], baseOf(args[0])), "made", true)
      case "symlink":
        return wrote(pathOf(args[1], cell.path), "made", true)
      case "symlinkat":
        return wrote(pathOf(args[2], baseOf(args[1])), "made", true)
      case "rename":
      case "link": {
        // The new path holds what the old one held, so the old one was read.
        const from = pathOf(args[0], cell.path)
        looked(from)
        if (name === "rename") wrote(from, "changed")
        else if (from !== undefined && ok) changed.add(from)
        return wrote(pathOf(args[1], cell.path), "made")
      }
      case "renameat":
      case "renameat2":
      case "linkat": {
        const from = pathOf(args[1], baseOf(args[0]))
        looked(from)
        if (name === "linkat") {
          if (from !== undefined && ok) changed.add(from)
        } else wrote(from, "changed")
        return wrote(pathOf(args[3], baseOf(args[2])), "made")
      }
      case "bind":
      case "connect": {
        const address = args[1] ?? ""
        const family = /sa_family=(AF_[A-Z0-9_]+)/.exec(address)?.[1]
        const unix = /sun_path=(@?"(?:[^"\\]|\\.)*")/.exec(address)?.[1]
        const key = family === "AF_UNIX"
          ? unix === undefined ? undefined : `unix:${unix}`
          : family === "AF_INET" || family === "AF_INET6"
          ? `port:${portOf(address)}`
          : undefined
        if (name === "bind") {
          if (failed) return
          if (key === "port:0") ephemeral = true
          else if (key !== undefined) bound.add(key)
          return
        }
        // A connection that was refused or found nothing read nothing.
        if (failed && errno !== "EINPROGRESS") return
        if (family === "AF_UNIX") {
          if (key === undefined || !bound.has(key)) {
            refusals.add(`it reached a program outside the run through the socket ${unix ?? "it was given"}`)
          }
        } else if (family === "AF_INET" || family === "AF_INET6") {
          if (!loopback(address)) refusals.add("it opened a network connection")
          else if (!ephemeral && !bound.has(key!)) {
            refusals.add(`it reached a program outside the run on local port ${portOf(address)}`)
          }
        }
        return
      }
      case "mount":
      case "pivot_root":
      case "setns":
        if (ok) refusals.add("it changed its view of the file system")
        return
      case "io_uring_setup":
        if (ok) refusals.add("it read through io_uring, which a trace does not show")
        return
      default:
        return
    }
  }

  for (const line of lines()) {
    at += 1
    const match = /^(\d+)\s+(.*)$/s.exec(line)
    if (match === null) {
      if (line.trim() !== "") refusals.add(`its trace holds a line that cannot be read: ${line.slice(0, 80)}`)
      continue
    }
    const pid = Number(match[1])
    let rest = match[2]!
    if (root === undefined) {
      root = pid
      cells.set(pid, { path: cwd })
    }
    if (!cells.has(pid)) cells.set(pid, { path: undefined })
    if (rest.startsWith("+++") || rest.startsWith("---")) continue
    let entered = at
    const resumed = /^<\.\.\. (\w+) resumed>/.exec(rest)
    if (resumed !== null) {
      const open = pending.get(pid)
      pending.delete(pid)
      if (open === undefined) {
        refusals.add(`its trace resumes a call it never started: ${rest.slice(0, 80)}`)
        continue
      }
      entered = open.at
      rest = open.text + rest.slice(resumed[0].length)
    }
    const start = resumed === null ? children.get(at) : undefined
    if (start !== undefined) {
      const parent = cells.get(pid)!
      cells.set(start.child, start.shared ? parent : { path: parent.path })
    }
    if (rest.endsWith("<unfinished ...>")) {
      pending.set(pid, { at: entered, text: rest.slice(0, -"<unfinished ...>".length) })
      continue
    }
    // The answer follows the last `) = `, which the tracer pads to a column.
    const call = /^(\w+)\((.*)\)\s+= (.*)$/s.exec(rest)
    if (call === null) {
      refusals.add(`its trace holds a line that cannot be read: ${rest.slice(0, 80)}`)
      continue
    }
    handle(pid, call[1]!, call[2]!, call[3]!.trim(), entered)
  }
  // Every traced run starts a program, so a trace without a line is not a run's trace.
  if (root === undefined) refusals.add("its trace is empty")
  // A call cut off by the end of its process still happened, with an answer nobody saw.
  for (const [pid, open] of pending) {
    const paren = open.text.indexOf("(")
    if (paren > 0) handle(pid, open.text.slice(0, paren), open.text.slice(paren + 1), undefined, open.at)
  }
  return { found, missing, listed, made, emptied, changed, started, refusals: [...refusals] }
}

/**
 * The file-system reads a measurement makes; a test supplies a failing one.
 *
 * @category models
 * @since 1.0.0
 */
export interface Io {
  readonly lstat: (path: string) => NodeFs.Stats
  readonly readlink: (path: string) => string
  readonly readdir: (path: string) => ReadonlyArray<string>
  readonly readFile: (path: string) => Buffer
  /** The first `length` bytes of a file, or fewer when it is shorter. */
  readonly head: (path: string, length: number) => Buffer
}

/**
 * The host file system.
 *
 * @category constructors
 * @since 1.0.0
 */
export const defaultIo: Io = {
  lstat: (path) => NodeFs.lstatSync(path),
  readlink: (path) => NodeFs.readlinkSync(path),
  readdir: (path) => NodeFs.readdirSync(path),
  readFile: (path) => NodeFs.readFileSync(path),
  head: (path, length) => {
    const descriptor = NodeFs.openSync(path, "r")
    try {
      const block = Buffer.alloc(length)
      return block.subarray(0, NodeFs.readSync(descriptor, block, 0, length, 0))
    } finally {
      NodeFs.closeSync(descriptor)
    }
  }
}

const codeOf = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && typeof (cause as { readonly code?: unknown }).code === "string"
    ? (cause as { readonly code: string }).code
    : "EIO"

const absent = "-"

/**
 * What is at a path, as one comparable text: `-` when nothing is, `d` for a
 * directory, `l:<target>` for a symbolic link, `f:<digest>` for a file (with
 * `:x` when it can be executed), `o:<kind>` for anything else, and `!<code>`
 * when it cannot be read.
 *
 * @category measuring
 * @since 1.0.0
 */
export const measure = (path: string, io: Io = defaultIo): string => {
  try {
    const stats = io.lstat(path)
    if (stats.isSymbolicLink()) return `l:${io.readlink(path)}`
    if (stats.isDirectory()) return "d"
    if (!stats.isFile()) return `o:${stats.mode & NodeFs.constants.S_IFMT}`
    const digest = createHash("sha256").update(io.readFile(path)).digest("hex")
    return `f:${digest}${(stats.mode & 0o111) === 0 ? "" : ":x"}`
  } catch (cause) {
    const code = codeOf(cause)
    return code === "ENOENT" || code === "ENOTDIR" ? absent : `!${code}`
  }
}

/**
 * The names in a directory apart from `own`, as one digest; `undefined` when
 * the path is not a directory that can be listed.
 *
 * @category measuring
 * @since 1.0.0
 */
export const listing = (path: string, own: ReadonlyArray<string>, io: Io = defaultIo): string | undefined => {
  try {
    const skipped = new Set(own)
    const names = io.readdir(path).filter((name) => !skipped.has(name)).sort(byCodeUnit)
    return createHash("sha256").update(JSON.stringify(names)).digest("hex")
  } catch {
    return undefined
  }
}

/**
 * What one run read. A path inside the workspace is written from its root; a
 * path outside it is absolute.
 *
 * @category models
 * @since 1.0.0
 */
export interface Record {
  /** Each path with what the run left there, and `-` after it when the run found the path missing and made it. */
  readonly reads: ReadonlyArray<readonly [path: string, state: string] | readonly [string, string, string]>
  /** Each directory the run listed: its listing's digest, and the names the run itself added or removed. */
  readonly lists: ReadonlyArray<readonly [path: string, digest: string, own: ReadonlyArray<string>]>
}

const pseudo = (path: string): boolean => /^\/(?:proc|sys|dev)(?:\/|$)/.test(path)

const under = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`)

/**
 * Turns a trace into the record of what its run read, or says why the run
 * stores nothing.
 *
 * `root` is the workspace root and `ignore` holds absolute paths whose
 * subtrees are left out: the build's own cache, and what the declaration
 * says never decides the result. `startedMs` is when the run began, read as
 * the status-change time of a file made just before it: file times come from
 * the file system's clock, which trails the system clock by up to a tick, so
 * only another file's time compares with them. A path changed in the same
 * tick counts as changed during the run.
 *
 * @category recording
 * @since 1.0.0
 */
export const record = (
  trace: Trace,
  options: {
    readonly root: string
    readonly ignore: ReadonlyArray<string>
    readonly startedMs: number
    readonly io?: Io | undefined
  }
): Record | { readonly refusal: string } => {
  if (trace.refusals.length > 0) return { refusal: trace.refusals[0]! }
  const io = options.io ?? defaultIo
  const kinds = new Map<string, { readonly link: string | undefined; readonly directory: boolean } | undefined>()
  const kindOf = (path: string): { readonly link: string | undefined; readonly directory: boolean } | undefined => {
    if (kinds.has(path)) return kinds.get(path)
    let kind: { readonly link: string | undefined; readonly directory: boolean } | undefined
    try {
      const stats = io.lstat(path)
      kind = { link: stats.isSymbolicLink() ? io.readlink(path) : undefined, directory: stats.isDirectory() }
    } catch {
      kind = undefined
    }
    kinds.set(path, kind)
    return kind
  }

  interface Entry {
    readonly first: "found" | "missing" | "made"
    made: boolean
    changed: boolean
    listed: boolean
  }
  const entries = new Map<string, Entry>()
  const own = new Map<string, Set<string>>()
  let refusal: string | undefined
  const touch = (path: string, first: Entry["first"]): Entry => {
    const entry = entries.get(path)
    if (entry === undefined) {
      const created: Entry = { first, made: first === "made", changed: false, listed: false }
      entries.set(path, created)
      return created
    }
    // Events arrive in the order they happened, so the first one stays the first.
    if (first === "made") entry.made = true
    return entry
  }

  /**
   * The real path of a path as the run wrote it. Each symbolic link on the
   * way is something the run read, so it is noted as found.
   */
  const resolve = (path: string): string | undefined => {
    const queue = path.split("/").filter((part) => part !== "" && part !== ".")
    let current = ""
    let links = 0
    while (queue.length > 0) {
      const part = queue.shift()!
      if (part === "..") {
        current = current.slice(0, Math.max(0, current.lastIndexOf("/")))
        continue
      }
      const candidate = `${current}/${part}`
      const kind = kindOf(candidate)
      if (kind === undefined) {
        // Nothing is here, so nothing below it resolves any further.
        return NodePath.posix.normalize([candidate, ...queue].join("/"))
      }
      if (kind.link === undefined) {
        current = candidate
        continue
      }
      links += 1
      if (links > maximumLinks) {
        refusal ??= `${path} passes through too many symbolic links`
        return undefined
      }
      if (!pseudo(candidate)) touch(candidate, "found")
      const target = kind.link.split("/").filter((piece) => piece !== "" && piece !== ".")
      queue.unshift(...target)
      if (kind.link.startsWith("/")) current = ""
    }
    return current === "" ? "/" : current
  }

  const visible = (path: string): boolean =>
    !pseudo(path) && !options.ignore.some((directory) => under(path, directory))

  /** The real path of a name the run wrote: only what leads to the name is followed. */
  const named = (raw: string): string | undefined => {
    const parent = resolve(NodePath.posix.dirname(raw))
    if (parent === undefined) return undefined
    const name = NodePath.posix.basename(raw)
    return parent === "/" ? `/${name}` : `${parent}/${name}`
  }

  const events: Array<
    readonly [at: number, kind: "found" | "missing" | "made" | "emptied" | "listed", path: string]
  > = []
  for (const [path, at] of trace.found) events.push([at, "found", path])
  for (const [path, at] of trace.missing) events.push([at, "missing", path])
  for (const [path, at] of trace.made) events.push([at, "made", path])
  for (const [path, at] of trace.emptied) events.push([at, "emptied", path])
  for (const [path, at] of trace.listed) events.push([at, "listed", path])
  // A program a run starts can name another that the kernel starts for it.
  for (const [path, at] of trace.started) {
    for (const interpreter of interpreters(path, io)) events.push([at, "found", interpreter])
  }
  events.sort((left, right) => left[0] - right[0])
  for (const [, kind, raw] of events) {
    if (pseudo(raw)) continue
    const path = kind === "made" ? named(raw) : resolve(raw)
    if (path === undefined || !visible(path)) continue
    if (kind === "listed") {
      const entry = touch(path, "found")
      if (!entry.made) entry.listed = true
      continue
    }
    touch(path, kind === "emptied" ? "made" : kind)
  }
  for (const raw of trace.changed) {
    if (pseudo(raw)) continue
    // Both the name the run wrote and the file a link under that name leads to are the run's to change.
    const path = named(raw)
    if (path === undefined) continue
    for (const written of new Set([path, resolve(raw) ?? path])) {
      const entry = entries.get(written)
      if (entry !== undefined) entry.changed = true
    }
    const parent = NodePath.posix.dirname(path)
    let names = own.get(parent)
    if (names === undefined) own.set(parent, names = new Set())
    names.add(NodePath.posix.basename(path))
  }
  if (refusal !== undefined) return { refusal }

  const inside = (path: string): string =>
    path === options.root ? "." : under(path, options.root) ? path.slice(options.root.length + 1) : path
  /** Whether somebody changed a path after the run began. */
  const moved = (path: string): boolean => io.lstat(path).ctimeMs >= options.startedMs
  const reads: Array<readonly [string, string] | readonly [string, string, string]> = []
  const lists: Array<readonly [string, string, ReadonlyArray<string>]> = []
  for (const path of [...entries.keys()].sort(byCodeUnit)) {
    const entry = entries.get(path)!
    if (!visible(path) || entry.first === "made") continue
    const state = measure(path, io)
    if (entry.first === "missing") {
      reads.push(state !== absent && entry.made ? [inside(path), state, absent] : [inside(path), absent])
      continue
    }
    if (!entry.changed) {
      if (state === absent) return { refusal: `${inside(path)} was removed while it ran` }
      if (state !== "d" && moved(path)) return { refusal: `${inside(path)} changed while it ran` }
    }
    reads.push([inside(path), state])
    if (!entry.listed) continue
    const names = [...(own.get(path) ?? [])].sort(byCodeUnit)
    const digest = listing(path, names, io)
    if (digest === undefined) continue
    if (names.length === 0 && moved(path)) return { refusal: `${inside(path)} changed while it ran` }
    lists.push([inside(path), digest, names])
  }
  return { reads, lists }
}

/**
 * The programs the kernel starts in order to start `path`: the interpreter a
 * script's first line names, and the loader a dynamically linked program
 * names. Neither is opened by a system call, so no trace shows them.
 */
const interpreters = (path: string, io: Io): ReadonlyArray<string> => {
  const named: Array<string> = []
  let current = path
  for (let depth = 0; depth < 4; depth += 1) {
    let head: Buffer
    try {
      head = io.head(current, 64 * 1024)
    } catch {
      break
    }
    let next: string | undefined
    if (head[0] === 0x23 && head[1] === 0x21) {
      next = /^#!\s*(\S+)/.exec(head.subarray(0, 512).toString("latin1"))?.[1]
    } else if (head.length > 64 && head.readUInt32BE(0) === 0x7f454c46 && head[4] === 2 && head[5] === 1) {
      // A 64-bit little-endian ELF file: find the program header that names the loader.
      const offset = Number(head.readBigUInt64LE(0x20))
      const size = head.readUInt16LE(0x36)
      const count = head.readUInt16LE(0x38)
      for (let index = 0; index < count && offset + (index + 1) * size <= head.length; index += 1) {
        const header = offset + index * size
        if (head.readUInt32LE(header) !== 3) continue
        const from = Number(head.readBigUInt64LE(header + 8))
        const length = Number(head.readBigUInt64LE(header + 0x20))
        if (from + length <= head.length) {
          next = head.subarray(from, from + length).toString("latin1").replace(/\0+$/, "")
        }
        break
      }
    }
    if (next === undefined || !next.startsWith("/") || named.includes(next)) break
    named.push(next)
    current = next
  }
  return named
}

/**
 * Says what a record's run read that is no longer the same, or `undefined`
 * when every path it read still holds what the run left there.
 *
 * @category recording
 * @since 1.0.0
 */
export const changed = (
  stored: Record,
  root: string,
  measured: (path: string) => string = measure,
  io: Io = defaultIo
): string | undefined => {
  const absolute = (path: string): string => path === "." ? root : path.startsWith("/") ? path : `${root}/${path}`
  for (const [path, state, other] of stored.reads) {
    const now = measured(absolute(path))
    if (now === state || now === other) continue
    if (now === absent) return `${path} is gone`
    return state === absent ? `${path} now exists` : `${path} changed`
  }
  for (const [path, digest, own] of stored.lists) {
    if (listing(absolute(path), own, io) !== digest) return `${path} gained or lost an entry`
  }
  return undefined
}

/**
 * A measurement that remembers a file's digest while its size, times and
 * inode stay the same, the trust Git's index places in the same fields. A
 * file changed less than two seconds ago is always read again.
 *
 * @category measuring
 * @since 1.0.0
 */
export const remembering = (io: Io = defaultIo, now: () => number = Date.now): (path: string) => string => {
  const memory = new Map<string, readonly [fingerprint: string, state: string]>()
  return (path) => {
    let fingerprint: string | undefined
    try {
      const stats = io.lstat(path)
      if (stats.isFile() && now() - stats.ctimeMs > 2000) {
        fingerprint = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}:${stats.mode}`
      }
    } catch {
      fingerprint = undefined
    }
    const known = memory.get(path)
    if (fingerprint !== undefined && known !== undefined && known[0] === fingerprint) return known[1]
    const state = measure(path, io)
    if (fingerprint === undefined) memory.delete(path)
    else memory.set(path, [fingerprint, state])
    return state
  }
}

/**
 * The absolute paths whose subtrees a record leaves out: the build's cache
 * directory and each path a declaration names. `~` stands for `home`, and a
 * relative path is read from the workspace root.
 *
 * @category recording
 * @since 1.0.0
 */
export const ignored = (
  root: string,
  home: string,
  cacheDirectory: string,
  declared: ReadonlyArray<string>
): ReadonlyArray<string> =>
  [cacheDirectory, ...declared].map((entry) => {
    const path = entry === "~" || entry.startsWith("~/")
      ? NodePath.join(home, entry.slice(1))
      : NodePath.resolve(root, entry)
    try {
      return NodeFs.realpathSync(path)
    } catch {
      return path
    }
  })

/** The tag of a stored set of records. */
const kind = "observed"

/**
 * The stored form of a declaration's records.
 *
 * @category results
 * @since 1.0.0
 */
export interface Stored {
  readonly kind: "observed"
  readonly format: string
  readonly records: ReadonlyArray<Record>
}

const isRecord = (value: unknown): value is Record => {
  if (typeof value !== "object" || value === null) return false
  const { lists, reads } = value as { readonly lists?: unknown; readonly reads?: unknown }
  return Array.isArray(reads) && Array.isArray(lists) &&
    reads.every((row) =>
      Array.isArray(row) && (row.length === 2 || row.length === 3) && row.every((part) => typeof part === "string")
    ) &&
    lists.every((row) =>
      Array.isArray(row) && row.length === 3 && typeof row[0] === "string" && typeof row[1] === "string" &&
      Array.isArray(row[2]) && row[2].every((name) => typeof name === "string")
    )
}

/**
 * Decodes stored records; any other shape, or another format, is none.
 *
 * @category results
 * @since 1.0.0
 */
export const decode = (output: unknown): ReadonlyArray<Record> => {
  if (typeof output !== "object" || output === null) return []
  const value = output as { readonly kind?: unknown; readonly format?: unknown; readonly records?: unknown }
  if (value.kind !== kind || value.format !== format || !Array.isArray(value.records)) return []
  return value.records.every(isRecord) ? value.records : []
}

/**
 * Puts a new record in front of the stored ones and keeps the newest that
 * fit {@link maximumRecords} and {@link maximumBytes}. `undefined` when the
 * new record alone is too large to store.
 *
 * @category results
 * @since 1.0.0
 */
export const store = (added: Record, earlier: ReadonlyArray<Record>): Stored | undefined => {
  const records: Array<Record> = []
  let bytes = 0
  for (const candidate of [added, ...earlier].slice(0, maximumRecords)) {
    bytes += Buffer.byteLength(JSON.stringify(candidate))
    if (bytes > maximumBytes) break
    records.push(candidate)
  }
  return records.length === 0 ? undefined : { kind, format, records }
}

/**
 * The lines of a trace file, read a block at a time so a large trace is
 * never held whole.
 *
 * @category tracing
 * @since 1.0.0
 */
export const linesOf = (file: string): () => Iterable<string> =>
  function*() {
    const descriptor = NodeFs.openSync(file, "r")
    try {
      const block = Buffer.allocUnsafe(1024 * 1024)
      let rest = Buffer.alloc(0)
      for (;;) {
        const count = NodeFs.readSync(descriptor, block, 0, block.length, null)
        if (count === 0) break
        let data = Buffer.concat([rest, block.subarray(0, count)])
        for (;;) {
          const end = data.indexOf(0x0a)
          if (end < 0) break
          yield data.subarray(0, end).toString("utf8")
          data = data.subarray(end + 1)
        }
        rest = Buffer.from(data)
      }
      if (rest.length > 0) yield rest.toString("utf8")
    } finally {
      NodeFs.closeSync(descriptor)
    }
  }
