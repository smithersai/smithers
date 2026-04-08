import { describe, expect, test } from "bun:test";
import {
  eventCategoryForType,
  eventTypesForCategory,
  normalizeEventCategory,
} from "../src/cli/event-categories";

describe("event category mapping", () => {
  test("normalizes category aliases", () => {
    expect(normalizeEventCategory("tool")).toBe("tool-call");
    expect(normalizeEventCategory("tool_call")).toBe("tool-call");
    expect(normalizeEventCategory("approvals")).toBe("approval");
    expect(normalizeEventCategory("unknown")).toBeNull();
  });

  test("maps approval events to approval category", () => {
    const approvalTypes = eventTypesForCategory("approval");
    expect(approvalTypes).toContain("ApprovalRequested");
    expect(approvalTypes).toContain("ApprovalGranted");
    expect(approvalTypes).toContain("ApprovalAutoApproved");
    expect(approvalTypes).toContain("ApprovalDenied");
    expect(approvalTypes).toHaveLength(4);
  });

  test("maps runtime event types to categories", () => {
    expect(eventCategoryForType("RunStarted")).toBe("run");
    expect(eventCategoryForType("NodeFinished")).toBe("node");
    expect(eventCategoryForType("TaskHeartbeat")).toBe("node");
    expect(eventCategoryForType("ToolCallStarted")).toBe("tool-call");
    expect(eventCategoryForType("ScorerFailed")).toBe("scorer");
    expect(eventCategoryForType("NotARealEvent")).toBeNull();
  });
});
