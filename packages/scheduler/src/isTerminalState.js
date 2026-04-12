
/** @typedef {import("@smithers/graph").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./TaskState.ts").TaskState} TaskState */
/**
 * @param {TaskState} state
 * @param {Pick<TaskDescriptor, "continueOnFail">} [descriptor]
 * @returns {boolean}
 */
export function isTerminalState(state, descriptor) {
    if (state === "finished" || state === "skipped")
        return true;
    if (state === "failed")
        return Boolean(descriptor?.continueOnFail);
    return false;
}
