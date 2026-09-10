/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type ChatMessageRole = "assistant" | "user" | "system";

export type ChatMessageProps = Omit<ComponentProps<"article">, "role"> & {
  /** Which side and surface recipe this message uses. */
  role: ChatMessageRole;
  /** Optional small heading above the bubble, such as a pipeline stage name. */
  label?: ReactNode;
  /** Optional timestamp or delivery state below the bubble. */
  meta?: ReactNode;
  /** Monospace treatment for terminal or tool output. */
  variant?: "default" | "terminal";
  /** Render the shared three-dot assistant typing state. */
  pending?: boolean;
  /** Accessible text for the typing state. */
  pendingLabel?: string;
};

/** A Smithers chat row with the same user/assistant bubble geometry as Multi. */
export function ChatMessage({
  role,
  label,
  meta,
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
            <span className="sui-chat-typing" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </>
        ) : (
          children
        )}
      </div>
      {meta ? <div className="sui-chat-message-meta">{meta}</div> : null}
    </article>
  );
}
