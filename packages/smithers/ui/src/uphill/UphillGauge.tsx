/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";
import { useUphillCss } from "./uphillCss";

export type UphillScoreBand = "good" | "warn" | "poor" | "failed" | "none";

export function uphillScoreBand(score: number | null | undefined, failed = false): UphillScoreBand {
  if (failed) return "failed";
  if (score === null || score === undefined || !Number.isFinite(score)) return "none";
  if (score >= 90) return "good";
  if (score >= 50) return "warn";
  return "poor";
}

export type UphillGaugeSize = "sm" | "md" | "lg";

const DIMENSIONS: Record<UphillGaugeSize, { readonly box: number; readonly stroke: number; readonly font: number }> = {
  sm: { box: 44, stroke: 4, font: 13 },
  md: { box: 64, stroke: 5, font: 18 },
  lg: { box: 84, stroke: 6, font: 22 },
};

export type UphillGaugeProps = Omit<ComponentProps<"span">, "children"> & {
  /** 0–100 score, or null when unscored / failed. */
  score: number | null | undefined;
  /** Category or metric label for accessibility. */
  label: string;
  /** True when the underlying metric script exited non-zero. */
  failed?: boolean;
  /** Visual size preset. */
  size?: UphillGaugeSize;
};

/** Lighthouse-style 0–100 circular SVG gauge. */
export function UphillGauge({ score, label, failed = false, size = "md", className, ...props }: UphillGaugeProps) {
  useInjectUiCss();
  useUphillCss();
  const band = uphillScoreBand(score, failed);
  const clamped = typeof score === "number" && Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
  const dim = DIMENSIONS[size];
  const radius = (dim.box - dim.stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = failed || clamped === null ? 0 : clamped / 100;
  const dashOffset = circumference * (1 - fraction);
  const display = failed ? "!" : clamped === null ? "–" : String(clamped);
  const ariaLabel = failed ? `${label}: failed` : clamped === null ? `${label}: unscored` : `${label}: ${clamped} out of 100`;

  return (
    <span
      data-slot="uphill-gauge"
      data-band={band}
      role="img"
      aria-label={ariaLabel}
      className={cn("sui-uphill-gauge", className)}
      style={{ width: dim.box, height: dim.box }}
      {...props}
    >
      <svg width={dim.box} height={dim.box} viewBox={`0 0 ${dim.box} ${dim.box}`} aria-hidden="true">
        <circle className="sui-uphill-gauge-track" cx={dim.box / 2} cy={dim.box / 2} r={radius} strokeWidth={dim.stroke} />
        {fraction > 0 ? (
          <circle
            className="sui-uphill-gauge-arc"
            cx={dim.box / 2}
            cy={dim.box / 2}
            r={radius}
            strokeWidth={dim.stroke}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        ) : null}
      </svg>
      <span className="sui-uphill-gauge-value" style={{ fontSize: dim.font }}>
        {display}
      </span>
    </span>
  );
}
