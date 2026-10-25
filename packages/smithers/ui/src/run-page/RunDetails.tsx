/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { safeHref } from "../internal/safeHref";
import { useInjectUiCss } from "../styles";
import { STEP_GLYPHS, STEP_WORDS, stepDuration, stepElapsed, type StepState } from "./runPage";

/** One step of a job, as a run's details list it. */
export interface RunDetailsStep {
  readonly id: string;
  readonly label: string;
  readonly state: StepState;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  /** Its last failed attempt's closed code, such as `GitHubRefused`. */
  readonly error?: string | null;
  /** How many log lines it has. */
  readonly logs: number;
}

/** One job of a run: the run itself, or a run it started, with its steps in the order they began. */
export interface RunDetailsJob {
  readonly id: string;
  readonly label: string;
  readonly state: StepState;
  /** The job's own run page; none for the run itself. */
  readonly href: string | null;
  readonly steps: ReadonlyArray<RunDetailsStep>;
}

export type RunDetailsProps = Omit<ComponentProps<"div">, "children"> & {
  jobs: ReadonlyArray<RunDetailsJob>;
  now: number;
  /** A step's log lines, shown when it is opened. */
  renderLogs?: (job: RunDetailsJob, step: RunDetailsStep) => ReactNode;
  /** Renders a job's link, such as the router's `Link`; a plain `<a>` otherwise. */
  renderLink?: (href: string, children: ReactNode) => ReactNode;
  /** Shown while there is nothing to list yet, such as a loading line. */
  empty?: ReactNode;
};

/**
 * A run's jobs and their steps, like a CI run's: each step opens to its log lines, and a failed step starts open with
 * its error. Opening and closing a step is the browser's own disclosure, so the host keeps no state for it.
 */
export function RunDetails({ jobs, now, renderLogs, renderLink, empty, className, ...props }: RunDetailsProps) {
  useInjectUiCss();
  const link = renderLink ?? ((href: string, children: ReactNode) => {
    const safe = safeHref(href);
    return safe === undefined ? children : <a href={safe}>{children}</a>;
  });
  const listed = jobs.filter((job) => job.steps.length > 0 || job.href !== null);
  return (
    <div data-slot="run-details" className={cn("sui-run-details", className)} {...props}>
      {listed.length === 0 ? empty ?? null : listed.map((job) => (
        <section key={job.id} data-job={job.id} data-state={job.state} className="sui-run-details-job" aria-label={job.label}>
          <div className="sui-run-details-job-head">
            <span aria-hidden className="sui-run-details-glyph">{STEP_GLYPHS[job.state]}</span>
            <span className="sui-sr-only">{STEP_WORDS[job.state]}</span>
            {job.href === null ? <span className="sui-run-details-label">{job.label}</span> : link(job.href, job.label)}
          </div>
          {job.steps.map((step) => (
            <details
              key={step.id}
              data-step={step.id}
              data-state={step.state}
              className="sui-run-details-step"
              open={step.state === "failed"}
            >
              <summary>
                <span aria-hidden className="sui-run-details-glyph">{STEP_GLYPHS[step.state]}</span>
                <span className="sui-sr-only">{STEP_WORDS[step.state]}</span>
                <span className="sui-run-details-label">{step.label}</span>
                {step.state === "pending" || step.state === "skipped"
                  ? null
                  : <span className="sui-run-details-duration">{stepDuration(stepElapsed(step, now))}</span>}
              </summary>
              <div className="sui-run-details-body">
                {step.error === undefined || step.error === null
                  ? null
                  : <p className="sui-run-details-error" data-slot="run-step-error">{step.error}</p>}
                {step.logs > 0 && renderLogs !== undefined
                  ? renderLogs(job, step)
                  : <p className="sui-run-details-empty">No logs</p>}
              </div>
            </details>
          ))}
        </section>
      ))}
    </div>
  );
}
