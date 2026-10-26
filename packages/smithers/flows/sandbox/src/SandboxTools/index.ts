/**
 * Typed tools on a sandbox's working copy: run a command, read, write and list
 * files, and git status and diff, each over one `Sandbox.Session`.
 *
 * The sandbox exposes itself and these tools; it knows nothing about agents.
 * An agent, a button or an API route reaches a machine through them alike,
 * from whatever host runs it.
 *
 * - **Typed both ways.** A tool's input is a {@link Call} and its output a
 *   {@link Result}, both Schemas, so a durable flow declares them as its
 *   payload and success and its journal keeps them.
 * - **Bounded.** A command runs for at most `limits.maxTimeoutSeconds`. Each
 *   output stream, a read, a listing and a diff return at most their limit
 *   and say when they cut.
 * - **Confined.** Every path is taken under the session's workdir. A path
 *   that leaves it is refused before anything runs.
 * - **At most once.** {@link execute} fences a command by its call id in the
 *   guest. The same call again answers the result the first attempt recorded,
 *   or fails {@link ToolLost} when that attempt never finished. It never runs
 *   a command twice.
 * - **Portable.** The scripts are POSIX `sh` with git. A guest with GNU
 *   `timeout` stops a command's whole process group at its deadline; without
 *   it, the command's own process.
 *
 * {@link checkpoint} and {@link restore} carry a working copy from one machine
 * to the next: the commit it is based on, and a binary patch from that commit
 * covering every tracked and untracked change.
 *
 * Nothing here records a path, a command, a file's content or output in
 * telemetry: spans carry the tool, the outcome and byte counts.
 *
 * @since 1.0.0-rc.17
 */

import { Fault } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ProviderErrorCode } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../Sandbox/Session.ts"

/**
 * The tools' bounds.
 *
 * - `commandLength`: the longest command, in characters.
 * - `pathLength`: the longest path, in characters.
 * - `defaultTimeoutSeconds`, `maxTimeoutSeconds`: how long a command runs
 *   when it names no timeout, and at most.
 * - `outputBytes`: the bytes of each output stream a command returns.
 * - `fileBytes`: the largest file a write takes, and the bytes a read returns.
 * - `listEntries`: the entries a listing returns.
 * - `diffBytes`: the bytes a diff returns.
 * - `diffPaths`: the paths a diff may name.
 * - `checkpointBytes`: the largest working-copy patch a checkpoint takes.
 * - `maxObserveWaitSeconds`: the longest {@link observe} waits for a
 *   command to end.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const limits = {
  commandLength: 16 * 1024,
  pathLength: 4096,
  defaultTimeoutSeconds: 60,
  maxTimeoutSeconds: 600,
  outputBytes: 64 * 1024,
  fileBytes: 1024 * 1024,
  listEntries: 1000,
  diffBytes: 256 * 1024,
  diffPaths: 100,
  checkpointBytes: 8 * 1024 * 1024,
  maxObserveWaitSeconds: 60
} as const

const GuestPath = Schema.String.check(Schema.isMaxLength(limits.pathLength))

/**
 * Run `command` with `sh -c` in the workdir, or in `cwd` under it, with no
 * input, for at most `timeoutSeconds` (`limits.defaultTimeoutSeconds` unless
 * set).
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Run = Schema.Struct({
  tool: Schema.Literal("run"),
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(limits.commandLength)),
  cwd: Schema.optional(GuestPath),
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: limits.maxTimeoutSeconds }))
  )
})

/**
 * Read the text of the file at `path`.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Read = Schema.Struct({ tool: Schema.Literal("read"), path: GuestPath })

/**
 * Write `content` to the file at `path`, making its directories; it replaces
 * what was there.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Write = Schema.Struct({
  tool: Schema.Literal("write"),
  path: GuestPath,
  content: Schema.String.check(Schema.isMaxLength(limits.fileBytes))
})

/**
 * List the directory at `path`, the workdir unless set.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const List = Schema.Struct({ tool: Schema.Literal("list"), path: Schema.optional(GuestPath) })

/**
 * The working copy's git status.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Status = Schema.Struct({
  tool: Schema.Literal("status"),
  /** Compare the complete working tree with this immutable base, including local commits. */
  base: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)))
})

/**
 * The working copy's changes from `HEAD` as a unified diff, untracked files
 * as new ones, limited to `paths` when set.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Diff = Schema.Struct({
  tool: Schema.Literal("diff"),
  paths: Schema.optional(Schema.Array(GuestPath).check(Schema.isMaxLength(limits.diffPaths)))
})

/**
 * One tool call: its input, tagged by `tool`.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Call = Schema.Union([Run, Read, Write, List, Status, Diff])

/**
 * One tool call.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Call = typeof Call.Type

/**
 * A tool's name.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Tool = Call["tool"]

/**
 * Every tool's name.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const tools: ReadonlyArray<Tool> = ["run", "read", "write", "list", "status", "diff"]

/**
 * Whether a tool changes the working copy: `run` and `write`.
 *
 * @category predicates
 * @since 1.0.0-rc.17
 */
export const mutates = (tool: Tool): boolean => tool === "run" || tool === "write"

/**
 * What a command did: its exit code, whether its timeout stopped it, and the
 * first `limits.outputBytes` of each stream with the stream's whole size.
 * `truncated` is true when either stream was cut.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const RunResult = Schema.Struct({
  tool: Schema.Literal("run"),
  exitCode: Schema.Int,
  timedOut: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutBytes: Schema.Int,
  stderrBytes: Schema.Int,
  truncated: Schema.Boolean
})

/**
 * A file's text: its first `limits.fileBytes` bytes as UTF-8, its size, and
 * whether it was cut. `path` is relative to the workdir.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const ReadResult = Schema.Struct({
  tool: Schema.Literal("read"),
  path: Schema.String,
  content: Schema.String,
  bytes: Schema.Int,
  truncated: Schema.Boolean
})

/**
 * A written file: its path relative to the workdir, and its size.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const WriteResult = Schema.Struct({ tool: Schema.Literal("write"), path: Schema.String, bytes: Schema.Int })

/**
 * One directory entry: its name, its kind, and a file's size.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Entry = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["file", "directory", "symlink", "other"]),
  bytes: Schema.Int
})

/**
 * One directory entry.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Entry = typeof Entry.Type

/**
 * A directory's entries, in name order, at most `limits.listEntries`.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const ListResult = Schema.Struct({
  tool: Schema.Literal("list"),
  path: Schema.String,
  entries: Schema.Array(Entry),
  truncated: Schema.Boolean
})

/**
 * One changed path in git's short form: `index` and `worktree` are the two
 * status letters (`?` for untracked), and `from` a rename's old path.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const StatusEntry = Schema.Struct({
  path: Schema.String,
  index: Schema.String,
  worktree: Schema.String,
  from: Schema.optional(Schema.String)
})

/**
 * One changed path.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type StatusEntry = typeof StatusEntry.Type

/**
 * The working copy's status: its branch (`null` when detached) and every
 * changed path.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const StatusResult = Schema.Struct({
  tool: Schema.Literal("status"),
  branch: Schema.NullOr(Schema.String),
  entries: Schema.Array(StatusEntry)
})

/**
 * A unified diff: its first `limits.diffBytes` bytes, its size, and whether
 * it was cut.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const DiffResult = Schema.Struct({
  tool: Schema.Literal("diff"),
  diff: Schema.String,
  bytes: Schema.Int,
  truncated: Schema.Boolean
})

/**
 * One tool's output, tagged by `tool` as its call is.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Result = Schema.Union([RunResult, ReadResult, WriteResult, ListResult, StatusResult, DiffResult])

/**
 * One tool's output.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Result = typeof Result.Type

/**
 * Why a tool refused a call, before or without changing anything:
 *
 * - `path`: the path leaves the workdir;
 * - `not_found`: nothing is at the path;
 * - `not_a_file`: the path is a directory, where a file was meant;
 * - `not_a_directory`: the path is not a directory, where one was meant;
 * - `not_a_repository`: the workdir is not a git working copy;
 * - `too_large`: the content or the working copy's patch is over its limit.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export class ToolRefused extends Schema.TaggedError<ToolRefused>()("@smthrs/sandbox/SandboxTools/ToolRefused", {
  reason: Schema.Literals(["path", "not_found", "not_a_file", "not_a_directory", "not_a_repository", "too_large"])
}) {}

/**
 * The command was started by an earlier attempt of the same call, which never
 * recorded how it ended: it may have run, and it is not run again.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export class ToolLost extends Schema.TaggedError<ToolLost>()("@smthrs/sandbox/SandboxTools/ToolLost", {}) {}

/**
 * The session failed: the machine couldn't run the tool. `code` is the
 * provider's failure kind; a caller may try the call again. `exitCode` is the
 * tool's script's own exit code when the script ran and failed (`code`
 * `unknown`), which names the step that failed; absent when the session
 * itself failed.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export class ToolUnavailable extends Schema.TaggedError<ToolUnavailable>()(
  "@smthrs/sandbox/SandboxTools/ToolUnavailable",
  { code: ProviderErrorCode, exitCode: Schema.optional(Schema.Number) }
) {}

// What each failure is to the flow engine, which retries a keyed step's infrastructure faults by default: a refusal is
// the caller's, a lost command stays lost, and a session that couldn't answer is tried again, classed by its provider's
// code as `ProviderError` is (@smthrs/flow's `Fault`).
Fault.register("@smthrs/sandbox/SandboxTools/ToolRefused", "user")
Fault.register("@smthrs/sandbox/SandboxTools/ToolLost", "dependency")
Fault.register(
  "@smthrs/sandbox/SandboxTools/ToolUnavailable",
  {
    unavailable: "infra",
    timeout: "infra",
    spawn_error: "bug",
    not_found: "bug",
    aborted: "bug",
    unknown: "bug"
  } satisfies Fault.Rows<ProviderErrorCode>
)

/**
 * What a tool can fail with.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const ToolFailure = Schema.Union([ToolRefused, ToolLost, ToolUnavailable])

/**
 * What a tool can fail with.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type ToolFailure = typeof ToolFailure.Type

/**
 * Where {@link execute} keeps what it needs between attempts.
 *
 * - `callId`: the call's own id. A command runs at most once per id.
 * - `callsDirectory`: an absolute guest directory outside the workdir, which
 *   the session's user may write, holding each command's fence, exit and
 *   output under its id.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface ExecuteOptions {
  readonly callId: string
  readonly callsDirectory: string
}

/**
 * The absolute path `path` names under `workdir`, or `undefined` when it
 * leaves it. A relative path is taken under the workdir; `.` and `..` are
 * resolved by name, so a symbolic link is followed only by the guest.
 *
 * @category paths
 * @since 1.0.0-rc.17
 */
export const resolve = (workdir: string, path: string): string | undefined => {
  if (path.includes("\0")) return undefined
  const root = `/${workdir.split("/").filter((segment) => segment !== "").join("/")}`
  const segments: Array<string> = []
  for (const segment of (path.startsWith("/") ? path : `${root}/${path}`).split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.pop() === undefined) return undefined
      continue
    }
    segments.push(segment)
  }
  const resolved = `/${segments.join("/")}`
  return resolved === root || resolved.startsWith(root === "/" ? "/" : `${root}/`) ? resolved : undefined
}

/** `absolute`, under `workdir`, as a result names it: relative, `.` for the workdir itself. */
const relative = (workdir: string, absolute: string): string => {
  const root = `/${workdir.split("/").filter((segment) => segment !== "").join("/")}`
  return absolute === root ? "." : absolute.slice(root === "/" ? 1 : root.length + 1)
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** A shell command that runs `body` with `args` as its positional parameters. */
const script = (body: string, args: ReadonlyArray<string>): string =>
  [`sh -c ${quote(body)} sandbox-tool`, ...args.map(quote)].join(" ")

const decoder = new TextDecoder()
const text = (bytes: Uint8Array): string => decoder.decode(bytes)

/** The bytes a stream sent, keeping at most `max`. */
const kept = (stream: Stream.Stream<Uint8Array, ProviderError>, max: number) =>
  Effect.map(
    Stream.runFold(stream, () => ({ chunks: [] as Array<Uint8Array>, size: 0 }), (acc, chunk) => {
      const room = max - acc.size
      if (room > 0) {
        const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk
        acc.chunks.push(part)
        acc.size += part.byteLength
      }
      return acc
    }),
    ({ chunks, size }) => {
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
    }
  )

const unavailable = (error: ProviderError) => new ToolUnavailable({ code: error.code })

/** Runs `command`, feeding it `stdin`: its exit code and at most `max` bytes of its standard output. */
const gather = (session: Session, command: string, max: number, stdin?: Uint8Array) =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* session.spawn(command, stdin === undefined ? {} : { stdin })
    const [stdout, , code] = yield* Effect.all([
      kept(process.stdout, max),
      kept(process.stderr, 0),
      process.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, code }
  })).pipe(Effect.mapError(unavailable))

/** The first line of `bytes`, split on spaces, and what follows it. A script that exits 0 always prints that line. */
const headed = (bytes: Uint8Array): { readonly header: Array<string>; readonly body: Uint8Array } => {
  const end = bytes.indexOf(10)
  return { header: text(bytes.subarray(0, end)).split(" "), body: bytes.subarray(end + 1) }
}

/** Exit codes the scripts answer for a refusal. */
const refusals: Readonly<Record<number, ToolRefused["reason"]>> = {
  20: "not_a_directory",
  21: "not_a_file",
  44: "not_found",
  69: "not_a_repository"
}

/**
 * The script's exit code `code` as a refusal, the lost fence, something the script needed that didn't answer (76:
 * `unavailable`, worth trying again), or the session failing.
 */
const failedWith = (code: number): ToolFailure => {
  const reason = refusals[code]
  if (reason !== undefined) return new ToolRefused({ reason })
  if (code === 76) return new ToolUnavailable({ code: "unavailable" })
  return code === 75 ? new ToolLost() : new ToolUnavailable({ code: "unknown", exitCode: code })
}

const refused = (reason: ToolRefused["reason"]) => Effect.fail(new ToolRefused({ reason }))

/**
 * The start identity of process `$1`: its start time in clock ticks since boot, read from `/proc` where the guest has
 * one, else `-`. A pid the guest reuses, or one a restarted box hands out again, has another; a process that has exited
 * and waits to be reaped has `-`. Always one word, so a record of several reads back field by field.
 */
const IDENT = `ident() {
  i=
  [ -r "/proc/$1/stat" ] && i=$(sed 's/^.*) //' "/proc/$1/stat" | { read -r state rest; [ "$state" != Z ] && printf '%s\\n' "$rest" | cut -d' ' -f19; })
  printf '%s\\n' "\${i:--}"
}`

/**
 * Runs command `$4` in `$3` for at most `$2` seconds under fence directory `$1`, which exists. Each file it writes is
 * written whole: `pid` (its own pid, which leads its process group, its start in epoch seconds, the box's identity and
 * its own), `child` (the command's process, which leads the command's group under `timeout`, and its identity), `out`
 * and `err` (the command's streams), then `exit` (the exit code, and 1 when the timeout stopped it). A cwd that isn't a
 * directory ends `20 0` with no output; a fence cancelled before the command began ends `143 0`. A TERM to the runner
 * stops the command's group too, even before `child` is written, and the runner ends without an exit.
 */
const RUNNER = `d=$1; t=$2; cwd=$3; cmd=$4
${IDENT}
start=$(date +%s)
printf '%s %s %s %s\\n' "$$" "$start" "$(ident 1)" "$(ident $$)" >"$d/pid.tmp" && mv -f -- "$d/pid.tmp" "$d/pid" || exit 125
c=
trap 'trap - TERM; if [ -n "$c" ]; then kill -TERM "-$c" 2>/dev/null || kill -TERM "$c" 2>/dev/null; fi; exit 143' TERM
timed=0
if [ -e "$d/cancelled" ]; then code=143; : >"$d/out"; : >"$d/err"
elif [ ! -d "$cwd" ]; then code=20
else
  watchdog=
  if command -v timeout >/dev/null 2>&1; then
    (cd -- "$cwd" && exec timeout -k 5 "$t" sh -c "$cmd") </dev/null >"$d/out" 2>"$d/err" &
    c=$!
  else
    (cd -- "$cwd" && exec sh -c "$cmd") </dev/null >"$d/out" 2>"$d/err" &
    c=$!
    (sleep "$t"; kill -TERM "$c"; sleep 5; kill -KILL "$c") </dev/null >/dev/null 2>&1 &
    watchdog=$!
  fi
  printf '%s %s\\n' "$c" "$(ident "$c")" >"$d/child.tmp" && mv -f -- "$d/child.tmp" "$d/child"
  wait "$c"
  code=$?
  [ -z "$watchdog" ] || kill "$watchdog" 2>/dev/null
  case $code in 124|137|143) [ $(($(date +%s) - start)) -ge "$t" ] && timed=1 ;; esac
fi
printf '%s %s\\n' "$code" "$timed" >"$d/exit.tmp" && mv -f -- "$d/exit.tmp" "$d/exit" || exit 125`

/**
 * Answers how the command under fence `$d` ended: exit 75 when it never recorded it, 20 for a cwd that wasn't a
 * directory, else its exit code, whether it timed out and each stream's size, then the first `$max` bytes of each.
 */
const ANSWER = `[ -f "$d/exit" ] || exit 75
read -r code timed <"$d/exit"
[ "$timed" = 0 ] && [ "$code" = 20 ] && [ ! -f "$d/out" ] && exit 20
printf '%s %s %s %s\\n' "$code" "$timed" $(($(wc -c <"$d/out"))) $(($(wc -c <"$d/err")))
head -c "$max" -- "$d/out"
head -c "$max" -- "$d/err"`

/** The runner `$1` with the rest of its arguments, in the foreground, the first time its fence `$2` is made. */
const RUN = `d=$2; max=$6
umask 002
mkdir -p -- "\${d%/*}" 2>/dev/null || exit 125
if mkdir -- "$d" 2>/dev/null; then sh -c "$1" sandbox-run "$2" "$3" "$4" "$5" </dev/null >/dev/null 2>&1 || exit 125; fi
${ANSWER}`

/** The fence directory of `id` under `callsDirectory`, when that is an absolute guest path. */
const fenceOf = (callsDirectory: string, id: string): string | undefined => {
  const calls = resolve("/", callsDirectory)
  return calls === undefined ? undefined : `${calls}/${id.replaceAll(/[^A-Za-z0-9._-]/g, "_")}`
}

/** A command's result from an `ANSWER`'s output: its exit code, whether it timed out, and its kept streams. */
const answered = (stdout: Uint8Array): typeof RunResult.Type => {
  const max = limits.outputBytes
  const { body, header } = headed(stdout)
  const [exitCode, timed, outBytes, errBytes] = header.map(Number) as [number, number, number, number]
  const outKept = Math.min(outBytes, max)
  return {
    tool: "run",
    exitCode,
    timedOut: timed === 1,
    stdout: text(body.subarray(0, outKept)),
    stderr: text(body.subarray(outKept, outKept + Math.min(errBytes, max))),
    stdoutBytes: outBytes,
    stderrBytes: errBytes,
    truncated: outBytes > max || errBytes > max
  }
}

/**
 * Runs a command at most once under its call's fence. A cwd that isn't a
 * directory is recorded as such, so the same call answers the same refusal.
 */
const run = (session: Session, call: typeof Run.Type, options: ExecuteOptions) =>
  Effect.gen(function*() {
    const cwd = resolve(session.workdir, call.cwd ?? ".")
    const fence = fenceOf(options.callsDirectory, options.callId)
    if (cwd === undefined || fence === undefined) return yield* refused("path")
    const timeout = call.timeoutSeconds ?? limits.defaultTimeoutSeconds
    const max = limits.outputBytes
    const { code, stdout } = yield* gather(
      session,
      script(RUN, [RUNNER, fence, String(timeout), cwd, call.command, String(max)]),
      2 * max + 128
    )
    if (code !== 0) return yield* Effect.fail(failedWith(code))
    return answered(stdout)
  })

const READ = `p=$1; max=$2
[ -d "$p" ] && exit 21
[ -f "$p" ] || exit 44
printf '%s\\n' $(($(wc -c <"$p")))
head -c "$max" -- "$p"`

const read = (session: Session, call: typeof Read.Type) =>
  Effect.gen(function*() {
    const path = resolve(session.workdir, call.path)
    if (path === undefined) return yield* refused("path")
    const max = limits.fileBytes
    const { code, stdout } = yield* gather(session, script(READ, [path, String(max)]), max + 64)
    if (code !== 0) return yield* Effect.fail(failedWith(code))
    const { body, header } = headed(stdout)
    const bytes = Number(header[0])
    return {
      tool: "read",
      path: relative(session.workdir, path),
      content: text(body),
      bytes,
      truncated: bytes > max
    } satisfies typeof ReadResult.Type
  })

const WRITE = `p=$1
umask 002
[ -d "$p" ] && exit 21
mkdir -p -- "\${p%/*}" 2>/dev/null || exit 20
cat >"$p" || exit 20`

const encoder = new TextEncoder()

const write = (session: Session, call: typeof Write.Type) =>
  Effect.gen(function*() {
    const path = resolve(session.workdir, call.path)
    if (path === undefined || path === resolve(session.workdir, ".")) return yield* refused("path")
    const content = encoder.encode(call.content)
    if (content.byteLength > limits.fileBytes) return yield* refused("too_large")
    const { code } = yield* gather(session, script(WRITE, [path]), 0, content)
    if (code !== 0) return yield* Effect.fail(failedWith(code))
    return {
      tool: "write",
      path: relative(session.workdir, path),
      bytes: content.byteLength
    } satisfies typeof WriteResult.Type
  })

const LIST = `p=$1; max=$2
[ -e "$p" ] || exit 44
[ -d "$p" ] || exit 20
n=0
for f in "$p"/* "$p"/.[!.]* "$p"/..?*; do
  if [ ! -e "$f" ] && [ ! -L "$f" ]; then continue; fi
  n=$((n + 1))
  if [ "$n" -gt "$max" ]; then printf 'more\\0'; break; fi
  if [ -L "$f" ]; then k=symlink; s=0
  elif [ -d "$f" ]; then k=directory; s=0
  elif [ -f "$f" ]; then k=file; s=$(($(wc -c <"$f")))
  else k=other; s=0; fi
  printf '%s %s %s\\0' "$k" "$s" "\${f##*/}"
done`

const list = (session: Session, call: typeof List.Type) =>
  Effect.gen(function*() {
    const path = resolve(session.workdir, call.path ?? ".")
    if (path === undefined) return yield* refused("path")
    const { code, stdout } = yield* gather(
      session,
      script(LIST, [path, String(limits.listEntries)]),
      (limits.listEntries + 1) * (limits.pathLength + 32)
    )
    if (code !== 0) return yield* Effect.fail(failedWith(code))
    const records = text(stdout).split("\0").filter((record) => record !== "")
    const truncated = records.at(-1) === "more"
    const entries = (truncated ? records.slice(0, -1) : records).map((record): Entry => {
      const [kind, bytes] = record.split(" ", 2) as [Entry["kind"], string]
      return { name: record.slice(kind.length + bytes.length + 2), kind, bytes: Number(bytes) }
    })
    return { tool: "list", path: relative(session.workdir, path), entries, truncated } satisfies typeof ListResult.Type
  })

const STATUS = `cd -- "$1" 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 69
git -c core.quotePath=false status --porcelain=v1 --branch -z --untracked-files=all`

/** Git's `## <branch>...<upstream> [ahead n]` header: the branch, or `null` when detached or unborn without a name. */
const branchOf = (header: string): string | null => {
  const name = header.slice(3).split("...")[0]!.split(" ")[0]!
  return name === "HEAD" ? null : name
}

// Use a private index so collection never stages, resets or commits the agent's checkout.
const BASE_STATUS = `cd -- "$1" 2>/dev/null || exit 69
d=$(mktemp -d) || exit 125
trap 'rm -rf -- "$d"' EXIT HUP INT TERM
export GIT_INDEX_FILE="$d/index"
git read-tree HEAD || exit 69
git -c core.fsmonitor=false add -A -- . || exit 125
tree=$(git write-tree) || exit 125
git diff --name-status -z --no-renames --no-ext-diff "$2" "$tree" --`

const status = (session: Session, call: typeof Status.Type) =>
  Effect.gen(function*() {
    const { code, stdout } = yield* gather(
      session,
      script(call.base === undefined ? STATUS : BASE_STATUS, [
        resolve(session.workdir, ".")!,
        ...(call.base === undefined ? [] : [call.base])
      ]),
      limits.diffBytes + 1
    )
    if (code !== 0) return yield* Effect.fail(failedWith(code))
    if (stdout.length > limits.diffBytes) return yield* Effect.fail(new ToolUnavailable({ code: "unknown" }))
    const records = text(stdout).split("\0")
    let branch: string | null = null
    const entries: Array<StatusEntry> = []
    if (call.base !== undefined) {
      for (let index = 0; index < records.length - 1; index += 2) {
        const path = records[index + 1]!
        if (resolve(session.workdir, path) === undefined) return yield* refused("path")
        entries.push({ path, index: records[index]!, worktree: " " })
      }
      return { tool: "status", branch, entries } satisfies typeof StatusResult.Type
    }
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!
      if (record.startsWith("## ")) {
        branch = branchOf(record.startsWith("## No commits yet on ") ? `## ${record.slice(21)}` : record)
      } else if (record.length > 3) {
        const [x, y] = [record[0]!, record[1]!]
        // A rename or copy names its old path in the next record.
        const from = x === "R" || x === "C" ? records[++index] : undefined
        entries.push({ path: record.slice(3), index: x, worktree: y, ...from === undefined ? {} : { from } })
      }
    }
    return { tool: "status", branch, entries } satisfies typeof StatusResult.Type
  })

const DIFF = `w=$1; max=$2; shift 2
cd -- "$w" 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 69
out=$(mktemp) || exit 125
{
  git -c core.quotePath=false diff HEAD --no-color --no-ext-diff -- "$@"
  git -c core.quotePath=false ls-files --others --exclude-standard -- "$@" | while IFS= read -r f; do
    git diff --no-color --no-ext-diff --no-index -- /dev/null "$f"
  done
} >"$out" 2>/dev/null
printf '%s\\n' $(($(wc -c <"$out")))
head -c "$max" -- "$out"
rm -f -- "$out"`

const diff = (session: Session, call: typeof Diff.Type) =>
  Effect.gen(function*() {
    const paths: Array<string> = []
    for (const path of call.paths ?? []) {
      const resolved = resolve(session.workdir, path)
      if (resolved === undefined) return yield* refused("path")
      paths.push(resolved)
    }
    const max = limits.diffBytes
    const { code, stdout } = yield* gather(
      session,
      script(DIFF, [resolve(session.workdir, ".")!, String(max), ...paths]),
      max + 64
    )
    if (code !== 0) return yield* Effect.fail(failedWith(code))
    const { body, header } = headed(stdout)
    const bytes = Number(header[0])
    return { tool: "diff", diff: text(body), bytes, truncated: bytes > max } satisfies typeof DiffResult.Type
  })

/**
 * Runs `call` on `session`'s working copy. A `run` runs at most once per
 * `options.callId`: the same call again answers the result the first attempt
 * recorded, or fails {@link ToolLost} when that attempt never finished.
 *
 * Each call is a span `sandbox.tool` with the tool, its outcome and, for a
 * command, its exit code; never a path, a command, content or output.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const execute = (session: Session, call: Call, options: ExecuteOptions): Effect.Effect<Result, ToolFailure> => {
  const effect: Effect.Effect<Result, ToolFailure> = call.tool === "run"
    ? run(session, call, options)
    : call.tool === "read"
    ? read(session, call)
    : call.tool === "write"
    ? write(session, call)
    : call.tool === "list"
    ? list(session, call)
    : call.tool === "status"
    ? status(session, call)
    : diff(session, call)
  return effect.pipe(
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({
        "smithers.sandbox.tool.outcome": "done",
        ...result.tool === "run" ? { "smithers.sandbox.tool.exit_code": result.exitCode } : {}
      })
    ),
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({ "smithers.sandbox.tool.outcome": error._tag.split("/").at(-1)! })
    ),
    Effect.withSpan("sandbox.tool", { attributes: { "smithers.sandbox.tool": call.tool } })
  )
}

/**
 * Where a command started with {@link start} keeps what outlives the exec
 * session that started it.
 *
 * - `key`: the command's own key. One key starts one command, ever.
 * - `callsDirectory`: an absolute guest directory outside the workdir, which
 *   the session's user may write, as for {@link execute}. The command's pid,
 *   exit and output live there under its key.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface CommandOptions {
  readonly key: string
  readonly callsDirectory: string
}

/**
 * A started command's handle: the pid of the process that runs it, which
 * leads its process group, and when it started, in epoch seconds. Both are
 * 0 when an earlier start of the same key never got as far as recording
 * them, or the key was cancelled first; the command then observes `lost`.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Started = Schema.Struct({ pid: Schema.Int, startedAt: Schema.Int })

/**
 * A started command's handle.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Started = typeof Started.Type

/**
 * What a started command is doing: `running` while its process group lives
 * (the heartbeat), `finished` once it recorded its exit code and whether
 * its timeout stopped it, or `lost` when neither holds: the box restarted,
 * or something killed the process before it recorded how it ended.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Observed = Schema.Union([
  Schema.Struct({ state: Schema.Literal("running"), pid: Schema.Int }),
  Schema.Struct({ state: Schema.Literal("finished"), exitCode: Schema.Int, timedOut: Schema.Boolean }),
  Schema.Struct({ state: Schema.Literal("lost") })
])

/**
 * What a started command is doing.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Observed = typeof Observed.Type

/**
 * Starts the runner `$1` with the rest of its arguments in a session of its
 * own (`setsid`), or else a process group of its own where the shell has job
 * control, the first time its fence `$2` is made, then answers its pid and
 * start once it recorded them, waiting at most five seconds by the clock.
 */
const START = `d=$2
umask 002
mkdir -p -- "\${d%/*}" 2>/dev/null || exit 125
if mkdir -- "$d" 2>/dev/null; then
  if command -v setsid >/dev/null 2>&1; then
    setsid sh -c "$1" sandbox-command "$2" "$3" "$4" "$5" </dev/null >/dev/null 2>&1 &
  else
    (set -m 2>/dev/null; sh -c "$1" sandbox-command "$2" "$3" "$4" "$5" </dev/null >/dev/null 2>&1 &)
  fi
fi
end=$(($(date +%s) + 5))
while [ ! -f "$d/pid" ] && [ ! -e "$d/cancelled" ] && [ "$(date +%s)" -lt "$end" ]; do
  sleep 0.01 2>/dev/null || sleep 1
done
pid=0; at=0
[ -f "$d/pid" ] && read -r pid at box id <"$d/pid"
printf '%s %s\\n' "$pid" "$at"`

/**
 * Whether the command under fence `$1` runs: its runner, which waits for the
 * command and then records how it ended, lives in the box that started it.
 * With `$2` seconds to wait, it first waits that long at most for the exit,
 * looking every 50 ms, and stops waiting once the runner is gone.
 */
const OBSERVE = `d=$1; w=\${2:-0}
${IDENT}
alive() {
  [ -f "$d/pid" ] && read -r pid at box id <"$d/pid" && [ "$pid" -gt 1 ] && [ "$(ident 1)" = "$box" ] &&
    kill -0 "$pid" 2>/dev/null && [ "$(ident "$pid")" = "$id" ]
}
if [ "$w" -gt 0 ]; then
  end=$(($(date +%s) + w)); i=0
  while [ ! -f "$d/exit" ]; do
    i=$((i + 1))
    if [ $((i % 20)) -eq 1 ]; then { alive && [ "$(date +%s)" -lt "$end" ]; } || break; fi
    sleep 0.05 2>/dev/null || sleep 1
  done
fi
if [ ! -f "$d/exit" ] && alive; then
  printf 'running %s\\n' "$pid"
  exit 0
fi
if [ -f "$d/exit" ]; then read -r code timed <"$d/exit"; printf 'finished %s %s\\n' "$code" "$timed"; else printf 'lost\\n'; fi`

const COLLECT = `d=$1; max=$2
${ANSWER}`

/**
 * Marks fence `$1` cancelled, so a runner that hasn't begun its command
 * never does, then stops the runner and the command, each with its process
 * group, while each is the very process the runner recorded in the box that
 * started it: TERM, up to five seconds for them to go, then KILL. A command
 * that finished, or whose pid now names another process, is left alone.
 */
const CANCEL = `d=$1
${IDENT}
umask 002
mkdir -p -- "$d" 2>/dev/null || exit 125
: >"$d/cancelled" || exit 125
[ -f "$d/pid" ] && [ ! -f "$d/exit" ] || exit 0
read -r pid at box id <"$d/pid"
[ "$(ident 1)" = "$box" ] || exit 0
targets=
[ "$pid" -gt 1 ] && targets="$pid:$id"
[ -f "$d/child" ] && read -r child cid <"$d/child" && [ "$child" -gt 1 ] && targets="$targets $child:$cid"
live() {
  for t in $targets; do
    g=\${t%%:*}
    [ "$(ident "$g")" = "\${t#*:}" ] && { kill -0 "-$g" || kill -0 "$g"; } 2>/dev/null && printf '%s\\n' "$g"
  done
}
stop() { for g in $(live); do { kill "-$1" "-$g"; kill "-$1" "$g"; } 2>/dev/null; done; }
stop TERM
i=0
while [ -n "$(live)" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.1 2>/dev/null || sleep 1; done
stop KILL
exit 0`

/** `effect` as span `sandbox.command`, with the operation and its outcome; never a command, a path or output. */
const commandSpan = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.tap((value) =>
      Effect.annotateCurrentSpan({
        "smithers.sandbox.command.outcome": typeof value === "object" && value !== null && "state" in value
          ? String(value.state)
          : "done"
      })
    ),
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({
        "smithers.sandbox.command.outcome": (error as { readonly _tag: string })._tag.split("/").at(-1)!
      })
    ),
    Effect.withSpan("sandbox.command", { attributes: { "smithers.sandbox.command.op": operation } })
  )

/**
 * The fence of `options.key`, named so no two keys share one: each byte outside `[A-Za-z0-9.-]` is `_` and its two hex
 * digits. A calls directory that isn't an absolute guest path is refused `path`.
 */
const commandFence = (options: CommandOptions) => {
  const name = Array.from(
    encoder.encode(options.key),
    (
      byte
    ) => (/[A-Za-z0-9.-]/.test(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `_${byte.toString(16).padStart(2, "0")}`)
  ).join("")
  const fence = fenceOf(options.callsDirectory, `command-${name}`)
  return fence === undefined ? refused("path") : Effect.succeed(fence)
}

/**
 * Starts `call`'s command in the session's working copy, detached from the
 * exec session that starts it: in a process session and group of its own
 * where the guest has `setsid`, with its streams in files, so it outlives
 * that session, the host that asked and any number of hosts after it. It
 * runs for at most its timeout, as {@link execute}'s do.
 *
 * It answers at once, with the command's {@link Started} handle. The same
 * key again answers the same handle and never starts the command twice, so a
 * caller that lost the answer asks again. Follow it with {@link observe},
 * {@link collect} and {@link cancel}.
 *
 * A cwd that leaves the workdir is refused `path` before anything runs; one
 * that isn't a directory finishes the command, which then collects as
 * `not_a_directory`.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const start = (
  session: Session,
  call: typeof Run.Type,
  options: CommandOptions
): Effect.Effect<Started, ToolRefused | ToolUnavailable> =>
  commandSpan(
    "start",
    Effect.gen(function*() {
      const cwd = resolve(session.workdir, call.cwd ?? ".")
      if (cwd === undefined) return yield* refused("path")
      const fence = yield* commandFence(options)
      const timeout = call.timeoutSeconds ?? limits.defaultTimeoutSeconds
      const { code, stdout } = yield* gather(
        session,
        script(START, [RUNNER, fence, String(timeout), cwd, call.command]),
        128
      )
      if (code !== 0) return yield* Effect.fail(failedWith(code) as ToolUnavailable)
      const [pid, startedAt] = text(stdout).trim().split(" ").map(Number) as [number, number]
      return { pid, startedAt }
    })
  )

/**
 * What the command started under `options.key` is doing ({@link Observed}).
 * It reads only: asking changes nothing in the box. With `waitMs`, it first
 * waits for the command to end, answering `finished` as soon as it does
 * (within 50 ms) and what it sees once the wait is over otherwise; the wait
 * is whole seconds, `waitMs` rounded up, at most {@link limits}`.maxObserveWaitSeconds`.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const observe = (
  session: Session,
  options: CommandOptions & { readonly waitMs?: number | undefined }
): Effect.Effect<Observed, ToolRefused | ToolUnavailable> =>
  commandSpan(
    "observe",
    Effect.gen(function*() {
      const fence = yield* commandFence(options)
      const wait = Math.min(limits.maxObserveWaitSeconds, Math.max(0, Math.ceil((options.waitMs ?? 0) / 1000)))
      const { code, stdout } = yield* gather(session, script(OBSERVE, [fence, String(wait)]), 128)
      if (code !== 0) return yield* Effect.fail(failedWith(code) as ToolUnavailable)
      const [state, first, second] = text(stdout).trim().split(" ")
      return state === "running"
        ? { state: "running" as const, pid: Number(first) }
        : state === "finished"
        ? { state: "finished" as const, exitCode: Number(first), timedOut: second === "1" }
        : { state: "lost" as const }
    })
  )

/**
 * The result of the command started under `options.key`, once it finished:
 * the same {@link RunResult} {@link execute} answers, as often as it is
 * asked. A command that never recorded how it ended fails {@link ToolLost};
 * one whose cwd wasn't a directory, `not_a_directory`.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const collect = (
  session: Session,
  options: CommandOptions
): Effect.Effect<typeof RunResult.Type, ToolFailure> =>
  commandSpan(
    "collect",
    Effect.gen(function*() {
      const fence = yield* commandFence(options)
      const max = limits.outputBytes
      const { code, stdout } = yield* gather(session, script(COLLECT, [fence, String(max)]), 2 * max + 128)
      if (code !== 0) return yield* Effect.fail(failedWith(code))
      return answered(stdout)
    })
  )

/**
 * Stops the command started under `options.key`: its runner's and its own
 * process groups, TERM and then KILL. A key not started yet is cancelled
 * too, and a later {@link start} of it starts nothing. A command that
 * finished, or ran in a box that has since restarted, is left as it is.
 * Asking again changes nothing.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const cancel = (session: Session, options: CommandOptions): Effect.Effect<void, ToolRefused | ToolUnavailable> =>
  commandSpan(
    "cancel",
    Effect.gen(function*() {
      const fence = yield* commandFence(options)
      const { code } = yield* gather(session, script(CANCEL, [fence]), 0)
      if (code !== 0) return yield* Effect.fail(failedWith(code) as ToolUnavailable)
    })
  )

/**
 * A working copy, carried to another machine: the commit it is based on, a
 * binary patch from that commit with every tracked and untracked change, and
 * a git bundle of the commits no remote has, such as a commit made in the
 * box, so a fresh clone can reach that commit. Ignored files are not carried.
 *
 * `bundle` is empty when every commit is on a remote; a checkpoint without
 * one restores as one with an empty bundle.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Checkpoint {
  readonly head: string
  readonly patch: Uint8Array
  readonly bundle?: Uint8Array | undefined
}

// Each step that can fail exits with its own code (120 to 124), so a failure names its step (`ToolUnavailable.exitCode`).
// The index the changes are staged in starts as a copy of the checkout's own, whose stat data lets `git add` hash only
// the files that changed rather than every file in the checkout (on 15,000 files, 25 ms rather than a second); a checkout
// with no index starts from `HEAD`. Either way `add -A` makes it the working copy, so the patch is the same.
const CHECKPOINT = `cd -- "$1" 2>/dev/null && git rev-parse --verify -q HEAD >/dev/null 2>&1 || exit 69
dir=$(mktemp -d) || exit 120
trap 'rm -rf -- "$dir"' EXIT
own=$(git rev-parse --git-path index) || exit 121
{ [ -f "$own" ] && cp -- "$own" "$dir/index" 2>/dev/null; } || GIT_INDEX_FILE="$dir/index" git read-tree HEAD || exit 121
GIT_INDEX_FILE="$dir/index" git add -A || exit 122
GIT_INDEX_FILE="$dir/index" git diff --cached --binary --no-color --no-ext-diff HEAD >"$dir/patch" || exit 123
: >"$dir/bundle"
if [ -n "$(git rev-list -n 1 HEAD --not --remotes)" ]; then
  git bundle create "$dir/bundle" HEAD --not --remotes 2>/dev/null || exit 124
fi
p=$(($(wc -c <"$dir/patch"))); b=$(($(wc -c <"$dir/bundle")))
printf '%s %s %s\\n' "$(git rev-parse HEAD)" "$p" "$b"
if [ $((p + b)) -le "$2" ]; then cat -- "$dir/patch" "$dir/bundle"; fi`

/**
 * Captures the session's working copy without changing it: its `HEAD`, a
 * binary patch from it, and a bundle of the commits no remote has. A patch
 * and bundle together over `limits.checkpointBytes` are refused
 * `too_large`; a workdir with no commit, `not_a_repository`.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const checkpoint = (
  session: Session
): Effect.Effect<Checkpoint & { readonly bundle: Uint8Array }, ToolRefused | ToolUnavailable> =>
  Effect.gen(function*() {
    const max = limits.checkpointBytes
    const { code, stdout } = yield* gather(
      session,
      script(CHECKPOINT, [resolve(session.workdir, ".")!, String(max)]),
      max + 128
    )
    if (code !== 0) return yield* Effect.fail(failedWith(code) as ToolRefused | ToolUnavailable)
    const { body, header } = headed(stdout)
    const patchBytes = Number(header[1])
    if (patchBytes + Number(header[2]) > max) return yield* Effect.fail(new ToolRefused({ reason: "too_large" }))
    return { head: header[0]!, patch: body.slice(0, patchBytes), bundle: body.slice(patchBytes) }
  }).pipe(Effect.withSpan("sandbox.checkpoint"))

const RESTORE = `cd -- "$1" 2>/dev/null && git rev-parse --verify -q HEAD >/dev/null 2>&1 || exit 69
dir=$(mktemp -d) || exit 125
trap 'rm -rf -- "$dir"' EXIT
cat >"$dir/in" || exit 125
# BSD head refuses -c 0.
if [ "$3" -gt 0 ]; then head -c "$3" "$dir/in" >"$dir/patch" || exit 125; else : >"$dir/patch"; fi
tail -c +$(($3 + 1)) "$dir/in" >"$dir/bundle" || exit 125
has() { git cat-file -e "$1^{commit}" 2>/dev/null; }
# Fetches commit $1 from origin by its id. An origin that can't be reached exits 76, so the restore is tried again; one
# that answered without the commit leaves it missing.
fetch() {
  out=$(git fetch -q --depth=1 origin "$1" 2>&1) && return 0
  case "$out" in *"unable to access"*|*"returned error: 5"*|*"RPC failed"*|*"early EOF"*|*"Could not resolve"*|*"timed out"*) exit 76 ;; esac
  return 1
}
if ! has "$2"; then
  if [ -s "$dir/bundle" ]; then
    # The bundle's base commits first: a branch that moved on may have left them out of a shallow clone.
    for base in $(sed -n '/^$/q; s/^-\\([0-9a-f]\\{40,64\\}\\).*/\\1/p' "$dir/bundle"); do has "$base" || fetch "$base" || true; done
    git fetch -q "$dir/bundle" 2>/dev/null
  fi
  has "$2" || fetch "$2" || true
  has "$2" || exit 44
fi
umask 002
if [ "$(git rev-parse HEAD)" != "$2" ]; then git reset -q --hard "$2" || exit 125; fi
[ "$3" = 0 ] && exit 0
git apply --binary --whitespace=nowarn "$dir/patch" || exit 125`

/**
 * Puts a {@link Checkpoint} back on the session's working copy: moves `HEAD`
 * to its commit when it is elsewhere, then applies its patch. A commit the
 * working copy lacks comes from the checkpoint's bundle, whose base commits
 * are fetched from `origin` by their ids first, else is fetched from `origin`
 * by its id; `not_found` when neither has it. An `origin` that can't be
 * reached fails `ToolUnavailable` with code `unavailable`, so the caller can
 * try again. Restore onto a clean
 * checkout: a working copy with changes may refuse the patch.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const restore = (session: Session, saved: Checkpoint): Effect.Effect<void, ToolRefused | ToolUnavailable> =>
  Effect.gen(function*() {
    const bundle = saved.bundle ?? new Uint8Array()
    const input = new Uint8Array(saved.patch.byteLength + bundle.byteLength)
    input.set(saved.patch)
    input.set(bundle, saved.patch.byteLength)
    const { code } = yield* gather(
      session,
      script(RESTORE, [resolve(session.workdir, ".")!, saved.head, String(saved.patch.byteLength)]),
      0,
      input
    )
    if (code !== 0) return yield* Effect.fail(failedWith(code) as ToolRefused | ToolUnavailable)
  }).pipe(Effect.withSpan("sandbox.restore"))

/**
 * Where {@link rebaseCall}'s script leaves the paths it found, relative to
 * the workdir, NUL-separated: the files that conflict, or the files whose
 * contents the move changes. Read it with the `read` tool and
 * {@link rebasePaths}.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const REBASE_PATHS = ".git/smithers-rebase"

/**
 * Moving a working copy onto commit `onto` of `branch`, which `origin` serves.
 * Without `expect` the call only plans; with it, the call applies the plan if
 * the working copy's tree is still `expect`, the tree its plan answered.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface RebaseOptions {
  readonly branch: string
  readonly onto: string
  readonly expect?: string | undefined
  readonly timeoutSeconds?: number | undefined
}

/**
 * How a {@link rebaseCall} ended, each with the working copy's tree (`tree`,
 * every tracked and untracked change staged, ignored files left out):
 *
 * - `Current`: `HEAD` is `onto` already; nothing to do.
 * - `Unrelated`: `onto` and `HEAD` share no commit.
 * - `Conflicted`: `paths` files conflict, listed in {@link REBASE_PATHS};
 *   nothing changed.
 * - `Planned`: the move is clean; it would change `paths` files' contents
 *   (listed) and leave the working copy at tree `result`.
 * - `Moved`: the working copy is no longer `expect`; nothing changed.
 * - `Applied`: `HEAD` is `onto` and the working copy is `result`, its own
 *   changes on top of `onto` as uncommitted ones; `paths` files changed.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Rebased =
  | { readonly _tag: "Current"; readonly tree: string }
  | { readonly _tag: "Unrelated"; readonly tree: string }
  | { readonly _tag: "Conflicted"; readonly tree: string; readonly paths: number }
  | { readonly _tag: "Planned"; readonly tree: string; readonly result: string; readonly paths: number }
  | { readonly _tag: "Moved"; readonly tree: string }
  | { readonly _tag: "Applied"; readonly tree: string; readonly result: string; readonly paths: number }

// Fetches `$2` from origin unless commit `$3` is here (76 when origin can't be reached, 44 when it hasn't the commit),
// stages the working copy into a scratch index as `checkpoint` does, and merges it onto `$3` with git's own merge base,
// as a commit of that tree on `HEAD` (`merge-tree`, git 2.38 or later, changing nothing). Local commits not on `$3`
// merge as the working copy's own changes. With `$4`, the tree the plan saw, it applies a clean merge: `HEAD` moves to
// `$3` and the working copy becomes the merge, its changes uncommitted. Each failing step exits with its own code.
const REBASE = `cd -- "$1" 2>/dev/null && [ -d .git ] && git rev-parse --verify -q HEAD >/dev/null 2>&1 || exit 69
dir=$(mktemp -d) || exit 120
trap 'rm -rf -- "$dir"' EXIT
has() { git cat-file -e "$1^{commit}" 2>/dev/null; }
commit() { git -c user.name=Smithers -c user.email=smithers@localhost commit-tree "$@" </dev/null; }
count() { tr -cd '\\000' <"$1" | wc -c | tr -d ' '; }
if ! has "$3"; then
  if ! out=$(git fetch -q origin "$2" 2>&1); then
    case "$out" in *"unable to access"*|*"returned error: 5"*|*"RPC failed"*|*"early EOF"*|*"Could not resolve"*|*"timed out"*) exit 76 ;; esac
  fi
  has "$3" || exit 44
fi
head=$(git rev-parse HEAD) || exit 121
own=$(git rev-parse --git-path index) || exit 121
{ [ -f "$own" ] && cp -- "$own" "$dir/index" 2>/dev/null; } || GIT_INDEX_FILE="$dir/index" git read-tree HEAD || exit 121
GIT_INDEX_FILE="$dir/index" git add -A || exit 122
tree=$(GIT_INDEX_FILE="$dir/index" git write-tree) || exit 122
paths=${REBASE_PATHS}
: >"$paths" || exit 121
if [ "$head" = "$3" ]; then printf 'current %s\\n' "$tree"; exit 0; fi
git merge-base "$3" "$head" >/dev/null 2>&1 || { printf 'unrelated %s\\n' "$tree"; exit 0; }
w=$(commit "$tree" -p "$head" -m rebase) || exit 123
git merge-tree --write-tree --name-only --no-messages -z "$3" "$w" >"$dir/merge"
code=$?
[ "$code" -le 1 ] || exit 124
result=$(tr '\\000' '\\n' <"$dir/merge" | head -n 1)
if [ "$code" = 1 ]; then
  tail -c +$((\${#result} + 2)) "$dir/merge" >"$paths" || exit 124
  printf 'conflict %s %s\\n' "$tree" "$(count "$paths")"
  exit 0
fi
git diff -z --name-only --no-renames "$tree" "$result" >"$paths" || exit 124
n=$(count "$paths")
if [ -z "$4" ]; then printf 'clean %s %s %s\\n' "$tree" "$result" "$n"; exit 0; fi
[ "$4" = "$tree" ] || { printf 'moved %s\\n' "$tree"; exit 0; }
umask 002
r=$(commit "$result" -p "$3" -m rebase) || exit 125
git add -A && git reset -q --hard "$r" && git reset -q "$3" || exit 125
printf 'applied %s %s %s\\n' "$tree" "$result" "$n"`

/**
 * The `run` call that moves the working copy onto commit `options.onto` of
 * `options.branch`, fetched from `origin` when the working copy lacks it:
 * every change the working copy holds, local commits included, merged onto
 * `onto` with git's own merge base, so a change both sides made alike merges
 * clean. It plans unless `options.expect` names the tree its plan answered;
 * then it applies a clean merge and leaves the working copy's own changes
 * uncommitted on top of `onto`, its commits flattened into them. A conflict
 * changes nothing. Decode its result with {@link rebased}.
 *
 * Git 2.38 or later (`merge-tree --write-tree`). It runs as long as
 * `options.timeoutSeconds`, at most `limits.maxTimeoutSeconds` (the default):
 * a remote that answers the whole history again for every fetch takes as
 * long as a clone.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const rebaseCall = (options: RebaseOptions): typeof Run.Type => ({
  tool: "run",
  command: script(REBASE, [".", options.branch, options.onto, options.expect ?? ""]),
  timeoutSeconds: options.timeoutSeconds ?? limits.maxTimeoutSeconds
})

/**
 * How a {@link rebaseCall} ended, from its `run` result: a refusal for a
 * workdir that isn't a git working copy (`not_a_repository`) or a commit
 * `origin` doesn't serve (`not_found`); `ToolUnavailable` for an `origin`
 * that couldn't be reached (`unavailable`), a run its timeout stopped
 * (`timeout`), or a step that failed (`unknown`, with its exit code).
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const rebased = (
  result: typeof RunResult.Type
): Effect.Effect<Rebased, ToolRefused | ToolUnavailable> => {
  if (result.timedOut) return Effect.fail(new ToolUnavailable({ code: "timeout" }))
  if (result.exitCode !== 0) return Effect.fail(failedWith(result.exitCode) as ToolRefused | ToolUnavailable)
  const [kind, tree = "", second = "", third = ""] = result.stdout.split("\n", 1)[0]!.split(" ")
  const count = Number(second)
  const rebased: Rebased | undefined = kind === "current"
    ? { _tag: "Current", tree }
    : kind === "unrelated"
    ? { _tag: "Unrelated", tree }
    : kind === "conflict"
    ? { _tag: "Conflicted", tree, paths: count }
    : kind === "clean"
    ? { _tag: "Planned", tree, result: second, paths: Number(third) }
    : kind === "moved"
    ? { _tag: "Moved", tree }
    : kind === "applied"
    ? { _tag: "Applied", tree, result: second, paths: Number(third) }
    : undefined
  return rebased === undefined || tree === ""
    ? Effect.fail(new ToolUnavailable({ code: "unknown" }))
    : Effect.succeed(rebased)
}

/**
 * The paths a {@link rebaseCall} left in {@link REBASE_PATHS}, read with the
 * `read` tool: each once, in git's order.
 *
 * @category operations
 * @since 1.0.0-rc.17
 */
export const rebasePaths = (read: typeof ReadResult.Type): ReadonlyArray<string> => [
  ...new Set(read.content.split("\0").filter((path) => path !== ""))
]
