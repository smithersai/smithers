
/** @typedef {import("./ReadonlyTaskStateMap.ts").ReadonlyTaskStateMap} ReadonlyTaskStateMap */
/** @typedef {import("./TaskStateMap.ts").TaskStateMap} TaskStateMap */
/**
 * @param {ReadonlyTaskStateMap} states
 * @returns {TaskStateMap}
 */
export function cloneTaskStateMap(states) {
    return new Map(states);
}
