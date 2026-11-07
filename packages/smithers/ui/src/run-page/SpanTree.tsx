/** @jsxImportSource react */
import { type ComponentProps, type CSSProperties, type KeyboardEvent, useRef } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";
import { STEP_GLYPHS, STEP_WORDS, stepDuration, stepElapsed, type StepRow } from "./runPage";

export type SpanTreeProps = Omit<ComponentProps<"div">, "children" | "onSelect"> & {
  steps: ReadonlyArray<StepRow>;
  /** The selected step's id, or `null`. */
  selected: string | null;
  onSelect: (id: string) => void;
  now: number;
};

/**
 * A run's steps, one row each, indented by depth: glyph, label, attempts when
 * more than one, and duration. A listbox: one row takes Tab, the arrow keys
 * and Home and End move between rows, and Enter, Space or a click selects.
 */
export function SpanTree({ steps, selected, onSelect, now, className, ...props }: SpanTreeProps) {
  useInjectUiCss();
  const list = useRef<HTMLDivElement>(null);
  const tabStop = selected !== null && steps.some((step) => step.id === selected) ? selected : (steps[0]?.id ?? null);
  const focusRow = (index: number) => {
    const rows = list.current?.querySelectorAll<HTMLElement>("[role='option']");
    if (rows === undefined || rows.length === 0) return;
    rows[Math.min(Math.max(index, 0), rows.length - 1)]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number, id: string) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(index + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusRow(index - 1);
        return;
      case "Home":
        event.preventDefault();
        focusRow(0);
        return;
      case "End":
        event.preventDefault();
        focusRow(steps.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        onSelect(id);
        return;
    }
  };
  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Steps"
      data-slot="span-tree"
      className={cn("sui-span-tree", className)}
      {...props}
    >
      {steps.map((step, index) => (
        <div
          key={step.id}
          role="option"
          aria-selected={step.id === selected}
          tabIndex={step.id === tabStop ? 0 : -1}
          data-step={step.id}
          data-state={step.state}
          className="sui-span-tree-row"
          style={{ "--sui-span-depth": step.depth } as CSSProperties}
          onClick={() => onSelect(step.id)}
          onKeyDown={(event) => onKeyDown(event, index, step.id)}
        >
          <span aria-hidden className="sui-span-tree-glyph">
            {STEP_GLYPHS[step.state]}
          </span>
          <span className="sui-sr-only">{STEP_WORDS[step.state]}</span>
          <span className="sui-span-tree-label">{step.label}</span>
          {step.attempts > 1 ? (
            <span className="sui-span-tree-attempts" data-failed={step.failedAttempts > 0 ? "true" : undefined}>
              {step.attempts} attempts
            </span>
          ) : null}
          <span className="sui-span-tree-duration">{stepDuration(stepElapsed(step, now))}</span>
        </div>
      ))}
    </div>
  );
}
