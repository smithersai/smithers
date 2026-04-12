import { SmithersError } from "./SmithersError.js";
import { fromTaggedError } from "./fromTaggedError.js";
/**
 * @param {unknown} error
 * @returns {Record<string, unknown>}
 */
export function errorToJson(error) {
    const taggedError = fromTaggedError(error);
    if (taggedError) {
        return errorToJson(taggedError);
    }
    if (error instanceof SmithersError) {
        return {
            name: error.name,
            code: error.code,
            message: error.message,
            stack: error.stack,
            cause: error.cause,
            summary: error.summary,
            docsUrl: error.docsUrl,
            details: error.details,
        };
    }
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }
    if (error && typeof error === "object") {
        return error;
    }
    return { message: String(error) };
}
