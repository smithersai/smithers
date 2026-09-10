/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { Shimmer } from "./Shimmer";

export type MarkerProps = Omit<ComponentProps<"div">, "children"> & {
  variant?: "separator" | "note" | "status";
  live?: boolean;
  shimmer?: boolean;
  children: ReactNode;
};

/** Labeled chat separator, system note, or streaming-status row. */
export function Marker({
  variant = "separator",
  live = false,
  shimmer = false,
  className,
  children,
  ...nativeProps
}: MarkerProps) {
  useInjectUiCss();
  const { role, "aria-live": _ariaLive, ...props } = nativeProps;
  const label = shimmer ? <Shimmer active>{children}</Shimmer> : children;
  return (
    <div
      data-slot="marker"
      data-variant={variant}
      role={role === "separator" ? undefined : role}
      aria-live={live ? "polite" : undefined}
      className={cn("sui-marker", className)}
      {...props}
    >
      <span data-slot="marker-label" className="sui-marker-label">
        {label}
      </span>
    </div>
  );
}
