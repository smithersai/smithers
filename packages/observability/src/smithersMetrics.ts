import { smithersMetricCatalog } from "./metrics";

export const smithersMetrics = Object.fromEntries(
  smithersMetricCatalog.map((metric) => [metric.key, metric.metric] as const),
);
