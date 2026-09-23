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

/** The toolbar's roving items: focusable, enabled, and not hidden from assistive tech. */
function rovingItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
}

export type MessageActionsProps = ComponentProps<"div">;

/** Hover-revealed action toolbar with Left/Right roving tabindex. */
export function MessageActions({ className, onKeyDown, ...props }: MessageActionsProps) {
  useMessageLaneCss();
  const ref = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLElement | null>(null);

  /** Leave exactly one tab stop: `active` when it is still an item, else the first. */
  const syncTabstops = useCallback((active: HTMLElement | null) => {
    const root = ref.current;
    if (!root) return;
    const items = rovingItems(root);
    const stop = active !== null && items.includes(active) ? active : (items[0] ?? null);
    activeRef.current = stop;
    // Ineligible controls (disabled, aria-hidden) drop out of the tab order too.
    for (const item of root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
      const tabIndex = item === stop ? 0 : -1;
      if (item.tabIndex !== tabIndex) item.tabIndex = tabIndex;
    }
  }, []);

  // Actions arrive after the message (retry, copy) and toggle disabled or
  // aria-hidden while it streams; every change re-derives the single tab stop.
  useEffect(() => {
    const root = ref.current;
    syncTabstops(activeRef.current);
    if (!root || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => syncTabstops(activeRef.current));
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-hidden", "href"],
    });
    return () => observer.disconnect();
  }, [syncTabstops]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const root = ref.current;
    if (!root) return;
    const items = rovingItems(root);
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
