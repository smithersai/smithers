/** @jsxImportSource react */
import type { ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";

/** One row a composer offers while typing: a command, or an argument's value. */
export type ComposerCompletion = {
  /** Stable across renders: the row's React key. */
  id: string;
  label: ReactNode;
  /** A muted second column, such as a command's description; none when absent or `null`. */
  detail?: ReactNode;
};

/**
 * What a composer lists while typing, controlled by the host: the rows, which one is highlighted, and what the
 * keys and the pointer do. The host owns every piece of state.
 */
export type ChatComposerCompletions = {
  /** The list's accessible name, such as "Commands". */
  label: string;
  items: ReadonlyArray<ComposerCompletion>;
  /** The highlighted row; clamped into range. */
  highlighted: number;
  /** ArrowDown and ArrowUp (wrapping), or the pointer moving over a row. */
  onHighlight: (index: number) => void;
  /** Enter or a click accepts a row; Tab completes it. */
  onChoose: (index: number, how: "accept" | "complete") => void;
  /** Escape closes the list. The composer keeps its draft. */
  onDismiss: () => void;
};

/** The DOM id of the option at `index` in the list `listId`: what the input's `aria-activedescendant` names. */
export const completionOptionId = (listId: string, index: number): string => `${listId}-option-${index}`;

/** The highlighted row, clamped into `0..length-1`. */
export const clampHighlight = (highlighted: number, length: number): number =>
  Math.min(Math.max(0, Math.trunc(highlighted) || 0), Math.max(0, length - 1));

export type CompletionListProps = {
  id: string;
  completions: ChatComposerCompletions;
  className?: string;
};

/**
 * The listbox a composer shows above its input. Focus never leaves the input: a row is `role="option"`, the input
 * points at the highlighted one through `aria-activedescendant`, and pressing a row doesn't take focus.
 */
export function CompletionList({ id, completions, className }: CompletionListProps) {
  useInjectUiCss();
  const { items, label, onChoose, onHighlight } = completions;
  const highlighted = clampHighlight(completions.highlighted, items.length);
  return (
    <div id={id} role="listbox" aria-label={label} data-slot="completion-list" className={cn("sui-completion-list", className)}>
      {items.map((item, index) => {
        const selected = index === highlighted;
        return (
          <div
            key={item.id}
            id={completionOptionId(id, index)}
            role="option"
            aria-selected={selected}
            data-highlighted={selected ? "true" : "false"}
            className="sui-completion-option"
            ref={selected ? revealHighlighted : undefined}
            // Only real pointer motion moves the highlight, never a list reflowing under a still pointer.
            onMouseMove={() => {
              if (!selected) onHighlight(index);
            }}
            // Keeps focus in the input.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(index, "accept")}
          >
            <span className="sui-completion-label">{item.label}</span>
            {item.detail === undefined || item.detail === null ? null : <span className="sui-completion-detail">{item.detail}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Scrolls only the list, so the highlighted row stays in view as the arrows move it. */
const revealHighlighted = (node: HTMLDivElement | null) => {
  node?.scrollIntoView?.({ block: "nearest" });
};
