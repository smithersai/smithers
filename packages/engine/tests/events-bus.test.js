import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { EventBus } from "../src/events.js";
import { renderPrometheusMetrics } from "@smithers/observability";
/**
 * @param {string} type
 * @param {any} [overrides]
 * @returns {SmithersEvent}
 */
function makeEvent(type, overrides = {}) {
    return {
        type,
        runId: "r1",
        timestampMs: Date.now(),
        ...overrides,
    };
}
/**
 * @param {string} name
 * @param {Record<string, string>} [labels]
 * @returns {number}
 */
function metricValue(name, labels) {
    const entries = Object.entries(labels ?? {}).sort(([left], [right]) => left.localeCompare(right));
    const suffix = entries.length === 0
        ? ""
        : `{${entries.map(([key, value]) => `${key}="${value}"`).join(",")}}`;
    const prefix = `${name}${suffix} `;
    const line = renderPrometheusMetrics()
        .split("\n")
        .find((entry) => entry.startsWith(prefix));
    if (!line)
        return 0;
    return Number(line.slice(prefix.length));
}
describe("EventBus", () => {
    test("emits events to listeners", async () => {
        const bus = new EventBus({});
        const received = [];
        bus.on("event", (e) => received.push(e));
        await Effect.runPromise(bus.emitEvent(makeEvent("RunStarted")));
        expect(received).toHaveLength(1);
        expect(received[0].type).toBe("RunStarted");
    });
    test("multiple listeners receive events", async () => {
        const bus = new EventBus({});
        const r1 = [];
        const r2 = [];
        bus.on("event", (e) => r1.push(e));
        bus.on("event", (e) => r2.push(e));
        await Effect.runPromise(bus.emitEvent(makeEvent("RunStarted")));
        expect(r1).toHaveLength(1);
        expect(r2).toHaveLength(1);
    });
    test("emitEventQueued emits synchronously", async () => {
        const bus = new EventBus({});
        const received = [];
        bus.on("event", (e) => received.push(e));
        await bus.emitEventQueued(makeEvent("NodeStarted"));
        expect(received).toHaveLength(1);
    });
    test("constructor accepts startSeq", () => {
        const bus = new EventBus({ startSeq: 10 });
        // Should not throw; internal seq starts at 10
        expect(bus).toBeDefined();
    });
    test("flush resolves after queued events", async () => {
        const bus = new EventBus({});
        await bus.emitEventQueued(makeEvent("RunStarted"));
        await bus.emitEventQueued(makeEvent("RunFinished"));
        // flush should not throw
        await Effect.runPromise(bus.flush());
    });
    test("persists events to db when provided", async () => {
        const inserted = [];
        const mockDb = {
            insertEventEffect: (row) => {
                inserted.push(row);
                const { Effect } = require("effect");
                return Effect.void;
            },
        };
        const bus = new EventBus({ db: mockDb });
        await Effect.runPromise(bus.emitEvent(makeEvent("RunStarted")));
        expect(inserted).toHaveLength(1);
        expect(inserted[0].type).toBe("RunStarted");
    });
    test("works without db (no persistence)", async () => {
        const bus = new EventBus({});
        // Should not throw
        await Effect.runPromise(bus.emitEvent(makeEvent("RunStarted")));
        await Effect.runPromise(bus.flush());
    });
    test("emitEventQueued tracks event-derived counters", async () => {
        const before = metricValue("smithers_tool_calls_total");
        const bus = new EventBus({});
        await bus.emitEventQueued(makeEvent("ToolCallStarted", {
            nodeId: "node",
            iteration: 0,
            attempt: 1,
            toolName: "bash",
            seq: 1,
        }));
        await Effect.runPromise(bus.flush());
        expect(metricValue("smithers_tool_calls_total")).toBe(before + 1);
    });
    test("emitEventWithPersist tracks token usage metrics", async () => {
        const labels = { agent: "test-agent", model: "test-model" };
        const beforeInput = metricValue("smithers_tokens_input_total", labels);
        const beforeOutput = metricValue("smithers_tokens_output_total", labels);
        const bus = new EventBus({});
        await Effect.runPromise(bus.emitEventWithPersist(makeEvent("TokenUsageReported", {
            nodeId: "node",
            iteration: 0,
            attempt: 1,
            model: labels.model,
            agent: labels.agent,
            inputTokens: 12,
            outputTokens: 7,
        })));
        expect(metricValue("smithers_tokens_input_total", labels)).toBe(beforeInput + 12);
        expect(metricValue("smithers_tokens_output_total", labels)).toBe(beforeOutput + 7);
    });
    test("emitEventWithPersist tracks context window usage buckets", async () => {
        const bus = new EventBus({});
        const cases = [
            { inputTokens: 49_999, bucket: "lt_50k" },
            { inputTokens: 50_000, bucket: "gte_50k_lt_100k" },
            { inputTokens: 100_000, bucket: "gte_100k_lt_200k" },
            { inputTokens: 200_000, bucket: "gte_200k_lt_500k" },
            { inputTokens: 500_000, bucket: "gte_500k_lt_1m" },
            { inputTokens: 1_000_000, bucket: "gte_1m" },
        ];
        for (const [index, testCase] of cases.entries()) {
            const labels = {
                agent: `context-agent-${index}`,
                model: `context-model-${index}`,
            };
            const bucketLabels = { ...labels, bucket: testCase.bucket };
            const beforeBucket = metricValue("smithers_tokens_context_window_bucket_total", bucketLabels);
            const beforeCount = metricValue("smithers_tokens_context_window_per_call_count", labels);
            const beforeSum = metricValue("smithers_tokens_context_window_per_call_sum", labels);
            await Effect.runPromise(bus.emitEventWithPersist(makeEvent("TokenUsageReported", {
                nodeId: `context-node-${index}`,
                iteration: 0,
                attempt: 1,
                model: labels.model,
                agent: labels.agent,
                inputTokens: testCase.inputTokens,
                outputTokens: 1,
            })));
            expect(metricValue("smithers_tokens_context_window_bucket_total", bucketLabels)).toBe(beforeBucket + 1);
            expect(metricValue("smithers_tokens_context_window_per_call_count", labels)).toBe(beforeCount + 1);
            expect(metricValue("smithers_tokens_context_window_per_call_sum", labels)).toBe(beforeSum + testCase.inputTokens);
        }
    });
});
