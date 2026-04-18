// ---------------------------------------------------------------------------
// Shared private helpers for OpenAPI tool factory
// ---------------------------------------------------------------------------
import { tool, zodSchema } from "ai";
import { Effect, Metric } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { openApiToolCallsTotal, openApiToolCallErrorsTotal, openApiToolDuration, } from "../metrics.js";
import { buildOperationSchema } from "../schema-converter.js";
import { extractOperations } from "../spec-parser.js";
/** @typedef {import("../OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("../OpenApiTool.ts").OpenApiTool} OpenApiTool */
/** @typedef {import("../OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */
/** @typedef {import("../ParsedOperation.ts").ParsedOperation} ParsedOperation */

// ---------------------------------------------------------------------------
// HTTP execution
// ---------------------------------------------------------------------------
/**
 * @param {OpenApiToolsOptions} options
 * @returns {Record<string, string>}
 */
export function buildAuthHeaders(options) {
    const headers = {};
    if (options.auth) {
        switch (options.auth.type) {
            case "bearer":
                headers["Authorization"] = `Bearer ${options.auth.token}`;
                break;
            case "basic": {
                const encoded = btoa(`${options.auth.username}:${options.auth.password}`);
                headers["Authorization"] = `Basic ${encoded}`;
                break;
            }
            case "apiKey":
                if (options.auth.in === "header") {
                    headers[options.auth.name] = options.auth.value;
                }
                break;
        }
    }
    if (options.headers) {
        Object.assign(headers, options.headers);
    }
    return headers;
}
/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {Record<string, string>} pathParams
 * @param {Record<string, string>} queryParams
 * @param {OpenApiToolsOptions} options
 * @returns {string}
 */
export function buildUrl(baseUrl, path, pathParams, queryParams, options) {
    // Substitute path parameters
    let url = path;
    for (const [key, value] of Object.entries(pathParams)) {
        url = url.replace(`{${key}}`, encodeURIComponent(value));
    }
    const fullUrl = new URL(url, baseUrl);
    // Add query parameters
    for (const [key, value] of Object.entries(queryParams)) {
        fullUrl.searchParams.set(key, value);
    }
    // Add API key to query if configured
    if (options.auth?.type === "apiKey" && options.auth.in === "query") {
        fullUrl.searchParams.set(options.auth.name, options.auth.value);
    }
    return fullUrl.toString();
}
/**
 * @param {ParsedOperation} operation
 * @param {Record<string, unknown>} args
 * @param {string} baseUrl
 * @param {OpenApiToolsOptions} options
 * @returns {Promise<unknown>}
 */
export async function executeRequest(operation, args, baseUrl, options) {
    /** @type {Record<string, string>} */
    const pathParams = {};
    /** @type {Record<string, string>} */
    const queryParams = {};
    /** @type {Record<string, string>} */
    const headerParams = {};
    // Sort parameters into buckets
    for (const param of operation.parameters) {
        const value = args[param.name];
        if (value === undefined)
            continue;
        const strValue = String(value);
        switch (param.in) {
            case "path":
                pathParams[param.name] = strValue;
                break;
            case "query":
                queryParams[param.name] = strValue;
                break;
            case "header":
                headerParams[param.name] = strValue;
                break;
        }
    }
    const url = buildUrl(baseUrl, operation.path, pathParams, queryParams, options);
    /** @type {Record<string, string>} */
    const headers = {
        ...buildAuthHeaders(options),
        ...headerParams,
    };
    /** @type {RequestInit} */
    const fetchInit = {
        method: operation.method.toUpperCase(),
        headers,
    };
    // Request body
    if (args.body !== undefined) {
        headers["Content-Type"] = "application/json";
        fetchInit.headers = headers;
        fetchInit.body = JSON.stringify(args.body);
    }
    const response = await fetch(url, fetchInit);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
        return response.json();
    }
    return response.text();
}
// ---------------------------------------------------------------------------
// Effect-wrapped execution with metrics
// ---------------------------------------------------------------------------
/**
 * @param {ParsedOperation} operation
 * @param {Record<string, unknown>} args
 * @param {string} baseUrl
 * @param {OpenApiToolsOptions} options
 * @returns {Effect.Effect<unknown, unknown, never>}
 */
export function executeToolEffect(operation, args, baseUrl, options) {
    const started = nowMs();
    return Effect.gen(function* () {
        yield* Metric.increment(openApiToolCallsTotal);
        const result = yield* Effect.tryPromise({
            try: () => executeRequest(operation, args, baseUrl, options),
            catch: (err) => err,
        });
        const durationMs = nowMs() - started;
        yield* Metric.update(openApiToolDuration, durationMs);
        return result;
    }).pipe(Effect.tapError(() => Metric.increment(openApiToolCallErrorsTotal)), Effect.annotateLogs({
        toolName: `openapi:${operation.operationId}`,
        method: operation.method,
        path: operation.path,
    }), Effect.withLogSpan(`openapi:${operation.operationId}`));
}
// ---------------------------------------------------------------------------
// Tool creation
// ---------------------------------------------------------------------------
/**
 * @param {ParsedOperation} operation
 * @param {OpenApiSpec} spec
 * @param {string} baseUrl
 * @param {OpenApiToolsOptions} options
 * @returns {{ name: string; tool: OpenApiTool }}
 */
export function createToolFromOperation(operation, spec, baseUrl, options) {
    const inputSchema = buildOperationSchema(operation.parameters, operation.requestBody, spec);
    const description = operation.summary || operation.description || operation.operationId;
    const prefix = options.namePrefix ?? "";
    return {
        name: `${prefix}${operation.operationId}`,
        tool: tool({
            description,
            inputSchema: zodSchema(inputSchema),
            execute: async (args) => {
                try {
                    return await Effect.runPromise(executeToolEffect(operation, /** @type {Record<string, unknown>} */ (args), baseUrl, options));
                }
                catch (error) {
                    // Return error info as tool result instead of throwing
                    const e = /** @type {{ message?: string }} */ (error);
                    return {
                        error: true,
                        message: e?.message ?? String(error),
                        status: "failed",
                    };
                }
            },
        }),
    };
}
/**
 * @param {OpenApiSpec} spec
 * @param {OpenApiToolsOptions} options
 * @returns {string}
 */
export function resolveBaseUrl(spec, options) {
    if (options.baseUrl)
        return options.baseUrl;
    if (spec.servers && spec.servers.length > 0)
        return spec.servers[0].url;
    return "http://localhost";
}
/**
 * @param {OpenApiSpec} spec
 * @param {OpenApiToolsOptions} options
 * @returns {Record<string, OpenApiTool>}
 */
export function createOpenApiToolsFromSpec(spec, options) {
    const operations = extractOperations(spec);
    const baseUrl = resolveBaseUrl(spec, options);
    /** @type {Record<string, OpenApiTool>} */
    const tools = {};
    for (const op of operations) {
        // Apply include/exclude filters
        if (options.include && !options.include.includes(op.operationId))
            continue;
        if (options.exclude && options.exclude.includes(op.operationId))
            continue;
        const { name, tool: t } = createToolFromOperation(op, spec, baseUrl, options);
        tools[name] = t;
    }
    return tools;
}
/**
 * @param {OpenApiSpec} spec
 * @param {string} operationId
 * @param {OpenApiToolsOptions} options
 * @returns {OpenApiTool}
 */
export function createOpenApiToolFromSpec(spec, operationId, options) {
    const operations = extractOperations(spec);
    const op = operations.find((o) => o.operationId === operationId);
    if (!op) {
        throw new Error(`Operation "${operationId}" not found in spec. Available: ${operations.map((o) => o.operationId).join(", ")}`);
    }
    const baseUrl = resolveBaseUrl(spec, options);
    return createToolFromOperation(op, spec, baseUrl, options).tool;
}
