/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

/**
 * Radix Tabs with the house underline tab bar. TabsTrigger takes an optional
 * `count` for the tab-bar-with-counts pattern:
 *
 * ```tsx
 * <Tabs defaultValue="runs">
 *   <TabsList>
 *     <TabsTrigger value="runs" count={12}>Runs</TabsTrigger>
 *     <TabsTrigger value="events">Events</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="runs">...</TabsContent>
 * </Tabs>
 * ```
 */
export function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  useInjectUiCss();
  return <TabsPrimitive.Root data-slot="tabs" className={cn("sui-tabs", className)} {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("sui-tabs-list", className)} {...props} />;
}

export type TabsTriggerProps = ComponentProps<typeof TabsPrimitive.Trigger> & {
  /** Optional count pill rendered after the label. */
  count?: number;
};

export function TabsTrigger({ className, count, children, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn("sui-tabs-trigger", className)} {...props}>
      {children}
      {count !== undefined ? <span className="sui-tab-count">{count}</span> : null}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("sui-tabs-content", className)} {...props} />;
}
