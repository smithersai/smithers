/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { JsonValue } from "../json-value/JsonValue";
import type { JsonValueData } from "../json-value/jsonValueText";
import { useInjectUiCss } from "../styles";
import { formatRelativeTime } from "../time/formatRelativeTime";
import { type AttemptRow, attemptWords, STEP_GLYPHS, STEP_WORDS, type StepState, untilWords } from "./runPage";

/** What a step waits on: its kind (`timer`, `human`, `signal`, …), since when, and when it wakes. */
export interface WaitData {
  readonly kind: string;
  readonly sinceMs: number | null;
  readonly wakeAtMs: number | null;
}

export type SpanDetailProps = Omit<ComponentProps<"section">, "children"> & {
  label: string;
  state: StepState;
  attempts: ReadonlyArray<AttemptRow>;
  input: JsonValueData | null;
  output: JsonValueData | null;
  wait?: WaitData | null;
  now: number;
  /** The step's acts, such as Answer for a human wait. */
  actions?: ReactNode;
};

/** The wait line: `human · since 3m ago · wakes in 2 m`. */
export const waitWords = (wait: WaitData, now: number): string =>
  [
    wait.kind,
    wait.sinceMs === null ? null : `since ${formatRelativeTime(wait.sinceMs, now)}`,
    wait.wakeAtMs === null ? null : `wakes ${untilWords(wait.wakeAtMs, now)}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

/**
 * One step: its state, its wait, its attempts (`1 ✕ unavailable · 2 ✓`), and
 * its input and output as text, open. Shows nothing it wasn't given.
 */
export function SpanDetail({
  label,
  state,
  attempts,
  input,
  output,
  wait,
  now,
  actions,
  className,
  ...props
}: SpanDetailProps) {
  useInjectUiCss();
  return (
    <section
      data-slot="span-detail"
      data-state={state}
      aria-label={label}
      className={cn("sui-span-detail", className)}
      {...props}
    >
      <header className="sui-span-detail-header">
        <span aria-hidden className="sui-span-detail-glyph">
          {STEP_GLYPHS[state]}
        </span>
        <h3 className="sui-span-detail-label">{label}</h3>
        <span className="sui-span-detail-word">{STEP_WORDS[state]}</span>
      </header>
      {wait === undefined || wait === null ? null : (
        <p className="sui-span-detail-wait" data-kind={wait.kind}>
          {waitWords(wait, now)}
        </p>
      )}
      {attempts.length === 0 ? null : (
        <p className="sui-span-detail-attempts" aria-label="Attempts">
          {attempts.map(attemptWords).join(" · ")}
        </p>
      )}
      {input === null ? null : <JsonValue label="Input" value={input} defaultOpen />}
      {output === null ? null : <JsonValue label="Output" value={output} defaultOpen />}
      {actions === undefined || actions === null ? null : <div className="sui-span-detail-actions">{actions}</div>}
    </section>
  );
}
