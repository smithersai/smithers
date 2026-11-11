/**
 * The runner's own job store (`LocalJobs`): every transition of the hosted store's semantics over real files, the
 * deadline and restarts on a test clock, a store opened again from its files, a corrupt file, and a filesystem that
 * fails where the store writes.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import type * as AgentRunner from "@smthrs/agent/AgentRunner"
import { NotificationQueue } from "@smthrs/notifications"
import { Deferred, Effect, Exit, FileSystem, Layer, PlatformError } from "effect"
import { TestClock } from "effect/testing"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { ModuleOwner } from "../src/internal/ModuleOwner.ts"
import * as LocalJobs from "../src/runner/LocalJobs.ts"

let stateDir = ""
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "runner-jobs-"))
})
afterEach(() => rmSync(stateDir, { recursive: true, force: true }))

const task = (restarts = 1, profile = "coder"): AgentRunner.Task => ({
  agent: { name: "lane", labels: [], profile, maxHours: 1, restarts },
  repository: "github/acme/app",
  base: "a".repeat(40),
  system: [],
  prompt: "do it",
  limits: { files: 10, bytes: 1000 }
})
const claimAll = { profiles: ["coder"], free: 1, running: [], waitSeconds: 0 }
const done: AgentRunner.Outcome = { _tag: "Done", changes: { additions: [], deletions: [] }, summary: "ok", usage: {} }
const HOUR = 3_600_000

/** What fails while it is set: the store's writes (`rename`), its appends, or its reads. */
const faults = new Set<"rename" | "append" | "read">()
/** How many writes the store tried. */
let renames = 0
const fault = (method: string) =>
  Effect.fail(PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method }))
const faulty = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (fs) =>
    FileSystem.FileSystem.of({
      ...fs,
      rename: (from, to) => {
        renames++
        return faults.has("rename") ? fault("rename") : fs.rename(from, to)
      },
      writeFileString: (path, data, options) =>
        faults.has("append") && options?.flag === "a" ? fault("writeFile") : fs.writeFileString(path, data, options),
      readFileString: (path, encoding) => faults.has("read") ? fault("readFile") : fs.readFileString(path, encoding)
    }))
).pipe(Layer.provide(NodeServices.layer))

/**
 * Runs `body` with a store over `stateDir` on a test clock (its time starts at 0) and the faulty filesystem, its runs'
 * ends told by `options`.
 */
const run = <A, E>(
  body: (store: LocalJobs.Store) => Effect.Effect<A, E, FileSystem.FileSystem>,
  options: LocalJobs.Options = {}
) =>
  Effect.runPromise(
    LocalJobs.make(stateDir, options).pipe(
      Effect.flatMap(body),
      Effect.scoped,
      Effect.provide(Layer.merge(TestClock.layer(), faulty))
    )
  ).finally(() => faults.clear())

const rowFiles = () => readdirSync(join(stateDir, "jobs"))
const rowOf = (key: string) =>
  JSON.parse(readFileSync(join(stateDir, "jobs", `${LocalJobs.fileOf(key)}.json`), "utf8")) as LocalJobs.Row

describe("LocalJobs", () => {
  test("queued, claimed, heartbeat and settled Done: the step reads Running, then the outcome", () =>
    run(({ host, jobs }) =>
      Effect.gen(function*() {
        yield* jobs.start(task(), "s1#g1")
        expect(yield* jobs.status("s1#g1")).toEqual({ _tag: "Running" })
        // The same key again is a no-op.
        yield* jobs.start(task(5), "s1#g1")
        expect(rowOf("s1#g1").task?.agent.restarts).toBe(1)
        expect(yield* host.claim({ ...claimAll, profiles: ["other"] })).toBeNull()
        expect(yield* host.claim({ ...claimAll, free: 0 })).toBeNull()
        const job = (yield* host.claim(claimAll))!
        expect(job).toMatchObject({ key: "s1#g1", generation: 1, deadline: HOUR, reclaimed: false, leaseSeconds: 45 })
        expect(rowOf("s1#g1")).toMatchObject({ status: "claimed", claim: job.claim })
        expect(yield* host.claim({ ...claimAll, running: ["s1#g1"] })).toBeNull()
        expect(yield* jobs.status("s1#g1")).toEqual({ _tag: "Running" })
        expect(yield* host.heartbeat({ key: "s1#g1", claim: job.claim }))
          .toEqual({ held: true, cancel: false, leaseSeconds: 45 })
        expect(yield* host.heartbeat({ key: "s1#g1", claim: "other" }))
          .toEqual({ held: false, cancel: false, leaseSeconds: 45 })
        expect(yield* host.settle({ key: "s1#g1", claim: "other", outcome: done })).toEqual({ recorded: false })
        expect(yield* host.settle({ key: "s1#g1", claim: job.claim, outcome: done })).toEqual({ recorded: true })
        expect(yield* jobs.status("s1#g1")).toEqual({ _tag: "Ended", outcome: done })
        expect(yield* host.settle({ key: "s1#g1", claim: job.claim, outcome: done })).toEqual({ recorded: false })
        expect(yield* host.heartbeat({ key: "s1#g1", claim: job.claim })).toMatchObject({ held: false })
        // A key never queued reads as another generation.
        expect(yield* jobs.status("s1#g2")).toEqual({ _tag: "Again" })
      })
    ))

  test("settles Failed and Cancelled as they are", () =>
    run(({ host, jobs }) =>
      Effect.gen(function*() {
        yield* jobs.start(task(), "f#g1")
        yield* jobs.start(task(), "c#g1")
        const failed = (yield* host.claim(claimAll))!
        const cancelled = (yield* host.claim({ ...claimAll, running: [failed.key] }))!
        const lost: AgentRunner.Outcome = { _tag: "Failed", reason: "machine_lost" }
        const stopped: AgentRunner.Outcome = { _tag: "Cancelled", processTreeGone: false }
        yield* host.settle({ key: failed.key, claim: failed.claim, outcome: lost })
        yield* host.settle({ key: cancelled.key, claim: cancelled.claim, outcome: stopped })
        expect(yield* jobs.status("f#g1")).toEqual({ _tag: "Ended", outcome: lost })
        expect(yield* jobs.status("c#g1")).toEqual({ _tag: "Ended", outcome: stopped })
        expect([rowOf("f#g1").status, rowOf("c#g1").status]).toEqual(["failed", "cancelled"])
      })
    ))

  test("records the control run that started a job, from the step's owner", () =>
    run(({ jobs }) =>
      Effect.gen(function*() {
        yield* jobs.start(task(), "o#g1").pipe(Effect.provideService(ModuleOwner, { rootId: "run-7", flowId: "lane" }))
        yield* jobs.start(task(), "n#g1")
        expect(rowOf("o#g1").runId).toBe("run-7")
        expect(rowOf("n#g1").runId).toBeUndefined()
      })
    ))

  test("a job's run that ends cancels its open jobs, after a restart too; a run that never ends cancels none", async () => {
    const owned = (runId: string) => Effect.provideService(ModuleOwner, { rootId: runId, flowId: "lane" })
    const ended = new Map<string, Deferred.Deferred<void>>()
    const runEnded = (runId: string) =>
      Effect.suspend(() => {
        if (!ended.has(runId)) ended.set(runId, Deferred.makeUnsafe<void>())
        return Deferred.await(ended.get(runId)!)
      })
    const stopped = { _tag: "Ended", outcome: { _tag: "Cancelled", processTreeGone: true } }
    const job = await run(({ host, jobs }) =>
      Effect.gen(function*() {
        yield* jobs.start(task(), "a#g1").pipe(owned("run-a"))
        yield* jobs.start(task(), "b#g1").pipe(owned("run-b"))
        yield* jobs.start(task(), "c#g1").pipe(owned("run-c"))
        yield* jobs.start(task(), "d#g1").pipe(owned("run-a"))
        const claimed = (yield* host.claim(claimAll))!
        expect(claimed.key).toBe("a#g1")
        while (!ended.has("run-a")) yield* Effect.yieldNow
        Deferred.doneUnsafe(ended.get("run-a")!, Exit.void)
        // Once its run ended: the claimed job is told to stop, the queued one ends.
        yield* Effect.yieldNow
        while (!(yield* host.heartbeat({ key: claimed.key, claim: claimed.claim })).cancel) yield* Effect.yieldNow
        expect(yield* jobs.status("d#g1")).toEqual(stopped)
        expect(yield* jobs.status("b#g1")).toEqual({ _tag: "Running" })
        return claimed
      }), { runEnded })
    // Opened again, it watches the runs of its open jobs; run-b's end cancels b, and c's run never ends.
    ended.clear()
    await run(({ host, jobs }) =>
      Effect.gen(function*() {
        expect(yield* host.heartbeat({ key: job.key, claim: job.claim })).toMatchObject({ cancel: true })
        while (!ended.has("run-b")) yield* Effect.yieldNow
        Deferred.doneUnsafe(ended.get("run-b")!, Exit.void)
        while ((yield* jobs.status("b#g1"))._tag === "Running") yield* Effect.yieldNow
        expect(yield* jobs.status("b#g1")).toEqual(stopped)
        expect(yield* jobs.status("c#g1")).toEqual({ _tag: "Running" })
        expect([...ended.keys()].sort()).toEqual(["run-a", "run-b", "run-c"])
      }), { runEnded })
    // A run whose jobs' writes fail when it ends logs it and leaves them.
    ended.clear()
    await run(({ jobs }) =>
      Effect.gen(function*() {
        faults.add("rename")
        while (!ended.has("run-c")) yield* Effect.yieldNow
        const before = renames
        Deferred.doneUnsafe(ended.get("run-c")!, Exit.void)
        while (renames === before) yield* Effect.yieldNow
        faults.delete("rename")
        expect(yield* jobs.status("c#g1")).toEqual({ _tag: "Running" })
      }), { runEnded })
  })

  test("a run's notification queue that fails hands out no steers, and the heartbeat holds", () =>
    run(({ host, jobs }) =>
      Effect.gen(function*() {
        yield* jobs.start(task(), "q#g1").pipe(
          Effect.provideService(ModuleOwner, { rootId: "run-q", flowId: "lane" }),
          Effect.provideService(NotificationQueue.NotificationQueue, NotificationQueue.makeNoop())
        )
        const job = (yield* host.claim(claimAll))!
        expect(yield* host.heartbeat({ key: job.key, claim: job.claim, delivered: ["steer-1"] }))
          .toEqual({ held: true, cancel: false, leaseSeconds: 45 })
        expect(LocalJobs.steerBoundary("q#g1", ["b", "a"])).toBe(LocalJobs.steerBoundary("q#g1", ["a", "b"]))
      })
    ))

  test("a cancel before the start wins; a queued job ends at its cancel; a claimed one is told and settles", () =>
    run(({ host, jobs }) =>
      Effect.gen(function*() {
        const stopped = { _tag: "Ended", outcome: { _tag: "Cancelled", processTreeGone: true } }
        yield* jobs.cancel("early#g1")
        yield* jobs.start(task(), "early#g1")
        expect(yield* jobs.status("early#g1")).toEqual(stopped)
        yield* jobs.start(task(), "queued#g1")
        yield* jobs.cancel("queued#g1")
        expect(yield* jobs.status("queued#g1")).toEqual(stopped)
        expect(yield* host.claim(claimAll)).toBeNull()
        yield* jobs.start(task(), "claimed#g1")
        const job = (yield* host.claim(claimAll))!
        yield* jobs.cancel("claimed#g1")
        expect(yield* jobs.status("claimed#g1")).toEqual({ _tag: "Running" })
        expect(yield* host.heartbeat({ key: job.key, claim: job.claim })).toMatchObject({ held: true, cancel: true })
        // A retryable end of a job someone asked to stop ends it cancelled.
        yield* host.settle({ key: job.key, claim: job.claim, outcome: { _tag: "Retryable" } })
        expect(yield* jobs.status("claimed#g1")).toEqual(stopped)
        // Each later generation of a cancelled one is cancelled as it is queued.
        yield* jobs.start(task(), "claimed#g2")
        expect(yield* jobs.status("claimed#g2")).toEqual(stopped)
        expect(yield* host.claim(claimAll)).toBeNull()
      })
    ))

  test("an open job past its agent's hours ends timeout; a claimed one after the runner's grace", () =>
    run(({ host, jobs }) =>
      Effect.gen(function*() {
        yield* jobs.start(task(), "q#g1")
        yield* jobs.start(task(), "c#g1")
        yield* jobs.start(task(), "s#g1")
        // Claims in queue order: the first two queued.
        const claimed = (yield* host.claim(claimAll))!
        const other = (yield* host.claim({ ...claimAll, running: [claimed.key] }))!
        expect([claimed.key, other.key]).toEqual(["q#g1", "c#g1"])
        yield* TestClock.adjust(HOUR)
        expect(yield* host.heartbeat({ key: claimed.key, claim: claimed.claim })).toMatchObject({
          held: true,
          cancel: true
        })
        expect(yield* jobs.status("s#g1")).toEqual({ _tag: "Ended", outcome: { _tag: "Failed", reason: "timeout" } })
        expect(yield* jobs.status("q#g1")).toEqual({ _tag: "Running" })
        yield* TestClock.adjust(LocalJobs.SETTLE_GRACE_MS)
        expect(yield* jobs.status("q#g1")).toEqual({ _tag: "Ended", outcome: { _tag: "Failed", reason: "timeout" } })
        // The claim loop's own pass ends the other: it is never handed back.
        expect(yield* host.claim(claimAll)).toBeNull()
        expect(rowOf("c#g1")).toMatchObject({ status: "failed", cancelRequested: true })
        expect(yield* host.settle({ key: other.key, claim: other.claim, outcome: done })).toEqual({ recorded: false })
      })
    ))

  test("a retryable end gets the next generation after its wait, by the first one's deadline, up to the restarts", () =>
    run(({ host, jobs }) =>
      Effect.gen(function*() {
        yield* jobs.start(task(1), "r#g1")
        const first = (yield* host.claim(claimAll))!
        yield* TestClock.adjust(1000)
        yield* host.settle({ key: first.key, claim: first.claim, outcome: { _tag: "Retryable", afterSeconds: 30 } })
        expect(yield* jobs.status("r#g1")).toEqual({ _tag: "Again" })
        yield* jobs.start(task(1), "r#g2")
        expect(yield* host.claim(claimAll)).toBeNull()
        yield* TestClock.adjust(30_000)
        const second = (yield* host.claim(claimAll))!
        expect(second).toMatchObject({ key: "r#g2", generation: 2, deadline: HOUR })
        yield* host.settle({ key: second.key, claim: second.claim, outcome: { _tag: "Retryable" } })
        expect(yield* jobs.status("r#g2")).toEqual({ _tag: "Ended", outcome: { _tag: "Failed", reason: "exhausted" } })
        // With no wait asked, the next generation is claimable at once.
        yield* jobs.start(task(2), "n#g1")
        const next = (yield* host.claim(claimAll))!
        yield* host.settle({ key: next.key, claim: next.claim, outcome: { _tag: "Retryable" } })
        yield* jobs.start(task(2), "n#g2")
        expect((yield* host.claim(claimAll))?.key).toBe("n#g2")
      })
    ))

  test("opened again from its files, it hands a claimed job back to the restarted runner", async () => {
    const job = await run(({ host, jobs }) => jobs.start(task(), "k#g1").pipe(Effect.andThen(host.claim(claimAll))))
    await run(({ host, jobs }) =>
      Effect.gen(function*() {
        expect(yield* jobs.status("k#g1")).toEqual({ _tag: "Running" })
        expect(yield* host.claim({ ...claimAll, running: ["k#g1"] })).toBeNull()
        expect(yield* host.claim({ ...claimAll, free: 0 })).toEqual({ ...job, reclaimed: true })
        expect(yield* host.heartbeat({ key: "k#g1", claim: job!.claim })).toMatchObject({ held: true })
      })
    )
  })

  test("a file that doesn't decode is left alone: its job is unavailable and never claimed; leftovers go", async () => {
    await run(({ jobs }) => jobs.start(task(), "good#g1"))
    writeFileSync(join(stateDir, "jobs", `${LocalJobs.fileOf("bad#g1")}.json`), "{\"key\":\"bad#g1\",\"sta")
    // A row whose key doesn't name its file is as unreadable.
    writeFileSync(
      join(stateDir, "jobs", `${LocalJobs.fileOf("moved#g1")}.json`),
      readFileSync(join(stateDir, "jobs", `${LocalJobs.fileOf("good#g1")}.json`), "utf8")
    )
    writeFileSync(join(stateDir, "jobs", `.${LocalJobs.fileOf("good#g1")}.left-by-a-kill`), "{")
    await run(({ host, jobs }) =>
      Effect.gen(function*() {
        expect(yield* Effect.exit(jobs.status("bad#g1"))).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { _tag: "@smthrs/agent/AgentRunner/AgentJobsUnavailable" } }] }
        })
        expect(Exit.isFailure(yield* Effect.exit(jobs.status("moved#g1")))).toBe(true)
        expect((yield* host.claim(claimAll))?.key).toBe("good#g1")
        expect(yield* host.claim({ ...claimAll, running: ["good#g1"] })).toBeNull()
      })
    )
    expect(rowFiles().filter((name) => name.startsWith("."))).toEqual([])
    expect(rowFiles()).toHaveLength(3)
  })

  test("a failed write changes nothing: the step and the claim loop are told the store is unavailable", () =>
    run(({ host, jobs }) =>
      Effect.gen(function*() {
        faults.add("rename")
        const unavailable = { _tag: "@smthrs/agent/AgentRunner/AgentJobsUnavailable" }
        expect(yield* Effect.flip(jobs.start(task(), "w#g1"))).toMatchObject(unavailable)
        expect(yield* Effect.flip(jobs.cancel("w#g1"))).toMatchObject(unavailable)
        faults.delete("rename")
        expect(yield* jobs.status("w#g1")).toEqual({ _tag: "Again" })
        yield* jobs.start(task(), "w#g1")
        faults.add("rename")
        expect(yield* Effect.flip(jobs.cancel("w#g1"))).toMatchObject(unavailable)
        expect(yield* Effect.flip(host.claim(claimAll))).toMatchObject({ code: "unavailable", route: "claim" })
        faults.delete("rename")
        const job = (yield* host.claim(claimAll))!
        faults.add("rename")
        expect(yield* Effect.flip(host.settle({ key: job.key, claim: job.claim, outcome: done })))
          .toMatchObject({ code: "unavailable", route: "settle" })
        expect(yield* host.heartbeat({ key: job.key, claim: job.claim })).toMatchObject({ held: true, cancel: false })
        expect(yield* jobs.status("w#g1")).toEqual({ _tag: "Running" })
        // A host with no credential to issue: the runner fetches as with none.
        expect(yield* Effect.flip(host.gitCredential({ key: job.key, claim: job.claim })))
          .toMatchObject({ code: "invalid", status: 404 })
      })
    ))

  test("a store whose files can't be read doesn't open", async () => {
    await run(({ jobs }) => jobs.start(task(), "x#g1"))
    faults.add("read")
    await expect(run(() => Effect.void)).rejects.toMatchObject({ _tag: "PlatformError" })
  })

  test("keeps each event of a job's transcript once and in order, from a cut line too", async () => {
    const event = (seq: number) => ({ seq, at: seq, kind: "agent_message_chunk", update: { text: `e${seq}` } })
    const file = join(stateDir, "transcripts", `${LocalJobs.fileOf("t#g1")}.jsonl`)
    await run(({ host, jobs }) =>
      Effect.gen(function*() {
        expect(yield* Effect.flip(host.events({ key: "t#g1", claim: "c", events: [event(0)] })))
          .toMatchObject({ code: "invalid", route: "events", status: 409 })
        yield* jobs.start(task(), "t#g1")
        expect(yield* host.events({ key: "t#g1", claim: "c", events: [event(1), event(0)] })).toEqual({ next: 2 })
        // Again, and past a gap: only what comes next is kept.
        expect(yield* host.events({ key: "t#g1", claim: "c", events: [event(1), event(3)] })).toEqual({ next: 2 })
        expect(yield* host.events({ key: "t#g1", claim: "c", events: [] })).toEqual({ next: 2 })
        faults.add("append")
        expect(yield* Effect.flip(host.events({ key: "t#g1", claim: "c", events: [event(2)] })))
          .toMatchObject({ code: "unavailable", route: "events" })
      })
    )
    // A kill cut the last line short.
    writeFileSync(file, `${readFileSync(file, "utf8")}{"seq":2,"at`)
    await run(({ host }) =>
      Effect.gen(function*() {
        expect(yield* host.events({ key: "t#g1", claim: "c", events: [event(2)] })).toEqual({ next: 3 })
      })
    )
    expect(readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line).seq)).toEqual([0, 1, 2])
    // A transcript cut before its first line is whole starts from 0.
    const empty = join(stateDir, "transcripts", `${LocalJobs.fileOf("u#g1")}.jsonl`)
    mkdirSync(join(stateDir, "transcripts"), { recursive: true })
    writeFileSync(empty, "{\"seq\":0")
    await run(({ host, jobs }) =>
      jobs.start(task(), "u#g1").pipe(Effect.andThen(host.events({ key: "u#g1", claim: "c", events: [event(0)] })))
    )
    expect(readFileSync(empty, "utf8").trim().split("\n")).toHaveLength(1)
  })
})
