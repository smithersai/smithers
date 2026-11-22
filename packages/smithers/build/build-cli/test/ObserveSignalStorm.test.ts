/**
 * A path the recorder read from a call is the path the call named.
 *
 * `smthrs-observe` reads each path from the memory of the thread whose call
 * waits for it. Threads here open known names from a buffer each writes over
 * with other bytes as soon as its call returns, while a 10 kHz timer and a
 * sibling thread send signals, with `SA_RESTART` and without. Were a call to
 * go on while the recorder read its buffer, the record would name the bytes
 * written after it. Every path recorded under the run's directory is one of
 * the known names. A run whose signals come faster than its calls complete
 * is not stored, and says so: it records nothing to hold.
 *
 * `SMTHRS_STORM_RUNS` sets how many runs each case makes (4 unless given),
 * `SMTHRS_STORM_CORES` the processors they run on (all unless given), and
 * `SMTHRS_STORM_OUT=<file>` writes one line per case with what its runs did.
 */
import { spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"

const base = NodeFs.realpathSync(NodeFs.mkdtempSync(Path.join(Os.tmpdir(), "smthrs-signal-storm-")))
afterAll(() => NodeFs.rmSync(base, { recursive: true, force: true }))

/** Opens `known-<n>` by its number through libc, from a buffer written over after every call. */
const program = `
import ctypes, os, signal, sys, threading, time
restart, workers, calls = sys.argv[1] == "restart", int(sys.argv[2]), int(sys.argv[3])
openat, tgkill = {"x86_64": (257, 234), "aarch64": (56, 131)}[os.uname().machine]
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
def handler(number, frame):
    pass
for number in (signal.SIGALRM, signal.SIGUSR1):
    signal.signal(number, handler)
    signal.siginterrupt(number, not restart)
ids = []
done = threading.Event()
def work(me):
    ids.append(threading.get_native_id())
    buffer = ctypes.create_string_buffer(96)
    for call in range(calls):
        buffer.value = b"known-%d" % ((me + call) % 8)
        fd = libc.syscall(openat, -100, buffer, os.O_RDONLY)
        if fd >= 0:
            os.close(fd)
        buffer.value = b"written-after-the-call-%d-%d" % (me, call)
def storm():
    while not done.is_set():
        for tid in list(ids):
            libc.syscall(tgkill, os.getpid(), tid, signal.SIGUSR1)
        time.sleep(0.001)
threads = [threading.Thread(target=work, args=(me,)) for me in range(workers)]
killer = threading.Thread(target=storm)
signal.setitimer(signal.ITIMER_REAL, 0.0001, 0.0001)
killer.start()
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()
done.set()
killer.join()
signal.setitimer(signal.ITIMER_REAL, 0, 0)
`

const supervisor = ObservedReads.supervisorPath(process.platform, process.arch, {
  SMTHRS_OBSERVE_WITH: "smthrs-observe"
})
const runs = Number(process.env["SMTHRS_STORM_RUNS"] ?? "4")
/** What the recorder writes when it gives a run up to its signals. */
const stormed = "+++ unrecorded: signals arrive faster than a recorded call completes +++"
const cores = process.env["SMTHRS_STORM_CORES"]

/**
 * What a trace names that no call named: bytes written after a call, or another name directly in `root`, where
 * every open of the storm is. A program found on the way to `python3` is in a directory below it.
 */
const strangers = (trace: string, root: string): ReadonlyArray<string> => {
  const quoted = /"((?:[^"\\]|\\.)*)"/g
  const found = new Set<string>()
  for (const line of NodeFs.readFileSync(trace, "utf8").split("\n")) {
    for (const [, text] of line.matchAll(quoted)) {
      if (text!.includes("written-after")) found.add(text!)
      else if (
        text!.startsWith(`${root}/`) && !/^(?:known-[0-7]|storm\.py|.*\/.*)$/.test(text!.slice(root.length + 1))
      ) {
        found.add(text!)
      }
    }
  }
  return [...found]
}

describe.skipIf(process.platform !== "linux" || supervisor === undefined)("a call that signals interrupt", () => {
  for (const mode of ["restart", "plain"] as const) {
    it(`names only the paths its calls named, ${mode === "restart" ? "with" : "without"} SA_RESTART`, () => {
      const root = Path.join(base, mode)
      NodeFs.mkdirSync(root)
      NodeFs.writeFileSync(Path.join(root, "storm.py"), program)
      for (let known = 0; known < 8; known += 1) NodeFs.writeFileSync(Path.join(root, `known-${known}`), "x")
      const trace = Path.join(base, `${mode}.trace`)
      const pinned = cores === undefined ? [] : ["taskset", "-c", cores]
      const seen: Array<string> = []
      let recorded = 0
      for (let run = 0; run < runs; run += 1) {
        const argv = [...pinned, supervisor!, trace, "--", "python3", "-I", "storm.py", mode, "8", "400"]
        const ran = spawnSync(argv[0]!, argv.slice(1), { cwd: root, stdio: "ignore", timeout: 120_000 })
        const lines = NodeFs.readFileSync(trace, "utf8")
        if (ran.status !== 0) {
          expect([run, lines]).toEqual([run, expect.stringContaining(stormed)])
          continue
        }
        recorded += 1
        // The run opened its names: the trace holds them.
        expect(lines).toContain(`known-7`)
        seen.push(...strangers(trace, root))
      }
      const counts = process.env["SMTHRS_STORM_OUT"]
      if (counts !== undefined) {
        NodeFs.appendFileSync(counts, `${JSON.stringify({ mode, cores, runs, recorded, strangers: seen.length })}\n`)
      }
      expect(seen).toEqual([])
      expect(recorded).toBeGreaterThan(0)
    }, 600_000)
  }
})
