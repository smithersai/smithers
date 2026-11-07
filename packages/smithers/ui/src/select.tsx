/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

/**
 * Radix Select with shadcn anatomy, themed listbox included. For trivial
 * cases a native `<select>` styled by the styleguide is still fine.
 *
 * ```tsx
 * <Select value={model} onValueChange={setModel}>
 *   <SelectTrigger><SelectValue placeholder="Model" /></SelectTrigger>
 *   <SelectContent>
 *     <SelectItem value="fast">Fast</SelectItem>
 *     <SelectItem value="strong">Strong</SelectItem>
 *   </SelectContent>
 * </Select>
 * ```
 */
export function Select(props: ComponentProps<typeof SelectPrimitive.Root>) {
  useInjectUiCss();
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

export function SelectGroup(props: ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

export function SelectValue(props: ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger data-slot="select-trigger" className={cn("sui-select-trigger", className)} {...props}>
      {children}
      <SelectPrimitive.Icon asChild>
        <svg
          className="sui-select-icon"
          aria-hidden
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 3.75L5 6.75l3-3" />
        </svg>
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  sideOffset = 4,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={sideOffset}
        className={cn("sui-select-content", className)}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="sui-select-scroll-button">
          <svg
            aria-hidden
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 6.25l3-3 3 3" />
          </svg>
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="sui-select-viewport">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="sui-select-scroll-button">
          <svg
            aria-hidden
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 3.75L5 6.75l3-3" />
          </svg>
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label data-slot="select-label" className={cn("sui-select-label", className)} {...props} />;
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={cn("sui-select-item", className)} {...props}>
      <span className="sui-select-item-indicator">
        <SelectPrimitive.ItemIndicator>
          <svg
            aria-hidden
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M1.5 5.5l2.5 2.5 4.5-5" />
          </svg>
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("sui-select-separator", className)}
      {...props}
    />
  );
}
