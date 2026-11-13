/** @jsxImportSource react */
import { type FocusEvent, type PointerEvent, type ReactNode, useRef } from "react";
import { useInjectUiCss } from "./styles";

/**
 * The path a plain link opens in this tab: none for another origin, a new tab
 * or a download. Its search and hash are left out: what a preload warms is
 * the page, not a line on it.
 */
export function intentPath(target: EventTarget | null, origin: string): string | undefined {
  if (typeof Element === "undefined" || !(target instanceof Element)) return undefined;
  const anchor = target.closest("a[href]");
  if (anchor === null || !("href" in anchor) || typeof anchor.href !== "string") return undefined;
  const opens = anchor.getAttribute("target");
  if ((opens !== null && opens !== "" && opens !== "_self") || anchor.hasAttribute("download")) return undefined;
  if (!URL.canParse(anchor.href)) return undefined;
  const url = new URL(anchor.href);
  return url.origin === origin ? url.pathname : undefined;
}

export type LinkIntentProps = {
  /** How long the pointer or focus must rest on a link before `onIntent`, so a pointer sweeping a list asks nothing. */
  delayMs: number;
  /** A link's intent: the same-origin path it opens. Once per rest on a link. */
  onIntent: (path: string) => void;
  /** The origin a link must be on; the page's own by default. */
  origin?: string;
  children?: ReactNode;
};

/**
 * Reports the intent to follow any plain link inside it, as a router's own
 * links preload on hover or focus: the pointer or focus has rested on the
 * link for `delayMs`. A pointer that leaves first reports nothing. It takes no
 * box of its own (`display: contents`).
 */
export function LinkIntent({ delayMs, onIntent, origin, children }: LinkIntentProps) {
  useInjectUiCss();
  const waiting = useRef<{ readonly path: string; readonly timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const cancel = () => {
    if (waiting.current !== undefined) clearTimeout(waiting.current.timer);
    waiting.current = undefined;
  };
  const start = (event: PointerEvent | FocusEvent) => {
    const path = intentPath(event.target, origin ?? window.location.origin);
    if (path === undefined || path === waiting.current?.path) return;
    cancel();
    const timer = setTimeout(() => {
      waiting.current = undefined;
      onIntent(path);
    }, delayMs);
    waiting.current = { path, timer };
  };
  const leave = (event: PointerEvent) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    // Moving between the link's own children stays on it.
    if (anchor !== null && event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;
    cancel();
  };
  return (
    <div data-slot="link-intent" className="sui-link-intent" onPointerOver={start} onPointerOut={leave} onFocus={start} onBlur={cancel}>
      {children}
    </div>
  );
}
