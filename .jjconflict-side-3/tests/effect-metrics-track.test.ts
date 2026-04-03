import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { trackEvent } from "../src/effect/metrics";

// trackEvent returns an Effect — we test that it produces an Effect for each event type
// without throwing, and that the returned effect is well-formed.

function runTrack(event: any) {
  return Effect.runPromise(trackEvent(event));
}

describe("trackEvent", () => {
  test("handles RunStarted event", async () => {
    await runTrack({
      type: "RunStarted",
      runId: "run-1",
      timestampMs: Date.now(),
    });
  });

  test("handles RunFinished event", async () => {
    await runTrack({
      type: "RunFinished",
      runId: "run-1",
      timestampMs: Date.now(),
    });
  });

  test("handles RunFailed event", async () => {
    await runTrack({
      type: "RunFailed",
      runId: "run-1",
      timestampMs: Date.now(),
      error: "boom",
    });
  });

  test("handles RunCancelled event", async () => {
    await runTrack({
      type: "RunCancelled",
      runId: "run-1",
      timestampMs: Date.now(),
    });
  });

  test("handles NodeStarted event", async () => {
    await runTrack({
      type: "NodeStarted",
      runId: "run-1",
      nodeId: "node-1",
      iteration: 0,
      timestampMs: Date.now(),
    });
  });

  test("handles NodeFinished event", async () => {
    await runTrack({
      type: "NodeFinished",
      runId: "run-1",
      nodeId: "node-1",
      iteration: 0,
      timestampMs: Date.now(),
    });
  });

  test("handles NodeFailed event", async () => {
    await runTrack({
      type: "NodeFailed",
      runId: "run-1",
      nodeId: "node-1",
      iteration: 0,
      timestampMs: Date.now(),
      error: "fail",
    });
  });

  test("handles NodeRetrying event", async () => {
    await runTrack({
      type: "NodeRetrying",
      runId: "run-1",
      nodeId: "node-1",
      iteration: 0,
      attempt: 2,
      timestampMs: Date.now(),
    });
  });

  test("handles ToolCallStarted event", async () => {
    await runTrack({
      type: "ToolCallStarted",
      runId: "run-1",
      nodeId: "node-1",
      toolName: "bash",
      timestampMs: Date.now(),
    });
  });

  test("handles ToolCallFinished with success", async () => {
    await runTrack({
      type: "ToolCallFinished",
      runId: "run-1",
      nodeId: "node-1",
      toolName: "bash",
      status: "success",
      timestampMs: Date.now(),
    });
  });

  test("handles ToolCallFinished with error", async () => {
    await runTrack({
      type: "ToolCallFinished",
      runId: "run-1",
      nodeId: "node-1",
      toolName: "bash",
      status: "error",
      timestampMs: Date.now(),
    });
  });

  test("handles ApprovalRequested event", async () => {
    await runTrack({
      type: "ApprovalRequested",
      runId: "run-1",
      nodeId: "node-1",
      iteration: 0,
      timestampMs: Date.now(),
    });
  });

  test("handles ApprovalGranted event", async () => {
    await runTrack({
      type: "ApprovalGranted",
      runId: "run-1",
      nodeId: "node-1",
      iteration: 0,
      timestampMs: Date.now(),
    });
  });

  test("handles ApprovalDenied event", async () => {
    await runTrack({
      type: "ApprovalDenied",
      runId: "run-1",
      nodeId: "node-1",
      iteration: 0,
      timestampMs: Date.now(),
    });
  });

  test("handles TokenUsageReported with model and agent tags", async () => {
    await runTrack({
      type: "TokenUsageReported",
      runId: "run-1",
      nodeId: "node-1",
      model: "claude-sonnet-4-20250514",
      agent: "claude-code",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 20,
      timestampMs: Date.now(),
    });
  });

  test("handles TokenUsageReported with zero tokens (no metric updates)", async () => {
    await runTrack({
      type: "TokenUsageReported",
      runId: "run-1",
      nodeId: "node-1",
      model: "unknown",
      agent: "unknown",
      inputTokens: 0,
      outputTokens: 0,
      timestampMs: Date.now(),
    });
  });

  test("handles ScorerStarted event", async () => {
    await runTrack({
      type: "ScorerStarted",
      runId: "run-1",
      scorerId: "s1",
      timestampMs: Date.now(),
    });
  });

  test("handles ScorerFinished event", async () => {
    await runTrack({
      type: "ScorerFinished",
      runId: "run-1",
      scorerId: "s1",
      score: 0.9,
      timestampMs: Date.now(),
    });
  });

  test("handles ScorerFailed event", async () => {
    await runTrack({
      type: "ScorerFailed",
      runId: "run-1",
      scorerId: "s1",
      error: "scorer crash",
      timestampMs: Date.now(),
    });
  });

  test("handles VoiceStarted event", async () => {
    await runTrack({
      type: "VoiceStarted",
      runId: "run-1",
      timestampMs: Date.now(),
    });
  });

  test("handles VoiceFinished event", async () => {
    await runTrack({
      type: "VoiceFinished",
      runId: "run-1",
      durationMs: 5000,
      timestampMs: Date.now(),
    });
  });

  test("handles VoiceError event", async () => {
    await runTrack({
      type: "VoiceError",
      runId: "run-1",
      error: "mic failure",
      timestampMs: Date.now(),
    });
  });

  test("handles McpToolCalled success event", async () => {
    await runTrack({
      type: "McpToolCalled",
      runId: "run-1",
      toolName: "list-files",
      status: "success",
      durationMs: 42,
      timestampMs: Date.now(),
    });
  });

  test("handles McpToolCalled error event", async () => {
    await runTrack({
      type: "McpToolCalled",
      runId: "run-1",
      toolName: "list-files",
      status: "error",
      durationMs: 42,
      timestampMs: Date.now(),
    });
  });

  test("handles OpenApiToolCalled success event", async () => {
    await runTrack({
      type: "OpenApiToolCalled",
      runId: "run-1",
      toolName: "get-user",
      status: "success",
      durationMs: 100,
      timestampMs: Date.now(),
    });
  });

  test("handles OpenApiToolCalled error event", async () => {
    await runTrack({
      type: "OpenApiToolCalled",
      runId: "run-1",
      toolName: "get-user",
      status: "error",
      durationMs: 100,
      timestampMs: Date.now(),
    });
  });

  test("handles RagIngested event", async () => {
    await runTrack({
      type: "RagIngested",
      runId: "run-1",
      documentCount: 5,
      timestampMs: Date.now(),
    });
  });

  test("handles RagRetrieved event", async () => {
    await runTrack({
      type: "RagRetrieved",
      runId: "run-1",
      resultCount: 3,
      timestampMs: Date.now(),
    });
  });

  test("handles MemoryFactSet event", async () => {
    await runTrack({
      type: "MemoryFactSet",
      runId: "run-1",
      key: "user-name",
      timestampMs: Date.now(),
    });
  });

  test("handles MemoryRecalled event", async () => {
    await runTrack({
      type: "MemoryRecalled",
      runId: "run-1",
      query: "user preferences",
      timestampMs: Date.now(),
    });
  });

  test("handles MemoryMessageSaved event", async () => {
    await runTrack({
      type: "MemoryMessageSaved",
      runId: "run-1",
      timestampMs: Date.now(),
    });
  });

  test("handles unknown event type gracefully (just counts)", async () => {
    await runTrack({
      type: "SomeFutureEvent",
      timestampMs: Date.now(),
    });
  });

  test("handles SnapshotCaptured event", async () => {
    await runTrack({
      type: "SnapshotCaptured",
      runId: "run-1",
      frameNo: 3,
      timestampMs: Date.now(),
    });
  });

  test("handles McpServerStarted event", async () => {
    await runTrack({
      type: "McpServerStarted",
      runId: "run-1",
      timestampMs: Date.now(),
    });
  });

  test("handles McpServerStopped event", async () => {
    await runTrack({
      type: "McpServerStopped",
      runId: "run-1",
      timestampMs: Date.now(),
    });
  });
});
