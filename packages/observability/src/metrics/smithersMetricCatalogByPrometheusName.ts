import { smithersMetricCatalog } from "./smithersMetricCatalog";

export const smithersMetricCatalogByPrometheusName = new Map(
  smithersMetricCatalog.map((metric) => [metric.prometheusName, metric] as const),
);
