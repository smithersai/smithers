import { TaskAborted } from "@smithers/errors/TaskAborted";
/**
 * @returns {TaskAborted}
 */
export function makeAbortError(message = "Task aborted") {
    return new TaskAborted({
        message,
        name: "AbortError",
    });
}
/**
 * @param {AbortController} controller
 * @param {AbortSignal} [signal]
 */
export function wireAbortSignal(controller, signal) {
    if (!signal) {
        return () => { };
    }
    const forwardAbort = () => {
        controller.abort(signal.reason ?? makeAbortError());
    };
    if (signal.aborted) {
        forwardAbort();
        return () => { };
    }
    signal.addEventListener("abort", forwardAbort, { once: true });
    return () => signal.removeEventListener("abort", forwardAbort);
}
/**
 * @param {string | null} [metaJson]
 * @returns {Record<string, unknown>}
 */
export function parseAttemptMetaJson(metaJson) {
    if (!metaJson)
        return {};
    try {
        const parsed = JSON.parse(metaJson);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
