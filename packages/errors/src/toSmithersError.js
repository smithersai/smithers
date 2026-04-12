import { SmithersError } from "./SmithersError.js";
import { EngineError } from "./EngineError.js";
import { fromTaggedError } from "./fromTaggedError.js";
import { isSmithersError } from "./isSmithersError.js";
/** @typedef {import("./ErrorWrapOptions.ts").ErrorWrapOptions} ErrorWrapOptions */

/**
 * @param {unknown} cause
 * @returns {string}
 */
function causeSummary(cause) {
    if (isSmithersErrorLike(cause)) {
        return typeof cause.summary === "string" ? cause.summary : cause.message;
    }
    if (cause instanceof EngineError) {
        return cause.message;
    }
    if (cause instanceof Error) {
        return cause.message;
    }
    return String(cause);
}
/**
 * @param {unknown} cause
 * @returns {cause is SmithersError}
 */
function isSmithersErrorLike(cause) {
    return cause instanceof SmithersError || isSmithersError(cause);
}
/**
 * @param {unknown} cause
 * @param {string} [label]
 * @param {ErrorWrapOptions} [options]
 * @returns {SmithersError}
 */
export function toSmithersError(cause, label, options = {}) {
    const taggedError = fromTaggedError(cause);
    const normalizedCause = taggedError ?? cause;
    const smithersCause = isSmithersErrorLike(normalizedCause);
    if (smithersCause &&
        !label &&
        !options.code &&
        !options.details) {
        return normalizedCause;
    }
    const code = options.code ??
        (smithersCause
            ? normalizedCause.code
            : normalizedCause instanceof EngineError
                ? normalizedCause.code
                : "INTERNAL_ERROR");
    const details = {
        ...(smithersCause ? normalizedCause.details : {}),
        ...(normalizedCause instanceof EngineError ? normalizedCause.context : {}),
        ...options.details,
    };
    if (label && details.operation === undefined) {
        details.operation = label;
    }
    const summary = label
        ? `${label}: ${causeSummary(normalizedCause)}`
        : causeSummary(normalizedCause);
    return new SmithersError(code, summary, Object.keys(details).length > 0 ? details : undefined, { cause: normalizedCause });
}
