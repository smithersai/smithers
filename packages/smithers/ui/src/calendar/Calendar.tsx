/** @jsxImportSource react */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import { safeHref } from "../internal/safeHref";
import { Button } from "../button";
import { EmptyState } from "../empty-state";
import { statusColor } from "../status";
import { useInjectUiCss } from "../styles";
import { RelativeTime } from "../time/RelativeTime";
import {
  addDays,
  addMonths,
  agendaGroups,
  atMinutesIntoDay,
  dayKey,
  daySegment,
  eventsOnDay,
  fullDayLabel,
  hashSource,
  hourLabel,
  isSameDay,
  minutesIntoDay,
  monthGridDays,
  monthLabel,
  snapDown30,
  snapUp30,
  startOfDay,
  timeLabel,
  weekDays,
  weekLabel,
  weekdayLabel,
} from "./dateUtils";
import type { CalendarEvent, CalendarView } from "./types";

/** Pixels per hour in the week time grid; mirrors the 44px row period in calendarCss. */
const HOUR_PX = 44;
const WEEK_BODY_HEIGHT = 24 * HOUR_PX;
const TINTS = ["brand", "success", "info", "warning"] as const;
const VIEWS: readonly CalendarView[] = ["month", "week", "agenda"];

type Tint = (typeof TINTS)[number];

/** The per-source tint: explicit `color` wins; otherwise the source hash rotates the semantic tints. */
function tintFor(event: CalendarEvent): Tint {
  return TINTS[hashSource(event.source) % TINTS.length]!;
}

function colorStyle(event: CalendarEvent): CSSProperties | undefined {
  if (!event.color) return undefined;
  return {
    borderColor: `color-mix(in srgb, ${event.color} 40%, transparent)`,
    background: `color-mix(in srgb, ${event.color} 10%, transparent)`,
    color: event.color,
  };
}

function statusDot(event: CalendarEvent): ReactNode {
  if (!event.status) return null;
  return (
    <span
      aria-hidden
      className="sui-cal-chip-dot"
      style={{ background: statusColor(event.status) }}
      title={event.status}
    />
  );
}

type EventAction = Pick<CalendarViewProps, "onEventClick">;

function eventElement(
  event: CalendarEvent,
  onEventClick: EventAction["onEventClick"],
  props: Record<string, unknown>,
  children: ReactNode,
) {
  const title = `${event.title} — ${event.allDay ? "all day" : timeLabel(event.start)}`;
  const href = event.href === undefined ? undefined : safeHref(event.href);
  if (href !== undefined && !onEventClick) {
    return (
      <a {...props} key={event.id} href={href} title={title} onClick={(clickEvent) => clickEvent.stopPropagation()}>
        {children}
      </a>
    );
  }
  return (
    <button
      {...props}
      key={event.id}
      type="button"
      title={title}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onEventClick?.(event);
      }}
    >
      {children}
    </button>
  );
}

function EventChip({ event, onEventClick }: { event: CalendarEvent } & EventAction) {
  return eventElement(
    event,
    onEventClick,
    {
      className: "sui-cal-chip",
      "data-tint": event.color ? undefined : tintFor(event),
      style: colorStyle(event),
    },
    <>
      {statusDot(event)}
      {event.allDay ? null : <span className="sui-cal-chip-time">{timeLabel(event.start)}</span>}
      <span className="sui-cal-chip-title">{event.title}</span>
    </>,
  );
}

/* -------------------------------------------------------------------------- */
/* Month                                                                       */
/* -------------------------------------------------------------------------- */

type CalendarViewProps = {
  anchorMs: number;
  events: CalendarEvent[];
  nowMs: number;
  weekStartsOn: number;
  maxChipsPerDay: number;
  onEventClick?: (event: CalendarEvent) => void;
  onSlotClick?: (date: number) => void;
  /** Re-anchor the visible range (arrow-key travel past the grid edge). */
  onNavigate?: (anchorMs: number) => void;
};

const DAY_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

function MonthView({
  anchorMs,
  events,
  nowMs,
  weekStartsOn,
  maxChipsPerDay,
  onEventClick,
  onSlotClick,
  onNavigate,
}: CalendarViewProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const days = useMemo(() => monthGridDays(anchorMs, weekStartsOn), [anchorMs, weekStartsOn]);
  const month = new Date(anchorMs).getMonth();
  const [focusedKey, setFocusedKey] = useState(() => dayKey(nowMs));
  const effectiveFocusedKey = days.some((dayMs) => dayKey(dayMs) === focusedKey)
    ? focusedKey
    : dayKey(days[0] ?? anchorMs);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Arrow-key travel past the grid edge re-anchors the month; the target cell
  // only exists after the re-render, so focus it in an effect.
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    if (pendingFocus.current === null) return;
    const key = pendingFocus.current;
    pendingFocus.current = null;
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${key}"]`)?.focus();
  });

  // Close the "+N more" popover on any outside press.
  useEffect(() => {
    if (openKey === null) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.(".sui-cal-popover, .sui-cal-more")) setOpenKey(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openKey]);

  function focusDay(key: string, targetMs: number, visible: number[]) {
    setFocusedKey(key);
    if (visible.some((dayMs) => dayKey(dayMs) === key)) {
      gridRef.current?.querySelector<HTMLElement>(`[data-date="${key}"]`)?.focus();
    } else {
      pendingFocus.current = key;
      onNavigate?.(targetMs);
    }
  }

  function onGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      if (openKey !== null) {
        event.preventDefault();
        setOpenKey(null);
      }
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.getAttribute("role") !== "gridcell") return;
    const dateAttr = target.getAttribute("data-date");
    if (!dateAttr) return;
    const focusedMs = Date.parse(`${dateAttr}T00:00:00`);
    if (Number.isNaN(focusedMs)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSlotClick?.(focusedMs);
      return;
    }
    if (!DAY_KEYS.has(event.key)) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -7 : 7;
    // Home and End move within the VISIBLE row, and the grid is laid out with
    // `monthGridDays(anchorMs, weekStartsOn)`. Computing the row bounds from
    // the raw weekday always targeted Sunday and Saturday, so in a Monday-first
    // grid Home jumped to the previous visual row.
    const column = (new Date(focusedMs).getDay() - weekStartsOn + 7) % 7;
    const next =
      event.key === "Home"
        ? addDays(focusedMs, -column)
        : event.key === "End"
          ? addDays(focusedMs, 6 - column)
          : addDays(focusedMs, delta);
    focusDay(dayKey(next), next, days);
  }

  const weeks: number[][] = [];
  for (let row = 0; row < 6; row += 1) weeks.push(days.slice(row * 7, row * 7 + 7));

  return (
    <div ref={gridRef} role="grid" aria-label={monthLabel(anchorMs)} className="sui-cal-grid" onKeyDown={onGridKeyDown}>
      {days.slice(0, 7).map((dayMs) => (
        <div key={`h-${dayMs}`} role="columnheader" className="sui-cal-weekday">
          {weekdayLabel(dayMs)}
        </div>
      ))}
      {weeks.flatMap((week, row) =>
        week.map((dayMs, col) => {
          const key = dayKey(dayMs);
          const dayEvents = eventsOnDay(events, dayMs);
          const visible = dayEvents.slice(0, maxChipsPerDay);
          const overflow = dayEvents.length - visible.length;
          return (
            <div
              key={key}
              role="gridcell"
              tabIndex={key === effectiveFocusedKey ? 0 : -1}
              data-date={key}
              data-today={isSameDay(dayMs, nowMs) || undefined}
              data-outside={new Date(dayMs).getMonth() !== month || undefined}
              aria-label={fullDayLabel(dayMs)}
              className="sui-cal-day"
              onFocus={() => setFocusedKey(key)}
              onClick={() => {
                setFocusedKey(key);
                onSlotClick?.(dayMs);
              }}
            >
              <span className="sui-cal-day-num">{new Date(dayMs).getDate()}</span>
              {visible.map((event) => (
                <EventChip key={event.id} event={event} onEventClick={onEventClick} />
              ))}
              {overflow > 0 ? (
                <button
                  type="button"
                  className="sui-cal-more"
                  aria-expanded={openKey === key}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenKey(openKey === key ? null : key);
                  }}
                >
                  +{overflow} more
                </button>
              ) : null}
              {openKey === key ? (
                <div
                  role="dialog"
                  aria-label={fullDayLabel(dayMs)}
                  className="sui-cal-popover"
                  data-align={col >= 5 ? "end" : undefined}
                  data-placement={row >= 4 ? "up" : undefined}
                >
                  <div className="sui-cal-popover-label">{fullDayLabel(dayMs)}</div>
                  {dayEvents.map((event) => (
                    <EventChip key={event.id} event={event} onEventClick={onEventClick} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        }),
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Week                                                                        */
/* -------------------------------------------------------------------------- */

function WeekView({ anchorMs, events, nowMs, weekStartsOn, onEventClick, onSlotClick }: CalendarViewProps) {
  const days = useMemo(() => weekDays(anchorMs, weekStartsOn), [anchorMs, weekStartsOn]);

  function onColumnClick(dayMs: number, event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (!onSlotClick) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = snapDown30(((event.clientY - rect.top) / HOUR_PX) * 60);
    // The rows are wall-clock hours, so the offset is a wall clock, not elapsed time.
    onSlotClick(atMinutesIntoDay(dayMs, Math.min(Math.max(minutes, 0), 24 * 60 - 30)));
  }

  return (
    <div className="sui-cal-week">
      <div className="sui-cal-week-scroll">
        <div className="sui-cal-week-inner">
          <div className="sui-cal-week-head">
            <div className="sui-cal-week-corner" aria-hidden />
            {days.map((dayMs) => (
              <button
                key={dayMs}
                type="button"
                className="sui-cal-week-day"
                data-today={isSameDay(dayMs, nowMs) || undefined}
                aria-label={fullDayLabel(dayMs)}
                onClick={() => onSlotClick?.(dayMs)}
              >
                <span className="sui-cal-week-day-label">{weekdayLabel(dayMs)}</span>
                <span className="sui-cal-week-day-num">{new Date(dayMs).getDate()}</span>
              </button>
            ))}
          </div>
          <div className="sui-cal-week-allday">
            <div className="sui-cal-week-allday-label">all-day</div>
            {days.map((dayMs) => (
              <div key={dayMs} className="sui-cal-week-allday-cell">
                {eventsOnDay(events, dayMs)
                  .filter((event) => event.allDay)
                  .map((event) => (
                    <EventChip key={event.id} event={event} onEventClick={onEventClick} />
                  ))}
              </div>
            ))}
          </div>
          <div className="sui-cal-week-body" style={{ height: WEEK_BODY_HEIGHT }}>
            <div className="sui-cal-week-gutter" aria-hidden>
              {Array.from({ length: 24 }, (_, hour) => (
                <span key={hour} className="sui-cal-week-hour" style={{ top: hour * HOUR_PX }}>
                  {hour === 0 ? "" : hourLabel(hour)}
                </span>
              ))}
            </div>
            {days.map((dayMs) => {
              // An overnight or multi-day event renders one segment in every day it covers.
              const timed = events
                .filter((event) => !event.allDay)
                .flatMap((event) => {
                  const segment = daySegment(event, dayMs);
                  return segment ? [{ event, segment }] : [];
                })
                .sort((a, b) => a.event.start - b.event.start || a.event.title.localeCompare(b.event.title));
              const isToday = isSameDay(dayMs, nowMs);
              return (
                // Click targets the column backdrop only; chips stopPropagation.
                // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
                <div key={dayMs} className="sui-cal-week-col" onClick={(event) => onColumnClick(dayMs, event)}>
                  {timed.map(({ event, segment }) => {
                    const startMin = snapDown30(segment.startMin);
                    const endMin = snapUp30(segment.endMin);
                    const height = Math.max(endMin - startMin, 30);
                    return eventElement(
                      event,
                      onEventClick,
                      {
                        className: "sui-cal-week-event",
                        "data-tint": event.color ? undefined : tintFor(event),
                        "data-continues-before": segment.continuesBefore || undefined,
                        "data-continues-after": segment.continuesAfter || undefined,
                        style: {
                          top: (startMin / 60) * HOUR_PX,
                          height: (height / 60) * HOUR_PX,
                          ...colorStyle(event),
                        },
                      },
                      <>
                        <span className="sui-cal-week-event-title">{event.title}</span>
                        <span className="sui-cal-week-event-time">
                          {timeLabel(event.start)}
                          {event.end !== undefined ? ` – ${timeLabel(event.end)}` : ""}
                        </span>
                      </>,
                    );
                  })}
                  {isToday ? (
                    <div className="sui-cal-now-line" style={{ top: (minutesIntoDay(nowMs) / 60) * HOUR_PX }} />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Agenda                                                                      */
/* -------------------------------------------------------------------------- */

function agendaDayLabel(dayMs: number, nowMs: number): string {
  if (isSameDay(dayMs, nowMs)) return "Today";
  if (isSameDay(dayMs, addDays(nowMs, 1))) return "Tomorrow";
  return new Date(dayMs).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function AgendaView({
  anchorMs,
  events,
  nowMs,
  onEventClick,
  emptyMessage,
}: CalendarViewProps & { emptyMessage?: ReactNode }) {
  const upcoming = events.filter((event) => event.start >= startOfDay(anchorMs));
  const groups = agendaGroups(upcoming);
  if (groups.length === 0) {
    return <EmptyState description={emptyMessage ?? "No events."} />;
  }
  return (
    <div className="sui-cal-agenda" role="list" aria-label="Agenda">
      {groups.map((group) => (
        <section key={dayKey(group.dayMs)} className="sui-cal-agenda-day" aria-label={fullDayLabel(group.dayMs)}>
          <div className="sui-cal-agenda-day-label">{agendaDayLabel(group.dayMs, nowMs)}</div>
          {group.events.map((event) => {
            const isRecentPast = !event.allDay && event.start <= nowMs && nowMs - event.start < 24 * 3_600_000;
            const href = event.href === undefined ? undefined : safeHref(event.href);
            const row = (
              <>
                <span className="sui-cal-agenda-time">
                  {event.allDay ? "All day" : isRecentPast ? <RelativeTime ts={event.start} /> : timeLabel(event.start)}
                </span>
                {statusDot(event)}
                <span className="sui-cal-agenda-title" title={event.title}>
                  {event.title}
                </span>
                {event.source ? (
                  <span className="sui-cal-agenda-source" title={event.source}>
                    {event.source}
                  </span>
                ) : null}
              </>
            );
            return href !== undefined && !onEventClick ? (
              <a key={event.id} role="listitem" className="sui-cal-agenda-row" href={href}>
                {row}
              </a>
            ) : (
              <button
                key={event.id}
                role="listitem"
                type="button"
                className="sui-cal-agenda-row"
                onClick={() => onEventClick?.(event)}
              >
                {row}
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Calendar                                                                    */
/* -------------------------------------------------------------------------- */

export type CalendarProps = ComponentProps<"div"> & {
  events: CalendarEvent[];
  /** Controlled view. */
  view?: CalendarView;
  defaultView?: CalendarView;
  onViewChange?: (view: CalendarView) => void;
  /** Controlled anchor date (epoch ms anywhere inside the visible month/week). */
  date?: number;
  defaultDate?: number;
  onDateChange?: (date: number) => void;
  onEventClick?: (event: CalendarEvent) => void;
  /**
   * Fired with the day-start (month) or 30-minute-snapped local time (week) of
   * an empty-slot click. The week time is the row's wall clock: on a
   * daylight-saving transition day a slot inside the spring-forward gap resolves
   * to the instant the clock jumps to, and a slot inside the autumn fall-back
   * hour resolves to its first occurrence.
   */
  onSlotClick?: (date: number) => void;
  /** getDay()-style index of the first column (0 = Sunday, default). */
  weekStartsOn?: number;
  /** Injectable "now" for tests and SSR determinism; defaults to a 1-minute ticker. */
  now?: number;
  /** Max event chips per month cell before the "+N more" popover (default 3). */
  maxChipsPerDay?: number;
  /** Agenda-view zero-events message. */
  emptyMessage?: ReactNode;
};

/**
 * Google-Calendar-style month / week / agenda widget. Purely presentational:
 * the host supplies already-expanded {@link CalendarEvent}s and receives
 * click intents back. The week view doubles as a day view at narrow widths
 * (the time grid scrolls horizontally). Keyboard: arrows move the focused
 * month-grid day, Enter opens the slot, Esc closes the overflow popover.
 */
export function Calendar({
  events,
  view,
  defaultView,
  onViewChange,
  date,
  defaultDate,
  onDateChange,
  onEventClick,
  onSlotClick,
  weekStartsOn = 0,
  now,
  maxChipsPerDay = 3,
  emptyMessage,
  className,
  ...props
}: CalendarProps) {
  useInjectUiCss();

  const [nowState, setNowState] = useState(() => now ?? Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const id = setInterval(() => setNowState(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [now]);
  const nowMs = now ?? nowState;

  const [viewState, setViewState] = useState<CalendarView>(defaultView ?? "month");
  const activeView = view ?? viewState;
  const [anchorState, setAnchorState] = useState(() => defaultDate ?? startOfDay(now ?? Date.now()));
  const anchorMs = date ?? anchorState;

  function selectView(next: CalendarView) {
    setViewState(next);
    onViewChange?.(next);
  }

  function shiftAnchor(next: number) {
    setAnchorState(next);
    onDateChange?.(next);
  }

  function shift(direction: -1 | 1) {
    if (activeView === "month") shiftAnchor(addMonths(anchorMs, direction));
    else shiftAnchor(addDays(anchorMs, direction * 7));
  }

  const label =
    activeView === "month"
      ? monthLabel(anchorMs)
      : activeView === "week"
        ? weekLabel(weekDays(anchorMs, weekStartsOn))
        : "Agenda";

  const viewProps: CalendarViewProps = {
    anchorMs,
    events,
    nowMs,
    weekStartsOn,
    maxChipsPerDay,
    onEventClick,
    onSlotClick,
    onNavigate: shiftAnchor,
  };

  return (
    <div data-slot="calendar" className={cn("sui-cal", className)} {...props}>
      <div className="sui-cal-header">
        <div className="sui-cal-title" aria-live="polite">
          {label}
        </div>
        <div className="sui-cal-controls">
          <Button variant="outline" size="sm" aria-label="Previous" onClick={() => shift(-1)}>
            ‹
          </Button>
          <Button variant="outline" size="sm" onClick={() => shiftAnchor(startOfDay(nowMs))}>
            Today
          </Button>
          <Button variant="outline" size="sm" aria-label="Next" onClick={() => shift(1)}>
            ›
          </Button>
          <div className="sui-cal-segment" role="group" aria-label="Calendar view">
            {VIEWS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className="sui-cal-segment-button"
                data-active={candidate === activeView || undefined}
                aria-pressed={candidate === activeView}
                onClick={() => selectView(candidate)}
              >
                {candidate[0]!.toUpperCase() + candidate.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>
      {activeView === "month" ? <MonthView {...viewProps} /> : null}
      {activeView === "week" ? <WeekView {...viewProps} /> : null}
      {activeView === "agenda" ? <AgendaView {...viewProps} emptyMessage={emptyMessage} /> : null}
    </div>
  );
}
