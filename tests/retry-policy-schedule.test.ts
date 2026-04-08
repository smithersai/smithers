import { describe, expect, test } from "bun:test";
import { Chunk, Duration, Effect, Exit, Schedule, ScheduleDecision } from "effect";
import { computeRetryDelayMs, retryPolicyToSchedule } from "../src/utils/retry";

/**
 * Step through a schedule synchronously and collect the delay (in ms) for each iteration.
 * Uses Schedule.step directly to avoid the driver's async sleep behavior.
 */
function collectDelays(schedule: Schedule.Schedule<unknown>, count: number): number[] {
  const delays: number[] = [];
  let state = (schedule as any).initial;
  let now = 0;
  for (let i = 0; i < count; i++) {
    const [nextState, , decision] = Effect.runSync(
      (schedule as any).step(now, undefined, state),
    ) as [unknown, unknown, ScheduleDecision.ScheduleDecision];
    if (ScheduleDecision.isDone(decision)) break;
    const intervals = Chunk.toArray(decision.intervals.intervals);
    const delay = intervals[0]!.startMillis - now;
    delays.push(delay);
    state = nextState;
    now = intervals[0]!.startMillis;
  }
  return delays;
}

describe("retryPolicyToSchedule", () => {
  test("fixed backoff produces equal delays", () => {
    const schedule = retryPolicyToSchedule({ backoff: "fixed", initialDelayMs: 100 });
    const delays = collectDelays(schedule, 5);
    expect(delays).toHaveLength(5);
    for (const d of delays) {
      expect(d).toBe(100);
    }
  });

  test("linear backoff produces linearly increasing delays", () => {
    const schedule = retryPolicyToSchedule({ backoff: "linear", initialDelayMs: 50 });
    const delays = collectDelays(schedule, 5);
    expect(delays).toHaveLength(5);
    expect(delays[0]).toBe(50);
    expect(delays[1]).toBe(100);
    expect(delays[2]).toBe(150);
    expect(delays[3]).toBe(200);
    expect(delays[4]).toBe(250);
  });

  test("exponential backoff produces exponentially increasing delays", () => {
    const schedule = retryPolicyToSchedule({ backoff: "exponential", initialDelayMs: 25 });
    const delays = collectDelays(schedule, 5);
    expect(delays).toHaveLength(5);
    expect(delays[0]).toBe(25);
    expect(delays[1]).toBe(50);
    expect(delays[2]).toBe(100);
    expect(delays[3]).toBe(200);
    expect(delays[4]).toBe(400);
  });

  test("zero initialDelayMs returns a schedule that stops immediately", () => {
    const schedule = retryPolicyToSchedule({ backoff: "fixed", initialDelayMs: 0 });
    const delays = collectDelays(schedule, 1);
    expect(delays).toHaveLength(0);
  });

  test("undefined initialDelayMs returns a schedule that stops immediately", () => {
    const schedule = retryPolicyToSchedule({ backoff: "fixed" });
    const delays = collectDelays(schedule, 1);
    expect(delays).toHaveLength(0);
  });

  test("negative initialDelayMs returns a schedule that stops immediately", () => {
    const schedule = retryPolicyToSchedule({ backoff: "linear", initialDelayMs: -10 });
    const delays = collectDelays(schedule, 1);
    expect(delays).toHaveLength(0);
  });

  test("no backoff specified defaults to fixed", () => {
    const schedule = retryPolicyToSchedule({ initialDelayMs: 200 });
    const delays = collectDelays(schedule, 4);
    expect(delays).toHaveLength(4);
    for (const d of delays) {
      expect(d).toBe(200);
    }
  });

  test("fractional initialDelayMs is floored", () => {
    const schedule = retryPolicyToSchedule({ backoff: "fixed", initialDelayMs: 99.9 });
    const delays = collectDelays(schedule, 3);
    expect(delays).toHaveLength(3);
    for (const d of delays) {
      expect(d).toBe(99);
    }
  });

  test("computeRetryDelayMs caps exponential backoff at five minutes", () => {
    expect(
      computeRetryDelayMs(
        { backoff: "exponential", initialDelayMs: 1_000 },
        20,
      ),
    ).toBe(300_000);
  });
});
