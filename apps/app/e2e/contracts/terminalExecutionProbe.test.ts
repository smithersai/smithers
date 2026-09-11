import { describe, expect, test } from "bun:test"
import { terminalExecutionProbe } from "./terminalExecutionProbe"

const probe = terminalExecutionProbe("0123456789abcdef")
const prompt = "smithers@packaged terminal-repository % "

describe("terminalExecutionProbe", () => {
  test("keeps the marker out of the typed command, so echo cannot forge it", () => {
    expect(probe.command).not.toContain(probe.marker)
  })

  test("rejects echoed input when Enter never reached the shell", () => {
    const echoOnly = `${prompt}${probe.command}`
    expect(probe.echoed(echoOnly)).toBe(true)
    expect(probe.executed(echoOnly)).toBe(false)
  })

  test("reads a wrapped echo as echo, still without execution evidence", () => {
    const split = Math.floor(probe.command.length / 2)
    const wrapped = `${prompt}${probe.command.slice(0, split)}\r\n${probe.command.slice(split)}`
    expect(probe.echoed(wrapped)).toBe(true)
    expect(probe.executed(wrapped)).toBe(false)
  })

  test("accepts a standalone marker line from the PTY stream", () => {
    const ran = `${prompt}${probe.command}\r\n${probe.marker}\r\n${prompt}`
    expect(probe.executed(ran)).toBe(true)
  })

  test("accepts a marker row read out of the xterm grid, padded as it renders", () => {
    const rows = [`${prompt}${probe.command}`, `${probe.marker}\u00a0\u00a0`, prompt].join("\n")
    expect(probe.executed(rows)).toBe(true)
  })

  test("rejects a marker that shares its line with other output", () => {
    expect(probe.executed(`${prompt}echo ${probe.marker}`)).toBe(false)
  })
})
