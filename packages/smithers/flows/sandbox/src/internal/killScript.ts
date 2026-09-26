/**
 * Builds the descendant signalling scripts.
 *
 * @since 0.1.0
 */

/** How long the script waits for a newly started command to record its pid. */
const pidfileWaitSeconds = 5

/**
 * Snapshot `/proc` once and index its parent-to-children edges in awk. An
 * explicit stack then visits only the target subtree in postorder, without
 * rescanning the table or starting a subshell for each descendant. Collection
 * costs O(visible processes + descendants) before the first signal.
 *
 * Parse the parent pid after the last `)` in `/proc/N/stat`: the comm field
 * may itself contain spaces and closing parentheses. Linked sibling entries
 * avoid repeatedly copying a broad parent's entire child list. The visited
 * set also bounds traversal if pid reuse during the snapshot forms a cycle.
 */
const procKids = `kids() { t=$1; for d in /proc/[0-9]*; do read -r s 2>/dev/null < "$d/stat" || continue; ` +
  `r=\${s##*) }; set -- $r; printf '%s %s\\n' "\${d#/proc/}" "$2"; ` +
  `done | awk -v root="$t" '{ pid=$1+0; parent=$2+0; sibling[pid]=first[parent]; first[parent]=pid } ` +
  `END { root+=0; stack[1]=root; seen[root]=1; depth=1; while (depth) { ` +
  `pid=stack[depth]; child=first[pid]; if (child != "") { first[pid]=sibling[child]; ` +
  `if (!seen[child]++) stack[++depth]=child; ` +
  `} else { if (pid != root) print pid; depth-- } } }'; }`

/** A `kids` function on `pgrep -P`, for hosts with no `/proc` (macOS). */
const pgrepKids = `kids() { for c in $(pgrep -P "$1" 2>/dev/null); do ( kids "$c" ); echo "$c"; done; }`

/** Signals whose meaning a freeze-and-thaw around them would undo. */
const unfrozen = new Set(["STOP", "TSTP", "TTIN", "TTOU", "CONT"])

/**
 * The collect-then-signal tail both scripts share. The whole descendant set
 * is gathered BEFORE anything is signalled and delivered together with the
 * root in one `kill` invocation: killing children one at a time before their
 * parent lets a respawning parent (`while :; do work; done`) replace each
 * child in the gap. The batch `kill` fails if any single collected pid
 * vanished first, so the root is retried alone before the honesty check: a
 * signal the root demonstrably took is delivered, and only a `kill` that
 * failed while the root is still alive exits non-zero instead of claiming
 * delivery.
 *
 * One `kill` invocation is still one `kill(2)` per pid, children first. On a
 * single CPU the parent a dead child wakes can run before its own signal
 * lands, and a shell parent runs its next command in that gap
 * (`sleep 2; printf survived > file` writes the file). So the whole set is
 * stopped first, signalled while nothing in it can run, and continued, and
 * each process meets its pending signal before its next instruction. A
 * signal that itself stops or continues is delivered without the freeze,
 * whose continue would undo it.
 */
const signalCollected = (signal: string): string =>
  unfrozen.has(signal)
    ? `set -- $(kids "$p") "$p"; ` +
      `kill -s ${signal} "$@" 2>/dev/null && exit 0; ` +
      `kill -s ${signal} "$p" 2>/dev/null && exit 0; ` +
      `kill -0 "$p" 2>/dev/null || exit 0; ` +
      `exit 1`
    : `set -- $(kids "$p") "$p"; ` +
      `kill -s STOP "$@" 2>/dev/null; ` +
      `if kill -s ${signal} "$@" 2>/dev/null || kill -s ${signal} "$p" 2>/dev/null || ! kill -0 "$p" 2>/dev/null; ` +
      `then r=0; else r=1; fi; ` +
      `kill -s CONT "$@" 2>/dev/null; ` +
      `exit $r`

/**
 * The path a kill writes when the command it meant to stop has not recorded a
 * pid yet.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cancelMarker = (pidfile: string): string => `${pidfile}.cancel`

/**
 * The status a wrapper reports when it finds its cancellation marker: the
 * conventional `128 + SIGTERM`, the same number a shell reports for a command
 * a `SIGTERM` actually ended.
 *
 * @category models
 * @since 0.1.0
 */
export const cancelledStatus = 143

/**
 * The guard a spawned wrapper runs between recording its pid and becoming the
 * command.
 *
 * Container, Kubernetes, and ECS all return from `spawn` once the local client
 * starts, which is before the guest wrapper is guaranteed to have run
 * `echo $$ > pidfile`. A kill issued in that window, or on a machine slow
 * enough that the wrapper takes longer than {@link killScript}'s wait to be
 * scheduled at all, had nothing to signal and reported success anyway, so the
 * command started afterwards and ran unsupervised. The marker gives that kill
 * something to latch onto, and this guard is what honors it. The wrapper writes
 * its pid before this guard. Therefore a wrapper that has not written a pid has
 * not passed the guard, while a wrapper that has passed the guard has left a pid
 * the kill can signal.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cancelGuard = (pidfile: string): string =>
  `if [ -e ${cancelMarker(pidfile)} ]; then exit ${cancelledStatus}; fi`

/**
 * Builds a POSIX shell script that signals one recorded pid and all of its
 * descendants in a single `kill` invocation.
 *
 * This is the guest-side script for Linux guests. It plants
 * {@link cancelMarker} before waiting for or reading the pidfile, then walks
 * `/proc` when a pid is present. Writing the marker first closes the read-then-
 * mark race that let a wrapper write its pid, pass its guard, and start the
 * command after the kill had already read an empty file but before it wrote the
 * marker. A wrapper that has not written its pid has not reached its guard and
 * must see the marker. A wrapper that already passed the guard has written a pid
 * for this script to signal.
 *
 * An empty pid still reports success because the planted marker makes the
 * pending wrapper cancel itself. Leaving the marker after a successful signal
 * is harmless because every spawn has a unique pidfile name and acquisition
 * recreates the entire pidfile directory.
 *
 * @category constructors
 * @since 0.1.0
 */
export const killScript = (pidfile: string, signal: string): string =>
  `: > ${cancelMarker(pidfile)} || exit 1; ` +
  `n=0; while [ ! -s ${pidfile} ] && [ "$n" -lt ${pidfileWaitSeconds} ]; do sleep 1; n=$((n+1)); done; ` +
  `p=$(cat ${pidfile} 2>/dev/null); ` +
  `if [ -z "$p" ]; then exit 0; fi; ` +
  `${procKids}; ` +
  signalCollected(signal)

/**
 * Builds a POSIX shell script that signals one live pid and all of its
 * descendants in a single `kill` invocation.
 *
 * This is the host-side counterpart of {@link killScript} for providers whose
 * transport runs on this machine: the pid is already known, so there is no
 * pidfile to wait for. The descent runs on `pgrep -P` where it exists —
 * macOS, procps Linux, and busybox alike — and otherwise on the `/proc`
 * walk, because the only hosts without `pgrep` (slim Linux images) are
 * exactly the ones with `/proc`; degrading to signalling the root alone
 * would be the silent leak this script exists to close.
 *
 * @category constructors
 * @since 0.1.0
 */
export const hostKillScript = (pid: number, signal: string): string =>
  `p=${pid}; ` +
  `if command -v pgrep >/dev/null 2>&1; then ${pgrepKids}; else ${procKids}; fi; ` +
  signalCollected(signal)
