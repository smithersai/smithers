import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ProcSnapshot from "../src/internal/ProcSnapshot.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"

/** The boot second every fixture start time is measured from. */
const bootSeconds = 1_700_000_000

const roots: Array<string> = []

/** One `/proc/<pid>/stat` line in the kernel's own field order. */
const statLine = (options: {
  readonly pid: number | string
  readonly comm?: string
  readonly state?: string
  readonly pgid: number | string
  readonly startTicks?: number | string
}): string => {
  // Fields 6..21 sit between pgrp and starttime and are never read, so they are
  // filler that only has to be present in the right quantity.
  const filler = Array.from({ length: 16 }, (_, index) => String(index)).join(" ")
  return `${options.pid} (${options.comm ?? "node"}) ${options.state ?? "S"} 1 ${options.pgid} ${filler} ${
    options.startTicks ?? 100
  } 0 0\n`
}

interface Fixture {
  readonly pid: number
  readonly pgid: number
  readonly state?: string
  readonly startTicks?: number
}

const procRoot = (processes: ReadonlyArray<Fixture>, self: number, btime = String(bootSeconds)): string => {
  const root = mkdtempSync(join(tmpdir(), "proc-snapshot-"))
  roots.push(root)
  writeFileSync(join(root, "stat"), `cpu  1 2 3\nbtime ${btime}\nprocesses 99\n`)
  for (const entry of processes) {
    const line = statLine(entry)
    mkdirSync(join(root, String(entry.pid)))
    writeFileSync(join(root, String(entry.pid), "stat"), line)
    if (entry.pid === self) {
      mkdirSync(join(root, "self"))
      writeFileSync(join(root, "self", "stat"), line)
    }
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("ProcSnapshot.parseStat", () => {
  it("reads the fields after the LAST close paren, so a comm holding spaces and parens is not a field", () => {
    const parsed = ProcSnapshot.parseStat(
      statLine({ pid: 41, comm: "my (odd) name", pgid: 40, startTicks: 250 }),
      1_000
    )

    expect(parsed?.pgid).toBe(40)
    expect(parsed?.member).toEqual({ pid: 41, startedAtMs: 3_500, zombie: false })
  })

  it("marks state Z as a zombie and every other state as live", () => {
    expect(ProcSnapshot.parseStat(statLine({ pid: 7, pgid: 7, state: "Z" }), 0)?.member.zombie).toBe(true)
    for (const state of ["R", "S", "D", "T", "I"]) {
      expect(ProcSnapshot.parseStat(statLine({ pid: 7, pgid: 7, state }), 0)?.member.zombie).toBe(false)
    }
  })

  it("refuses anything that is not a stat line, rather than building a record from what parsed", () => {
    // No comm parens at all, a line that opens with one, and a reversed pair.
    expect(ProcSnapshot.parseStat("41 node S 1 40", 0)).toBeUndefined()
    expect(ProcSnapshot.parseStat("(node) 41 S", 0)).toBeUndefined()
    expect(ProcSnapshot.parseStat("41 )node( S", 0)).toBeUndefined()
    // A first field that is not a pid, and a line truncated before starttime.
    expect(ProcSnapshot.parseStat("pid (node) S 1 40 0 0 0 0 0", 0)).toBeUndefined()
    expect(ProcSnapshot.parseStat("41 (node) S 1 40", 0)).toBeUndefined()
  })

  it("refuses a pid, group or start time too large to be an exact number", () => {
    const huge = "99999999999999999999"
    expect(ProcSnapshot.parseStat(statLine({ pid: huge, pgid: 40 }), 0)).toBeUndefined()
    expect(ProcSnapshot.parseStat(statLine({ pid: 41, pgid: huge }), 0)).toBeUndefined()
    expect(ProcSnapshot.parseStat(statLine({ pid: 41, pgid: 40, startTicks: huge }), 0)).toBeUndefined()
  })
})

describe("ProcSnapshot.snapshot", () => {
  it("answers this process's own group and only the members of the group asked for", () => {
    const root = procRoot([
      { pid: 10, pgid: 10 },
      { pid: 11, pgid: 10, state: "Z" },
      { pid: 12, pgid: 99 },
      { pid: 500, pgid: 500 }
    ], 500)

    const observed = ProcSnapshot.snapshot(root)(10)

    expect(observed?.ownGroup).toBe(500)
    expect(observed?.members.map((member) => member.pid).sort((left, right) => left - right)).toEqual([10, 11])
    expect(observed?.members.find((member) => member.pid === 11)?.zombie).toBe(true)
  })

  it("measures start times from btime, so they are absolute rather than elapsed", () => {
    const root = procRoot([{ pid: 21, pgid: 21, startTicks: 350 }], 21)

    expect(ProcSnapshot.snapshot(root)(21)?.members[0]?.startedAtMs).toBe(bootSeconds * 1_000 + 3_500)
  })

  it("skips a pid that ended between listing the directory and reading its stat", () => {
    const root = procRoot([{ pid: 30, pgid: 30 }, { pid: 31, pgid: 30 }], 30)
    rmSync(join(root, "31", "stat"))

    expect(ProcSnapshot.snapshot(root)(30)?.members.map((member) => member.pid)).toEqual([30])
  })

  it("answers nothing, rather than an empty group, when the table cannot be read", () => {
    expect(ProcSnapshot.snapshot(join(tmpdir(), "proc-snapshot-absent"))(1)).toBeUndefined()

    const noBtime = mkdtempSync(join(tmpdir(), "proc-snapshot-"))
    roots.push(noBtime)
    writeFileSync(join(noBtime, "stat"), "cpu  1 2 3\n")
    expect(ProcSnapshot.snapshot(noBtime)(1)).toBeUndefined()

    // btime past the exact-integer range, an unparseable self, and a self with
    // no group are each a table this host cannot act on.
    expect(ProcSnapshot.snapshot(procRoot([{ pid: 40, pgid: 40 }], 40, "999999999999999999"))(40)).toBeUndefined()

    const badSelf = procRoot([{ pid: 41, pgid: 41 }], 41)
    writeFileSync(join(badSelf, "self", "stat"), "not a stat line\n")
    expect(ProcSnapshot.snapshot(badSelf)(41)).toBeUndefined()

    expect(ProcSnapshot.snapshot(procRoot([{ pid: 42, pgid: 0 }], 42))(42)).toBeUndefined()
  })

  it("answers nothing when a member is unreadable, rather than reporting a short group", () => {
    const unparseable = procRoot([{ pid: 50, pgid: 50 }, { pid: 51, pgid: 50 }], 50)
    writeFileSync(join(unparseable, "51", "stat"), "not a stat line\n")
    expect(ProcSnapshot.snapshot(unparseable)(50)).toBeUndefined()

    // A read that fails for any reason other than the pid being gone.
    const unreadable = procRoot([{ pid: 60, pgid: 60 }, { pid: 61, pgid: 60 }], 60)
    rmSync(join(unreadable, "61", "stat"))
    mkdirSync(join(unreadable, "61", "stat"))
    expect(ProcSnapshot.snapshot(unreadable)(60)).toBeUndefined()
  })
})

describe.runIf(process.platform === "linux")("ProcSnapshot.snapshot on a real /proc", () => {
  it("finds this very process in its own group", () => {
    const own = ProcSnapshot.snapshot(ProcSnapshot.defaultProcRoot)(process.pid)

    expect(own?.ownGroup).toBeGreaterThan(0)
    const group = ProcSnapshot.snapshot(ProcSnapshot.defaultProcRoot)(own!.ownGroup)
    expect(group?.members.some((member) => member.pid === process.pid)).toBe(true)
  })
})

describe("ProcessReaper.groupSnapshotFor", () => {
  it("asks the kernel directly on Linux and ps everywhere else", () => {
    // On Linux the reader needs no `ps` binary at all, which is the whole
    // point: `procps` is absent from the Cloud CI image (run 11727).
    const linux = ProcessReaper.groupSnapshotFor("linux")
    const posix = ProcessReaper.groupSnapshotFor("darwin")

    expect(linux).not.toBe(posix)
    // Whichever host runs this suite, exactly one of the two can answer, and
    // neither may invent a group it did not observe.
    const answers = [linux(process.pid), posix(process.pid)].filter((observed) => observed !== undefined)
    expect(answers.length).toBe(1)
    expect(answers[0]!.ownGroup).toBeGreaterThan(0)
  })
})
