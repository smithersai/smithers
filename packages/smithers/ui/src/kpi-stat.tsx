/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

export type KpiStatProps = ComponentProps<"div"> & {
  /** Uppercase metric label. */
  label: ReactNode;
  /** The big number/value. */
  value: ReactNode;
  /** Optional fine print under the value. */
  hint?: ReactNode;
};

/** Compact stat card (the styleguide `.kpi`/`.stat` pattern). */
export function KpiStat({ label, value, hint, className, ...props }: KpiStatProps) {
  useInjectUiCss();
  return (
    <div data-slot="kpi-stat" className={cn("sui-kpi", className)} {...props}>
      <div className="sui-kpi-label">{label}</div>
      <div className="sui-kpi-value">{value}</div>
      {hint ? <div className="sui-kpi-hint">{hint}</div> : null}
    </div>
  );
}
