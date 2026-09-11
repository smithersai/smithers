import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Calendar } from "../src/calendar/Calendar";
import { calendarCss } from "../src/calendar/calendarCss";
import { smithersUiCss } from "../src/uiCss";
import type { CalendarEvent } from "../src/calendar/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Monday, July 27 2026, 12:00 local — fixed "now" for deterministic markup.
const NOW = new Date(2026, 6, 27, 12, 0).getTime();

function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 6, day, hour, minute).getTime();
}

function event(id: string, start: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, title: `Event ${id}`, start, ...extra };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Calendar month view", () => {
  test("renders a 6x7 grid with columnheaders, today highlight, and muted adjacent months", () => {
    const html = renderToStaticMarkup(<Calendar events={[]} now={NOW} />);
    expect(html).toContain('data-slot="calendar"');
    expect(html).toContain('role="grid"');
    expect(count(html, 'role="columnheader"')).toBe(7);
    expect(count(html, 'role="gridcell"')).toBe(42);
    expect(html).toContain("2026");
    expect(html).toContain('data-today="true"');
    expect(html).toContain('data-outside="true"');
    expect(html).toContain('aria-label="Previous"');
    expect(html).toContain(">Today</button>");
  });

  test("caps a day at 3 chips plus a '+N more' affordance, popover closed by default", () => {
    const events = [0, 1, 2, 3, 4].map((i) => event(`e${i}`, at(27, 9 + i)));
    const html = renderToStaticMarkup(<Calendar events={events} now={NOW} />);
    expect(count(html, 'class="sui-cal-chip"')).toBe(3);
    expect(html).toContain("+2 more");
    expect(html).not.toContain("sui-cal-popover");
  });

  test("event chips carry the status dot, source tint, and full-title tooltip", () => {
    const html = renderToStaticMarkup(
      <Calendar events={[event("a", at(27, 9), { source: "implement", status: "failed" })]} now={NOW} />,
    );
    expect(html).toContain("sui-cal-chip-dot");
    expect(html).toContain("data-tint=");
    expect(html).toContain("Event a");
    expect(html).toContain("title=");
  });

  test("explicit color overrides the tint rotation", () => {
    const html = renderToStaticMarkup(
      <Calendar events={[event("a", at(27, 9), { source: "x", color: "var(--info, #3f66ba)" })]} now={NOW} />,
    );
    expect(html).not.toContain('data-tint="brand"');
    expect(html).toContain("color-mix(in srgb");
  });

  test("header navigation uses the shared Button component (data-slot, sm size, outline look)", () => {
    const html = renderToStaticMarkup(<Calendar events={[]} now={NOW} />);
    // The shared Button renders data-slot="button"; the previous hand-rolled
    // class-string buttons did not.
    expect(count(html, 'data-slot="button"')).toBe(3);
    expect(count(html, "sui-button-sm")).toBe(3);
    expect(count(html, "sui-button-outline")).toBe(3);
    expect(html).toContain('aria-label="Previous"');
    expect(html).toContain('aria-label="Next"');
    expect(html).toContain(">Today</button>");
  });

  test("className and style overrides land on the root", () => {
    const html = renderToStaticMarkup(<Calendar events={[]} now={NOW} className="my-cal" style={{ maxWidth: 640 }} />);
    expect(html).toContain("my-cal");
    expect(html).toContain("max-width:640px");
  });

  test("keeps one tabbable day when a controlled date moves to another month", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<Calendar events={[]} now={NOW} date={at(27, 0)} />);
      });
      await act(async () => {
        root.render(<Calendar events={[]} now={NOW} date={new Date(2026, 8, 15).getTime()} />);
      });
      expect(container.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test("event clicks do not also trigger the containing day", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let eventClicks = 0;
    let dayClicks = 0;
    try {
      await act(async () => {
        root.render(
          <Calendar
            events={[event("a", at(27, 9))]}
            now={NOW}
            onEventClick={() => {
              eventClicks += 1;
            }}
            onSlotClick={() => {
              dayClicks += 1;
            }}
          />,
        );
      });
      await act(async () => {
        (container.querySelector(".sui-cal-chip") as HTMLButtonElement).click();
      });
      expect(eventClicks).toBe(1);
      expect(dayClicks).toBe(0);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("Calendar week view", () => {
  test("renders the time grid, all-day lane, positioned events, and the now-line", () => {
    const events = [event("timed", at(27, 9), { end: at(27, 10, 30) }), event("allday", at(28, 0), { allDay: true })];
    const html = renderToStaticMarkup(<Calendar events={events} view="week" now={NOW} />);
    expect(html).toContain("sui-cal-week-body");
    expect(html).toContain("sui-cal-week-allday-cell");
    // 9:00 -> top 396px (9h * 44px); 90 minutes -> 66px tall.
    expect(html).toContain("top:396px");
    expect(html).toContain("height:66px");
    // now-line at 12:00 -> 528px, danger hairline + dot.
    expect(html).toContain("sui-cal-now-line");
    expect(html).toContain("top:528px");
    // The all-day event renders in the all-day lane, not the time grid.
    expect(html).toContain("all-day");
    expect(count(html, 'sui-cal-week-event"')).toBe(1);
  });

  test("splits an overnight event at local midnight into one segment per day", () => {
    // Tue 23:00 -> Wed 02:00: 60 minutes on Tuesday, 120 minutes on Wednesday.
    const html = renderToStaticMarkup(
      <Calendar events={[event("night", at(28, 23), { end: at(29, 2) })]} view="week" now={NOW} />,
    );
    const segments = html.match(/<button[^>]*sui-cal-week-event"[^>]*>/g) ?? [];
    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain("top:1012px;height:44px");
    expect(segments[0]).toContain('data-continues-after="true"');
    expect(segments[0]).not.toContain("data-continues-before");
    expect(segments[1]).toContain("top:0;height:88px");
    expect(segments[1]).toContain('data-continues-before="true"');
    expect(segments[1]).not.toContain("data-continues-after");
  });

  test("renders a full-height middle segment for a three-day event", () => {
    // Tue 20:00 -> Thu 04:00: Tuesday 4h, Wednesday all 24h, Thursday 4h.
    const html = renderToStaticMarkup(
      <Calendar events={[event("long", at(28, 20), { end: at(30, 4) })]} view="week" now={NOW} />,
    );
    const segments = html.match(/<button[^>]*sui-cal-week-event"[^>]*>/g) ?? [];
    expect(segments).toHaveLength(3);
    expect(segments[0]).toContain("top:880px;height:176px");
    expect(segments[1]).toContain("top:0;height:1056px");
    expect(segments[1]).toContain('data-continues-before="true"');
    expect(segments[1]).toContain('data-continues-after="true"');
    expect(segments[2]).toContain("top:0;height:176px");
  });

  test("omits the now-line when today is outside the visible week", () => {
    const html = renderToStaticMarkup(
      <Calendar events={[]} view="week" now={NOW} date={at(27, 0) + 14 * 86_400_000} />,
    );
    expect(html).not.toContain("sui-cal-now-line");
  });
});

describe("Calendar agenda view", () => {
  test("groups chronologically by day with RelativeTime for the recent past", () => {
    const events = [
      event("past", NOW - 3 * 60_000),
      event("soon", at(28, 9), { source: "implement" }),
      event("later", at(30, 14)),
    ];
    const html = renderToStaticMarkup(<Calendar events={events} view="agenda" now={NOW} />);
    expect(html).toContain("sui-cal-agenda");
    expect(html).toContain("Today");
    expect(html).toContain("Tomorrow");
    // The recent-past row uses the shared ticking RelativeTime (real clock label).
    expect(html).toContain("sui-relative-time");
    expect(html).toContain("implement");
  });

  test("empty agenda renders the empty state", () => {
    const html = renderToStaticMarkup(
      <Calendar events={[]} view="agenda" now={NOW} emptyMessage="Nothing scheduled." />,
    );
    expect(html).toContain("sui-empty");
    expect(html).toContain("Nothing scheduled.");
  });

  test("events before the anchor day are hidden", () => {
    const html = renderToStaticMarkup(<Calendar events={[event("old", at(20, 9))]} view="agenda" now={NOW} />);
    expect(html).not.toContain("Event old");
  });
});

describe("Calendar event links", () => {
  test("unsafe hrefs render as buttons in month, week, and agenda views", () => {
    for (const view of ["month", "week", "agenda"] as const) {
      for (const href of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "java\nscript:alert(1)"]) {
        const html = renderToStaticMarkup(
          <Calendar events={[event("unsafe", at(27, 13), { href })]} view={view} now={NOW} />,
        );
        expect(html).not.toContain("<a");
        expect(html).not.toContain("href=");
        expect(html).toContain("<button");
        expect(html).toContain("Event unsafe");
      }
    }
  });

  test("https hrefs render as links in month, week, and agenda views", () => {
    for (const view of ["month", "week", "agenda"] as const) {
      const html = renderToStaticMarkup(
        <Calendar events={[event("safe", at(27, 13), { href: "https://example.com/event" })]} view={view} now={NOW} />,
      );
      expect(html).toContain("<a");
      expect(html).toContain('href="https://example.com/event"');
      expect(html).toContain("Event safe");
    }
  });
});

describe("calendarCss", () => {
  test("is composed into the shipped stylesheet before the reduced-motion policy", () => {
    expect(smithersUiCss).toContain(".sui-cal-grid");
    expect(smithersUiCss).toContain(".sui-cal-now-line");
    expect(smithersUiCss.indexOf(calendarCss.trim())).toBeGreaterThan(-1);
    expect(smithersUiCss.indexOf(calendarCss.trim())).toBeLessThan(smithersUiCss.indexOf("prefers-reduced-motion"));
  });

  test("stays on the sui- namespace", () => {
    const classes = calendarCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(10);
    for (const cls of classes) expect(cls.startsWith(".sui-cal")).toBe(true);
  });
});
