
/** @typedef {import("./AgentCliActionKind.ts").AgentCliActionKind} AgentCliActionKind */
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}
/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function asString(value) {
    return typeof value === "string" ? value : undefined;
}
/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/**
 * @param {string} value
 * @returns {string}
 */
export function truncate(value, maxLength = 240) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 1)}…`;
}
const TOOL_KIND_KEYWORDS = [
    [["bash", "shell", "command"], "command"],
    [["search", "web"], "web_search"],
    [["todo", "plan"], "todo_list"],
    [["write", "edit", "file"], "file_change"],
];
/**
 * @param {string | undefined} name
 * @param {ReadonlyArray<readonly [string[], AgentCliActionKind]>} [extraRules]
 * @returns {AgentCliActionKind}
 */
export function toolKindFromName(name, extraRules) {
    const normalized = (name ?? "").toLowerCase();
    if (!normalized)
        return "tool";
    const rules = extraRules
        ? [...TOOL_KIND_KEYWORDS, ...extraRules]
        : TOOL_KIND_KEYWORDS;
    for (const [keywords, kind] of rules) {
        for (const keyword of keywords) {
            if (normalized.includes(keyword)) {
                return kind;
            }
        }
    }
    return "tool";
}
const RUNTIME_METADATA_MARKERS = [
    "\"mcp_servers\"",
    "\"slash_commands\"",
    "\"permissionmode\"",
    "\"claude_code_version\"",
    "\"apikeysource\"",
    "\"plugins\"",
    "\"skills\"",
];
/**
 * @param {string} value
 * @returns {boolean}
 */
export function isLikelyRuntimeMetadata(value) {
    const lower = value.toLowerCase();
    let matchCount = 0;
    for (const marker of RUNTIME_METADATA_MARKERS) {
        if (lower.includes(marker)) {
            matchCount += 1;
        }
    }
    return matchCount >= 3;
}
/**
 * @param {string} line
 * @returns {boolean}
 */
export function shouldSurfaceUnparsedStdout(line) {
    if (isLikelyRuntimeMetadata(line)) {
        return false;
    }
    if (line.length > 220) {
        return false;
    }
    const lower = line.toLowerCase();
    return (lower.includes("error") ||
        lower.includes("failed") ||
        lower.includes("denied") ||
        lower.includes("exception") ||
        lower.includes("timeout"));
}
/**
 * @returns {(prefix: string) => string}
 */
export function createSyntheticIdGenerator() {
    let counter = 0;
    return (prefix) => {
        counter += 1;
        return `${prefix}-${counter}`;
    };
}
