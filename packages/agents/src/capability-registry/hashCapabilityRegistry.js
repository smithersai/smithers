import { createHash } from "node:crypto";
import { normalizeCapabilityRegistry } from "./normalizeCapabilityRegistry.js";
/** @typedef {import("./AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */

/**
 * @param {unknown} value
 * @returns {StableJson}
 */
function toStableJson(value) {
    if (value === null ||
        typeof value === "boolean" ||
        typeof value === "number" ||
        typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => toStableJson(entry));
    }
    if (!value || typeof value !== "object") {
        return String(value);
    }
    return Object.fromEntries(Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, toStableJson(entry)]));
}
/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
    return JSON.stringify(toStableJson(value));
}
/**
 * @param {AgentCapabilityRegistry | null | undefined} registry
 * @returns {string}
 */
export function hashCapabilityRegistry(registry) {
    const input = stableStringify({
        capabilityRegistry: normalizeCapabilityRegistry(registry),
    });
    return createHash("sha256").update(input).digest("hex");
}
