import { MetricBoundaries } from "effect";

export const durationBuckets = MetricBoundaries.exponential({
  start: 100,
  factor: 2,
  count: 12,
}); // ~100ms to ~200s

export const fastBuckets = MetricBoundaries.exponential({
  start: 1,
  factor: 2,
  count: 12,
}); // ~1ms to ~2s

export const toolBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

export const tokenBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 18,
}); // ~10 to ~1.3M tokens

export const contextWindowBuckets = MetricBoundaries.fromIterable([
  50_000,
  100_000,
  200_000,
  500_000,
  1_000_000,
]);

export const sizeBuckets = MetricBoundaries.exponential({
  start: 100,
  factor: 2,
  count: 16,
}); // ~100 bytes to ~3.2MB

export const carriedStateSizeBuckets = MetricBoundaries.exponential({
  start: 256,
  factor: 2,
  count: 17,
}); // ~256 bytes to ~16MB

export const ancestryDepthBuckets = MetricBoundaries.exponential({
  start: 1,
  factor: 2,
  count: 12,
}); // depth 1 to 2048
