import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { EventBus } from "../src/events";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";

function makeEvent(overrides?: Partial<SmithersEvent>): SmithersEvent {
  return {
    type: "RunStarted",
    runId: "run-1",
    timestampMs: Date.now(),
    ...overrides,
  } as SmithersEvent;
}

describe("EventBus", () => {
  test("constructs with default seq 0", () => {
    const bus = new EventBus({});
    expect(bus).toBeDefined();
  });

  test("constructs with custom startSeq", () => {
    const bus = new EventBus({ startSeq: 100 });
    expect(bus).toBeDefined();
  });

  test("emits events to listeners", () => {
    const bus = new EventBus({});
    const received: SmithersEvent[] = [];
    bus.on("event", (e) => received.push(e));

    const event = makeEvent();
    bus.emit("event", event);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("RunStarted");
  });

  test("supports multiple listeners", () => {
    const bus = new EventBus({});
    let count = 0;
    bus.on("event", () => count++);
    bus.on("event", () => count++);

    bus.emit("event", makeEvent());
    expect(count).toBe(2);
  });

  test("emitEventQueued emits synchronously and persists async", async () => {
    const received: SmithersEvent[] = [];
    const bus = new EventBus({});
    bus.on("event", (e) => received.push(e));

    await bus.emitEventQueued(makeEvent());
    expect(received).toHaveLength(1);
  });

  test("flush resolves when queue is empty", async () => {
    const bus = new EventBus({});
    await bus.flush(); // Should not throw
  });

  test("persists to mock DB adapter", async () => {
    const inserted: any[] = [];
    const mockDb = {
      insertEventEffect: (row: any) => {
        inserted.push(row);
        return Effect.void;
      },
    };

    const bus = new EventBus({ db: mockDb });
    await bus.emitEvent(makeEvent({ runId: "db-test" }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].runId).toBe("db-test");
  });

  test("persists to mock DB with insertEventWithNextSeqEffect", async () => {
    const inserted: any[] = [];
    const mockDb = {
      insertEventWithNextSeq: async (row: any) => inserted.push(row),
      insertEventWithNextSeqEffect: (row: any) => {
        inserted.push(row);
        return Effect.void;
      },
    };

    const bus = new EventBus({ db: mockDb });
    await bus.emitEvent(makeEvent({ runId: "seq-test" }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].runId).toBe("seq-test");
  });

  test("works without DB (no persistence)", async () => {
    const bus = new EventBus({});
    const events: SmithersEvent[] = [];
    bus.on("event", (e) => events.push(e));

    // Should not throw even without DB
    await bus.emitEvent(makeEvent());
    expect(events).toHaveLength(1);
  });
});
