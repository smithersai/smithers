/** @jsxImportSource react */
import { useMemo, useSyncExternalStore, type ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { dateFromMs } from "./dateFromMs";
import { formatRelativeTime } from "./formatRelativeTime";

/**
 * Shared interval store: every mounted RelativeTime/useRelativeTime follows
 * ONE interval (ref-counted; cleared when the last subscriber unmounts)
 * instead of each owning a private timer. Each tick records its instant, so
 * every label read between two ticks is computed against the same now.
 *
 * The period is one second because {@link formatRelativeTime} has one-second
 * granularity below a minute: a longer period would render a label that is
 * visibly wrong for as long as the period lasts. The saving this store exists
 * for is having ONE timer for a page of timestamps, not a long one.
 */
export const TICK_MS = 1_000;
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;
/** The instant of the latest tick: every label read between two ticks is computed against it. */
let tickNow = Date.now();

function subscribeRelativeTime(listener: () => void): () => void {
  listeners.add(listener);
  if (intervalId === null) {
    tickNow = Date.now();
    intervalId = setInterval(() => {
      tickNow = Date.now();
      for (const listener of listeners) listener();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

/** The tick's instant while the interval runs; the current one before anything subscribed. */
function nowForLabels(): number {
  return intervalId === null ? Date.now() : tickNow;
}

/**
 * `formatRelativeTime(ts)` that follows the shared {@link TICK_MS} tick. The label itself is the store's snapshot, so a
 * tick re-renders only the components whose label changed: a page of thousands of rows older than a day (an issue
 * list) re-rendered every one of them each second, and on 2026-10-31 that kept the browser's main thread busy for two
 * thirds of every second, so a settled chat answer waited minutes to show.
 */
export function useRelativeTime(ts: number): string {
  const label = () => formatRelativeTime(ts, nowForLabels());
  return useSyncExternalStore(subscribeRelativeTime, label, label);
}

export type RelativeTimeProps = Omit<ComponentProps<"time">, "children" | "dateTime"> & {
  /** Unix epoch milliseconds. */
  ts: number;
  /** Hover title override; defaults to the full locale date+time string. */
  title?: string;
  /** Switch to an absolute locale time after this many milliseconds. */
  relativeUntilMs?: number;
};

/**
 * Ticking relative timestamp ("3m ago") with the absolute instant in
 * `dateTime`/`title`. Tabular-nums keeps the label from jittering as it ticks.
 */
export function RelativeTime({ ts, title, relativeUntilMs, className, ...props }: RelativeTimeProps) {
  useInjectUiCss();
  const label = useRelativeTime(ts);
  // `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`,
  // which would take down the whole render for one bad row. A timestamp
  // outside the representable range simply has no absolute instant to state.
  const date = useMemo(() => dateFromMs(ts), [ts]);
  // The absolute instant only changes with `ts`, never with the tick: formatted once, not on every render.
  const absolute = useMemo(
    () => date === undefined ? undefined : { dateTime: date.toISOString(), title: date.toLocaleString() },
    [date],
  );
  const display = date !== undefined && relativeUntilMs !== undefined && Date.now() - ts >= relativeUntilMs
    ? date.toLocaleTimeString(undefined, { timeStyle: "medium" })
    : label;
  return (
    <time
      data-slot="relative-time"
      className={cn("sui-relative-time", className)}
      {...(absolute !== undefined
        ? { dateTime: absolute.dateTime, title: title ?? absolute.title }
        : title === undefined
        ? {}
        : { title })}
      {...props}
    >
      {display}
    </time>
  );
}
