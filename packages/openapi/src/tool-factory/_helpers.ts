// ---------------------------------------------------------------------------
// Shared private helpers for OpenAPI tool factory
// ---------------------------------------------------------------------------

import { tool, zodSchema } from "ai";
import { Effect, Metric } from "effect";
import { runPromise } from "@smithers/runtime/runtime";
import { nowMs } from "@smithers/core/utils/time";
import {
  openApiToolCallsTotal,
  openApiToolCallErrorsTotal,
  openApiToolDuration,
} from "../metrics";
import { buildOperationSchema } from "../schema-converter";
import { extractOperations } from "../spec-parser";
import type {
  OpenApiSpec,
  OpenApiToolsOptions,
  ParsedOperation,
} from "../types";

// ---------------------------------------------------------------------------
// HTTP execution
// ---------------------------------------------------------------------------

export function buildAuthHeaders(
  options: OpenApiToolsOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (options.auth) {
    switch (options.auth.type) {
      case "bearer":
        headers["Authorization"] = `Bearer ${options.auth.token}`;
        break;
      case "basic": {
        const encoded = btoa(
          `${options.auth.username}:${options.auth.password}`,
        );
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

export function buildUrl(
  baseUrl: string,
  path: string,
  pathParams: Record<string, string>,
  queryParams: Record<string, string>,
  options: OpenApiToolsOptions,
): string {
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

export async function executeRequest(
  operation: ParsedOperation,
  args: Record<string, any>,
  baseUrl: string,
  options: OpenApiToolsOptions,
): Promise<unknown> {
  const pathParams: Record<string, string> = {};
  const queryParams: Record<string, string> = {};
  const headerParams: Record<string, string> = {};

  // Sort parameters into buckets
  for (const param of operation.parameters) {
    const value = args[param.name];
    if (value === undefined) continue;
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
  const headers = {
    ...buildAuthHeaders(options),
    ...headerParams,
  };

  const fetchInit: RequestInit = {
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

export function executeToolEffect(
  operation: ParsedOperation,
  args: Record<string, any>,
  baseUrl: string,
  options: OpenApiToolsOptions,
) {
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
  }).pipe(
    Effect.tapError(() => Metric.increment(openApiToolCallErrorsTotal)),
    Effect.annotateLogs({
      toolName: `openapi:${operation.operationId}`,
      method: operation.method,
      path: operation.path,
    }),
    Effect.withLogSpan(`openapi:${operation.operationId}`),
  );
}

// ---------------------------------------------------------------------------
// Tool creation
// ---------------------------------------------------------------------------

export function createToolFromOperation(
  operation: ParsedOperation,
  spec: OpenApiSpec,
  baseUrl: string,
  options: OpenApiToolsOptions,
): any {
  const inputSchema = buildOperationSchema(
    operation.parameters,
    operation.requestBody,
    spec,
  );

  const description = operation.summary || operation.description || operation.operationId;
  const prefix = options.namePrefix ?? "";

  return {
    name: `${prefix}${operation.operationId}`,
    tool: (tool as any)({
      description,
      inputSchema: zodSchema(inputSchema as any),
      execute: async (args: Record<string, any>) => {
        try {
          return await runPromise(
            executeToolEffect(operation, args, baseUrl, options),
          );
        } catch (error: any) {
          // Return error info as tool result instead of throwing
          return {
            error: true,
            message: error?.message ?? String(error),
            status: "failed",
          };
        }
      },
    }),
  };
}

export function resolveBaseUrl(
  spec: OpenApiSpec,
  options: OpenApiToolsOptions,
): string {
  if (options.baseUrl) return options.baseUrl;
  if (spec.servers && spec.servers.length > 0) return spec.servers[0]!.url;
  return "http://localhost";
}

export function createOpenApiToolsFromSpec(
  spec: OpenApiSpec,
  options: OpenApiToolsOptions,
): Record<string, any> {
  const operations = extractOperations(spec);
  const baseUrl = resolveBaseUrl(spec, options);
  const tools: Record<string, any> = {};

  for (const op of operations) {
    // Apply include/exclude filters
    if (options.include && !options.include.includes(op.operationId)) continue;
    if (options.exclude && options.exclude.includes(op.operationId)) continue;

    const { name, tool: t } = createToolFromOperation(op, spec, baseUrl, options);
    tools[name] = t;
  }

  return tools;
}

export function createOpenApiToolFromSpec(
  spec: OpenApiSpec,
  operationId: string,
  options: OpenApiToolsOptions,
): any {
  const operations = extractOperations(spec);
  const op = operations.find((o) => o.operationId === operationId);
  if (!op) {
    throw new Error(
      `Operation "${operationId}" not found in spec. Available: ${operations.map((o) => o.operationId).join(", ")}`,
    );
  }
  const baseUrl = resolveBaseUrl(spec, options);
  return createToolFromOperation(op, spec, baseUrl, options).tool;
}
