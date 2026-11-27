import { useInsertionEffect } from "react";

export const UPHILL_CSS_ATTR = "data-smithers-uphill-css";

export const uphillCss = `
.sui-uphill {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  color: var(--sui-fg, inherit);
}
.sui-uphill-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.sui-uphill-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--sui-muted-fg, #6b7280);
}
.sui-uphill-gauges {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 0.75rem;
}
.sui-uphill-gauge-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 0.875rem 0.625rem;
  border-radius: var(--sui-radius-md, 0.5rem);
  border: 1px solid var(--sui-border, rgba(127, 127, 127, 0.22));
  background: var(--sui-surface, transparent);
  color: inherit;
  text-align: center;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
.sui-uphill-gauge-card:hover {
  border-color: var(--sui-accent, currentColor);
}
.sui-uphill-gauge-card[aria-pressed="true"] {
  border-color: var(--sui-accent, currentColor);
  background: var(--sui-surface-subtle, rgba(127, 127, 127, 0.08));
}
.sui-uphill-gauge {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.sui-uphill-gauge[data-band="good"] { --sui-uphill-tone: var(--sui-success, #0c9c59); }
.sui-uphill-gauge[data-band="warn"] { --sui-uphill-tone: var(--sui-warning, #d97706); }
.sui-uphill-gauge[data-band="poor"] { --sui-uphill-tone: var(--sui-danger, #dc2626); }
.sui-uphill-gauge[data-band="failed"] { --sui-uphill-tone: var(--sui-danger, #dc2626); }
.sui-uphill-gauge[data-band="none"] { --sui-uphill-tone: var(--sui-muted-fg, #71717a); }
.sui-uphill-gauge-track {
  fill: none;
  stroke: var(--sui-border, rgba(127, 127, 127, 0.2));
}
.sui-uphill-gauge-arc {
  fill: none;
  stroke: var(--sui-uphill-tone);
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
}
.sui-uphill-gauge-value {
  position: absolute;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--sui-uphill-tone);
  line-height: 1;
}
.sui-uphill-gauge-title {
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1.25;
}
.sui-uphill-gauge-delta {
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: var(--sui-muted-fg, #6b7280);
}
.sui-uphill-gauge-delta[data-dir="up"] { color: var(--sui-success, #0c9c59); }
.sui-uphill-gauge-delta[data-dir="down"] { color: var(--sui-danger, #dc2626); }
.sui-uphill-section {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}
.sui-uphill-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.sui-uphill-section-title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}
.sui-uphill-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--sui-border, rgba(127, 127, 127, 0.22));
  border-radius: var(--sui-radius-md, 0.5rem);
  overflow: hidden;
}
.sui-uphill-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.55rem 0.75rem;
  font-size: 0.8125rem;
  border-top: 1px solid var(--sui-border, rgba(127, 127, 127, 0.14));
}
.sui-uphill-row:first-child { border-top: none; }
.sui-uphill-gain {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--sui-success, #0c9c59);
  min-width: 2.75rem;
}
.sui-uphill-target {
  font-variant-numeric: tabular-nums;
  color: var(--sui-muted-fg, #6b7280);
  white-space: nowrap;
}
.sui-uphill-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.75rem;
}
.sui-uphill-metric {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.75rem;
  border-radius: var(--sui-radius-md, 0.5rem);
  border: 1px solid var(--sui-border, rgba(127, 127, 127, 0.22));
  background: var(--sui-surface, transparent);
}
.sui-uphill-metric-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
.sui-uphill-metric-name {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8125rem;
  font-weight: 600;
}
.sui-uphill-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  flex-shrink: 0;
}
.sui-uphill-dot[data-band="good"] { background: var(--sui-success, #0c9c59); }
.sui-uphill-dot[data-band="warn"] { background: var(--sui-warning, #d97706); }
.sui-uphill-dot[data-band="poor"],
.sui-uphill-dot[data-band="failed"] { background: var(--sui-danger, #dc2626); }
.sui-uphill-dot[data-band="none"] { background: var(--sui-muted-fg, #71717a); }
.sui-uphill-bar {
  height: 4px;
  border-radius: 999px;
  background: var(--sui-border, rgba(127, 127, 127, 0.2));
  overflow: hidden;
}
.sui-uphill-bar-fill {
  height: 100%;
  border-radius: 999px;
}
.sui-uphill-bar-fill[data-band="good"] { background: var(--sui-success, #0c9c59); }
.sui-uphill-bar-fill[data-band="warn"] { background: var(--sui-warning, #d97706); }
.sui-uphill-bar-fill[data-band="poor"],
.sui-uphill-bar-fill[data-band="failed"] { background: var(--sui-danger, #dc2626); }
.sui-uphill-bar-fill[data-band="none"] { background: var(--sui-muted-fg, #71717a); }
.sui-uphill-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.75rem;
}
.sui-uphill-item {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  color: var(--sui-muted-fg, #6b7280);
}
.sui-uphill-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--sui-font-mono, ui-monospace, monospace);
}
.sui-uphill-item-note {
  font-size: 0.72rem;
  color: var(--sui-muted-fg, #6b7280);
  margin: 0.1rem 0 0 0;
}
.sui-uphill-sparkline {
  display: block;
  width: 100%;
  height: 56px;
}
@media (prefers-reduced-motion: reduce) {
  .sui-uphill-gauge-card { transition: none; }
}

.sui-uphill-provenance {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.625rem;
  padding: 0.625rem 0.875rem;
  border-radius: var(--sui-radius-md, 0.5rem);
  border: 1px solid var(--sui-border, rgba(127, 127, 127, 0.22));
  background: var(--sui-surface-subtle, rgba(127, 127, 127, 0.05));
}
.sui-uphill-provenance[data-trust="trusted_sandbox"],
.sui-uphill-provenance[data-trust="trusted_maintainer"] {
  border-color: color-mix(in srgb, var(--sui-success, #0c9c59) 35%, transparent);
}
.sui-uphill-provenance[data-trust="untrusted_contributor"] {
  border-color: color-mix(in srgb, var(--sui-warning, #d97706) 45%, transparent);
}
.sui-uphill-provenance-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.sui-uphill-provenance-detail {
  font-size: 0.75rem;
  color: var(--sui-muted-fg, #6b7280);
  font-variant-numeric: tabular-nums;
}
.sui-uphill-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 1.25rem;
  font-size: 0.75rem;
  color: var(--sui-muted-fg, #6b7280);
}
.sui-uphill-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-variant-numeric: tabular-nums;
}
`;

export function useUphillCss(): void {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[${UPHILL_CSS_ATTR}]`)) return;
    const el = document.createElement("style");
    el.setAttribute(UPHILL_CSS_ATTR, "");
    el.textContent = uphillCss;
    document.head.appendChild(el);
  }, []);
}
