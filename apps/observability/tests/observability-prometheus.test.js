import { describe, expect, test } from "bun:test";
import { Effect, Metric } from "effect";
import { externalWaitAsyncPending, renderPrometheusMetrics, prometheusContentType, rewindTotal, rewindDurationMs, rewindFramesDeleted, rewindSandboxesReverted, rewindRollbackTotal, } from "../src/index.js";
describe("renderPrometheusMetrics", () => {
    test("returns a string", () => {
        const result = renderPrometheusMetrics();
        expect(typeof result).toBe("string");
    });
    test("contains counter metrics for smithers", () => {
        // Increment a known counter so it appears in output
        Effect.runSync(Metric.increment(Metric.counter("smithers.test_prom.runs")));
        const result = renderPrometheusMetrics();
        expect(result).toContain("smithers");
    });
    test("formats with proper line endings", () => {
        const result = renderPrometheusMetrics();
        // Each line should end with \n
        if (result.length > 0) {
            expect(result.endsWith("\n")).toBe(true);
        }
    });
    test("includes TYPE annotations", () => {
        Effect.runSync(Metric.increment(Metric.counter("smithers.test_prom.typed")));
        const result = renderPrometheusMetrics();
        if (result.includes("smithers_test_prom_typed")) {
            expect(result).toContain("# TYPE");
        }
    });
    test("renders async external wait gauges with labels", () => {
        Effect.runSync(Metric.set(Metric.tagged(Metric.tagged(externalWaitAsyncPending, "kind", "event"), "case", "render"), 2));
        const result = renderPrometheusMetrics();
        expect(result).toContain('smithers_external_wait_async_pending{case="render",kind="event"} 2');
    });
    test("renders rewind metrics with underscore names (no dots)", () => {
        Effect.runSync(Effect.all([
            Metric.increment(Metric.tagged(rewindTotal, "result", "success")),
            Metric.update(rewindDurationMs, 42),
            Metric.update(rewindFramesDeleted, 3),
            Metric.update(rewindSandboxesReverted, 1),
            Metric.increment(rewindRollbackTotal),
        ]));
        const result = renderPrometheusMetrics();
        expect(result).toContain("smithers_rewind_total");
        expect(result).toContain("smithers_rewind_duration_ms");
        expect(result).toContain("smithers_rewind_frames_deleted");
        expect(result).toContain("smithers_rewind_sandboxes_reverted");
        expect(result).toContain("smithers_rewind_rollback_total");
        expect(result).not.toContain("smithers.rewind");
    });
    test("content type constant is correct", () => {
        expect(prometheusContentType).toBe("text/plain; version=0.0.4; charset=utf-8");
    });
});
