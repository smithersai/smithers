/**
 * The shell text that runs a workflow step the way a GitHub runner does.
 *
 * A runner gives each step a set of variables (`GITHUB_WORKSPACE`,
 * `RUNNER_TEMP`, `CI`), three files a step writes for the steps after it
 * (`GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT`), and fills `${{ }}` into the
 * step's script before a shell reads it. This module writes that as shell
 * text, so a baseline step and a generated target run the same thing.
 *
 * A job keeps its state in one directory of its own under
 * `/tmp/smithers-ci-runner-<user id>`, named after the repository's place and
 * the job. The job's first step starts the state anew, as a runner empties
 * `RUNNER_TEMP` when a job starts, writes the shared functions there for the
 * steps after it, and removes the state of any checkout that is gone. A job
 * that is told its own temporary directory (`Inventory.jobTemporaryVariable`),
 * as a job on a machine of its own is, keeps its state there: no other job's
 * state is beside it, and it is gone when the job ends, so the job's next
 * run starts with none.
 *
 * A job's first step does not name its job: its text is the same for two
 * jobs that start alike, so it can run once for both. What it leaves is kept
 * under a mark made from what it does, and each job's second step takes a
 * copy of that as the job's own state.
 *
 * An expression that could not be finished when the workflow was read is
 * finished here, in the shell, for the forms a shell decides exactly: text
 * compared with text, `&&`, `||`, `!`, `format`, `contains`, `startsWith` and
 * `endsWith`. Any other form is refused when the workflow is read.
 *
 * @since 0.1.0
 */

import * as Contract from "../contract/Inventory.ts"
import {
  commitNote,
  commitQuestion,
  eventsVariable,
  jobTemporaryVariable,
  noParent,
  runnerEntry,
  stateVariable
} from "../contract/Inventory.ts"
import { shardOf } from "../contract/Shard.ts"
import {
  finish,
  formatPieces,
  type Part,
  type Residual,
  toText,
  truthy,
  type Value,
  type Variable,
  variablesOf
} from "./Expression.ts"

/**
 * What a job's steps share: the job's name for its state directory, the
 * matrix keys that tell its variants apart, and the runner variables whose
 * values are known when the workflow is read.
 *
 * @category models
 * @since 0.1.0
 */
export interface JobFacts {
  readonly id: string
  readonly matrixKeys: ReadonlyArray<string>
  /** The job's matrix variants: what an expression over the matrix is worked out for. */
  readonly variants?: ReadonlyArray<Readonly<Record<string, string>>> | undefined
  readonly variables: Readonly<Record<string, string>>
  /** The runner variables only GitHub can fill, each with a value of the right shape (`Contexts.standIns`). */
  readonly standIns?: Readonly<Record<string, string>> | undefined
  /** The event file's JSON, with `commitMark` and `parentMark` where the commit and its first parent go. */
  readonly event: string
  /** The event the job's workflow is replayed as: a replay's event file for the job is named after it. */
  readonly eventName?: string | undefined
}

/**
 * What tells a tool not to call a server that decides nothing a step does, with the value that tells it. A step that
 * reaches the network cannot be reused, so every step is given each of them unless its workflow, its job or itself
 * sets one:
 *
 * - `DO_NOT_TRACK=1`: Turborepo, and every tool that keeps that convention, reports no use
 *   (turbo.build/repo/docs/telemetry).
 * - `WRANGLER_SEND_METRICS=false`: Wrangler sends no usage metrics to sparrow.cloudflare.com
 *   (workers-sdk/packages/wrangler/telemetry.md).
 * - `WRANGLER_HIDE_BANNER=true`: Wrangler prints no banner, and with it asks npm for no newer version of itself
 *   (developers.cloudflare.com/workers/wrangler/system-environment-variables).
 *
 * @category constants
 * @since 0.1.0
 */
export const quietTools: ReadonlyArray<readonly [string, string]> = [
  ["DO_NOT_TRACK", "1"],
  ["WRANGLER_SEND_METRICS", "false"],
  ["WRANGLER_HIDE_BANNER", "true"]
]

/**
 * What one step needs from its runner.
 *
 * - `key`: the step's name in the job's state, in upper case.
 * - `after`: the mark of the job's first step, whose state a later step takes over; `undefined` for the first
 *   step itself, which starts the state.
 * - `job`: the job's key, given as `GITHUB_JOB`. A first step is given none unless it asks for the variable or for
 *   a directory a runner gives a job (`RUNNER_TEMP`, `RUNNER_TOOL_CACHE`), so two jobs that start with the same
 *   step share it. A first step that is given its job starts the job's own state, and every step of the job has
 *   the same `RUNNER_TEMP`.
 * - `second`: the step is the second of its job and the first was given no job, so it starts the job's own state
 *   from what the first step left. A step split from another keeps the state the ones split with it started.
 * - `apart`: the step takes no place among the job's steps, because a replay may leave it out: it only installs
 *   packages, and the machine may have them. It starts from a copy of what the steps before it left (`after` and
 *   `second` say which), leaves nothing, and stops when it wrote a value for later steps. The steps around it are
 *   the first, the second and the rest whether or not it runs.
 * - `before`: the keys of the job's steps before this one that leave values, in the order they run. The step is
 *   given what those steps wrote to `GITHUB_ENV` and `GITHUB_PATH` and nothing else: a value a later step left on
 *   an earlier run of the job is not this step's to read.
 * - `cwd`: the directory the step is started in, from the repository root.
 * - `directory`: a directory decided while the job runs, which the step enters from the root before its script.
 * - `start`: the shell and its flags; the script follows `-c`.
 * - `own`: the variables the step sets itself, which `GITHUB_ENV` never replaces.
 * - `keeps`: values worked out once here and kept for later steps under a name, as the `with:` values of a local
 *   action are worked out when the action starts.
 * - `condition`: the rest of the step's `if:`, or `undefined` when it always runs.
 * - `outer`: the variables of the job and the workflow whose values are decided while the job runs.
 * - `env`: the step's own variables whose values are decided while the job runs.
 * - `fills`: the `${{ }}` texts left in the script, each with the expression that replaces it.
 * - `commit`: the step's script names the commit or the run, so its verdict belongs to one commit.
 * - `ownCi`: the workflow, the job or the step sets `CI`, and the step keeps that value. Any other step is given
 *   `CI=true`, as a runner gives it, whatever the machine it runs on holds under that name.
 * - `ownQuiet`: the variables of `quietTools` the workflow, the job or the step sets; the step keeps their values. It
 *   is given each other one with its value, whatever the machine holds.
 * - `action`: the step's own name, given as `GITHUB_ACTION`: its `id`, or `__run` and its place in the job.
 * - `store`: the step keeps files from one run to the next, as a cache step does. It is told where in
 *   `SMITHERS_CI_CACHE_STORE`: under the directory Smithers build keeps its cache in when the step is a target,
 *   under the one `Inventory.stateVariable` names in a baseline, and else in the user's own cache directory.
 * - `limit`: the most seconds the step may run, from `timeout-minutes`. A step that runs longer is stopped with
 *   every program it started, and has failed.
 * - `python`: a step before this one set Python up, as `actions/setup-python` does. The step finds `python`,
 *   `python3`, `pip` and `pip3` first on its `PATH`, each running the machine's Python 3, as the action leaves them
 *   on a runner. They are made in the job's tool directory (`RUNNER_TOOL_CACHE`), which is the job's own.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepFacts {
  readonly key: string
  readonly after: string | undefined
  readonly second: boolean
  readonly apart: boolean
  readonly job: string | undefined
  readonly before: ReadonlyArray<string>
  readonly cwd: string
  readonly directory: ReadonlyArray<Part> | undefined
  readonly start: ReadonlyArray<string>
  readonly own: ReadonlyArray<string>
  readonly keeps: ReadonlyArray<readonly [name: string, parts: ReadonlyArray<Part>]>
  readonly condition: Residual | undefined
  readonly outer: ReadonlyArray<readonly [name: string, parts: ReadonlyArray<Part>]>
  readonly env: ReadonlyArray<readonly [name: string, parts: ReadonlyArray<Part>]>
  readonly fills: ReadonlyArray<readonly [written: string, residual: Residual]>
  readonly commit: boolean
  readonly ownCi?: boolean | undefined
  readonly ownQuiet?: ReadonlyArray<string> | undefined
  readonly action?: string | undefined
  readonly limit?: number | undefined
  readonly store?: boolean | undefined
  readonly python?: boolean | undefined
}

/**
 * The runner text of a step with the mark of its job's first step, or why
 * its expressions cannot be finished in a shell. `alone` is the text of a
 * first step that turns out to be the only step of its job: nothing reads
 * what it leaves, so it leaves nothing and looks at no state but its own.
 *
 * @category models
 * @since 0.1.0
 */
export type Written =
  | { readonly text: string; readonly mark: string; readonly alone: string }
  | { readonly problem: string }

/** Ends a compilation that cannot go on. Caught where it started. */
class Refused {
  readonly why: string
  constructor(why: string) {
    this.why = why
  }
}

/**
 * One word for a POSIX shell, always in single quotes.
 *
 * @category shell
 * @since 0.1.0
 * @throws {never}
 */
export const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

const marker = "__SMITHERS_CI_LIB__"

/** The text Smithers build replaces, in a target's script, with the directory it keeps its cache in. */
const cacheDirectoryToken = "{smthrs:cache-directory}"

/**
 * Where the commit goes in `JobFacts.event`: the contract's mark.
 *
 * @category constants
 * @since 0.1.0
 */
export const commitMark = Contract.commitMark

/**
 * Where the commit's first parent goes in `JobFacts.event`: the contract's mark.
 *
 * @category constants
 * @since 0.1.0
 */
export const parentMark = Contract.parentMark

/** The event file's text as shell words: all of it in single quotes, but the commit and its parent. */
const eventText = (event: string): string =>
  quote(event)
    .replaceAll(JSON.stringify(commitMark).slice(1, -1), `'"$__sha"'`)
    .replaceAll(JSON.stringify(parentMark).slice(1, -1), `'"$__parent"'`)

/**
 * The functions every step of a job shares. A value is held as text with a
 * tag: `s` for text, `t` for a value that is true and is not text, `f` for
 * one that is false and is not text (`null`, `false`, `0`).
 */
const library = (job: JobFacts): string =>
  [
    `__ci_fail() { echo "smithers-ci: $1" >&2; exit 1; }`,
    // GitHub compares text without case. Here the letters a to z are folded. Text with other letters that is not
    // equal as written may still be equal on GitHub, which this cannot tell: the step stops and says so.
    `__ci_upper() { __u=$(printf '%sx' "$1" | LC_ALL=C tr 'a-z' 'A-Z'); __u=\${__u%X}; }`,
    `__ci_plain() {`,
    `  [ -z "$(printf %s "$1" | LC_ALL=C tr -d '\\000-\\177')" ] ||`,
    `    __ci_fail "text with letters beyond a to z is compared without case, which only GitHub decides"`,
    `}`,
    `__ci_folded() { __ci_plain "$1$2"; __ci_upper "$1"; __a=$__u; __ci_upper "$2"; __b=$__u; }`,
    `__ci_same() { [ "$1" = "$2" ] && return 0; __ci_folded "$1" "$2"; [ "$__a" = "$__b" ]; }`,
    `__ci_true() { [ "$1" = t ] || { [ "$1" = s ] && [ -n "$2" ]; }; }`,
    // Text equals null when the number it spells is 0, and an empty text spells 0.
    `__ci_zero_re='^[[:space:]]*([+-]?(0+\\.?0*|\\.0+)([eE][+-]?[0-9]+)?|0[xX]0+|0[oO]0+)?[[:space:]]*$'`,
    `__ci_zero() { [[ $1 =~ $__ci_zero_re ]]; }`,
    `__ci_equal() {`,
    `  if [ "$1" = s ] && [ "$3" = s ]; then __ci_same "$2" "$4"`,
    `  elif [ "$1" = s ]; then __ci_zero "$2"`,
    `  elif [ "$3" = s ]; then __ci_zero "$4"`,
    `  else return 0; fi`,
    `}`,
    `__ci_has() { case $1 in *"$2"*) return 0;; esac; __ci_folded "$1" "$2"; case $__a in *"$__b"*) return 0;; esac; return 1; }`,
    `__ci_starts() { case $1 in "$2"*) return 0;; esac; __ci_folded "$1" "$2"; case $__a in "$__b"*) return 0;; esac; return 1; }`,
    `__ci_ends() { case $1 in *"$2") return 0;; esac; __ci_folded "$1" "$2"; case $__a in *"$__b") return 0;; esac; return 1; }`,
    `__ci_read() { __v=; __t=f; [ -f "$1" ] || return 0; IFS= read -r -d '' __v < "$1"; __t=s; }`,
    `__ci_sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }`,
    // hashFiles: the SHA-256 of each file's SHA-256, in the order written; empty when no file is there.
    `__ci_hash() {`,
    `  __v=; __t=s; __h=`,
    `  for __f in "$@"; do`,
    // GitHub hashes every file under a directory, in an order only its runner's disk decides.
    `    [ ! -d "$__root/$__f" ] || __ci_fail "hashFiles of the directory $__f is worked out only on GitHub"`,
    `    [ -f "$__root/$__f" ] || continue`,
    `    __d=$(__ci_sha < "$__root/$__f") || __ci_fail "could not hash $__f"`,
    `    __h=$__h\${__d%% *}`,
    `  done`,
    `  [ -n "$__h" ] || return 0`,
    `  __v=$(printf "$(printf %s "$__h" | sed 's/../\\\\x&/g')" | __ci_sha) || __ci_fail "could not hash"`,
    `  __v=\${__v%% *}`,
    `}`,
    // The files of the checkout whose path matches one of the expressions before `--` and none after it, hashed
    // in sorted order: the SHA-256 of their SHA-256s. Empty when there is none. A cache key is made of it, which
    // has to be the same from one run to the next and is never compared with GitHub's.
    `__ci_glob() {`,
    `  __v=; __t=s; __take=(); __leave=()`,
    `  while [ "$1" != -- ]; do __take+=(-e "$1"); shift; done`,
    `  shift`,
    `  for __f in "$@"; do __leave+=(-e "$__f"); done`,
    `  __h=$(cd -- "$__root" && find . -type f ! -path './.git/*' | sed 's|^\\./||' | LC_ALL=C grep -E "\${__take[@]}" | LC_ALL=C sort)`,
    `  [ "\${#__leave[@]}" -eq 0 ] || __h=$(printf '%s\\n' "$__h" | LC_ALL=C grep -v -E "\${__leave[@]}")`,
    `  [ -n "$__h" ] || return 0`,
    `  __v=$(cd -- "$__root" && printf '%s\\n' "$__h" | while IFS= read -r __f; do __ci_sha < "$__f"; done | __ci_sha) || __ci_fail "could not hash"`,
    `  __v=\${__v%% *}`,
    `}`,
    // The variables a runner gives every step.
    `__ci_start() {`,
    `  mkdir -p -- "$__state/temp" "$__state/tool-cache" "$__state/steps" || exit 1`,
    // The job's name is given by the line after this, to the step that is told its job. What the machine holds
    // under that name is not the workflow's.
    `  unset GITHUB_JOB __limit ${stateVariable}`,
    `  case $(uname -m) in arm64|aarch64) RUNNER_ARCH=ARM64;; x86_64|amd64) RUNNER_ARCH=X64;; *) RUNNER_ARCH=$(uname -m);; esac`,
    `  case $(uname -s) in Linux) RUNNER_OS=Linux;; Darwin) RUNNER_OS=macOS;; *) RUNNER_OS=Windows;; esac`,
    `  export RUNNER_OS RUNNER_ARCH GITHUB_WORKSPACE="$__root" RUNNER_TEMP="$__state/temp" RUNNER_TOOL_CACHE="$__state/tool-cache"`,
    // A workflow may set CI itself. Every other runner variable is the runner's to set.
    `  export CI="\${CI-true}"${
      Object.entries({ ...job.standIns, ...job.variables }).map(([name, held]) => ` ${name}=${quote(held)}`).join("")
    }`,
    `}`,
    // What differs from one run to the next: the commit, the run's id, number and attempt, and the event file. A
    // runner gives every step all of them, and so does a replay, for the commit it replays: they are in the
    // step's environment already, and the step finds the event file of its workflow's event among the ones the
    // replay wrote for the commit. A step nobody gave them works them out itself: the commit the checkout stands
    // on, an id made from it, and as the run's number the count of commits up to it. Where there is no
    // repository there is no commit to give: a step that reads it fails, and any other runs without these.
    //
    // The names of these variables, and of the one that says where the event file is, are put together here and
    // never written out. Smithers build reuses a result at another commit unless the step's own text names one of
    // them, and this text is every step's.
    //
    // Where the replay wrote the event files is the replay's to know: the step's own script finds the event file
    // and no variable of the program that runs it.
    `__ci_commit() {`,
    `  __g=GITHUB_`,
    `  __events=\${${eventsVariable}-}`,
    `  unset ${eventsVariable}`,
    `  eval "__sha=\\\${\${__g}SHA-}"`,
    `  if [ -n "$__sha" ]; then`,
    `    [ -z "$__events" ] || export "\${__g}EVENT_PATH=$__events/${job.eventName ?? "push"}.json"`,
    `    return 0`,
    `  fi`,
    // A runner says which commit it is, and a step that does not name the commit reads nothing to learn it. So
    // where nobody said, the question is asked by a git marked as this text's own (`Inventory.commitQuestion`),
    // whose reads are none of the step's, and a step reuses at the next commit what it reuses on a runner.
    `  __ask=(git -c ${commitQuestion}); [ -z "$1" ] || __ask=(git)`,
    `  __sha=$("\${__ask[@]}" -C "$__root" rev-parse --verify --quiet HEAD) || {`,
    `    [ -n "$1" ] || return 0`,
    `    __ci_fail "this step reads the commit, and git cannot be read in $__root"`,
    `  }`,
    `  __count=$("\${__ask[@]}" -C "$__root" rev-list --count HEAD) || __count=1`,
    `  export "\${__g}SHA=$__sha" "\${__g}WORKFLOW_SHA=$__sha" "\${__g}RUN_ID=$((${Contract.runIdBase} + 16#\${__sha:0:9}))"`,
    `  export "\${__g}RUN_NUMBER=$__count" "\${__g}RUN_ATTEMPT=1" "\${__g}EVENT_PATH=$__state/event.json"`,
    `  __parent=$("\${__ask[@]}" -C "$__root" rev-parse --verify --quiet 'HEAD^') || __parent=${noParent}`,
    `  printf '%s\\n' ${eventText(job.event)} > "$__state/event.json"`,
    `}`,
    // What the steps before this one wrote to GITHUB_ENV and GITHUB_PATH, step by step in the order they ran. A
    // step's own variables, and the runner's, stay. Each step keeps what it wrote in a place of its own, named
    // after it, and a step asks only the places of the steps before it: it lists no directory, so what a later
    // step left there on an earlier run is nothing it reads.
    `__ci_load() {`,
    `  for __k in $__before; do`,
    `    if [ -f "$__state/steps/$__k/vars" ]; then`,
    `      while IFS= read -r __n; do`,
    `        case " $1 " in *" $__n "*) continue;; esac`,
    `        case $__n in GITHUB_*|RUNNER_*) continue;; esac`,
    `        IFS= read -r -d '' __v < "$__state/steps/$__k/env.$__n"`,
    `        export "$__n=$__v"`,
    `      done < "$__state/steps/$__k/vars"`,
    `    fi`,
    `    if [ -f "$__state/steps/$__k/path" ]; then`,
    `      while IFS= read -r __p; do PATH=$__p:$PATH; done < "$__state/steps/$__k/path"`,
    `    fi`,
    `  done`,
    `  export PATH`,
    `}`,
    // The value the steps before this one last gave a variable through GITHUB_ENV, or `f` when none did.
    `__ci_given() {`,
    `  __v=; __t=f`,
    `  for __k in $__before; do`,
    `    [ -f "$__state/steps/$__k/env.$1" ] || continue`,
    `    IFS= read -r -d '' __v < "$__state/steps/$__k/env.$1"; __t=s`,
    `  done`,
    `}`,
    // A step starts with nothing in its own place: what it left on an earlier run is gone before it runs or is
    // skipped. Steps split from one step share a place, and each keeps what the ones before it wrote there.
    `__ci_fresh() { [ -n "\${__smithers_ci_part-}" ] || rm -rf -- "$__state/steps/$1" || exit 1; }`,
    `__ci_outcome() { mkdir -p -- "$__state/steps/$1" && printf %s "$2" > "$__state/steps/$1/outcome" || exit 1; }`,
    // A directory decided while the job runs: one of the repository, as a step's `working-directory` is.
    `__ci_enter() {`,
    `  __to=$1`,
    `  case $__to in "$__root"/*) __to=\${__to#"$__root"/};; "$__root") __to=.;; esac`,
    `  case $__to in /*) __ci_fail "the step's directory $1 is outside the repository";; esac`,
    `  cd -- "$__root/$__to" 2>/dev/null || __ci_fail "the step's directory $1 is not in the repository"`,
    `  case $(pwd -P)/ in "$(cd -- "$__root" && pwd -P)"/*) ;; *) __ci_fail "the step's directory $1 is outside the repository";; esac`,
    `}`,
    `__ci_keep() { mkdir -p -- "$__state/kept" && printf %s "$2" > "$__state/kept/$1" || exit 1; }`,
    // Puts each value in the place of its \${{ }} text, in one pass from the left: a value is never read again
    // as a \${{ }} text, as it is not on GitHub.
    `__ci_fill() {`,
    `  __rest=$__script; __script=`,
    `  while :; do`,
    `    __at=; __before=`,
    `    for __i in "\${!__fk[@]}"; do`,
    `      case $__rest in`,
    `        *"\${__fk[__i]}"*)`,
    `          __head=\${__rest%%"\${__fk[__i]}"*}`,
    `          if [ -z "$__at" ] || [ \${#__head} -lt \${#__before} ]; then __at=$__i; __before=$__head; fi;;`,
    `      esac`,
    `    done`,
    `    [ -n "$__at" ] || break`,
    `    __script=$__script$__before\${__fv[__at]}`,
    `    __rest=\${__rest#"$__before\${__fk[__at]}"}`,
    `  done`,
    `  __script=$__script$__rest`,
    `}`,
    `__ci_skip() {`,
    `  __ci_fresh "$1"`,
    `  __ci_outcome "$1" skipped`,
    `  echo "smithers-ci: not run, its condition is false"`,
    `  exit 0`,
    `}`,
    // The two forms a runner reads: NAME=value, and NAME<<MARK with the value on the lines up to MARK.
    `__ci_each() {`,
    `  __file=$1; shift`,
    `  while IFS= read -r __line || [ -n "$__line" ]; do`,
    `    [ -n "$__line" ] || continue`,
    `    __eq=\${__line%%=*}; __he=\${__line%%<<*}`,
    `    if [ "$__he" != "$__line" ] && [ \${#__he} -lt \${#__eq} ]; then`,
    `      __name=$__he; __mark=\${__line#*<<}; __value=; __sep=; __done=`,
    `      while IFS= read -r __line || [ -n "$__line" ]; do`,
    `        if [ "$__line" = "$__mark" ]; then __done=1; break; fi`,
    `        __value=$__value$__sep$__line; __sep=$'\\n'`,
    `      done`,
    `      [ -n "$__done" ] || __ci_fail "a value the step wrote for later steps has no closing line"`,
    `    elif [ "$__eq" != "$__line" ]; then`,
    `      __name=$__eq; __value=\${__line#*=}`,
    `    else`,
    `      __ci_fail "a line the step wrote for later steps is neither NAME=value nor NAME<<MARK"`,
    `    fi`,
    `    "$@" "$__name" "$__value"`,
    `  done < "$__file"`,
    `}`,
    `__ci_output() {`,
    `  __ci_upper "$2"`,
    `  case $__u in ''|*[!A-Z0-9_-]*) return 0;; esac`,
    `  printf %s "$3" > "$__state/steps/$1/out.$__u" || exit 1`,
    `}`,
    `__ci_env() {`,
    `  case $1 in`,
    `    NODE_OPTIONS) __ci_fail "a step may not set NODE_OPTIONS for later steps: GitHub refuses it";;`,
    `    ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) __ci_fail "a step set a variable for later steps under a name a shell cannot hold";;`,
    `  esac`,
    `  printf %s "$2" > "$__state/steps/$__key/env.$1" && printf '%s\\n' "$1" >> "$__state/steps/$__key/vars" || exit 1`,
    `}`,
    // Runs the step's script and stops it at its limit, as a runner stops a step at its `timeout-minutes`. The
    // script runs in a process group of its own, so the programs it started stop with it: the group is asked to
    // stop, given ten seconds, and then ended. A signal to this shell is passed on the same way, and the shell
    // waits until the script is gone. A read from the terminal fails in the script, as where there is none.
    `__ci_stop() {`,
    `  kill -TERM -- "-$__pid" 2>/dev/null`,
    `  [ -z "$__signal" ] || return 0`,
    `  __signal=1`,
    `  set -m`,
    `  { sleep 10 && kill -KILL -- "-$__pid"; } < /dev/null > /dev/null 2>&1 &`,
    `  __end=$!`,
    `  set +m`,
    `}`,
    `__ci_limited() {`,
    `  __late="$__files.late"; __signal=; __end=`,
    `  set -m`,
    `  ( trap '' TTIN TTOU; exec "$@" -c "$__script" ) < /dev/null &`,
    `  __pid=$!`,
    // The mark says the limit ran out. It is written only while the script is still there, and the script is
    // stopped whether or not the mark could be written.
    `  { sleep "$__limit" && kill -0 -- "-$__pid" && { : > "$__late"; kill -TERM -- "-$__pid" && sleep 10 && kill -KILL -- "-$__pid"; }; } < /dev/null > /dev/null 2>&1 &`,
    `  __watch=$!`,
    `  set +m`,
    `  trap __ci_stop TERM INT HUP`,
    // A signal ends `wait` at once, with the script still there.
    `  while :; do`,
    `    wait "$__pid" 2>/dev/null`,
    `    __status=$?`,
    `    kill -0 "$__pid" 2>/dev/null || break`,
    `  done`,
    // From here a signal starts nothing new: the script is gone, and what is left is stopped below.
    `  trap '' TERM INT HUP`,
    // The script was told to stop and is gone. What it started has the rest of its ten seconds.
    `  if [ -e "$__late" ] || [ -n "$__signal" ]; then`,
    `    __n=0`,
    `    while kill -0 -- "-$__pid" 2>/dev/null && [ "$__n" -lt 100 ]; do sleep 0.1; __n=$((__n + 1)); done`,
    `    kill -KILL -- "-$__pid" 2>/dev/null`,
    `  fi`,
    `  for __job in "$__watch" $__end; do kill -KILL -- "-$__job" 2>/dev/null; wait "$__job" 2>/dev/null; done`,
    `  trap - TERM INT HUP`,
    `  if [ -e "$__late" ]; then`,
    `    rm -f -- "$__late"`,
    `    echo "smithers-ci: stopped, it ran longer than the $__allowed its timeout-minutes allows" >&2`,
    `    __status=124`,
    `  elif [ -n "$__signal" ] && [ "$__status" -eq 0 ]; then`,
    `    __status=143`,
    `  fi`,
    `}`,
    `__ci_run() {`,
    `  __key=$1; __script=$2; shift 2`,
    `  __ci_fresh "$__key"`,
    `  __files=$(mktemp -d "$__state/step.XXXXXX") || exit 1`,
    `  : > "$__files/output"; : > "$__files/env"; : > "$__files/path"; : > "$__files/summary"; : > "$__files/state"`,
    `  export GITHUB_OUTPUT="$__files/output" GITHUB_ENV="$__files/env" GITHUB_PATH="$__files/path"`,
    `  export GITHUB_STEP_SUMMARY="$__files/summary" GITHUB_STATE="$__files/state"`,
    // The files a step declares artifacts in and reads the job's artifacts from. Nothing is uploaded here, so
    // the job has none.
    `  : > "$__files/artifacts"; printf '{}' > "$__files/artifacts-list"`,
    `  export GITHUB_ARTIFACTS="$__files/artifacts" GITHUB_ARTIFACTS_LIST="$__files/artifacts-list"`,
    // A shell reports a program a signal ended with a line that holds the words it started it with. This shell
    // writes that line where nobody reads it: the script's error output is its own, and GitHub's runner, which
    // starts the script itself, writes no such line.
    `  if [ -n "\${__limit-}" ]; then __ci_limited "$@"`,
    `  else { "$@" -c "$__script" 2>&9 9>&-; } 9>&2 2>/dev/null; __status=$?; fi`,
    `  [ "$__status" -eq 0 ] || exit "$__status"`,
    // A step a replay may leave out leaves nothing for later steps. One that tried is stopped: without it the
    // steps after it would run on other values.
    `  if [ -n "\${__apart-}" ]; then`,
    `    [ ! -s "$__files/output" ] && [ ! -s "$__files/env" ] && [ ! -s "$__files/path" ] ||`,
    `      __ci_fail "a step that only installs packages wrote a value for later steps, which a replay that leaves the step out cannot give them"`,
    `    exit 0`,
    `  fi`,
    `  mkdir -p -- "$__state/steps/$__key" || exit 1`,
    `  __ci_each "$__files/output" __ci_output "$__key"`,
    `  __ci_each "$__files/env" __ci_env`,
    `  while IFS= read -r __p || [ -n "$__p" ]; do`,
    `    [ -z "$__p" ] || printf '%s\\n' "$__p" >> "$__state/steps/$__key/path" || exit 1`,
    `  done < "$__files/path"`,
    `  __ci_outcome "$__key" success`,
    `  rm -rf -- "$__files"`,
    `  exit 0`,
    `}`
  ].join("\n")

/** Where a variable's value is while the job runs: shell text that sets `__v` and `__t`. */
const loadOf = (found: Variable): string => {
  const [kind, ...rest] = found.id.split(":")
  const detail = rest.join(":")
  if (kind === "output") {
    const [step, name] = detail.split("/") as [string, string]
    return `__ci_read "$__state/steps/${step}/out.${name}"`
  }
  if (kind === "outcome") return `__ci_read "$__state/steps/${detail}/outcome"`
  if (kind === "env") {
    const { name, held } = JSON.parse(detail) as { readonly name: string; readonly held: string | null }
    const fallback = held === null ? `__v=; __t=f` : `__v=${quote(held)}; __t=s`
    return `__ci_given ${name}; [ "$__t" = s ] || { ${fallback}; }`
  }
  if (kind === "kept") return `__ci_read "$__state/kept/${detail}"; __t=s`
  if (kind === "process") return `__v=\${${detail}-}; __t=s`
  if (kind === "hash") return `__ci_hash ${(JSON.parse(detail) as ReadonlyArray<string>).map(quote).join(" ")}`
  if (kind === "glob") {
    const files = JSON.parse(detail) as { readonly take: ReadonlyArray<string>; readonly leave: ReadonlyArray<string> }
    return `__ci_glob ${[...files.take, "--", ...files.leave].map(quote).join(" ")}`
  }
  if (kind === "matrix") return `__v='\${{ matrix.${detail} }}'; __t=s`
  if (kind === "path") return `__v=$__root/${quote(detail)}; __t=s`
  if (kind === "base") {
    return `__v=$(git -C "$__root" rev-parse --verify --quiet 'HEAD^') || `
      + `__ci_fail "this commit has no parent to stand for the base of ${detail}"; __t=s`
  }
  if (kind === "before") {
    return `__v=$(git -C "$__root" rev-parse --verify --quiet 'HEAD^') || `
      + `__v=0000000000000000000000000000000000000000; __t=s`
  }
  return `__v=$${shellNames.get(kind as string) as string}; __t=s`
}

/** The variables a step reads from its runner's own shell variables. */
const shellNames: ReadonlyMap<string, string> = new Map([
  ["sha", "GITHUB_SHA"],
  ["runid", "GITHUB_RUN_ID"],
  ["runnumber", "GITHUB_RUN_NUMBER"],
  ["runattempt", "GITHUB_RUN_ATTEMPT"],
  ["os", "RUNNER_OS"],
  ["workspace", "__root"],
  ["temp", "RUNNER_TEMP"],
  ["toolcache", "RUNNER_TOOL_CACHE"],
  ["arch", "RUNNER_ARCH"]
])

/**
 * The ids a `Variable` may have, by their first part. An expression names a
 * runtime value with one of these and the runner text knows where it is.
 *
 * - `output:STEP/NAME`: what a step wrote to `GITHUB_OUTPUT`, both in upper case.
 * - `outcome:STEP`: `success` or `skipped`.
 * - `env:{"name","held"}`: a variable a step may have set through `GITHUB_ENV`, and its value when none did.
 * - `process:NAME`: a variable of the job or the workflow, as the step finds it once `GITHUB_ENV` is loaded.
 * - `kept:NAME`: a value an earlier step of the job worked out and kept (`StepFacts.keeps`).
 * - `hash:[...]`: `hashFiles` of the files named, from the repository root.
 * - `glob:{take,leave}`: the files patterns name (`Glob.Files`), hashed in sorted order, for a cache key.
 * - `matrix:key`: a matrix value, filled in for each variant.
 * - `path:dir`: a directory of the repository.
 * - `base:what`: the commit's first parent, which must exist; `before`: the same, or 40 zeros.
 * - `sha`, `runid`, `runnumber`, `runattempt`, `os`, `workspace`, `temp`, `toolcache`, `arch`.
 *
 * @category constants
 * @since 0.1.0
 */
export const variableKinds: ReadonlyArray<string> = [
  "output",
  "outcome",
  "env",
  "process",
  "kept",
  "hash",
  "glob",
  "matrix",
  "path",
  "base",
  "before",
  ...shellNames.keys()
]

interface Emitter {
  readonly lines: Array<string>
  readonly variants: ReadonlyArray<Readonly<Record<string, string>>>
  count: number
}

const matrixPrefix = "matrix:"

/** True for an expression that reads the matrix and nothing else decided while the job runs. */
const overMatrix = (node: Residual, emitter: Emitter): boolean => {
  const read = variablesOf(node)
  return emitter.variants.length > 0 && read.length > 0 && read.every((found) => found.id.startsWith(matrixPrefix))
}

/** A matrix value as GitHub holds it: a key written as a number or a boolean gives one, and a key a variant lacks is `null`. */
const matrixValue = (found: Variable, variant: Readonly<Record<string, string>>): Value => {
  const text = variant[found.id.slice(matrixPrefix.length)]
  if (text === undefined) return null
  if (!found.typed) return text
  if (text === "true" || text === "false") return text === "true"
  return String(Number(text)) === text ? Number(text) : text
}

const callTests: ReadonlyMap<string, string> = new Map([
  ["contains", "__ci_has"],
  ["startswith", "__ci_starts"],
  ["endswith", "__ci_ends"]
])

/** What a value can be when the job runs: text, empty text, `null`, `true`, `false`, or something a shell cannot tell. */
type Kind = "text" | "empty" | "null" | "true" | "false" | "other"

const truthyKinds: ReadonlyArray<Kind> = ["text", "true", "other"]
const falsyKinds: ReadonlyArray<Kind> = ["empty", "null", "false", "other"]

/**
 * Every kind of value a residual can give. `a && b` gives `a` when it is false and `b` otherwise, so
 * `x == 'y' && 'one' || 'two'` is always text. A number, a list and a variable that is a number or a boolean on
 * GitHub are `other`: their text is known and what they are is not.
 */
const kindsOf = (node: Residual): ReadonlyArray<Kind> => {
  if (node.kind === "literal") {
    const held = node.value
    if (typeof held === "string") return [held === "" ? "empty" : "text"]
    if (held === null) return ["null"]
    // Whether a written number is true is known. A list or a mapping is never used with a run-time value.
    return typeof held === "object" ? ["other"] : [truthy(held) ? "true" : "false"]
  }
  if (node.kind === "variable") {
    if (node.variable.typed) return ["other"]
    return node.variable.nullable ? ["text", "empty", "null"] : ["text", "empty"]
  }
  if (node.kind === "call" && node.name === "format") return ["text", "empty"]
  if (node.kind !== "binary" || (node.operator !== "&&" && node.operator !== "||")) return ["true", "false"]
  const kept = node.operator === "&&" ? falsyKinds : truthyKinds
  return [...new Set([...kindsOf(node.left).filter((kind) => kept.includes(kind)), ...kindsOf(node.right)])]
}

/**
 * Whether an expression still to finish is true whatever its variables hold: `x && false` is never true and
 * `x || 'fallback'` always is. `undefined` when its variables decide.
 *
 * @category shell
 * @since 0.1.0
 * @throws {never}
 */
export const settled = (node: Residual): boolean | undefined => {
  const kinds = kindsOf(node)
  if (kinds.every((kind) => kind !== "other" && falsyKinds.includes(kind))) return false
  return kinds.every((kind) => kind !== "other" && truthyKinds.includes(kind)) ? true : undefined
}

/**
 * A value that is tested or compared must be one a shell can tell apart. A matrix value that is a number on
 * GitHub is only known here as text: `0` is false there and `'0'` is true, so it is never tested.
 */
const tested = (node: Residual, compared: boolean, emitter: Emitter): Residual => {
  // Worked out per variant, it has the type GitHub gives it.
  if (overMatrix(node, emitter)) return node
  const kinds = kindsOf(node)
  if (kinds.includes("other") || (compared && (kinds.includes("true") || kinds.includes("false")))) {
    throw new Refused(
      compared
        ? "a comparison decided while the job runs is between values that are not both text"
        : "a value decided while the job runs is tested, and it may be a number or a list"
    )
  }
  return node
}

/**
 * Writes the shell lines that work a residual out. Returns the number of
 * the pair `__v<n>` and `__t<n>` that holds the result.
 */
const compile = (node: Residual, emitter: Emitter): number => {
  if (!overMatrix(node, emitter)) return compileInShell(node, emitter)
  if (kindsOf(node).includes("other")) return compileByVariant(node, emitter)
  const inner: Emitter = { ...emitter, lines: [] }
  try {
    const n = compileInShell(node, inner)
    emitter.count = inner.count
    emitter.lines.push(...inner.lines)
    return n
  } catch {
    // A shell cannot finish it: GitHub's rules can, one variant at a time.
    return compileByVariant(node, emitter)
  }
}

const assignment = (n: number, held: Value): string =>
  `__v${n}=${quote(toText(held))}; __t${n}=${typeof held === "string" ? "s" : truthy(held) ? "t" : "f"}`

/**
 * Writes an expression over the matrix as its answer for each variant, worked out here by GitHub's rules. The
 * shell picks the answer by the matrix values a variant's runner text holds.
 */
const compileByVariant = (node: Residual, emitter: Emitter): number => {
  emitter.count += 1
  const n = emitter.count
  const keys = [...new Set(variablesOf(node).map((found) => found.id.slice(matrixPrefix.length)))].sort()
  const arms = new Map<string, Array<string>>()
  for (const variant of emitter.variants) {
    const finished = finish(node, (found) => matrixValue(found, variant))
    if (finished.kind === "problem") throw new Refused(finished.why)
    const held = finished.value
    if (typeof held === "object" && held !== null) {
      throw new Refused("a list or mapping is used with a value decided while the job runs")
    }
    const set = assignment(n, held)
    arms.set(set, [...(arms.get(set) ?? []), quote(keys.map((key) => `|${key}=${variant[key] ?? ""}`).join(""))])
  }
  emitter.lines.push(
    `case ${quote(keys.map((key) => `|${key}=\${{ matrix.${key} }}`).join(""))} in`,
    ...[...arms].map(([set, patterns]) => `  ${patterns.join("|")}) ${set} ;;`),
    "esac"
  )
  return n
}

const compileInShell = (node: Residual, emitter: Emitter): number => {
  emitter.count += 1
  const n = emitter.count
  const set = (held: string, tag: string): string => `__v${n}=${held}; __t${n}=${tag}`
  const decide = (test: string): string => `if ${test}; then ${set("true", "t")}; else ${set("false", "f")}; fi`
  const pair = (index: number): string => `"$__t${index}" "$__v${index}"`
  if (node.kind === "literal") {
    const held = node.value
    if (typeof held === "object" && held !== null) {
      throw new Refused("a list or mapping is used with a value decided while the job runs")
    }
    emitter.lines.push(assignment(n, held))
  } else if (node.kind === "variable") {
    emitter.lines.push(`${loadOf(node.variable)}; ${set("$__v", "$__t")}`)
  } else if (node.kind === "not") {
    const operand = compile(tested(node.operand, false, emitter), emitter)
    emitter.lines.push(decide(`! __ci_true ${pair(operand)}`))
  } else if (node.kind === "call") {
    const args = node.args.map((arg) => compile(arg, emitter))
    const test = callTests.get(node.name)
    const [template] = node.args
    if (test !== undefined) {
      emitter.lines.push(decide(`${test} "$__v${args[0]}" "$__v${args[1]}"`))
    } else if (node.name === "format" && template?.kind === "literal") {
      const pieces = formatPieces(toText(template.value))
      if (pieces === undefined || pieces.some((piece) => typeof piece === "number" && args[piece + 1] === undefined)) {
        throw new Refused("format was given a template that names a value it does not have")
      }
      const text = pieces.map((piece) => typeof piece === "string" ? quote(piece) : `"$__v${args[piece + 1]}"`).join("")
      emitter.lines.push(set(text, "s"))
    } else {
      throw new Refused(`${node.name} of a value decided while the job runs`)
    }
  } else if (node.operator === "&&" || node.operator === "||") {
    const left = compile(tested(node.left, false, emitter), emitter)
    // The right side is read only when the left side does not decide, as GitHub reads it.
    const inner: Emitter = { ...emitter, lines: [] }
    const right = compile(node.right, inner)
    emitter.count = inner.count
    emitter.lines.push(
      `if ${node.operator === "&&" ? "" : "! "}__ci_true ${pair(left)}; then`,
      ...inner.lines.map((line) => `  ${line}`),
      `  ${set(`$__v${right}`, `$__t${right}`)}`,
      `else ${set(`$__v${left}`, `$__t${left}`)}; fi`
    )
  } else if (node.operator === "==" || node.operator === "!=") {
    const left = compile(tested(node.left, true, emitter), emitter)
    const right = compile(tested(node.right, true, emitter), emitter)
    emitter.lines.push(decide(`${node.operator === "==" ? "" : "! "}__ci_equal ${pair(left)} ${pair(right)}`))
  } else {
    throw new Refused(
      `${node.operator} orders values decided while the job runs, which a shell does not do as GitHub does`
    )
  }
  return n
}

/**
 * The lines that put `python`, `python3`, `pip` and `pip3` first on `PATH`, as a setup action leaves them. A machine
 * may have only `python3`: each runs the Python 3 the machine has, and `pip` runs its `-m pip`. They are made once
 * in the job's tool directory, which is under the job's own state, and nowhere else.
 */
const python = (fail: (why: string) => string): ReadonlyArray<string> => [
  `__py=$RUNNER_TOOL_CACHE/python/bin`,
  `if [ ! -x "$__py/pip3" ]; then`,
  `  __p=$(command -v python3 || command -v python) || ${fail("this job sets up Python, and this machine has none")}`,
  `  mkdir -p -- "$__py" && ln -sf -- "$__p" "$__py/python" && ln -sf -- "$__p" "$__py/python3" &&`,
  `    printf '#!/bin/sh\\nexec %q -m pip "$@"\\n' "$__p" > "$__py/pip" && chmod +x -- "$__py/pip" &&`,
  `    cp -- "$__py/pip" "$__py/pip3" || exit 1`,
  `fi`,
  `export PATH="$__py:$PATH"`
]

/**
 * The runner text of one step: the shell function `Inventory.runnerEntry`,
 * which takes the step's command.
 *
 * @category shell
 * @since 0.1.0
 * @throws {never}
 */
export const write = (job: JobFacts, step: StepFacts, command: string): Written => {
  const emitter: Emitter = { lines: [], count: 0, variants: job.variants ?? [] }
  // Each matrix value under its key, with its length, so two variants never share a state whatever they hold.
  const variant = job.matrixKeys.map((key) =>
    `__m='\${{ matrix.${key} }}'; __variant="$__variant|${key}=\${#__m}:$__m"`
  )
  /** The shell words that give a value made of pieces. */
  const words = (parts: ReadonlyArray<Part>): string =>
    parts.length === 0
      ? "''"
      : parts.map((part) => typeof part === "string" ? quote(part) : `"$__v${compile(part.residual, emitter)}"`).join(
        ""
      )
  const exported = (entries: StepFacts["env"]): void => {
    for (const [name, parts] of entries) emitter.lines.push(`export ${name}=${words(parts)}`)
  }
  try {
    // The steps whose values this one reads. An expression may ask for one before they are loaded. A step split
    // from another also reads what the ones split with it wrote, which is kept under the key they share.
    emitter.lines.push(
      `__before=${quote(step.before.join(" "))}`,
      `[ -z "\${__smithers_ci_part-}" ] || __before="$__before "${quote(step.key)}`
    )
    // A variable of the job is set before what earlier steps wrote is loaded, so GITHUB_ENV replaces it.
    exported(step.outer)
    emitter.lines.push(`__ci_load ${quote(step.own.join(" "))}`)
    for (const [name, parts] of step.keeps) emitter.lines.push(`__ci_keep ${quote(name)} ${words(parts)}`)
    if (step.condition !== undefined) {
      const result = compile(tested(step.condition, false, emitter), emitter)
      emitter.lines.push(`__ci_true "$__t${result}" "$__v${result}" || __ci_skip ${quote(step.key)}`)
    }
    exported(step.env)
    if (step.directory !== undefined) emitter.lines.push(`__ci_enter ${words(step.directory)}`)
    emitter.lines.push(`__script=$1`)
    if (step.fills.length > 0) {
      emitter.lines.push(`__fk=(); __fv=()`)
      for (const [index, [written, residual]] of step.fills.entries()) {
        emitter.lines.push(`__fk[${index}]=${quote(written)}; __fv[${index}]=$__v${compile(residual, emitter)}`)
      }
      emitter.lines.push(`__ci_fill`)
    }
    if (step.limit !== undefined) {
      const [count, unit] = step.limit % 60 === 0 ? [step.limit / 60, "minute"] : [step.limit, "second"]
      const allowed = `${count} ${unit}${count === 1 ? "" : "s"}`
      emitter.lines.push(`__limit=${step.limit}; __allowed=${quote(allowed)}`)
    }
  } catch (refused) {
    // Anything else thrown here is the stack running out on an expression nested thousands deep.
    return { problem: refused instanceof Refused ? refused.why : "it nests too deep to finish in a shell" }
  }
  // A step that reads the commit, its parent or the run's own numbers says so: its verdict is that commit's and
  // no other's.
  const commit = step.commit ||
    emitter.lines.some((line) => /\$GITHUB_(?:SHA|RUN_ID|RUN_NUMBER|RUN_ATTEMPT)|'HEAD\^'/.test(line))
  const fail = (why: string): string => `{ echo "smithers-ci: ${why}" >&2; exit 1; }`
  const shared = library(job)
  // What a first step does names what it leaves: its text, its command and the functions it writes.
  const work = JSON.stringify([
    shared,
    emitter.lines,
    step.key,
    step.cwd,
    step.start,
    step.job,
    commit,
    command,
    ...(step.python === true ? ["python"] : [])
  ])
  const mark = step.after ??
    `${shardOf(work, 0x1_0000_0000).toString(36)}-${shardOf(`${work}\n`, 0x1_0000_0000).toString(36)}`
  /** The lines that name a directory of the state after the repository's place and `name`, shell words. */
  const named = (target: string, name: string): ReadonlyArray<string> => [
    `__sum=$(printf %s "$__place|"${name}"$__variant" | cksum)`,
    `case \${__sum// /} in ''|*[!0-9]*) ${fail("cksum gave no checksum to name the job's state with")};; esac`,
    `${target}=$__base/\${__sum%% *}-\${__sum##* }`
  ]
  // The state a first step leaves for the jobs that start with it. Where jobs run at once in one checkout, as in
  // a baseline, `Inventory.script` names the job and each keeps its own.
  const shared_ = `${quote(`first|${mark}|`)}"\${__smithers_ci_unit-}"`
  /** The lines that copy what a state holds into a directory, but the event file. */
  const copied = (from: string, to: string): ReadonlyArray<string> => [
    `for __e in "$${from}"/*; do`,
    `  case \${__e##*/} in event.json) ;; *) cp -R "$__e" "$${to}/" || { __ci_gone "$${to}"; exit 1; };; esac`,
    `done`
  ]
  /** The lines that stop a step whose job's state was not started by this job's first step. */
  const started = (state: string): ReadonlyArray<string> => [
    `__o=; [ ! -f "$${state}/first" ] || IFS= read -r __o < "$${state}/first"`,
    `[ "$__o" = ${quote(mark)} ] || ${fail("the steps before this one have not run in $__root")}`
  ]
  /** A state of this run alone, removed as the step ends. */
  const own = [`__state=$(mktemp -d "$__base/only.XXXXXX") || exit 1`, `trap '__ci_gone "$__state"' EXIT`]
  /** The lines that say where the state's checkout is and write the functions every step of the job reads. */
  const library_ = [
    `printf %s "$__place" > "$__state/root.$$" && mv -f -- "$__state/root.$$" "$__state/root" || exit 1`,
    `cat > "$__state/lib.sh" <<'${marker}'`,
    shared,
    marker
  ]
  const textOf = (alone: boolean): string =>
    [
      `${runnerEntry}() {`,
      ...(commit ? [commitNote] : []),
      `set +e`,
      // Smithers build puts its cache directory where the line between the two marks is, before it starts a
      // target. A baseline leaves the line as written and names the directory in a variable.
      ...(step.store === true
        ? [
          `IFS= read -r __kept <<'__SMITHERS_CI_KEPT__'`,
          cacheDirectoryToken,
          `__SMITHERS_CI_KEPT__`,
          `case $__kept in '{'smthrs:*) __kept=\${${stateVariable}:-\${XDG_CACHE_HOME:-$HOME/.cache}/smithers-ci};; esac`
        ]
        : []),
      `__cwd=${quote(step.cwd)}`,
      `__root=$PWD`,
      `if [ -n "$__cwd" ]; then`,
      `  case $PWD in`,
      `    */"$__cwd") __root=\${PWD%"/$__cwd"};;`,
      // The directory was reached through a link: the root is the nearest one above from which it is this one.
      `    *)`,
      `      until [ "$__root/$__cwd" -ef "$PWD" ]; do`,
      `        [ "$__root" != / ] || ${fail("$PWD is not $__cwd in a repository")}`,
      `        __root=\${__root%/*}; __root=\${__root:-/}`,
      `      done;;`,
      `  esac`,
      `fi`,
      // The state is under /tmp whatever the step's own TMPDIR is, in a directory only this user can enter. Where
      // /tmp cannot be written, as inside a step held to its inputs, it is under the TMPDIR that step is given.
      // On a machine Smithers build made for the job, it is under that machine's temporary directory: a state
      // left under /tmp would be there when the job next runs, and a step that removes a directory another run
      // left has read something nobody can name, so its result would never be stored. The step's own script is
      // not told the variable.
      // Removes a state, read-only directories and all, as a tool's own cache has them. False when it is still
      // there.
      `__ci_gone() {`,
      `  [ -e "$1" ] || [ -L "$1" ] || return 0`,
      `  [ -L "$1" ] || chmod -R u+w -- "$1" 2>/dev/null`,
      `  rm -rf -- "$1" 2>/dev/null`,
      `  [ ! -e "$1" ] && [ ! -L "$1" ]`,
      `}`,
      `__variant=`,
      ...variant,
      // A state is named after the repository's place and holds it, so two checkouts that share /tmp keep
      // theirs apart and a checkout that is gone has its state removed. In the job's own directory there is no
      // other checkout: the name and the state hold no path, so a record of what a step read there answers in
      // another checkout. Where the job's directory is the step's own /tmp, as in its machine's namespace, it is
      // named /tmp: a path under RUNNER_TEMP, as a Unix socket's, is then as short as on a runner, where the kernel
      // refuses a socket path longer than 107 bytes.
      `__base=/tmp; __place=$__root`,
      `if [ -n "\${${jobTemporaryVariable}-}" ] && [ -w "$${jobTemporaryVariable}" ]; then __place=; [ /tmp -ef "$${jobTemporaryVariable}" ] || __base=$${jobTemporaryVariable}; fi`,
      `unset ${jobTemporaryVariable}; [ -w "$__base" ] || __base=\${TMPDIR:-/tmp}`,
      `__base=$__base/smithers-ci-runner-$(id -u)`,
      `mkdir -p -m 700 -- "$__base" 2>/dev/null; [ -d "$__base" ] && [ -O "$__base" ] || ${
        fail("$__base is not a directory of this user")
      }`,
      ...(step.apart
        // A step that may be left out keeps its state in a directory of this run alone, a copy of what the steps
        // before it left, and removes it as it ends.
        ? [
          ...own,
          ...(step.after === undefined
            ? library_
            : [
              ...(step.second ? named("__from", shared_) : [...named("__from", quote(job.id)), ...started("__from")]),
              `[ -f "$__from/lib.sh" ] || ${fail("the steps before this one have not run in $__root")}`,
              ...copied("__from", "__state")
            ]),
          `__apart=1`
        ]
        : step.after === undefined
        ? [
          ...(alone
            // The only step of a job keeps its state in a directory of this run alone and removes it as it ends:
            // nothing reads what it leaves. It looks at no state but its own, so what it reads is the same from
            // one run to the next, whatever other jobs, or steps split from this one, leave beside it.
            ? own
            : [
              // A first step that names its job, or the directories a runner gives a job, starts the job's own
              // state: every step of the job then has the same RUNNER_TEMP. Any other first step leaves a state
              // of its own, which each job that starts with it copies.
              ...named("__state", step.job === undefined ? shared_ : quote(job.id)),
              // The state of a checkout that is gone, such as a replay's copy, is removed with the first step of a
              // job. A state whose place cannot be read is being written by another step and is left alone.
              `for __d in "$__base"/*; do`,
              `  [ -f "$__d/root" ] || continue`,
              `  __r=; { IFS= read -r -d '' __r < "$__d/root"; } 2>/dev/null`,
              `  [ -z "$__r" ] || [ -d "$__r" ] || __ci_gone "$__d"`,
              `done`,
              `__ci_gone "$__state" || ${fail("could not remove $__state")}`,
              `mkdir -p -- "$__state" || exit 1`,
              ...(step.job === undefined ? [] : [`printf %s ${quote(mark)} > "$__state/first" || exit 1`])
            ]),
          ...library_
        ]
        : [
          ...named("__state", quote(job.id)),
          ...(step.second
            ? [
              ...named("__first", shared_),
              `[ -f "$__first/lib.sh" ] || ${fail("the first step of this job has not run in $__root")}`,
              // The job's own state starts as a copy of what its first step left: that step may have run for
              // another job that starts the same way. The event file is the first step's own and stays there.
              // A step split from this one keeps the state the ones before it wrote to, as long as it started
              // from this run of the first step: it holds a link to that run's file, which a new run replaces.
              // The copy is moved into place whole.
              `if [ -z "\${__smithers_ci_part-}" ] || ! [ "$__state/origin" -ef "$__first/lib.sh" ]; then`,
              `  __ci_gone "$__state" && __ci_gone "$__state.$$" || ${fail("could not remove $__state")}`,
              `  mkdir -- "$__state.$$" || exit 1`,
              ...copied("__first", "__state.$$").map((line) => `  ${line}`),
              `  printf %s ${quote(mark)} > "$__state.$$/first" && ln -- "$__first/lib.sh" "$__state.$$/origin" &&`,
              `    mv -- "$__state.$$" "$__state" || { __ci_gone "$__state.$$"; exit 1; }`,
              `fi`
            ]
            : started("__state"))
        ]),
      `[ -f "$__state/lib.sh" ] || ${fail("the steps before this one have not run in $__root")}`,
      `. "$__state/lib.sh" || exit 1`,
      `__ci_start`,
      ...(step.python === true ? python(fail) : []),
      // A runner sets CI to true. What the machine holds under that name is the person's, not the workflow's.
      ...(step.ownCi === true ? [] : [`export CI=true`]),
      // A tool that reports its use, or asks whether it has a newer version, calls a server that decides nothing the
      // step does. Told not to, it calls none.
      ...quietTools.filter(([name]) => !(step.ownQuiet ?? []).includes(name)).map(([name, value]) =>
        `export ${name}=${value}`
      ),
      ...(step.job === undefined ? [] : [`export GITHUB_JOB=${quote(step.job)}`]),
      ...(step.action === undefined ? [] : [`export GITHUB_ACTION=${quote(step.action)}`]),
      `__ci_commit ${commit ? "1" : "''"}`,
      ...(step.store === true ? [`export SMITHERS_CI_CACHE_STORE="$__kept/actions-cache"`] : []),
      ...emitter.lines,
      `__ci_run ${quote(step.key)} "$__script" ${step.start.map(quote).join(" ")}`,
      `}`
    ].join("\n")
  return { mark, text: textOf(false), alone: textOf(true) }
}
