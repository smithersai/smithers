import { describe, expect, test } from "bun:test";
import type { TaskDescriptor } from "../src/TaskDescriptor";
import { EventBus } from "../src/events";
import { executeTaskBridge } from "../src/effect/workflow-bridge";

const makeTaskDescriptor = (
  overrides: Partial<TaskDescriptor> = {},
): TaskDescriptor => ({
  nodeId: "bridge-task",
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
});

const toolConfig = {
  rootDir: "/tmp",
  allowNetwork: false,
  maxOutputBytes: 1_000_000,
  toolTimeoutMs: 1_000,
};

const makeAdapter = (listAttempts: () => any[]) =>
  ({
    listAttempts: async () => listAttempts(),
  }) as any;

const executeBridge = (
  adapter: any,
  runId: string,
  desc: TaskDescriptor,
  legacyExecuteTaskFn?: any,
  options: { signal?: AbortSignal } = {},
) =>
  executeTaskBridge(
    adapter,
    {},
    runId,
    desc,
    new Map<string, TaskDescriptor>(),
    null,
    new EventBus({}),
    toolConfig,
    "bridge-contract",
    false,
    options.signal,
    undefined,
    undefined,
    undefined,
    legacyExecuteTaskFn,
  );

describe("executeTaskBridge", () => {
  test("deduplicates concurrent executions and replays for the same bridge key", async () => {
    const desc = makeTaskDescriptor({ nodeId: "dedupe-task" });
    const adapter = makeAdapter(() => [{ attempt: 1, state: "finished" }]);
    let calls = 0;

    const legacyExecuteTaskFn = async () => {
      calls += 1;
      await Bun.sleep(25);
    };

    const first = executeBridge(adapter, "run-dedupe", desc, legacyExecuteTaskFn);
    const second = executeBridge(adapter, "run-dedupe", desc, legacyExecuteTaskFn);

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(calls).toBe(1);

    await executeBridge(adapter, "run-dedupe", desc, legacyExecuteTaskFn);
    expect(calls).toBe(1);

    await executeBridge(adapter, "run-dedupe-2", desc, legacyExecuteTaskFn);
    expect(calls).toBe(2);
  });

  test("retries when the latest attempt is still marked failed and budget remains", async () => {
    const desc = makeTaskDescriptor({ nodeId: "retry-task", retries: 1 });
    let calls = 0;
    const adapter = makeAdapter(() => {
      if (calls === 1) {
        return [{ attempt: 1, state: "failed" }];
      }
      return [
        { attempt: 2, state: "finished" },
        { attempt: 1, state: "failed" },
      ];
    });

    const legacyExecuteTaskFn = async () => {
      calls += 1;
    };

    await expect(
      executeBridge(adapter, "run-retry", desc, legacyExecuteTaskFn),
    ).resolves.toBeUndefined();
    await expect(
      executeBridge(adapter, "run-retry", desc, legacyExecuteTaskFn),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  test("resolves after retries are exhausted and leaves failure classification to the caller", async () => {
    const desc = makeTaskDescriptor({ nodeId: "exhausted-task", retries: 1 });
    let calls = 0;
    const adapter = makeAdapter(() => {
      if (calls === 1) {
        return [{ attempt: 1, state: "failed" }];
      }
      return [
        { attempt: 2, state: "failed" },
        { attempt: 1, state: "failed" },
      ];
    });

    const legacyExecuteTaskFn = async () => {
      calls += 1;
    };

    await expect(
      executeBridge(adapter, "run-exhausted", desc, legacyExecuteTaskFn),
    ).resolves.toBeUndefined();
    await expect(
      executeBridge(adapter, "run-exhausted", desc, legacyExecuteTaskFn),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  test("does not perform inline retry waits inside the bridge", async () => {
    const desc = makeTaskDescriptor({
      nodeId: "aborted-task",
      retries: 1,
      retryPolicy: { initialDelayMs: 1_000, backoff: "fixed" },
    });
    let calls = 0;
    const adapter = makeAdapter(() => [{ attempt: 1, state: "failed" }]);

    const legacyExecuteTaskFn = async () => {
      calls += 1;
    };

    await expect(
      executeBridge(adapter, "run-abort", desc, legacyExecuteTaskFn),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  test("rejects when no legacy executor is provided", async () => {
    const desc = makeTaskDescriptor({ nodeId: "missing-legacy-task" });
    const adapter = makeAdapter(() => []);

    await expect(executeBridge(adapter, "run-missing-legacy", desc)).rejects.toThrow(
      "legacyExecuteTaskFn must be provided",
    );
  });
});
