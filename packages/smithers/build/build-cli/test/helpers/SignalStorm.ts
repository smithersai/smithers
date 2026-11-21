/**
 * A program whose signals come faster than a recorded call completes, for the
 * tests of what `smthrs-observe` does with it.
 *
 * `python3 storm.py <microseconds> <path>` asks for `path` 20,000 times while
 * a timer sends it a signal, to a handler, every so many microseconds, and
 * prints `done`. Unrecorded, each signal costs it the kernel's delivery and the
 * handler; a timer faster than that leaves it no time for its own work,
 * recorded or not. How fast that is belongs to the machine: on the build
 * server the program ends with a timer of 2 microseconds, and on GitHub's
 * x86_64 runner it does not end in 20 s (recorder.yml, 2026-11-21). A test
 * takes the fastest timer this machine's program survives unrecorded, so that
 * what it sees recorded is the recorder's doing. Recorded on the build server,
 * a timer of 16 microseconds or faster is a storm the recorder stops within a
 * second, and one of 32 or slower lets the calls complete: the run ends
 * recorded, in 4 to 13 s.
 */
import { spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"

/** The program, to be written to a file and run by `python3`. */
export const signalling = String.raw`
import os, signal, sys
signal.signal(signal.SIGALRM, lambda sig, frame: None)
every = float(sys.argv[1]) / 1e6
signal.setitimer(signal.ITIMER_REAL, every, every)
for i in range(20000): os.stat(sys.argv[2])
signal.setitimer(signal.ITIMER_REAL, 0, 0)
print("done")
`

/**
 * The fastest timer, of 16 microseconds or faster, at which the program ends
 * unrecorded within five seconds on this machine.
 */
export const survivedTimer = (): number => {
  const base = NodeFs.mkdtempSync(Path.join(Os.tmpdir(), "smthrs-storm-timer-"))
  try {
    const script = Path.join(base, "storm.py")
    NodeFs.writeFileSync(script, signalling)
    for (const microseconds of [2, 4, 8, 16]) {
      const plain = spawnSync("python3", [script, String(microseconds), script], { encoding: "utf8", timeout: 5_000 })
      if (plain.stdout === "done\n") return microseconds
    }
    throw new Error("unrecorded, python3 ends with no timer of 16 microseconds or faster on this machine")
  } finally {
    NodeFs.rmSync(base, { recursive: true, force: true })
  }
}
