import { ProcessLedger } from "@smthrs/kernel"
import { Effect } from "effect"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as ProcessReaper from "../src/ProcessReaper.ts"

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

describe.skipIf(process.platform === "win32")("ProcessReaper.groupVacant", () => {
  it("answers true only after the kernel reports the group has no process", async () => {
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
