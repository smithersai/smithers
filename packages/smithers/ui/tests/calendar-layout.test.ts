import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { layoutTimedEvents } from "../src/calendar/layoutTimedEvents";
import type { CalendarEvent } from "../src/calendar/types";

const DAY = new Date(2026, 6, 27).getTime();
const at = (minute: number) => DAY + minute * 60_000;
const event = (id: string, start: number, end?: number): CalendarEvent => ({
  id, title: id, start: at(start), ...(end === undefined ? {} : { end: at(end) }),
});

describe("week event packing", () => {
  test("reuses free columns across chained overlaps and resets after a group", () => {
    const result = layoutTimedEvents([
      event("long", 540, 720), event("first", 540, 600), event("next", 600, 660),
      event("third", 630, 690), event("separate", 720, 750),
    ], DAY);
    expect(result.map(({ event, column, columns }) => [event.id, column, columns])).toEqual([
      ["first", 0, 3], ["long", 1, 3], ["next", 0, 3], ["third", 2, 3], ["separate", 0, 1],
    ]);
  });

  test("packs snapped rectangles even when raw intervals do not overlap", () => {
    const result = layoutTimedEvents([event("first", 541, 549), event("second", 551, 559)], DAY);
    expect(result.map(({ startMin, endMin, column, columns }) => [startMin, endMin, column, columns]))
      .toEqual([[540, 570, 0, 2], [540, 570, 1, 2]]);
  });

  test("ignores all-day and off-day events and packs an overnight segment", () => {
    const result = layoutTimedEvents([
      { ...event("all-day", 540), allDay: true }, event("off-day", 1500, 1530),
      event("overnight", -60, 60), event("early", 30, 90), event("default-length", 120),
    ], DAY);
    expect(result.map(({ event }) => event.id)).toEqual(["overnight", "early", "default-length"]);
    expect(result[0]!.segment.continuesBefore).toBe(true);
    expect(result[0]!.columns).toBe(2);
    expect(result[1]!.columns).toBe(2);
    expect(result[2]!.columns).toBe(1);
    expect(layoutTimedEvents([], DAY)).toEqual([]);
  });

  test("every generated overlap has separate columns without dropping events", () => {
    fc.assert(fc.property(fc.array(fc.record({
      start: fc.integer({ min: 0, max: 1400 }),
      duration: fc.integer({ min: 1, max: 600 }),
    }), { maxLength: 35 }), (input) => {
      const events = input.map(({ start, duration }, i) => event(String(i), start, Math.min(start + duration, 1440)));
      const layout = layoutTimedEvents(events, DAY);
      expect(layout.map(({ event }) => event.id).sort()).toEqual(events.map(({ id }) => id).sort());
      expect(layoutTimedEvents([...events].reverse(), DAY)).toEqual(layout);
      for (const item of layout) {
        expect(item.column).toBeGreaterThanOrEqual(0);
        expect(item.column).toBeLessThan(item.columns);
        for (const other of layout) {
          if (item === other || item.endMin <= other.startMin || other.endMin <= item.startMin) continue;
          expect(item.column).not.toBe(other.column);
          expect(item.columns).toBe(other.columns);
        }
      }
    }), { seed: 5008, numRuns: 250 });
  });
});

