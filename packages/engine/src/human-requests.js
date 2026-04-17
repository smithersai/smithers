// @smithers-type-exports-begin
/** @typedef {import("./HumanRequestKind.ts").HumanRequestKind} HumanRequestKind */
/** @typedef {import("./HumanRequestStatus.ts").HumanRequestStatus} HumanRequestStatus */
// @smithers-type-exports-end

import { jsonSchemaToZod } from "./external/json-schema-to-zod.js";
/**
 * @typedef {{ ok: true; } | { ok: false; code: "HUMAN_REQUEST_SCHEMA_INVALID" | "HUMAN_REQUEST_VALIDATION_FAILED"; message: string; }} HumanRequestSchemaValidation
 */

/** @type {readonly ["ask", "confirm", "select", "json"]} */
export const HUMAN_REQUEST_KINDS = ["ask", "confirm", "select", "json"];
/** @type {readonly ["pending", "answered", "cancelled", "expired"]} */
export const HUMAN_REQUEST_STATUSES = [
    "pending",
    "answered",
    "cancelled",
    "expired",
];
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
export function buildHumanRequestId(runId, nodeId, iteration) {
    return `human:${runId}:${nodeId}:${iteration}`;
}
/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @returns {boolean}
 */
export function isHumanTaskMeta(meta) {
    return Boolean(meta?.humanTask);
}
/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @param {string} fallback
 * @returns {string}
 */
export function getHumanTaskPrompt(meta, fallback) {
    const prompt = meta?.prompt;
    return typeof prompt === "string" && prompt.trim().length > 0
        ? prompt
        : fallback;
}
/**
 * @param {{ timeoutAtMs?: number | null } | null | undefined} request
 * @returns {boolean}
 */
export function isHumanRequestPastTimeout(request, nowMs = Date.now()) {
    return (typeof request?.timeoutAtMs === "number" &&
        Number.isFinite(request.timeoutAtMs) &&
        request.timeoutAtMs <= nowMs);
}
/**
 * @param {{ issues?: Array<{ path?: PropertyKey[]; message?: string }> }} error
 */
function formatValidationIssues(error) {
    const issues = error.issues ?? [];
    if (issues.length === 0) {
        return "unknown validation error";
    }
    return issues
        .map((issue) => {
        const path = Array.isArray(issue.path) && issue.path.length > 0
            ? issue.path.join(".")
            : "(root)";
        return `${path}: ${issue.message ?? "invalid value"}`;
    })
        .join("; ");
}
/**
 * @param {{ requestId: string; schemaJson: string | null }} request
 * @param {unknown} value
 * @returns {HumanRequestSchemaValidation}
 */
export function validateHumanRequestValue(request, value) {
    if (!request.schemaJson) {
        return { ok: true };
    }
    let schema;
    try {
        schema = JSON.parse(request.schemaJson);
    }
    catch (err) {
        return {
            ok: false,
            code: "HUMAN_REQUEST_SCHEMA_INVALID",
            message: `Stored schema for ${request.requestId} is not valid JSON: ${err?.message ?? String(err)}`,
        };
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return {
            ok: false,
            code: "HUMAN_REQUEST_SCHEMA_INVALID",
            message: `Stored schema for ${request.requestId} is not a JSON object.`,
        };
    }
    let validator;
    try {
        validator = jsonSchemaToZod(schema);
    }
    catch (err) {
        return {
            ok: false,
            code: "HUMAN_REQUEST_SCHEMA_INVALID",
            message: `Stored schema for ${request.requestId} could not be loaded for validation: ${err?.message ?? String(err)}`,
        };
    }
    const result = validator.safeParse(value);
    if (!result.success) {
        return {
            ok: false,
            code: "HUMAN_REQUEST_VALIDATION_FAILED",
            message: `Human request ${request.requestId} does not match the stored schema: ${formatValidationIssues(result.error)}`,
        };
    }
    return { ok: true };
}
