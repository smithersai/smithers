/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";

/** A titled work-product surface (file, report, preview) with header actions. */
export function Artifact({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="artifact" className={cn("sui-artifact", className)} {...props} />;
}

export function ArtifactHeader({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="artifact-header" className={cn("sui-artifact-header", className)} {...props} />;
}

export function ArtifactTitle({ className, ...props }: ComponentProps<"h3">) {
  useInjectUiCss();
  return <h3 data-slot="artifact-title" className={cn("sui-artifact-title", className)} {...props} />;
}

export function ArtifactDescription({ className, ...props }: ComponentProps<"p">) {
  useInjectUiCss();
  return <p data-slot="artifact-description" className={cn("sui-artifact-description", className)} {...props} />;
}

export function ArtifactActions({ className, "aria-label": ariaLabel, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return (
    <div
      data-slot="artifact-actions"
      role="toolbar"
      aria-label={ariaLabel ?? "Artifact actions"}
      className={cn("sui-artifact-actions", className)}
      {...props}
    />
  );
}

export type ArtifactActionProps = Omit<ComponentProps<"button">, "children"> & {
  /** Required accessible name for the icon button. */
  label: string;
  tooltip?: string;
  icon?: ReactNode;
};

/** Icon button for an artifact toolbar; the sr label is mandatory. */
export function ArtifactAction({ label, tooltip, icon, className, type, ...props }: ArtifactActionProps) {
  useInjectUiCss();
  const button = (
    <button
      type={type ?? "button"}
      data-slot="artifact-action"
      aria-label={label}
      className={cn("sui-artifact-action", className)}
      {...props}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span className="sui-sr-only">{label}</span>
    </button>
  );
  if (tooltip === undefined) return button;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export type ArtifactCloseProps = Omit<ComponentProps<"button">, "children"> & {
  onClose?: () => void;
  label?: string;
};

/** Dismiss affordance for hosts that render artifacts in closable panels. */
export function ArtifactClose({ onClose, label = "Close artifact", className, type, onClick, ...props }: ArtifactCloseProps) {
  useInjectUiCss();
  return (
    <button
      type={type ?? "button"}
      data-slot="artifact-close"
      aria-label={label}
      className={cn("sui-artifact-close", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onClose?.();
      }}
      {...props}
    >
      <span aria-hidden="true">×</span>
    </button>
  );
}

export function ArtifactContent({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="artifact-content" className={cn("sui-artifact-content", className)} {...props} />;
}
