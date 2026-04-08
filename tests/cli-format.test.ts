import { describe, expect, test } from "bun:test";
import {
  colorizeEventText,
  formatAge,
  formatElapsedCompact,
  formatTimestamp,
  formatRelativeOffset,
  formatEventLine,
} from "../src/cli/format";

describe("formatAge", () => {
  test("returns 'just now' for future timestamps", () => {
    expect(formatAge(Date.now() + 10_000)).toBe("just now");
  });

  test("formats seconds", () => {
    const result = formatAge(Date.now() - 30_000);
    expect(result).toMatch(/^\d+s ago$/);
  });

  test("formats minutes", () => {
    const result = formatAge(Date.now() - 5 * 60 * 1000);
    expect(result).toMatch(/^\d+m ago$/);
  });

  test("formats hours", () => {
    const result = formatAge(Date.now() - 3 * 60 * 60 * 1000);
    expect(result).toMatch(/^\d+h ago$/);
  });

  test("formats days", () => {
    const result = formatAge(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(result).toMatch(/^\d+d ago$/);
  });

  test("boundary: 59 seconds stays in seconds", () => {
    const result = formatAge(Date.now() - 59_000);
    expect(result).toMatch(/^\d+s ago$/);
  });

  test("boundary: 60 seconds becomes minutes", () => {
    const result = formatAge(Date.now() - 60_000);
    expect(result).toBe("1m ago");
  });
});

describe("formatElapsedCompact", () => {
  test("formats seconds only", () => {
    expect(formatElapsedCompact(0, 45_000)).toBe("45s");
  });

  test("formats minutes and seconds", () => {
    expect(formatElapsedCompact(0, 125_000)).toBe("2m 5s");
  });

  test("formats hours and minutes", () => {
    expect(formatElapsedCompact(0, 3_723_000)).toBe("1h 2m");
  });

  test("uses Date.now() when endMs omitted", () => {
    const start = Date.now() - 5_000;
    const result = formatElapsedCompact(start);
    expect(result).toMatch(/^\d+s$/);
  });

  test("zero elapsed", () => {
    expect(formatElapsedCompact(1000, 1000)).toBe("0s");
  });
});

describe("formatTimestamp", () => {
  test("formats elapsed as HH:MM:SS", () => {
    const base = 0;
    const event = 3_661_000; // 1h 1m 1s
    expect(formatTimestamp(base, event)).toBe("01:01:01");
  });

  test("pads single digits", () => {
    expect(formatTimestamp(0, 5_000)).toBe("00:00:05");
  });

  test("handles zero elapsed", () => {
    expect(formatTimestamp(1000, 1000)).toBe("00:00:00");
  });

  test("handles large elapsed", () => {
    expect(formatTimestamp(0, 100 * 3600 * 1000)).toBe("100:00:00");
  });
});

describe("formatRelativeOffset", () => {
  test("formats minute/second offsets with millis", () => {
    expect(formatRelativeOffset(1_000, 3_341)).toBe("+00:02.341");
  });

  test("formats hour offsets with millis", () => {
    expect(formatRelativeOffset(0, 3_723_004)).toBe("+01:02:03.004");
  });
});

describe("colorizeEventText", () => {
  test("applies ANSI color codes for terminal output", () => {
    const prevNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const finished = colorizeEventText("RunFinished", "RunFinished");
      const failed = colorizeEventText("NodeFailed", "NodeFailed");
      expect(finished).toContain("\u001b[");
      expect(failed).toContain("\u001b[");
      expect(finished).not.toBe(failed);
    } finally {
      if (prevNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = prevNoColor;
      }
    }
  });
});

describe("formatEventLine", () => {
  const base = 1000;

  test("formats NodeStarted", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "NodeStarted", payloadJson: JSON.stringify({ nodeId: "task-1", attempt: 2, iteration: 1 }) },
      base,
    );
    expect(line).toContain("→ task-1");
    expect(line).toContain("attempt 2");
    expect(line).toContain("iteration 1");
  });

  test("formats NodeFinished", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "NodeFinished", payloadJson: JSON.stringify({ nodeId: "task-1", attempt: 1 }) },
      base,
    );
    expect(line).toContain("✓ task-1");
  });

  test("formats NodeFailed with error", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "NodeFailed", payloadJson: JSON.stringify({ nodeId: "task-1", error: "timeout" }) },
      base,
    );
    expect(line).toContain("✗ task-1");
    expect(line).toContain("timeout");
  });

  test("formats NodeRetrying", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "NodeRetrying", payloadJson: JSON.stringify({ nodeId: "task-1", attempt: 3 }) },
      base,
    );
    expect(line).toContain("↻ task-1");
    expect(line).toContain("attempt 3");
  });

  test("formats RunFinished", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "RunFinished", payloadJson: "{}" },
      base,
    );
    expect(line).toContain("✓ Run finished");
  });

  test("formats RunFailed", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "RunFailed", payloadJson: JSON.stringify({ error: "boom" }) },
      base,
    );
    expect(line).toContain("✗ Run failed: boom");
  });

  test("formats RunCancelled", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "RunCancelled", payloadJson: "{}" },
      base,
    );
    expect(line).toContain("⊘ Run cancelled");
  });

  test("formats ApprovalRequested", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "ApprovalRequested", payloadJson: JSON.stringify({ nodeId: "gate-1" }) },
      base,
    );
    expect(line).toContain("⏸ Approval requested: gate-1");
  });

  test("formats ApprovalGranted", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "ApprovalGranted", payloadJson: JSON.stringify({ nodeId: "gate-1" }) },
      base,
    );
    expect(line).toContain("✓ Approved: gate-1");
  });

  test("formats ApprovalAutoApproved", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "ApprovalAutoApproved", payloadJson: JSON.stringify({ nodeId: "gate-1" }) },
      base,
    );
    expect(line).toContain("✓ Auto-approved: gate-1");
  });

  test("formats ApprovalDenied", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "ApprovalDenied", payloadJson: JSON.stringify({ nodeId: "gate-1" }) },
      base,
    );
    expect(line).toContain("✗ Denied: gate-1");
  });

  test("formats RunHijacked conversation mode", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "RunHijacked", payloadJson: JSON.stringify({ mode: "conversation", engine: "claude" }) },
      base,
    );
    expect(line).toContain("⇢ Hijacked claude conversation");
  });

  test("formats RunHijacked session mode", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "RunHijacked", payloadJson: JSON.stringify({ mode: "session", engine: "pi", resume: "abc" }) },
      base,
    );
    expect(line).toContain("⇢ Hijacked pi session abc");
  });

  test("formats WorkflowReloadDetected", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "WorkflowReloadDetected", payloadJson: "{}" },
      base,
    );
    expect(line).toContain("⟳ File change detected");
  });

  test("formats AgentEvent", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "AgentEvent", payloadJson: JSON.stringify({ engine: "codex", event: { type: "tool_call" } }) },
      base,
    );
    expect(line).toContain("codex: tool_call");
  });

  test("formats unknown event type", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "CustomEvent", payloadJson: "{}" },
      base,
    );
    expect(line).toContain("CustomEvent");
  });

  test("truncates large payloads for unknown event types", () => {
    const line = formatEventLine(
      {
        timestampMs: 2000,
        type: "CustomEvent",
        payloadJson: JSON.stringify({ text: "x".repeat(400) }),
      },
      base,
      { truncatePayloadAt: 80 },
    );
    expect(line).toContain("...");
  });

  test("handles invalid JSON in payload", () => {
    const line = formatEventLine(
      { timestampMs: 2000, type: "NodeStarted", payloadJson: "not-json" },
      base,
    );
    expect(line).toContain("?"); // Falls back to payload.nodeId ?? "?"
  });

  test("includes timestamp prefix", () => {
    const line = formatEventLine(
      { timestampMs: 1000 + 61_000, type: "RunFinished", payloadJson: "{}" },
      1000,
    );
    expect(line).toMatch(/^\[00:01:01\]/);
  });
});
