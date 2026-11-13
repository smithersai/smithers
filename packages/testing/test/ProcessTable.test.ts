import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { win32 } from "node:path"
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
    const query = { columns: ["pid", "ppid", "pgid", "stat", "comm"], platform: "linux" } as const
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
    expect(
      ProcessTable.query(
        { pid: 123, columns: ["stat"], timeoutMs: 2000, platform: "linux" },
        (_command, args, options) => {
          expect(args).toEqual(["-p", "123", "-ww", "-o", "stat="])
          expect(options.timeout).toBe(2000)
          return result("", 1)
        }
      )
    ).toBe("")
    expect(() => ProcessTable.query({ columns: ["pid"], platform: "linux" }, () => result("", 1))).toThrow(
      "ps failed (1)"
    )
    expect(() => ProcessTable.query({ pid: 123, columns: ["pid"], platform: "linux" }, () => result("partial", 1)))
      .toThrow("ps failed (1)")
    // A successful probe must contain evidence; only ps's explicit no-pid
    // status may mean gone. Empty or truncated success cannot prove cleanup.
    expect(() => ProcessTable.query({ pid: 123, columns: ["pid"], platform: "linux" }, () => result("", 0)))
      .toThrow("ps failed (0)")
  })

  it("propagates spawn errors without treating truncated output as process evidence", () => {
    const error = Object.assign(new Error("spawnSync ps ENOBUFS"), { code: "ENOBUFS" })
    expect(() => ProcessTable.query({ columns: ["pid"], platform: "linux" }, () => ({ ...result("partial"), error })))
      .toThrow(error)
  })
})

describe("ProcessTable.queryWindows", () => {
  it("asks Windows for the selected process and reports resident KiB", () => {
    const spawn: ProcessTable.Spawn = (command, args, options) => {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
      expect(command).toBe(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
      expect(win32.isAbsolute(command)).toBe(true)
      expect(options.env).toEqual({ SystemRoot: systemRoot, PATH: win32.join(systemRoot, "System32") })
      expect(options.env).not.toBe(process.env)
      expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"])
      expect(args[3]).toContain("Get-CimInstance Win32_Process -Filter 'ProcessId = 123'")
      expect(args[3]).toContain("WorkingSetSize / 1024")
      expect(options.maxBuffer).toBe(64 * 1024 * 1024)
      expect(options.timeout).toBe(2000)
      return result("123 256\n")
    }
    expect(ProcessTable.query({ pid: 123, columns: ["pid", "rss"], timeoutMs: 2000, platform: "win32" }, spawn))
      .toBe("123 256\n")
  })

  it.each([undefined, "D:\\Windows Root"])(
    "pins the Windows shell with SystemRoot %s and an untrusted PATH",
    (root) => {
      const child = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `import { queryWindows } from ${JSON.stringify(new URL("../src/ProcessTable.ts", import.meta.url).href)};
       queryWindows({ pid: 1, columns: ["pid"] }, (command, _args, options) => {
         process.stdout.write(JSON.stringify({ command, env: options.env }));
         return { stdout: "1", status: 0 };
       });`
      ], {
        encoding: "utf8",
        env: { ...process.env, SystemRoot: root, PATH: "untrusted", NODE_OPTIONS: "" }
      })
      expect(child.status, child.stderr).toBe(0)
      const systemRoot = root ?? "C:\\Windows"
      const system32 = win32.join(systemRoot, "System32")
      expect(JSON.parse(child.stdout)).toEqual({
        command: win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
        env: { SystemRoot: systemRoot, PATH: system32 }
      })
    }
  )

  it.each(["", ".", "Windows", "C:Windows", "\\Windows", "/Windows"])(
    "rejects non-qualified SystemRoot %j before spawning",
    (root) => {
      const child = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `import { queryWindows } from ${JSON.stringify(new URL("../src/ProcessTable.ts", import.meta.url).href)};
         let calls = 0;
         try {
           queryWindows({ pid: 1, columns: ["pid"] }, () => { calls++; return { stdout: "1", status: 0 }; });
           process.stdout.write(JSON.stringify({ calls }));
         } catch (error) { process.stdout.write(JSON.stringify({ calls, error: error.message })); }`
      ], { encoding: "utf8", env: { ...process.env, SystemRoot: root, NODE_OPTIONS: "" } })
      expect(child.status, child.stderr).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual({
        calls: 0,
        error: "Windows process probe needs a fully qualified SystemRoot"
      })
      const previous = process.env.SystemRoot
      let calls = 0
      try {
        process.env.SystemRoot = root
        expect(() =>
          ProcessTable.queryWindows({ pid: 1, columns: ["pid"] }, () => {
            calls++
            return result("1")
          })
        ).toThrow("Windows process probe needs a fully qualified SystemRoot")
        expect(calls).toBe(0)
      } finally {
        if (previous === undefined) delete process.env.SystemRoot
        else process.env.SystemRoot = previous
      }
    }
  )

  it("returns no row for a missing pid and refuses an empty full scan", () => {
    expect(ProcessTable.queryWindows({ pid: 123, columns: ["pid"] }, () => result(""))).toBe("")
    expect(() => ProcessTable.queryWindows({ columns: ["pid"] }, () => result("")))
      .toThrow("Windows process query failed (0)")
  })

  it("refuses POSIX process groups and propagates probe errors", () => {
    expect(() => ProcessTable.queryWindows({ columns: ["pgid"] }, () => result("")))
      .toThrow("Windows has no POSIX process groups")
    const error = Object.assign(new Error("spawnSync pwsh ENOBUFS"), { code: "ENOBUFS" })
    expect(() => ProcessTable.queryWindows({ columns: ["pid"] }, () => ({ ...result("partial"), error })))
      .toThrow(error)
  })

  it("refuses a pid that is not a positive integer before any probe script is built", () => {
    const scripts: Array<string> = []
    const spawn: ProcessTable.Spawn = (_command, args) => {
      scripts.push(args.join(" "))
      return result("")
    }
    const injected = "0' OR 1=1'; Remove-Item -Recurse C:\\ ; '" as unknown as number
    for (const pid of [injected, 1.5, 0, -4, Number.NaN]) {
      expect(() => ProcessTable.queryWindows({ pid, columns: ["pid"] }, spawn))
        .toThrow("Process probe needs a positive integer pid")
      expect(() => ProcessTable.query({ pid, columns: ["pid"], platform: "win32" }, spawn))
        .toThrow("Process probe needs a positive integer pid")
      expect(() => ProcessTable.query({ pid, columns: ["pid"], platform: "linux" }, spawn))
        .toThrow("Process probe needs a positive integer pid")
    }
    expect(scripts).toEqual([])
  })
})
