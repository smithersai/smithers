/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

/**
 * Card family with shadcn anatomy on the house `.card` metrics (8px radius,
 * 14px padding, layered shadow). Compose:
 *
 * ```tsx
 * <Card>
 *   <CardHeader>
 *     <CardTitle>Runs</CardTitle>
 *     <CardAction><Badge>3 active</Badge></CardAction>
 *   </CardHeader>
 *   <CardContent>...</CardContent>
 * </Card>
 * ```
 */
export function Card({ className, ...props }: ComponentProps<"section">) {
  useInjectUiCss();
  return <section data-slot="card" className={cn("sui-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("sui-card-header", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("sui-card-title", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("sui-card-description", className)} {...props} />;
}

/** Right-aligned slot inside CardHeader for badges/buttons. */
export function CardAction({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-action" className={cn("sui-card-action", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("sui-card-content", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("sui-card-footer", className)} {...props} />;
}
