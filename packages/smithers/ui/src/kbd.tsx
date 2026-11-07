/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

export type KbdProps = ComponentProps<"kbd">;

/** A keyboard key chip, such as `<Kbd>⌘K</Kbd>`. */
export function Kbd({ className, ...props }: KbdProps) {
  useInjectUiCss();
  return <kbd data-slot="kbd" className={cn("sui-kbd", className)} {...props} />;
}
