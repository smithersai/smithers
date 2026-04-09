import { describe, expect, test } from "bun:test";
import { executeTaskActivity } from "../src/effect/activity-bridge";
import type { TaskDescriptor } from "../src/TaskDescriptor";

function makeTaskDescriptor(
  overrides: Partial<TaskDescriptor> = {},
): TaskDescriptor {
  return {
    nodeId: "replay-task",
    ordinal: 0,
    iteration: 0,
    outputTable: null,
    outputTableName: "out",
    needsApproval: false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    heartbeatTimeoutMs: null,
    continueOnFail: false,
    ...overrides,
  };
}

describe("workflow replay", () => {
  test("completed activities return cached results on replay", async () => {
    const adapter = {} as any;
    const desc = makeTaskDescriptor({ nodeId: "cached-activity" });
    let calls = 0;

    const first = await executeTaskActivity(
      adapter,
      "workflow-replay-contract",
      "run-1",
      desc,
      ({ attempt, idempotencyKey }) => {
        calls += 1;
        return {
          value: 42,
          attempt,
          idempotencyKey,
        };
      },
    );

    const replayed = await executeTaskActivity(
      adapter,
      "workflow-replay-contract",
      "run-1",
      desc,
      () => {
        calls += 1;
        return {
          value: 99,
        };
      },
    );

    const differentRun = await executeTaskActivity(
      adapter,
      "workflow-replay-contract",
      "run-2",
      desc,
      ({ attempt }) => {
        calls += 1;
        return {
          value: 7,
          attempt,
        };
      },
    );

    expect(replayed).toEqual(first);
    expect(differentRun).toEqual({
      value: 7,
      attempt: 1,
    });
    expect(calls).toBe(2);
  });
});
