/** Cross-process ownership, initialization, recovery, and release schedules. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import type * as Checkpoint from "@smthrs/migrate/flow/Checkpoint"
import * as Lock from "@smthrs/migrate/flow/Lock"
import { Effect, FileSystem, PlatformError } from "effect"
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach } from "vitest"

const platform = NodeServices.layer
const temporaries: Array<string> = []
const heldLocks: Array<Lock.Held> = []
const children: Array<ChildProcess> = []
const scratch = (): string => {
  const target = mkdtempSync(join(tmpdir(), "migrate-lock-"))
  temporaries.push(target)
  return target
}
const acquire = (root: string, reportDir = ".smithers-migrate") =>
  Lock.acquire({ root, reportDir }).pipe(
    Effect.tap((held) => Effect.sync(() => heldLocks.push(held))),
    Effect.provide(platform)
  )
const release = (held: Lock.Held) => Lock.release(held).pipe(Effect.provide(platform))
const lockPath = (root: string) => join(root, ".smithers-migrate", "apply.lock")
const guardPath = (root: string) => `${lockPath(root)}.sqlite`
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid

interface Message {
  readonly phase: string
  readonly code?: string
  readonly message?: string
  readonly record?: Lock.Record
  readonly reclaimed?: Lock.Record
  readonly file?: string
  readonly checkpoint?: Checkpoint.Ref
}
const worker = (root: string, reportDir = ".smithers-migrate", mode = "normal") => {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../fixtures/lock/worker.ts", import.meta.url)),
    root,
    reportDir,
    mode
  ], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
  children.push(child)
  let stderr = ""
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const messages: Array<Message> = []
  const waiters = new Set<() => void>()
  child.on("message", (message) => {
    messages.push(message as Message)
    for (const notify of waiters) notify()
  })
  const next = (phase?: string): Promise<Message> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`worker ${child.pid} did not send ${phase ?? "an outcome"}: ${stderr}`))
      }, 15_000)
      const check = () => {
        const index = messages.findIndex((message) => phase === undefined || message.phase === phase)
        if (index < 0) return
        clearTimeout(timer)
        waiters.delete(check)
        resolve(messages.splice(index, 1)[0]!)
      }
      waiters.add(check)
      check()
    })
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  }
  return { child, next, stop, send: (command: string) => child.send(command) }
}

afterEach(async () => {
  for (const held of heldLocks.splice(0)) await Effect.runPromise(release(held))
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  }
  for (const target of temporaries.splice(0)) rmSync(target, { recursive: true, force: true })
})

describe("Lock.acquire", () => {
  it.effect("publishes ownership and releases without replacing the permanent guard inode", () =>
    Effect.gen(function*() {
      const root = scratch()
      const held = yield* acquire(root)
      const written = JSON.parse(readFileSync(lockPath(root), "utf8"))
      expect(written).toMatchObject({ pid: process.pid, root: realpathSync(root), reportDir: ".smithers-migrate" })
      expect(typeof written.startedAt).toBe("string")
      expect(written.token).toMatch(/^[a-f0-9-]+$/)
      expect(held.reclaimed).toBeUndefined()
      const inode = statSync(guardPath(root)).ino
      yield* release(held)
      expect(existsSync(lockPath(root))).toBe(false)
      expect(statSync(guardPath(root)).ino).toBe(inode)
      const next = yield* acquire(root, "audit")
      expect(statSync(guardPath(root)).ino).toBe(inode)
      yield* release(next)
    }))

  it.effect("refuses another connection in the same process, including another report layout", () =>
    Effect.gen(function*() {
      const root = scratch()
      const held = yield* acquire(root, "reports/first")
      for (const report of ["reports/first", "reports/second", ".smithers-migrate"]) {
        const failure = yield* Effect.flip(acquire(root, report))
        expect(failure.code).toBe("apply-in-progress")
        expect(failure.message).toContain(`pid ${process.pid}`)
      }
      // Closing refused SQLite connections must not drop the original lock.
      const competitor = worker(root, "third")
      yield* Effect.promise(() => competitor.next("ready"))
      competitor.send("acquire")
      expect((yield* Effect.promise(() => competitor.next())).code).toBe("apply-in-progress")
      yield* release(held)
      const next = yield* acquire(root)
      yield* release(next)
    }))

  it("shares one lock across real processes, custom report directories, and root symlinks", async () => {
    const root = scratch()
    const aliases = scratch()
    const alias = join(aliases, "project")
    symlinkSync(root, alias, "dir")
    const first = worker(root, "audit/a")
    await first.next("ready")
    first.send("acquire")
    const owned = await first.next("acquired")
    const second = worker(alias, "audit/b")
    await second.next("ready")
    second.send("acquire")
    expect(await second.next()).toMatchObject({ phase: "refused", code: "apply-in-progress" })
    expect(owned.file).toBe(join(realpathSync(root), ".smithers-migrate", "apply.lock"))
    expect(existsSync(join(root, "audit"))).toBe(false)
    first.send("release")
    await first.next("released")
    const retry = worker(alias, "audit/b")
    await retry.next("ready")
    retry.send("acquire")
    expect((await retry.next("acquired")).file).toBe(owned.file)
    retry.send("release")
    await retry.next("released")
  })

  it("never steals a live owner whose record is incomplete, and recovers after death before publication", async () => {
    const root = scratch()
    const first = worker(root, "audit/a", "before-publish")
    await first.next("ready")
    first.send("acquire")
    await first.next("initializing")
    writeFileSync(lockPath(root), "{\"pid\":")
    const second = worker(root, "audit/b")
    await second.next("ready")
    second.send("acquire")
    expect(await second.next()).toMatchObject({ phase: "refused", code: "apply-in-progress" })
    expect(readFileSync(lockPath(root), "utf8")).toBe("{\"pid\":")
    await first.stop()
    const recovered = worker(root, "audit/b")
    await recovered.next("ready")
    recovered.send("acquire")
    expect((await recovered.next("acquired")).record?.pid).toBe(recovered.child.pid)
    recovered.send("release")
    await recovered.next("released")
  })

  it("serializes simultaneous stale reclaimers and preserves the winning replacement", async () => {
    const root = scratch()
    const crashed = worker(root, "original-report")
    await crashed.next("ready")
    crashed.send("acquire")
    const previous = await crashed.next("acquired")
    await crashed.stop()
    const contenders = [worker(root, "one"), worker(root, "two"), worker(root, "three")]
    await Promise.all(contenders.map((contender) => contender.next("ready")))
    for (const contender of contenders) contender.send("acquire")
    const outcomes = await Promise.all(contenders.map((contender) => contender.next()))
    const winner = outcomes.findIndex((outcome) => outcome.phase === "acquired")
    expect(outcomes.filter((outcome) => outcome.phase === "acquired")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.code === "apply-in-progress")).toHaveLength(2)
    expect(outcomes[winner]?.reclaimed).toEqual(previous.record)
    expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toEqual(outcomes[winner]?.record)
    const late = worker(root, "late")
    await late.next("ready")
    late.send("acquire")
    expect(await late.next()).toMatchObject({ phase: "refused", code: "apply-in-progress" })
    contenders[winner]!.send("release")
    await contenders[winner]!.next("released")
  })

  it("holds authority across the stale-read to replacement-publication window", async () => {
    const root = scratch()
    mkdirSync(join(root, ".smithers-migrate"))
    const stale = { pid: deadPid(), startedAt: "2026-01-01T00:00:00.000Z", root }
    writeFileSync(lockPath(root), JSON.stringify(stale))
    const first = worker(root, "one", "after-read")
    await first.next("ready")
    first.send("acquire")
    await first.next("reclaiming")
    const second = worker(root, "two")
    await second.next("ready")
    second.send("acquire")
    expect(await second.next()).toMatchObject({ phase: "refused", code: "apply-in-progress" })
    first.send("continue")
    const owned = await first.next("acquired")
    expect(owned.reclaimed).toEqual(stale)
    expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toEqual(owned.record)
    first.send("release")
    await first.next("released")
  })

  it.effect("closes authority after a failed metadata publication so a retry can acquire", () =>
    Effect.gen(function*() {
      const root = scratch()
      const fs = yield* FileSystem.FileSystem
      const failure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "open"
      })
      const failed = yield* Effect.flip(
        Lock.acquire({ root, reportDir: "audit" }).pipe(Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: () => Effect.fail(failure)
        }))
      )
      expect(failed.code).toBe("io")
      const held = yield* Lock.acquire({ root, reportDir: "retry" })
      yield* Lock.release(held)
    }).pipe(Effect.provide(platform)))

  it.effect("fails closed for an unreadable guard and for redirected lock state", () =>
    Effect.gen(function*() {
      const root = scratch()
      mkdirSync(join(root, ".smithers-migrate"))
      writeFileSync(guardPath(root), "not a SQLite database")
      expect((yield* Effect.flip(acquire(root))).code).toBe("io")
      const other = scratch()
      const redirected = scratch()
      symlinkSync(other, join(redirected, ".smithers-migrate"), "dir")
      expect((yield* Effect.flip(acquire(redirected))).code).toBe("invalid-layout")
      expect(existsSync(guardPath(other))).toBe(false)
    }))
})

describe("Lock.release", () => {
  it("preserves a crashed checkpoint across repeated default and custom-report retries until operator recovery", async () => {
    for (const reportDir of [".smithers-migrate", "audit/original"]) {
      const root = scratch()
      writeFileSync(join(root, "workflow.jsx"), "original workflow\n")
      const owner = worker(root, reportDir, "checkpoint")
      await owner.next("ready")
      owner.send("acquire")
      const original = await owner.next("acquired")
      const { checkpoint } = await owner.next("checkpoint")
      expect(checkpoint).toBeDefined()
      await owner.stop()
      const pending = join(root, reportDir, "pending-unit.json")
      const markerBytes = readFileSync(pending)
      const backupBytes = readFileSync(join(checkpoint!.backup, "workflow.jsx"))
      const treeBytes = readFileSync(checkpoint!.tree)
      for (const retryDir of [reportDir, "audit/second", ".smithers-migrate", "audit/third"]) {
        const retry = worker(root, retryDir)
        await retry.next("ready")
        retry.send("acquire")
        const outcome = await retry.next()
        expect(outcome).toMatchObject({ phase: "refused", code: "checkpoint-failed" })
        expect(outcome.message).toContain("pending-unit.json")
        expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toEqual(original.record)
        expect(readFileSync(pending)).toEqual(markerBytes)
        expect(readFileSync(join(checkpoint!.backup, "workflow.jsx"))).toEqual(backupBytes)
        expect(readFileSync(checkpoint!.tree)).toEqual(treeBytes)
        expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("half migrated\n")
      }
      // Execute the documented no-VCS recovery command over this fixture,
      // verify its bytes, then clear only the resolved pending marker.
      execFileSync("cp", ["-R", `${checkpoint!.backup}/.`, "."], { cwd: root })
      expect(readFileSync(join(root, "workflow.jsx"), "utf8")).toBe("original workflow\n")
      rmSync(pending)
      const next = worker(root, "audit/recovered")
      await next.next("ready")
      next.send("acquire")
      expect((await next.next("acquired")).reclaimed).toEqual(original.record)
      next.send("release")
      await next.next("released")
      expect(existsSync(lockPath(root))).toBe(false)
    }
  })

  it("keeps authority while removing its record so a contender cannot publish a replacement underneath cleanup", async () => {
    const root = scratch()
    const owner = worker(root, "one", "before-remove")
    await owner.next("ready")
    owner.send("acquire")
    const held = await owner.next("acquired")
    owner.send("release")
    await owner.next("releasing")
    const contender = worker(root, "two")
    await contender.next("ready")
    contender.send("acquire")
    expect(await contender.next()).toMatchObject({ phase: "refused", code: "apply-in-progress" })
    expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toEqual(held.record)
    owner.send("continue")
    await owner.next("released")
    const next = worker(root, "two")
    await next.next("ready")
    next.send("acquire")
    expect((await next.next("acquired")).record?.pid).toBe(next.child.pid)
    next.send("release")
    await next.next("released")
  })

  it.effect("is idempotent and cannot release a later owner with the same pid and clock", () =>
    Effect.gen(function*() {
      const root = scratch()
      const held = yield* acquire(root)
      yield* release({ ...held })
      expect((yield* Effect.flip(acquire(root))).code).toBe("apply-in-progress")
      yield* release(held)
      const next = yield* acquire(root)
      expect(next.record.pid).toBe(held.record.pid)
      expect(next.record.startedAt).toBe(held.record.startedAt)
      expect(next.record.token).not.toBe(held.record.token)
      yield* release(held)
      expect((yield* Effect.flip(acquire(root))).code).toBe("apply-in-progress")
      expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toEqual(next.record)
      yield* release(next)
    }))

  it.effect("preserves a changed record and still closes its own transaction", () =>
    Effect.gen(function*() {
      const root = scratch()
      const held = yield* acquire(root)
      const other = { pid: 424242, startedAt: "2026-02-02T00:00:00.000Z", root, token: "another-owner" }
      writeFileSync(lockPath(root), JSON.stringify(other))
      yield* release(held)
      expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toEqual(other)
      const next = yield* acquire(root)
      expect(next.reclaimed).toEqual(other)
      yield* release(next)
    }))

  it.effect("closes its transaction when the diagnostic record is already gone", () =>
    Effect.gen(function*() {
      const root = scratch()
      const held = yield* acquire(root)
      rmSync(lockPath(root))
      yield* release(held)
      const next = yield* acquire(root)
      yield* release(next)
      expect(existsSync(lockPath(root))).toBe(false)
    }))

  it.effect("releases authority even if removing its diagnostic record fails", () =>
    Effect.gen(function*() {
      const root = scratch()
      const held = yield* acquire(root)
      const fs = yield* FileSystem.FileSystem
      yield* Lock.release(held).pipe(Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        remove: () =>
          Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "remove" }))
      }))
      expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toEqual(held.record)
      const next = yield* acquire(root)
      expect(next.reclaimed).toEqual(held.record)
      yield* release(next)
    }).pipe(Effect.provide(platform)))

  it.effect("retains the recovery-directory pointer after a handled failure with an incomplete pending record", () =>
    Effect.gen(function*() {
      const root = scratch()
      const held = yield* acquire(root, "audit/original")
      mkdirSync(join(root, "audit/original"), { recursive: true })
      writeFileSync(join(root, "audit/original/pending-unit.json"), "{\"checkpoint\":")
      yield* release(held)
      expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toEqual(held.record)
      for (const reportDir of ["audit/original", "audit/retry", ".smithers-migrate"]) {
        const failure = yield* Effect.flip(acquire(root, reportDir))
        expect(failure.code).toBe("checkpoint-failed")
        expect(failure.details).toContain("restore its checkpoint")
        expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toEqual(held.record)
      }
      rmSync(join(root, "audit/original/pending-unit.json"))
      const next = yield* acquire(root)
      yield* release(next)
    }))
})
