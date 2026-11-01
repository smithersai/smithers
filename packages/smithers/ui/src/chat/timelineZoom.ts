/**
 * The rail's pure geometry (ruling FE-19): which levels exist, how entries fold into exchanges, phases and arcs, what
 * each column's window shows, and how wide the columns are. Nothing here reads the DOM, so every rule is testable alone.
 */

/** The room one entry's label or one block's title needs: how many of them a column's window holds. */
export const TIMELINE_PITCH = 34;
/** The gap between blocks in an outer level. */
export const TIMELINE_BLOCK_GAP = 6;
/** A block's floor: two lines of title, so a small phase stays readable. */
const BLOCK_FLOOR = TIMELINE_PITCH - TIMELINE_BLOCK_GAP;
/** A one-liner's mark, however long the conversation around it. */
const MARK_FLOOR = 3;
const LABEL_LINE = 14;
const LABEL_GAP = 2;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const measured = (height: number) => Math.max(0, Number.isFinite(height) ? height : 0);

/** Rows or blocks that fit a column of `height`, at least two. */
export const timelineCapacity = (height: number): number => Math.max(2, Math.floor(measured(height) / TIMELINE_PITCH));

/**
 * The columns a conversation needs: a level appears only when the one inside it no longer fits (FE-16). `spans` is how
 * many phases the level-1 column has.
 */
export const timelineLevelCount = (entries: number, spans: number, height: number, outerCounts: readonly number[] = []): number => {
  if (entries <= 0) return 0;
  const capacity = timelineCapacity(height);
  const counts = [entries, spans, ...outerCounts];
  const fitting = counts.findIndex(count => count <= capacity);
  // If the last supplied summary level overflows, show the next level as pending until its summaries arrive.
  return fitting < 0 ? counts.length + 1 : fitting + 1;
};

/** A marker a host supplies: this phase or arc starts at entry `start`, with what the summary model wrote. */
export interface TimelineMarker {
  readonly id: string;
  /** The id of the entry the span starts at. */
  readonly start: string;
  /** The last entry actually covered, inclusive. Missing or unavailable coverage remains pending. */
  readonly end?: string;
  readonly title: string;
  /** One sentence on what happened in the span; shown on hover. */
  readonly summary?: string;
  /** False while the latest span may still grow or be rewritten. */
  readonly closed?: boolean;
}

/** A half-open range of entries, and its title when one has been written. */
export interface TimelineBlock {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly title?: string;
  readonly summary?: string;
  readonly closed?: boolean;
}

/** Child marks belong only to the intersection with their parent's recorded coverage. */
export const timelineIntersections = (parts: readonly TimelineWindow[], range: TimelineWindow): readonly TimelineWindow[] =>
  parts.map(part => ({ start: Math.max(range.start, part.start), end: Math.min(range.end, part.end) })).filter(part => part.end > part.start);

/** Folds recorded coverage into titled spans, with separate pending blocks for every uncovered gap and tail. */
export const timelineBlocks = (ids: readonly string[], markers: readonly TimelineMarker[], level: number): readonly TimelineBlock[] => {
  if (ids.length === 0) return [];
  const at = new Map(ids.map((id, index) => [id, index]));
  const known = markers.flatMap(marker => {
    const start = at.get(marker.start), last = marker.end === undefined ? undefined : at.get(marker.end);
    return start === undefined || last === undefined || last < start ? [] : [{ marker, start, end: last + 1 }];
  }).sort((a, b) => a.start - b.start);
  const blocks: TimelineBlock[] = [];
  let cursor = 0;
  const pending = (end: number) => {
    if (end > cursor) blocks.push({ id: `pending:${level}:${ids[cursor]}`, start: cursor, end });
    cursor = end;
  };
  for (const { marker, start, end } of known) {
    // Overlapping or duplicate coverage cannot rename already-covered entries.
    if (start < cursor) continue;
    pending(start);
    blocks.push({ id: marker.id, start, end, title: marker.title,
      ...(marker.summary === undefined ? {} : { summary: marker.summary }),
      ...(marker.closed === undefined ? {} : { closed: marker.closed }),
    });
    cursor = end;
  }
  pending(ids.length);
  return blocks;
};

/** A question and what followed it, as half-open entry indices. Anything before the first question is its own. */
export const timelineExchanges = (asks: readonly boolean[]): readonly { readonly start: number; readonly end: number }[] => {
  const starts = asks.flatMap((ask, index) => ask || index === 0 ? [index] : []);
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? asks.length }));
};

/**
 * The room a host gives the rail beside its transcript: enough for a level-0 summary's words on its line and whole-word
 * phase titles. A host shifts its chat column to leave it, rather than squeezing the rail (`chat-timeline.md`).
 */
export const TIMELINE_ROOM = 380;

/** Columns' widths, innermost first, and the gap between them, for `available` px of rail. */
export const timelineWidths = (levels: number, available: number): { readonly widths: readonly number[]; readonly gap: number } => {
  if (levels > 3) {
    const room = measured(available), gap = Math.min(12, room / (levels * 4));
    const free = Math.max(0, room - gap * (levels - 1)), total = levels + 7;
    return { widths: Array.from({ length: levels }, (_, level) => free * (level === 0 ? 6 : level === 1 ? 3 : 1) / total), gap };
  }
  const gap = available < 300 ? 18 : 20;
  if (levels <= 1) return { widths: [Math.min(available, 200)], gap };
  // Level 0 takes its room first, so a summary reads whole; what it leaves widens the phase titles, up to a cap.
  if (levels === 2) {
    const least = clamp(Math.round(available * .4), 84, 92);
    const level0 = Math.min(200, available - least - gap);
    return { widths: [level0, Math.max(least, Math.min(140, available - level0 - gap))], gap };
  }
  // Under 340 px (a phone's sheet) the outermost column is a strip of colors, so the words go to the inner two.
  const outermost = available >= 340 ? clamp(Math.round(available * .19), 46, 62) : 18;
  const least = clamp(Math.round(available * (available >= 300 ? .264 : .33)), 84, 90);
  const level0 = Math.min(190, available - least - outermost - 2 * gap);
  return { widths: [level0, Math.max(least, Math.min(130, available - level0 - outermost - 2 * gap)), outermost], gap };
};

/** The inclusive-exclusive stretch a column shows. */
export interface TimelineWindow { readonly start: number; readonly end: number }

/** The window around what's on screen is still right, so nothing moves: scrolling never drags a level along. */
const holds = (window: TimelineWindow | undefined, first: number, last: number) =>
  window !== undefined && window.start >= 0 && first >= window.start && last < window.end;

/**
 * Level 0's rows: everything while one level fits; otherwise the window it already has while the viewport stays inside,
 * else a page centered on `reading` (a fractional row) that starts on an exchange, and on `blockStart` when that still
 * covers what is on screen. `ask` says whether a row starts an exchange.
 */
export const timelineRowWindow = (input: {
  readonly count: number;
  readonly levels: number;
  readonly height: number;
  readonly first: number;
  readonly last: number;
  readonly reading: number;
  readonly current?: TimelineWindow;
  readonly force?: boolean;
  readonly ask: (row: number) => boolean;
  readonly blockStart: (row: number) => number;
}): TimelineWindow => {
  const { count, levels, height, first, last, reading, current, force, ask, blockStart } = input;
  if (levels <= 1) return { start: 0, end: count };
  const rows = Math.max(1, Math.floor(height / TIMELINE_PITCH));
  if (!force && holds(current, first, last) && current!.end - current!.start <= rows) return current!;
  const onExchange = (row: number) => row > 0 && !ask(row) ? row - 1 : row;
  let start = onExchange(clamp(Math.ceil(reading - rows / 2), 0, Math.max(0, count - rows)));
  if (start > first) start = onExchange(first);
  const fill = (from: number) => {
    const end = Math.min(count, from + rows);
    return end < count && end - 1 > from && ask(end - 1) ? end - 1 : end;
  };
  let end = fill(start);
  while (end <= last && start < first) { start += ask(start) ? 2 : 1; end = fill(start); }
  const block = blockStart(start);
  if (fill(block) > last) { start = block; end = fill(block); }
  return { start, end };
};

/** Each outer column holds its bounded window, then pages around the inner column’s covered blocks. */
export const timelineBlockWindow = (input: {
  readonly count: number;
  readonly height: number;
  readonly first: number;
  readonly last: number;
  readonly current?: TimelineWindow;
  readonly force?: boolean;
}): TimelineWindow => {
  const { count, height, first, last, current, force } = input;
  const capacity = timelineCapacity(height);
  if (count <= capacity) return { start: 0, end: count };
  if (!force && holds(current, first, last) && current!.end - current!.start <= capacity) return current!;
  const start = Math.min(first, clamp(Math.floor((first + last + 1) / 2 - capacity / 2), 0, Math.max(0, count - capacity)));
  return { start, end: Math.min(count, start + capacity) };
};

/** Index of the last value at or before `value` in the ascending `values`; 0 when none is. */
export const timelineSearch = (values: readonly number[], value: number): number => {
  let low = 0, high = values.length - 1, found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (values[middle]! <= value) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
};

/** One entry's box in the transcript. */
export interface TimelineBox { readonly row: number; readonly top: number; readonly bottom: number }

/** Transcript y to a fractional row, piecewise by message, so the thumb covers exactly what the chat shows. */
export const timelineToRow = (boxes: readonly TimelineBox[], y: number): number => {
  if (boxes.length === 0) return 0;
  if (y <= boxes[0]!.top) return boxes[0]!.row;
  const index = timelineSearch(boxes.map(box => box.top), y);
  const box = boxes[index]!;
  if (y <= box.bottom) return box.row + (y - box.top) / Math.max(1, box.bottom - box.top);
  const next = boxes[index + 1];
  if (next === undefined) return box.row + 1;
  return box.row + 1 + (y - box.bottom) / Math.max(1, next.top - box.bottom) * (next.row - box.row - 1);
};

/** A fractional row to transcript y: the inverse of {@link timelineToRow}. */
export const timelineToChat = (boxes: readonly TimelineBox[], row: number): number => {
  if (boxes.length === 0) return 0;
  if (row <= boxes[0]!.row) return boxes[0]!.top;
  const index = timelineSearch(boxes.map(box => box.row), row);
  const box = boxes[index]!;
  if (row <= box.row + 1) return box.top + (row - box.row) * (box.bottom - box.top);
  const next = boxes[index + 1];
  if (next === undefined) return box.bottom;
  return box.bottom + (row - box.row - 1) / Math.max(1, next.row - box.row - 1) * (next.top - box.bottom);
};

/** An entry's size in the transcript: `height` is its box, `advance` how far the next entry starts below its top. */
export interface TimelineSize { readonly height: number; readonly advance: number }

/** Unmounted history's stable stand-in, from the message's length, until it has been measured once. */
export const timelineEstimate = (length: number): TimelineSize => {
  const height = 44 + Math.ceil(Math.max(length, 1) / 80) * 24;
  return { height, advance: height + 24 };
};

/** Where each entry starts on the conversation's position scale; the last value is where the conversation ends. */
export const timelineOffsets = (sizes: readonly TimelineSize[]): readonly number[] => {
  const offsets = [0];
  for (const size of sizes) offsets.push(offsets.at(-1)! + size.advance);
  return offsets;
};

/**
 * Transcript y to the position scale: exact inside what's mounted, where an entry's offset advances as its transcript
 * top does. Past the last mounted entry of a run it stops at that entry's end, because the rows after it are estimates.
 */
export const timelineTrack = (boxes: readonly TimelineBox[], offsets: readonly number[], y: number): number => {
  if (boxes.length === 0) return 0;
  if (y <= boxes[0]!.top) return offsets[boxes[0]!.row]!;
  const box = boxes[timelineSearch(boxes.map(item => item.top), y)]!;
  return Math.min(offsets[box.row + 1]!, offsets[box.row]! + y - box.top);
};

/** A position back to a fractional row, by the message's own box, so a drag lands on what the mark shows. */
export const timelineRowAt = (sizes: readonly TimelineSize[], offsets: readonly number[], position: number): number => {
  if (sizes.length === 0 || position <= 0) return 0;
  const row = timelineSearch(offsets, position);
  if (row >= sizes.length) return sizes.length;
  return row + Math.min(1, (position - offsets[row]!) / Math.max(1, sizes[row]!.height));
};

/** Level 0 as a minimap of its window: every mark at its position, never magnified past the transcript's own size. */
export const timelineRowLayout = (sizes: readonly TimelineSize[], offsets: readonly number[], window: TimelineWindow, height: number) => {
  const base = offsets[window.start]!, span = offsets[window.end]! - base;
  const scale = span > 0 ? Math.min(1, measured(height) / span) : 1;
  return {
    scale, base, height: span * scale,
    marks: sizes.map((size, row) => ({ y: (offsets[row]! - base) * scale, height: Math.max(MARK_FLOOR, size.height * scale) })),
  };
};

/** An outer column's blocks: a floor for the title, and the column's free room shared by what each block covers. */
export const timelineBlockLayout = (spans: readonly number[], window: TimelineWindow, height: number) => {
  const inside = spans.slice(window.start, window.end), count = inside.length;
  const total = inside.reduce((sum, span) => sum + span, 0);
  const free = Math.max(0, measured(height) - count * BLOCK_FLOOR - (count - 1) * TIMELINE_BLOCK_GAP);
  const heights = spans.map(span => BLOCK_FLOOR + (total > 0 ? free * span / total : 0));
  const tops = spans.map(() => 0);
  for (let index = window.start + 1; index < spans.length; index++) tops[index] = tops[index - 1]! + heights[index - 1]! + TIMELINE_BLOCK_GAP;
  for (let index = window.start - 1; index >= 0; index--) tops[index] = tops[index + 1]! - heights[index]! - TIMELINE_BLOCK_GAP;
  return spans.map((_, index) => ({ top: tops[index]!, height: heights[index]! }));
};

/** A label to place: its mark's y and height, the lines its text wants, and whether its state outranks length. */
export interface TimelineLabelInput { readonly y: number; readonly height: number; readonly lines: number; readonly urgent: boolean }
export interface TimelineLabel { readonly visible: boolean; readonly y: number; readonly lines: number }

/** Top-down: each label at its mark, or pushed down within its own message. Undefined when one has nowhere to go. */
const placed = (labels: readonly (TimelineLabelInput & { readonly index: number })[], rail: number) => {
  const slots = new Map<number, number>();
  let cursor = 0;
  for (const label of labels) {
    const needed = label.lines * LABEL_LINE;
    const low = Math.min(label.y, rail - needed);
    if (low < 0) return undefined;
    const slot = Math.max(low, cursor);
    if (slot > Math.max(low, Math.min(label.y + label.height, rail) - needed)) return undefined;
    slots.set(label.index, slot);
    cursor = slot + needed + LABEL_GAP;
  }
  return slots;
};

/**
 * Which labels show and where. Urgent, then longest, then earliest, each joins while every label already chosen still
 * has a slot, at the lines it wants or else at one line. The rest wait for hover or focus. So the set never depends on
 * scrolling, and a label never leaves its own message.
 */
export const timelineLabels = (items: readonly TimelineLabelInput[], rail: number): readonly TimelineLabel[] => {
  const order = items.map((item, index) => ({ ...item, index }))
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.height - a.height || a.index - b.index);
  let chosen: typeof order = [];
  let slots = new Map<number, number>();
  for (const item of order) for (let lines = item.lines; lines >= 1; lines--) {
    const trial = [...chosen, { ...item, lines }].sort((a, b) => a.index - b.index);
    const fits = placed(trial, rail);
    if (fits === undefined) continue;
    chosen = trial; slots = fits;
    break;
  }
  const lines = new Map(chosen.map(label => [label.index, label.lines]));
  return items.map((item, index) => {
    const slot = slots.get(index);
    return slot === undefined ? { visible: false, y: item.y, lines: 0 } : { visible: true, y: slot, lines: lines.get(index)! };
  });
};
