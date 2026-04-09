import { pydanticSchemaToZod } from "./external/json-schema-to-zod";

export const HUMAN_REQUEST_KINDS = ["ask", "confirm", "select", "json"] as const;
export type HumanRequestKind = (typeof HUMAN_REQUEST_KINDS)[number];

export const HUMAN_REQUEST_STATUSES = [
  "pending",
  "answered",
  "cancelled",
  "expired",
] as const;
export type HumanRequestStatus = (typeof HUMAN_REQUEST_STATUSES)[number];

export function buildHumanRequestId(
  runId: string,
  nodeId: string,
  iteration: number,
): string {
  return `human:${runId}:${nodeId}:${iteration}`;
}

export function isHumanTaskMeta(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  return Boolean(meta?.humanTask);
}

export function getHumanTaskPrompt(
  meta: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  const prompt = meta?.prompt;
  return typeof prompt === "string" && prompt.trim().length > 0
    ? prompt
    : fallback;
}

export function isHumanRequestPastTimeout(
  request: { timeoutAtMs?: number | null } | null | undefined,
  nowMs = Date.now(),
): boolean {
  return (
    typeof request?.timeoutAtMs === "number" &&
    Number.isFinite(request.timeoutAtMs) &&
    request.timeoutAtMs <= nowMs
  );
}

type HumanRequestSchemaValidation =
  | { ok: true }
  | {
      ok: false;
      code: "HUMAN_REQUEST_SCHEMA_INVALID" | "HUMAN_REQUEST_VALIDATION_FAILED";
      message: string;
    };

function formatValidationIssues(error: { issues?: Array<{ path?: PropertyKey[]; message?: string }> }) {
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

export function validateHumanRequestValue(
  request: { requestId: string; schemaJson: string | null },
  value: unknown,
): HumanRequestSchemaValidation {
  if (!request.schemaJson) {
    return { ok: true };
  }

  let schema: unknown;
  try {
    schema = JSON.parse(request.schemaJson);
  } catch (err: any) {
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
    validator = pydanticSchemaToZod(schema as Record<string, unknown>);
  } catch (err: any) {
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
