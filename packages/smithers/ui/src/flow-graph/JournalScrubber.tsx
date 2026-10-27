/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Button } from "../button";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
export interface JournalTick { readonly seq: number; readonly emittedAtMs: number; readonly eventType: string; }
export const journalPosition = (events: ReadonlyArray<JournalTick>, at: number | null, direction: -1 | 1, byStep = false): number => {
  const current = at ?? events.at(-1)?.seq ?? 0;
  const choices = events.filter((e) => !byStep || /node-(scheduled|settled)$/.test(e.eventType));
  return (direction === -1 ? [...choices].reverse().find((e) => e.seq < current) : choices.find((e) => e.seq > current))?.seq ?? current;
};
export type JournalScrubberProps = Omit<ComponentProps<"div">, "onChange" | "children"> & {
  events: ReadonlyArray<JournalTick>;
  at: number | null;
  onChange: (at: number | null) => void;
};
/** Read-only navigation. Null means live; the last recorded event remains replayable. */
export function JournalScrubber({ events, at, onChange, className, ...props }: JournalScrubberProps) {
  useInjectUiCss();
  const index = at === null ? events.length : events.filter((e) => e.seq <= at).length;
  return <div className={cn("sui-journal-scrubber", className)} data-slot="journal-scrubber" data-live={at === null} {...props}>
    <Button variant="ghost" size="sm" aria-label="Previous event" disabled={events.length === 0} onClick={() => onChange(journalPosition(events, at, -1))}>[</Button>
    <div className="sui-journal-scrubber-track">
      <div className="sui-journal-ticks" aria-hidden>{events.map((e, i) => <span key={e.seq} title={e.eventType} style={{ left: `${(i + 1) / events.length * 100}%` }} />)}</div>
      <input type="range" aria-label="Journal position" min={0} max={events.length} value={index} disabled={events.length === 0}
        onInput={(event) => onChange(events[Number(event.currentTarget.value) - 1]?.seq ?? (events[0] === undefined ? 0 : events[0].seq - 1))} />
    </div>
    <Button variant="ghost" size="sm" aria-label="Next event" disabled={events.length === 0} onClick={() => onChange(journalPosition(events, at, 1))}>]</Button>
    <output aria-live="polite">{at === null ? "" : `#${at}`}</output>
    <Button variant={at === null ? "secondary" : "ghost"} size="sm" onClick={() => onChange(null)} aria-pressed={at === null}>Live</Button>
  </div>;
}
