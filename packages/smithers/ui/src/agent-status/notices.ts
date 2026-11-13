/**
 * Notices (apps/mvp decision 0009 §4): what a toast or a feed entry is about,
 * and when its toast shows. The agent's five states plus `update`, and pure
 * visibility, so a component keeps no timers and a reload draws the same
 * stack. Framework-free.
 */
import { AGENT_STATUS_GLYPHS, AGENT_STATUS_WORDS, type AgentState } from "./agentStatus";

/** What a notice is about: one of the agent's five states, or `update`, an event such as a repository's main moving or a new release. */
export type NoticeState = AgentState | "update";

/** The glyph each notice state shows: the agent's glyphs plus `●` for an update. */
export const NOTICE_GLYPHS: Readonly<Record<NoticeState, string>> = Object.freeze({
  ...AGENT_STATUS_GLYPHS,
  update: "●",
});

/** The one word each notice state shows: the agent's words plus `Updated`. */
export const NOTICE_WORDS: Readonly<Record<NoticeState, string>> = Object.freeze({
  ...AGENT_STATUS_WORDS,
  update: "Updated",
});

const SETTLED_TOAST_MS = 4000;

/** Milliseconds a notice's toast shows before it hides on its own: 4000 for "done" and "update"; Infinity for the rest (they show while live, until answered, or until dismissed). */
export const noticeDismissDelay = (state: NoticeState): number =>
  state === "done" || state === "update" ? SETTLED_TOAST_MS : Number.POSITIVE_INFINITY;

/**
 * The keys notices answer to, as `aria-keyshortcuts` names them: Alt+T focuses the first toast and Alt+N opens or
 * closes the notifications panel outside editable fields; on a focused toast or notification, O opens what it is about, E
 * expands it (a toast's opens the panel at it), A answers its question, H hides it and R marks it read. Arrows (and
 * J and K) move between them, Home and End go to the first and last, and Escape leaves.
 */
export const NOTICE_KEYS = Object.freeze({
  toasts: "Alt+T",
  notifications: "Alt+N",
  open: "O",
  expand: "E",
  answer: "A",
  hide: "H",
  read: "R",
} as const);

/** What a key does on a focused toast or notification. */
export type NoticeKeyAction = "open" | "expand" | "answer" | "hide" | "read" | "next" | "previous" | "first" | "last" | "close";

const NOTICE_KEY_ACTIONS: Readonly<Record<string, NoticeKeyAction>> = {
  o: "open",
  e: "expand",
  a: "answer",
  h: "hide",
  r: "read",
  arrowdown: "next",
  j: "next",
  arrowup: "previous",
  k: "previous",
  home: "first",
  end: "last",
  escape: "close",
};

/** A key event as the notice keys read it. */
export interface NoticeKeyEvent {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

/**
 * What `event` does on a focused toast or notification (`NOTICE_KEYS`), or `undefined`: any key held with Alt, Ctrl
 * or ⌘, and any other key, does nothing. Shift doesn't matter. Pure.
 */
export const noticeKeyAction = (event: NoticeKeyEvent): NoticeKeyAction | undefined =>
  event.altKey === true || event.ctrlKey === true || event.metaKey === true
    ? undefined
    : NOTICE_KEY_ACTIONS[event.key.toLowerCase()];

/** Whether `event` is Alt+T (`toasts`) or Alt+N (`notifications`), by the key's place, so a layout's Alt character doesn't matter. Pure. */
export const isNoticeHotkey = (
  event: { readonly code: string; readonly altKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean },
  hotkey: "toasts" | "notifications",
): boolean =>
  event.altKey && !event.ctrlKey && !event.metaKey && event.code === (hotkey === "toasts" ? "KeyT" : "KeyN");

/** Whether a key event came from a field the person types in, where a notice's letter keys stay letters. */
export const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as { readonly tagName?: string; readonly isContentEditable?: boolean } | null;
  const tag = element?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element?.isContentEditable === true;
};

/** Whether a notice's toast shows at nowMs (0009 §4): open, not hidden, and nowMs < updatedAtMs + noticeDismissDelay(state). Pure. */
export const workNoticeVisible = (
  notice: {
    readonly state: NoticeState;
    readonly updatedAtMs: number;
    readonly open: boolean;
    readonly hidden: boolean;
  },
  nowMs: number,
): boolean => notice.open && !notice.hidden && nowMs < notice.updatedAtMs + noticeDismissDelay(notice.state);
