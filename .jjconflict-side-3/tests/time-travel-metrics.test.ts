import { describe, expect, test } from "bun:test";
import { Effect, Metric, MetricState } from "effect";
import {
  snapshotsCaptured,
  runForksCreated,
  replaysStarted,
  snapshotDuration,
} from "../src/time-travel/metrics";

describe("time-travel metrics", () => {
  test("snapshotsCaptured is a counter metric", async () => {
    // Incrementing should not throw
    await Effect.runPromise(Metric.increment(snapshotsCaptured));
  });

  test("runForksCreated is a counter metric", async () => {
    await Effect.runPromise(Metric.increment(runForksCreated));
  });

  test("replaysStarted is a counter metric", async () => {
    await Effect.runPromise(Metric.increment(replaysStarted));
  });

  test("snapshotDuration is a histogram metric", async () => {
    // Should accept a duration value
    await Effect.runPromise(Metric.update(snapshotDuration, 42));
  });

  test("metrics can be updated multiple times", async () => {
    await Effect.runPromise(
      Effect.all([
        Metric.increment(snapshotsCaptured),
        Metric.increment(snapshotsCaptured),
        Metric.increment(runForksCreated),
        Metric.update(snapshotDuration, 10),
        Metric.update(snapshotDuration, 50),
      ]),
    );
  });
});
