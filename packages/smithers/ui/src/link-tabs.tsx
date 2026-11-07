/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

export type LinkTabsProps = ComponentProps<"nav">;

/**
 * A row of page tabs that are links, such as a repository's Home and Code: a `<nav>` whose child links draw as tabs,
 * the one with `aria-current="page"` underlined. The host renders the links, its router's own, and names the nav.
 */
export function LinkTabs({ className, ...props }: LinkTabsProps) {
  useInjectUiCss();
  return <nav data-slot="link-tabs" className={cn("sui-link-tabs", className)} {...props} />;
}
