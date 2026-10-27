/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Button } from "../button";
import { cn } from "../cn";
import { JsonValue } from "../json-value/JsonValue";
import type { JsonValueData } from "../json-value/jsonValueText";
import { useInjectUiCss } from "../styles";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../table";
import { dateFromMs } from "../time/dateFromMs";
import { offsetWords } from "./runPage";

const eventWords: Readonly<Record<string, string>> = {
  "flows.engine.run-decision": "Run updated",
  "flows.engine.plan-recorded": "Steps planned",
  "flows.engine.node-scheduled": "Step queued",
  "flows.engine.node-settled": "Step finished",
  "flows.engine.attempt-started": "Attempt started",
  "flows.engine.attempt-finished": "Attempt finished",
  "flows.time-travel.effect-boundary": "Step recorded",
  "telemetry.log": "Log recorded",
};

/** One journal record: its sequence, type, when it was written, and its payload as text. */
export interface JournalRow {
  readonly seq: number;
  readonly eventType: string;
  readonly emittedAtMs: number;
  readonly payload: JsonValueData;
}

export type RunJournalProps = Omit<ComponentProps<"div">, "children"> & {
  events: ReadonlyArray<JournalRow>;
  /** Where times count from, such as the run's start. Default: the first record's time. */
  originMs?: number;
  hasMore?: boolean;
  onMore?: () => void;
};

/**
 * The run's journal as a table: sequence, type, time from the run's start,
 * and the payload, collapsed. `More` reads the next page when there is one.
 */
export function RunJournal({ events, originMs, hasMore = false, onMore, className, ...props }: RunJournalProps) {
  useInjectUiCss();
  const origin = originMs ?? events[0]?.emittedAtMs ?? 0;
  return (
    <div data-slot="run-journal" className={cn("sui-run-journal", className)} {...props}>
      <Table aria-label="Journal">
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Time</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => {
            const date = dateFromMs(event.emittedAtMs);
            return (
              <TableRow key={event.seq} data-seq={event.seq}>
                <TableCell className="sui-run-journal-seq">{event.seq}</TableCell>
                <TableCell className="sui-run-journal-type"><details><summary>{eventWords[event.eventType] ?? "Activity"}</summary><code>{event.eventType}</code></details></TableCell>
                <TableCell className="sui-run-journal-time">
                  <time {...(date === undefined ? {} : { dateTime: date.toISOString(), title: date.toLocaleString() })}>
                    {offsetWords(event.emittedAtMs, origin)}
                  </time>
                </TableCell>
                <TableCell>
                  <JsonValue label="Payload" value={event.payload} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {hasMore && onMore !== undefined ? (
        <Button variant="outline" size="sm" className="sui-run-journal-more" onClick={onMore}>
          More
        </Button>
      ) : null}
    </div>
  );
}
