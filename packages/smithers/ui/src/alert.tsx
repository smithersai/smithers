/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

export const alertVariants = cva("sui-alert", {
  variants: {
    variant: {
      default: "",
      success: "sui-alert-success",
      warning: "sui-alert-warning",
      destructive: "sui-alert-destructive",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type AlertProps = ComponentProps<"div"> & VariantProps<typeof alertVariants>;

/**
 * Inline callout. The designated surface for honest degradation states
 * ("gateway not connected", "no credentials") -- use `variant="warning"` or
 * `variant="destructive"` rather than faking success.
 */
export function Alert({ className, variant, ...props }: AlertProps) {
  useInjectUiCss();
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("sui-alert-title", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("sui-alert-description", className)} {...props} />;
}
