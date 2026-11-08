/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

/**
 * A placeholder in the place of content that is loading. Size it like the
 * content it stands for (`style` or a consumer class), so the content takes
 * its box without shifting layout. It is invisible for the first
 * `LOADING_DELAY_MS`, so a fast load shows nothing; then it fades in and
 * pulses gently, and holds still under reduced motion.
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="skeleton" aria-hidden className={cn("sui-skeleton", className)} {...props} />;
}
