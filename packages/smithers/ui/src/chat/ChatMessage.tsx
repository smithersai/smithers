/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { Skeleton } from "../skeleton";
import { useInjectUiCss } from "../styles";

export type ChatMessageRole = "assistant" | "user" | "system";

export type ChatMessageProps = Omit<ComponentProps<"article">, "role"> & {
  /** Which side and surface recipe this message uses. */
  role: ChatMessageRole;
  /** Optional small heading above the bubble, such as a pipeline stage name. */
  label?: ReactNode;
  /** Delivery state below the bubble, always shown, such as `Queued` or a Retry button. */
  meta?: ReactNode;
  /**
   * The message's time and controls, such as Copy, after `meta`. Hidden until the pointer is over the message or
   * focus is inside it; on a touch screen, until the message is tapped. Their space is kept, so nothing moves when
   * they show.
   */
  actions?: ReactNode;
  /** Monospace treatment for terminal or tool output. */
  variant?: "default" | "terminal";
  /**
   * The answer hasn't started: a one-line skeleton in its bubble, the size of the answer's first line, so the text
   * takes its place without a jump. Like every loading state, nothing shows for the first `LOADING_DELAY_MS`.
   */
  pending?: boolean;
  /** Accessible text for the pending state. */
  pendingLabel?: string;
};

/** A Smithers chat row with the same user/assistant bubble geometry as Multi. */
export function ChatMessage({
  role,
  label,
  meta,
  actions,
  variant = "default",
  pending = false,
  pendingLabel = "Smithers is thinking",
  className,
  children,
  ...props
}: ChatMessageProps) {
  useInjectUiCss();
  return (
    <article
      data-slot="chat-message"
      data-role={role}
      data-variant={variant}
      className={cn("sui-chat-message", className)}
      // A tap focuses the message, which shows its actions on a touch screen (:focus-within); never a tab stop.
      tabIndex={actions ? -1 : undefined}
      {...props}
    >
      {label ? <div className="sui-chat-message-label">{label}</div> : null}
      <div
        className={cn("sui-chat-bubble", pending && "sui-chat-bubble-pending")}
        role={pending ? "status" : variant === "terminal" ? "region" : undefined}
        aria-live={pending ? "polite" : undefined}
        aria-label={!pending && variant === "terminal" ? "Terminal output" : undefined}
        tabIndex={!pending && variant === "terminal" ? 0 : undefined}
      >
        {pending ? (
          <>
            <span className="sui-sr-only">{pendingLabel}</span>
            <Skeleton className="sui-chat-pending-line" />
          </>
        ) : (
          children
        )}
      </div>
      {meta || actions ? (
        <div className="sui-chat-message-meta">
          {meta}
          {actions ? <span className="sui-chat-message-actions">{actions}</span> : null}
        </div>
      ) : null}
    </article>
  );
}
