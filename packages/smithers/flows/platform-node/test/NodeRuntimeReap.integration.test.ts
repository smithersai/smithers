/**
 * What survives a host that was KILLED, and what the next one does about it.
 *
 * The signal test next door proves the graceful half: a host that is asked to
 * stop runs its finalizers and takes its children with it. This is the other
 * half, and the one A31 exists for. A `SIGKILL`ed host runs no finalizer. The
 * supervisor that owns each spawned group loses the host's channel and stops
 * the group itself (#3760), so the first case here is a host that leaves
 * nothing running and a record the next incarnation retires without a signal.
 * The reaper is the backstop for a group nothing left alive could stop, and the
 * only thing that can reach that group is the record the host wrote to the
 * journal before it died. The suite produces that group honestly by freezing
 * it with `SIGSTOP` before the host is killed: no member of a stopped group,
 * supervisor and guardian included, runs a line of code until it is killed.
 *
 * Everything here is real: a real child process running the real `layerHost`
 * composition over a real SQLite file, a real `SIGKILL`, a real orphaned
 * process group, and a second incarnation of the same `hostId` over the same
 * database. A double at any of those points would prove nothing, because the
 * subject is precisely what is left when no code of ours got to run.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import { ProcessLedger } from "@smthrs/kernel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import * as NodeHost from "../src/NodeHost.ts"
import * as NodeRuntime from "../src/NodeRuntime.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-reap-host-"))
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "reap-host.ts")

// These hosts exercise containment. None of them calls jj, so none needs one.
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const groupIsAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Runs the host until it reports the group it started, then `SIGKILL`s it and
 * waits for the operating system to reap it, so its pid reads as gone.
 *
 * `frozen` stops the whole group before the host dies, so neither its
 * supervisor nor its guardian can act on the loss and the group outlives the
 * host until something kills it.
 */
const killHost = (filename: string, hostId: string, frozen = false): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, filename, hostId, "reap-run"], {
      stdio: ["ignore", "pipe", "pipe"]
    })
    let announced = ""
    let stderr = ""
    let pgid: number | undefined
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`the host never announced a spawned group: ${stderr}`))
    }, 60_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      announced += chunk
      const receipt = /^SPAWNED=([1-9][0-9]*)\r?$/m.exec(announced)
      if (pgid === undefined && receipt !== null) {
        pgid = Number(receipt[1])
        if (frozen) process.kill(-pgid, "SIGSTOP")
        // No handler runs for this. Whatever the host had open stays open.
        child.kill("SIGKILL")
      }
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("exit", () => {
      clearTimeout(timer)
      if (pgid === undefined) reject(new Error(`the host exited before announcing: ${stderr}`))
      else resolve(pgid)
    })
  })

/**
 * A journal-backed ledger over one runtime file, with NO reaper attached.
 *
 * `layerHost` reaps while it is being built, so a test that only stands a host
 * up can never see what the sweep was handed. This composes the same ledger
 * over the same storage the host uses and stops there, which is the only way
 * to observe `orphans` before anything acts on it.
 */
const ledgerOver = (filename: string, hostId: string) =>
  ProcessLedger.layer({ hostId, ownerPid: process.pid }).pipe(
    Layer.provide(NodeRuntime.storage(filename)),
    Layer.provide(Layer.merge(NodeHost.layer, NodeHost.NodeCrypto.layer))
  )

const readBack = <A>(filename: string, query: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(filename, { readOnly: true })
  try {
    return query(database)
  } finally {
    database.close()
  }
}

/** The host's process records, in journal order. */
const journalOf = (filename: string, hostId: string) =>
  readBack(filename, (database) =>
    database
      .prepare(
        "SELECT event_type, json_extract(payload_json, '$.reason') AS reason FROM flows_journal_events WHERE run_id = ? ORDER BY seq"
      )
      .all(`flows.host:${hostId}`)
      .map((row) => row.reason === null ? { event_type: row.event_type } : row))

/** A second incarnation of the SAME host over the SAME database, handed nothing about the dead one but its id. */
const secondIncarnation = (filename: string, hostId: string): Promise<void> =>
  Effect.runPromise(
    Effect.void.pipe(
      Effect.provide(
        NodeRuntime.layerHost(
          { filename, workspaceRoot: directory, owner: { hostId }, signals: [] },
          Layer.empty
        )
      ),
      Effect.scoped
    )
  )

/** Waits up to ten seconds for a group to empty. */
const settled = async (pgid: number): Promise<boolean> => {
  const deadline = Date.now() + 10_000
  while (groupIsAlive(pgid) && Date.now() < deadline) await sleep(50)
  return !groupIsAlive(pgid)
}

describe("a host that was killed", () => {
  it("starts no jj probe, so its live child is the only process it journals", async () => {
    const filename = join(directory, "probe", "runtime.sqlite")
    const pgid = await killHost(filename, "probe-host")
    try {
      expect(journalOf(filename, "probe-host")).toEqual([
        { event_type: "flows.host.process-spawned.v1" }
      ])
    } finally {
      // Its supervisor may already have stopped the group.
      if (groupIsAlive(pgid)) process.kill(-pgid, "SIGKILL")
    }
  }, 120_000)

  it("leaves nothing running, and the next incarnation retires the record without a signal", async () => {
    const filename = join(directory, "supervised", "runtime.sqlite")

    const pgid = await killHost(filename, "supervised-host")
    try {
      // No code of the dead host runs and no reaper has started, yet the group
      // ends: its supervisor lost the host's channel and stopped it.
      expect(await settled(pgid)).toBe(true)
      expect(journalOf(filename, "supervised-host")).toEqual([
        { event_type: "flows.host.process-spawned.v1" }
      ])

      await secondIncarnation(filename, "supervised-host")

      // The record stayed inherited until now. The next incarnation finds its
      // pid gone, signals nothing, and says so durably, so a third incarnation
      // never aims a kill at a pid the operating system has handed out again.
      expect(journalOf(filename, "supervised-host")).toEqual([
        { event_type: "flows.host.process-spawned.v1" },
        { event_type: "flows.host.process-reap-skipped.v1", reason: "process-gone" }
      ])
    } finally {
      if (groupIsAlive(pgid)) process.kill(-pgid, "SIGKILL")
    }
  }, 120_000)

  it("leaves a group nothing could stop for the next incarnation of the same host to reap", async () => {
    const filename = join(directory, "reap", "runtime.sqlite")

    const pgid = await killHost(filename, "reap-host", true)
    try {
      // The host is gone and its children are not: this is the state a crash
      // leaves when nothing in the group can act, and the state scope closure
      // can do nothing about.
      expect(groupIsAlive(pgid)).toBe(true)
      expect(journalOf(filename, "reap-host")).toEqual([
        { event_type: "flows.host.process-spawned.v1" }
      ])

      await secondIncarnation(filename, "reap-host")

      expect(await settled(pgid)).toBe(true)

      // And it said so durably, so a third incarnation does not try the same kill
      // against a pid the operating system has since handed to somebody else.
      expect(journalOf(filename, "reap-host")).toEqual([
        { event_type: "flows.host.process-spawned.v1" },
        { event_type: "flows.host.process-reaped.v1" }
      ])
    } finally {
      if (groupIsAlive(pgid)) process.kill(-pgid, "SIGKILL")
    }
  }, 120_000)

  it("names the abandoned group in `orphans` before anything signals it", async () => {
    const filename = join(directory, "orphans", "runtime.sqlite")

    const pgid = await killHost(filename, "orphan-host", true)
    try {
      expect(groupIsAlive(pgid)).toBe(true)

      // The next incarnation is handed nothing but the host id, and what it
      // inherits through the journal is the process GROUP the dead one led. A
      // record naming a pid with no group would be one the reaper must refuse,
      // so this is the half of the contract the kill assertion cannot show.
      const orphans = await Effect.runPromise(
        Effect.flatMap(ProcessLedger.ProcessLedger, (ledger) => ledger.orphans).pipe(
          Effect.provide(ledgerOver(filename, "orphan-host")),
          Effect.scoped
        )
      )

      expect(orphans).toEqual([
        expect.objectContaining({
          pid: pgid,
          pgid,
          hostId: "orphan-host"
        })
      ])
      // The record names the program it started and none of its arguments. The
      // host confines every spawn (#3140), so that program is the sandbox
      // launcher wherever one exists, not the `sh` the action asked for.
      expect(orphans[0]?.commandDigest).toMatch(/^\S+$/)
      expect(orphans[0]?.commandDigest).not.toContain("sleep")
      expect(orphans[0]?.ownerPid).not.toBe(process.pid)

      // And the reaper, given exactly that, ends the group.
      const reaped = await Effect.runPromise(
        ProcessReaper.reap().pipe(Effect.provide(ledgerOver(filename, "orphan-host")), Effect.scoped)
      )

      expect(reaped).toEqual([{ record: expect.objectContaining({ pid: pgid, pgid }), killed: true }])
      expect(await settled(pgid)).toBe(true)
    } finally {
      if (groupIsAlive(pgid)) process.kill(-pgid, "SIGKILL")
    }
  }, 120_000)
})
