/** @since 0.1.0 */
import { JournalEvent } from "@smthrs/journal"
import { ModelEvent, ModelRequest } from "@smthrs/model"
import * as AgentEvent from "../../src/AgentEvent.vibe"

const runId = "run-1" as JournalEvent.RunId
const sourceId = "fixture" as JournalEvent.SourceId

/** @category testing @since 0.1.0 */
export const entry = (seq: number, eventType: string, payload: unknown): JournalEvent.Entry =>
  new JournalEvent.Entry({
    runId,
    seq: seq as JournalEvent.Seq,
    eventId: `event-${seq}`,
    sourceId,
    sourceSeq: seq as JournalEvent.SourceSeq,
    emittedAtMs: seq,
    eventType,
    payload,
    meta: {}
  })

/** @category testing @since 0.1.0 */
export const journal = (): ReadonlyArray<JournalEvent.Entry> => [
  entry(
    1,
    "flows.harness.model-settled.v1",
    new AgentEvent.ModelSettled({
      eventType: "flows.harness.model-settled.v1",
      message: ModelRequest.Message.assistant("first", { stopReason: "tool-calls" }),
      usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
    })
  ),
  entry(2, "grant", { capability: "fs:read" }),
  entry(4, "telemetry", { latencyMs: 3 }),
  entry(
    5,
    "flows.harness.steering-drained.v1",
    new AgentEvent.SteeringDrained({
      eventType: "flows.harness.steering-drained.v1",
      messages: [ModelRequest.Message.user("continue carefully")]
    })
  ),
  entry(
    6,
    "flows.harness.model-settled.v1",
    new AgentEvent.ModelSettled({
      eventType: "flows.harness.model-settled.v1",
      message: ModelRequest.Message.assistant("second", { stopReason: "tool-calls" }),
      usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
    })
  ),
  entry(
    8,
    "flows.harness.compaction-settled.v1",
    new AgentEvent.CompactionSettled({
      eventType: "flows.harness.compaction-settled.v1",
      replacedPrefixDigest: "prefix-digest",
      summary: ModelRequest.Message.user("First turn summary")
    })
  ),
  entry(
    9,
    "flows.harness.model-settled.v1",
    new AgentEvent.ModelSettled({
      eventType: "flows.harness.model-settled.v1",
      message: ModelRequest.Message.assistant("third", { stopReason: "stop" }),
      usage: ModelEvent.Usage.make({ inputTokens: 1, outputTokens: 1 })
    })
  )
]
