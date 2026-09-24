/**
 * Crash reaping on a Linux host that has no `ps`: every identity question is
 * read from `/proc`, and every decision is reported.
 *
 * The `/proc` fixture supplies identity observations on every test host.
 * Cleanup signals a real native process: a POSIX group or a Windows tree.
 */
import { describe, expect, it } from "@effect/vitest"
import { ProcessLedger } from "@smthrs/kernel"
import { Effect } from "effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import { waitForExit } from "./helpers/waitForExit.ts"

/** A `/proc/<pid>/stat` line: state, ppid, pgrp, then zeros up to starttime. */
const statLine = (pid: number, pgrp: number, startTicks: number): string =>
  `${pid} (sh) S 1 ${pgrp} ${pgrp} 0 -1 ${Array(13).fill(0).join(" ")} ${startTicks} 0 0\n`

const fakeProc = (entries: ReadonlyArray<{ readonly pid: number; readonly startedAtMs: number }>, ownGroup: number) => {
  const root = mkdtempSync(join(tmpdir(), "flows-proc-"))
  const btime = Math.floor((Date.now() - 3_600_000) / 1000)
  writeFileSync(join(root, "stat"), `cpu 0 0 0 0\nbtime ${btime}\nprocesses 1\n`)
  mkdirSync(join(root, "self"))
  writeFileSync(join(root, "self", "stat"), statLine(process.pid, ownGroup, 0))
  for (const entry of entries) {
    mkdirSync(join(root, String(entry.pid)))
    const ticks = Math.round((entry.startedAtMs - btime * 1000) / 10)
    writeFileSync(join(root, String(entry.pid), "stat"), statLine(entry.pid, entry.pid, ticks))
  }
  return root
}

const spyLedger = (orphans: ReadonlyArray<ProcessLedger.ProcessRecord>) => {
  const reaped: Array<number> = []
  const service: ProcessLedger.Service = {
    record: () => Effect.die("the sweep never records"),
    release: () => Effect.die("the sweep never releases"),
    reaped: (record) => Effect.sync(() => void reaped.push(record.pid)),
    skipped: () => Effect.void,
    live: Effect.succeed([]),
    orphans: Effect.succeed(orphans)
  }
  return { service, reaped }
}

describe("ProcessReaper on /proc", () => {
  it.live("reaps a real native process using proc identity without a ps binary", () =>
    Effect.gen(function*() {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        detached: true,
        windowsHide: true,
        stdio: "ignore"
      })
      child.unref()
      const leader = child.pid as number
      const startedAtMs = Date.now()
      const native = ProcessReaper.systemFor(process.platform)
      const pgid = process.platform === "win32" ? null : leader
      const root = fakeProc([{ pid: leader, startedAtMs }], process.pid)
      try {
        const record: ProcessLedger.ProcessRecord = {
          pid: leader,
          pgid,
          hostId: "proc-host",
          ownerPid: 2_147_483_646,
          startedAtMs,
          commandDigest: "node process fixture"
        }
        const ledger = spyLedger([record])
        const proc = ProcessReaper.procSystemWith({ procRoot: root })
        expect(proc.ownGroup()).toBe(process.pid)
        // Keep identity and boot observations on the synthetic /proc. Only
        // signalling and group guards follow the real host's process model.
        const system = process.platform === "win32"
          ? { ...proc, ownGroup: native.ownGroup, refuseTarget: native.refuseTarget, killTree: native.killTree }
          : proc
        const decided = yield* ProcessReaper.reap({ system }).pipe(
          Effect.provideService(ProcessLedger.ProcessLedger, ledger.service)
        )
        expect(decided).toEqual([{ record, killed: true }])
        expect(ledger.reaped).toEqual([leader])
        expect(yield* Effect.promise(() => waitForExit(leader, 2_000))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
        if (child.exitCode === null && child.signalCode === null) {
          native.killTree({
            pid: leader,
            pgid,
            hostId: "fixture-cleanup",
            ownerPid: process.pid,
            startedAtMs,
            commandDigest: "node process fixture"
          })
        }
      }
    }))

  it("answers unavailable, never gone, for a pid /proc hides but the kernel still runs", () => {
    const root = fakeProc([], process.pid)
    try {
      expect(ProcessReaper.procSystemWith({ procRoot: root }).startedAtMs(process.pid)).toEqual({
        _tag: "unavailable"
      })
      expect(ProcessReaper.procSystemWith({ procRoot: root }).startedAtMs(2_147_483_646)).toEqual({ _tag: "gone" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("reads no group when /proc is absent, so the sweep refuses instead of guessing", () => {
    expect(ProcessReaper.procSystemWith({ procRoot: "/nonexistent/proc" }).ownGroup()).toBeNull()
  })

  it("takes the boot instant from /proc/stat, and from uptime when that cannot be read", () => {
    const root = fakeProc([], process.pid)
    try {
      const btime = Number(/btime (\d+)/.exec(readFileSync(join(root, "stat"), "utf8"))![1])
      expect(ProcessReaper.procSystemWith({ procRoot: root }).bootedAtMs()).toBe(btime * 1000)
      writeFileSync(join(root, "stat"), `btime ${"9".repeat(20)}\n`)
      const fallback = ProcessReaper.procSystemWith({ procRoot: root }).bootedAtMs()
      expect(Math.abs(fallback - ProcessReaper.posixSystem.bootedAtMs())).toBeLessThan(2_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("selects the /proc system on Linux", () => {
    expect(ProcessReaper.systemFor("linux")).toBe(ProcessReaper.procSystem)
    expect(ProcessReaper.systemFor("darwin")).toBe(ProcessReaper.posixSystem)
  })

  it.effect("warns and counts when a sweep leaves an orphan running", () =>
    Effect.gen(function*() {
      const messages: Array<unknown> = []
      const levels: Array<string> = []
      const capture = Logger.layer([
        Logger.make<unknown, void>(({ logLevel, message }) => {
          messages.push(message)
          levels.push(logLevel)
        })
      ])
      const counter = Metric.withAttributes(ProcessReaper.refusals, { refusal: "own-group-unknown" })
      const before = (yield* Metric.value(counter)).count
      const record: ProcessLedger.ProcessRecord = {
        pid: 987_654,
        pgid: 987_654,
        hostId: "proc-host",
        ownerPid: 2_147_483_646,
        startedAtMs: Date.now(),
        commandDigest: "agent"
      }
      const reaper = ProcessReaper.layer({ system: { ...ProcessReaper.posixSystem, ownGroup: () => null } }).pipe(
        Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(spyLedger([record]).service))
      )
      yield* Effect.void.pipe(Effect.provide(reaper), Effect.provide(capture))
      expect((yield* Metric.value(counter)).count - before).toBe(1)
      expect(messages.flat()).toContain("process reaper swept inherited records")
      expect(levels).toContain("Warn")
    }))
})
