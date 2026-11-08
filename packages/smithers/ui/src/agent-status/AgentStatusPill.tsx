/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Badge, type BadgeProps } from "../badge";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";
import { AGENT_STATUS_GLYPHS, AGENT_STATUS_WORDS, type AgentState } from "./agentStatus";

const VARIANT: Readonly<Record<AgentState, NonNullable<BadgeProps["variant"]>>> = {
  working: "default",
  waiting: "muted",
  needs_you: "warning",
  failed: "destructive",
  done: "success",
};

export type AgentStatusPillProps = Omit<ComponentProps<"span">, "children" | "onClick"> & {
  state: AgentState;
  /** How many runs are in this state; shown beside the word above 1. */
  count?: number;
  /** Renders the pill as a button that calls this. */
  onClick?: () => void;
  /** The accessible name of the button, when it needs more than the word. */
  label?: string;
};

/**
 * One of the agent's five states as glyph, tone and word (`◆ Needs you`).
 * Working shows only once it has lasted `LOADING_DELAY_MS`, and holds still.
 * With `onClick` it is a button, so a status bar's pill can take the person
 * to what needs them.
 */
export function AgentStatusPill({ state, count, onClick, label, className, ...props }: AgentStatusPillProps) {
  useInjectUiCss();
  const content = (
    <>
      <span aria-hidden className="sui-agent-status-glyph">
        {AGENT_STATUS_GLYPHS[state]}
      </span>
      {AGENT_STATUS_WORDS[state]}
      {count !== undefined && count > 1 ? <span className="sui-agent-status-count">{count}</span> : null}
    </>
  );
  const shared = {
    "data-slot": "agent-status",
    "data-state": state,
    className: cn("sui-agent-status", className),
  };
  if (onClick === undefined) {
    return (
      <Badge variant={VARIANT[state]} {...shared} {...props}>
        {content}
      </Badge>
    );
  }
  return (
    <Badge variant={VARIANT[state]} asChild {...shared} {...props}>
      <button type="button" onClick={onClick} aria-label={label}>
        {content}
      </button>
    </Badge>
  );
}
