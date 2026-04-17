import {} from "../_coreMetrics.js";
import { renderPrometheusSamples, } from "../_corePrometheus.js";
import { Effect, Metric, MetricState } from "effect";
import { toPrometheusMetricName } from "./toPrometheusMetricName.js";
import { durationBuckets } from "./_buckets.js";
import { smithersMetricCatalogByName } from "./smithersMetricCatalogByName.js";
import { smithersMetricCatalogByPrometheusName } from "./smithersMetricCatalogByPrometheusName.js";
import { trackEvent } from "./trackEvent.js";
import { updateProcessMetrics } from "./updateProcessMetrics.js";
import { updateAsyncExternalWaitPending } from "./updateAsyncExternalWaitPending.js";
/** @typedef {import("./SmithersMetricDefinition.ts").SmithersMetricDefinition} SmithersMetricDefinition */
/** @typedef {import("../_coreMetricsShape.ts").MetricsServiceShape} MetricsServiceShape */
/** @typedef {import("../_corePrometheusShape.ts").MetricLabels} MetricLabels */
/** @typedef {import("../_corePrometheusShape.ts").PrometheusSample} PrometheusSample */
/** @typedef {import("../_coreMetricsShape.ts").MetricsSnapshot} MetricsSnapshot */

/**
 * @param {string} name
 * @returns {SmithersMetricDefinition | undefined}
 */
function resolveMetricDefinition(name) {
    return (smithersMetricCatalogByName.get(name) ??
        smithersMetricCatalogByPrometheusName.get(toPrometheusMetricName(name)));
}
/**
 * @template A
 * @param {A} metric
 * @param {MetricLabels} [labels]
 * @returns {A}
 */
function tagMetricWithLabels(metric, labels) {
    let tagged = metric;
    for (const [key, value] of Object.entries(labels ?? {})) {
        tagged = Metric.tagged(tagged, key, String(value));
    }
    return tagged;
}
/**
 * @param {string} name
 * @param {MetricLabels} [labels]
 * @returns {Metric.Metric<any, number, any>}
 */
function counterOrGaugeMetric(name, labels) {
    const definition = resolveMetricDefinition(name);
    const metric = definition?.type === "counter" || definition?.type === "gauge"
        ? definition.metric
        : Metric.counter(name);
    return tagMetricWithLabels(metric, labels);
}
/**
 * @param {string} name
 * @param {MetricLabels} [labels]
 * @returns {Metric.Metric<any, number, any>}
 */
function gaugeMetric(name, labels) {
    const definition = resolveMetricDefinition(name);
    const metric = definition?.type === "gauge" ? definition.metric : Metric.gauge(name);
    return tagMetricWithLabels(metric, labels);
}
/**
 * @param {string} name
 * @param {MetricLabels} [labels]
 * @returns {Metric.Metric<any, number, any>}
 */
function histogramMetric(name, labels) {
    const definition = resolveMetricDefinition(name);
    const metric = definition?.type === "histogram"
        ? definition.metric
        : Metric.histogram(name, durationBuckets);
    return tagMetricWithLabels(metric, labels);
}
/**
 * @param {number | bigint | undefined} value
 * @returns {number}
 */
function metricValueAsNumber(value) {
    if (typeof value === "bigint")
        return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/**
 * @param {any} metricKey
 * @returns {MetricLabels}
 */
function metricsServiceLabels(metricKey) {
    const tags = Array.isArray(metricKey?.tags) ? metricKey.tags : [];
    return Object.freeze(Object.fromEntries(tags
        .map((tag) => [String(tag.key), String(tag.value)])
        .sort(([left], [right]) => left.localeCompare(right))));
}
/**
 * @param {MetricLabels} labels
 * @returns {string}
 */
function metricsServiceLabelsKey(labels) {
    return JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}
/**
 * @param {string} name
 * @param {MetricLabels} labels
 * @returns {string}
 */
function metricsServiceSnapshotKey(name, labels) {
    return `${name}|${metricsServiceLabelsKey(labels)}`;
}
/**
 * @returns {PrometheusSample[]}
 */
function metricsServicePrometheusSamples() {
    const samples = [];
    for (const snapshot of Metric.unsafeSnapshot()) {
        const metricKey = snapshot.metricKey;
        const metricState = snapshot.metricState;
        const name = String(metricKey.name ?? "");
        if (!name)
            continue;
        const labels = metricsServiceLabels(metricKey);
        if (MetricState.isCounterState(metricState)) {
            samples.push({
                name,
                type: "counter",
                labels,
                value: metricValueAsNumber(metricState.count),
            });
            continue;
        }
        if (MetricState.isGaugeState(metricState)) {
            samples.push({
                name,
                type: "gauge",
                labels,
                value: metricValueAsNumber(metricState.value),
            });
            continue;
        }
        if (MetricState.isHistogramState(metricState)) {
            samples.push({
                name,
                type: "histogram",
                labels,
                buckets: new Map([...metricState.buckets].map(([boundary, count]) => [
                    boundary,
                    metricValueAsNumber(count),
                ])),
                sum: metricValueAsNumber(metricState.sum),
                count: metricValueAsNumber(metricState.count),
            });
        }
    }
    return samples;
}
/**
 * @returns {MetricsSnapshot}
 */
function metricsServiceSnapshot() {
    const result = new Map();
    for (const sample of metricsServicePrometheusSamples()) {
        const key = metricsServiceSnapshotKey(sample.name, sample.labels);
        if (sample.type === "histogram") {
            result.set(key, {
                type: "histogram",
                sum: sample.sum ?? 0,
                count: sample.count ?? 0,
                labels: sample.labels,
                buckets: new Map(sample.buckets ?? []),
            });
            continue;
        }
        result.set(key, {
            type: sample.type,
            value: sample.value ?? 0,
            labels: sample.labels,
        });
    }
    return result;
}
/** @type {MetricsServiceShape} */
export const metricsServiceAdapter = {
    increment: (name, labels) => Metric.incrementBy(counterOrGaugeMetric(name, labels), 1),
    incrementBy: (name, value, labels) => Metric.incrementBy(counterOrGaugeMetric(name, labels), value),
    gauge: (name, value, labels) => Metric.set(gaugeMetric(name, labels), value),
    histogram: (name, value, labels) => Metric.update(histogramMetric(name, labels), value),
    recordEvent: (event) => trackEvent(event),
    updateProcessMetrics: () => updateProcessMetrics(),
    updateAsyncExternalWaitPending: (kind, delta) => updateAsyncExternalWaitPending(kind, delta),
    renderPrometheus: () => Effect.sync(() => renderPrometheusSamples(metricsServicePrometheusSamples())),
    snapshot: () => Effect.sync(metricsServiceSnapshot),
};
