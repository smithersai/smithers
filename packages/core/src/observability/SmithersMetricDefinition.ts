import type { MetricLabels } from "./prometheus.ts";
import type { SmithersMetricType } from "./SmithersMetricType.ts";
import type { SmithersMetricUnit } from "./SmithersMetricUnit.ts";

export type SmithersMetricDefinition = {
  readonly key: string;
  readonly name: string;
  readonly prometheusName: string;
  readonly type: SmithersMetricType;
  readonly label: string;
  readonly unit?: SmithersMetricUnit;
  readonly labels?: readonly string[];
  readonly defaultLabels?: readonly MetricLabels[];
  readonly boundaries?: readonly number[];
};
