/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";

/**
 * What an item's state icon draws, as GitHub's issue and pull request lists
 * do: an issue `open` or `closed`; a write this device `requested`; work
 * `queued`, `running`, waiting on a person (`needs_you`), `in_review` as a pull
 * request, `merged`, `dropped` or `failed`.
 */
export type ItemStateKind =
  | "open"
  | "closed"
  | "requested"
  | "queued"
  | "running"
  | "needs_you"
  | "in_review"
  | "merged"
  | "dropped"
  | "failed";

/**
 * An item's state as a list row or page shows it: the icon to draw, the word it
 * stands for, and whether work is under way on it now that a person can go and
 * watch (`live`), which makes the icon blink slowly.
 */
export type ItemStatus = { readonly kind: ItemStateKind; readonly label: string; readonly live?: boolean };

/** The Badge variant each kind's pill takes on an item's page; the icon takes the same color in a list. */
export const ITEM_STATE_VARIANTS: Readonly<
  Record<ItemStateKind, "success" | "muted" | "outline" | "default" | "warning" | "destructive">
> = {
  open: "success",
  closed: "muted",
  requested: "muted",
  queued: "outline",
  running: "default",
  needs_you: "warning",
  in_review: "success",
  merged: "default",
  dropped: "muted",
  failed: "destructive",
};

/** A 16-unit ring, the frame most kinds draw in. */
const ring = (dashed = false) => (
  <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dashed ? "2.4 2.1" : undefined} />
);

/** The marks inside the frame: each kind's shape in a 16 × 16 box, stroked or filled in the current color. */
const SHAPES: Readonly<Record<ItemStateKind, ReactNode>> = {
  open: (
    <>
      {ring()}
      <circle cx="8" cy="8" r="1.75" fill="currentColor" />
    </>
  ),
  closed: (
    <>
      {ring()}
      <path d="M5.25 8.25l1.9 1.9 3.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  requested: ring(true),
  queued: ring(),
  running: (
    <>
      {ring()}
      <path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor" />
    </>
  ),
  needs_you: (
    <>
      {ring()}
      <path d="M8 4.75v3.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11" r="0.95" fill="currentColor" />
    </>
  ),
  in_review: (
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.25" cy="3.75" r="1.75" />
      <circle cx="4.25" cy="12.25" r="1.75" />
      <circle cx="11.75" cy="12.25" r="1.75" />
      <path d="M4.25 5.5v5M11.75 10.5V6.25a1.75 1.75 0 0 0-1.75-1.75H7.5M9 3l-1.5 1.5L9 6" />
    </g>
  ),
  merged: (
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.25" cy="3.75" r="1.75" />
      <circle cx="4.25" cy="12.25" r="1.75" />
      <circle cx="11.75" cy="8.75" r="1.75" />
      <path d="M4.25 5.5v5M4.25 5.5c0 2.25 1.75 3.25 5.75 3.25" />
    </g>
  ),
  dropped: (
    <>
      {ring()}
      <path d="M3.75 12.25l8.5-8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  failed: (
    <>
      {ring()}
      <path d="M6 6l4 4M10 6l-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
};

export type ItemStateIconProps = Omit<ComponentProps<"svg">, "children"> & {
  kind: ItemStateKind;
  /** The state's word: the icon's accessible name. */
  label: string;
  /**
   * Work is under way now: the icon blinks slowly, one 2-second cycle, and
   * holds steady when the person prefers reduced motion.
   */
  live?: boolean;
};

/**
 * An item's state as a 16-pixel icon, as GitHub's lists draw one: an image
 * named `label`, colored for its kind (`ITEM_STATE_VARIANTS`). A `live` icon
 * carries `data-live` and blinks slowly while the work goes on.
 */
export function ItemStateIcon({ kind, label, live = false, className, ...props }: ItemStateIconProps) {
  useInjectUiCss();
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      data-slot="item-state-icon"
      data-kind={kind}
      data-live={live ? "" : undefined}
      className={cn("sui-state-icon", className)}
      {...props}
    >
      {SHAPES[kind]}
    </svg>
  );
}
