/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { stepDuration, type RunState, type RunWord } from "./runPage";
import { RunStatusPill } from "./RunStatusPill";

export type RunHeaderProps = Omit<ComponentProps<"header">, "children" | "title"> & {
  /** The flow's name. */
  title: string;
  state: RunState;
  cancelRequested?: boolean;
  /** A word that overrides the state's, such as `On another device`. */
  word?: RunWord;
  startedAtMs: number;
  finishedAtMs: number | null;
  now: number;
  /** Where the run runs, such as `This device`. */
  host?: string;
  /** The run's acts: Stop, Retry, Resume. */
  actions?: ReactNode;
  /** The title's heading level. Default `h1`. */
  headingLevel?: 1 | 2 | 3;
};

/**
 * One line naming a run: `release-notes · ✓ Done · 0:42 · This device`, then
 * its acts. The state sits in a polite live region, so a screen reader hears
 * `Stopping` and then `Stopped`.
 */
export function RunHeader({
  title,
  state,
  cancelRequested = false,
  word,
  startedAtMs,
  finishedAtMs,
  now,
  host,
  actions,
  headingLevel = 1,
  className,
  ...props
}: RunHeaderProps) {
  useInjectUiCss();
  const Heading = `h${headingLevel}` as const;
  const elapsed = (finishedAtMs ?? now) - startedAtMs;
  return (
    <header data-slot="run-header" className={cn("sui-run-header", className)} {...props}>
      <div className="sui-run-header-line">
        <Heading className="sui-run-header-title">{title}</Heading>
        <span role="status" aria-live="polite" className="sui-run-header-state">
          <RunStatusPill state={state} cancelRequested={cancelRequested} {...(word === undefined ? {} : { word })} />
        </span>
        <span className="sui-run-header-elapsed" aria-label="Elapsed">
          {stepDuration(elapsed)}
        </span>
        {host === undefined ? null : <span className="sui-run-header-host">{host}</span>}
      </div>
      {actions === undefined || actions === null ? null : <div className="sui-run-header-actions">{actions}</div>}
    </header>
  );
}
