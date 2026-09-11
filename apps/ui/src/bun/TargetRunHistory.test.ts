import { expect, test } from "bun:test"
import { closeSync, constants, openSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunHistoryResponseSchema, RunReplayResponseSchema } from "@smthrs/rpc/TargetGraph"
import { createTargetRunHistory, JOURNAL_TRUNCATED_MARKER, MAX_JOURNAL_LOADS, MAX_PENDING_LOG_CHARS, MAX_RESIDENT_RUNS, MAX_RETAINED_LOG_CHARS } from "./TargetRunHistory"
import type { TargetRun } from "./Targets"

test("run history persists and reloads ordered events", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  const run: TargetRun = { runId: "run-1", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
  const history = createTargetRunHistory()
  await history.start(run)
  history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100 })
  history.event(run, { type: "node", node: { label: "//:test", status: "ran", durationMs: 10 }, at: 110 })
  history.event(run, { type: "summary", summary: { total: 1, hit: 0, ran: 1, failed: 0, skipped: 0, durationMs: 10, ok: true, criticalPath: ["//:test"] }, at: 110 })
  history.event(run, { type: "exit", code: 0 })
  expect((await history.list("repo-1", repo))[0]).toMatchObject({ runId: "run-1", status: "done", exitCode: 0 })

  const reloaded = createTargetRunHistory()
  const listed = await reloaded.list("repo-1", repo)
  expect(listed).toHaveLength(1)
  const replay = await reloaded.replay("run-1")
  expect(replay?.events.map((event) => event.type)).toEqual(["started", "node", "summary", "exit"])
  expect(replay?.run.summary?.criticalPath).toEqual(["//:test"])
  await rm(repo, { recursive: true, force: true })
})

test("a run interrupted by a restart reloads as failed, not stuck running", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  const run: TargetRun = { runId: "run-2", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
  const history = createTargetRunHistory()
  await history.start(run)
  history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100 })
  await history.list("repo-1", repo) // flush the event queue; no exit frame follows (crash)

  const reloaded = createTargetRunHistory()
  const listed = await reloaded.list("repo-1", repo)
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({ runId: "run-2", status: "failed" })
  const replay = await reloaded.replay("run-2")
  expect(replay?.run.status).toBe("failed")
  expect(replay?.events.map((event) => event.type)).toEqual(["started"])
  await rm(repo, { recursive: true, force: true })
})

test("replay orders every frame by its run-local sequence", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  const run: TargetRun = { runId: "run-seq", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
  const history = createTargetRunHistory()
  await history.start(run)
  history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100, seq: 0 })
  history.event(run, { type: "exit", code: 0, seq: 2 })
  history.event(run, { type: "stdout", data: "hello", seq: 1 })
  const replay = await history.replay(run.runId)
  expect(replay?.events.map((event) => event.seq)).toEqual([0, 1, 2])
  await rm(repo, { recursive: true, force: true })
})

test("a failed terminal append reports degraded durability and agrees with the durable bytes", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const run: TargetRun = { runId: "append-failure", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
    const logs: Array<string> = []
    const history = createTargetRunHistory({ log: (line) => logs.push(line) })
    await history.start(run)
    const path = join(repo, ".flows", "ui", "runs", `${run.runId}.jsonl`)
    await rename(path, `${path}.saved`)
    await mkdir(path) // EISDIR, even when tests run with elevated permissions.
    history.event(run, { type: "exit", code: 0 })
    const replay = RunReplayResponseSchema.parse(await history.replay(run.runId))
    expect(replay.run.journal).toMatchObject({ state: "degraded", error: expect.stringContaining("EISDIR") })
    expect(replay.run.status).toBe("failed")
    expect(replay.run.exitCode).toBeUndefined()
    expect(replay.events).toEqual([])
    const listed = RunHistoryResponseSchema.parse({ runs: await history.list(run.repoId, repo) })
    expect(listed.runs[0]).toEqual(replay.run)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(run.runId)
    expect(logs[0]).toContain("EISDIR")
    await expect(history.flush()).rejects.toThrow("Target run journal append failed")

    await rm(path, { recursive: true })
    await rename(`${path}.saved`, path)
    const restored = await createTargetRunHistory().replay(run.runId, [{ id: run.repoId, path: repo }])
    expect(restored?.run.journal?.state).toBe("degraded")
    expect(restored?.run.status).toBe(replay.run.status)
    expect(restored?.run.exitCode).toBeUndefined()
    expect(restored?.events).toEqual(replay.events)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("the first failed append stops durable acknowledgements without blocking other runs", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const run: TargetRun = { runId: "gap", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
    const other = { ...run, runId: "healthy" }
    const logs: Array<string> = []
    const history = createTargetRunHistory({ log: (line) => logs.push(line) })
    await history.start(run)
    await history.start(other)
    history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100 })
    history.event(run, { type: "summary", summary: { total: 1, hit: 0, ran: 1, failed: 0, skipped: 0, durationMs: 10, ok: true, criticalPath: [run.label] }, at: 110 })
    await history.flush()
    const path = join(repo, ".flows", "ui", "runs", `${run.runId}.jsonl`)
    const durable = await readFile(path, "utf8")
    await rename(path, `${path}.saved`)
    await mkdir(path)
    history.event(run, { type: "stdout", data: "lost" })
    history.event(run, { type: "exit", code: 0 })
    const degraded = RunReplayResponseSchema.parse(await history.replay(run.runId))
    await rm(path, { recursive: true })
    await rename(`${path}.saved`, path)
    // Repairing the path must not allow later frames to conceal the gap.
    history.event(run, { type: "exit", code: 0 })
    history.event(other, { type: "exit", code: 0 })
    await expect(history.flush()).rejects.toThrow("Target run journal append failed")
    expect(await history.replay(run.runId)).toEqual(degraded)
    expect(await readFile(path, "utf8")).toBe(durable)
    expect(logs).toHaveLength(1)
    const restored = await createTargetRunHistory().replay(run.runId, [{ id: run.repoId, path: repo }])
    expect(restored?.events).toEqual(degraded?.events)
    expect(restored?.run).toEqual({ ...degraded.run, journal: { state: "degraded", error: expect.any(String) } })
    expect((await history.replay(other.runId))?.run.status).toBe("done")
    expect((await createTargetRunHistory().replay(other.runId, [{ id: run.repoId, path: repo }]))?.run.status).toBe("done")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

const runsDirOf = (repo: string): string => join(repo, ".flows", "ui", "runs")
const mkfifo = (path: string): void => {
  const made = Bun.spawnSync(["mkfifo", path])
  if (made.exitCode !== 0) throw new Error(`mkfifo ${path}: ${made.stderr.toString()}`)
}
/*
 * Has the loader opened this FIFO for reading? A non-blocking write-only
 * open succeeds only once a reader holds the other end and fails with ENXIO
 * otherwise, and the synchronous call never occupies Bun's file thread pool,
 * whose size is the CPU count: the loader's own blocked reads must be the
 * only ones in it, or a small CI runner deadlocks. The writer end stays open:
 * closing it is what gives the loader end-of-file, see `release`.
 */
const attach = (path: string): number | undefined => {
  try {
    return openSync(path, constants.O_WRONLY | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENXIO") return undefined
    throw error
  }
}
const untilAttached = async (path: string): Promise<number> => {
  for (let attempt = 0; attempt < 500; attempt++) {
    const fd = attach(path)
    if (fd !== undefined) return fd
    await Bun.sleep(10)
  }
  throw new Error(`no reader attached to ${path}`)
}
/** Give the loader end-of-file on this FIFO: its only writer closes. */
const release = (fd: number): void => closeSync(fd)

test.skipIf(process.platform === "win32")("loading a repository opens a bounded number of journals at once", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const dir = runsDirOf(repo)
    await mkdir(dir, { recursive: true })
    /*
     * Every journal used to be read at once with readFile: a repository with
     * a long history materialized every log byte it ever wrote in one go. A
     * FIFO stands in for a slow journal; the loader blocks on it until it is
     * released, so which FIFOs have a reader shows how many load together.
     */
    const paths = Array.from({ length: MAX_JOURNAL_LOADS + 1 }, (_, index) => join(dir, `run-${index}.jsonl`))
    for (const path of paths) mkfifo(path)
    const history = createTargetRunHistory()
    const listed = history.list("repo-1", repo)
    const held = new Map<string, number>()
    held.set(paths[0]!, await untilAttached(paths[0]!))
    await Bun.sleep(150)
    for (const path of paths) {
      if (held.has(path)) continue
      const fd = attach(path)
      if (fd !== undefined) held.set(path, fd)
    }
    expect(held.size).toBeGreaterThan(0)
    expect(held.size).toBeLessThanOrEqual(MAX_JOURNAL_LOADS)
    expect(held.has(paths[MAX_JOURNAL_LOADS]!)).toBe(false)
    /* Releasing the journals in flight lets the loader move on to the rest. */
    const remaining = new Set(paths)
    while (remaining.size > 0) {
      for (const path of [...remaining]) {
        const fd = held.get(path) ?? attach(path)
        if (fd === undefined) continue
        release(fd)
        held.delete(path)
        remaining.delete(path)
      }
      if (remaining.size > 0) await Bun.sleep(10)
    }
    expect(await listed).toEqual([])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("a log backlog the disk has not taken yet stops resolving at the pending budget", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const dir = runsDirOf(repo)
    await mkdir(dir, { recursive: true })
    /* The loader must finish before the first append; a FIFO holds it. */
    const gate = join(dir, "gate.jsonl")
    mkfifo(gate)
    const run: TargetRun = { runId: "backlog", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
    /* This pins the pending budget; redacting 4 MB of filler only adds CPU time. */
    const history = createTargetRunHistory({ redact: (text) => text })
    const started = history.start(run)
    /*
     * Every frame used to extend the append chain at once, so a child that
     * outran the disk pinned its whole output in queued closures. Now the
     * frame that crosses the budget waits until the backlog drains under it.
     */
    const chunk = "x".repeat(100_000)
    const frames = Math.ceil(MAX_PENDING_LOG_CHARS / chunk.length)
    const settled: Array<boolean> = []
    const pending: Array<Promise<void>> = []
    for (let index = 0; index <= frames; index++) {
      const promise = history.event(run, { type: "stdout", data: chunk, seq: index })
      settled.push(false)
      pending.push(promise.then(() => { settled[index] = true }))
    }
    await Bun.sleep(50)
    expect(settled.slice(0, frames).every(Boolean)).toBe(true)
    expect(settled[frames]).toBe(false)
    /* One more over the budget waits as well. */
    let overflowSettled = false
    const overflow = history.event(run, { type: "exit", code: 0, seq: frames + 1 }).then(() => { overflowSettled = true })
    await Bun.sleep(20)
    expect(overflowSettled).toBe(false)

    release(await untilAttached(gate))
    await started
    await Promise.all([...pending, overflow])
    expect(settled.every(Boolean)).toBe(true)
    expect(overflowSettled).toBe(true)
    await history.flush()
    const replay = RunReplayResponseSchema.parse(await history.replay(run.runId))
    expect(replay.run.status).toBe("done")
    expect(replay.events.map((event) => event.seq)).toEqual([...Array.from({ length: frames + 1 }, (_, index) => index).slice(-Math.floor(MAX_RETAINED_LOG_CHARS / chunk.length)), frames + 1])
    const journal = await readFile(join(dir, `${run.runId}.jsonl`), "utf8")
    expect(journal.split("\n").filter((line) => line !== "")).toHaveLength(frames + 4)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("settled runs beyond the resident bound answer replay from their journal", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const history = createTargetRunHistory()
    const runs: Array<TargetRun> = []
    for (let index = 0; index <= MAX_RESIDENT_RUNS; index++) {
      const run: TargetRun = { runId: `resident-${index}`, repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 + index }
      runs.push(run)
      await history.start(run)
      void history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: run.startedAt, seq: 0 })
      void history.event(run, { type: "stdout", data: `memory ${index}`, seq: 1 })
      void history.event(run, { type: "exit", code: 0, seq: 2 })
      /* Settle each run before the next starts so eviction order is the start order. */
      await history.flush()
    }
    /*
     * Every run's events used to stay resident for the life of the process,
     * so history grew the heap by up to a capped tail per run ever started.
     * Rewriting the journals tells memory from disk: the oldest settled run
     * is read back from its file, the newest still answers from memory.
     */
    const rewrite = async (run: TargetRun): Promise<void> => {
      const path = join(runsDirOf(repo), `${run.runId}.jsonl`)
      const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "")
      const record = lines[0]!
      await writeFile(path, `${record}\n${JSON.stringify({ type: "event", event: { type: "stdout", data: "disk", seq: 1 } })}\n`)
    }
    const oldest = runs[0]!
    const newest = runs[runs.length - 1]!
    await rewrite(oldest)
    await rewrite(newest)
    expect((await history.replay(oldest.runId))?.events).toEqual([{ type: "stdout", data: "disk", seq: 1 }])
    expect((await history.replay(newest.runId))?.events.map((event) => event.type)).toEqual(["started", "stdout", "exit"])
    /* Records stay resident: the list needs no journal read. */
    expect((await history.list("repo-1", repo)).map((record) => record.runId)).toHaveLength(MAX_RESIDENT_RUNS + 1)
    expect((await history.list("repo-1", repo)).every((record) => record.status === "done")).toBe(true)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("a multi-megabyte journal reloads with the capped tail and every structured frame", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const run: TargetRun = { runId: "big", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
    const dir = runsDirOf(repo)
    await mkdir(dir, { recursive: true })
    const record = { runId: run.runId, repoId: run.repoId, label: run.label, labels: [...run.labels], status: "pending", startedAt: run.startedAt }
    const chunk = "x".repeat(10_000)
    const lines = [JSON.stringify({ type: "record", record })]
    lines.push(JSON.stringify({ type: "event", event: { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100, seq: 0 } }))
    const frames = 300
    for (let index = 0; index < frames; index++) lines.push(JSON.stringify({ type: "event", event: { type: "stdout", data: `${index}:${chunk}`, seq: index + 1 } }))
    lines.push(JSON.stringify({ type: "event", event: { type: "exit", code: 0, seq: frames + 1 } }))
    lines.push(JSON.stringify({ type: "record", record: { ...record, status: "done", exitCode: 0, endedAt: 200 } }))
    await writeFile(join(dir, `${run.runId}.jsonl`), `${lines.join("\n")}\n`)

    const history = createTargetRunHistory()
    const replay = RunReplayResponseSchema.parse(await history.replay(run.runId, [{ id: run.repoId, path: repo }]))
    expect(replay.run.status).toBe("done")
    const logs = replay.events.filter((event) => event.type === "stdout")
    const retained = logs.reduce((total, event) => total + (event as { data: string }).data.length, 0)
    expect(retained).toBeLessThanOrEqual(MAX_RETAINED_LOG_CHARS)
    expect(logs.length).toBeGreaterThan(0)
    expect((logs[logs.length - 1] as { data: string }).data.startsWith(`${frames - 1}:`)).toBe(true)
    expect(replay.events[0]?.type).toBe("started")
    expect(replay.events[replay.events.length - 1]?.type).toBe("exit")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("log frames reach the journal and the replay redacted", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const run: TargetRun = { runId: "secret", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
    const history = createTargetRunHistory()
    await history.start(run)
    const token = `ghp_${"a".repeat(36)}`
    void history.event(run, { type: "stdout", data: `token=${token}\n`, seq: 0 })
    void history.event(run, { type: "stderr", data: `Authorization: Bearer ${token}\n`, seq: 1 })
    void history.event(run, { type: "exit", code: 0, seq: 2 })
    await history.flush()
    const journal = await readFile(join(runsDirOf(repo), `${run.runId}.jsonl`), "utf8")
    expect(journal).not.toContain(token)
    expect(journal).toContain("REDACTED")
    const replay = await history.replay(run.runId)
    expect(JSON.stringify(replay)).not.toContain(token)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")("the journal is private to its owner and ignored by git", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const run: TargetRun = { runId: "mode", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
    const history = createTargetRunHistory()
    await history.start(run)
    void history.event(run, { type: "exit", code: 0 })
    await history.flush()
    expect((await stat(join(runsDirOf(repo), `${run.runId}.jsonl`))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(repo, ".flows", "ui", ".gitignore"), "utf8")).toBe("*\n")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("log output past the journal cap ends in one truncation marker", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const run: TargetRun = { runId: "capped", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
    const history = createTargetRunHistory({ maxJournalLogChars: 250 })
    await history.start(run)
    for (let index = 0; index < 10; index++) void history.event(run, { type: "stdout", data: "x".repeat(100), seq: index })
    void history.event(run, { type: "exit", code: 0, seq: 10 })
    await history.flush()
    const lines = (await readFile(join(runsDirOf(repo), `${run.runId}.jsonl`), "utf8")).split("\n").filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string; event?: { type: string; data?: string } })
    const events = lines.flatMap((line) => line.event === undefined ? [] : [line.event])
    expect(events.filter((event) => event.type === "stdout")).toHaveLength(2)
    const markers = events.filter((event) => event.data === JOURNAL_TRUNCATED_MARKER)
    expect(markers).toHaveLength(1)
    expect(events.map((event) => event.type)).toEqual(["stdout", "stdout", "stderr", "exit"])
    expect(lines[lines.length - 1]?.type).toBe("record")
    expect((await history.replay(run.runId))?.run.status).toBe("done")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
