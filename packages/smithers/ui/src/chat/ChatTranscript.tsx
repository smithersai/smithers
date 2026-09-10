/** @jsxImportSource react */
import { Children, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { ChatMessage } from "./ChatMessage";
import {
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./MessageScroller";

export type ChatTranscriptProps = ComponentProps<"div"> & {
  /** Whether a reply is currently being generated or streamed. */
  pending?: boolean;
  /** Accessible text for the pending assistant bubble. */
  pendingLabel?: string;
  /** Content shown when there are no messages. */
  empty?: ReactNode;
};

/** Scrollable, accessible transcript container for Smithers chat surfaces. */
export function ChatTranscript({
  pending = false,
  pendingLabel,
  empty,
  className,
  children,
  ...props
}: ChatTranscriptProps) {
  useInjectUiCss();
  const isEmpty = Children.toArray(children).length === 0;
  return (
    <div
      data-slot="chat-transcript"
      role="log"
      aria-busy={pending}
      className={cn("sui-chat-transcript", className)}
      {...props}
    >
      <MessageScrollerProvider scrollAnchor="bottom">
        <div data-slot="message-scroller" className="sui-msg-scroller" data-streaming={pending ? "true" : "false"}>
          <MessageScrollerViewport fade>
            <MessageScrollerContent className="sui-chat-messages">
              {isEmpty && empty ? <div className="sui-chat-empty">{empty}</div> : children}
              {pending ? <ChatMessage role="assistant" pending pendingLabel={pendingLabel} /> : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </div>
      </MessageScrollerProvider>
    </div>
  );
}
