/**
 * Hand-rolled local-time date math for the calendar lane. Everything works in
 * epoch milliseconds interpreted in the host's local timezone (matching how
 * the server evaluates cron patterns), with no dependencies.
 */
import type { CalendarEvent } from "./types";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Local midnight at the start of the day containing `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Add whole days, preserving the local wall-clock time across DST. */
export function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ).getTime();
}

/** Add whole months, clamping the day-of-month into the target month. */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getDate();
  const target = new Date(
    d.getFullYear(),
    d.getMonth() + months,
    1,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  );
  const lastDay = daysInMonth(target.getFullYear(), target.getMonth());
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    Math.min(day, lastDay),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ).getTime();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** YYYY-MM-DD in local time; stable identity for a day cell/group. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * The 42 day-start timestamps (6 rows x 7 columns) covering the month grid
 * for the month containing `anchorMs`, leading with the previous month's
 * tail and trailing with the next month's head. `weekStartsOn` is a
 * getDay()-style index (0 = Sunday).
 */
export function monthGridDays(anchorMs: number, weekStartsOn = 0): number[] {
  const anchor = new Date(anchorMs);
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const gridStart = addDays(first.getTime(), -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

/** The 7 day-start timestamps of the week containing `anchorMs`. */
export function weekDays(anchorMs: number, weekStartsOn = 0): number[] {
  const day = startOfDay(anchorMs);
  const offset = (new Date(day).getDay() - weekStartsOn + 7) % 7;
  const weekStart = addDays(day, -offset);
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** "July 2026"-style label for the month containing `ms`. */
export function monthLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** "Jul 27 – Aug 2, 2026"-style label for a week row. */
export function weekLabel(days: number[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return "";
  const sameMonth = new Date(first).getMonth() === new Date(last).getMonth();
  const startPart = new Date(first).toLocaleDateString(
    undefined,
    sameMonth ? { month: "short", day: "numeric" } : { month: "short", day: "numeric" },
  );
  const endPart = new Date(last).toLocaleDateString(undefined, {
    month: sameMonth ? undefined : "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startPart} – ${endPart}`;
}

/** Short weekday column header ("Sun"). */
export function weekdayLabel(ms: number): string {
  return WEEKDAY_SHORT[new Date(ms).getDay()] ?? "";
}

/** Full accessible day label ("Monday, July 27, 2026"). */
export function fullDayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** "9:30 AM"-style local time label. */
export function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * January 1 is the reference day for wall-clock hour labels: no zone shifts its
 * clock on it, so hour N formats as hour N.
 */
const HOUR_LABEL_REFERENCE_YEAR = 2001;

/**
 * "9:00 AM"-style label for the wall-clock hour `hour` (0-23). The week grid
 * draws one row per wall-clock hour, so the label is read off a transition-free
 * reference day; formatting `dayStart + hour * HOUR_MS` on the visible day skips
 * the spring-forward hour and prints the autumn one twice.
 */
export function hourLabel(hour: number): string {
  return timeLabel(new Date(HOUR_LABEL_REFERENCE_YEAR, 0, 1, hour).getTime());
}

/** Minutes elapsed since local midnight. */
export function minutesIntoDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * The inverse of {@link minutesIntoDay}: the instant whose wall clock reads
 * `minutes` past midnight on the local day containing `dayMs`. Adding
 * `minutes * MINUTE_MS` to a day start instead measures elapsed time, which
 * slips by an hour on a daylight-saving transition day.
 *
 * The daylight-saving edges resolve the way `Date` does. A slot that does not
 * exist, inside the spring-forward gap, lands on the instant the clock jumps to
 * (02:30 returns 03:30 local). A slot that happens twice, inside the autumn
 * fall-back hour, returns its first, still-daylight occurrence.
 */
export function atMinutesIntoDay(dayMs: number, minutes: number): number {
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes).getTime();
}

/**
 * Local midnight at the start of the day after the one containing `dayMs`,
 * built from wall-clock fields. `startOfDay(dayMs) + DAY_MS` is 23 or 25
 * hours off on a daylight-saving transition day.
 */
export function startOfNextDay(dayMs: number): number {
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export type DaySegment = {
  /** Wall-clock minutes past midnight where the segment starts on this day. */
  startMin: number;
  /** Wall-clock minutes past midnight where the segment ends; 1440 when it runs to midnight. */
  endMin: number;
  /** The event started on an earlier day. */
  continuesBefore: boolean;
  /** The event ends on a later day. */
  continuesAfter: boolean;
};

/**
 * The part of a timed event that falls on the local day containing `dayMs`,
 * or undefined when the event does not touch that day. The event's
 * `[start, end)` interval is intersected with the day's local
 * `[midnight, next midnight)`, so an overnight or multi-day event yields one
 * segment per day it covers. An event without a later `end` covers only its
 * start instant.
 */
export function daySegment(event: CalendarEvent, dayMs: number): DaySegment | undefined {
  const dayStart = startOfDay(dayMs);
  const dayEnd = startOfNextDay(dayMs);
  const end = event.end !== undefined && event.end > event.start ? event.end : undefined;
  if (end === undefined) {
    if (event.start < dayStart || event.start >= dayEnd) return undefined;
    const startMin = minutesIntoDay(event.start);
    return { startMin, endMin: startMin, continuesBefore: false, continuesAfter: false };
  }
  if (event.start >= dayEnd || end <= dayStart) return undefined;
  const continuesBefore = event.start < dayStart;
  const continuesAfter = end > dayEnd;
  return {
    startMin: continuesBefore ? 0 : minutesIntoDay(event.start),
    endMin: end >= dayEnd ? 24 * 60 : minutesIntoDay(end),
    continuesBefore,
    continuesAfter,
  };
}

/** Snap minutes down to the nearest 30-minute slot (week-grid rendering). */
export function snapDown30(minutes: number): number {
  return Math.floor(minutes / 30) * 30;
}

/** Snap minutes up to the nearest 30-minute slot. */
export function snapUp30(minutes: number): number {
  return Math.ceil(minutes / 30) * 30;
}

export type AgendaDayGroup = {
  /** Day-start epoch ms. */
  dayMs: number;
  events: CalendarEvent[];
};

/**
 * Group events by local day, sorted chronologically inside and across groups.
 * Multi-day events appear under their start day only (spanning bars are a
 * deferred renderer feature).
 */
export function agendaGroups(events: CalendarEvent[]): AgendaDayGroup[] {
  const byDay = new Map<string, AgendaDayGroup>();
  for (const event of events) {
    const key = dayKey(event.start);
    let group = byDay.get(key);
    if (!group) {
      group = { dayMs: startOfDay(event.start), events: [] };
      byDay.set(key, group);
    }
    group.events.push(event);
  }
  const groups = [...byDay.values()].sort((a, b) => a.dayMs - b.dayMs);
  for (const group of groups) group.events.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
  return groups;
}

/** Events overlapping one local day (an event belongs to a day if it starts that day). */
export function eventsOnDay(events: CalendarEvent[], dayMs: number): CalendarEvent[] {
  return events
    .filter((event) => isSameDay(event.start, dayMs))
    .sort(
      (a, b) =>
        Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) || a.start - b.start || a.title.localeCompare(b.title),
    );
}

/**
 * Deterministic FNV-1a hash of a source key onto the tint rotation. The same
 * source always lands on the same tint within and across sessions.
 */
export function hashSource(source: string | undefined): number {
  const text = source ?? "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
