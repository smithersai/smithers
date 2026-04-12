import { Metric } from "effect";
export declare const scorersStarted: Metric.Metric.Counter<number>;
export declare const scorersFinished: Metric.Metric.Counter<number>;
export declare const scorersFailed: Metric.Metric.Counter<number>;
export declare const scorerDuration: Metric.Metric<import("effect/MetricKeyType").MetricKeyType.Histogram, number, import("effect/MetricState").MetricState.Histogram>;
