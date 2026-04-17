import { describe, expect, test } from "bun:test";
import { DevToolsRunStore } from "../src/DevToolsRunStore.js";
import type { DevToolsEventBus } from "../src/DevToolsEventBus.ts";

type Listener = (event: unknown) => void;

function createFakeBus(): DevToolsEventBus & {
  emit: (event: unknown) => void;
  listenerCount: () => number;
} {
  const listeners: Listener[] = [];
  return {
    on(_event: "event", handler: Listener) {
      listeners.push(handler);
    },
    removeListener(_event: "event", handler: Listener) {
      const i = listeners.indexOf(handler);
      if (i >= 0) listeners.splice(i, 1);
    },
    emit(event: unknown) {
      for (const l of listeners.slice()) l(event);
    },
    listenerCount: () => listeners.length,
  };
}

describe("DevToolsRunStore event processing", () => {
  test("RunStarted initializes a run as running", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 1000,
    });
    const run = store.getRun("r1");
    expect(run).toBeDefined();
    expect(run?.status).toBe("running");
    expect(run?.startedAt).toBe(1000);
  });

  test("RunFinished/RunFailed/RunCancelled mark status and finishedAt", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 1,
    });
    store.processEngineEvent({
      type: "RunFinished",
      runId: "r1",
      timestampMs: 2,
    });
    expect(store.getRun("r1")?.status).toBe("finished");
    expect(store.getRun("r1")?.finishedAt).toBe(2);

    store.processEngineEvent({
      type: "RunStarted",
      runId: "r2",
      timestampMs: 1,
    });
    store.processEngineEvent({
      type: "RunFailed",
      runId: "r2",
      timestampMs: 3,
    });
    expect(store.getRun("r2")?.status).toBe("failed");
    expect(store.getRun("r2")?.finishedAt).toBe(3);

    store.processEngineEvent({
      type: "RunStarted",
      runId: "r3",
      timestampMs: 1,
    });
    store.processEngineEvent({
      type: "RunCancelled",
      runId: "r3",
      timestampMs: 4,
    });
    expect(store.getRun("r3")?.status).toBe("cancelled");
    expect(store.getRun("r3")?.finishedAt).toBe(4);
  });

  test("FrameCommitted updates frameNo on the run", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 1,
    });
    store.processEngineEvent({
      type: "FrameCommitted",
      runId: "r1",
      timestampMs: 2,
      frameNo: 7,
    });
    expect(store.getRun("r1")?.frameNo).toBe(7);
  });

  test("NodePending/Started/Finished track task lifecycle and attempts", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "n1", iteration: 0 };
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 0,
    });
    store.processEngineEvent({
      ...base,
      type: "NodePending",
      timestampMs: 1,
    });
    expect(store.getTaskState("r1", "n1")?.status).toBe("pending");

    store.processEngineEvent({
      ...base,
      type: "NodeStarted",
      timestampMs: 2,
      attempt: 1,
    });
    const started = store.getTaskState("r1", "n1");
    expect(started?.status).toBe("started");
    expect(started?.attempt).toBe(1);
    expect(started?.startedAt).toBe(2);

    store.processEngineEvent({
      ...base,
      type: "NodeFinished",
      timestampMs: 3,
      attempt: 1,
    });
    const finished = store.getTaskState("r1", "n1");
    expect(finished?.status).toBe("finished");
    expect(finished?.finishedAt).toBe(3);
  });

  test("NodeFailed captures error payload", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "NodeFailed",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
      attempt: 2,
      error: { message: "boom" },
    });
    const task = store.getTaskState("r1", "n1");
    expect(task?.status).toBe("failed");
    expect(task?.attempt).toBe(2);
    expect(task?.error).toEqual({ message: "boom" });
  });

  test("NodeRetrying increments attempt", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "NodeRetrying",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
      attempt: 2,
    });
    const task = store.getTaskState("r1", "n1");
    expect(task?.status).toBe("retrying");
    expect(task?.attempt).toBe(2);
  });

  test("NodeCancelled and NodeSkipped", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "NodeCancelled",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
    });
    expect(store.getTaskState("r1", "n1")?.status).toBe("cancelled");

    store.processEngineEvent({
      type: "NodeSkipped",
      runId: "r1",
      nodeId: "n2",
      iteration: 0,
      timestampMs: 1,
    });
    expect(store.getTaskState("r1", "n2")?.status).toBe("skipped");
  });

  test("NodeWaitingApproval raises run status", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 0,
    });
    store.processEngineEvent({
      type: "NodeWaitingApproval",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
    });
    expect(store.getRun("r1")?.status).toBe("waiting-approval");
    expect(store.getTaskState("r1", "n1")?.status).toBe("waiting-approval");
  });

  test("NodeWaitingEvent marks task only", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 0,
    });
    store.processEngineEvent({
      type: "NodeWaitingEvent",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
    });
    expect(store.getRun("r1")?.status).toBe("running");
    expect(store.getTaskState("r1", "n1")?.status).toBe("waiting-event");
  });

  test("NodeWaitingTimer raises run status", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 0,
    });
    store.processEngineEvent({
      type: "NodeWaitingTimer",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
    });
    expect(store.getRun("r1")?.status).toBe("waiting-timer");
    expect(store.getTaskState("r1", "n1")?.status).toBe("waiting-timer");
  });

  test("ToolCallStarted/Finished track tool calls with status", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "n1", iteration: 0 };
    store.processEngineEvent({
      ...base,
      type: "ToolCallStarted",
      timestampMs: 1,
      toolName: "search",
      seq: 1,
    });
    store.processEngineEvent({
      ...base,
      type: "ToolCallFinished",
      timestampMs: 2,
      toolName: "search",
      seq: 1,
      status: "success",
    });
    const task = store.getTaskState("r1", "n1");
    expect(task?.toolCalls).toHaveLength(1);
    expect(task?.toolCalls[0]?.name).toBe("search");
    expect(task?.toolCalls[0]?.status).toBe("success");
  });

  test("getTaskState with iteration returns exact iteration", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "NodeStarted",
      runId: "r1",
      nodeId: "loop-n",
      iteration: 0,
      timestampMs: 1,
      attempt: 1,
    });
    store.processEngineEvent({
      type: "NodeStarted",
      runId: "r1",
      nodeId: "loop-n",
      iteration: 1,
      timestampMs: 2,
      attempt: 1,
    });
    expect(store.getTaskState("r1", "loop-n", 0)?.iteration).toBe(0);
    expect(store.getTaskState("r1", "loop-n", 1)?.iteration).toBe(1);
  });

  test("ignores events without type or runId", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({ runId: "r1" });
    store.processEngineEvent({ type: "RunStarted" });
    store.processEngineEvent(null);
    expect(store.runs.size).toBe(0);
  });

  test("onEngineEvent callback fires for every event", () => {
    const received: unknown[] = [];
    const store = new DevToolsRunStore({
      onEngineEvent: (e) => received.push(e),
    });
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 1,
    });
    store.processEngineEvent({
      type: "RunFinished",
      runId: "r1",
      timestampMs: 2,
    });
    expect(received).toHaveLength(2);
  });

  test("attachEventBus forwards bus events", () => {
    const bus = createFakeBus();
    const store = new DevToolsRunStore();
    store.attachEventBus(bus);
    expect(bus.listenerCount()).toBe(1);
    bus.emit({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 1,
    });
    expect(store.getRun("r1")?.status).toBe("running");
  });

  test("detachEventBuses removes all listeners", () => {
    const bus = createFakeBus();
    const store = new DevToolsRunStore();
    store.attachEventBus(bus);
    store.detachEventBuses();
    expect(bus.listenerCount()).toBe(0);
    bus.emit({
      type: "RunStarted",
      runId: "r-after-detach",
      timestampMs: 1,
    });
    expect(store.getRun("r-after-detach")).toBeUndefined();
  });
});
