
/** @typedef {import("./_corePrometheusShape.ts").MetricLabels} MetricLabels */
/** @typedef {import("./_corePrometheusShape.ts").PrometheusSample} PrometheusSample */
export {};
/**
 * @param {string} name
 * @returns {string}
 */
export function toPrometheusMetricName(name) {
    const next = name.replace(/[^a-zA-Z0-9_:]/g, "_");
    return /^[a-zA-Z_:]/.test(next) ? next : `_${next}`;
}
/**
 * @param {string} text
 * @returns {string}
 */
function escapeText(text) {
    return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
/**
 * @param {string} value
 * @returns {string}
 */
function escapeLabelValue(value) {
    return escapeText(value).replace(/"/g, '\\"');
}
/**
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
    if (Number.isNaN(value))
        return "NaN";
    if (value === Number.POSITIVE_INFINITY)
        return "+Inf";
    if (value === Number.NEGATIVE_INFINITY)
        return "-Inf";
    return String(value);
}
/**
 * @param {MetricLabels} labels
 * @returns {string}
 */
function formatLabels(labels) {
    const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0)
        return "";
    return `{${entries
        .map(([key, value]) => `${toPrometheusMetricName(key)}="${escapeLabelValue(String(value))}"`)
        .join(",")}}`;
}
/**
 * @param {MetricLabels} labels
 * @param {MetricLabels} extra
 * @returns {MetricLabels}
 */
function mergeLabels(labels, extra) {
    return { ...labels, ...extra };
}
/**
 * @param {readonly PrometheusSample[]} samples
 * @returns {string}
 */
export function renderPrometheusSamples(samples) {
    const grouped = new Map();
    for (const sample of samples) {
        const name = toPrometheusMetricName(sample.name);
        const group = grouped.get(name) ??
            (() => {
                const created = { type: sample.type, lines: [] };
                grouped.set(name, created);
                return created;
            })();
        if (sample.type === "histogram") {
            const buckets = [...(sample.buckets ?? new Map()).entries()].sort(([left], [right]) => left - right);
            for (const [boundary, count] of buckets) {
                group.lines.push(`${name}_bucket${formatLabels(mergeLabels(sample.labels, { le: boundary }))} ${formatNumber(count)}`);
            }
            group.lines.push(`${name}_bucket${formatLabels(mergeLabels(sample.labels, { le: "+Inf" }))} ${formatNumber(sample.count ?? 0)}`);
            group.lines.push(`${name}_sum${formatLabels(sample.labels)} ${formatNumber(sample.sum ?? 0)}`);
            group.lines.push(`${name}_count${formatLabels(sample.labels)} ${formatNumber(sample.count ?? 0)}`);
        }
        else {
            group.lines.push(`${name}${formatLabels(sample.labels)} ${formatNumber(sample.value ?? 0)}`);
        }
    }
    const lines = [];
    for (const [name, group] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        lines.push(`# TYPE ${name} ${group.type}`);
        lines.push(...group.lines.sort());
    }
    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}
