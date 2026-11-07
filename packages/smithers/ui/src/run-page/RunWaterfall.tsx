/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";
import { STEP_WORDS, stepDuration, stepElapsed, type StepRow, waterfallAxis, waterfallBars } from "./runPage";

export type RunWaterfallProps = Omit<ComponentProps<"div">, "children" | "onSelect"> & {
  steps: ReadonlyArray<StepRow>;
  now: number;
  /** Replay cursor on the shared axis. */
  cursorMs?: number;
  /** Recorded attempts, waits and agent cells; child rows use StepRow.depth. */
  segments?: ReadonlyArray<{ readonly stepId: string; readonly startedAtMs: number; readonly endedAtMs: number | null; readonly state: string }>;
  selected?: string | null;
  /** With it, each bar is a button that selects its step. */
  onSelect?: (id: string) => void;
};

/**
 * The run's timeline: one bar per step on a shared axis from the earliest
 * start to the latest end. An open step runs to `now`; a step that ended where
 * it began is a marker.
 */
export function RunWaterfall({ steps, now, selected = null, onSelect, cursorMs, segments = [], className, ...props }: RunWaterfallProps) {
  useInjectUiCss();
  const bars = waterfallBars(steps, now);
  const axis = waterfallAxis(steps, now);
  const percent = (ms: number) => Math.max(0, Math.min(100, (ms - axis.start) / Math.max(1, axis.end - axis.start) * 100));
  return (
    <div role="list" aria-label="Timeline" data-slot="run-waterfall" className={cn("sui-waterfall", className)} {...props}>
      {steps.map((step, index) => {
        const bar = bars[index]!;
        const name = `${step.label}, ${STEP_WORDS[step.state]}, ${stepDuration(stepElapsed(step, now))}`;
        const shape = (
          <>
          <span
            className="sui-waterfall-bar"
            data-instant={bar.instant ? "true" : undefined}
            data-open={bar.open ? "true" : undefined}
            style={{ left: `${bar.left}%`, width: bar.instant ? undefined : `${bar.width}%` }}
          />
          {segments.filter((segment) => segment.stepId === step.id).map((segment, i) => <span key={i} className="sui-waterfall-segment" data-state={segment.state} style={{ left: `${percent(segment.startedAtMs)}%`, width: `${Math.max(0, percent(segment.endedAtMs ?? now) - percent(segment.startedAtMs))}%` }} />)}
          {cursorMs === undefined ? null : <span className="sui-waterfall-cursor" style={{ left: `${percent(cursorMs)}%` }} />}
          </>
        );
        return (
          <div
            key={step.id}
            role="listitem"
            data-step={step.id}
            data-state={step.state}
            data-selected={step.id === selected ? "true" : undefined}
            className="sui-waterfall-row"
          >
            <span className="sui-waterfall-label" style={{ paddingInlineStart: `${step.depth * 12}px` }} aria-hidden>
              {step.label}
            </span>
            {onSelect === undefined ? (
              <span className="sui-waterfall-track" role="img" aria-label={name}>
                {shape}
              </span>
            ) : (
              <button
                type="button"
                className="sui-waterfall-track"
                aria-label={name}
                aria-pressed={step.id === selected}
                onClick={() => onSelect(step.id)}
              >
                {shape}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
