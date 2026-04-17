import { LogLevel } from "effect";
/** @typedef {import("./SmithersLogFormat.ts").SmithersLogFormat} SmithersLogFormat */

/** @typedef {import("./ResolvedSmithersObservabilityOptions.ts").ResolvedSmithersObservabilityOptions} ResolvedSmithersObservabilityOptions */
/** @typedef {import("./SmithersObservabilityOptions.ts").SmithersObservabilityOptions} SmithersObservabilityOptions */

/**
 * @param {LogLevel.LogLevel | string | undefined} value
 * @returns {LogLevel.LogLevel}
 */
function resolveLogLevel(value) {
    if (typeof value !== "string") {
        return value ?? LogLevel.Info;
    }
    switch (value.toLowerCase()) {
        case "none":
            return LogLevel.None;
        case "trace":
            return LogLevel.Trace;
        case "debug":
            return LogLevel.Debug;
        case "warning":
        case "warn":
            return LogLevel.Warning;
        case "error":
            return LogLevel.Error;
        case "fatal":
            return LogLevel.Fatal;
        case "all":
            return LogLevel.All;
        case "info":
        default:
            return LogLevel.Info;
    }
}
/**
 * @param {string | undefined} value
 * @returns {SmithersLogFormat}
 */
function resolveLogFormat(value) {
    switch ((value ?? "").toLowerCase()) {
        case "json":
            return "json";
        case "pretty":
            return "pretty";
        case "string":
            return "string";
        case "logfmt":
        default:
            return "logfmt";
    }
}
/**
 * @param {boolean | undefined} value
 * @returns {boolean}
 */
function resolveEnabled(value) {
    if (typeof value === "boolean")
        return value;
    const env = (process.env.SMITHERS_OTEL_ENABLED ?? "").toLowerCase();
    return env === "1" || env === "true";
}
/**
 * @param {SmithersObservabilityOptions} [options]
 * @returns {ResolvedSmithersObservabilityOptions}
 */
export function resolveSmithersObservabilityOptions(options = {}) {
    return {
        enabled: resolveEnabled(options.enabled),
        endpoint: options.endpoint ??
            process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
            "http://localhost:4318",
        serviceName: options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "smithers",
        logFormat: options.logFormat
            ? resolveLogFormat(options.logFormat)
            : resolveLogFormat(process.env.SMITHERS_LOG_FORMAT),
        logLevel: resolveLogLevel(options.logLevel ?? process.env.SMITHERS_LOG_LEVEL),
    };
}
