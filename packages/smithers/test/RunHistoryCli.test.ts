/** Real binary, SQLite run records and persisted history; no model call. */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { NodeRuntime } from "@smthrs/platform-node"
import { Effect } from "effect"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import { launch, processBudget, temporaryDirectoryPrefix } from "./support/bin.ts"

describe("large persisted run diagnosis", processBudget, () => {
  it("summarizes and reads fields without changing list, terminal resume or cancel", async () => {
    const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
    try {
      // A persisted-history reader must also work on a host that cannot run
      // the recorded flow. Use the real migrated stores, as RunTimingStore
      // does, without booting a flow through the optional native helper.
      await Effect.runPromise(Effect.void.pipe(
        Effect.provide(NodeRuntime.storage(join(cwd, ".flows", "engine.db"), cwd)),
        Effect.provide(NodeServices.layer),
        Effect.provide(NodeCrypto.layer)
      ))
      await Effect.runPromise(Effect.void.pipe(Effect.provide(NodeControl.engineDurable(cwd).runtime)))
      const runId = "run-large"
      const db = new DatabaseSync(join(cwd, ".flows", "control.db"))
      let sequence = 0
      const largeBytes = 17 * 1024 * 1024
      try {
        db.prepare("INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (?, 'failed', 1000, ?)")
          .run(runId, JSON.stringify({ runId, flowId: "failing", status: "failed", createdAt: 1000, updatedAt: 1001 }))
        db.prepare("INSERT INTO control_runs (run_id, created_seq) VALUES (?, 0)").run(runId)
        sequence =
          Number(db.prepare("SELECT MAX(seq) AS seq FROM flows_journal_events WHERE run_id = ?").get(runId)!.seq) + 1
        const insert = db.prepare(`INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES (?, ?, ?, 'large-fixture', ?, ?, ?, ?, '{}')`)
        // Generated on the test host. A legacy persisted state can exceed
        // today's writer bounds; readers must still diagnose it.
        insert.run(
          runId,
          sequence,
          `large-${sequence}`,
          sequence,
          Date.now(),
          "example.state",
          JSON.stringify({ state: { blob: "x".repeat(largeBytes), currentNode: "handoff", round: 401 } })
        )
        insert.run(
          runId,
          sequence + 1,
          `large-${sequence + 1}`,
          sequence + 1,
          Date.now(),
          "control.run.failed",
          JSON.stringify({ cause: "large synthetic state" })
        )
        insert.run(
          runId,
          sequence + 2,
          `large-${sequence + 2}`,
          sequence + 2,
          Date.now(),
          "example.deep",
          "{\"deep\":[" + Array.from({ length: 16 }, () => "[".repeat(200) + "0" + "]".repeat(200)).join(",") + "]}"
        )
        insert.run(
          runId,
          sequence + 3,
          `large-${sequence + 3}`,
          sequence + 3,
          Date.now(),
          "example.escaped",
          JSON.stringify({ text: "\u0085".repeat(200_000), nested: { text: "\u0085".repeat(200_000) } })
        )
      } finally {
        db.close()
      }
      const native = new DatabaseSync(join(cwd, ".flows", "engine.db"))
      try {
        native.prepare(
          "INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (?, 'failed', 1000, ?)"
        )
          .run(runId, JSON.stringify({ version: 1, flowName: "failing", payload: {} }))
        native.prepare(
          "UPDATE flows_runs SET state_json = json_set(state_json, '$.payload.synthetic', ?) WHERE run_id = ?"
        )
          .run("n".repeat(largeBytes), runId)
      } finally {
        native.close()
      }
      const invoke = (...args: Array<string>) => launch(cwd, ["runs", ...args, "--json"])
      const shown = invoke("show", runId)
      expect(shown.status, shown.stderr + shown.stdout.slice(0, 1000)).toBe(0)
      const result = JSON.parse(shown.stdout)
      expect(result).toMatchObject({
        runId,
        status: "failed",
        history: { lastRecordedNode: "handoff", currentNodeUnavailable: true, lastError: "large synthetic state" }
      })
      expect(result).not.toHaveProperty("health")
      expect(result).not.toHaveProperty("executions")
      expect(result).toMatchObject({ activityUnavailable: true, healthUnavailable: true })
      expect(result.history.round).toBe(result.executionView?.current.roundOrdinal ?? 401)
      expect(result.history.truncatedFields).toContainEqual({
        path: `/events/${sequence}/payload/state/blob`,
        bytes: largeBytes + 2
      })
      expect(shown.stdout.length).toBeLessThan(100_000)
      const field = invoke("show", runId, "--field", `/events/${sequence}/payload/state/round`)
      expect(field.status, field.stderr).toBe(0)
      expect(JSON.parse(field.stdout)).toMatchObject({ bytes: 3, value: 401 })
      const page = invoke(
        "show",
        runId,
        "--field",
        `/events/${sequence}/payload/state/blob`,
        "--offset",
        String(largeBytes - 4),
        "--length",
        "4"
      )
      expect(page.status, page.stderr).toBe(0)
      expect(JSON.parse(page.stdout)).toMatchObject({
        bytes: largeBytes + 2,
        value: "xxxx",
        page: { totalCharacters: largeBytes }
      })
      const deep = invoke("show", runId, "--field", `/events/${sequence + 2}/payload/deep`)
      expect(deep.status, deep.stderr).toBe(0)
      expect(deep.stdout.length).toBeLessThan(1024 * 1024)
      expect(JSON.parse(deep.stdout)).toMatchObject({ bytes: 6433, omitted: true, reason: "rendering-limit" })
      for (const key of ["text", "nested"]) {
        const escaped = invoke("show", runId, "--field", `/events/${sequence + 3}/payload/${key}`)
        expect(escaped.status, escaped.stderr).toBe(0)
        expect(Buffer.byteLength(escaped.stdout)).toBeLessThan(1024 * 1024)
        expect(JSON.parse(escaped.stdout)).toMatchObject({ omitted: true, reason: "rendering-limit" })
      }
      const escapedPage = invoke("show", runId, "--field", `/events/${sequence + 3}/payload/text`, "--length", "65536")
      expect(escapedPage.status, escapedPage.stderr).toBe(0)
      expect(Buffer.byteLength(escapedPage.stdout)).toBeLessThan(1024 * 1024)
      expect(JSON.parse(escapedPage.stdout)).toMatchObject({
        value: "\u0085".repeat(65536),
        page: { totalCharacters: 200_000, nextOffset: 65536 }
      })
      const human = launch(cwd, ["runs", "show", runId, "--audience", "human", "--ui", "plain"])
      expect(human.status, human.stderr).toBe(0)
      expect(human.stdout).toContain(`/events/${sequence}/payload/state/blob`)
      expect(human.stdout).toContain(String(largeBytes + 2))
      expect(human.stdout).toMatch(new RegExp(`round: ${result.history.round}`, "i"))
      const listed = invoke("list")
      expect(listed.status, listed.stderr).toBe(0)
      expect(JSON.parse(listed.stdout).items).toContainEqual(expect.objectContaining({ runId, status: "failed" }))
      for (const verb of ["resume", "cancel"]) {
        const receipt = invoke(verb, runId)
        expect(receipt.stdout).not.toContain("ResourceLimitError")
        expect(JSON.parse(receipt.stdout)).toMatchObject({ _tag: "Terminal", status: "failed" })
      }
      // A nonterminal copied history can lose a settlement or cross a rewind.
      // Exercise its current-node receipt through the actual CLI, too.
      const projectedRun = "run-projection-\u001b]0;unsafe-title\u0007\u001b[2J"
      const projected = new DatabaseSync(join(cwd, ".flows", "control.db"))
      try {
        projected.prepare(
          "INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (?, 'suspended', 1000, ?)"
        )
          .run(
            projectedRun,
            JSON.stringify({
              runId: projectedRun,
              flowId: "failing",
              status: "parked",
              createdAt: 1000,
              updatedAt: 1001
            })
          )
        projected.prepare("INSERT INTO control_runs (run_id, created_seq) VALUES (?, 0)").run(projectedRun)
        const engine = new DatabaseSync(join(cwd, ".flows", "engine.db"))
        try {
          engine.prepare(
            "INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (?, 'suspended', 1000, ?)"
          )
            .run(projectedRun, JSON.stringify({ version: 1, flowName: "failing", payload: {} }))
        } finally {
          engine.close()
        }
        let projectedSequence = 0
        const record = (kind: string, payload: unknown) => {
          projectedSequence++
          projected.prepare(`INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES (?, ?, ?, 'projection-fixture', ?, ?, ?, ?, '{}')`)
            .run(
              projectedRun,
              projectedSequence,
              `projection-${projectedSequence}`,
              projectedSequence,
              Date.now(),
              kind,
              JSON.stringify(payload)
            )
        }
        const schedule = (generation: number, nodeId: string) =>
          record("control.engine.event", {
            version: 1,
            executionId: projectedRun,
            generation,
            eventType: "flows.engine.node-scheduled",
            payload: { kind: "ActionCall", nodeId, action: nodeId }
          })
        const observe = () => {
          const result = launch(cwd, ["runs", "show", projectedRun, "--json"])
          expect(result.status, result.stderr).toBe(0)
          return JSON.parse(result.stdout).history
        }
        record("example.state", { state: { blob: "x".repeat(largeBytes), currentNode: "historical" } })
        schedule(0, "stale")
        record("control.engine.projection-gap", {
          executionId: projectedRun,
          generation: 0,
          reason: "compacted",
          throughSequence: 4
        })
        const compacted = observe()
        expect(compacted.currentNode).toBeUndefined()
        expect(compacted.currentNodeUnavailable).toBe(true)
        schedule(0, "fresh")
        expect(observe().currentNode).toBe("fresh")
        record("control.run.failed", { cause: "old lifecycle" })
        record("control.engine.projection-gap", {
          executionId: projectedRun,
          generation: 1,
          reason: "rewound",
          afterSequence: 0
        })
        record("control.run.resume", { runId: projectedRun })
        schedule(0, "replayed-old")
        const rewound = observe()
        expect(rewound.currentNode).toBeUndefined()
        expect(rewound.currentNodeUnavailable).toBe(true)
        schedule(1, "new-generation")
        const fresh = observe()
        expect(fresh.currentNode).toBe("new-generation")
        expect(fresh.read).toContain(projectedRun)
        record("control.run.failed", { cause: "second lifecycle" })
        schedule(1, "delayed-old")
        record("control.run.resumed", { runId: projectedRun })
        expect(observe().currentNodeUnavailable).toBe(true)
        schedule(1, "resumed-action")
        expect(observe().currentNode).toBe("resumed-action")
        const humanProjection = launch(cwd, ["runs", "show", projectedRun, "--audience", "human", "--ui", "plain"])
        expect(humanProjection.status, humanProjection.stderr).toBe(0)
        expect(humanProjection.stdout).toContain("smthrs runs show")
        expect(humanProjection.stdout).not.toMatch(/\u001b\]|\u001b\[2J|\u0007/u)
      } finally {
        projected.close()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
