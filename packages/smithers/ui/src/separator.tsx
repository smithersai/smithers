/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Separator as SeparatorPrimitive } from "radix-ui";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

/** Hairline divider (horizontal by default), Radix separator semantics. */
export function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>) {
  useInjectUiCss();
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      orientation={orientation}
      decorative={decorative}
      className={cn("sui-separator", className)}
      {...props}
    />
  );
}
