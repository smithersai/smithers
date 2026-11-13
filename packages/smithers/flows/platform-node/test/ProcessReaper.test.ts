import { ProcessLedger } from "@smthrs/kernel"
import { Effect, Layer } from "effect"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, parse } from "node:path"
import { describe, expect, it } from "vitest"
import { usableExecutable } from "../src/internal/AtomicFileSystemTransport.ts"
import { groupVacant, posixSystemFrom } from "../src/internal/ProcessNative.ts"
import { windowsIdentity } from "../src/internal/WindowsIdentity.ts"
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

describe("ProcessReaper.reap owner liveness", () => {
  it("reaps a record whose dead owner had the pid this host now has", async () => {
    const record: ProcessLedger.ProcessRecord = {
      pid: 900011,
      pgid: 900011,
      hostId: "same-pid",
      ownerPid: 900012,
      startedAtMs: 10_000,
      commandDigest: "agent",
      incarnation: "dead"
    }
    const probed: Array<number> = []
    const killed: Array<number> = []
    const ledger: ProcessLedger.Service = {
      record: () => Effect.die("unused"),
      release: () => Effect.void,
      reaped: () => Effect.void,
      skipped: () => Effect.die("unused"),
      live: Effect.succeed([]),
      orphans: Effect.succeed([record])
    }
    const outcomes = await Effect.runPromise(
      ProcessReaper.reap({
        // The successor was given the dead incarnation's pid.
        ownerPid: record.ownerPid,
        system: {
          ...ProcessReaper.posixSystem,
          bootedAtMs: () => 0,
          ownGroup: () => 900013,
          isAlive: (pid) => {
            probed.push(pid)
            return pid === record.ownerPid ? "alive" : "dead"
          },
          startedAtMs: () => ({ _tag: "started", startedAtMs: record.startedAtMs }),
          killTree: (row) => {
            killed.push(row.pid)
            return "signalled"
          }
        }
      }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, ledger))
    )

    expect(outcomes).toEqual([{ record, killed: true }])
    expect(probed).toEqual([])
    expect(killed).toEqual([record.pid])
  })
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

  it("never addresses the caller's group or every process", () => {
    const signals: Array<number> = []
    const kill: typeof process.kill = (pid) => {
      signals.push(pid)
      return true
    }
    for (const pgid of [1, 0, -5, 1.5, Number.NaN]) expect(groupVacant(pgid, kill)).toBe(false)
    expect(signals).toEqual([])
  })

  it.each(["ESRCH", "EPERM", "EINVAL"])("keeps every signal failure except ESRCH occupied (%s)", (code) => {
    const signals: Array<unknown> = []
    const kill: typeof process.kill = (pid, signal) => {
      signals.push([pid, signal])
      throw Object.assign(new Error(code), { code })
    }
    expect(groupVacant(4242, kill)).toBe(code === "ESRCH")
    expect(signals).toEqual([[-4242, 0]])
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
  it.skipIf(process.platform === "win32")(
    "runs the trusted executable with bounded output and no inherited environment",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "windows-identity-query-"))
      const executable = join(directory, "identity")
      try {
        writeFileSync(
          executable,
          "#!" + process.execPath + "\n" +
            "require(\"node:fs\").writeFileSync(__filename+\".request\",JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env}));" +
            "console.log(JSON.stringify(process.argv[3] === \"4243\" ? {status:\"gone\"} : {status:\"started\",startedAtMs:123456}));",
          { mode: 0o755 }
        )
        expect(ProcessReaper.windowsSystemWith({ processExecutable: executable }).startedAtMs(4242)).toEqual({
          _tag: "started",
          startedAtMs: 123456
        })
        const request = JSON.parse(readFileSync(executable + ".request", "utf8"))
        delete request.env.__CF_USER_TEXT_ENCODING
        expect(request).toEqual({
          args: ["--process-info", "4242"],
          cwd: parse(process.execPath).root,
          env: {}
        })
        expect(ProcessReaper.windowsSystemWith({ processExecutable: executable }).startedAtMs(4243)).toEqual({
          _tag: "gone"
        })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it("keeps malformed, denied, interrupted and refused queries unavailable", () => {
    const calls: Array<unknown> = []
    let answer: ReturnType<typeof spawnSync> = {
      pid: 100,
      output: [],
      stdout: "{}",
      stderr: "",
      status: 0,
      signal: null
    }
    let refusal: Error | undefined
    const read = windowsIdentity({ processExecutable: process.execPath }, {
      usableExecutable,
      configuredExecutable: () => undefined,
      resolveDefaultExecutable: () => {
        throw new Error("unconfigured helper")
      },
      spawnSync: ((...args: Parameters<typeof spawnSync>) => {
        calls.push(args)
        if (refusal !== undefined) throw refusal
        return answer
      }) as typeof spawnSync
    })
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
      answer = { ...answer, stdout }
      expect(read(4242)).toEqual({ _tag: "unavailable" })
    }
    for (
      const result of [
        { ...answer, error: new Error("denied") },
        { ...answer, signal: "SIGKILL" as const },
        { ...answer, status: 1 }
      ]
    ) {
      answer = result
      expect(read(4242)).toEqual({ _tag: "unavailable" })
    }
    refusal = new Error("spawn refused")
    expect(read(4242)).toEqual({ _tag: "unavailable" })
    const before = calls.length
    for (const pid of [0, 1, -1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
      expect(read(pid)).toEqual({ _tag: "unavailable" })
    }
    expect(calls).toHaveLength(before)
    expect(calls[0]).toEqual([expect.any(String), ["--process-info", "4242"], {
      cwd: parse(process.execPath).root,
      env: {},
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 4096
    }])
    const relative = windowsIdentity({ processExecutable: "relative-helper" })
    expect(relative(4242)).toEqual({ _tag: "unavailable" })
  })

  it("keeps a missing default helper unavailable", () => {
    const read = windowsIdentity(undefined, {
      spawnSync,
      usableExecutable,
      configuredExecutable: () => undefined,
      resolveDefaultExecutable: () => {
        throw new Error("missing packaged helper")
      }
    })
    expect(read(4242)).toEqual({ _tag: "unavailable" })
  })
})

describe("POSIX signal results through the native seam", () => {
  it.skipIf(process.platform === "win32").each(
    [
      ["valid", "Sat Sep  5 12:00:00 2026", { _tag: "started", startedAtMs: Date.UTC(2026, 8, 5, 12) }],
      ["malformed", "not-a-time", { _tag: "unavailable" }]
    ] as const
  )("reads a %s start time from the selected executable", (_name, printed, expected) => {
    const directory = mkdtempSync(join(tmpdir(), "posix-date-probe-"))
    const executable = join(directory, "ps")
    try {
      writeFileSync(
        executable,
        "#!" + process.execPath + "\nprocess.stdout.write(" + JSON.stringify(printed + "\n") + ")\n",
        {
          mode: 0o755
        }
      )
      expect(execFileSync(executable, { encoding: "utf8" })).toBe(printed + "\n")
      expect(ProcessReaper.posixSystemWith({ psExecutable: executable }).startedAtMs(process.pid)).toEqual(expected)
    } finally {
      rmSync(directory, { recursive: true, force: true })
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
    const killed: Array<number> = []
    const killTree = (record: ProcessLedger.ProcessRecord) => {
      killed.push(record.pid)
      return "signalled" as const
    }
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
    expect(killed).toEqual([])
  })

  it.each(
    [
      ["ESRCH", "dead", "already-gone"],
      ["EPERM", "unknown", "failed"],
      ["EINVAL", "unknown", "failed"]
    ] as const
  )("preserves unknown liveness and failed group signals (%s)", (code, alive, outcome) => {
    const signals: Array<unknown> = []
    const kill: typeof process.kill = (pid, signal) => {
      signals.push([pid, signal])
      throw Object.assign(new Error(code), { code })
    }
    const system = posixSystemFrom(
      {
        ownGroup: () => 77,
        bootedAtMs: () => 0,
        startedAtMs: () => ({ _tag: "unavailable" })
      },
      900002,
      kill
    )
    const record: ProcessLedger.ProcessRecord = {
      pid: 900001,
      pgid: 900001,
      hostId: "probe",
      ownerPid: 900003,
      startedAtMs: 1,
      commandDigest: "probe"
    }
    expect(system.isAlive(record.pid)).toBe(alive)
    expect(system.killTree(record)).toBe(outcome)
    expect(signals).toEqual([[record.pid, 0], [-record.pid, "SIGKILL"]])
  })
})
