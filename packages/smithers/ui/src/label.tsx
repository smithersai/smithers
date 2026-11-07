/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Label as LabelPrimitive } from "radix-ui";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

/** Uppercase 11px form label (the styleguide `.label` recipe), on Radix Label. */
export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  useInjectUiCss();
  return <LabelPrimitive.Root data-slot="label" className={cn("sui-label", className)} {...props} />;
}

/**
 * Vertical label + control group (the styleguide `.field` grid):
 *
 * ```tsx
 * <Field>
 *   <Label htmlFor="prompt">Prompt</Label>
 *   <Input id="prompt" />
 * </Field>
 * ```
 */
export function Field({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="field" className={cn("sui-field", className)} {...props} />;
}
