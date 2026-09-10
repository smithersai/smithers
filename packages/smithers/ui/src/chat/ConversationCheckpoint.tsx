/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type ConversationCheckpointProps = Omit<ComponentProps<"div">, "children"> & {
  /** Checkpoint label (restore point name, frame description, ...). */
  label: ReactNode;
  /** Epoch milliseconds; rendered as a locale <time> when provided. */
  timestampMs?: number;
  /** Trailing action slot (restore/fork buttons, ...). */
  actions?: ReactNode;
};

/** Labeled durable-checkpoint separator row inside a transcript. */
export function ConversationCheckpoint({
  label,
  timestampMs,
  actions,
  className,
  ...props
}: ConversationCheckpointProps) {
  useInjectUiCss();
  const date = timestampMs !== undefined ? new Date(timestampMs) : undefined;
  return (
    <div data-slot="conversation-checkpoint" className={cn("sui-convo-checkpoint", className)} {...props}>
      <span className="sui-convo-checkpoint-body">
        <span data-slot="conversation-checkpoint-label" className="sui-convo-checkpoint-label">
          {label}
        </span>
        {date ? (
          <time className="sui-convo-checkpoint-time" dateTime={date.toISOString()}>
            {date.toLocaleTimeString()}
          </time>
        ) : null}
        {actions ? (
          <span data-slot="conversation-checkpoint-actions" className="sui-convo-checkpoint-actions">
            {actions}
          </span>
        ) : null}
      </span>
    </div>
  );
}
