import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { describe, expect, it } from "vitest"
import * as ProcessTable from "../src/ProcessTable.ts"

const result = (stdout: string, status = 0): SpawnSyncReturns<string> => ({
  pid: 1,
  output: [null, stdout, ""],
  stdout,
  stderr: "",
  status,
  signal: null
})

describe("ProcessTable.query", () => {
  it("retains a synthetic 5 MiB process table through the real spawn buffer", () => {
    const output = "123 1 123 S worker\n".repeat(Math.ceil(5 * 1024 * 1024 / 19))
    const query = { columns: ["pid", "ppid", "pgid", "stat", "comm"] } as const
    const spawn: ProcessTable.Spawn = (command, args, options) => {
      expect(command).toBe("ps")
      expect(args).toEqual(["-A", "-ww", "-o", "pid=,ppid=,pgid=,stat=,comm="])
      expect(options.maxBuffer).toBe(64 * 1024 * 1024)
      expect(options.timeout).toBeUndefined()
      // The injected producer writes real bytes through Node's spawnSync.
      // Its output exceeds the default buffer; no fabricated success result.
      return spawnSync(process.execPath, [
        "-e",
        `process.stdout.write(${JSON.stringify("123 1 123 S worker\n")}.repeat(${Math.ceil(5 * 1024 * 1024 / 19)}))`
      ], options)
    }
    expect(Buffer.byteLength(output)).toBeGreaterThanOrEqual(5 * 1024 * 1024)
    expect(ProcessTable.query(query, spawn)).toBe(output)
  })

  it("reads a real process using only its pid and resident size", () => {
    const row = ProcessTable.query({ pid: process.pid, columns: ["pid", "rss"] }).trim().split(/\s+/)
    expect(Number(row[0])).toBe(process.pid)
    expect(Number(row[1])).toBeGreaterThan(0)
  })

  it("accepts an empty selected pid but refuses a failed full-table scan", () => {
    expect(ProcessTable.query({ pid: 123, columns: ["stat"], timeoutMs: 2000 }, (_command, args, options) => {
      expect(args).toEqual(["-p", "123", "-ww", "-o", "stat="])
      expect(options.timeout).toBe(2000)
      return result("", 1)
    })).toBe("")
    expect(() => ProcessTable.query({ columns: ["pid"] }, () => result("", 1))).toThrow("ps failed (1)")
    expect(() => ProcessTable.query({ pid: 123, columns: ["pid"] }, () => result("partial", 1)))
      .toThrow("ps failed (1)")
    // A successful probe must contain evidence; only ps's explicit no-pid
    // status may mean gone. Empty or truncated success cannot prove cleanup.
    expect(() => ProcessTable.query({ pid: 123, columns: ["pid"] }, () => result("", 0)))
      .toThrow("ps failed (0)")
  })

  it("propagates spawn errors without treating truncated output as process evidence", () => {
    const error = Object.assign(new Error("spawnSync ps ENOBUFS"), { code: "ENOBUFS" })
    expect(() => ProcessTable.query({ columns: ["pid"] }, () => ({ ...result("partial"), error }))).toThrow(error)
  })
})
