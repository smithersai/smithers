import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import {
  smithersRuns,
  smithersNodes,
  smithersAttempts,
  smithersFrames,
  smithersApprovals,
  smithersCache,
  smithersToolCalls,
  smithersEvents,
  smithersRalph,
  smithersCron,
  smithersScorers,
} from "../src/db/internal-schema";

describe("internal schema table definitions", () => {
  test("smithersRuns table name is _smithers_runs", () => {
    expect(getTableName(smithersRuns)).toBe("_smithers_runs");
  });

  test("smithersNodes table name is _smithers_nodes", () => {
    expect(getTableName(smithersNodes)).toBe("_smithers_nodes");
  });

  test("smithersAttempts table name is _smithers_attempts", () => {
    expect(getTableName(smithersAttempts)).toBe("_smithers_attempts");
  });

  test("smithersFrames table name is _smithers_frames", () => {
    expect(getTableName(smithersFrames)).toBe("_smithers_frames");
  });

  test("smithersApprovals table name is _smithers_approvals", () => {
    expect(getTableName(smithersApprovals)).toBe("_smithers_approvals");
  });

  test("smithersCache table name is _smithers_cache", () => {
    expect(getTableName(smithersCache)).toBe("_smithers_cache");
  });

  test("smithersToolCalls table name is _smithers_tool_calls", () => {
    expect(getTableName(smithersToolCalls)).toBe("_smithers_tool_calls");
  });

  test("smithersEvents table name is _smithers_events", () => {
    expect(getTableName(smithersEvents)).toBe("_smithers_events");
  });

  test("smithersRalph table name is _smithers_ralph", () => {
    expect(getTableName(smithersRalph)).toBe("_smithers_ralph");
  });

  test("smithersCron table name is _smithers_cron", () => {
    expect(getTableName(smithersCron)).toBe("_smithers_cron");
  });

  test("smithersScorers table name is _smithers_scorers", () => {
    expect(getTableName(smithersScorers)).toBe("_smithers_scorers");
  });

  test("smithersRuns has expected columns", () => {
    const cols = Object.keys(smithersRuns);
    expect(cols).toContain("runId");
    expect(cols).toContain("workflowName");
    expect(cols).toContain("status");
    expect(cols).toContain("createdAtMs");
  });

  test("smithersNodes has composite key columns", () => {
    const cols = Object.keys(smithersNodes);
    expect(cols).toContain("runId");
    expect(cols).toContain("nodeId");
    expect(cols).toContain("iteration");
    expect(cols).toContain("state");
  });

  test("smithersAttempts has composite key columns", () => {
    const cols = Object.keys(smithersAttempts);
    expect(cols).toContain("runId");
    expect(cols).toContain("nodeId");
    expect(cols).toContain("iteration");
    expect(cols).toContain("attempt");
    expect(cols).toContain("state");
  });

  test("smithersAttempts has jj columns", () => {
    const cols = Object.keys(smithersAttempts);
    expect(cols).toContain("jjPointer");
    expect(cols).toContain("jjCwd");
  });

  test("smithersFrames has xml and hash columns", () => {
    const cols = Object.keys(smithersFrames);
    expect(cols).toContain("xmlJson");
    expect(cols).toContain("xmlHash");
    expect(cols).toContain("frameNo");
  });

  test("smithersApprovals has approval-specific columns", () => {
    const cols = Object.keys(smithersApprovals);
    expect(cols).toContain("status");
    expect(cols).toContain("requestedAtMs");
    expect(cols).toContain("decidedAtMs");
    expect(cols).toContain("note");
    expect(cols).toContain("decidedBy");
  });

  test("smithersEvents has event columns", () => {
    const cols = Object.keys(smithersEvents);
    expect(cols).toContain("runId");
    expect(cols).toContain("seq");
    expect(cols).toContain("timestampMs");
    expect(cols).toContain("type");
    expect(cols).toContain("payloadJson");
  });

  test("smithersScorers has scorer columns", () => {
    const cols = Object.keys(smithersScorers);
    expect(cols).toContain("scorerId");
    expect(cols).toContain("scorerName");
    expect(cols).toContain("score");
    expect(cols).toContain("reason");
  });

  test("smithersCron has cron columns", () => {
    const cols = Object.keys(smithersCron);
    expect(cols).toContain("cronId");
    expect(cols).toContain("pattern");
    expect(cols).toContain("workflowPath");
    expect(cols).toContain("enabled");
  });
});
