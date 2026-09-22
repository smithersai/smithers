import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Coordinator, type Dependencies } from "./coordinator"
import type { LiveTutorialRun } from "@smthrs/rpc/LiveTutorial"

const answer = { title: "Observed issue", summary: "Actual test evidence", steps: ["Fix the greeting"], files: [], message: "" }
const executor = {
  snapshot: async () => ({ base: "base", head: "base", files: { "src/hello.ts": "broken" } }),
  files: async () => ({ "src/hello.ts": "broken" }),
  apply: async () => { throw new Error("Unexpected apply") },
  commit: async () => { throw new Error("Unexpected commit") },
  diff: async () => { throw new Error("Unexpected diff") },
  test: async () => ({ command: "test", code: 1, stdout: "recorded failure", stderr: "" }),
}

if (process.argv[2] === "--interrupted-owner") {
  const coordinator = new Coordinator(process.argv[3]!, {
    ensure: async () => executor,
    agent: async () => {
      const run = coordinator.journal.all().find(row => row.run.sessionId === "visitor")!.run
      process.send!({ runId: run.runId })
      return new Promise<never>(() => {})
    },
  })
  const now = Date.now()
  coordinator.journal.create({ sessionId: "queued", runId: "queued", operation: "research", phase: "queued", createdAt: now, updatedAt: now, events: [] }, { playthrough: 0, idempotencyKey: "queued" })
  coordinator.start("visitor", "research", { playthrough: 0, idempotencyKey: "interrupted" })
  setInterval(() => {}, 1000)
} else {
  const directory = await mkdtemp(join(tmpdir(), "tutorial-restart-"))
  const child = spawn(process.execPath, [process.argv[1]!, "--interrupted-owner", directory], { stdio: ["ignore", "inherit", "inherit", "ipc"] })
  let replacement: Coordinator | undefined, observer: Coordinator | undefined
  const close = (coordinator: Coordinator | undefined) => {
    if (!coordinator) return
    // Also runs against the pre-fix coordinator to demonstrate the regression.
    const compatible: { close?: () => void; db: { close(): void } } = coordinator
    if (compatible.close) compatible.close()
    else compatible.db.close()
  }
  try {
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) }) as [{ runId: string }]
    let calls = 0, hold = false, release: ((value: typeof executor) => void) | undefined
    const deps: Dependencies = { ensure: async () => { calls++; return hold ? new Promise<typeof executor>(resolve => { release = resolve }) : executor }, agent: async () => answer }
    replacement = new Coordinator(directory, deps)
    const key = { playthrough: 0, idempotencyKey: "interrupted" }
    const active = replacement.start("visitor", "research", key)
    assert.equal(active.runId, message.runId)
    replacement.resume()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(calls, 0, "another coordinator cannot drive a live owner's workspace")
    assert.equal(replacement.get("visitor", active.runId)!.phase, "running")

    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
    replacement.resume()
    const recovered = replacement.get("visitor", active.runId)!
    assert.equal(recovered.phase, "failed", "a killed owner's claim must become a visible, retryable failure")
    assert.match(recovered.error!, /interrupted/i)
    assert.equal(recovered.events.find(event => event.id === "research")!.status, "failed")
    assert.equal(replacement.journal.checkpoint(recovered, "reproduce"), JSON.stringify(await executor.test()), "confirmed checkpoints must survive recovery")
    const history = replacement.journal.history(active.runId)
    assert.equal(history.filter(record => record.fact.kind === "execution.claimed").length, 1, "recovery never re-executes an ambiguous claim")
    const interruption = history.find(record => record.fact.kind === "execution.interrupted")!.fact
    assert.equal(interruption.kind === "execution.interrupted" && interruption.executionId, active.runId)
    assert.equal(replacement.journal.verify(active.runId), true)
    assert.throws(() => replacement!.journal.recordCheckpoint(active, "late", "{}"), /stale writer/, "pre-recovery writers are fenced by the journal head")
    assert.equal(replacement.start("visitor", "research", key).runId, active.runId)
    assert.equal(replacement.start("visitor", "research", key).phase, "failed")

    observer = new Coordinator(directory, deps)
    observer.resume()
    assert.throws(() => observer!.start("another", "research", { playthrough: 0, idempotencyKey: "new" }), /coordinator.*running/i)
    const wait = async (session: string, id: string): Promise<LiveTutorialRun> => {
      for (let n = 0; n < 200; n++) {
        const run = replacement!.get(session, id)!
        if (run.phase === "completed" || run.phase === "failed") return run
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      throw new Error("The restarted coordinator did not settle")
    }
    assert.equal((await wait("queued", "queued")).phase, "completed", "unclaimed queued work can execute after restart")
    const retried = replacement.start("visitor", "research", { ...key, idempotencyKey: "retry" })
    assert.notEqual(retried.runId, active.runId)
    assert.equal((await wait("visitor", retried.runId)).phase, "completed", "the interrupted claim must no longer block a retry")
    assert.equal(calls, 4, "only queued work and the explicit retry acquire the executor")
    hold = true
    const closing = replacement.start("closing", "research", { playthrough: 0, idempotencyKey: "closing" })
    for (let n = 0; n < 100 && !release; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(release)
    replacement.close()
    observer.resume()
    release(executor)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(observer.get("closing", closing.runId)!.phase, "failed")
    assert.equal(calls, 5, "a closed owner must not issue another call after pending work returns")
    assert.equal(observer.get("visitor", active.runId)!.phase, "failed", "a subsequent owner must preserve the terminal recovery result")
    assert.equal(observer.journal.history(active.runId).filter(record => record.fact.kind === "execution.interrupted").length, 1)
    console.log("Tutorial restart passed: real SIGKILL, live-owner exclusion, durable interruption, checkpoint retention, stale-writer fencing, queued recovery, explicit retry, closed-owner fencing")
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited }
    close(observer); close(replacement)
    await rm(directory, { recursive: true, force: true })
  }
}
