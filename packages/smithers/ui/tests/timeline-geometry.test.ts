import { expect, test } from "bun:test";
import {
  timelineIntersections, timelineBlockLayout, timelineBlocks, timelineBlockWindow, timelineCapacity, timelineEstimate, timelineExchanges, timelineLabels,
  timelineLevelCount, timelineOffsets, timelineRowAt, timelineRowLayout, timelineRowWindow, timelineSearch, timelineToChat, timelineToRow, timelineTrack, timelineWidths, TIMELINE_ROOM,
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
    { id: "b", start: "e4", end: "e29", title: "Fix" }, { id: "a", start: "e0", end: "e3", title: "Research", summary: "Why.", closed: true },
    { id: "gone", start: "nowhere", title: "Deleted" }, { id: "twin", start: "e4", end: "e29", title: "Same start" },
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

const sized = (...heights: readonly number[]) => heights.map(height => ({ height, advance: height + 20 }));

test("a long answer's mark is proportionally taller and later marks are offset by it (FE-22)", () => {
  const sizes = sized(40, 1160, 40, 40);
  const offsets = timelineOffsets(sizes);
  expect(offsets).toEqual([0, 60, 1240, 1300, 1360]);
  const { scale, marks } = timelineRowLayout(sizes, offsets, { start: 0, end: 4 }, 680);
  expect(scale).toBe(.5);
  expect(marks.map(mark => [mark.y, mark.height])).toEqual([[0, 20], [30, 580], [620, 20], [650, 20]]);
});

test("the position scale never magnifies a conversation shorter than the rail", () => {
  const sizes = sized(40, 40);
  expect(timelineRowLayout(sizes, timelineOffsets(sizes), { start: 0, end: 2 }, 800).scale).toBe(1);
  expect(timelineRowLayout(sizes, timelineOffsets(sizes), { start: 0, end: 0 }, 800).marks).toHaveLength(2);
});

test("a one-liner in a long conversation keeps a visible mark", () => {
  const sizes = sized(30, 100000);
  const { marks } = timelineRowLayout(sizes, timelineOffsets(sizes), { start: 0, end: 2 }, 400);
  expect(marks[0]!.height).toBe(3);
  expect(marks[1]!.height).toBeCloseTo(100000 * 400 / 100070);
});

test("a window measures from its own first row, so rows above it can't move it", () => {
  const near = sized(100, 100, 100), far = sized(5000, 100, 100);
  const window = { start: 1, end: 3 };
  expect(timelineRowLayout(far, timelineOffsets(far), window, 600).marks[2]!.y)
    .toBe(timelineRowLayout(near, timelineOffsets(near), window, 600).marks[2]!.y);
  expect(timelineRowLayout(far, timelineOffsets(far), window, 600).marks[0]!.y).toBeLessThan(0);
});

test("unmounted history takes a stable estimate from its length", () => {
  expect(timelineEstimate(0)).toEqual(timelineEstimate(1));
  expect(timelineEstimate(4000).height).toBeGreaterThan(timelineEstimate(400).height * 3);
  expect(timelineEstimate(400)).toEqual(timelineEstimate(400));
  expect(timelineEstimate(400).advance).toBeGreaterThan(timelineEstimate(400).height);
});

test("the band maps transcript y exactly, across gaps, unmounted rows and both ends", () => {
  const boxes = [{ row: 1, top: 100, bottom: 200 }, { row: 2, top: 240, bottom: 300 }, { row: 5, top: 900, bottom: 1000 }];
  const offsets = [0, 500, 640, 700, 800, 900, 1000];
  expect(timelineTrack([], offsets, 50)).toBe(0);
  expect(timelineTrack(boxes, offsets, 0)).toBe(500);
  expect(timelineTrack(boxes, offsets, 150)).toBe(550);
  expect(timelineTrack(boxes, offsets, 220)).toBe(620);
  expect(timelineTrack(boxes, offsets, 280)).toBe(680);
  expect(timelineTrack(boxes, offsets, 500)).toBe(700);
  expect(timelineTrack(boxes, offsets, 950)).toBe(950);
  expect(timelineTrack(boxes, offsets, 5000)).toBe(1000);
});

test("a rail position goes back to a fractional row of the message under it", () => {
  const sizes = sized(80, 180);
  const offsets = timelineOffsets(sizes);
  expect(timelineRowAt(sizes, offsets, -5)).toBe(0);
  expect(timelineRowAt(sizes, offsets, 40)).toBe(.5);
  expect(timelineRowAt(sizes, offsets, 90)).toBe(1);
  expect(timelineRowAt(sizes, offsets, 190)).toBe(1.5);
  expect(timelineRowAt(sizes, offsets, 999)).toBe(2);
  expect(timelineRowAt([], [0], 10)).toBe(0);
});

const label = (y: number, height: number, extra: Partial<Parameters<typeof timelineLabels>[0][number]> = {}) => ({ y, height, lines: 2, urgent: false, ...extra });

test("a label sits at its mark while it fits", () => {
  expect(timelineLabels([label(0, 40), label(50, 40)], 400)).toEqual([{ visible: true, y: 0, lines: 2 }, { visible: true, y: 50, lines: 2 }]);
});

test("a displaced label slides down inside its own message", () => {
  expect(timelineLabels([label(0, 10, { lines: 1 }), label(10, 100)], 400).map(item => item.y)).toEqual([0, 16]);
  // The long answer below a two-line question moves; the question stays by its mark.
  expect(timelineLabels([label(0, 10), label(10, 100)], 400).map(item => item.y)).toEqual([0, 30]);
});

test("too dense a window keeps the longest and most urgent labels, and shortens before it hides", () => {
  const dense = timelineLabels([label(0, 4), label(6, 4), label(12, 80), label(92, 4, { urgent: true }), label(98, 4)], 400);
  expect(dense.map(item => item.visible)).toEqual([true, false, true, true, false]);
  expect(dense[2]).toEqual({ visible: true, y: 30, lines: 2 });
  expect(dense[3]).toEqual({ visible: true, y: 92, lines: 2 });
  const shortened = timelineLabels([label(0, 8), label(14, 40)], 400);
  expect(shortened[0]).toEqual({ visible: true, y: 0, lines: 1 });
  expect(shortened[1]!.lines).toBe(2);
});

test("hidden labels keep their row's order and a tie keeps the earlier message", () => {
  const tied = timelineLabels([label(0, 2), label(2, 2)], 400);
  expect(tied.map(item => item.visible)).toEqual([true, false]);
  expect(tied[1]).toEqual({ visible: false, y: 2, lines: 0 });
});

test("the last label stays inside the rail", () => {
  const [last] = timelineLabels([label(395, 5)], 400);
  expect(last).toEqual({ visible: true, y: 372, lines: 2 });
  const [only] = timelineLabels([label(395, 5)], 10);
  expect(only).toEqual({ visible: false, y: 395, lines: 0 });
});

test("outer blocks follow what they cover above a floor that holds a title", () => {
  const window = { start: 1, end: 4 };
  const blocks = timelineBlockLayout([500, 100, 300, 600, 700], window, 400);
  expect(blocks[1]).toEqual({ top: 0, height: 28 + 304 * 100 / 1000 });
  expect(blocks[2]!.top).toBeCloseTo(blocks[1]!.height + 6);
  expect(blocks[3]!.top + blocks[3]!.height).toBeCloseTo(400);
  expect(blocks[3]!.height).toBeGreaterThan(blocks[2]!.height);
  expect(blocks[0]!.top + blocks[0]!.height + 6).toBeCloseTo(0);
  expect(blocks[4]!.top).toBeCloseTo(406);
  for (const block of timelineBlockLayout([1, 100000], { start: 0, end: 2 }, 100)) expect(block.height).toBeGreaterThanOrEqual(28);
  expect(timelineBlockLayout([0, 0], { start: 0, end: 2 }, 100)[1]).toEqual({ top: 34, height: 28 });
});

test("columns take the mock's widths at both windows", () => {
  expect(timelineWidths(1, 342)).toEqual({ widths: [200], gap: 20 });
  expect(timelineWidths(2, 342)).toEqual({ widths: [200, 122], gap: 20 });
  expect(timelineWidths(3, 342)).toEqual({ widths: [150, 90, 62], gap: 20 });
  expect(timelineWidths(3, 262)).toEqual({ widths: [122, 86, 18], gap: 18 });
});

test("the room a host gives the rail goes to whole summaries first, then to phase titles", () => {
  const level0 = (levels: number) => timelineWidths(levels, TIMELINE_ROOM).widths[0]!;
  expect(level0(2)).toBe(200);
  expect(level0(3)).toBeGreaterThanOrEqual(186);
  expect(timelineWidths(2, TIMELINE_ROOM)).toEqual({ widths: [200, 140], gap: 20 });
  expect(timelineWidths(2, 600)).toEqual({ widths: [200, 140], gap: 20 });
  expect(timelineWidths(3, 414)).toEqual({ widths: [190, 122, 62], gap: 20 });
  expect(timelineWidths(3, 600)).toEqual({ widths: [190, 130, 62], gap: 20 });
});

test("a phase column keeps a readable measure at every width the rail shows at", () => {
  for (const available of [180, 212, 230, 262, 299, 300, 342, 380, 414, 600]) for (const levels of [2, 3]) {
    const { widths, gap } = timelineWidths(levels, available);
    expect(widths[1]).toBeGreaterThanOrEqual(84);
    expect(widths[0]).toBeGreaterThan(0);
    expect(widths.reduce((sum, width) => sum + width, 0) + gap * (levels - 1)).toBeLessThanOrEqual(available);
  }
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
  const blocks = (extra: Partial<Parameters<typeof timelineBlockWindow>[0]>) => timelineBlockWindow({ count: 60, height: 804, first: 30, last: 31, ...extra });
  expect(blocks({ count: 20 })).toEqual({ start: 0, end: 20 });
  expect(blocks({ current: { start: 20, end: 43 }, first: 30, last: 31 })).toEqual({ start: 20, end: 43 });
  const page = blocks({});
  expect(page).toEqual({ start: 19, end: 42 });
  expect(blocks({ first: 0, last: 40 }).end).toBe(23);
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

test("search", () => {
  expect(timelineSearch([1, 3, 5], 4)).toBe(1);
  expect(timelineSearch([1, 3, 5], 0)).toBe(0);
});

test("closed coverage stops at its recorded endpoint, leaving gaps and the growing tail pending", () => {
  const blocks = timelineBlocks(ids(12), [
    { id: "p0", start: "e0", end: "e3", title: "Research", closed: true },
    { id: "p1", start: "e6", end: "e9", title: "Fix", closed: false },
  ], 1);
  expect(blocks.map(({ start, end, title }) => [start, end, title])).toEqual([
    [0, 4, "Research"], [4, 6, undefined], [6, 10, "Fix"], [10, 12, undefined],
  ]);
  expect(timelineBlocks(ids(4), [{ id: "bad", start: "e0", end: "missing", title: "Unknown" }], 1))
    .toEqual([{ id: "pending:1:e0", start: 0, end: 4 }]);
});

test("a shorter rail invalidates retained row and block windows", () => {
  const window = { start: 40, end: 62 };
  const short = rows({ height: 544, current: window, first: 48, last: 50, reading: 49 });
  expect((short.end - short.start) * 34).toBeLessThanOrEqual(544);
  const blocks = timelineBlockWindow({ count: 60, height: 544, first: 48, last: 50, current: window });
  expect((blocks.end - blocks.start) * 34).toBeLessThanOrEqual(544);
});

test("semantic summary levels continue beyond arcs only when each inner level overflows", () => {
  expect(timelineLevelCount(2000, 200, 704, [50])).toBe(4);
  expect(timelineLevelCount(20000, 2000, 704, [500, 50, 8])).toBe(5);
  expect(timelineLevelCount(2000, 20, 704, [50])).toBe(2);
  for (const levels of [4, 5, 12]) {
    const { widths, gap } = timelineWidths(levels, 262);
    expect(widths.length).toBe(levels);
    expect(widths.every(width => width >= 0)).toBe(true);
    expect(widths.reduce((sum, width) => sum + width, 0) + gap * (levels - 1)).toBeCloseTo(262);
  }
});

test("fifty arcs stay in a bounded window instead of overflowing the outer track", () => {
  const window = timelineBlockWindow({ count: 50, height: 704, first: 24, last: 27 });
  expect(window.end - window.start).toBeLessThanOrEqual(timelineCapacity(704));
  expect(window.start).toBeLessThanOrEqual(24);
  expect(window.end).toBeGreaterThan(27);
  const broad = timelineBlockWindow({ count: 50, height: 704, first: 0, last: 49 });
  expect(broad.end - broad.start).toBeLessThanOrEqual(timelineCapacity(704));
});

test("strip intersections cover a split child on both sides without leaking coverage", () => {
  const parts = [{ start: 0, end: 3 }, { start: 3, end: 6 }];
  expect(timelineIntersections(parts, { start: 1, end: 4 })).toEqual([{ start: 1, end: 3 }, { start: 3, end: 4 }]);
  expect(timelineIntersections(parts, { start: 4, end: 6 })).toEqual([{ start: 4, end: 6 }]);
  expect(timelineIntersections(parts, { start: 6, end: 6 })).toEqual([]);
});
