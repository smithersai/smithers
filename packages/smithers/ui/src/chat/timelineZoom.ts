/**
 * The rail's pure geometry (ruling FE-19): which levels exist, how entries fold into exchanges, phases and arcs, what
 * each column's window shows, and how wide the columns are. Nothing here reads the DOM, so every rule is testable alone.
 */

/** A row of the entries' level; every row is this tall, so a summary arriving never moves anything. */
export const TIMELINE_PITCH = 34;
/** The gap between blocks in an outer level. */
export const TIMELINE_BLOCK_GAP = 6;
/** The mock's three columns: entries, phases, arcs. */
export const TIMELINE_MAX_LEVELS = 3;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const measured = (height: number) => Math.max(0, Number.isFinite(height) ? height : 0);

/** Rows or blocks that fit a column of `height`, at least two. */
export const timelineCapacity = (height: number): number => Math.max(2, Math.floor(measured(height) / TIMELINE_PITCH));

/**
 * The columns a conversation needs: a level appears only when the one inside it no longer fits (FE-16). `spans` is how
 * many phases the level-1 column has.
 */
export const timelineLevelCount = (entries: number, spans: number, height: number): number => {
  if (entries <= 0) return 0;
  const capacity = timelineCapacity(height);
  if (entries <= capacity) return 1;
  return spans <= capacity ? 2 : TIMELINE_MAX_LEVELS;
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

/** A mark's height from its message's length, on a log scale: 6 px for a word, 26 px for a long answer. */
export const timelineMarkHeight = (length: number): number =>
  Math.round(6 + 20 * clamp(Math.log10(Math.max(length, 10) / 12) / 2.1, 0, 1));

/** Stacked marks inside a block, each as tall as its share of `room`, at least 1.5 px. */
export const timelineMarks = <A extends { readonly weight: number }>(parts: readonly A[], room: number, gap: number): readonly (A & { readonly y: number; readonly height: number })[] => {
  const total = parts.reduce((sum, part) => sum + part.weight, 0) || 1;
  const free = Math.max(0, room - gap * (parts.length - 1));
  let y = 0;
  return parts.map(part => {
    const height = Math.max(1.5, free * part.weight / total);
    const mark = { ...part, y, height };
    y += height + gap;
    return mark;
  });
};

/** Columns' widths, innermost first, and the gap between them, for `available` px of rail. */
export const timelineWidths = (levels: number, available: number): { readonly widths: readonly number[]; readonly gap: number } => {
  const gap = available < 300 ? 18 : 20;
  if (levels <= 1) return { widths: [Math.min(available, 200)], gap };
  if (levels === 2) {
    const outer = clamp(Math.round(available * .3), 60, 92);
    return { widths: [Math.min(200, available - outer - gap), outer], gap };
  }
  const outermost = available >= 300 ? clamp(Math.round(available * .19), 46, 62) : 18;
  const middle = available >= 300 ? clamp(Math.round(available * .24), 60, 78) : clamp(Math.round(available * .29), 70, 80);
  return { widths: [Math.min(190, available - middle - outermost - 2 * gap), middle, outermost], gap };
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

/** Level 1's blocks: all of them with two levels; else the same hold-then-page rule around the blocks level 0 covers. */
export const timelineBlockWindow = (input: {
  readonly count: number;
  readonly levels: number;
  readonly height: number;
  readonly first: number;
  readonly last: number;
  readonly current?: TimelineWindow;
  readonly force?: boolean;
}): TimelineWindow => {
  const { count, levels, height, first, last, current, force } = input;
  if (levels < TIMELINE_MAX_LEVELS) return { start: 0, end: count };
  const capacity = timelineCapacity(height);
  if (!force && holds(current, first, last) && current!.end - current!.start <= capacity) return current!;
  const start = Math.min(first, clamp(Math.floor((first + last + 1) / 2 - capacity / 2), 0, Math.max(0, count - capacity)));
  return { start, end: Math.max(Math.min(count, start + capacity), last + 1) };
};

/** A block's height when `perColumn` of them fill a column of `height`. */
export const timelineBlockHeight = (height: number, perColumn: number): number =>
  (measured(height) + TIMELINE_BLOCK_GAP) / Math.max(1, perColumn) - TIMELINE_BLOCK_GAP;

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
