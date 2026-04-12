/**
 * @param {string | null | undefined} runtimeOwnerId
 * @returns {number | null}
 */
export function parseRuntimeOwnerPid(runtimeOwnerId) {
    if (!runtimeOwnerId)
        return null;
    const trimmed = runtimeOwnerId.trim();
    if (trimmed.length === 0)
        return null;
    const exact = trimmed.match(/^pid:(\d+)(?::.*)?$/i);
    if (exact) {
        const pid = Number(exact[1]);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    if (/^\d+$/.test(trimmed)) {
        const pid = Number(trimmed);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    return null;
}
/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error?.code === "EPERM";
    }
}
