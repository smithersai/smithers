/**
 * @param {string | null | undefined} metaJson
 * @returns {{ correlationKey: string } | null}
 */
export function parseEventMeta(metaJson) {
    if (!metaJson) return null;
    try {
        const parsed = JSON.parse(metaJson);
        const key =
            parsed?.event?.correlationKey ??
            parsed?.correlationKey ??
            parsed?.event?.eventName ??
            null;
        return typeof key === "string" ? { correlationKey: key } : null;
    } catch {
        return null;
    }
}
