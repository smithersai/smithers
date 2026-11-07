/** @jsxImportSource react */
import type { ComponentProps, KeyboardEvent, MouseEvent } from "react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@smthrs/ui-css";
import { isPlainNavigationClick } from "./internal/navigationClick";
import { useInjectUiCss } from "./styles";

/** One open file in a {@link FileTabs} strip. */
export type FileTab = {
  /** Stable identity within the strip (the file's path works). */
  key: string;
  /** What the tab shows: the file's name. */
  label: string;
  /** The whole path, shown on hover. */
  title?: string;
  /** Where the tab links, so a modified click opens it in a new browser tab. */
  href: string;
  /** The file the page shows now. At most one tab is active. */
  active: boolean;
};

/** Content-free diagnostics for the strip's keyboard focus handoff. */
export type FileTabsFocusEvent = {
  phase: "requested" | "consumed" | "dropped";
  reason: "keyboard" | "restored" | "disconnected" | "outside";
};

export type FileTabsProps = Omit<ComponentProps<"div">, "children" | "role"> & {
  /** The open files, in the order they opened. */
  tabs: ReadonlyArray<FileTab>;
  /**
   * A plain click on a tab, or Enter or Space on it. The browser's default is
   * prevented first; a modified click (⌘, Ctrl, Shift, Alt, middle button)
   * keeps the browser's behavior.
   */
  onOpen: (tab: FileTab) => void;
  /** The tab's close button, or Delete or Backspace on the tab. */
  onClose: (tab: FileTab) => void;
  /** Records focus ownership without including file names or paths. */
  onFocusLifecycle?: (event: FileTabsFocusEvent) => void;
};

const NEXT: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

/**
 * A strip of open files above a code view, as an editor's tabs: each tab links
 * to its file and has a close button. It is a tablist: one tab is in the Tab
 * order (the active one, else the first); ←, →, Home and End move between
 * tabs, Enter or Space opens one, and Delete or Backspace closes it, moving
 * focus to the tab that takes its place. It holds no state: the host says
 * which files are open and which is active.
 */
export function FileTabs({ tabs, onOpen, onClose, onFocusLifecycle, className, "aria-label": label, ...props }: FileTabsProps) {
  useInjectUiCss();
  const focused = useRef<HTMLAnchorElement | null>(null);
  const report = useRef(onFocusLifecycle);
  report.current = onFocusLifecycle;
  useLayoutEffect(() => {
    // Suspense hides a pending route and drops browser focus to the body.
    // Restore the strip's focus on reveal unless another control now owns it.
    const element = focused.current;
    if (element?.isConnected && element.ownerDocument.activeElement === element.ownerDocument.body) {
      report.current?.({ phase: "requested", reason: "restored" });
      element.focus();
      report.current?.({ phase: "consumed", reason: "restored" });
    }
    return () => {
      if (focused.current !== null && focused.current !== focused.current.ownerDocument.activeElement) {
        report.current?.({ phase: "dropped", reason: "outside" });
        focused.current = null;
      } else if (focused.current !== null) {
        report.current?.({ phase: "dropped", reason: "disconnected" });
      }
    };
  }, []);
  if (tabs.length === 0) return null;
  const focusable = Math.max(0, tabs.findIndex((tab) => tab.active));
  const follow = (tab: FileTab) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainNavigationClick(event)) return;
    event.preventDefault();
    onOpen(tab);
  };
  const keys = (index: number) => (event: KeyboardEvent<HTMLAnchorElement>) => {
    const strip = event.currentTarget.closest("[data-slot=file-tabs]");
    const focusAt = (at: number) => {
      report.current?.({ phase: "requested", reason: "keyboard" });
      const element = strip?.querySelectorAll<HTMLElement>("[role=tab]")[at];
      element?.focus();
      report.current?.(element !== undefined && element.ownerDocument.activeElement === element
        ? { phase: "consumed", reason: "keyboard" }
        : { phase: "dropped", reason: "disconnected" });
    };
    const move = NEXT[event.key];
    if (move !== undefined) {
      event.preventDefault();
      focusAt(move(index, tabs.length));
    } else if (event.key === " ") {
      event.preventDefault();
      onOpen(tabs[index]!);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      // The tab that takes its place: the next one, else the one before.
      focusAt(index + 1 < tabs.length ? index + 1 : index - 1);
      onClose(tabs[index]!);
    }
  };
  return (
    <div
      data-slot="file-tabs"
      role="tablist"
      aria-label={label ?? "Open files"}
      className={cn("sui-file-tabs", className)}
      {...props}
    >
      {tabs.map((tab, index) => (
        <span key={tab.key} className="sui-file-tab" data-active={tab.active ? "true" : undefined}>
          <a
            role="tab"
            href={tab.href}
            title={tab.title}
            aria-selected={tab.active}
            tabIndex={index === focusable ? 0 : -1}
            onClick={follow(tab)}
            onKeyDown={keys(index)}
            onFocus={(event) => { focused.current = event.currentTarget; }}
          >
            {tab.label}
          </a>
          <button type="button" tabIndex={-1} aria-label={`Close ${tab.label}`} onClick={() => onClose(tab)}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}
