/**
 * What a run spent its time on, part by part: the ledger, and the two clocks
 * it reads.
 */
import { describe, expect, it } from "vitest"
import * as Parts from "../src/internal/Parts.ts"

/** Clocks a test moves by hand. */
const clocks = (cpu: number | undefined) => {
  const state = { now: 0, cpu }
  return { state, clocks: { now: () => state.now, cpu: () => state.cpu } satisfies Parts.Clocks }
}

describe("the CPU time of the processes a process waited for", () => {
  it("is read from the sixteenth and seventeenth fields, whatever the program is called", () => {
    const stat = (name: string): string =>
      `4242 (${name}) S 1 4242 4242 0 -1 4194304 100 2000 0 0 11 22 345 67 20 0 9 0 12345 1000 200 18446744073709551615`
    expect(Parts.waitedCpuMs(stat("node"))).toBe(4120)
    // A name with a space and a closing parenthesis moves no field.
    expect(Parts.waitedCpuMs(stat("tmux: server) R 1"))).toBe(4120)
  })

  it("is nothing for a text that is not the file's", () => {
    expect(Parts.waitedCpuMs("")).toBeUndefined()
    expect(Parts.waitedCpuMs("1 (sh) S 1 1 1")).toBeUndefined()
    expect(Parts.waitedCpuMs(`1 (sh) S ${"x ".repeat(20)}`)).toBeUndefined()
  })
})

describe("a ledger", () => {
  it("adds up the time of each part of each target and of the run", () => {
    const { clocks: read, state } = clocks(0)
    const ledger = Parts.ledger(read)
    expect(ledger.of("//:a")).toBeUndefined()
    expect(ledger.of(undefined)).toBeUndefined()
    const step = ledger.begin("//:a", "step")
    state.now = 1200.04
    state.cpu = 900
    step()
    const again = ledger.begin("//:a", "step")
    const reads = ledger.begin("//:a", "reads")
    state.now = 1500
    state.cpu = 1000
    again()
    reads()
    ledger.spend(undefined, "answer", 12.345)
    ledger.spend("//:b", "store", 3, 1)
    expect(ledger.of("//:a")).toEqual({ ms: { step: 1500, reads: 300 }, cpuMs: { step: 1000, reads: 100 } })
    expect(ledger.of("//:b")).toEqual({ ms: { store: 3 }, cpuMs: { store: 1 } })
    // A part timed without a CPU reading has a wall time alone.
    expect(ledger.of(undefined)).toEqual({ ms: { answer: 12.3 } })
  })

  it("has no CPU time where the host's processes cannot be read", () => {
    const { clocks: read, state } = clocks(undefined)
    const ledger = Parts.ledger(read)
    const end = ledger.begin("//:a", "step")
    state.now = 40
    end()
    expect(ledger.of("//:a")).toEqual({ ms: { step: 40 } })
    // A clock that could be read when the part began and not when it ended says nothing either.
    state.cpu = 5
    const other = ledger.begin("//:a", "keep")
    state.cpu = undefined
    state.now = 50
    other()
    expect(ledger.of("//:a")).toEqual({ ms: { step: 40, keep: 10 } })
  })

  it("reads this process's clocks unless it is given others", () => {
    const ledger = Parts.ledger()
    const end = ledger.begin("//:a", "step")
    end()
    const spent = ledger.of("//:a")!
    expect(spent.ms["step"]).toBeGreaterThanOrEqual(0)
    expect(Parts.hostClocks.now()).toBeGreaterThan(0)
    // Linux says what the processes this one waited for used; no other system does.
    if (process.platform === "linux") expect(Parts.hostClocks.cpu()).toBeGreaterThan(0)
    else expect(Parts.hostClocks.cpu()).toBeUndefined()
  })
})

describe("the clocks of a process", () => {
  it("add its own CPU time to that of the processes it waited for", () => {
    const stat = "7 (node) S 1 7 7 0 -1 0 0 0 0 0 1 1 300 200 20 0 1 0 1 1 1 1"
    const own = process.cpuUsage()
    const cpu = Parts.clocksOf(() => stat).cpu()!
    expect(cpu).toBeGreaterThanOrEqual(5000 + (own.user + own.system) / 1000)
    expect(cpu).toBeLessThan(5000 + (own.user + own.system) / 1000 + 60_000)
  })

  it("have no CPU time where the file cannot be read, or is another file", () => {
    expect(
      Parts.clocksOf(() => {
        throw new Error("ENOENT")
      }).cpu()
    ).toBeUndefined()
    expect(Parts.clocksOf(() => "not the file").cpu()).toBeUndefined()
  })
})

describe("the time before a program's first run", () => {
  it("is the start up to the command and the planning after it, given to the first run alone", () => {
    const { clocks: read, state } = clocks(700)
    state.now = 2500
    // Nothing before the command began: a program that embeds the build has no start to name.
    const embedded = Parts.ledger(read)
    Parts.beforeRun(embedded, read, true)
    expect(embedded.of(undefined)).toBeUndefined()
    Parts.commandBegan(read)
    // The first call counts.
    state.now = 2600
    Parts.commandBegan(read)
    state.now = 3100
    state.cpu = 1000
    const first = Parts.ledger(read)
    Parts.beforeRun(first, read, true)
    expect(first.of(undefined)).toEqual({ ms: { start: 2500, plan: 600 }, cpuMs: { start: 700, plan: 300 } })
    const second = Parts.ledger(read)
    Parts.beforeRun(second, read)
    expect(second.of(undefined)).toBeUndefined()
    // Where the CPU clock cannot be read now, the planning has a wall time alone.
    state.cpu = undefined
    const unread = Parts.ledger(read)
    Parts.beforeRun(unread, read, true)
    expect(unread.of(undefined)).toEqual({ ms: { start: 2500, plan: 600 }, cpuMs: { start: 700 } })
  })
})
