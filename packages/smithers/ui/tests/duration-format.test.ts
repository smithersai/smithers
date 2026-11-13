import { expect, test } from "bun:test";
import fc from "fast-check";
import { formatDuration } from "../src/internal/formatDuration";

test("whole-second formatting preserves rounded elapsed time across minute boundaries", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 3_600_000 }), (milliseconds) => {
    const seconds = Math.round(milliseconds / 1000);
    const label = formatDuration(milliseconds / 1000);
    if (seconds < 60) expect(label).toBe(`${seconds}s`);
    else {
      const match = /^(\d+)m (\d{2})s$/.exec(label)!;
      expect(match).not.toBeNull();
      expect(Number(match[2])).toBeLessThan(60);
      expect(Number(match[1]) * 60 + Number(match[2])).toBe(seconds);
    }
  }), { seed: 5008, numRuns: 500 });
});

test("millisecond precision never emits an overflowing unit", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 3_600_000 }), (tenthsOfMs) => {
    const label = formatDuration(tenthsOfMs / 10_000, "milliseconds");
    if (label.endsWith("ms")) expect(Number.parseInt(label)).toBeLessThan(1000);
    else if (label.includes("m ")) expect(Number(label.split("m ")[1]!.slice(0, -1))).toBeLessThan(60);
    else expect(Number.parseFloat(label)).toBeLessThan(60);
  }), { seed: 5008, numRuns: 500 });
});

