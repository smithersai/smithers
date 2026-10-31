import { expect, test } from "bun:test";
import {
  timelineBlockHeight, timelineBlocks, timelineBlockWindow, timelineCapacity, timelineExchanges, timelineLevelCount, timelineMarkHeight,
  timelineMarks, timelineRowWindow, timelineSearch, timelineToChat, timelineToRow, timelineWidths,
} from "../src/chat/timelineZoom";

const ids = (count: number) => Array.from({ length: count }, (_, index) => `e${index}`);

test("capacity follows the 34 px pitch, at least two", () => {
  expect(timelineCapacity(804)).toBe(23);
  expect(timelineCapacity(704)).toBe(20);
  for (const height of [0, -1, NaN, Infinity]) expect(timelineCapacity(height)).toBe(2);
});

test("a level appears only when the one inside it no longer fits", () => {
  expect(timelineLevelCount(0, 0, 804)).toBe(0);
  expect(timelineLevelCount(23, 0, 804)).toBe(1);
  expect(timelineLevelCount(24, 1, 804)).toBe(2);
  expect(timelineLevelCount(500, 23, 804)).toBe(2);
  expect(timelineLevelCount(500, 24, 804)).toBe(3);
});

test("blocks follow markers, not a stride, and cover every entry", () => {
  const blocks = timelineBlocks(ids(30), [
    { id: "b", start: "e4", title: "Fix" }, { id: "a", start: "e2", title: "Research", summary: "Why.", closed: true },
    { id: "gone", start: "nowhere", title: "Deleted" }, { id: "twin", start: "e4", title: "Same start" },
  ], 1);
  expect(blocks.map(({ id, start, end }) => [id, start, end])).toEqual([["a", 0, 4], ["b", 4, 30]]);
  expect(blocks[0]).toMatchObject({ title: "Research", summary: "Why.", closed: true });
  expect(timelineBlocks(ids(3), [], 2)).toEqual([{ id: "pending:2:e0", start: 0, end: 3 }]);
  expect(timelineBlocks([], [], 1)).toEqual([]);
});

test("an exchange is a question and what followed it", () => {
  expect(timelineExchanges([true, false, false, true, false])).toEqual([{ start: 0, end: 3 }, { start: 3, end: 5 }]);
  expect(timelineExchanges([false, true])).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
});

test("marks scale by length and by share", () => {
  expect(timelineMarkHeight(1)).toBe(6);
  expect(timelineMarkHeight(5000)).toBe(26);
  expect(timelineMarkHeight(120)).toBeGreaterThan(timelineMarkHeight(20));
  const marks = timelineMarks([{ weight: 1 }, { weight: 3 }], 23, 3);
  expect(marks.map(mark => [mark.y, mark.height])).toEqual([[0, 5], [8, 15]]);
  expect(timelineMarks([{ weight: 0 }], 10, 3)[0]!.height).toBe(1.5);
});

test("columns take the mock's widths at both windows", () => {
  expect(timelineWidths(1, 342)).toEqual({ widths: [200], gap: 20 });
  expect(timelineWidths(2, 342)).toEqual({ widths: [200, 92], gap: 20 });
  expect(timelineWidths(3, 342)).toEqual({ widths: [162, 78, 62], gap: 20 });
  expect(timelineWidths(3, 262)).toEqual({ widths: [132, 76, 18], gap: 18 });
});

const rows = (extra: Partial<Parameters<typeof timelineRowWindow>[0]>) => timelineRowWindow({
  count: 200, levels: 2, height: 816, first: 50, last: 52, reading: 51, ask: row => row % 2 === 0, blockStart: row => row, ...extra,
});

test("level 0 holds still while the viewport stays inside it, and pages when it leaves", () => {
  expect(rows({ levels: 1 })).toEqual({ start: 0, end: 200 });
  const page = rows({});
  expect(page.start % 2).toBe(0);
  expect(page.start).toBeLessThanOrEqual(50);
  expect(page.end).toBeGreaterThan(52);
  expect(page.end - page.start).toBeLessThanOrEqual(24);
  expect(rows({ current: { start: 40, end: 60 }, first: 45, last: 50 })).toEqual({ start: 40, end: 60 });
  expect(rows({ current: { start: 40, end: 60 }, first: 45, last: 50, force: true })).not.toEqual({ start: 40, end: 60 });
  expect(rows({ current: { start: 40, end: 60 }, first: 60, last: 62, reading: 61 }).start).toBeGreaterThan(40);
});

test("a page starts on its block when that still covers the screen, and always covers what's on screen", () => {
  expect(rows({ blockStart: () => 44 }).start).toBe(44);
  expect(rows({ blockStart: () => 0 }).start).toBeGreaterThan(0);
  const tall = rows({ first: 50, last: 90, reading: 70 });
  expect(tall.start).toBeLessThanOrEqual(90);
  expect(tall.end).toBeGreaterThan(rows({}).end);
  expect(rows({ reading: 199, first: 198, last: 199 }).end).toBe(200);
  expect(rows({ reading: 0, first: 1, last: 1 }).start).toBe(0);
  // Reading far below what's on screen: the page still starts at the first row shown.
  expect(rows({ reading: 180, first: 3, last: 4 }).start).toBeLessThanOrEqual(3);
  // A row that doesn't start an exchange ending the page keeps its exchange whole.
  expect(rows({ ask: () => true }).end % 1).toBe(0);
});

test("level 1's window holds, then pages around the blocks level 0 covers", () => {
  const blocks = (extra: Partial<Parameters<typeof timelineBlockWindow>[0]>) => timelineBlockWindow({ count: 60, levels: 3, height: 804, first: 30, last: 31, ...extra });
  expect(blocks({ levels: 2 })).toEqual({ start: 0, end: 60 });
  expect(blocks({ current: { start: 20, end: 43 }, first: 30, last: 31 })).toEqual({ start: 20, end: 43 });
  const page = blocks({});
  expect(page).toEqual({ start: 19, end: 42 });
  expect(blocks({ first: 0, last: 40 }).end).toBe(41);
  expect(blocks({ force: true, current: { start: 0, end: 5 } })).toEqual(page);
});

test("the transcript maps to rows and back, through gaps and unmounted rows", () => {
  const boxes = [{ row: 2, top: 100, bottom: 200 }, { row: 3, top: 220, bottom: 300 }, { row: 6, top: 400, bottom: 500 }];
  expect(timelineToRow([], 10)).toBe(0);
  expect(timelineToChat([], 10)).toBe(0);
  expect(timelineToRow(boxes, 0)).toBe(2);
  expect(timelineToRow(boxes, 150)).toBe(2.5);
  expect(timelineToRow(boxes, 210)).toBe(3);
  expect(timelineToRow(boxes, 350)).toBe(5);
  expect(timelineToRow(boxes, 900)).toBe(7);
  for (const row of [2.5, 3.25, 5, 6.5]) expect(timelineToRow(boxes, timelineToChat(boxes, row))).toBeCloseTo(row, 6);
  expect(timelineToChat(boxes, 0)).toBe(100);
  expect(timelineToChat(boxes, 9)).toBe(500);
});

test("search and block heights", () => {
  expect(timelineSearch([1, 3, 5], 4)).toBe(1);
  expect(timelineSearch([1, 3, 5], 0)).toBe(0);
  expect(timelineBlockHeight(100, 2)).toBe(47);
  expect(timelineBlockHeight(NaN, 0)).toBe(0);
});
