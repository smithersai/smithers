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
 * A run can also read what a step it depends on wrote: an install leaves a
 * tree, a build leaves its products. Such a path is recorded with the step it
 * came from. It matches when it still holds what the run read there, or when
 * it is missing and that step is itself answered from the record this run read
 * it under: the step would write it again as it was. So a job whose every
 * step reads what it read before is answered whole, and no step of it runs.
 *
 * One kind of network connection does not stop a result from being stored:
 * that of a package manager told to install exactly what a lockfile pins
 * (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync --locked`), and of the
 * processes it starts. What it fetches is fixed by a file the run read.
 *
 * A run is also given variables of the host whose values differ from one
 * run to the next, such as the commit a CI run is for. No trace shows a
 * process reading its environment: every shell copies all of it when it
 * starts, and so does the call that starts a program. So a record holds a
 * variable's value when the run shows it could have used it: the variable's
 * name is in the command's text or in a file of the workspace the run read
 * that git does not ignore, or its value is in what the run printed, in a
 * file it wrote and left, or in the arguments of a program it started. A
 * record answers a later run only while each of those variables holds the
 * same value.
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
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { byCodeUnit } from "./Text.ts"

/**
 * The format tag of a stored set of records; any other tag is ignored.
 *
 * @category constants
 * @since 1.0.0
 */
export const format = "smthrs-observed-reads/2"

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
  /** Paths the run removed or moved away. */
  readonly removed: ReadonlySet<string>
  /** Paths written by a package manager installing what a lockfile pins, or by a process it started. */
  readonly fetched: ReadonlySet<string>
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

/** The words of a command line a tracer printed as `["npm", "ci"]`; `undefined` when it is cut short. */
const wordsOf = (text: string | undefined): ReadonlyArray<string> | undefined => {
  if (text === undefined || !text.startsWith("[") || !text.endsWith("]")) return undefined
  const words: Array<string> = []
  for (const part of split(text.slice(1, -1))) {
    const word = unquote(part)
    if (word === undefined) return undefined
    words.push(word)
  }
  return words
}

/** Programs that run the program their arguments name: `node /usr/lib/node_modules/npm/bin/npm-cli.js ci`. */
const runners = /^(?:env|node|nodejs|corepack|python[0-9.]*)$/

/**
 * Whether a command line is a package manager told to install exactly what a
 * lockfile pins, and to fail when it cannot. What such an install fetches is
 * fixed by the lockfile, which the run reads, so a connection it opens does
 * not make its result depend on the network's answer.
 *
 * @category tracing
 * @since 1.0.0
 */
export const lockedInstall = (argv: ReadonlyArray<string>): boolean => {
  const names = argv.map((word) =>
    word.slice(word.lastIndexOf("/") + 1).replace(/\.(?:[cm]?js|exe)$/, "").replace(/-cli$/, "")
  )
  let at = 0
  while (at < names.length - 1 && runners.test(names[at]!)) at += names[at + 1] === "-m" ? 2 : 1
  const rest = argv.slice(at + 1)
  const words = rest.filter((word) => !word.startsWith("-"))
  const has = (...flags: ReadonlyArray<string>): boolean => flags.some((flag) => rest.includes(flag))
  const installs = words[0] === "install" || words[0] === "i"
  switch (names[at]) {
    case "npm":
      return ["ci", "clean-install", "install-clean", "ic"].includes(words[0]!)
    case "pnpm":
    case "bun":
      return words[0] === "ci" || (installs && has("--frozen-lockfile"))
    case "yarn":
    case "yarnpkg":
      return (installs || words.length === 0) && has("--frozen-lockfile", "--immutable")
    case "uv":
      // `uv run` passes every flag after the command's name on to the command, so its own comes first.
      return (words[0] === "sync" && has("--locked", "--frozen")) ||
        (rest[0] === "run" && (rest[1] === "--locked" || rest[1] === "--frozen"))
    case "pip":
    case "pip3":
      return words[0] === "install" && has("--require-hashes")
    case "go":
      return words[0] === "mod" && words[1] === "download"
    case "cargo":
      return words[0] === "fetch" && has("--locked", "--frozen")
    case "deno":
      return words[0] === "install" && has("--frozen")
    default:
      return false
  }
}

/** One process's working directory. Threads that share it share the cell. */
interface Cell {
  path: string | undefined
}

const cloneCall = /^(\d+)\s+(?:(clone3?|v?fork)\(|<\.\.\. (clone3?|v?fork) resumed>)/

/** An argument the tracer printed as an address. */
const address = /^0x[0-9a-f]+$/

/** What the tracer ends a line with when a thread ends in the middle of the line. */
const detachedMark = "<detached ...>"

/** The answers a call that starts a program can have: it started, or it did not and the answer names why. */
const startAnswer = /^(?:0|-1 E[A-Z0-9]+\b.*)$/

/** Whether an address a run connected or bound to is on this machine's loopback. */
const loopback = (address: string): boolean =>
  /inet_addr\("127\./.test(address) || /inet_pton\(AF_INET6, "(?:::1|::ffff:127\.[0-9.]+)"/.test(address)

const portOf = (address: string): string | undefined => /sin6?_port=htons\((\d+)\)/.exec(address)?.[1]

/** Which program reached which address, for the line that says why a run stores nothing. */
const reached = (program: string | undefined, address: string): string => {
  const host = /inet_addr\("([^"]+)"\)/.exec(address)?.[1] ?? /inet_pton\(AF_INET6, "([^"]+)"/.exec(address)?.[1]
  const port = portOf(address)
  const where = `${host ?? "an address the trace does not show"}${port === undefined ? "" : ` port ${port}`}`
  return `${program === undefined ? "" : `${program} `}to ${where}`
}

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
  /** The paths the run wrote, by the directory each is in. */
  const below = new Map<string, Set<string>>()
  const write = (path: string): void => {
    changed.add(path)
    const parent = path.slice(0, path.lastIndexOf("/"))
    let paths = below.get(parent)
    if (paths === undefined) below.set(parent, paths = new Set())
    paths.add(path)
  }
  /**
   * A directory the run moved takes along what the run wrote in it: each such
   * path is the run's own under its new name too, made there when the run
   * made it under the old one.
   */
  const carry = (from: string, to: string, at: number): void => {
    const moves: Array<readonly [string, string]> = [[from, to]]
    for (let index = 0; index < moves.length; index += 1) {
      const [source, target] = moves[index]!
      for (const path of [...(below.get(source) ?? [])]) {
        const moved = `${target}${path.slice(source.length)}`
        write(moved)
        if (fetched.has(path)) fetched.add(moved)
        if (made.has(path)) first(made, moved, at)
        if (emptied.has(path)) first(emptied, moved, at)
        moves.push([path, moved])
      }
    }
  }
  /** Where the first call that found each path ended, where `found` holds where it began. */
  const ended = new Map<string, number>()
  /** Where the call began that made each name the run made where nothing was: a directory, a link, a new file. */
  const began = new Map<string, number>()
  /** Names the run removed or moved away. */
  const removed = new Set<string>()
  /** The calls that take a name away. */
  const removers = new Set(["unlink", "unlinkat", "rmdir", "rename", "renameat", "renameat2"])
  /** The program each process is running, by the name it was started under. */
  const programs = new Map<number, string>()
  let networked = false
  /** Processes that are a locked install now, and the processes started under one. */
  const installing = new Set<number>()
  const installed = new Set<number>()
  /** What those processes wrote. */
  const fetched = new Set<string>()

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
    // An answer that starts with `?` is no answer: the thread ended inside the call.
    const ok = result !== undefined && !failed && !result.startsWith("?")

    /** The absolute path an argument names from a directory, or `undefined` when it names none. */
    const pathOf = (argument: string | undefined, base: string | undefined): string | undefined => {
      if (argument === undefined || argument === "NULL") return undefined
      const text = unquote(argument)
      if (text === undefined) {
        // An address where a path belongs: the tracer could not read the path from the thread. Either the thread
        // was killed where it stopped before the call, or the address is no memory of the process and the call
        // failed on it. Neither opened a file. A call that succeeded on such a path did read something.
        if (address.test(argument) && !ok) return undefined
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
    const saw = (path: string): void => {
      if (!found.has(path)) ended.set(path, at)
      first(found, path, entered)
    }
    const looked = (path: string | undefined): void => {
      if (path === undefined) return
      if (gone) first(missing, path, entered)
      else saw(path)
    }
    /**
     * Notes a write. `creates` says the call would have made the name: when it
     * finds nothing, the directory the name goes in is what was missing.
     */
    const wrote = (
      path: string | undefined,
      how: "made" | "emptied" | "changed",
      creates = false,
      fresh = how === "made"
    ): void => {
      if (path === undefined) return
      if (gone) {
        first(missing, path, entered)
        if (creates) first(missing, NodePath.posix.dirname(path), entered)
        return
      }
      if (failed) return saw(path)
      write(path)
      if (installing.has(pid) || installed.has(pid)) fetched.add(path)
      if (!ok) return
      if (how !== "changed") first(how === "made" ? made : emptied, path, at)
      // A call that only succeeds where nothing was says so: the name was not there when it began.
      if (fresh) first(began, path, entered)
      // A name the run found missing and then opened to write, making it if need be, is one the run made.
      else if (creates && how === "changed" && missing.has(path)) first(made, path, at)
      if (how === "changed" && removers.has(name)) removed.add(path)
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
        // Any other answer is not this call's. The tracer lost its place, as it does when a thread other than
        // the first starts a program, and the first call the new program made is then in no line.
        if (result !== undefined && !result.startsWith("?") && !startAnswer.test(result)) {
          refusals.add(`the tracer lost its place when a thread started ${path ?? "a program"}`)
        }
        if (path !== undefined && !failed) {
          first(started, path, entered)
          programs.set(pid, path.slice(path.lastIndexOf("/") + 1))
          // A process that goes on to run another program is that program from here on.
          const words = ok ? wordsOf(args[name === "execve" ? 1 : 2]) : undefined
          if (words !== undefined && lockedInstall(words)) installing.add(pid)
          else installing.delete(pid)
        }
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
        const to = pathOf(args[1], cell.path)
        looked(from)
        if (name === "rename") wrote(from, "changed")
        else if (from !== undefined && ok) write(from)
        wrote(to, "made", false, name === "link")
        if (name === "rename" && ok && from !== undefined && to !== undefined && from !== to) carry(from, to, at)
        return
      }
      case "renameat":
      case "renameat2":
      case "linkat": {
        const from = pathOf(args[1], baseOf(args[0]))
        const to = pathOf(args[3], baseOf(args[2]))
        looked(from)
        if (name === "linkat") {
          if (from !== undefined && ok) write(from)
        } else wrote(from, "changed")
        wrote(to, "made", false, name === "linkat")
        if (name !== "linkat" && ok && from !== undefined && to !== undefined && from !== to) carry(from, to, at)
        return
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
        // What a locked install fetches, and whom it asks for an address, is fixed by the lockfile it read.
        if (installing.has(pid) || installed.has(pid)) return
        if (family === "AF_UNIX") {
          if (key === undefined || !bound.has(key)) {
            refusals.add(`it reached a program outside the run through the socket ${unix ?? "it was given"}`)
          }
        } else if (family === "AF_INET" || family === "AF_INET6") {
          if (!loopback(address)) {
            // The first connection is named; a run that opened one usually opened many.
            if (!networked) refusals.add(`it opened a network connection (${reached(programs.get(pid), address)})`)
            networked = true
          } else if (!ephemeral && !bound.has(key!)) {
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

  /** A call cut off by the end of its thread still happened, with an answer nobody saw. */
  const cutOff = (pid: number, open: { readonly at: number; readonly text: string }): void => {
    const paren = open.text.indexOf("(")
    if (paren > 0) handle(pid, open.text.slice(0, paren), open.text.slice(paren + 1), undefined, open.at)
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
    const superseded = /^\+\+\+ superseded by execve in pid (\d+) \+\+\+$/.exec(rest)
    if (superseded !== null) {
      // A thread that starts a program becomes the process, and the tracer names it by the process from here on:
      // the call that starts the program is answered under that name. A call the first thread was in is cut off.
      const thread = Number(superseded[1])
      const own = pending.get(pid)
      if (own !== undefined) cutOff(pid, own)
      const starting = pending.get(thread)
      pending.delete(thread)
      if (starting === undefined) pending.delete(pid)
      else pending.set(pid, starting)
      continue
    }
    if (rest.startsWith("+++") || rest.startsWith("---")) continue
    // The tracer writes `???` for a call it could not ask the thread about: the thread was killed where it stopped
    // before the call, by a thread that ended the process or started another program. The call never ran.
    if (rest.startsWith("???(") || rest.startsWith("<... ??? resumed>")) {
      pending.delete(pid)
      continue
    }
    // A thread that ended in the middle of its line: the call began, and nobody saw the answer.
    const detached = rest.endsWith(detachedMark)
    if (detached) rest = rest.slice(0, -detachedMark.length)
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
      // A process id comes round again. A call its last holder never finished was cut off when that one ended.
      const unfinished = pending.get(start.child)
      if (unfinished !== undefined) {
        pending.delete(start.child)
        cutOff(start.child, unfinished)
      }
      const parent = cells.get(pid)!
      cells.set(start.child, start.shared ? parent : { path: parent.path })
      const program = programs.get(pid)
      if (program !== undefined) programs.set(start.child, program)
      if (installing.has(pid) || installed.has(pid)) installed.add(start.child)
    }
    if (detached) {
      cutOff(pid, { at: entered, text: rest })
      continue
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
  // Calls of two threads overlap in a trace, and a call is placed where it began. A name the run made where
  // nothing was cannot have been found before it was made: a call that found it, and ended after the making
  // began, came after the making, so the name is the run's own and not something it read.
  for (const [path, start] of began) {
    const looked = found.get(path)
    if (looked === undefined || removed.has(path)) continue
    if (looked < made.get(path)! && ended.get(path)! > start) found.delete(path)
  }
  // Every traced run starts a program, so a trace without a line is not a run's trace.
  if (root === undefined) refusals.add("its trace is empty")
  for (const [pid, open] of pending) cutOff(pid, open)
  return { found, missing, listed, made, emptied, changed, started, removed, fetched, refusals: [...refusals] }
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
  /**
   * Each directory the run listed: its listing's digest, the names the run
   * itself added or removed, and the names a step in `from` wrote there, each
   * with that step's place in `from`. The digest leaves both sets of names out.
   */
  readonly lists: ReadonlyArray<
    | readonly [path: string, digest: string, own: ReadonlyArray<string>]
    | readonly [string, string, ReadonlyArray<string>, ReadonlyArray<readonly [name: string, from: number]>]
  >
  /** The steps the run depends on whose files it read: each one's label, and the id of the record its run stored. */
  readonly from?: ReadonlyArray<readonly [label: string, id: string]>
  /** Each path a step in `from` wrote that the run read: what was there, and that step's place in `from`. */
  readonly given?: ReadonlyArray<readonly [path: string, state: string, from: number]>
  /** Set when the run left something behind that it wrote: a file, a directory or a link. */
  readonly left?: true
  /**
   * Set when what the run left in the workspace and in the temporary
   * directory is kept beside the record, to be put back in place of running
   * the step again. `outside` holds what it left anywhere else, with what was
   * there: the kept files stand for the run only while each of those is
   * unchanged. `gone` holds the paths the run removed. `archive` names the
   * kept files: the id the record had when they were kept.
   */
  readonly kept?: {
    readonly archive: string
    readonly outside: ReadonlyArray<readonly [path: string, state: string]>
    readonly gone: ReadonlyArray<string>
  }
  /**
   * Each variable of the host the run could have used, with a digest of the
   * value it held, or `-` when the host did not set it. See {@link Variables}.
   */
  readonly variables?: ReadonlyArray<readonly [name: string, held: string]>
  /** Names this record among the records of its declaration: a digest of everything above. */
  readonly id?: string
}

/**
 * A step that ran before a run, and that the run depends on: its label, the
 * id of the record its run stored, and the absolute paths it wrote. `made`
 * holds the names it made, so everything under a directory in it is its own.
 *
 * @category models
 * @since 1.0.0
 */
export interface Producer {
  readonly label: string
  readonly id: string
  readonly made: ReadonlySet<string>
  readonly touched: ReadonlySet<string>
}

/**
 * What a run did to the file system: the record of what it read, and the
 * absolute paths it wrote, for the runs after it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Observation {
  readonly record: Record
  readonly made: ReadonlySet<string>
  readonly touched: ReadonlySet<string>
  /** What the run left behind, when it left anything: what to keep of it, or why it cannot be kept. */
  readonly left?: Left | { readonly refusal: string }
}

/**
 * What a run left behind, sorted so that a directory comes before what it
 * holds. `keep` is every file, directory and link it wrote that is still
 * there, in the workspace (written from its root) or under a temporary
 * directory (absolute). `gone` is every path in those places it removed.
 * `outside` is what it wrote anywhere else and left there, with what is
 * there now, apart from what a locked install fetched: a package manager's
 * own cache, which it fills again when a file is missing.
 *
 * @category models
 * @since 1.0.0
 */
export interface Left {
  readonly keep: ReadonlyArray<string>
  readonly gone: ReadonlyArray<string>
  readonly outside: ReadonlyArray<readonly [path: string, state: string]>
}

/**
 * The most paths kept for one run, the most bytes in them, and the most
 * paths a run may leave outside the workspace and still be kept.
 *
 * @category constants
 * @since 1.0.0
 */
export const keptLimits: { readonly paths: number; readonly bytes: number; readonly outside: number } = {
  paths: 300_000,
  bytes: 2 * 1024 * 1024 * 1024,
  outside: 2_000
}

/**
 * The id of a record: a digest of what it holds.
 *
 * @category results
 * @since 1.0.0
 */
export const idOf = (record: Omit<Record, "id">): string =>
  createHash("sha256")
    .update(JSON.stringify([
      record.reads,
      record.lists,
      record.from ?? [],
      record.given ?? [],
      record.left ?? false,
      // A record with no variable keeps the id it had before records held any.
      ...(record.variables === undefined ? [] : [record.variables])
    ]))
    .digest("hex")

/**
 * The host variables a run was given without their values entering its key,
 * and what besides the trace shows it used one.
 *
 * - `values`: each variable's name with the value the run was given, or
 *   `undefined` when the host does not set it.
 * - `text`: the command's own text. A name written in it is the run reading
 *   the variable.
 * - `shown`: the names whose values the run printed or passed to a program
 *   it started ({@link listening}).
 * - `ignored`: which of some absolute paths git leaves out of the workspace;
 *   {@link ignoredByGit} unless a test gives another.
 *
 * @category models
 * @since 1.0.0
 */
export interface Variables {
  readonly values: Readonly<{ readonly [name: string]: string | undefined }>
  readonly text: string
  readonly shown?: ReadonlySet<string> | undefined
  readonly ignored?: ((paths: ReadonlyArray<string>) => ReadonlySet<string>) | undefined
}

/**
 * A variable's value as a record holds it: a digest, so a record never
 * shows a value, or `-` for a variable that is not set.
 *
 * @category measuring
 * @since 1.0.0
 */
export const heldAs = (value: string | undefined): string =>
  value === undefined ? absent : createHash("sha256").update(value).digest("hex")

/**
 * The fewest characters of a value that are looked for in what a run
 * produced. A shorter value, such as `1` or `main`, is in every output by
 * chance, so only its name shows a run used it.
 *
 * @category constants
 * @since 1.0.0
 */
export const minimumValueLength = 6

/** A commit id, or another id written the same way. */
const hexId = /^[0-9a-f]{40,}$/

const hexDigit = (character: string | undefined): boolean => character !== undefined && /[0-9a-f]/.test(character)

/**
 * Whether a text holds a variable's value: the whole value, or the first
 * seven characters of a hexadecimal id of forty or more, the short form a
 * commit is written in, where no other hexadecimal digit touches them. A
 * value shorter than {@link minimumValueLength} is never looked for.
 *
 * @category recording
 * @since 1.0.0
 */
export const holdsValue = (text: string, value: string): boolean => {
  if (value.length < minimumValueLength) return false
  if (text.includes(value)) return true
  if (!hexId.test(value)) return false
  const short = value.slice(0, 7)
  for (let at = text.indexOf(short); at >= 0; at = text.indexOf(short, at + 1)) {
    if (!hexDigit(text[at - 1]) && !hexDigit(text[at + short.length])) return true
  }
  return false
}

/**
 * Whether a text holds a variable's name, as most files write it or as a
 * file of two-byte characters does.
 *
 * @category recording
 * @since 1.0.0
 */
export const holdsName = (text: string, name: string): boolean =>
  text.includes(name) || text.includes([...name].join("\0"))

/**
 * Listens to what a run prints and to the lines of its trace, and collects
 * the names of the variables whose values go by. `hear` takes what the run
 * wrote to its output, a block at a time: a value cut in two by the end of a
 * block is still found. `lines` gives a trace's lines back as they are, and
 * looks for the values in each line that starts a program, where the
 * program's arguments are.
 *
 * @category recording
 * @since 1.0.0
 */
export const listening = (
  values: Variables["values"]
): {
  readonly names: ReadonlySet<string>
  readonly hear: (block: Uint8Array) => void
  readonly lines: (trace: () => Iterable<string>) => () => Iterable<string>
} => {
  const sought = Object.entries(values).flatMap(([name, value]) =>
    value === undefined || value.length < minimumValueLength ? [] : [[name, value] as const]
  )
  const longest = Math.max(0, ...sought.map(([, value]) => value.length))
  const names = new Set<string>()
  const look = (text: string): void => {
    for (const [name, value] of sought) {
      if (!names.has(name) && holdsValue(text, value)) names.add(name)
    }
  }
  let rest = ""
  return {
    names,
    hear: (block) => {
      if (sought.length === 0) return
      const text = rest + Buffer.from(block.buffer, block.byteOffset, block.byteLength).toString("latin1")
      look(text)
      // Enough of the end to hold a value cut in two, and the character before it.
      rest = text.slice(-longest)
    },
    lines: (trace) =>
      function*() {
        for (const line of trace()) {
          if (sought.length > names.size && line.includes("execve")) look(line)
          yield line
        }
      }
  }
}

/**
 * Asks git which of some absolute paths it leaves out of the workspace at
 * `root`: what `.gitignore` names, such as installed packages and build
 * products. Every other path is the workspace's own. Where git cannot say,
 * because the workspace is no repository or git is not there, none is left
 * out.
 *
 * @category recording
 * @since 1.0.0
 */
export const ignoredByGit = (root: string) => (paths: ReadonlyArray<string>): ReadonlySet<string> => {
  const asked = spawnSync("git", ["-C", root, "check-ignore", "-z", "--stdin"], {
    encoding: "utf8",
    input: paths.map((path) => `${path}\0`).join(""),
    maxBuffer: 64 * 1024 * 1024
  })
  return new Set(asked.status === 0 ? asked.stdout.split("\0").filter((path) => path !== "") : [])
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
 * `producers` are the steps the run depends on that ran before it, in the
 * order they ran. A path one of them wrote is recorded in `given` with that
 * step, and the last one to write a path is the one it came from.
 *
 * @category recording
 * @since 1.0.0
 */
export const observe = (
  trace: Trace,
  options: {
    readonly root: string
    readonly ignore: ReadonlyArray<string>
    readonly startedMs: number
    readonly io?: Io | undefined
    readonly producers?: ReadonlyArray<Producer> | undefined
    /** The temporary directories, by their real paths: what a run left there is kept with what it left in the workspace. */
    readonly temporary?: ReadonlyArray<string> | undefined
    /** The limits on what is kept; {@link keptLimits} unless a test gives smaller ones. */
    readonly limits?: typeof keptLimits | undefined
    /** The host variables the run was given, whose values are in the record only when the run could have used them. */
    readonly variables?: Variables | undefined
  }
): Observation | { readonly refusal: string } => {
  if (trace.refusals.length > 0) return { refusal: trace.refusals[0]! }
  const io = options.io ?? defaultIo
  const variables = options.variables
  const variableNames = Object.keys(variables?.values ?? {}).sort(byCodeUnit)
  /** The files of the workspace the run read that hold each variable's name. */
  const naming = new Map<string, Array<string>>()
  /** Measures a path, and looks for the variables' names in a file of the workspace as it is read. */
  const measured = (path: string): string =>
    variableNames.length === 0 || !under(path, options.root) ? measure(path, io) : measure(path, {
      ...io,
      readFile: (file) => {
        const data = io.readFile(file)
        const text = data.toString("latin1")
        for (const name of variableNames) {
          if (!holdsName(text, name)) continue
          const files = naming.get(name)
          if (files === undefined) naming.set(name, [path])
          else files.push(path)
        }
        return data
      }
    })
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
    // What a run made or found missing is the name itself: a link put there since leads somewhere the run never looked.
    const path = kind === "made" || kind === "missing" ? named(raw) : resolve(raw)
    if (path === undefined || !visible(path)) continue
    if (kind === "listed") {
      const entry = touch(path, "found")
      if (!entry.made) entry.listed = true
      continue
    }
    touch(path, kind === "emptied" ? "made" : kind)
  }
  const touched = new Set<string>()
  const fetched = new Set<string>()
  for (const raw of trace.changed) {
    if (pseudo(raw)) continue
    // Both the name the run wrote and the file a link under that name leads to are the run's to change.
    const path = named(raw)
    if (path === undefined) continue
    for (const written of new Set([path, resolve(raw) ?? path])) {
      const entry = entries.get(written)
      if (entry !== undefined) entry.changed = true
      // Making a name writes the name: a link the run made leads to a file the run may never have written.
      if (written !== path && trace.made.has(raw)) continue
      if (visible(written)) touched.add(written)
      if (trace.fetched.has(raw)) fetched.add(written)
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
  const made = new Set<string>()
  for (const raw of trace.made.keys()) {
    const path = pseudo(raw) ? undefined : named(raw)
    if (path !== undefined && visible(path)) made.add(path)
  }
  const producers = options.producers ?? []
  /** The last step the run depends on that wrote a path, or made a directory above it. */
  const producerOf = (path: string): number | undefined => {
    for (let index = producers.length - 1; index >= 0; index -= 1) {
      const producer = producers[index]!
      if (producer.touched.has(path)) return index
      for (let above = NodePath.posix.dirname(path); above !== "/"; above = NodePath.posix.dirname(above)) {
        if (producer.made.has(above)) return index
      }
    }
    return undefined
  }
  const from: Array<readonly [string, string]> = []
  const places = new Map<number, number>()
  /** The place in `from` of the step that wrote a path, when one did. */
  const placeOf = (path: string): number | undefined => {
    const producer = producerOf(path)
    if (producer === undefined) return undefined
    let place = places.get(producer)
    if (place === undefined) {
      place = from.length
      places.set(producer, place)
      from.push([producers[producer]!.label, producers[producer]!.id])
    }
    return place
  }
  const reads: Array<readonly [string, string] | readonly [string, string, string]> = []
  const given: Array<readonly [string, string, number]> = []
  const lists: Array<Record["lists"][number]> = []
  for (const path of [...entries.keys()].sort(byCodeUnit)) {
    const entry = entries.get(path)!
    if (!visible(path) || entry.first === "made") continue
    const state = measured(path)
    if (entry.first === "missing") {
      reads.push(state !== absent && entry.made ? [inside(path), state, absent] : [inside(path), absent])
      continue
    }
    if (!entry.changed) {
      if (state === absent) return { refusal: `${inside(path)} was removed while it ran` }
      if (state !== "d" && moved(path)) return { refusal: `${inside(path)} changed while it ran` }
    }
    const place = producers.length === 0 ? undefined : placeOf(path)
    if (place === undefined) reads.push([inside(path), state])
    else given.push([inside(path), state, place])
    if (!entry.listed) continue
    const names = [...(own.get(path) ?? [])].sort(byCodeUnit)
    // In a directory no step made, the names a step added are that step's: each is checked on its own.
    const added: Array<readonly [string, number]> = []
    if (place === undefined && producers.length > 0) {
      for (const name of namesIn(path, io)) {
        if (names.includes(name)) continue
        const writer = placeOf(path === "/" ? `/${name}` : `${path}/${name}`)
        if (writer !== undefined) added.push([name, writer])
      }
    }
    const digest = listing(path, [...names, ...added.map(([name]) => name)], io)
    if (digest === undefined) continue
    if (names.length === 0 && moved(path)) return { refusal: `${inside(path)} changed while it ran` }
    lists.push(added.length === 0 ? [inside(path), digest, names] : [inside(path), digest, names, added])
  }
  const survivors = [...touched].filter((path) => path !== options.root && present(path, io)).sort(byCodeUnit)
  /** Whether the run wrote a path, or made a directory above it. */
  const wrote = (path: string, among: ReadonlySet<string>): boolean => {
    if (among.has(path)) return true
    for (let above = NodePath.posix.dirname(path); above !== "/"; above = NodePath.posix.dirname(above)) {
      if (among.has(above) && made.has(above)) return true
    }
    return false
  }
  /** The variables the run could have used, each with what it held. */
  const used = (given: Variables): ReadonlyArray<readonly [string, string]> => {
    const names = new Set(given.shown)
    for (const name of variableNames) if (holdsName(given.text, name)) names.add(name)
    // A name in a file git leaves out, such as an installed tool, says nothing: many tools hold names they never
    // act on. A name in the workspace's own text is the run's to read.
    const holders = [...new Set([...naming.values()].flat())]
    const left = holders.length === 0 ? new Set<string>() : (given.ignored ?? ignoredByGit(options.root))(holders)
    for (const [name, files] of naming) if (files.some((file) => !left.has(file))) names.add(name)
    // A value in a file the run wrote and left. What a locked install fetched is fixed by a lockfile, not by the run.
    const sought = variableNames.flatMap((name) => {
      const value = given.values[name]
      return names.has(name) || value === undefined || value.length < minimumValueLength ? [] : [[name, value] as const]
    })
    for (const path of sought.length === 0 ? [] : survivors) {
      if (wrote(path, fetched)) continue
      let text: string
      try {
        if (!io.lstat(path).isFile()) continue
        text = io.readFile(path).toString("latin1")
      } catch {
        // A file that cannot be read may hold any of them.
        for (const [name] of sought) names.add(name)
        break
      }
      for (const [name, value] of sought) if (holdsValue(text, value)) names.add(name)
    }
    return [...names].sort(byCodeUnit).map((name) => [name, heldAs(given.values[name])] as const)
  }
  const held = variables === undefined ? [] : used(variables)
  const body = {
    reads,
    lists,
    ...(from.length === 0 ? {} : { from, given }),
    ...(survivors.length > 0 ? { left: true as const } : {}),
    ...(held.length === 0 ? {} : { variables: held })
  }
  const record = { ...body, id: idOf(body) }
  if (survivors.length === 0) return { record, made, touched }

  const limits = options.limits ?? keptLimits
  const temporary = options.temporary ?? []
  /** A path as it is kept: from the root inside the workspace, absolute under a temporary directory. */
  const keptAs = (path: string): string | undefined =>
    under(path, options.root)
      ? inside(path)
      : temporary.some((directory) => under(path, directory))
      ? path
      : undefined
  const leaves = (): Left | { readonly refusal: string } => {
    const keep: Array<string> = []
    const outside: Array<readonly [string, string]> = []
    let bytes = 0
    for (const path of survivors) {
      const name = keptAs(path)
      if (name === undefined) {
        // A package manager fills its own cache again when a file of it is missing.
        if (wrote(path, fetched)) continue
        outside.push([path, measure(path, io)])
        if (outside.length > limits.outside) return { refusal: "it left too many files outside the workspace to keep" }
        continue
      }
      if (under(path, `${options.root}/.git`)) return { refusal: `it wrote ${name}, in the repository's own store` }
      const stats = io.lstat(path)
      if (stats.isSymbolicLink()) {
        const target = NodePath.posix.resolve(NodePath.posix.dirname(path), io.readlink(path))
        if (keptAs(target) === undefined && wrote(target, touched)) {
          return { refusal: `${name} is a link to ${target}, which it wrote outside the workspace` }
        }
      } else if (stats.isFile()) bytes += stats.size
      // A socket or a pipe a process left is nothing to put back.
      else if (!stats.isDirectory()) continue
      keep.push(name)
      if (keep.length > limits.paths || bytes > limits.bytes) return { refusal: "it left too much to keep" }
    }
    const gone: Array<string> = []
    for (const raw of trace.removed) {
      const path = pseudo(raw) ? undefined : named(raw)
      if (path === undefined || !visible(path) || present(path, io)) continue
      const name = keptAs(path)
      if (name !== undefined) gone.push(name)
    }
    if (gone.length > limits.paths) return { refusal: "it left too much to keep" }
    return { keep, gone: [...new Set(gone)].sort(byCodeUnit), outside }
  }
  return { record, made, touched, left: leaves() }
}

/**
 * Whether what a kept record's run left outside the workspace is still as
 * the run left it. The kept files stand for the run only then: a step after
 * it may read a program the run installed in the home directory.
 *
 * @category recording
 * @since 1.0.0
 */
export const outsideHolds = (stored: Record, measured: (path: string) => string = measure): boolean =>
  (stored.kept?.outside ?? []).every(([path, state]) => measured(path) === state)

/**
 * Whether a name in a kept archive may be put back: a path inside the
 * workspace, written from its root and never in `.git`, or an absolute path
 * under one of the temporary directories.
 *
 * @category recording
 * @since 1.0.0
 */
export const keptName = (name: string, temporary: ReadonlyArray<string>): boolean => {
  const parts = name.split("/")
  if (name === "" || name.includes("\0") || parts.includes("..")) return false
  if (!name.startsWith("/")) return parts[0] !== ".git" && !parts.includes("")
  return temporary.some((directory) => name.startsWith(`${directory}/`))
}

/** The names in a directory, sorted; none when it cannot be listed. */
const namesIn = (path: string, io: Io): ReadonlyArray<string> => {
  try {
    return [...io.readdir(path)].sort(byCodeUnit)
  } catch {
    return []
  }
}

/** Whether anything is at a path. */
const present = (path: string, io: Io): boolean => {
  try {
    io.lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Turns a trace into the record of what its run read, or says why the run
 * stores nothing: {@link observe} without the paths the run wrote.
 *
 * @category recording
 * @since 1.0.0
 */
export const record = (
  trace: Trace,
  options: Parameters<typeof observe>[1]
): Record | { readonly refusal: string } => {
  const observed = observe(trace, options)
  return "refusal" in observed ? observed : observed.record
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
 * when every path it read still holds what the run left there and every
 * variable it could have used holds, in `values`, the value it had.
 *
 * `answered` gives, for a step the run read files from, the ids of the
 * records that step is answered from while it has written nothing in this
 * run, and `undefined` once what it left is in place: it ran, or its files
 * were put back. A step answered from another of its runs would write other
 * files than this run read, whatever is at those paths now, so the record
 * does not hold.
 *
 * @category recording
 * @since 1.0.0
 */
export const changed = (
  stored: Record,
  root: string,
  measured: (path: string) => string = measure,
  io: Io = defaultIo,
  answered: (label: string) => ReadonlySet<string> | undefined = () => undefined,
  values: Variables["values"] = {}
): string | undefined => {
  for (const [name, held] of stored.variables ?? []) {
    if (heldAs(values[name]) !== held) return `the variable ${name} has another value`
  }
  const absolute = (path: string): string => path === "." ? root : path.startsWith("/") ? path : `${root}/${path}`
  for (const [path, state, other] of stored.reads) {
    const now = measured(absolute(path))
    if (now === state || now === other) continue
    if (now === absent) return `${path} is gone`
    return state === absent ? `${path} now exists` : `${path} changed`
  }
  for (const [label, id] of stored.from ?? []) {
    if (answered(label)?.has(id) === false) return `${label} is answered from another of its runs`
  }
  /** Whether the step at a place in `from` is answered from the record this run read its files under. */
  const again = (place: number): boolean => {
    const [label, id] = stored.from![place]!
    return answered(label)?.has(id) === true
  }
  // A path a step wrote that is missing now is written again as it was when that step is answered from the same record.
  const pending = new Set<string>()
  for (const [path, state, place] of stored.given ?? []) {
    const now = measured(absolute(path))
    if (now === state) continue
    if (now !== absent) return state === absent ? `${path} now exists` : `${path} changed`
    if (!again(place)) return `${path} is gone`
    pending.add(path)
  }
  for (const [path, digest, own, added = []] of stored.lists) {
    if (pending.has(path)) continue
    const directory = absolute(path)
    if (listing(directory, [...own, ...added.map(([name]) => name)], io) !== digest) {
      return `${path} gained or lost an entry`
    }
    for (const [name, place] of added) {
      if (!present(`${directory}/${name}`, io) && !again(place)) {
        return `${path === "." ? "" : `${path}/`}${name} is gone`
      }
    }
  }
  return undefined
}

/**
 * A record whose run read files of steps that have since run again and
 * stored new records: the same record under those steps' new ids. `idOf`
 * gives the id of the record a step's last run stored. `undefined` when no id
 * differs. Only a record whose every path still holds is moved this way: the
 * steps wrote again exactly what its run read.
 *
 * @category results
 * @since 1.0.0
 */
export const anchored = (stored: Record, latest: (label: string) => string | undefined): Record | undefined => {
  const before = stored.from ?? []
  const from = before.map(([label, id]) => [label, latest(label) ?? id] as const)
  if (from.every(([, id], place) => id === before[place]![1])) return undefined
  const body = {
    reads: stored.reads,
    lists: stored.lists,
    from,
    given: stored.given ?? [],
    ...(stored.left === true ? { left: true as const } : {}),
    ...(stored.variables === undefined ? {} : { variables: stored.variables })
  }
  return { ...body, id: idOf(body), ...(stored.kept === undefined ? {} : { kept: stored.kept }) }
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
 * directory and each path a declaration names. `~` stands for `home`,
 * `$TMPDIR` for `temporary`, the run's temporary directory, and a relative
 * path is read from the workspace root.
 *
 * @category recording
 * @since 1.0.0
 */
export const ignored = (
  root: string,
  home: string,
  cacheDirectory: string,
  declared: ReadonlyArray<string>,
  temporary: string = NodeOs.tmpdir()
): ReadonlyArray<string> =>
  [cacheDirectory, ...declared].map((entry) => {
    const path = entry === "~" || entry.startsWith("~/")
      ? NodePath.join(home, entry.slice(1))
      : entry === temporaryName || entry.startsWith(`${temporaryName}/`)
      ? NodePath.join(temporary, entry.slice(temporaryName.length))
      : NodePath.resolve(root, entry)
    try {
      return NodeFs.realpathSync(path)
    } catch {
      return path
    }
  })

/** How a declaration names the run's temporary directory in a path it leaves out. */
const temporaryName = "$TMPDIR"

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

const isKept = (value: unknown): boolean => {
  if (value === undefined) return true
  if (typeof value !== "object" || value === null) return false
  const { archive, gone, outside } = value as { readonly [key in "archive" | "gone" | "outside"]?: unknown }
  return typeof archive === "string" && /^[0-9a-f]{64}$/.test(archive) &&
    Array.isArray(gone) && gone.every((path) => typeof path === "string") && Array.isArray(outside) &&
    outside.every((row) => Array.isArray(row) && row.length === 2 && row.every((part) => typeof part === "string"))
}

const isRecord = (value: unknown): value is Record => {
  if (typeof value !== "object" || value === null) return false
  const { from = [], given = [], id, kept, left, lists, reads, variables = [] } = value as {
    readonly [key in keyof Record]?: unknown
  }
  const text = (part: unknown): boolean => typeof part === "string"
  /** A place in `from`. */
  const place = (part: unknown): boolean =>
    Number.isInteger(part) && (part as number) >= 0 && (part as number) < (from as ReadonlyArray<unknown>).length
  return Array.isArray(reads) && Array.isArray(lists) && Array.isArray(from) && Array.isArray(given) &&
    typeof id === "string" && (left === undefined || left === true) && isKept(kept) &&
    Array.isArray(variables) && variables.every((row) => Array.isArray(row) && row.length === 2 && row.every(text)) &&
    reads.every((row) => Array.isArray(row) && (row.length === 2 || row.length === 3) && row.every(text)) &&
    from.every((row) => Array.isArray(row) && row.length === 2 && row.every(text)) &&
    given.every((row) => Array.isArray(row) && row.length === 3 && text(row[0]) && text(row[1]) && place(row[2])) &&
    lists.every((row) =>
      Array.isArray(row) && (row.length === 3 || row.length === 4) && text(row[0]) && text(row[1]) &&
      Array.isArray(row[2]) && row[2].every(text) &&
      (row[3] === undefined ||
        (Array.isArray(row[3]) &&
          row[3].every((added) => Array.isArray(added) && added.length === 2 && text(added[0]) && place(added[1]))))
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
  // A run that read what an earlier one read replaces that one's record.
  const others = earlier.filter((record) => record.id !== added.id)
  for (const candidate of [added, ...others].slice(0, maximumRecords)) {
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
