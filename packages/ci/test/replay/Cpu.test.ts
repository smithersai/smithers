/** The CPU time of a process tree, added up from readings of the machine's processes. */
import { describe, expect, it } from "vitest"
import { cpuMsOf, meterOf, observe } from "../../src/replay/Cpu.ts"
import type { ProcessEntry } from "../../src/replay/ProcessTable.ts"

/** A process as Linux gives it: its own time, the time of the children it waited for, and when it started. */
const process = (pid: number, parent: number, ownMs: number, waitedMs = 0, started = pid): ProcessEntry => ({
  pid,
  parent,
  cpuMs: ownMs + waitedMs,
  ownMs,
  waitedMs,
  started
})

describe("the CPU time of a step", () => {
  it("is nothing before anything was read, and when the step was never seen", () => {
    const meter = meterOf(10)
    expect(cpuMsOf(meter)).toBe(0)
    observe(meter, [process(1, 0, 500), process(2, 1, 300)])
    expect(cpuMsOf(meter)).toBe(0)
  })

  it("adds each process of the tree for itself, and leaves the rest of the machine out", () => {
    const meter = meterOf(10)
    observe(meter, [process(1, 0, 9000), process(10, 1, 100), process(11, 10, 200), process(12, 11, 400)])
    expect(cpuMsOf(meter)).toBe(700)
  })

  it("keeps what a process had used when it is gone, though nothing handed that time up", () => {
    const meter = meterOf(10)
    observe(meter, [process(10, 1, 100), process(11, 10, 2000)])
    // The child ended, and the process that started it never waited for it, as a jail's does not.
    observe(meter, [process(10, 1, 150)])
    expect(cpuMsOf(meter)).toBe(2150)
    // Nor does the time vanish when the whole tree is gone.
    observe(meter, [])
    expect(cpuMsOf(meter)).toBe(2150)
  })

  it("counts a child once when its parent waited for it", () => {
    const meter = meterOf(10)
    observe(meter, [process(10, 1, 100), process(11, 10, 2000)])
    // The child used 500 ms more after it was read, and all 2500 ms were handed to its parent.
    observe(meter, [process(10, 1, 100, 2500)])
    expect(cpuMsOf(meter)).toBe(2600)
  })

  it("counts a grandchild once when its time came up through a parent that ended between two readings", () => {
    const meter = meterOf(10)
    // The grandchild had used 8 s when it was read; its parent had waited for nothing yet.
    observe(meter, [process(10, 1, 100), process(11, 10, 1000), process(12, 11, 8000)])
    // Then the grandchild ended, its parent waited for it and ended, and all 9 s came up to the process on top.
    observe(meter, [process(10, 1, 100, 9000)])
    expect(cpuMsOf(meter)).toBe(9100)
    // The same over three generations, with half a second more used at each after it was last read.
    const deep = meterOf(20)
    observe(deep, [process(20, 1, 100), process(21, 20, 1000), process(22, 21, 2000), process(23, 22, 4000)])
    observe(deep, [process(20, 1, 100, 8500)])
    expect(cpuMsOf(deep)).toBe(8600)
  })

  it("counts a deep process tree after its descendants exit", () => {
    const meter = meterOf(1)
    observe(meter, Array.from({ length: 12_000 }, (_, index) => process(index + 1, index, 1)))
    observe(meter, [])
    expect(cpuMsOf(meter)).toBe(12_000)
  })

  it("counts the children that came and went between two readings", () => {
    const meter = meterOf(10)
    observe(meter, [process(10, 1, 100)])
    observe(meter, [process(10, 1, 100, 3000)])
    expect(cpuMsOf(meter)).toBe(3100)
  })

  it("counts what a process had waited for before it was first read", () => {
    const meter = meterOf(10)
    observe(meter, [process(10, 1, 100, 700), process(11, 10, 50, 40)])
    expect(cpuMsOf(meter)).toBe(890)
    // What it waits for later is counted once more, and only the part no process seen explains.
    observe(meter, [process(10, 1, 100, 800)])
    expect(cpuMsOf(meter)).toBe(900)
  })

  it("never counts less than it has seen when a child's time went elsewhere", () => {
    const meter = meterOf(10)
    observe(meter, [process(10, 1, 100), process(11, 10, 2000), process(12, 10, 300)])
    // 11 ended and was taken over by another process; 12 ended and was waited for.
    observe(meter, [process(10, 1, 100, 300)])
    expect(cpuMsOf(meter)).toBe(2400)
  })

  it("tells a process from a later one with the same id", () => {
    const meter = meterOf(10)
    observe(meter, [process(10, 1, 100), process(11, 10, 400, 0, 1000)])
    observe(meter, [process(10, 1, 100), process(11, 10, 50, 0, 2000)])
    expect(cpuMsOf(meter)).toBe(550)
  })

  it("reads a table that gives one number for a process, as ps does", () => {
    const meter = meterOf(10)
    observe(meter, [{ pid: 10, parent: 1, cpuMs: 100 }, { pid: 11, parent: 10, cpuMs: 200 }])
    observe(meter, [{ pid: 10, parent: 1, cpuMs: 250 }])
    expect(cpuMsOf(meter)).toBe(450)
  })

  it("survives a table where a process is its own parent", () => {
    const meter = meterOf(10)
    observe(meter, [process(10, 10, 100)])
    expect(cpuMsOf(meter)).toBe(100)
  })
})
