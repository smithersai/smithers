/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageProps = ComponentProps<"div"> & {
  /** Author role; drives default alignment. */
  role?: MessageRole;
  /** Row alignment; defaults from role (user end, others start). */
  align?: "start" | "end";
  /** Tighter spacing for consecutive same-author messages; hides the avatar. */
  grouped?: boolean;
};

function useMessageLaneCss(): void {
  useInjectUiCss();
}

/** Conversation row: avatar rail plus header/content/footer/actions layout. */
export function Message({ role = "assistant", align, grouped = false, className, children, ...props }: MessageProps) {
  useMessageLaneCss();
  const resolvedAlign = align ?? (role === "user" ? "end" : "start");
  return (
    <div
      data-slot="message"
      data-role={role}
      data-align={resolvedAlign}
      data-grouped={grouped ? "true" : undefined}
      className={cn("sui-msg", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export type MessageAvatarProps = Omit<ComponentProps<"span">, "children"> & {
  /** Image source; when absent the fallback renders. */
  src?: string;
  /** Image alt text; empty alt keeps the avatar decorative. */
  alt?: string;
  /** Text or glyph shown when no image is provided (or it fails). */
  fallback?: ReactNode;
};

/** Author avatar: image with an automatic text/glyph fallback. */
export function MessageAvatar({ src, alt = "", fallback, className, ...props }: MessageAvatarProps) {
  useMessageLaneCss();
  const [failedSrc, setFailedSrc] = useState<string>();
  const decorative = alt === "";
  return (
    <span data-slot="message-avatar" className={cn("sui-msg-avatar", className)} {...props}>
      {src && src !== failedSrc ? (
        <img src={src} alt={alt} aria-hidden={decorative ? true : undefined} onError={() => setFailedSrc(src)} />
      ) : (
        <span aria-hidden={decorative ? true : undefined}>{fallback}</span>
      )}
    </span>
  );
}

/** Small heading row above the message body (author name, timestamps). */
export function MessageHeader({ className, ...props }: ComponentProps<"div">) {
  useMessageLaneCss();
  return <div data-slot="message-header" className={cn("sui-msg-header", className)} {...props} />;
}

/** The message body region. */
export function MessageContent({ className, ...props }: ComponentProps<"div">) {
  useMessageLaneCss();
  return <div data-slot="message-content" className={cn("sui-msg-content", className)} {...props} />;
}

/** Row beneath the message body (delivery state, metadata). */
export function MessageFooter({ className, ...props }: ComponentProps<"div">) {
  useMessageLaneCss();
  return <div data-slot="message-footer" className={cn("sui-msg-footer", className)} {...props} />;
}

const FOCUSABLE_SELECTOR = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

export type MessageActionsProps = ComponentProps<"div">;

/** Hover-revealed action toolbar with Left/Right roving tabindex. */
export function MessageActions({ className, onKeyDown, ...props }: MessageActionsProps) {
  useMessageLaneCss();
  const ref = useRef<HTMLDivElement>(null);

  const syncTabstops = useCallback((active: HTMLElement | null) => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
    );
    for (const item of items) item.tabIndex = item === active ? 0 : -1;
    if (active === null && items.length > 0) items[0]!.tabIndex = 0;
  }, []);

  useEffect(() => {
    syncTabstops(null);
  }, [syncTabstops]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !el.hasAttribute("disabled"),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = items[(current + delta + items.length) % items.length]!;
    next.focus();
    syncTabstops(next);
  };

  return (
    <div
      ref={ref}
      data-slot="message-actions"
      role="toolbar"
      aria-label="Message actions"
      className={cn("sui-msg-actions", className)}
      onKeyDown={handleKeyDown}
      {...props}
    />
  );
}

/** Vertical cluster of consecutive same-author messages. */
export function MessageGroup({ className, ...props }: ComponentProps<"div">) {
  useMessageLaneCss();
  return <div data-slot="message-group" role="group" className={cn("sui-msg-group", className)} {...props} />;
}
