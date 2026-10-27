/** @jsxImportSource react */
import { Children, type ComponentProps, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../button";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { isNoticeHotkey, isTypingTarget, NOTICE_GLYPHS, NOTICE_KEYS, NOTICE_WORDS, noticeKeyAction, type NoticeState } from "./notices";
import { moveFocus } from "./roving";

/** What takes focus in each toast: its open button, else its action, else Hide. */
const TOAST_FOCUS = '[data-slot="toast"] [data-toast-focus]';

export type ToastStackProps = Omit<ComponentProps<"section">, "children"> & {
  /** The toasts, most urgent first. */
  children?: ReactNode;
  /** The person's other entries, such as settled ones. They show only while the stack is expanded, after the toasts. */
  more?: ReactNode;
  /**
   * Opens the person's entries elsewhere, such as a notifications panel, in place of expanding the stack: `+N` counts
   * the toasts past `max` plus `moreCount`, and calls this. `more` is then not shown.
   */
  onMore?: () => void;
  /** With `onMore`: how many entries the person has besides the toasts. Default 0. */
  moreCount?: number;
  /** How many toasts show before `+N`. Default 3. */
  max?: number;
  /** The region's accessible name. Default `Notifications`. */
  label?: string;
  /**
   * `fixed` (the default) floats at the window's bottom-left; `inline` sits where it is rendered, such as just above a
   * composer, so it never covers it.
   */
  placement?: "fixed" | "inline";
};

/**
 * The toast stack (apps/mvp decision 0009 §4): bottom-left, or inline where
 * it is rendered, at most `max` toasts, and `+N`: with `onMore` it opens the
 * person's entries elsewhere; else it expands the rest in place, the toasts
 * past `max` then the `more` entries, and reads `Less` to collapse them again.
 * A polite live region, so a new toast is announced without taking focus.
 * Alt+T focuses its first toast from anywhere, arrows (and J and K, Home and
 * End) move between its toasts, and Escape gives focus back. Renders nothing
 * while it has no toasts and nothing more.
 */
export function ToastStack({
  children,
  more,
  onMore,
  moreCount = 0,
  max = 3,
  label = "Notifications",
  placement = "fixed",
  className,
  onKeyDown,
  ...props
}: ToastStackProps) {
  useInjectUiCss();
  const [expanded, setExpanded] = useState(false);
  const section = useRef<HTMLElement>(null);
  // Where focus was before Alt+T brought it here, for Escape to give it back.
  const before = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onHotkey = (event: globalThis.KeyboardEvent) => {
      if (!isNoticeHotkey(event, "toasts")) return;
      const first = section.current?.querySelector<HTMLElement>(TOAST_FOCUS);
      if (first === null || first === undefined) return;
      event.preventDefault();
      const active = document.activeElement;
      if (!section.current!.contains(active)) before.current = active instanceof HTMLElement ? active : null;
      first.focus();
    };
    document.addEventListener("keydown", onHotkey, true);
    return () => document.removeEventListener("keydown", onHotkey, true);
  }, []);
  const toasts = Children.toArray(children);
  const entries = onMore === undefined ? Children.toArray(more) : [];
  const extra = onMore === undefined ? entries.length : moreCount;
  if (toasts.length === 0 && extra === 0) return null;
  const folded = Math.max(0, toasts.length - max) + extra;
  const open = onMore === undefined && expanded;

  const keys = (event: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    const action = noticeKeyAction(event);
    if (action === "close") {
      event.preventDefault();
      const back = before.current;
      before.current = null;
      if (back !== null && back.isConnected) back.focus();
      else (event.target as HTMLElement).blur();
      return;
    }
    if (action !== undefined && moveFocus(event.currentTarget, TOAST_FOCUS, action, event.target as Element)) {
      event.preventDefault();
    }
  };

  return (
    <section
      ref={section}
      data-slot="toast-stack"
      data-placement={placement}
      aria-label={label}
      aria-live="polite"
      aria-keyshortcuts={NOTICE_KEYS.toasts}
      className={cn("sui-toast-stack", className)}
      onKeyDown={keys}
      {...props}
    >
      {open ? toasts : toasts.slice(0, max)}
      {open ? entries : null}
      {folded === 0 ? null : onMore === undefined ? (
        <Button
          variant="ghost"
          size="sm"
          className="sui-toast-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Less" : `+${folded}`}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="sui-toast-more"
          aria-haspopup="dialog"
          aria-keyshortcuts={NOTICE_KEYS.notifications}
          data-notifications-trigger=""
          onClick={onMore}
        >
          {`+${folded}`}
        </Button>
      )}
    </section>
  );
}

export type ToastProps = Omit<ComponentProps<"div">, "children" | "title"> & {
  /** The state the toast is about: its glyph, word and tone. */
  tone: NoticeState;
  /** Shown in bold in place of the state's word, such as a branch name. */
  word?: ReactNode;
  /** What it is about, in a few words, after the word. */
  detail?: ReactNode;
  /** Its one action. */
  action?: { readonly label: string; readonly onAction: () => void } | undefined;
  /** Hide: the toast goes, and what it is about stays where it lives. H. */
  onHide?: () => void;
  /** The × button's accessible name. Default `Hide`. */
  hideLabel?: string;
  /** Not yet read: a dot before the glyph, and `Unread` for screen readers. */
  unread?: boolean;
  /** Fades in only after 300 ms (0009's rule), so a toast gone within that never flashes. */
  delayed?: boolean;
  /** Opens what the toast is about: its words become a button. Clicking it, Enter or O. */
  onOpen?: () => void;
  /** E: shows more of it, such as the notifications panel at its entry. */
  onExpand?: () => void;
  /** A: answers its question. */
  onAnswer?: () => void;
  /** R: marks it read. */
  onRead?: () => void;
};

/**
 * One toast: the state's glyph and word, a detail on one line, at most one
 * action, and optional Hide. Tone follows the state: gold for needs you, ember for
 * failed, brand for working, muted for an update. With `onOpen` its words are
 * a button that opens what it is about. A focused toast takes `NOTICE_KEYS`:
 * O opens, E expands, A answers, H hides and R marks it read.
 */
export function Toast({
  tone,
  word,
  detail,
  action,
  onHide,
  hideLabel = "Hide",
  unread = false,
  delayed = false,
  onOpen,
  onExpand,
  onAnswer,
  onRead,
  className,
  onKeyDown,
  ...props
}: ToastProps) {
  useInjectUiCss();
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    const act = noticeKeyAction(event);
    const run = act === "open"
      ? onOpen
      : act === "expand"
      ? onExpand
      : act === "answer"
      ? onAnswer
      : act === "hide"
      ? onHide
      : act === "read"
      ? onRead
      : undefined;
    if (run === undefined) return;
    event.preventDefault();
    run();
  };
  const shortcuts = [
    onOpen === undefined ? null : NOTICE_KEYS.open,
    onExpand === undefined ? null : NOTICE_KEYS.expand,
    onAnswer === undefined ? null : NOTICE_KEYS.answer,
    onHide === undefined ? null : NOTICE_KEYS.hide,
    onRead === undefined ? null : NOTICE_KEYS.read,
  ].filter((key) => key !== null).join(" ");
  const face = (
    <>
      {unread ? (
        <span className="sui-toast-unread">
          <span className="sui-sr-only">Unread</span>
        </span>
      ) : null}
      <span aria-hidden className="sui-toast-glyph">
        {NOTICE_GLYPHS[tone]}
      </span>
      <span className="sui-toast-text">
        <b>{word === undefined ? NOTICE_WORDS[tone] : word}</b>
        {detail === undefined ? null : <> · {detail}</>}
      </span>
    </>
  );
  const focusOn = onOpen !== undefined ? "open" : action !== undefined ? "action" : "hide";
  return (
    <div
      data-slot="toast"
      data-tone={tone}
      data-unread={unread ? "" : undefined}
      data-delayed={delayed ? "" : undefined}
      className={cn("sui-toast", className)}
      onKeyDown={keys}
      {...props}
    >
      {onOpen === undefined ? face : (
        <button
          type="button"
          data-slot="toast-open"
          data-toast-focus=""
          className="sui-toast-open"
          aria-keyshortcuts={shortcuts}
          onClick={onOpen}
        >
          {face}
        </button>
      )}
      {action === undefined ? null : (
        <Button
          size="sm"
          data-toast-focus={focusOn === "action" ? "" : undefined}
          aria-keyshortcuts={onAnswer === undefined ? undefined : NOTICE_KEYS.answer}
          onClick={action.onAction}
        >
          {action.label}
        </Button>
      )}
      {onHide === undefined ? null : <Button
        variant="ghost"
        size="icon"
        className="sui-toast-hide"
        aria-label={hideLabel}
        aria-keyshortcuts={NOTICE_KEYS.hide}
        data-toast-focus={focusOn === "hide" ? "" : undefined}
        onClick={onHide}
      >
        ×
      </Button>}
    </div>
  );
}
