/**
 * @param {string} key
 * @returns {{ readonly nodeId: string; readonly iteration: number; }}
 */
export function parseStateKey(key) {
    const separator = key.lastIndexOf("::");
    if (separator < 0) {
        return { nodeId: key, iteration: 0 };
    }
    const iteration = Number(key.slice(separator + 2));
    return {
        nodeId: key.slice(0, separator),
        iteration: Number.isFinite(iteration) ? iteration : 0,
    };
}
