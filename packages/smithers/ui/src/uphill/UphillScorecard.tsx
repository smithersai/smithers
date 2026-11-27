/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { Badge } from "../badge";
import { Button } from "../button";
import { EmptyState } from "../empty-state";
import { useInjectUiCss } from "../styles";
import { UphillGauge, uphillScoreBand } from "./UphillGauge";
import { useUphillCss } from "./uphillCss";

export interface UphillItemData {
  readonly name: string;
  readonly value: number | boolean | null;
  readonly target?: number | null | undefined;
  readonly note?: string | null | undefined;
}

export interface UphillMetricData {
  readonly name: string;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly kind: "size" | "time" | "count" | "check";
  readonly unit?: string | null | undefined;
  readonly value: number | null;
  readonly score: number | null;
  readonly target?: number | null | undefined;
  readonly note?: string | null | undefined;
  readonly items?: ReadonlyArray<UphillItemData> | undefined;
}

export interface UphillCategoryData {
  readonly name: string;
  readonly title: string;
  readonly score: number | null;
  readonly rounds?: number | undefined;
  readonly metrics: ReadonlyArray<UphillMetricData>;
  readonly error?: { readonly message: string; readonly details?: string | null | undefined } | null | undefined;
}

export interface UphillOpportunityData {
  readonly category: string;
  readonly metric: string;
  readonly item?: string | null | undefined;
  readonly items?: number | undefined;
  readonly value?: number | boolean | null | undefined;
  readonly target?: number | boolean | null | undefined;
  readonly gain: number;
}

export interface UphillChangeData {
  readonly category: string;
  readonly metric: string;
  readonly item?: string | null | undefined;
  readonly change: string;
  readonly before?: number | boolean | null | undefined;
  readonly after?: number | boolean | null | undefined;
}

export interface UphillComparisonScoreData {
  readonly category: string;
  readonly score: number | null;
}

export interface UphillReportData {
  readonly categories: ReadonlyArray<UphillCategoryData>;
  readonly opportunities?: ReadonlyArray<UphillOpportunityData> | undefined;
  readonly changes?: ReadonlyArray<UphillChangeData> | null | undefined;
  readonly comparison?: {
    readonly reference: string;
    readonly scores?: ReadonlyArray<UphillComparisonScoreData> | undefined;
  } | null | undefined;
}

export interface UphillHistoryPointData {
  readonly commit: string;
  readonly overall: number | null;
  readonly timestamp?: string | null | undefined;
}

export type UphillScorecardProps = Omit<ComponentProps<"section">, "children"> & {
  /** Decoded Uphill report data. */
  report: UphillReportData;
  /** Optional commit SHA for the report header. */
  commit?: string | null | undefined;
  /** Optional branch name for the report header. */
  branch?: string | null | undefined;
  /** Optional historical overall scores for trend sparkline. */
  history?: ReadonlyArray<UphillHistoryPointData> | undefined;
  /** Currently selected category name (`null` shows all categories). */
  selectedCategory?: string | null | undefined;
  /** Invoked when a category gauge card is toggled. */
  onSelectCategory?: ((category: string | null) => void) | undefined;
  /** Optional action invoked for an opportunity (e.g. "Climb" / open TODO). */
  onOpportunityAction?: ((opportunity: UphillOpportunityData) => void) | undefined;
  /** Label for the opportunity action button. */
  opportunityActionLabel?: string | undefined;
};

function trimFixed(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

function formatCompactValue(value: number | boolean | null | undefined, kind?: string, unit?: string | null): string {
  if (value === null || value === undefined) return "–";
  if (typeof value === "boolean") return value ? "pass" : "fail";
  if (!Number.isFinite(value)) return "–";
  if (kind === "size" || unit === "B") {
    const abs = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    if (abs < 1_000) return `${sign}${Math.round(abs)} B`;
    if (abs < 1_000_000) return `${sign}${trimFixed(abs / 1_000, 1)} kB`;
    if (abs < 1_000_000_000) return `${sign}${trimFixed(abs / 1_000_000, 2)} MB`;
    return `${sign}${trimFixed(abs / 1_000_000_000, 2)} GB`;
  }
  if (kind === "time" || unit === "ns") {
    const abs = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    if (abs < 1_000) return `${sign}${Math.round(abs)} ns`;
    if (abs < 1_000_000) return `${sign}${trimFixed(abs / 1_000, 1)} µs`;
    if (abs < 1_000_000_000) return `${sign}${trimFixed(abs / 1_000_000, 2)} ms`;
    return `${sign}${trimFixed(abs / 1_000_000_000, 2)} s`;
  }
  if (kind === "check") return `${Math.round(value * 100)}%`;
  const formatted = Number.isInteger(value) ? value.toLocaleString("en-US") : trimFixed(value, 2);
  return unit ? `${formatted} ${unit}` : formatted;
}

function metricUnitLookup(report: UphillReportData, categoryName: string, metricName: string): { kind?: string; unit?: string | null } {
  const category = report.categories.find((c) => c.name === categoryName);
  const metric = category?.metrics.find((m) => m.name === metricName);
  return metric ? { kind: metric.kind, unit: metric.unit } : {};
}

function changeBadgeVariant(change: string): "success" | "destructive" | "warning" | "muted" {
  if (change === "better" || change === "tighter") return "success";
  if (change === "worse" || change === "looser") return "destructive";
  if (change === "new" || change === "gone") return "warning";
  return "muted";
}

function TrendSparkline({ points }: { readonly points: ReadonlyArray<UphillHistoryPointData> }) {
  const valid = points.filter((p): p is UphillHistoryPointData & { readonly overall: number } => typeof p.overall === "number");
  if (valid.length < 2) return null;
  const width = 320;
  const height = 56;
  const pad = 6;
  const stepX = (width - pad * 2) / (valid.length - 1);
  const coords = valid.map((p, index) => {
    const x = pad + index * stepX;
    const clamped = Math.max(0, Math.min(100, p.overall));
    const y = height - pad - (clamped / 100) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const latest = valid[valid.length - 1]!;
  return (
    <section className="sui-uphill-section" aria-label="Score trend">
      <div className="sui-uphill-section-head">
        <h3 className="sui-uphill-section-title">Trend ({valid.length} runs)</h3>
        <Badge variant="muted">{latest.overall}/100</Badge>
      </div>
      <svg className="sui-uphill-sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Overall score trend ending at ${latest.overall}`}>
        <polyline
          fill="none"
          stroke="var(--sui-success, #0c9c59)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={coords.join(" ")}
        />
      </svg>
    </section>
  );
}

/** Lighthouse-style continuous metrics scorecard for Uphill reports. */
export function UphillScorecard({
  report,
  commit,
  branch,
  history,
  selectedCategory = null,
  onSelectCategory,
  onOpportunityAction,
  opportunityActionLabel = "Climb",
  className,
  ...props
}: UphillScorecardProps) {
  useInjectUiCss();
  useUphillCss();

  if (report.categories.length === 0) {
    return <EmptyState title="No Uphill categories scored" />;
  }

  const scored = report.categories
    .map((c) => c.score)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  const overall = scored.length > 0 ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
  const compareByCat = new Map(
    (report.comparison?.scores ?? []).map((entry) => [entry.category, entry.score] as const),
  );
  const visibleCategories = selectedCategory
    ? report.categories.filter((c) => c.name === selectedCategory)
    : report.categories;
  const opportunities = (report.opportunities ?? [])
    .filter((o) => !selectedCategory || o.category === selectedCategory)
    .slice(0, 10);
  const changes = (report.changes ?? []).filter((c) => !selectedCategory || c.category === selectedCategory).slice(0, 12);

  return (
    <section data-slot="uphill-scorecard" className={cn("sui-uphill", className)} aria-label="Uphill scorecard" {...props}>
      <header className="sui-uphill-header">
        <div className="sui-uphill-meta">
          {overall !== null ? <Badge variant={overall >= 90 ? "success" : overall >= 50 ? "warning" : "destructive"}>Overall {overall}</Badge> : null}
          {branch ? <Badge variant="muted">{branch}</Badge> : null}
          {commit ? <Badge variant="muted">{commit.slice(0, 8)}</Badge> : null}
          {report.comparison?.reference ? <Badge variant="secondary">vs {report.comparison.reference}</Badge> : null}
        </div>
        {selectedCategory && onSelectCategory ? (
          <Button variant="ghost" size="sm" onClick={() => onSelectCategory(null)}>
            All categories
          </Button>
        ) : null}
      </header>

      <div className="sui-uphill-gauges" role="group" aria-label="Category scores">
        {report.categories.map((category) => {
          const failed = category.error != null;
          const prev = compareByCat.get(category.name);
          const delta = typeof category.score === "number" && typeof prev === "number" ? Math.round(category.score - prev) : null;
          const selected = selectedCategory === category.name;
          return (
            <button
              key={category.name}
              type="button"
              className="sui-uphill-gauge-card"
              aria-pressed={selected}
              onClick={() => onSelectCategory?.(selected ? null : category.name)}
            >
              <UphillGauge score={category.score} label={category.title} failed={failed} size="md" />
              <span className="sui-uphill-gauge-title">{category.title}</span>
              {delta !== null && delta !== 0 ? (
                <span className="sui-uphill-gauge-delta" data-dir={delta > 0 ? "up" : "down"}>
                  {delta > 0 ? `+${delta}` : String(delta)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {opportunities.length > 0 ? (
        <section className="sui-uphill-section" aria-label="Opportunities">
          <div className="sui-uphill-section-head">
            <h3 className="sui-uphill-section-title">Opportunities</h3>
            <Badge variant="muted">{opportunities.length}</Badge>
          </div>
          <div className="sui-uphill-list">
            {opportunities.map((opp, idx) => {
              const fmt = metricUnitLookup(report, opp.category, opp.metric);
              const label = opp.item ? `${opp.metric} · ${opp.item}` : opp.metric;
              return (
                <div key={`${opp.category}-${opp.metric}-${opp.item ?? idx}`} className="sui-uphill-row">
                  <span className="sui-uphill-gain">+{Math.round(opp.gain)}</span>
                  <span>
                    <strong>{opp.category}</strong> {label}
                  </span>
                  <span className="sui-uphill-target">
                    {formatCompactValue(opp.value, fmt.kind, fmt.unit)} → {formatCompactValue(opp.target, fmt.kind, fmt.unit)}
                  </span>
                  {onOpportunityAction ? (
                    <Button size="sm" variant="outline" onClick={() => onOpportunityAction(opp)}>
                      {opportunityActionLabel}
                    </Button>
                  ) : <span />}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {changes.length > 0 ? (
        <section className="sui-uphill-section" aria-label="Changes since baseline">
          <div className="sui-uphill-section-head">
            <h3 className="sui-uphill-section-title">Changes</h3>
            <Badge variant="muted">{changes.length}</Badge>
          </div>
          <div className="sui-uphill-list">
            {changes.map((chg, idx) => {
              const fmt = metricUnitLookup(report, chg.category, chg.metric);
              return (
                <div key={`${chg.category}-${chg.metric}-${chg.item ?? idx}`} className="sui-uphill-row">
                  <Badge variant={changeBadgeVariant(chg.change)}>{chg.change}</Badge>
                  <span>
                    <strong>{chg.category}</strong> {chg.item ? `${chg.metric} · ${chg.item}` : chg.metric}
                  </span>
                  <span className="sui-uphill-target">
                    {formatCompactValue(chg.before, fmt.kind, fmt.unit)} → {formatCompactValue(chg.after, fmt.kind, fmt.unit)}
                  </span>
                  <span />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {history && history.length >= 2 ? <TrendSparkline points={history} /> : null}

      {visibleCategories.map((category) => (
        <section key={category.name} className="sui-uphill-section" aria-label={category.title}>
          <div className="sui-uphill-section-head">
            <h3 className="sui-uphill-section-title">{category.title}</h3>
            {category.error ? (
              <Badge variant="destructive">{category.error.message}</Badge>
            ) : (
              <Badge variant="muted">{category.metrics.length} metrics</Badge>
            )}
          </div>
          <div className="sui-uphill-metrics">
            {category.metrics.map((metric) => {
              const band = uphillScoreBand(metric.score);
              const pct = typeof metric.score === "number" ? Math.max(0, Math.min(100, Math.round(metric.score))) : 0;
              const topItems = (metric.items ?? []).slice(0, 5);
              return (
                <article key={metric.name} className="sui-uphill-metric">
                  <div className="sui-uphill-metric-top">
                    <span className="sui-uphill-metric-name">
                      <span className="sui-uphill-dot" data-band={band} aria-hidden="true" />
                      {metric.title}
                    </span>
                    <span className="sui-uphill-target">
                      {formatCompactValue(metric.value, metric.kind, metric.unit)}
                      {metric.target != null ? ` / ${formatCompactValue(metric.target, metric.kind, metric.unit)}` : ""}
                    </span>
                  </div>
                  <div className="sui-uphill-bar" aria-hidden="true">
                    <div className="sui-uphill-bar-fill" data-band={band} style={{ width: `${pct}%` }} />
                  </div>
                  {topItems.length > 0 ? (
                    <ul className="sui-uphill-items">
                      {topItems.map((item) => (
                        <li key={item.name}>
                          <div className="sui-uphill-item">
                            <span className="sui-uphill-item-name" title={item.name}>{item.name}</span>
                            <span>{formatCompactValue(item.value, metric.kind, metric.unit)}</span>
                          </div>
                          {item.note ? <p className="sui-uphill-item-note">{item.note}</p> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </section>
  );
}
