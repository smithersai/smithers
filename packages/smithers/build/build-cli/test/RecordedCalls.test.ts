/**
 * The one table of calls (`src/internal/RecordedCalls.ts`), and every row of
 * it walked three ways.
 *
 * Each way of `test/helpers/KernelProbe.ts` reaches a file through one call
 * and one form of it, and exits 0 when it finds what the repository holds.
 * Run unrecorded, it exits 0, and after a change a commit could make, it does
 * not: that is the known answer. Run under strace and under `smthrs-observe`,
 * each run either stores a record that is reused while nothing changed and
 * runs again after the change, or stores nothing and says why. A record that
 * is reused after the change is a stale pass, the one wrong answer.
 *
 * `SMTHRS_MATRIX_OUT=<file>` writes one line per way with what each of the
 * three runs did.
 */
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { callsHeader } from "../scripts/build-observe.mjs"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as RecordedCalls from "../src/internal/RecordedCalls.ts"
import * as KernelProbe from "./helpers/KernelProbe.ts"

const base = NodeFs.realpathSync(NodeFs.mkdtempSync(Path.join(Os.tmpdir(), "smthrs-recorded-calls-")))
afterAll(() => NodeFs.rmSync(base, { recursive: true, force: true }))

describe("the table of calls", () => {
  it("names each call once, and each number once", () => {
    const names = RecordedCalls.calls.map((call) => call.name)
    expect(new Set(names).size).toBe(names.length)
    const numbers = RecordedCalls.calls.flatMap((call) => call.number === undefined ? [] : [call.number])
    expect(RecordedCalls.byNumber.size).toBe(numbers.length)
    expect(Math.max(...numbers)).toBe(RecordedCalls.lastKnown)
    expect(RecordedCalls.byName.get("openat2")?.number).toBe(437)
  })

  it("says which flag of a call is not followed, as strace prints it", () => {
    const linkat = RecordedCalls.byName.get("linkat")!
    expect(RecordedCalls.unfollowed(linkat, "0")).toBeUndefined()
    expect(RecordedCalls.unfollowed(linkat, "AT_SYMLINK_FOLLOW|AT_EMPTY_PATH")).toBeUndefined()
    expect(RecordedCalls.unfollowed(linkat, "AT_SYMLINK_NOFOLLOW")).toBe("linkat with AT_SYMLINK_NOFOLLOW")
    expect(RecordedCalls.unfollowed(linkat, "AT_EMPTY_PATH|0x10000 /* AT_??? */")).toBe("linkat with 0x10000")
    // Asked again, the same answer.
    expect(RecordedCalls.unfollowed(linkat, "AT_SYMLINK_NOFOLLOW")).toBe("linkat with AT_SYMLINK_NOFOLLOW")
    expect(RecordedCalls.unfollowed(linkat, "0")).toBeUndefined()
    // A trace that spells a call's flags more ways than are kept is still answered.
    const statx = RecordedCalls.byName.get("statx")!
    for (let bit = 0; bit < 4100; bit += 1) {
      RecordedCalls.unfollowed(statx, `AT_EMPTY_PATH|0x${(bit + 0x100000).toString(16)}`)
    }
    expect(RecordedCalls.unfollowed(statx, "AT_EMPTY_PATH|0x999999")).toBe("statx with 0x999999")
    // A call with no flags argument has none to refuse.
    expect(RecordedCalls.unfollowed(RecordedCalls.byName.get("stat")!, "AT_RECURSIVE")).toBeUndefined()
    expect(RecordedCalls.cannotFollow("open_by_handle_at")).toBe(
      "it reached a file in a way the recorder cannot follow: open_by_handle_at"
    )
  })

  it("tells strace every call it watches, by a name it may not know", () => {
    expect(RecordedCalls.traced).toContain("?openat2")
    expect(RecordedCalls.traced).toContain("?getxattrat")
    expect(RecordedCalls.traced).toContain("?open_by_handle_at")
    // What a descriptor names is followed from the copies strace prints.
    expect(RecordedCalls.traced).toContain("?dup2")
    // smthrs-observe's own, and calls strace prints by number, are not asked for.
    expect(RecordedCalls.traced).not.toContain("?rt_sigaction")
    expect(RecordedCalls.traced).not.toContain("?listns")
    expect(ObservedReads.command("strace", "/t", ["true"]).join(" ")).toContain(
      `trace=${RecordedCalls.traced.join(",")}`
    )
  })

  it("is the table smthrs-observe is built with", () => {
    const header = callsHeader()
    expect(header).toContain(`#define LAST_KNOWN ${RecordedCalls.lastKnown}`)
    for (const call of RecordedCalls.calls) {
      const row = `{SYS_${call.name}, "${call.name}",`
      if (call.only === "strace") expect(header).not.toContain(row)
      else expect(header).toContain(row)
    }
    // A flag's value differs between machines where the kernel's does.
    expect(header).toContain("#define OPEN_FOLLOWED FLAGS(0x7fffc3u, 0x7fffc3u)")
    expect(header).toContain(`{SYS_linkat, "linkat", K_LINK, 0, 1, 2, 3, 4, 1, FLAGS(0x1400u, 0x1400u)},`)
    expect(header).toContain(`{SYS_stat, "stat", K_LOOK, CWD, 0, NONE, NONE, NONE, 0, ~0ull},`)
    expect(header).toContain("#ifndef SYS_getxattrat\n#define SYS_getxattrat 464\n#endif")
    // The guard hands strace the calls from 424 to 461 that name a file, and every one from 462 on.
    expect(header).toContain("#define GUARD_FROM 462")
    expect(header).toContain("static const unsigned guarded[] = {437, 439, 452, 428, 429, 430, 431, 432, 433, 442};")
  })

  it("has a way to walk for every row, and no way through a call it does not hold", () => {
    const walked = new Set(Object.values(KernelProbe.ways).map((way) => way.call))
    expect(RecordedCalls.calls.map((call) => call.name).filter((name) => !walked.has(name))).toEqual([])
    expect([...walked].filter((name) => !RecordedCalls.byName.has(name))).toEqual(["(472)"])
  })
})

type Recorder = { readonly tracer: string; readonly supervisor?: true | undefined; readonly guard?: string | undefined }

/** The recorders this host has: strace, through the guard where this package holds one, and smthrs-observe. */
const recorders = (): ReadonlyArray<readonly ["strace" | "observe", Recorder]> => {
  const host = ObservedReads.observer(ExecSandbox.host())
  const supervisor = ObservedReads.supervisorPath(process.platform, process.arch, {
    SMTHRS_OBSERVE_WITH: "smthrs-observe"
  })
  const found: Array<readonly ["strace" | "observe", Recorder]> = []
  if ("tracer" in host && host.supervisor !== true) found.push(["strace", host])
  if (supervisor !== undefined) found.push(["observe", { tracer: supervisor, supervisor: true }])
  return found
}

let made = 0
/** A repository as {@link KernelProbe.files} holds it, with the probe. */
const repository = (): string => {
  made += 1
  const root = Path.join(base, `ws-${made}`)
  for (
    const [path, text] of [
      ...KernelProbe.files,
      ["probe.py", KernelProbe.program] as const,
      ["ring.py", KernelProbe.ringGiver] as const
    ]
  ) {
    const file = Path.join(root, path)
    NodeFs.mkdirSync(Path.dirname(file), { recursive: true })
    if (text.startsWith("-> ")) NodeFs.symlinkSync(text.slice(3), file)
    else NodeFs.writeFileSync(file, text, { mode: path.endsWith(".sh") ? 0o755 : 0o644 })
  }
  return root
}

/** Makes the change a commit makes. */
const change = (root: string, [path, text]: KernelProbe.Change): void => {
  const file = Path.join(root, path)
  NodeFs.rmSync(file, { recursive: true, force: true })
  if (text === undefined) return
  if (text === "/") NodeFs.mkdirSync(file)
  else if (text.startsWith("-> ")) NodeFs.symlinkSync(text.slice(3), file)
  else NodeFs.writeFileSync(file, text)
}

/** The command a way runs: under {@link KernelProbe.ringGiver} when it is given a ring set up outside the run. */
const given = (way: string, command: ReadonlyArray<string>): ReadonlyArray<string> =>
  KernelProbe.ways[way]!.given === "ring" ? ["python3", "ring.py", ...command] : command

const probe = (root: string, way: string): number => {
  const [program, ...rest] = given(way, ["python3", "probe.py", way])
  return spawnSync(program!, rest, { cwd: root, stdio: "ignore", timeout: 60_000 }).status ?? -1
}

/** The probes that explicitly check whether a generated name already exists. */
const checkedOutputs = new Map([
  ["in-root-made-link", "data/root/abs"],
  ["linkat-follow", "build/h"],
  ["linkat-empty-path", "build/h"],
  ["tmpfile-linkat", "build/named.txt"],
  ["sendmmsg", "build/me"]
])

/** What a recorder made of a way: its verdict, and whether the run it recorded exited as the plain run did. */
const recorded = (way: string, observer: Recorder): { readonly exit: number; readonly verdict: string } => {
  const root = repository()
  const preRun = new Map<string, string>()
  for (const [rel] of KernelProbe.files) {
    const abs = Path.join(root, rel)
    preRun.set(abs, ObservedReads.measure(abs))
  }
  const trace = Path.join(base, `trace-${made}`)
  const startedMs = ObservedReads.markStart(Path.join(base, `mark-${made}`))
  // A ring given to the run is set up outside it: before the recorder starts.
  const [program, ...rest] = given(way, ObservedReads.commandFor(observer, trace, ["python3", "probe.py", way]))
  const exit = spawnSync(program!, rest, { cwd: root, stdio: "ignore", timeout: 120_000 }).status ?? -1
  const lines = NodeFs.readFileSync(trace, "utf8").split("\n")
  const stored = ObservedReads.record(ObservedReads.read(() => lines, root), {
    root,
    ignore: [],
    startedMs,
    found: preRun
  })
  if ("refusal" in stored) return { exit, verdict: `not stored: ${stored.refusal}` }
  const output = checkedOutputs.get(way)
  if (output !== undefined) {
    expect(ObservedReads.changed(stored, root)).toBe(`${output} changed`)
    change(root, [output, undefined])
  }
  // Restore the input state, then change one input while keeping the output absent.
  const before = ObservedReads.changed(stored, root)
  if (before !== undefined) return { exit, verdict: `never reused: ${before}` }
  change(root, KernelProbe.ways[way]!.change)
  const after = ObservedReads.changed(stored, root)
  return { exit, verdict: after === undefined ? "STALE PASS" : "stored" }
}

const expectedOf = (expected: KernelProbe.Expected, recorder: "strace" | "observe") =>
  typeof expected === "object" && "strace" in expected ? expected[recorder] : expected

const matrix = process.env["SMTHRS_MATRIX_OUT"]
const linuxIt = it.skipIf(process.platform !== "linux" || recorders().length === 0)

describe("every way a run reaches a file", () => {
  linuxIt.each(Object.keys(KernelProbe.ways))("%s: no recorder gives a stale pass", (way) => {
    const { change: changing, expected } = KernelProbe.ways[way]!
    const plain = repository()
    const before = probe(plain, way)
    // This machine has no such call.
    if (before === 77) return
    change(plain, changing)
    const after = probe(plain, way)
    expect([way, before, after]).toEqual([way, 0, 1])
    const results: Record<string, string> = {}
    for (const [name, observer] of recorders()) {
      const { exit, verdict } = recorded(way, observer)
      results[name] = verdict
      // Recorded, the step does what it does unrecorded.
      expect([way, name, exit]).toEqual([way, name, 0])
      expect([way, name, verdict]).not.toEqual([way, name, "STALE PASS"])
      const wanted = expectedOf(expected, name)
      if (wanted === "either") expect(verdict === "stored" || verdict.startsWith("not stored: ")).toBe(true)
      else if (wanted === "stored") expect([way, name, verdict]).toEqual([way, name, "stored"])
      else {expect([way, name, verdict.startsWith(`not stored: ${wanted.reason}`) ? "ok" : verdict]).toEqual([
          way,
          name,
          "ok"
        ])}
    }
    if (matrix !== undefined) {
      const { call, form } = KernelProbe.ways[way]!
      NodeFs.appendFileSync(matrix, `${JSON.stringify({ way, call, form, plain: [before, after], ...results })}\n`)
    }
  }, 300_000)
})
