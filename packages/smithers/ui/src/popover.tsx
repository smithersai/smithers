/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

/**
 * Radix Popover on the overlay tokens: a panel anchored to its trigger that
 * holds interactive content, such as a picker or a menu with a field. Escape,
 * a click outside and the trigger close it; focus moves into it on open and
 * back to the trigger on close.
 *
 * ```tsx
 * <Popover>
 *   <PopoverTrigger asChild><Button>Code</Button></PopoverTrigger>
 *   <PopoverContent>...</PopoverContent>
 * </Popover>
 * ```
 */
export function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>) {
  useInjectUiCss();
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

export function PopoverTrigger(props: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/** The panel, in a portal; aligned to the trigger's start, 6px below it, unless set. */
export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn("sui-popover-content", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
