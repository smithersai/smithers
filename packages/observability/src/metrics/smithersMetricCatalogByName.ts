import { smithersMetricCatalog } from "./smithersMetricCatalog";

export const smithersMetricCatalogByName = new Map(
  smithersMetricCatalog.map((metric) => [metric.name, metric] as const),
);
