import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TargetRunEvent } from "@smthrs/rpc/TargetGraph"
import type { NodeSidecar } from "./Node"
import { createTargetRunHistory, JOURNAL_TRUNCATED_MARKER } from "./TargetRunHistory"
import { createTargetRunner } from "./Targets"
import type { TargetRun } from "./Targets"

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const scratch = async () => { const directory = await mkdtemp(join(tmpdir(), "target-commit-")); directories.push(directory); return directory }
const runOf = (repo: string): TargetRun => ({ runId: "run", repoId: "repo", repo, workspace: ".", label: "//:test",
  labels: ["//:test"], startedAt: 100, status: "pending", exitCode: null })
const pathOf = (run: TargetRun) => join(run.repo, ".flows", "ui", "runs", `${run.runId}.jsonl`)
const node: NodeSidecar = { path: process.execPath, version: "test" }
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 500; attempt++) { if (predicate()) return; await Bun.sleep(10) }
  throw new Error("Target did not settle")
}

describe("target publication follows durable acceptance", () => {
  test("receipts contain exactly the redacted and capped journal frames", async () => {
    const run = runOf(await scratch())
    const history = createTargetRunHistory({ redact: value => value.replaceAll("secret", "hidden"), maxJournalLogChars: 10 })
    await history.start(run)
    expect(await history.event(run, { type: "stdout", data: "secret", seq: 0 })).toEqual({ type: "stdout", data: "hidden", seq: 0 })
    expect(await history.event(run, { type: "stdout", data: "overflow", seq: 1 })).toEqual({ type: "stderr", data: JOURNAL_TRUNCATED_MARKER, seq: 1 })
    expect(await history.event(run, { type: "stdout", data: "omitted", seq: 2 })).toBeNull()
    const exit = await history.event(run, { type: "exit", code: 0, seq: 3, at: 222 })
    if (exit === null) throw new Error("A terminal event cannot be omitted by log retention")
    expect(exit).toEqual({ type: "exit", code: 0, seq: 3, at: 222 })
    const bytes = await readFile(pathOf(run), "utf8")
    expect(bytes).not.toContain("secret")
    expect(bytes).not.toContain("omitted")
    expect((await history.replay(run.runId))?.events).toEqual([
      { type: "stdout", data: "hidden", seq: 0 }, { type: "stderr", data: JOURNAL_TRUNCATED_MARKER, seq: 1 }, exit
    ])
  })

  test("terminal state reconstructs from exit facts when the final record cache is removed or changed", async () => {
    const run = runOf(await scratch())
    const history = createTargetRunHistory()
    await history.start(run)
    await history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100, seq: 0 })
    await history.event(run, { type: "exit", code: 0, seq: 1, at: 222 })
    const lines = (await readFile(pathOf(run), "utf8")).trim().split("\n")
    const expected = await history.replay(run.runId)
    for (const final of ["", JSON.stringify({ type: "record", record: { ...expected!.run, status: "failed", endedAt: 999, exitCode: 1 } })]) {
      await writeFile(pathOf(run), [...lines.slice(0, -1), final].filter(Boolean).join("\n") + "\n")
      expect(await createTargetRunHistory().replay(run.runId, [{ id: run.repoId, path: run.repo }])).toEqual(expected)
    }
  })

  test("a failed append returns no receipt, does not recreate a missing prefix, and poisons the suffix", async () => {
    const run = runOf(await scratch())
    const history = createTargetRunHistory({ log: () => {} })
    await history.start(run)
    const saved = `${pathOf(run)}.saved`
    await rename(pathOf(run), saved)
    expect(await history.event(run, { type: "stdout", data: "unaccepted", seq: 0 })).toBeNull()
    expect(await Bun.file(pathOf(run)).exists()).toBe(false)
    await rename(saved, pathOf(run))
    expect(await history.event(run, { type: "exit", code: 0, seq: 1 })).toBeNull()
    expect((await history.replay(run.runId))?.events).toEqual([])
    await expect(history.flush()).rejects.toThrow("append failed")
  })

  test("the live topic carries the committed canonical frames in the same order as reload", async () => {
    const repo = await scratch(), cli = join(repo, "cli.ts")
    await writeFile(cli, 'console.log("secret"); console.error("diagnostic")')
    const history = createTargetRunHistory({ redact: value => value.replaceAll("secret", "hidden") })
    const published: TargetRunEvent[] = [], durableAtPublish: boolean[] = []
    let run!: TargetRun
    const runner = createTargetRunner({ cli, autoStartMs: 60_000, onEvent: history.event,
      publish: (_topic, message) => {
        const frame = (message as { frame: TargetRunEvent }).frame
        published.push(frame)
        durableAtPublish.push(readFileSync(pathOf(run), "utf8").includes(JSON.stringify({ type: "event", event: frame })))
      } })
    try {
      run = runner.reserve({ repoId: "repo", repo, workspace: ".", label: "//:test", node })
      await history.start(run)
      runner.arm(run.runId); runner.attach(run.runId)
      await waitFor(() => published.some(frame => frame.type === "exit"))
      await runner.stop()
      expect(durableAtPublish.every(Boolean)).toBe(true)
      expect(JSON.stringify(published)).toContain("hidden")
      expect(JSON.stringify(published)).not.toContain("secret")
      const reloaded = await createTargetRunHistory().replay(run.runId, [{ id: run.repoId, path: repo }])
      expect(reloaded?.events).toEqual(published)
      expect(reloaded?.run.status).toBe("done")
    } finally { await runner.stop() }
  })

  test("journal failure suppresses live success and shutdown waits for pending terminal receipts", async () => {
    const repo = await scratch(), history = createTargetRunHistory({ log: () => {} })
    const published: TargetRunEvent[] = []
    const runner = createTargetRunner({ cli: join(repo, "missing"), autoStartMs: 60_000, onEvent: history.event,
      publish: (_topic, message) => published.push((message as { frame: TargetRunEvent }).frame) })
    const run = runner.reserve({ repoId: "repo", repo, workspace: ".", label: "//:test", node })
    await history.start(run)
    await rename(pathOf(run), `${pathOf(run)}.saved`); await mkdir(pathOf(run))
    runner.arm(run.runId); runner.attach(run.runId)
    await runner.stop()
    expect(published).toEqual([])
    expect((await history.replay(run.runId))?.run.journal?.state).toBe("degraded")
    await expect(history.flush()).rejects.toThrow("append failed")

    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const acknowledged: TargetRunEvent[] = [], visible: TargetRunEvent[] = []
    const slow = createTargetRunner({ cli: join(repo, "missing"), autoStartMs: 60_000,
      onEvent: async (_run, frame) => { acknowledged.push(frame); entered.resolve(); await gate.promise; return frame },
      publish: (_topic, message) => visible.push((message as { frame: TargetRunEvent }).frame) })
    slow.start({ repoId: "repo", repo, workspace: ".", label: "//:slow", node })
    let stopped = false
    const closing = slow.stop().then(() => { stopped = true })
    await entered.promise
    expect(visible).toEqual([])
    expect(stopped).toBe(false)
    gate.resolve(); await closing
    expect(visible).toEqual(acknowledged)
    expect(visible.map(frame => frame.type)).toEqual(["error", "exit"])
  })

  test("settled handles cannot be evicted while their terminal receipt is pending", async () => {
    const repo = await scratch(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const runner = createTargetRunner({ cli: join(repo, "missing"), autoStartMs: 60_000, maxRetainedRuns: 1,
      publish: () => {}, onEvent: async () => { entered.resolve(); await gate.promise } })
    const input = { repoId: "repo", repo, workspace: ".", label: "//:test", node }
    const run = runner.start(input)
    const cancelling = runner.cancel(run.runId)
    await entered.promise
    expect(() => runner.reserve(input)).toThrow("retained")
    gate.resolve(); await cancelling
    expect(runner.reserve(input).runId).not.toBe(run.runId)
    await runner.stop()
  })
})
