import { daySegment, snapDown30, snapUp30 } from "./dateUtils";
import type { CalendarEvent } from "./types";

/** Pack each day's displayed segments into disjoint columns within overlap groups. */
export function layoutTimedEvents(events: readonly CalendarEvent[], dayMs: number) {
  const timed = events.filter((event) => !event.allDay).flatMap((event) => {
    const segment = daySegment(event, dayMs);
    if (!segment) return [];
    const startMin = snapDown30(segment.startMin);
    return [{
      event, segment, startMin,
      endMin: Math.max(snapUp30(segment.endMin), startMin + 30),
      column: 0, columns: 1,
    }];
  }).sort((a, b) => a.startMin - b.startMin || a.event.start - b.event.start || a.event.title.localeCompare(b.event.title) || a.event.id.localeCompare(b.event.id));

  let group: typeof timed = [];
  let columnEnds: number[] = [];
  let groupEnd = -Infinity;
  function finishGroup() {
    for (const item of group) item.columns = columnEnds.length;
  }
  for (const item of timed) {
    if (item.startMin >= groupEnd) {
      finishGroup();
      group = [];
      columnEnds = [];
    }
    const available = columnEnds.findIndex((end) => end <= item.startMin);
    item.column = available === -1 ? columnEnds.length : available;
    columnEnds[item.column] = item.endMin;
    group.push(item);
    groupEnd = Math.max(groupEnd, item.endMin);
  }
  finishGroup();
  return timed;
}
