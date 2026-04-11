import type { Metric } from "effect";
import type { SmithersMetricType } from "./SmithersMetricType";
import type { SmithersMetricUnit } from "./SmithersMetricUnit";

export type SmithersMetricDefinition = {
  readonly key: string;
  readonly metric: Metric.Metric<any, any, any>;
  readonly name: string;
  readonly prometheusName: string;
  readonly type: SmithersMetricType;
  readonly label: string;
  readonly unit?: SmithersMetricUnit;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly boundaries?: readonly number[];
  readonly defaultLabels?: readonly Readonly<Record<string, string>>[];
};
