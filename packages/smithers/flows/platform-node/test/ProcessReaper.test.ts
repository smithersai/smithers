import { ProcessLedger } from "@smthrs/kernel"
import { Effect, Layer } from "effect"
import NativeMutable, { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join, parse } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { resolveDefaultExecutable } from "../src/internal/AtomicFileSystemExecutable.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"

vi.mock("../src/internal/AtomicFileSystemExecutable.ts", async (original) => {
  const module = await original<typeof import("../src/internal/AtomicFileSystemExecutable.ts")>()
  return { ...module, resolveDefaultExecutable: vi.fn(module.resolveDefaultExecutable) }
})

describe.skipIf(process.platform === "win32")("ProcessReaper start-time timezone", () => {
  it.each(["UTC", "Pacific/Honolulu", "America/New_York"])(
    "keeps a matching record actionable with runtime TZ=%s",
    async (timezone) => {
      const directory = mkdtempSync(join(tmpdir(), "reaper-timezone-"))
      const executable = join(directory, "ps")
      try {
        // Observe the probe's actual environment independently of its output.
        writeFileSync(
          executable,
          `#!/bin/sh\nprintf '%s' "$TZ" > "$0.timezone"\nprintf 'Sat Sep  5 12:00:00 2026\\n'\n`,
          { mode: 0o755 }
        )
        // A separate runtime makes TZ effective even under Vitest's thread pool.
        const output = execFileSync(process.execPath, [
          "--input-type=module",
          "--eval",
          `import { posixSystemWith } from ${JSON.stringify(new URL("../src/ProcessReaper.ts", import.meta.url).href)};
          console.log(JSON.stringify(posixSystemWith({ psExecutable: process.argv[1] }).startedAtMs(process.pid)));`,
          executable
        ], { env: { ...process.env, TZ: timezone }, encoding: "utf8", timeout: 30_000 })
        const measured: ProcessReaper.StartTime = JSON.parse(output)
        const record: ProcessLedger.ProcessRecord = {
          pid: 900001,
          pgid: 900001,
          hostId: "timezone",
          ownerPid: 900002,
          startedAtMs: Date.UTC(2026, 8, 5, 12),
          commandDigest: "timezone"
        }
        const skipped: Array<string> = []
        const reaped: Array<number> = []
        const killed: Array<number> = []
        const ledger: ProcessLedger.Service = {
          record: () => Effect.die("unused"),
          release: () => Effect.void,
          reaped: (row) => Effect.sync(() => void reaped.push(row.pid)),
          skipped: (_row, reason) => Effect.sync(() => void skipped.push(reason)),
          live: Effect.succeed([]),
          orphans: Effect.succeed([record])
        }
        const outcomes = await Effect.runPromise(
          ProcessReaper.reap({
            ownerPid: 900003,
            system: {
              ...ProcessReaper.posixSystem,
              bootedAtMs: () => 0,
              ownGroup: () => 900004,
              isAlive: () => "dead",
              startedAtMs: () => measured,
              killTree: (row) => {
                killed.push(row.pid)
                return "signalled"
              }
            }
          }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, ledger))
        )

        expect(outcomes).toEqual([{ record, killed: true }])
        expect(skipped).toEqual([])
        expect(killed).toEqual([record.pid])
        expect(reaped).toEqual([record.pid])
        expect(measured).toEqual({ _tag: "started", startedAtMs: record.startedAtMs })
        expect(readFileSync(`${executable}.timezone`, "utf8")).toBe("UTC")
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})

describe("ProcessReaper.groupVacant", () => {
  it.skipIf(process.platform === "win32")(
    "answers true only after the kernel reports the group has no process",
    async () => {
      const leader = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" })
      const pgid = leader.pid!
      try {
        expect(ProcessReaper.groupVacant(pgid)).toBe(false)
      } finally {
        leader.kill("SIGKILL")
      }
      await new Promise((resolve) => leader.once("exit", resolve))
      // Node reaps on exit; poll briefly for the kernel to drop the group.
      const deadline = Date.now() + 5000
      while (!ProcessReaper.groupVacant(pgid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
      expect(ProcessReaper.groupVacant(pgid)).toBe(true)
    }
  )

  it("distinguishes a populated group from ESRCH without native signals", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    try {
      expect(ProcessReaper.groupVacant(4242)).toBe(false)
      kill.mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" })
      })
      expect(ProcessReaper.groupVacant(4242)).toBe(true)
      expect(kill).toHaveBeenCalledWith(-4242, 0)
    } finally {
      kill.mockRestore()
    }
  })

  it("never addresses the caller's group or every process", () => {
    const kill = vi.spyOn(process, "kill")
    try {
      for (const pgid of [1, 0, -5, 1.5, Number.NaN]) expect(ProcessReaper.groupVacant(pgid)).toBe(false)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it("treats another user's member or an unknown error as not vacant", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    })
    try {
      expect(ProcessReaper.groupVacant(4242)).toBe(false)
      expect(kill).toHaveBeenCalledWith(-4242, 0)
    } finally {
      kill.mockRestore()
    }
  })
})

describe("ProcessReaper over an unreadable ledger history", () => {
  const unreadable = (touched: Array<string>): ProcessLedger.Service => ({
    record: () => Effect.die("unused"),
    release: () => Effect.void,
    reaped: () => Effect.sync(() => void touched.push("reaped")),
    skipped: () => Effect.sync(() => void touched.push("skipped")),
    live: Effect.succeed([]),
    orphans: Effect.fail(
      new ProcessLedger.ProcessLedgerReplayError({ code: "journal_unreadable", message: "journal offline" })
    )
  })
  const system: ProcessReaper.System = {
    ...ProcessReaper.posixSystem,
    killTree: () => {
      throw new Error("a sweep over an unread history must not signal anything")
    }
  }

  it("fails the sweep with the replay error instead of reporting nothing to reap", async () => {
    const touched: Array<string> = []
    const failure = await Effect.runPromise(
      Effect.flip(ProcessReaper.reap({ system })).pipe(
        Effect.provideService(ProcessLedger.ProcessLedger, unreadable(touched))
      )
    )
    expect(failure._tag).toBe("@smthrs/kernel/ProcessLedgerReplayError")
    expect(touched).toEqual([])
  })

  it("still builds the host layer, refusing the sweep and retiring nothing", async () => {
    const touched: Array<string> = []
    await Effect.runPromise(
      Layer.build(ProcessReaper.layer({ system })).pipe(
        Effect.scoped,
        Effect.provideService(ProcessLedger.ProcessLedger, unreadable(touched))
      )
    )
    expect(touched).toEqual([])
  })
})

describe("Windows native process identity", () => {
  it("queries a trusted executable with bounded output and no inherited environment", () => {
    const query = vi.spyOn(NativeMutable, "spawnSync").mockReturnValue({
      pid: 100,
      output: [],
      stdout: JSON.stringify({ status: "started", startedAtMs: 123456 }),
      stderr: "",
      status: 0,
      signal: null
    })
    syncBuiltinESMExports()
    try {
      const system = ProcessReaper.windowsSystemWith({ processExecutable: process.execPath })
      expect(system.startedAtMs(4242)).toEqual({ _tag: "started", startedAtMs: 123456 })
      expect(query).toHaveBeenCalledWith(expect.any(String), ["--process-info", "4242"], {
        cwd: parse(process.execPath).root,
        env: {},
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 4096
      })
      query.mockReturnValueOnce({
        pid: 100,
        output: [],
        stdout: "{\"status\":\"gone\"}",
        stderr: "",
        status: 0,
        signal: null
      })
      expect(system.startedAtMs(4242)).toEqual({ _tag: "gone" })
      const previous = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
      delete process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
      vi.mocked(resolveDefaultExecutable).mockReturnValueOnce(process.execPath)
      try {
        expect(ProcessReaper.windowsSystemWith().startedAtMs(4242)).toEqual({ _tag: "started", startedAtMs: 123456 })
        expect(resolveDefaultExecutable).toHaveBeenCalledWith(expect.any(String), undefined)
      } finally {
        if (previous === undefined) delete process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
        else process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY = previous
      }
      query.mockClear()
      for (const pid of [0, 1, -1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
        expect(system.startedAtMs(pid)).toEqual({ _tag: "unavailable" })
      }
      expect(query).not.toHaveBeenCalled()
    } finally {
      query.mockRestore()
      syncBuiltinESMExports()
    }
  })

  it("keeps identity unavailable for denied, interrupted, or malformed queries", () => {
    const query = vi.spyOn(NativeMutable, "spawnSync")
    syncBuiltinESMExports()
    try {
      const system = ProcessReaper.windowsSystemWith({ processExecutable: process.execPath })
      const reply = { pid: 100, output: [], stdout: "{}", stderr: "", status: 0, signal: null }
      for (
        const stdout of [
          "invalid",
          "null",
          "[]",
          "{}",
          "{\"status\":\"unknown\"}",
          "{\"status\":\"started\"}",
          "{\"status\":\"started\",\"startedAtMs\":\"1\"}",
          "{\"status\":\"started\",\"startedAtMs\":-1}",
          "{\"status\":\"started\",\"startedAtMs\":1.5}",
          "{\"status\":\"started\",\"startedAtMs\":9007199254740992}"
        ]
      ) {
        query.mockReturnValueOnce({ ...reply, stdout })
        expect(system.startedAtMs(4242)).toEqual({ _tag: "unavailable" })
      }
      for (
        const result of [{ ...reply, error: new Error("denied") }, { ...reply, signal: "SIGKILL" as const }, {
          ...reply,
          status: 1
        }]
      ) {
        query.mockReturnValueOnce(result)
        expect(system.startedAtMs(4242)).toEqual({ _tag: "unavailable" })
      }
      query.mockImplementationOnce(() => {
        throw new Error("spawn refused")
      })
      expect(system.startedAtMs(4242)).toEqual({ _tag: "unavailable" })
      query.mockClear()
      expect(ProcessReaper.windowsSystemWith({ processExecutable: "relative-helper" }).startedAtMs(4242)).toEqual({
        _tag: "unavailable"
      })
      expect(query).not.toHaveBeenCalled()
    } finally {
      query.mockRestore()
      syncBuiltinESMExports()
    }
  })
})

describe("POSIX signal results through the native seam", () => {
  it("parses a successful POSIX timestamp on every host", () => {
    const query = vi.spyOn(NativeMutable, "spawnSync").mockReturnValue({
      pid: 100,
      output: [],
      stdout: "Sat Sep  5 12:00:00 2026",
      stderr: "",
      status: 0,
      signal: null
    })
    syncBuiltinESMExports()
    try {
      expect(ProcessReaper.posixSystem.startedAtMs(900001)).toEqual({
        _tag: "started",
        startedAtMs: Date.UTC(2026, 8, 5, 12)
      })
    } finally {
      query.mockRestore()
      syncBuiltinESMExports()
    }
  })

  it.each(["pid", "pgid"] as const)("refuses a stored %s naming the observed caller group", async (field) => {
    const record: ProcessLedger.ProcessRecord = {
      pid: 900001,
      pgid: 900001,
      hostId: "probe",
      ownerPid: 900003,
      startedAtMs: 1,
      commandDigest: "probe",
      [field]: 77
    }
    const killTree = vi.fn(() => "signalled" as const)
    const ledger: ProcessLedger.Service = {
      record: () => Effect.die("unused"),
      release: () => Effect.void,
      reaped: () => Effect.die("must not retire"),
      skipped: () => Effect.void,
      live: Effect.succeed([]),
      orphans: Effect.succeed([record])
    }
    const result = await Effect.runPromise(
      ProcessReaper.reap({
        ownerPid: 900002,
        system: { ...ProcessReaper.posixSystem, ownGroup: () => 77, killTree }
      }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, ledger))
    )
    expect(result).toEqual([{ record, killed: false, refusal: "own-group" }])
    expect(killTree).not.toHaveBeenCalled()
  })

  it("preserves unknown liveness and failed group signals", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    const query = vi.spyOn(NativeMutable, "spawnSync").mockReturnValue({
      pid: 100,
      output: [],
      stdout: "77",
      stderr: "",
      status: 0,
      signal: null
    })
    syncBuiltinESMExports()
    try {
      const system = ProcessReaper.posixSystemWith({ ownerPid: 900002 })
      const record: ProcessLedger.ProcessRecord = {
        pid: 900001,
        pgid: 900001,
        hostId: "probe",
        ownerPid: 900003,
        startedAtMs: 1,
        commandDigest: "probe"
      }
      expect(system.isAlive(record.pid)).toBe("alive")
      expect(system.killTree(record)).toBe("signalled")
      expect(kill).toHaveBeenLastCalledWith(-record.pid, "SIGKILL")
      for (
        const [code, alive, outcome] of [
          ["ESRCH", "dead", "already-gone"],
          ["EPERM", "unknown", "failed"],
          ["EINVAL", "unknown", "failed"]
        ] as const
      ) {
        kill.mockImplementation(() => {
          throw Object.assign(new Error(code), { code })
        })
        expect(system.isAlive(record.pid)).toBe(alive)
        expect(system.killTree(record)).toBe(outcome)
      }
    } finally {
      kill.mockRestore()
      query.mockRestore()
      syncBuiltinESMExports()
    }
  })
})
