import { Metric } from "effect";
export declare const openApiToolCallsTotal: Metric.Metric.Counter<number>;
export declare const openApiToolCallErrorsTotal: Metric.Metric.Counter<number>;
export declare const openApiToolDuration: Metric.Metric<import("effect/MetricKeyType").MetricKeyType.Histogram, number, import("effect/MetricState").MetricState.Histogram>;
