/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "../cn";
import type { JsonValueData } from "../json-value/jsonValueText";
import { useInjectUiCss } from "../styles";
import { stepLogLines, stepLogTime } from "./stepLogLines";

export type StepLogsProps = Omit<ComponentProps<"ol">, "children"> & {
  /** The step's log values as the host hands them over: `telemetry.log` payloads or printed text. */
  lines: ReadonlyArray<JsonValueData>;
  /** The presentation clock; a line from another day shows its date. */
  now: number;
};

/** A step's log read like a CI log: time, level, message, then `key=value` fields. Renders nothing when empty. */
export function StepLogs({ lines, now, className, ...props }: StepLogsProps) {
  useInjectUiCss();
  const rows = stepLogLines(lines);
  if (rows.length === 0) return null;
  return <ol aria-label="Logs" data-slot="step-logs" className={cn("sui-step-logs", className)} {...props}>
    {rows.map((row, i) => row.kind === "attempt"
      ? <li key={i} data-kind="attempt">Attempt {row.attempt}</li>
      : row.kind === "text"
      ? <li key={i} data-kind="text">{row.text}</li>
      : <li key={i} data-kind="record" data-level={row.level}>
        {row.at === null ? null : <time dateTime={new Date(row.at).toISOString()}>{stepLogTime(row.at, now)}</time>}
        <span className="sui-step-log-level">{row.level}</span>
        {row.message === "" ? null : <span className="sui-step-log-message">{row.message}</span>}
        {row.fields.map(([key, value], f) => <span key={f} className="sui-step-log-field"><span>{key}</span>={value}</span>)}
        {row.error === null ? null : <span className="sui-step-log-error">{row.error}</span>}
      </li>)}
  </ol>;
}
