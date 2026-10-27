/** @jsxImportSource react */
import {
  Children,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { Button } from "../button";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { isNoticeHotkey, isTypingTarget, NOTICE_GLYPHS, NOTICE_KEYS, NOTICE_WORDS, noticeKeyAction, type NoticeState } from "./notices";
import { moveFocus } from "./roving";

/** What takes focus in each entry: its row. */
const ENTRY_FOCUS = '[data-slot="notification-row"]';

/** What may open the panel: clicking one never counts as clicking outside it. */
const TRIGGER = "[data-notifications-trigger]";

export type NotificationPanelProps = Omit<ComponentProps<"section">, "children" | "onKeyDown"> & {
  /** Whether the panel shows. Alt+N toggles it from anywhere while it is mounted. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The person's notifications, newest first: `NotificationEntry` elements. */
  children?: ReactNode;
  /** The entry (its `entryId`) that takes focus when the panel opens, else the first. */
  focus?: string | null | undefined;
  /** The panel's heading and accessible name. Default `Notifications`. */
  label?: string;
};

/**
 * The person's notifications, newest first, in a panel at the window's
 * top-right that scrolls (apps/mvp decision 0009). Controlled: `open` and
 * `onOpenChange`. Alt+N opens and closes it from anywhere; opening focuses
 * `focus`'s entry or the first, arrows (and J and K, Home and End) move
 * between entries, and Escape, ×, or a click outside it closes it and gives
 * focus back. A click on an element marked `data-notifications-trigger`, such
 * as `NotificationBell`, isn't outside. Not modal: the page stays usable.
 */
export function NotificationPanel({
  open,
  onOpenChange,
  children,
  focus,
  label = "Notifications",
  className,
  ...props
}: NotificationPanelProps) {
  useInjectUiCss();
  const panel = useRef<HTMLElement>(null);
  // Where focus was before the panel opened, to give it back when it closes.
  const before = useRef<HTMLElement | null>(null);
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  const shown = useRef(open);
  shown.current = open;
  const headingId = useId();

  useEffect(() => {
    const onHotkey = (event: globalThis.KeyboardEvent) => {
      if (!isNoticeHotkey(event, "notifications")) return;
      event.preventDefault();
      change.current(!shown.current);
    };
    document.addEventListener("keydown", onHotkey, true);
    return () => document.removeEventListener("keydown", onHotkey, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target === null || panel.current?.contains(target) === true || target.closest?.(TRIGGER) != null) return;
      change.current(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open]);

  // Opening takes focus into the panel; closing gives it back where it was, unless the person moved it elsewhere.
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (panel.current?.contains(active) !== true) before.current = active instanceof HTMLElement ? active : null;
    const entries = [...(panel.current?.querySelectorAll<HTMLElement>(ENTRY_FOCUS) ?? [])];
    const target = entries.find((entry) => entry.closest("[data-entry]")?.getAttribute("data-entry") === focus) ??
      entries[0] ?? panel.current?.querySelector<HTMLElement>("[data-panel-close]");
    target?.focus();
    return () => {
      const back = before.current;
      before.current = null;
      const active = document.activeElement;
      const lost = active === null || active === document.body || panel.current?.contains(active) === true;
      if (back !== null && back.isConnected && lost) back.focus();
    };
  }, [open, focus]);

  if (!open) return null;
  const items = Children.toArray(children);

  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    const action = noticeKeyAction(event);
    if (action === "close") {
      event.preventDefault();
      onOpenChange(false);
      return;
    }
    if (isTypingTarget(event.target) || action === undefined) return;
    if (moveFocus(event.currentTarget, ENTRY_FOCUS, action, event.target as Element)) event.preventDefault();
  };

  return (
    <section
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      aria-keyshortcuts={NOTICE_KEYS.notifications}
      data-slot="notification-panel"
      className={cn("sui-notification-panel", className)}
      onKeyDown={keys}
      {...props}
    >
      <header className="sui-notification-panel-head">
        <h2 id={headingId}>{label}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          aria-keyshortcuts="Escape"
          data-panel-close=""
          onClick={() => onOpenChange(false)}
        >
          ×
        </Button>
      </header>
      {items.length === 0 ? (
        <p className="sui-notification-empty">No notifications</p>
      ) : (
        <ul className="sui-notification-list" aria-label={label}>
          {items}
        </ul>
      )}
    </section>
  );
}

/** One of a run's steps, as a notification shows it. */
export type NotificationStep = { readonly id: string; readonly label: string; readonly state: "running" | "done" | "failed" };

const STEP_GLYPHS: Readonly<Record<NotificationStep["state"], string>> = { running: "◌", done: "✓", failed: "✕" };

export type NotificationEntryProps = Omit<ComponentProps<"li">, "children" | "onKeyDown"> & {
  /** Its key among the panel's entries, for the panel's `focus`. */
  entryId: string;
  /** The state it is about: its glyph, word and tone. */
  tone: NoticeState;
  /** Shown in bold in place of the state's word. */
  word?: ReactNode;
  /** What it is about, after the word: one line, whole once expanded. */
  detail?: ReactNode;
  /** When it happened, such as a `RelativeTime`. */
  time?: ReactNode;
  /** Not yet read: a dot, and `Unread` for screen readers. */
  unread?: boolean;
  /** Whether its body shows. Clicking the entry, Enter, Space or E toggles it. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Opens what it is about: the body's Open button, or O. */
  onOpen?: () => void;
  /** A row may open its subject directly; Details and E still expand it. */
  onActivate?: () => void;
  /** The body's open button's label. Default `Open`. */
  openLabel?: string;
  /** A: answers its question. */
  onAnswer?: () => void;
  /** ×, or H: hides or dismisses it, as `hideLabel` names it. */
  onHide: () => void;
  /** The × button's accessible name. Default `Hide`. */
  hideLabel?: string;
  /** R: marks it read. */
  onRead?: () => void;
  /** Who, under the heading in the body. */
  meta?: ReactNode;
  /** A run's last steps, in the body. */
  steps?: ReadonlyArray<NotificationStep>;
  /** A short text in the body, such as an answer or a failure. */
  note?: ReactNode;
  /** Buttons in the body before Open, such as Retry. */
  actions?: ReactNode;
  /** Anything else in the body, such as a question to answer. */
  children?: ReactNode;
};

/**
 * One notification in the panel: a row with the unread dot, the state's glyph
 * and word, the detail and the time, and ×. The row is a button that expands
 * the entry in place: its whole detail, who, the run's last steps, a note,
 * anything else given, and Open. A focused row takes `NOTICE_KEYS`: O opens,
 * E expands, A answers, H hides and R marks it read.
 */
export function NotificationEntry({
  entryId,
  tone,
  word,
  detail,
  time,
  unread = false,
  expanded,
  onExpandedChange,
  onOpen,
  onActivate,
  openLabel = "Open",
  onAnswer,
  onHide,
  hideLabel = "Hide",
  onRead,
  meta,
  steps,
  note,
  actions,
  children,
  className,
  ...props
}: NotificationEntryProps) {
  useInjectUiCss();
  const bodyId = useId();
  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    const act = noticeKeyAction(event);
    const run = act === "open"
      ? onOpen
      : act === "expand"
      ? () => onExpandedChange(!expanded)
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
    NOTICE_KEYS.expand,
    onAnswer === undefined ? null : NOTICE_KEYS.answer,
    NOTICE_KEYS.hide,
    onRead === undefined ? null : NOTICE_KEYS.read,
  ].filter((key) => key !== null).join(" ");
  return (
    <li
      data-slot="notification"
      data-entry={entryId}
      data-tone={tone}
      data-unread={unread ? "" : undefined}
      data-expanded={expanded ? "" : undefined}
      className={cn("sui-notification", className)}
      {...props}
    >
      <div className="sui-notification-head">
        <button
          type="button"
          data-slot="notification-row"
          className="sui-notification-row"
          aria-expanded={onActivate === undefined ? expanded : undefined}
          aria-controls={onActivate === undefined && expanded ? bodyId : undefined}
          aria-keyshortcuts={shortcuts}
          onClick={onActivate ?? (() => onExpandedChange(!expanded))}
          onKeyDown={keys}
        >
          {unread ? (
            <span className="sui-notification-unread">
              <span className="sui-sr-only">Unread</span>
            </span>
          ) : null}
          <span aria-hidden className="sui-notification-glyph">
            {tone === "failed" ? "!" : NOTICE_GLYPHS[tone]}
          </span>
          <span className="sui-notification-text">
            <b>{word === undefined ? NOTICE_WORDS[tone] : word}</b>
            {detail === undefined ? null : <> · {detail}</>}
          </span>
          {time === undefined ? null : <span className="sui-notification-time">{time}</span>}
        </button>
        {onActivate === undefined ? null : (
          <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined}
            onClick={() => onExpandedChange(!expanded)}>Details</Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="sui-notification-hide"
          aria-label={hideLabel}
          aria-keyshortcuts={NOTICE_KEYS.hide}
          onClick={onHide}
        >
          ×
        </Button>
      </div>
      {expanded ? (
        <div id={bodyId} data-slot="notification-body" className="sui-notification-body">
          {meta === undefined ? null : <p className="sui-notification-meta">{meta}</p>}
          {steps === undefined || steps.length === 0 ? null : (
            <ol className="sui-notification-steps" aria-label="Steps">
              {steps.map((step) => (
                <li key={step.id} data-state={step.state}>
                  <span aria-hidden className="sui-notification-step-glyph">
                    {STEP_GLYPHS[step.state]}
                  </span>
                  <span className="sui-sr-only">{step.state === "running" ? "Running" : step.state === "done" ? "Done" : "Failed"}</span>
                  {step.label}
                </li>
              ))}
            </ol>
          )}
          {note === undefined ? null : <p className="sui-notification-note">{note}</p>}
          {children}
          <div className="sui-notification-actions">
            {actions}
            {onOpen === undefined ? null : <Button size="sm" aria-keyshortcuts={NOTICE_KEYS.open} onClick={onOpen}>
              {openLabel}
            </Button>}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export type NotificationBellProps = Omit<ComponentProps<"button">, "children"> & {
  /** How many notifications are unread: a count on the bell above 0. */
  unread?: number;
  /** How many runs wait on the person: above 0, the bell reads `◆ Needs you` in gold, with the count above 1. */
  needsYou?: number;
  /** Whether the panel it opens shows. */
  expanded?: boolean;
};

/** The bell's accessible name: `Notifications`, then how many need the person and how many are unread. */
const bellLabel = (unread: number, needsYou: number) => {
  const parts = [
    needsYou > 0 ? `${needsYou} ${needsYou === 1 ? "needs" : "need"} you` : null,
    unread > 0 ? `${unread} unread` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Notifications" : `Notifications: ${parts.join(", ")}`;
};

/**
 * The top bar's one way in to the person's notifications: a bell that opens the notifications panel (Alt+N), with the
 * unread count on it, and, while runs wait on the person, `◆ Needs you` in gold beside it.
 */
export function NotificationBell({ unread = 0, needsYou = 0, expanded = false, className, ...props }: NotificationBellProps) {
  useInjectUiCss();
  return (
    <Button
      variant="ghost"
      size={needsYou > 0 ? "sm" : "icon"}
      data-slot="notification-bell"
      data-notifications-trigger=""
      data-needs-you={needsYou > 0 ? "" : undefined}
      aria-label={bellLabel(unread, needsYou)}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-keyshortcuts={NOTICE_KEYS.notifications}
      className={cn("sui-notification-bell", className)}
      {...props}
    >
      {needsYou > 0 ? (
        <span aria-hidden className="sui-notification-needs">
          <span className="sui-notification-needs-glyph">◆</span>
          Needs you
          {needsYou > 1 ? <span className="sui-notification-needs-count">{needsYou}</span> : null}
        </span>
      ) : null}
      <svg
        aria-hidden
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 6.5a4 4 0 0 1 8 0c0 3.5 1.5 4.5 1.5 4.5h-11S4 10 4 6.5Z" />
        <path d="M6.5 13.5a1.6 1.6 0 0 0 3 0" />
      </svg>
      {unread > 0 ? <span className="sui-notification-count">{unread > 99 ? "99+" : unread}</span> : null}
    </Button>
  );
}
