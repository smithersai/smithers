/** @jsxImportSource react */
import { Children, type ComponentProps, type ReactNode, useLayoutEffect, useRef } from "react";
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
  /** Public chat rail contribution; it reserves no transcript space. */
  rail?: ReactNode;
  /** Accessible text for the pending assistant bubble. */
  pendingLabel?: string;
  /** Content shown when there are no messages. */
  empty?: ReactNode;
};

/** Where the rail stands beside the transcript instead of behind its disclosure (chatTimelineCss.ts). */
const RAIL_WIDE_VIEWPORT = "(min-width:1180px)";
const RAIL_WIDE_TRANSCRIPT = 600;

/**
 * Keeps the disclosure open while the rail stands beside the transcript. CSS alone can't: WebKit renders nothing of a
 * closed `<details>`. Returns whether it stands there now, when Escape has nothing to close.
 */
function useRailBeside(hasRail: boolean) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const beside = useRef(false);
  useLayoutEffect(() => {
    const details = disclosure.current;
    const transcript = details?.parentElement;
    if (details === null || transcript === null || transcript === undefined) return;
    const viewport = window.matchMedia(RAIL_WIDE_VIEWPORT);
    const sync = () => {
      const now = viewport.matches && transcript.clientWidth >= RAIL_WIDE_TRANSCRIPT;
      if (now === beside.current) return;
      beside.current = now;
      details.open = now;
    };
    sync();
    viewport.addEventListener("change", sync);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
    observer?.observe(transcript);
    return () => {
      viewport.removeEventListener("change", sync);
      observer?.disconnect();
      beside.current = false;
    };
  }, [hasRail]);
  return { disclosure, beside };
}

/** Scrollable, accessible transcript container for Smithers chat surfaces. */
export function ChatTranscript({
  rail,
  pending = false,
  pendingLabel,
  empty,
  className,
  children,
  ...props
}: ChatTranscriptProps) {
  useInjectUiCss();
  const { disclosure, beside } = useRailBeside(Boolean(rail));
  const isEmpty = Children.toArray(children).length === 0;
  return (
    <div
      data-slot="chat-transcript"
      role="region"
      aria-label="Conversation"
      aria-busy={pending}
      className={cn("sui-chat-transcript", className)}
      {...props}
    >
      {rail ? <details ref={disclosure} className="sui-timeline-disclosure" onKeyDown={event => {
        if (event.key !== "Escape" || !event.currentTarget.open || beside.current) return;
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}>
        <summary>Timeline</summary>
        {rail}
      </details> : null}
      <MessageScrollerProvider scrollAnchor="bottom">
        <div data-slot="message-scroller" className="sui-msg-scroller" data-streaming={pending ? "true" : "false"}>
          <MessageScrollerViewport fade>
            <MessageScrollerContent className="sui-chat-messages" aria-label="Messages">
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
