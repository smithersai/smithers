/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { Markdown, type MarkdownLinkClick } from "../primitives/markdown";
import { useInjectUiCss } from "../styles";

export type MessageResponseProps = Omit<ComponentProps<"div">, "children"> & {
  content: string;
  streaming?: boolean;
  onLinkClick?: MarkdownLinkClick;
};

/** Assistant-message content rendered as stream-tolerant Markdown. */
export function MessageResponse({
  content,
  streaming = false,
  onLinkClick,
  className,
  ...props
}: MessageResponseProps) {
  useInjectUiCss();
  return (
    <div
      data-slot="message-response"
      data-streaming={streaming ? "true" : "false"}
      className={cn("sui-response", className)}
      {...props}
    >
      <Markdown content={content} onLinkClick={onLinkClick} />
      {streaming ? <span data-slot="message-response-caret" className="sui-response-caret" aria-hidden="true" /> : null}
    </div>
  );
}
