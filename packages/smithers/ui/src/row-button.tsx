/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

export type RowButtonProps = ComponentProps<"button"> & {
  /** Selected state: brand border + inset brand bar (the house run-row recipe). */
  active?: boolean;
};

/**
 * Full-width selectable list row with button semantics. Unifies the
 * run-row / finding / ticket-row / clickable-card variants.
 */
export function RowButton({ active = false, className, type, ...props }: RowButtonProps) {
  useInjectUiCss();
  return (
    <button
      data-slot="row-button"
      data-active={active ? "true" : undefined}
      type={type ?? "button"}
      className={cn("sui-row-button", className)}
      {...props}
    />
  );
}
