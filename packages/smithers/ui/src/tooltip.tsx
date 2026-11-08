/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

/**
 * Radix Tooltip on the inverse-surface tokens. Wrap the app (or a subtree)
 * once in TooltipProvider:
 *
 * ```tsx
 * <TooltipProvider>
 *   <Tooltip>
 *     <TooltipTrigger asChild><Button size="icon">?</Button></TooltipTrigger>
 *     <TooltipContent>Explain the thing</TooltipContent>
 *   </Tooltip>
 * </TooltipProvider>
 * ```
 */
export function TooltipProvider({ delayDuration = 250, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

export function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
  useInjectUiCss();
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

export function TooltipTrigger(props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn("sui-tooltip-content", className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
