/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { EmptyState } from "../empty-state";
import { useInjectUiCss } from "../styles";

export type JSXPreviewProps = Omit<ComponentProps<"div">, "children"> & {
  node?: ReactNode;
  inert?: boolean;
  unavailableReason?: string;
};

/**
 * Renders a caller-provided React node inside an inert preview frame. Never
 * synthesizes output: with no node it shows an honest unavailable state.
 */
export function JSXPreview({ node, inert = true, unavailableReason, className, ...props }: JSXPreviewProps) {
  useInjectUiCss();
  if (node === undefined) {
    return (
      <div data-slot="jsx-preview" className={cn("sui-jsxpreview", className)} {...props}>
        <EmptyState title={unavailableReason ?? "Preview unavailable"} />
      </div>
    );
  }
  return (
    <div data-slot="jsx-preview" className={cn("sui-jsxpreview", className)} {...props}>
      <div data-slot="jsx-preview-frame" className="sui-jsxpreview-frame" inert={inert}>
        {node}
      </div>
    </div>
  );
}
