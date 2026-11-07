/** @jsxImportSource react */
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

export type SegmentedControlOption = {
  value: string;
  label: ReactNode;
  /** Skipped by the arrow keys and drawn struck through. */
  disabled?: boolean;
  title?: string;
};

export type SegmentedControlProps = Omit<
  ComponentProps<"div">,
  "children" | "role" | "onChange" | "defaultValue" | "aria-label"
> & {
  /** The checked option's value. */
  value: string;
  options: ReadonlyArray<SegmentedControlOption>;
  /** Called with the option a click or an arrow key checks. */
  onValueChange: (value: string) => void;
  "aria-label": string;
  /** `sm` is `--ctl-h-sm` tall; the default is `--ctl-h`. */
  size?: "sm";
};

const STEP: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** The next enabled option from `from` in `step` direction, wrapping; `from` itself when no other is enabled. */
function nextEnabled(options: ReadonlyArray<SegmentedControlOption>, from: number, step: 1 | -1): number {
  for (let offset = 1; offset < options.length; offset++) {
    const index = (from + step * offset + options.length) % options.length;
    if (!options[index]!.disabled) return index;
  }
  return from;
}

/**
 * A single-choice row of buttons: a `radiogroup` of `radio`s. Controlled; the
 * host owns `value`. Only the checked option is in the tab order, and the
 * arrow keys check and focus the next enabled option, wrapping.
 */
export function SegmentedControl({
  value,
  options,
  onValueChange,
  size,
  className,
  ...props
}: SegmentedControlProps) {
  useInjectUiCss();
  const checked = options.findIndex((option) => option.value === value && !option.disabled);
  const tabbable = checked >= 0 ? checked : options.findIndex((option) => !option.disabled);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = nextEnabled(options, index, step);
    if (next === index) return;
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
    onValueChange(options[next]!.value);
  };
  return (
    <div
      data-slot="segmented-control"
      data-size={size}
      role="radiogroup"
      className={cn("sui-segmented", className)}
      {...props}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className="sui-segmented-item"
          aria-checked={option.value === value}
          tabIndex={index === tabbable ? 0 : -1}
          disabled={option.disabled}
          title={option.title}
          onClick={() => {
            if (option.value !== value) onValueChange(option.value);
          }}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
