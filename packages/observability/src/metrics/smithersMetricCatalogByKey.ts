import { smithersMetricCatalog } from "./smithersMetricCatalog";

export const smithersMetricCatalogByKey = new Map(
  smithersMetricCatalog.map((metric) => [metric.key, metric] as const),
);
