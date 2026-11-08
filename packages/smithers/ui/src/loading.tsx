/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { LOADING_DELAY_MS } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

export { LOADING_DELAY_MS };

export type LoadingBarProps = Omit<ComponentProps<"div">, "children"> & {
  /** Whether the load is in flight. The bar shows only once it has lasted {@link LOADING_DELAY_MS}. */
  loading: boolean;
  /**
   * `page`: fixed to the top of the viewport, for a navigation. `inline`: at
   * the top edge of the nearest positioned ancestor, for one card or button.
   */
  placement?: "page" | "inline";
  /**
   * The bar's accessible name while it loads, as a `progressbar`. Without one the bar is decorative (`aria-hidden`):
   * for a control that says it is busy itself, such as a `Button` with `loading`.
   */
  label?: string;
};

/**
 * A thin indeterminate bar: with `Skeleton`, the whole loading pattern; there
 * is no spinner. It stays mounted, so it never shifts layout; it appears only
 * after {@link LOADING_DELAY_MS} of loading and fades out when the load
 * settles. Under reduced motion it holds still at full width.
 */
export function LoadingBar({ loading, placement = "page", label, className, ...props }: LoadingBarProps) {
  useInjectUiCss();
  return (
    <div
      data-slot="loading-bar"
      data-state={loading ? "loading" : "idle"}
      data-placement={placement}
      className={cn("sui-loading-bar", className)}
      {...(loading && label !== undefined ? { role: "progressbar", "aria-label": label } : { "aria-hidden": true })}
      {...props}
    />
  );
}
