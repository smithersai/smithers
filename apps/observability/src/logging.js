import { Effect } from "effect";
import { getCurrentSmithersTraceAnnotations } from "./getCurrentSmithersTraceAnnotations.js";
import { correlationContextToLogAnnotations, getCurrentCorrelationContext, withCurrentCorrelationContext, } from "./correlation.js";
/**
 * @typedef {Record<string, unknown> | undefined} LogAnnotations
 */

/** @type {number} */
const LOG_LEVEL_NONE = 0;
const LOG_LEVEL_DEBUG = 1;
const LOG_LEVEL_INFO = 2;
const LOG_LEVEL_WARNING = 3;
const LOG_LEVEL_ERROR = 4;

/** @returns {number} */
function resolveMinLevel() {
    const env = process.env.SMITHERS_LOG_LEVEL?.toLowerCase();
    switch (env) {
        case "none": return Infinity;
        case "trace":
        case "debug": return LOG_LEVEL_DEBUG;
        case "warning":
        case "warn": return LOG_LEVEL_WARNING;
        case "error": return LOG_LEVEL_ERROR;
        case "fatal": return Infinity;
        case "all": return LOG_LEVEL_NONE;
        case "info": return LOG_LEVEL_INFO;
        default: return LOG_LEVEL_WARNING;
    }
}

const minLevel = resolveMinLevel();

/**
 * @param {Effect.Effect<void, never, never>} effect
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 * @param {number} [level]
 */
function emitLog(effect, annotations, span, level = LOG_LEVEL_INFO) {
    if (level < minLevel) return;
    const correlationAnnotations = correlationContextToLogAnnotations(getCurrentCorrelationContext());
    const traceAnnotations = getCurrentSmithersTraceAnnotations();
    const mergedAnnotations = correlationAnnotations || traceAnnotations || annotations
        ? {
            ...correlationAnnotations,
            ...traceAnnotations,
            ...annotations,
        }
        : undefined;
    let program = effect;
    if (mergedAnnotations) {
        program = program.pipe(Effect.annotateLogs(mergedAnnotations));
    }
    if (span) {
        program = program.pipe(Effect.withLogSpan(span));
    }
    void Effect.runFork(withCurrentCorrelationContext(program));
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logDebug(message, annotations, span) {
    emitLog(Effect.logDebug(message), annotations, span, LOG_LEVEL_DEBUG);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logInfo(message, annotations, span) {
    emitLog(Effect.logInfo(message), annotations, span, LOG_LEVEL_INFO);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logWarning(message, annotations, span) {
    emitLog(Effect.logWarning(message), annotations, span, LOG_LEVEL_WARNING);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logError(message, annotations, span) {
    emitLog(Effect.logError(message), annotations, span, LOG_LEVEL_ERROR);
}
