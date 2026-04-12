
/** @typedef {import("./CodexConfigOverrides.ts").CodexConfigOverrides} CodexConfigOverrides */
/**
 * @param {CodexConfigOverrides} [config]
 * @returns {string[]}
 */
export function normalizeCodexConfig(config) {
    if (!config)
        return [];
    if (Array.isArray(config))
        return config.map(String);
    const entries = Object.entries(config);
    return entries.map(([key, value]) => {
        if (value === null)
            return `${key}=null`;
        if (typeof value === "string")
            return `${key}=${value}`;
        if (typeof value === "number" || typeof value === "boolean")
            return `${key}=${value}`;
        return `${key}=${JSON.stringify(value)}`;
    });
}
