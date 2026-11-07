/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { Badge, type BadgeProps } from "./badge";
import { cn } from "@smthrs/ui-css";
import { isTerminalRunStatus, normalizeStatus, statusClass } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

/** One phase/stage in a pipeline: a label plus a status string. */
export type StageStripItem = {
  /** The stage name shown in the chip. */
  label: ReactNode;
  /**
   * A status string from the shared vocabulary. `done`/`ok`/`complete` tint
   * green, `failed`/`error` tint red, `active`/`running`/`current` highlight
   * brand, and everything else (`pending`, `queued`, `cancelled`, undefined,
   * ...) reads as neutral/upcoming.
   */
  status: string | undefined;
};

/** The four visual tones a stage chip can take. */
export type StageTone = "pending" | "active" | "done" | "failed";

/** Status spellings that mean "this is the stage currently in flight". */
const ACTIVE_STATUSES = new Set(["active", "current", "running", "in-progress", "inprogress", "working"]);

/**
 * Bucket a stage status string into one of the four chip tones, reusing the
 * shared {@link statusClass} vocabulary for the terminal states and treating
 * the "in flight" family as the highlighted `active` tone.
 */
export function stageTone(status: string | undefined): StageTone {
  if (ACTIVE_STATUSES.has(normalizeStatus(status))) return "active";
  const cls = statusClass(status);
  if (cls === "bad") return "failed";
  if (cls === "ok") return "done";
  return "pending";
}

/** Map a tone onto the shared Badge variant StatusPill also draws from. */
const TONE_VARIANT: Record<StageTone, NonNullable<BadgeProps["variant"]>> = {
  pending: "muted",
  active: "default",
  done: "success",
  failed: "destructive",
};

export type StageStripProps = Omit<ComponentProps<"div">, "children"> & {
  /** The ordered pipeline stages. Renders nothing when empty. */
  stages: StageStripItem[];
  /** Show a `done/total` count header derived from terminal-status stages. */
  showSummary?: boolean;
  /** Override the summary prefix label (defaults to "Stages"). */
  summaryLabel?: ReactNode;
};

/**
 * Horizontal pipeline-stage chip strip — the `StepChips`/`Stage`/`stageEl`
 * pattern reinvented across workflow UIs, promoted to one presentational
 * component. Callers derive `stages` however they like (node status, run
 * phase, ...) and each chip is tinted through the shared status vocabulary
 * (done/active/pending/failed) via the same {@link Badge} tints
 * {@link StatusPill} uses. Store-free: no gateway hooks or node-status
 * derivation is baked in.
 */
export function StageStrip({
  stages,
  showSummary = false,
  summaryLabel = "Stages",
  className,
  ...props
}: StageStripProps) {
  useInjectUiCss();
  if (stages.length === 0) return null;
  const done = stages.filter((stage) => isTerminalRunStatus(stage.status)).length;
  return (
    <div data-slot="stage-strip" className={cn("sui-stage-strip", className)} {...props}>
      {showSummary ? (
        <div data-slot="stage-strip-summary" className="sui-stage-strip-summary">
          {summaryLabel ? <span className="sui-stage-strip-summary-label">{summaryLabel}</span> : null}
          <span className="sui-stage-strip-summary-count">
            {done}/{stages.length}
          </span>
        </div>
      ) : null}
      <div className="sui-stage-strip-chips">
        {stages.map((stage, index) => {
          const tone = stageTone(stage.status);
          return (
            <Badge
              // Stages are a static ordered list; labels may repeat, so index is the stable key.
              key={index}
              variant={TONE_VARIANT[tone]}
              data-slot="stage-strip-chip"
              data-tone={tone}
              data-status={stage.status}
              className="sui-stage-chip"
            >
              <span aria-hidden className="sui-status-dot" />
              {stage.label}
            </Badge>
          );
        })}
      </div>
    </div>
  );
}
