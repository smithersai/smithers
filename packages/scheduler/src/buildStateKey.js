/**
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
export function buildStateKey(nodeId, iteration) {
    return `${nodeId}::${iteration}`;
}
