/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

export type ProgressProps = ComponentProps<typeof ProgressPrimitive.Root>;

/** Determinate progress bar (brand fill on the muted track), Radix a11y semantics. */
export function Progress({ className, value, max, ...props }: ProgressProps) {
  useInjectUiCss();
  // Radix falls back to 100 for a missing/invalid max; mirror that so the fill matches the announced value.
  const ceiling = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : 100;
  // Radix treats an out-of-range value as indeterminate (no aria-valuenow), so
  // the announced value is clamped to the same range as the painted fill.
  // Only a missing or non-finite value is genuinely indeterminate.
  const clamped = typeof value === "number" && Number.isFinite(value)
    ? Math.min(ceiling, Math.max(0, value))
    : null;
  const percent = ((clamped ?? 0) / ceiling) * 100;
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={clamped}
      max={ceiling}
      className={cn("sui-progress", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="sui-progress-indicator"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
