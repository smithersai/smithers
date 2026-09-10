/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { formatStatus, normalizeStatus, statusClass } from "../status";
import { useInjectUiCss } from "../styles";

export type ActivityKind =
  | "message"
  | "reasoning"
  | "tool"
  | "approval"
  | "retry"
  | "handoff"
  | "delegation"
  | "checkpoint"
  | "signal"
  | "output"
  | "failure";

export type ActivityItemModel = {
  id: string;
  kind: ActivityKind;
  title: ReactNode;
  detail?: ReactNode;
  status?: string;
  timestampMs?: number;
  actor?: string;
};

export type ActivityTimelineProps = Omit<ComponentProps<"div">, "children"> &
  ({ items: readonly ActivityItemModel[]; children?: never } | { children: ReactNode; items?: never });

const ACTIVITY_GLYPHS: Record<ActivityKind, string> = {
  message: "✉",
  reasoning: "◌",
  tool: "⚙",
  approval: "!",
  retry: "↻",
  handoff: "⇢",
  delegation: "↳",
  checkpoint: "⚑",
  signal: "↯",
  output: "»",
  failure: "✕",
};

function useActivityCss(): void {
  useInjectUiCss();
}

function formatTimestamp(timestampMs: number): { dateTime: string; text: string } {
  const iso = new Date(timestampMs).toISOString();
  return { dateTime: iso, text: iso.slice(11, 19) };
}

export type ActivityItemProps = Omit<ComponentProps<"li">, "children" | "title"> & {
  kind: ActivityKind;
  title: ReactNode;
  status?: string;
  timestampMs?: number;
  actor?: string;
  children?: ReactNode;
};

/** One entry of an activity timeline: glyph, title, actor, time, and detail. */
export function ActivityItem({
  kind,
  title,
  status,
  timestampMs,
  actor,
  className,
  children,
  ...props
}: ActivityItemProps) {
  useActivityCss();
  const timestamp = timestampMs !== undefined ? formatTimestamp(timestampMs) : undefined;
  return (
    <li
      data-slot="activity-item"
      data-kind={kind}
      data-status={status !== undefined ? normalizeStatus(status) : undefined}
      data-status-class={statusClass(status)}
      className={cn("sui-activity-item", className)}
      {...props}
    >
      <span className="sui-activity-marker" aria-hidden="true">
        {ACTIVITY_GLYPHS[kind]}
      </span>
      <div className="sui-activity-body">
        {status !== undefined ? <span className="sui-sr-only">{formatStatus(status)}: </span> : null}
        <span className="sui-activity-title">{title}</span>
        {actor !== undefined ? <span className="sui-activity-actor">{actor}</span> : null}
        {timestamp !== undefined ? (
          <time className="sui-activity-time" dateTime={timestamp.dateTime}>
            {timestamp.text}
          </time>
        ) : null}
        {children !== undefined && children !== null ? <div className="sui-activity-detail">{children}</div> : null}
      </div>
    </li>
  );
}

export type ActivityGroupProps = Omit<ComponentProps<"li">, "children" | "title"> & {
  label: ReactNode;
  children: ReactNode;
};

/** A labeled cluster of activity items inside the timeline. */
export function ActivityGroup({ label, className, children, ...props }: ActivityGroupProps) {
  useActivityCss();
  return (
    <li data-slot="activity-group" className={cn("sui-activity-group", className)} {...props}>
      <div className="sui-activity-group-label">{label}</div>
      <ol className="sui-activity-group-items">{children}</ol>
    </li>
  );
}

/**
 * An ordered, role=list timeline of run activity: agent messages, reasoning
 * summaries, tool calls, approvals, retries, handoffs, delegations,
 * checkpoints, signals, outputs, and failures.
 */
export function ActivityTimeline(props: ActivityTimelineProps) {
  useActivityCss();
  const { className, ...rest } = props;
  if ("items" in rest && rest.items !== undefined) {
    const { items, ...domProps } = rest;
    return (
      <ol
        data-slot="activity-timeline"
        role="list"
        className={cn("sui-activity-timeline", className)}
        {...(domProps as ComponentProps<"ol">)}
      >
        {items.map((item) => (
          <ActivityItem
            key={item.id}
            kind={item.kind}
            title={item.title}
            status={item.status}
            timestampMs={item.timestampMs}
            actor={item.actor}
          >
            {item.detail}
          </ActivityItem>
        ))}
      </ol>
    );
  }
  const { children, ...domProps } = rest;
  return (
    <ol
      data-slot="activity-timeline"
      role="list"
      className={cn("sui-activity-timeline", className)}
      {...(domProps as ComponentProps<"ol">)}
    >
      {children}
    </ol>
  );
}
