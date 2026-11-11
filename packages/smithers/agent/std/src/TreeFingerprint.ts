/**
 * The identity of one directory tree, measured where the tree is.
 *
 * `@smthrs/agent/WorkspaceObservation` measures the host workspace around
 * every frame so the loop's mutation accounting is a fact rather than a
 * claim. A command routed into a container writes to a filesystem that walk
 * never sees: the SWE-bench rig bind-mounts the checkout into its container,
 * so a container edit lands on the host too, but a container Harbor or Pier
 * starts has no such mount, and every edit an agent made there read as an
 * idle frame. Measured 2026-09-22 on Terminal-Bench 4.0: `read_only_cap`
 * ended one run after twenty-four frames of container writes, and the claim
 * judge refused another's completion as "work this run never recorded".
 *
 * This module is the same measurement taken inside the container: one POSIX
 * shell script that lists every kept file under a directory with its size and
 * modification time, in sorted order, and prints one checksum of the listing.
 * `bash` runs it before and after a containerised command, inside the one
 * transport call that runs the command ({@link around}), and reports whether
 * the two answers differ under the reserved {@link key}. The harness reads
 * that key as a measured write, the way it reads `invalidProbe` as a measured
 * refusal.
 *
 * The measurements used to be two transport calls of their own, either side
 * of the command's. A transport call is a round trip: about 2.8 s each to a
 * remote sandbox on 2026-11-11 (Runta, through Harbor), so a `bash` call
 * that ran `ls` took 9.5 s, two thirds of it measuring.
 *
 * The same properties as the host walk, and the same stated limits:
 *
 * - **Identity, not content.** Size and mtime per file; a rewrite that
 *   restores both is invisible.
 * - **Pruning is the signal.** {@link defaultPrune} and
 *   {@link defaultIgnoreSuffixes} are the one list both measurements use, so
 *   a derived artifact the host walk skips is skipped here too.
 * - **A partial listing says so.** The listing stops at {@link maxPaths}, and
 *   a measurement that stopped there reports `complete: false`; `bash` then
 *   reports nothing rather than a guess.
 * - **Every tool it needs is POSIX or busybox.** `find -prune`, `stat -c`,
 *   `sort`, `head`, `cksum`, `grep -c` and `timeout` are in every Linux base
 *   image this has been run against, GNU and busybox alike. A container that
 *   lacks one answers with nothing, which is read as "unmeasured".
 *
 * {@link around} also enforces the command's deadline where the command runs,
 * with `sleep` and `kill` from the shell, and `timeout`, `setsid` and `env`
 * where the container has them; see its own description.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Random from "effect/Random"
import * as Prune from "./internal/Prune.ts"

/**
 * The reserved output key a flow reports a measured write under.
 *
 * A wire contract with the harness rather than a shared type, exactly as
 * `Probe.key` is: `@smthrs/harness` reads this key off a `Schema.Json` result
 * and must not depend on the tool library to do it. `true` means the tree the
 * call targeted differed after the call from before it; `false` means it was
 * measured and held still; absent means it was not measured.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const key = "mutated"

/**
 * Directory names never descended into.
 *
 * Every entry is a place a tool writes derived state while the run is working:
 * version-control internals, dependency trees, and the caches Python, Node,
 * Rust and their test runners keep beside the sources. A run that changes only
 * these has changed nothing it will be judged on.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultPrune: ReadonlyArray<string> = [
  ...Prune.repositoryDirectories,
  // Build and environment directories a search still reads, since a project
  // may keep sources under these names, but a measurement leaves out.
  "venv",
  "target"
]

/**
 * File and directory name suffixes left out of a measurement.
 *
 * Compiled output is the case that matters: several SWE-bench projects build
 * extensions in place, which drops `.so` files next to the `.py` files they
 * came from. Those move whenever the run executes its test suite, and
 * counting them would report every probe as an edit.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultIgnoreSuffixes: ReadonlyArray<string> = [
  ".pyc",
  ".pyo",
  ".pyd",
  ".so",
  ".o",
  ".a",
  ".dylib",
  ".class",
  ".egg-info"
]

/**
 * The largest number of files one measurement covers.
 *
 * The same bound the host walk uses, for the same reason: a listing that
 * stopped here covers a prefix chosen by sort order, and a prefix holding
 * still says nothing about the files being edited outside it.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxPaths = 50_000

/**
 * One measurement, as {@link parse} reads it off the script's output.
 *
 * @category models
 * @since 1.0.0
 */
export interface Measurement {
  /** The checksum of the whole listing; equal for two measurements of an unchanged tree. */
  readonly digest: string
  /** How many files the listing covered. */
  readonly paths: number
  /** Whether the listing covered the whole tree rather than a bounded prefix. */
  readonly complete: boolean
}

/** One name, single-quoted for a POSIX shell. Every name here is a constant without quotes in it. */
const quoted = (name: string): string => `'${name.replaceAll("'", `'\\''`)}'`

/**
 * The POSIX shell script that measures the current directory.
 *
 * Prints two lines: `cksum`'s `<crc> <bytes>` over the sorted listing, then
 * the number of listing lines. The listing is capped one past
 * {@link maxPaths} so the count alone says whether the bound was reached.
 * Errors from `find` and `stat` are discarded: a path that vanished mid-walk
 * is movement the next measurement reports, and a file the shell may not
 * stat is one it could not have measured either way.
 *
 * It exits 0 exactly when it measured. A shell without `find` or GNU-style
 * `stat -c` exits 1 before listing anything, because an empty listing from
 * tools that could not run would read as an empty tree. A tree with no file
 * in it is a measurement, zero lines, and exits 0: a task that starts in an
 * empty directory must see its first write as a move.
 *
 * @category constructors
 * @since 1.0.0
 */
export const script = (options: {
  readonly prune?: ReadonlyArray<string> | undefined
  readonly ignoreSuffixes?: ReadonlyArray<string> | undefined
} = {}): string => {
  const prune = (options.prune ?? defaultPrune).map((name) => `-name ${quoted(name)}`).join(" -o ")
  const skipped = (options.ignoreSuffixes ?? defaultIgnoreSuffixes)
    .map((suffix) => `! -name ${quoted(`*${suffix}`)}`)
    .join(" ")
  return [
    "set -f",
    "command -v find >/dev/null 2>&1 && stat -c '%s %Y %n' . >/dev/null 2>&1 || exit 1",
    `L=$(find . -xdev \\( ${prune} \\) -prune -o -type f ${skipped} -exec stat -c '%s %Y %n' {} + 2>/dev/null | LC_ALL=C sort | head -n ${
      maxPaths + 1
    })`,
    `printf '%s' "$L" | cksum`,
    `printf '%s' "$L" | grep -c '' || true`
  ].join("\n")
}

/**
 * Reads one measurement off the script's standard output.
 *
 * `undefined` for anything that is not two well-formed lines: the script did
 * not run, a tool it needs is missing, or the output was cut. An unmeasured
 * tree is reported as unmeasured, never as unchanged.
 *
 * @category conversions
 * @since 1.0.0
 */
export const parse = (stdout: string): Measurement | undefined => {
  const lines = stdout.trim().split("\n").map((line) => line.trim())
  if (lines.length !== 2) return undefined
  const checksum = /^(\d+) (\d+)$/.exec(lines[0]!)
  const count = /^(\d+)$/.exec(lines[1]!)
  if (checksum === null || count === null) return undefined
  const paths = Number(count[1])
  const bounded = paths > maxPaths
  return {
    digest: `${checksum[1]}:${checksum[2]}`,
    paths: bounded ? maxPaths : paths,
    complete: !bounded
  }
}

/**
 * Whether two measurements say the tree moved, or nothing at all.
 *
 * `true` and `false` are answers; `undefined` is the honest reading whenever
 * either measurement is absent or bounded, because a prefix that held still
 * is not a tree that held still.
 *
 * @category conversions
 * @since 1.0.0
 */
export const moved = (
  before: Measurement | undefined,
  after: Measurement | undefined
): boolean | undefined =>
  before === undefined || after === undefined || !before.complete || !after.complete
    ? undefined
    : before.digest !== after.digest

/**
 * The word {@link around} starts its one line of standard error with.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const marker = "__smithers_tree__"

/**
 * How long one measurement inside {@link around} may take, in seconds.
 *
 * A tree too large to list in a minute is reported unmeasured rather than
 * holding the command it brackets.
 *
 * @category constants
 * @since 1.0.0
 */
export const measureSeconds = 60

/**
 * How long a command stopped at its deadline has between the polite signal
 * and the one it cannot refuse, in seconds.
 *
 * Long enough for a test runner to flush the line it was writing; short
 * enough that a command ignoring `TERM` costs the caller little more than its
 * own deadline.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const graceSeconds = 2

/**
 * The most {@link around} adds to its command's deadline, in seconds: a
 * measurement before the command starts, the grace after the deadline, and a
 * measurement after the command stops. A host that bounds the whole transport
 * call bounds it at the deadline plus this, so the deadline inside the
 * container is the one that fires.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const overrunSeconds = 2 * measureSeconds + graceSeconds

/**
 * A fresh value that frames one call's line, so {@link split} reads only the
 * line the script wrote for that call: sixteen hex digits.
 *
 * A command can print anything to standard error, the shape of this line
 * included, and then kill the script before the real line is written. It
 * cannot print a nonce it was never given. The nonce reaches the script as an
 * argument and is never exported to the command's environment; a process that
 * reads its parent's argument list can still find it, which this guards
 * against no more than any other harness does.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const nonce: Effect.Effect<string> = Effect.map(
  Effect.all([Random.nextIntBetween(0, 0xffff_ffff), Random.nextIntBetween(0, 0xffff_ffff)]),
  (halves) => halves.map((half) => half.toString(16).padStart(8, "0")).join("")
)

/**
 * The seconds a deadline of `limitMillis` gives a containerised command:
 * rounded up to a whole second, and at least one.
 *
 * Whole seconds because `sleep` in a POSIX shell takes nothing finer, and a
 * `sleep` that refused a fraction would end the wait at once.
 *
 * @category conversions
 * @since 1.0.0-rc.17
 */
export const deadlineSeconds = (limitMillis: number): number => Math.max(1, Math.ceil(limitMillis / 1000))

/**
 * A POSIX shell script that measures the current directory, runs its
 * arguments as one command under a deadline, measures again, and exits with
 * the command's status:
 *
 *     sh -c <around> sh <nonce> <deadline-seconds> <program> <args…>
 *
 * Every value arrives as an argument, never as script text, so a command,
 * a nonce or a deadline cannot change what the script does.
 *
 * The command inherits standard input and both output streams untouched; a
 * measurement reads `/dev/null` and prints nothing. After the command, the
 * script writes one line to standard error, which {@link split} reads and
 * removes:
 *
 *     __smithers_tree__ <nonce> exited|deadline <crc> <bytes> <count> | <crc> <bytes> <count>
 *
 * **The deadline.** The command runs in the background of the script and a
 * watchdog sleeps beside it. At the deadline the watchdog sends `TERM`, waits
 * {@link graceSeconds}, sends `KILL`, and the line says `deadline`; the
 * script itself still takes the second measurement and exits normally, so the
 * transport returns everything the command printed. The command is started,
 * in order of preference:
 *
 * - by a GNU-compatible `timeout` (one that accepts `--preserve-status` and
 *   `-k`), which gives it a process group of its own and enforces the deadline
 *   plus {@link graceSeconds} as a second line of defence, late enough that
 *   the watchdog, which records that the deadline fired, always acts first;
 * - by `setsid`, which gives it a process group of its own;
 * - by the shell alone. The watchdog then reaches the command but not a
 *   process it started.
 *
 * A POSIX shell starts every background job with `SIGINT` and `SIGQUIT`
 * ignored, and a program such as Python reads that as "never raise
 * `KeyboardInterrupt`". Where `env` is GNU's (`--default-signal`), the command
 * starts with both at their defaults, as it would in the foreground; where it
 * is not (busybox), both stay ignored.
 *
 * A signal that ends the script itself (`TERM`, `HUP` or `INT`, from a
 * transport giving up on the call) stops the command the same way first.
 *
 * A side that could not be measured (no `timeout`, `find` or `stat -c`, a
 * listing that took longer than {@link measureSeconds}) is empty. A script
 * that is killed leaves no line at all, and its tree is unmeasured.
 *
 * @category constructors
 * @since 1.0.0
 */
export const around = (options: {
  readonly prune?: ReadonlyArray<string> | undefined
  readonly ignoreSuffixes?: ReadonlyArray<string> | undefined
} = {}): string =>
  [
    `__smithers_f=${quoted(script(options))}`,
    // A measurement counts only when its script exits 0, as it always has:
    // a listing no tool could produce must not read as an empty tree.
    `__smithers_m() { command -v timeout >/dev/null 2>&1 && __smithers_o=$(timeout ${measureSeconds} sh -c "$__smithers_f" </dev/null 2>/dev/null) && printf '%s' "$__smithers_o" | tr '\\n' ' '; }`,
    `__smithers_n=$1`,
    `__smithers_d=$2`,
    `shift 2`,
    `__smithers_b=$(__smithers_m)`,
    // A background job's standard input is /dev/null unless it is given one
    // explicitly, so the command takes the script's through descriptor 3.
    `exec 3<&0`,
    // A shell starts a background job with SIGINT and SIGQUIT ignored, and
    // GNU timeout keeps them ignored; GNU env puts them back.
    `env --default-signal=INT,QUIT true >/dev/null 2>&1 && set -- env --default-signal=INT,QUIT "$@"`,
    `__smithers_g=-`,
    `if timeout --preserve-status -k 1 1 true >/dev/null 2>&1; then`,
    // Its own deadline is the grace later, so the watchdog's, which records
    // that it fired, always comes first.
    `  set -- timeout -k ${graceSeconds} "$((__smithers_d + ${graceSeconds}))" "$@"`,
    `elif command -v setsid >/dev/null 2>&1; then`,
    `  set -- setsid "$@"`,
    `else`,
    `  __smithers_g=`,
    `fi`,
    `"$@" <&3 3<&- &`,
    `__smithers_p=$!`,
    `exec 3<&-`,
    // The command's process group where it has one of its own, else the command.
    `__smithers_k() { kill -"$1" "$__smithers_g$__smithers_p" 2>/dev/null; }`,
    // The watchdog's status is the record of the deadline: 3 once it fired,
    // anything else when the command ended first and the script stopped it.
    `(`,
    `  trap 'kill "$__smithers_s" 2>/dev/null; exit "$__smithers_t"' TERM`,
    `  __smithers_t=0`,
    `  sleep "$__smithers_d" & __smithers_s=$!`,
    `  wait "$__smithers_s" || exit 0`,
    `  __smithers_t=3`,
    `  __smithers_k TERM`,
    `  sleep ${graceSeconds} & __smithers_s=$!`,
    `  wait "$__smithers_s"`,
    `  __smithers_k KILL`,
    `  exit 3`,
    `) </dev/null >/dev/null 2>&1 &`,
    `__smithers_w=$!`,
    `trap '__smithers_i=1; __smithers_k TERM; sleep ${graceSeconds}; __smithers_k KILL' TERM HUP INT`,
    // A signal the trap answers ends a wait early, so wait until the command
    // itself has ended. Job notices go nowhere: standard error is the command's.
    `__smithers_i=1`,
    `while [ "$__smithers_i" = 1 ]; do __smithers_i=0; wait "$__smithers_p" 2>/dev/null; __smithers_c=$?; done`,
    `trap - TERM HUP INT`,
    `{ kill "$__smithers_w"; wait "$__smithers_w"; } 2>/dev/null`,
    `[ $? = 3 ] && __smithers_e=deadline || __smithers_e=exited`,
    `__smithers_a=$(__smithers_m)`,
    `printf '\\n%s %s %s %s| %s\\n' ${
      quoted(marker)
    } "$__smithers_n" "$__smithers_e" "$__smithers_b" "$__smithers_a" >&2`,
    `exit $__smithers_c`
  ].join("\n")

/** One side of the line {@link around} writes, as the two lines {@link parse} reads. */
const side = (text: string): Measurement | undefined => {
  const fields = /^(\d+) (\d+) (\d+)$/.exec(text.trim())
  return fields === null ? undefined : parse(`${fields[1]} ${fields[2]}\n${fields[3]}`)
}

/**
 * Separates the line {@link around} wrote for one call from a command's
 * standard error.
 *
 * Answers the standard error the command itself wrote, the two measurements,
 * and whether the deadline stopped the command. Only a last line framed with
 * this call's `nonce` counts: anything else, a line the command printed in
 * that shape included, is the command's own output. Standard error with no
 * such last line is returned whole, unmeasured and not timed out: the script
 * was killed, its output was cut, or the command did not run under
 * {@link around}.
 *
 * @category conversions
 * @since 1.0.0
 */
export const split = (stderr: string, nonce: string): {
  readonly stderr: string
  readonly before: Measurement | undefined
  readonly after: Measurement | undefined
  readonly timedOut: boolean
} => {
  const framed = `\n${marker} ${nonce} `
  const start = stderr.lastIndexOf(framed)
  const line = start === -1
    ? null
    : /^(exited|deadline) ([^|\n]*)\| ([^|\n]*)\n$/.exec(stderr.slice(start + framed.length))
  return line === null
    ? { stderr, before: undefined, after: undefined, timedOut: false }
    : {
      stderr: stderr.slice(0, start),
      before: side(line[2]!),
      after: side(line[3]!),
      timedOut: line[1] === "deadline"
    }
}
