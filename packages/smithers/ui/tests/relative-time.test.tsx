/** @jsxImportSource react */
// The relative-time label and its shared interval store. Both were largely
// uncovered: the interval creation, fan-out and ref-counted teardown had no
// test, and neither did the label's own boundaries.
import { afterEach, describe, expect, test } from "bun:test";
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { formatRelativeTime } from "../src/time/formatRelativeTime";
import { RelativeTime, TICK_MS, useRelativeTime } from "../src/time/RelativeTime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const containers: HTMLElement[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const container of containers.splice(0)) container.remove();
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
}

const NOW = Date.parse("2026-07-01T12:00:00.000Z");

describe("formatRelativeTime boundaries", () => {
  test("each boundary renders the documented shape", () => {
    const label = (deltaMs: number) => formatRelativeTime(NOW - deltaMs, NOW);
    expect(label(0)).toBe("just now");
    expect(label(999)).toBe("just now");
    expect(label(1_000)).toBe("1s ago");
    expect(label(59_999)).toBe("59s ago");
    expect(label(60_000)).toBe("1m ago");
    expect(label(3_599_999)).toBe("59m ago");
    expect(label(3_600_000)).toBe("1h ago");
    expect(label(8_040_000)).toBe("2h 14m ago");
    expect(label(86_399_999)).toBe("23h 59m ago");
  });

  test("a future timestamp clamps to just now, as the clock-skew note promises", () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("just now");
  });

  test("beyond a day the label is absolute, not relative", () => {
    const absolute = formatRelativeTime(NOW - 86_400_000, NOW);
    expect(absolute).not.toContain("ago");
    expect(absolute).toContain(",");
  });

  test("a non-representable timestamp says so instead of rendering Invalid Date", () => {
    expect([Number.NaN, Number.POSITIVE_INFINITY, 9e15].map((ts) => formatRelativeTime(ts, NOW))).toEqual([
      "unknown time",
      "unknown time",
      "unknown time",
    ]);
  });
});

describe("the shared tick store", () => {
  test("two mounted components share one interval and release it on the last unmount", async () => {
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    const created: number[] = [];
    let cleared = 0;
    (globalThis as { setInterval: typeof setInterval }).setInterval = ((fn: () => void, ms: number) => {
      created.push(ms);
      return originalSet(fn, ms);
    }) as typeof setInterval;
    (globalThis as { clearInterval: typeof clearInterval }).clearInterval = ((id: number) => {
      cleared += 1;
      return originalClear(id);
    }) as typeof clearInterval;
    try {
      function Probe() {
        return <span>{useRelativeTime(NOW)}</span>;
      }
      const first = createRoot(document.body.appendChild(document.createElement("div")));
      const second = createRoot(document.body.appendChild(document.createElement("div")));
      await act(async () => first.render(<Probe />));
      await act(async () => second.render(<Probe />));
      expect(created).toEqual([TICK_MS]);
      expect(cleared).toBe(0);

      await act(async () => first.unmount());
      expect(cleared).toBe(0);
      await act(async () => second.unmount());
      expect(cleared).toBe(1);

      // A later mount opens a fresh interval rather than reusing a dead one.
      const third = createRoot(document.body.appendChild(document.createElement("div")));
      await act(async () => third.render(<Probe />));
      expect(created).toEqual([TICK_MS, TICK_MS]);
      await act(async () => third.unmount());
    } finally {
      (globalThis as { setInterval: typeof setInterval }).setInterval = originalSet;
      (globalThis as { clearInterval: typeof clearInterval }).clearInterval = originalClear;
    }
  });

  test("the label advances when the interval fires", async () => {
    const container = await render(<RelativeTime ts={Date.now() - 1_500} />);
    const time = container.querySelector("time")!;
    expect(time.textContent).toBe("1s ago");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, TICK_MS + 200));
    });
    expect(time.textContent).toBe("2s ago");
  }, 10_000);
});

describe("a tick re-renders only labels that changed", () => {
  // Production 2026-10-31: a branch page mounted 7,726 RelativeTimes (7,680 issue rows), every one re-rendered each
  // second though rows older than a day never change; the idle page's main thread was busy 6.7 s of every 10.3 s and a
  // settled chat answer took minutes to show.
  test("a day-old timestamp renders once across ticks; a seconds-old one renders each tick", async () => {
    const commits = { old: 0, fresh: 0 };
    const count = (id: string) => () => { commits[id as keyof typeof commits] += 1; };
    await render(
      <>
        <Profiler id="old" onRender={count("old")}><RelativeTime ts={Date.now() - 2 * 86_400_000} /></Profiler>
        <Profiler id="fresh" onRender={count("fresh")}><RelativeTime ts={Date.now() - 1_500} /></Profiler>
      </>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2 * TICK_MS + 300));
    });
    expect(commits.old).toBe(1);
    expect(commits.fresh).toBeGreaterThanOrEqual(3);
  }, 10_000);
});

describe("RelativeTime markup", () => {
  test("a representable timestamp carries dateTime and a title", async () => {
    const container = await render(<RelativeTime ts={NOW} />);
    const time = container.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe(new Date(NOW).toISOString());
    expect(time.getAttribute("title")).toBe(new Date(NOW).toLocaleString());
  });

  test("a NaN timestamp renders without throwing and states no instant", async () => {
    const container = await render(<RelativeTime ts={Number.NaN} />);
    const time = container.querySelector("time")!;
    expect(time.textContent).toBe("unknown time");
    expect(time.getAttribute("datetime")).toBeNull();
    expect(time.getAttribute("title")).toBeNull();
  });

  test("relativeUntilMs switches to an absolute clock time", async () => {
    const container = await render(<RelativeTime ts={Date.now() - 10_000} relativeUntilMs={1_000} />);
    expect(container.querySelector("time")!.textContent).not.toContain("ago");
  });
});
