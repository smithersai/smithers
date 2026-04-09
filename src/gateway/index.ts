import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { Effect, Metric } from "effect";
import { WebSocketServer, type WebSocket } from "ws";
import { runWorkflow } from "../engine";
import { approveNode, denyNode } from "../engine/approvals";
import { signalRun } from "../engine/signals";
import type { SmithersWorkflow } from "../SmithersWorkflow";
import type { SmithersEvent } from "../SmithersEvent";
import { SmithersDb } from "../db/adapter";
import { ensureSmithersTables } from "../db/ensure";
import {
  gatewayApprovalDecisionsTotal,
  gatewayAuthEventsTotal,
  gatewayConnectionsActive,
  gatewayConnectionsClosedTotal,
  gatewayConnectionsTotal,
  gatewayCronTriggersTotal,
  gatewayErrorsTotal,
  gatewayHeartbeatTicksTotal,
  gatewayMessagesReceivedTotal,
  gatewayMessagesSentTotal,
  gatewayRpcCallsTotal,
  gatewayRpcDuration,
  gatewayRunsCompletedTotal,
  gatewayRunsStartedTotal,
  gatewaySignalsTotal,
  gatewayWebhooksReceivedTotal,
  gatewayWebhooksRejectedTotal,
  gatewayWebhooksVerifiedTotal,
} from "../effect/metrics";
import { runFork, runPromise } from "../effect/runtime";
import { prometheusContentType, renderPrometheusMetrics } from "../observability";
import { nowMs } from "../utils/time";
import { newRunId } from "../utils/ids";
import { errorToJson, isSmithersError, SmithersError } from "../utils/errors";
import {
  assertJsonPayloadWithinBounds,
  assertOptionalStringMaxLength,
  assertPositiveFiniteInteger,
} from "../utils/input-bounds";
import { loadLatestSnapshot, loadSnapshot } from "../time-travel/snapshot";
import { diffRawSnapshots } from "../time-travel/diff";

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq: number;
  stateVersion: number;
};

export type ConnectRequest = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
  };
  auth?: { token: string } | { password: string };
  subscribe?: string[];
};

export type HelloResponse = {
  protocol: number;
  features: string[];
  policy: { heartbeatMs: number };
  auth: {
    sessionToken: string;
    role: string;
    scopes: string[];
    userId: string | null;
  };
  snapshot: {
    runs: any[];
    approvals: any[];
    stateVersion: number;
  };
};

export type GatewayTokenGrant = {
  role: string;
  scopes: string[];
  userId?: string;
};

export type GatewayAuthConfig =
  | {
      mode: "token";
      tokens: Record<string, GatewayTokenGrant>;
    }
  | {
      mode: "jwt";
      issuer: string;
      audience: string | string[];
      secret: string;
      scopesClaim?: string;
      roleClaim?: string;
      userClaim?: string;
      defaultRole?: string;
      defaultScopes?: string[];
      clockSkewSeconds?: number;
    }
  | {
      mode: "trusted-proxy";
      trustedHeaders?: string[];
      allowedOrigins?: string[];
      defaultRole?: string;
      defaultScopes?: string[];
    };

export type GatewayDefaults = {
  cliAgentTools?: "all" | "explicit-only";
};

export type GatewayOptions = {
  protocol?: number;
  features?: string[];
  heartbeatMs?: number;
  auth?: GatewayAuthConfig;
  defaults?: GatewayDefaults;
  maxBodyBytes?: number;
  maxPayload?: number;
  maxConnections?: number;
};

type RegisteredWorkflow = {
  key: string;
  workflow: SmithersWorkflow<any>;
  schedule?: string;
  webhook?: GatewayWebhookConfig;
};

type GatewayWebhookSignalConfig = {
  name: string;
  correlationIdPath?: string;
  runIdPath?: string;
  payloadPath?: string;
};

type GatewayWebhookRunConfig = {
  enabled?: boolean;
  inputPath?: string;
};

type GatewayWebhookConfig = {
  secret: string;
  signatureHeader?: string;
  signaturePrefix?: string;
  signal?: GatewayWebhookSignalConfig;
  run?: GatewayWebhookRunConfig;
};

type GatewayWebhookDelivery = {
  runId: string;
  seq: number;
  signalName: string;
  correlationId: string | null;
  receivedAtMs: number;
};

type ActiveRunRecord = {
  workflowKey: string;
  workflow: SmithersWorkflow<any>;
  abort: AbortController;
  input: Record<string, unknown>;
};

type GatewayTransport = "http" | "ws";

type GatewayRequestContext = {
  connectionId: string;
  transport: GatewayTransport;
  role: string | null;
  scopes: string[];
  userId: string | null;
  subscribedRuns: Set<string> | null;
};

type ConnectionState = GatewayRequestContext & {
  ws: WebSocket;
  seq: number;
  authenticated: boolean;
  sessionToken: string | null;
  heartbeatTimer: Timer | null;
};

type ResolvedRun = {
  workflowKey: string;
  workflow: SmithersWorkflow<any>;
  adapter: SmithersDb;
};

type ApprovalRequestRecord = {
  mode: "decision" | "select" | "rank" | "gate";
  title: string | null;
  summary: string | null;
  options: Array<{ key: string; label: string; summary?: string }>;
  allowedScopes: string[];
  allowedUsers: string[];
  autoApprove: Record<string, unknown> | null;
};

type RunStartAuthContext = {
  triggeredBy: string;
  scopes: string[];
  role: string;
  subscribeConnection?: GatewayRequestContext | null;
};

type MethodAccess = "read" | "execute" | "approve" | "admin";
type GatewayMetricLabels = Record<
  string,
  string | number | boolean | null | undefined
>;

const DEFAULT_PROTOCOL = 1;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_CONNECTIONS = 1_000;
export const GATEWAY_RPC_MAX_PAYLOAD_BYTES = DEFAULT_MAX_BODY_BYTES;
export const GATEWAY_RPC_MAX_DEPTH = 32;
export const GATEWAY_RPC_MAX_ARRAY_LENGTH = 256;
export const GATEWAY_RPC_MAX_STRING_LENGTH = 16 * 1024;
export const GATEWAY_METHOD_NAME_MAX_LENGTH = 64;
export const GATEWAY_FRAME_ID_MAX_LENGTH = 128;
export const GATEWAY_RPC_INPUT_MAX_BYTES = GATEWAY_RPC_MAX_PAYLOAD_BYTES;
export const GATEWAY_RPC_INPUT_MAX_DEPTH = GATEWAY_RPC_MAX_DEPTH;
const GATEWAY_METHOD_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;

const ACCESS_RANK: Record<MethodAccess, number> = {
  read: 1,
  execute: 2,
  approve: 3,
  admin: 4,
};

const METHOD_ACCESS: Record<string, MethodAccess> = {
  health: "read",
  "runs.list": "read",
  "runs.get": "read",
  "runs.diff": "read",
  "frames.list": "read",
  "frames.get": "read",
  "attempts.list": "read",
  "attempts.get": "read",
  "approvals.list": "read",
  "runs.create": "execute",
  "runs.cancel": "execute",
  "runs.rerun": "execute",
  "signals.send": "execute",
  "approvals.decide": "approve",
  "cron.list": "read",
  "cron.add": "admin",
  "cron.remove": "admin",
  "cron.trigger": "execute",
};

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
}

function sendText(
  res: ServerResponse,
  status: number,
  payload: string,
  contentType = "text/plain; charset=utf-8",
) {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(payload);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asWebhookString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return undefined;
}

function taggedMetric(metric: any, labels: GatewayMetricLabels = {}) {
  let tagged = metric;
  for (const [key, value] of Object.entries(labels)) {
    if (value === undefined || value === null) {
      continue;
    }
    tagged = Metric.tagged(tagged, key, String(value));
  }
  return tagged;
}

function incrementMetric(metric: any, labels: GatewayMetricLabels = {}) {
  return Metric.increment(taggedMetric(metric, labels));
}

function updateMetric(metric: any, value: number, labels: GatewayMetricLabels = {}) {
  return Metric.update(taggedMetric(metric, labels), value);
}

function emitGatewayEffect(effect: Effect.Effect<void, never, never>) {
  void runFork(effect);
}

function emitGatewayLog(
  level: "debug" | "info" | "warning" | "error",
  message: string,
  annotations?: Record<string, unknown>,
  span?: string,
) {
  let effect = level === "debug"
    ? Effect.logDebug(message)
    : level === "info"
      ? Effect.logInfo(message)
      : level === "warning"
        ? Effect.logWarning(message)
        : Effect.logError(message);
  if (annotations && Object.keys(annotations).length > 0) {
    effect = effect.pipe(Effect.annotateLogs(annotations));
  }
  if (span) {
    effect = effect.pipe(Effect.withLogSpan(span));
  }
  emitGatewayEffect(effect);
}

function gatewayContextAnnotations(
  context: GatewayRequestContext,
): Record<string, unknown> {
  return {
    connectionId: context.connectionId,
    transport: context.transport,
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.role ? { role: context.role } : {}),
  };
}

function gatewayRunAnnotations(
  params?: Record<string, unknown>,
  payload?: unknown,
): Record<string, unknown> {
  const annotations: Record<string, unknown> = {};
  const responsePayload = asObject(payload);
  const runId = asString(params?.runId) ?? asString(responsePayload?.runId);
  const leftRunId = asString(params?.leftRunId);
  const rightRunId = asString(params?.rightRunId);
  if (runId) {
    annotations.runId = runId;
  }
  if (leftRunId) {
    annotations.leftRunId = leftRunId;
  }
  if (rightRunId) {
    annotations.rightRunId = rightRunId;
  }
  return annotations;
}

function gatewayRpcAnnotations(
  context: GatewayRequestContext,
  frame: Pick<RequestFrame, "id" | "method" | "params">,
  payload?: unknown,
): Record<string, unknown> {
  return {
    ...gatewayContextAnnotations(context),
    frameId: frame.id,
    method: frame.method,
    ...gatewayRunAnnotations(asObject(frame.params) ?? {}, payload),
  };
}

function gatewayErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = asString((error as any).code);
    if (code) {
      return code;
    }
  }
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "UNKNOWN";
}

function gatewayErrorAnnotations(error: unknown): Record<string, unknown> {
  const serialized = errorToJson(error);
  return {
    errorCode: gatewayErrorCode(error),
    ...(serialized.summary ? { errorSummary: serialized.summary } : {}),
    ...(serialized.message ? { errorMessage: serialized.message } : {}),
    error: serialized,
  };
}

function gatewayAuthMode(auth: GatewayAuthConfig | undefined): string {
  return auth?.mode ?? "none";
}

function gatewayTriggerSource(triggeredBy: string): string {
  if (triggeredBy.startsWith("cron:")) {
    return "cron";
  }
  if (triggeredBy.startsWith("webhook:")) {
    return "webhook";
  }
  if (triggeredBy === "gateway") {
    return "gateway";
  }
  return "user";
}

function asOptionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return Math.floor(assertPositiveFiniteInteger(field, Number(value)));
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" ? value : null;
}

function bearerTokenFromHeaders(req: IncomingMessage): string | null {
  const smithersKey = headerValue(req, "x-smithers-key");
  if (smithersKey) {
    return smithersKey;
  }
  const authHeader = headerValue(req, "authorization");
  if (!authHeader) {
    return null;
  }
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
}

function asStringRecord(value: unknown): Record<string, unknown> | null {
  return asObject(value);
}

function responseOk(id: string, payload?: unknown): ResponseFrame {
  return { type: "res", id, ok: true, payload };
}

function responseError(id: string, code: string, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}

function rawDataToUtf8(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(
      raw.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(entry))),
    ).toString("utf8");
  }
  return Buffer.from(raw as ArrayBufferLike).toString("utf8");
}

export function validateGatewayMethodName(method: unknown): string {
  if (typeof method !== "string") {
    throw new SmithersError(
      "INVALID_INPUT",
      "Gateway method name must be a string.",
      { methodType: typeof method },
    );
  }
  assertOptionalStringMaxLength(
    "method",
    method,
    GATEWAY_METHOD_NAME_MAX_LENGTH,
  );
  if (!GATEWAY_METHOD_NAME_PATTERN.test(method)) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Gateway method name is invalid.",
      { method },
    );
  }
  return method;
}

export function parseGatewayRequestFrame(
  raw: unknown,
  maxPayloadBytes = GATEWAY_RPC_MAX_PAYLOAD_BYTES,
): RequestFrame {
  const body = rawDataToUtf8(raw);
  if (Buffer.byteLength(body, "utf8") > maxPayloadBytes) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Gateway RPC payload exceeds ${maxPayloadBytes} bytes.`,
      { maxBytes: maxPayloadBytes },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Gateway RPC payload must be valid JSON.",
      undefined,
      { cause: error },
    );
  }

  assertJsonPayloadWithinBounds("gateway frame", parsed, {
    maxArrayLength: GATEWAY_RPC_MAX_ARRAY_LENGTH,
    maxDepth: GATEWAY_RPC_MAX_DEPTH,
    maxStringLength: GATEWAY_RPC_MAX_STRING_LENGTH,
  });

  const frame = asObject(parsed);
  if (!frame || frame.type !== "req") {
    throw new SmithersError(
      "INVALID_INPUT",
      "Gateway frame must be a request object.",
    );
  }
  if (typeof frame.id !== "string") {
    throw new SmithersError(
      "INVALID_INPUT",
      "Gateway frame id must be a string.",
    );
  }
  assertOptionalStringMaxLength("id", frame.id, GATEWAY_FRAME_ID_MAX_LENGTH);

  return {
    type: "req",
    id: frame.id,
    method: validateGatewayMethodName(frame.method),
    params: frame.params,
  };
}

function gatewayInputDepthAt(
  value: unknown,
  depth: number,
  seen: Set<unknown>,
): number {
  if (!value || typeof value !== "object") {
    return depth;
  }
  if (seen.has(value)) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Gateway RPC input must not contain circular references.",
    );
  }

  seen.add(value);
  let maxDepth = depth;
  const entries = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    const entryDepth =
      entry && typeof entry === "object"
        ? gatewayInputDepthAt(entry, depth + 1, seen)
        : depth;
    if (entryDepth > maxDepth) {
      maxDepth = entryDepth;
    }
  }
  seen.delete(value);
  return maxDepth;
}

export function getGatewayInputDepth(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  return gatewayInputDepthAt(value, 1, new Set());
}

export function assertGatewayInputDepthWithinBounds(
  value: unknown,
  maxDepth = GATEWAY_RPC_INPUT_MAX_DEPTH,
): number {
  const depth = getGatewayInputDepth(value);
  if (depth > maxDepth) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Gateway RPC input exceeds the maximum nesting depth of ${maxDepth}.`,
      {
        actualDepth: depth,
        maxDepth,
      },
    );
  }
  return depth;
}

function validateGatewayRpcInput(input: unknown): Record<string, unknown> {
  const normalizedInput = asObject(input) ?? {};
  const inputJson = JSON.stringify(normalizedInput);
  if (inputJson === undefined) {
    throw new SmithersError(
      "INVALID_INPUT",
      "Gateway RPC input must be JSON-serializable.",
    );
  }

  const inputBytes = Buffer.byteLength(inputJson, "utf8");
  if (inputBytes > GATEWAY_RPC_INPUT_MAX_BYTES) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Gateway RPC input exceeds ${GATEWAY_RPC_INPUT_MAX_BYTES} bytes.`,
      {
        actualBytes: inputBytes,
        maxBytes: GATEWAY_RPC_INPUT_MAX_BYTES,
      },
    );
  }

  assertGatewayInputDepthWithinBounds(normalizedInput);
  return normalizedInput;
}

function statusForRpcError(code: string | undefined) {
  switch (code) {
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
    case "METHOD_NOT_FOUND":
      return 404;
    case "INVALID_REQUEST":
    case "INVALID_FRAME":
    case "INVALID_INPUT":
    case "PROTOCOL_UNSUPPORTED":
      return 400;
    default:
      return 500;
  }
}

function eventRunId(payload: unknown): string | null {
  const record = asObject(payload);
  const runId = record ? asString(record.runId) : undefined;
  return runId ?? null;
}

function normalizeGrantedScope(scope: string): string {
  return scope.trim();
}

function accessForMethod(method: string): MethodAccess {
  return METHOD_ACCESS[method] ?? (method.startsWith("config.") ? "admin" : "read");
}

function hasScope(scopes: string[], method: string): boolean {
  if (scopes.includes("*")) {
    return true;
  }

  const requiredAccess = accessForMethod(method);
  const grantedLevels = scopes
    .map((scope) => scope.trim())
    .filter((scope) => scope === "read" || scope === "execute" || scope === "approve" || scope === "admin") as MethodAccess[];
  if (grantedLevels.some((level) => ACCESS_RANK[level] >= ACCESS_RANK[requiredAccess])) {
    return true;
  }

  for (const scope of scopes.map(normalizeGrantedScope)) {
    if (!scope) continue;
    if (scope === method) return true;
    if (scope.endsWith(".*") && method.startsWith(scope.slice(0, -1))) {
      return true;
    }
  }

  return false;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return asStringRecord(JSON.parse(decoded));
  } catch {
    return null;
  }
}

function verifyJwtToken(
  token: string,
  config: Extract<GatewayAuthConfig, { mode: "jwt" }>,
): { ok: true; payload: Record<string, unknown> } | { ok: false; message: string } {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return { ok: false, message: "JWT must have three segments" };
  }

  const header = decodeBase64UrlJson(encodedHeader);
  const payload = decodeBase64UrlJson(encodedPayload);
  if (!header || !payload) {
    return { ok: false, message: "JWT header or payload was not valid JSON" };
  }
  if (header.alg !== "HS256") {
    return { ok: false, message: "Unsupported JWT algorithm" };
  }

  const expectedSignature = createHmac("sha256", config.secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  const actualSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignatureBuffer = Buffer.from(expectedSignature, "base64url");
  if (
    actualSignature.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(actualSignature, expectedSignatureBuffer)
  ) {
    return { ok: false, message: "JWT signature verification failed" };
  }

  const now = Math.floor(Date.now() / 1_000);
  const skew = Math.max(0, config.clockSkewSeconds ?? 60);
  const exp = asNumber(payload.exp);
  const nbf = asNumber(payload.nbf);
  const iss = asString(payload.iss);
  const aud = payload.aud;
  if (iss !== config.issuer) {
    return { ok: false, message: "JWT issuer did not match" };
  }
  const audiences = Array.isArray(config.audience) ? config.audience : [config.audience];
  const tokenAudiences = typeof aud === "string" ? [aud] : parseStringArray(aud);
  if (!audiences.some((audience) => tokenAudiences.includes(audience))) {
    return { ok: false, message: "JWT audience did not match" };
  }
  if (typeof exp === "number" && now - skew >= exp) {
    return { ok: false, message: "JWT has expired" };
  }
  if (typeof nbf === "number" && now + skew < nbf) {
    return { ok: false, message: "JWT is not active yet" };
  }

  return { ok: true, payload };
}

function parseJwtScopes(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return parseStringArray(value);
}

function parseApprovalRequest(value: unknown, fallbackTitle: string | null): ApprovalRequestRecord {
  const record = asObject(value);
  const options = Array.isArray(record?.options)
    ? record.options
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
        .map((entry) => ({
          key: asString(entry.key) ?? "",
          label: asString(entry.label) ?? "",
          ...(asString(entry.summary) ? { summary: asString(entry.summary)! } : {}),
        }))
        .filter((entry) => entry.key.length > 0 && entry.label.length > 0)
    : [];
  const autoApprove =
    record?.autoApprove && typeof record.autoApprove === "object" && !Array.isArray(record.autoApprove)
      ? (record.autoApprove as Record<string, unknown>)
      : null;
  return {
    mode:
      record?.mode === "select" || record?.mode === "rank" || record?.mode === "decision"
        ? record.mode
        : "gate",
    title: asString(record?.title) ?? fallbackTitle,
    summary: asString(record?.summary) ?? null,
    options,
    allowedScopes: parseStringArray(record?.allowedScopes),
    allowedUsers: parseStringArray(record?.allowedUsers),
    autoApprove,
  };
}

function validateApprovalDecision(request: ApprovalRequestRecord, decision: unknown) {
  if (request.mode === "select") {
    const payload = asObject(decision);
    const selected = asString(payload?.selected);
    if (!selected) {
      return { ok: false as const, code: "INVALID_REQUEST", message: "select approvals require decision.selected" };
    }
    if (request.options.length > 0 && !request.options.some((option) => option.key === selected)) {
      return { ok: false as const, code: "INVALID_REQUEST", message: `Unknown selection: ${selected}` };
    }
  }
  if (request.mode === "rank") {
    const payload = asObject(decision);
    const ranked = parseStringArray(payload?.ranked);
    if (ranked.length === 0) {
      return { ok: false as const, code: "INVALID_REQUEST", message: "rank approvals require decision.ranked" };
    }
    const allowed = new Set(request.options.map((option) => option.key));
    if (allowed.size > 0 && ranked.some((value) => !allowed.has(value))) {
      return { ok: false as const, code: "INVALID_REQUEST", message: "rank approval included unknown options" };
    }
  }
  return { ok: true as const };
}

function nextCronRunAtMs(pattern: string) {
  const interval = CronExpressionParser.parse(pattern);
  return interval.next().getTime();
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizeCorrelationId(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function parseWebhookWaitForEventSnapshot(metaJson?: string | null) {
  if (!metaJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(metaJson);
    const waitForEvent = asObject(asObject(parsed)?.waitForEvent);
    const signalName = asString(waitForEvent?.signalName)?.trim();
    if (!signalName) {
      return null;
    }
    return {
      signalName,
      correlationId: normalizeCorrelationId(asString(waitForEvent?.correlationId) ?? null),
    };
  } catch {
    return null;
  }
}

function readPathValue(source: unknown, path: string | undefined): unknown {
  if (!path) {
    return source;
  }
  const trimmed = path.trim();
  if (!trimmed) {
    return source;
  }
  let current: unknown = source;
  for (const segment of trimmed.split(".").filter((entry) => entry.length > 0)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    const record = asObject(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

function parseJsonBuffer(body: Buffer, description: string) {
  if (body.length === 0) {
    return {};
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${description} must be valid JSON.`,
      undefined,
      { cause: error },
    );
  }
}

async function readRawBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  const lengthHeader = headerValue(req, "content-length");
  const declaredLength = lengthHeader ? Number(lengthHeader) : NaN;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Gateway request payload exceeds ${maxBytes} bytes.`,
      { maxBytes },
    );
  }

  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new SmithersError(
        "INVALID_INPUT",
        `Gateway request payload exceeds ${maxBytes} bytes.`,
        { maxBytes },
      );
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }

  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage, maxBytes: number) {
  return parseJsonBuffer(await readRawBody(req, maxBytes), "Gateway RPC payload");
}

function computeWebhookSignature(
  rawBody: Buffer,
  secret: string,
  prefix: string,
) {
  return `${prefix}${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function isValidWebhookSignature(expected: string, provided: string | null) {
  if (!provided) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function normalizeWebhookRunInput(input: unknown): Record<string, unknown> {
  const normalized = asObject(input) ?? { payload: input ?? null };
  return validateGatewayRpcInput(normalized);
}

function webhookTriggerUserId(workflowKey: string) {
  return `webhook:${workflowKey}`;
}

function cronWorkflowPath(workflowKey: string) {
  return `gateway:${workflowKey}`;
}

function workflowKeyFromCronPath(workflowPath: string | null | undefined) {
  if (!workflowPath || !workflowPath.startsWith("gateway:")) {
    return null;
  }
  return workflowPath.slice("gateway:".length);
}

function shouldDeliverEvent(connection: ConnectionState, runId: string | null) {
  if (!runId) return true;
  if (!connection.subscribedRuns || connection.subscribedRuns.size === 0) {
    return true;
  }
  return connection.subscribedRuns.has(runId);
}

export class Gateway {
  readonly protocol: number;
  readonly features: string[];
  readonly heartbeatMs: number;
  readonly maxBodyBytes: number;
  readonly maxPayload: number;
  readonly maxConnections: number;
  readonly auth?: GatewayAuthConfig;
  readonly defaults?: GatewayDefaults;

  private readonly workflows = new Map<string, RegisteredWorkflow>();
  private readonly connections = new Set<ConnectionState>();
  private readonly runRegistry = new Map<string, ActiveRunRecord>();
  private readonly activeRuns = new Map<string, ActiveRunRecord>();
  private readonly inflightRuns = new Map<string, Promise<void>>();
  private server: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private schedulerTimer: Timer | null = null;
  private stateVersion = 0;
  private readonly startedAtMs = nowMs();

  constructor(options: GatewayOptions = {}) {
    this.protocol = options.protocol ?? DEFAULT_PROTOCOL;
    this.features = [...(options.features ?? ["streaming", "runs"])];
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.maxBodyBytes = options.maxBodyBytes === undefined
      ? DEFAULT_MAX_BODY_BYTES
      : Math.floor(assertPositiveFiniteInteger("maxBodyBytes", Number(options.maxBodyBytes)));
    this.maxPayload = options.maxPayload === undefined
      ? GATEWAY_RPC_MAX_PAYLOAD_BYTES
      : Math.floor(assertPositiveFiniteInteger("maxPayload", Number(options.maxPayload)));
    this.maxConnections = options.maxConnections === undefined
      ? DEFAULT_MAX_CONNECTIONS
      : Math.floor(assertPositiveFiniteInteger("maxConnections", Number(options.maxConnections)));
    this.auth = options.auth;
    this.defaults = options.defaults;
  }

  private authModeLabel() {
    return gatewayAuthMode(this.auth);
  }

  private recordMessageReceived(
    transport: GatewayTransport,
    frameType: string,
    labels: GatewayMetricLabels = {},
  ) {
    emitGatewayEffect(
      incrementMetric(gatewayMessagesReceivedTotal, {
        transport,
        frameType,
        ...labels,
      }),
    );
  }

  private recordMessageSent(
    transport: GatewayTransport,
    frameType: string,
    labels: GatewayMetricLabels = {},
  ) {
    emitGatewayEffect(
      incrementMetric(gatewayMessagesSentTotal, {
        transport,
        frameType,
        ...labels,
      }),
    );
  }

  private recordAuthEvent(
    transport: GatewayTransport,
    outcome: "success" | "failure",
    context: GatewayRequestContext,
    details: Record<string, unknown> = {},
    level: "debug" | "info" | "warning" = outcome === "success" ? "info" : "warning",
  ) {
    const annotations = {
      ...gatewayContextAnnotations(context),
      authMode: this.authModeLabel(),
      outcome,
      ...details,
    };
    const logEffect = level === "debug"
      ? Effect.logDebug(
          outcome === "success"
            ? "Gateway auth succeeded"
            : "Gateway auth rejected",
        )
      : level === "info"
        ? Effect.logInfo("Gateway auth succeeded")
        : Effect.logWarning("Gateway auth rejected");
    emitGatewayEffect(
      Effect.all([
        incrementMetric(gatewayAuthEventsTotal, {
          transport,
          mode: this.authModeLabel(),
          outcome,
        }),
        logEffect.pipe(
          Effect.annotateLogs(annotations),
          Effect.withLogSpan("gateway:auth"),
        ),
      ], { discard: true }),
    );
  }

  private async executeRpc(
    context: GatewayRequestContext,
    frame: RequestFrame,
    handler: () => Promise<ResponseFrame>,
  ): Promise<ResponseFrame> {
    const self = this;
    const start = performance.now();
    const params = asObject(frame.params) ?? {};
    const result = await runPromise(
      Effect.gen(function* () {
        yield* incrementMetric(gatewayRpcCallsTotal, {
          transport: context.transport,
          method: frame.method,
        });
        yield* Effect.logDebug("Gateway RPC started");
        const result = yield* Effect.promise(() =>
          handler()
            .then((response) => ({ _tag: "success" as const, response }))
            .catch((error) => ({ _tag: "failure" as const, error })),
        );
        yield* updateMetric(gatewayRpcDuration, performance.now() - start, {
          transport: context.transport,
          method: frame.method,
        });
        if (result._tag === "failure") {
          yield* incrementMetric(gatewayErrorsTotal, {
            kind: "rpc",
            transport: context.transport,
            method: frame.method,
            code: gatewayErrorCode(result.error),
          });
          yield* Effect.logError("Gateway RPC failed").pipe(
            Effect.annotateLogs(gatewayErrorAnnotations(result.error)),
          );
          return result;
        }
        if (!result.response.ok) {
          yield* incrementMetric(gatewayErrorsTotal, {
            kind: "rpc",
            transport: context.transport,
            method: frame.method,
            code: result.response.error?.code ?? "UNKNOWN",
          });
          yield* Effect.logWarning("Gateway RPC rejected").pipe(
            Effect.annotateLogs({
              ...gatewayRunAnnotations(params, result.response.payload),
              rpcCode: result.response.error?.code ?? "UNKNOWN",
              ...(result.response.error?.message
                ? { rpcMessage: result.response.error.message }
                : {}),
            }),
          );
        } else {
          yield* Effect.logDebug("Gateway RPC completed").pipe(
            Effect.annotateLogs(gatewayRunAnnotations(params, result.response.payload)),
          );
          yield* self.rpcSuccessEffect(context, frame, result.response);
        }
        return result;
      }).pipe(
        Effect.annotateLogs(gatewayRpcAnnotations(context, frame)),
        Effect.withLogSpan(`gateway:rpc:${frame.method}`),
      ),
    );
    if (result._tag === "failure") {
      throw result.error;
    }
    return result.response;
  }

  private rpcSuccessEffect(
    context: GatewayRequestContext,
    frame: RequestFrame,
    response: ResponseFrame,
  ): Effect.Effect<void> {
    const params = asObject(frame.params) ?? {};
    switch (frame.method) {
      case "approvals.decide": {
        const approved = asBoolean(params.approved) ?? false;
        const nodeId = asString(params.nodeId);
        return Effect.all([
          incrementMetric(gatewayApprovalDecisionsTotal, {
            outcome: approved ? "approved" : "denied",
          }),
          Effect.logInfo("Gateway approval decision recorded").pipe(
            Effect.annotateLogs({
              ...gatewayRpcAnnotations(context, frame, response.payload),
              ...(nodeId ? { nodeId } : {}),
              iteration: asNumber(params.iteration) ?? 0,
              approved,
            }),
          ),
        ], { discard: true });
      }
      case "signals.send": {
        const signalName = asString(params.signalName);
        const correlationId = asString(params.correlationId);
        return Effect.all([
          incrementMetric(gatewaySignalsTotal, { outcome: "sent" }),
          Effect.logInfo("Gateway signal sent").pipe(
            Effect.annotateLogs({
              ...gatewayRpcAnnotations(context, frame, response.payload),
              ...(signalName ? { signalName } : {}),
              ...(correlationId ? { correlationId } : {}),
            }),
          ),
        ], { discard: true });
      }
      case "cron.trigger": {
        const cronId = asString(params.cronId);
        const workflow = asString(params.workflow);
        return Effect.all([
          incrementMetric(gatewayCronTriggersTotal, { source: "manual" }),
          Effect.logInfo("Gateway cron trigger requested").pipe(
            Effect.annotateLogs({
              ...gatewayRpcAnnotations(context, frame, response.payload),
              ...(cronId ? { cronId } : {}),
              ...(workflow ? { workflow } : {}),
            }),
          ),
        ], { discard: true });
      }
      default:
        return Effect.void;
    }
  }

  private sendHttpRpcResponse(
    res: ServerResponse,
    status: number,
    response: ResponseFrame,
  ) {
    this.recordMessageSent("http", "response", {
      outcome: response.ok ? "ok" : "error",
    });
    return sendJson(res, status, response);
  }

  private async runWaitsForSignal(
    adapter: SmithersDb,
    runId: string,
    signalName: string,
    correlationId: string | null,
  ) {
    const nodes = await adapter.listNodes(runId);
    for (const node of nodes as any[]) {
      if (node.state !== "waiting-event") {
        continue;
      }
      const iteration = node.iteration ?? 0;
      const attempts = await adapter.listAttempts(runId, node.nodeId, iteration);
      const waitingAttempt =
        (attempts as any[]).find((attempt) => attempt.state === "waiting-event") ??
        attempts[0];
      const snapshot = parseWebhookWaitForEventSnapshot(waitingAttempt?.metaJson);
      if (!snapshot) {
        continue;
      }
      if (snapshot.signalName !== signalName) {
        continue;
      }
      if (snapshot.correlationId !== correlationId) {
        continue;
      }
      return true;
    }
    return false;
  }

  private async findMatchingWebhookRuns(
    entry: RegisteredWorkflow,
    signalName: string,
    correlationId: string | null,
    explicitRunId?: string,
  ) {
    const adapter = this.adapterForWorkflow(entry.workflow);
    const matches = new Set<string>();
    if (explicitRunId) {
      const run = await adapter.getRun(explicitRunId);
      if (
        run &&
        run.status !== "finished" &&
        run.status !== "failed" &&
        run.status !== "cancelled" &&
        await this.runWaitsForSignal(adapter, explicitRunId, signalName, correlationId)
      ) {
        matches.add(explicitRunId);
      }
      return [...matches];
    }

    const waitingRuns = await adapter.listRuns(1_000, "waiting-event");
    for (const run of waitingRuns as any[]) {
      if (await this.runWaitsForSignal(adapter, run.runId, signalName, correlationId)) {
        matches.add(run.runId);
      }
    }
    return [...matches];
  }

  private async handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    workflowKey: string,
  ) {
    const requestId = headerValue(req, "x-request-id") ?? randomUUID();
    const respond = (status: number, payload: unknown) => {
      this.recordMessageSent("http", "response", {
        route: "webhook",
        workflow: workflowKey,
        outcome: status < 400 ? "ok" : "error",
      });
      return sendJson(res, status, payload);
    };
    const reject = (
      status: number,
      code: string,
      message: string,
      reason: string,
      error?: unknown,
    ) => {
      emitGatewayEffect(
        Effect.all([
          incrementMetric(gatewayWebhooksRejectedTotal, {
            workflow: workflowKey,
            reason,
          }),
          incrementMetric(gatewayErrorsTotal, {
            kind: "webhook",
            workflow: workflowKey,
            code,
          }),
        ], { discard: true }),
      );
      emitGatewayLog(
        error && !isSmithersError(error) ? "error" : "warning",
        "Gateway webhook rejected",
        {
          workflow: workflowKey,
          requestId,
          reason,
          errorCode: code,
          errorMessage: message,
          ...(error ? gatewayErrorAnnotations(error) : {}),
        },
        "gateway:webhook",
      );
      return respond(status, { ok: false, error: { code, message } });
    };

    this.recordMessageReceived("http", "webhook", { workflow: workflowKey });
    emitGatewayEffect(
      incrementMetric(gatewayWebhooksReceivedTotal, {
        workflow: workflowKey,
      }),
    );

    const entry = this.workflows.get(workflowKey);
    if (!entry) {
      return reject(404, "NOT_FOUND", `Unknown workflow: ${workflowKey}`, "workflow_not_found");
    }
    const webhook = entry.webhook;
    if (!webhook) {
      return reject(404, "NOT_FOUND", `Webhook not configured for workflow: ${workflowKey}`, "not_configured");
    }

    const secret = webhook.secret.trim();
    if (!secret) {
      return reject(500, "SERVER_ERROR", "Webhook secret is not configured", "not_configured");
    }

    const signatureHeader = webhook.signatureHeader?.trim().toLowerCase() || "x-hub-signature-256";
    const signaturePrefix = webhook.signaturePrefix ?? "sha256=";
    const signalConfig = webhook.signal;
    const runConfig = webhook.run;
    const runEnabled = runConfig?.enabled !== false;
    if (!signalConfig?.name && !runEnabled) {
      return reject(
        400,
        "INVALID_REQUEST",
        "Webhook config must enable signal delivery or run creation",
        "misconfigured",
      );
    }

    try {
      const rawBody = await readRawBody(req, this.maxBodyBytes);
      const providedSignature = headerValue(req, signatureHeader);
      const expectedSignature = computeWebhookSignature(rawBody, secret, signaturePrefix);
      if (!isValidWebhookSignature(expectedSignature, providedSignature)) {
        return reject(
          401,
          "UNAUTHORIZED",
          "Webhook signature verification failed",
          "invalid_signature",
        );
      }

      emitGatewayEffect(
        incrementMetric(gatewayWebhooksVerifiedTotal, {
          workflow: workflowKey,
        }),
      );

      const payload = parseJsonBuffer(rawBody, "Webhook payload");
      const adapter = this.adapterForWorkflow(entry.workflow);
      const explicitRunId = asWebhookString(readPathValue(payload, signalConfig?.runIdPath));
      const correlationId = normalizeCorrelationId(
        asWebhookString(readPathValue(payload, signalConfig?.correlationIdPath)) ?? null,
      );
      const signalPayload = readPathValue(payload, signalConfig?.payloadPath);
      const matchedRunIds = signalConfig?.name
        ? await this.findMatchingWebhookRuns(
            entry,
            signalConfig.name,
            correlationId,
            explicitRunId,
          )
        : [];

      const triggeredBy = webhookTriggerUserId(workflowKey);
      const auth: RunStartAuthContext = {
        triggeredBy,
        scopes: ["*"],
        role: "system",
      };
      const delivered: GatewayWebhookDelivery[] = [];

      for (const runId of matchedRunIds) {
        const signal = await signalRun(
          adapter,
          runId,
          signalConfig!.name,
          signalPayload,
          {
            correlationId,
            receivedBy: triggeredBy,
          },
        );
        delivered.push({
          runId,
          seq: signal.seq,
          signalName: signal.signalName,
          correlationId: signal.correlationId ?? null,
          receivedAtMs: signal.receivedAtMs,
        });
        await this.resumeRunIfNeeded(runId, workflowKey, adapter, auth);
      }

      const started =
        delivered.length === 0 && runEnabled
          ? await this.startRun(
              workflowKey,
              normalizeWebhookRunInput(readPathValue(payload, runConfig?.inputPath)),
              auth,
            )
          : null;

      emitGatewayLog(
        "info",
        "Gateway webhook processed",
        {
          workflow: workflowKey,
          requestId,
          matchedRunCount: matchedRunIds.length,
          deliveredCount: delivered.length,
          ...(started ? { startedRunId: started.runId } : {}),
        },
        "gateway:webhook",
      );

      return respond(200, {
        ok: true,
        workflow: workflowKey,
        verified: true,
        delivered,
        matchedRunIds,
        started,
      });
    } catch (error: any) {
      if (isSmithersError(error)) {
        return reject(
          statusForRpcError(error.code),
          error.code,
          error.summary,
          "invalid_payload",
          error,
        );
      }
      return reject(
        500,
        "SERVER_ERROR",
        error?.message ?? "Gateway webhook failed",
        "server_error",
        error,
      );
    }
  }

  register(
    key: string,
    workflow: SmithersWorkflow<any>,
    options?: { schedule?: string; webhook?: GatewayWebhookConfig },
  ) {
    ensureSmithersTables(workflow.db as any);
    this.workflows.set(key, {
      key,
      workflow,
      schedule: options?.schedule,
      webhook: options?.webhook,
    });
    return this;
  }

  async listen(options: { port?: number } = {}) {
    if (this.server) {
      return this.server;
    }

    const wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: this.maxPayload,
    });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const webhookMatch = url.pathname.match(/^\/webhooks\/([^/]+)$/);
      if ((req.method ?? "GET") === "GET" && (req.url ?? "/") === "/health") {
        return sendJson(res, 200, {
          ok: true,
          protocol: this.protocol,
          features: this.features,
          stateVersion: this.stateVersion,
        });
      }
      if ((req.method ?? "GET") === "GET" && (req.url ?? "/") === "/metrics") {
        return sendText(
          res,
          200,
          renderPrometheusMetrics(),
          prometheusContentType,
        );
      }
      if ((req.method ?? "GET") === "POST" && webhookMatch) {
        return this.handleWebhook(req, res, decodeURIComponent(webhookMatch[1]!));
      }
      if ((req.method ?? "GET") === "POST" && (req.url ?? "/") === "/rpc") {
        return this.handleHttpRpc(req, res);
      }
      return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    });

    server.on("upgrade", (req, socket, head) => {
      if (this.connections.size >= this.maxConnections) {
        emitGatewayEffect(
          incrementMetric(gatewayErrorsTotal, {
            kind: "connection_limit",
            transport: "ws",
          }),
        );
        emitGatewayLog(
          "warning",
          "Gateway connection rejected",
          {
            transport: "ws",
            remoteAddress: req.socket.remoteAddress ?? null,
            maxConnections: this.maxConnections,
          },
          "gateway:connect",
        );
        const body = "Gateway connection limit reached\n";
        socket.write(
          "HTTP/1.1 503 Service Unavailable\r\n"
            + "Connection: close\r\n"
            + "Content-Type: text/plain; charset=utf-8\r\n"
            + `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n`
            + "\r\n"
            + body,
        );
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        this.handleSocket(ws, req);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(options.port ?? 7331, () => resolve());
    });

    this.server = server;
    this.wsServer = wsServer;
    await this.syncRegisteredSchedules();
    this.startScheduler();
    return server;
  }

  async close() {
    const activeRuns = [...this.activeRuns.values()];
    for (const activeRun of activeRuns) {
      activeRun.abort.abort();
    }
    const inflightRuns = [...this.inflightRuns.values()];
    if (inflightRuns.length > 0) {
      await Promise.allSettled(inflightRuns);
    }
    for (const connection of this.connections) {
      if (connection.heartbeatTimer) {
        clearInterval(connection.heartbeatTimer);
      }
      try {
        connection.ws.close();
      } catch {}
    }
    this.connections.clear();
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private startScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
    }
    const intervalMs = Math.max(1_000, Math.min(this.heartbeatMs, 15_000));
    this.schedulerTimer = setInterval(() => {
      void this.processDueCrons();
    }, intervalMs);
  }

  private async syncRegisteredSchedules() {
    for (const entry of this.workflows.values()) {
      if (!entry.schedule) {
        continue;
      }
      const adapter = this.adapterForWorkflow(entry.workflow);
      await adapter.upsertCron({
        cronId: `gateway:${entry.key}`,
        pattern: entry.schedule,
        workflowPath: cronWorkflowPath(entry.key),
        enabled: true,
        createdAtMs: nowMs(),
        lastRunAtMs: null,
        nextRunAtMs: nextCronRunAtMs(entry.schedule),
        errorJson: null,
      });
    }
  }

  private async processDueCrons() {
    const now = nowMs();
    emitGatewayLog(
      "debug",
      "Gateway cron evaluation tick",
      {
        workflowCount: this.workflows.size,
      },
      "gateway:cron",
    );
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      const crons = await adapter.listCrons(true);
      for (const cron of crons as any[]) {
        const workflowKey = workflowKeyFromCronPath(cron.workflowPath);
        if (!workflowKey || workflowKey !== entry.key) {
          continue;
        }
        if (typeof cron.nextRunAtMs === "number" && cron.nextRunAtMs > now) {
          emitGatewayLog(
            "debug",
            "Gateway cron skipped",
            {
              cronId: cron.cronId,
              workflow: workflowKey,
              nextRunAtMs: cron.nextRunAtMs,
            },
            "gateway:cron",
          );
          continue;
        }
        try {
          const run = await this.startRun(workflowKey, {}, {
            triggeredBy: "cron:gateway",
            scopes: ["*"],
            role: "system",
          });
          await adapter.updateCronRunTime(
            cron.cronId,
            now,
            nextCronRunAtMs(cron.pattern),
            null,
          );
          emitGatewayEffect(
            incrementMetric(gatewayCronTriggersTotal, {
              source: "scheduled",
            }),
          );
          emitGatewayLog(
            "info",
            "Gateway cron triggered",
            {
              cronId: cron.cronId,
              workflow: workflowKey,
              runId: run.runId,
            },
            "gateway:cron",
          );
          this.broadcastEvent("cron.triggered", {
            cronId: cron.cronId,
            workflow: workflowKey,
            runId: run.runId,
          });
        } catch (error: any) {
          emitGatewayEffect(
            incrementMetric(gatewayErrorsTotal, {
              kind: "cron",
              code: gatewayErrorCode(error),
            }),
          );
          emitGatewayLog(
            "error",
            "Gateway cron trigger failed",
            {
              cronId: cron.cronId,
              workflow: workflowKey,
              ...gatewayErrorAnnotations(error),
            },
            "gateway:cron",
          );
          await adapter.updateCronRunTime(
            cron.cronId,
            now,
            cron.nextRunAtMs ?? now + 60_000,
            error?.message ?? "cron trigger failed",
          );
        }
      }
    }
  }

  private async startRun(
    workflowKey: string,
    input: Record<string, unknown>,
    auth: RunStartAuthContext,
    runId = newRunId(),
    options?: { resume?: boolean },
  ) {
    const entry = this.workflows.get(workflowKey);
    if (!entry) {
      throw new Error(`Unknown workflow: ${workflowKey}`);
    }
    const abort = new AbortController();
    const record: ActiveRunRecord = {
      workflowKey,
      workflow: entry.workflow,
      abort,
      input,
    };
    this.runRegistry.set(runId, record);
    this.activeRuns.set(runId, record);
    emitGatewayEffect(
      Effect.all([
        incrementMetric(gatewayRunsStartedTotal, {
          workflow: workflowKey,
          source: gatewayTriggerSource(auth.triggeredBy),
          resume: options?.resume ? "true" : "false",
        }),
        Effect.logInfo("Gateway run started").pipe(
          Effect.annotateLogs({
            workflow: workflowKey,
            runId,
            triggeredBy: auth.triggeredBy,
            source: gatewayTriggerSource(auth.triggeredBy),
            resume: options?.resume ?? false,
            ...(auth.subscribeConnection
              ? gatewayContextAnnotations(auth.subscribeConnection)
              : {}),
          }),
          Effect.withLogSpan("gateway:run"),
        ),
      ], { discard: true }),
    );
    if (auth.subscribeConnection) {
      if (!auth.subscribeConnection.subscribedRuns) {
        auth.subscribeConnection.subscribedRuns = new Set();
      }
      auth.subscribeConnection.subscribedRuns.add(runId);
    }

    const runPromise = runWorkflow(entry.workflow, {
      runId,
      input,
      resume: options?.resume,
      signal: abort.signal,
      onProgress: (event: SmithersEvent) => this.handleSmithersEvent(event),
      cliAgentToolsDefault: this.defaults?.cliAgentTools,
      config: {
        gatewayWorkflowKey: workflowKey,
        gatewayTriggeredBy: auth.triggeredBy,
      },
      auth: {
        triggeredBy: auth.triggeredBy,
        scopes: [...auth.scopes],
        role: auth.role,
        createdAt: new Date().toISOString(),
      },
    } as any)
      .catch((error) => {
        emitGatewayEffect(
          Effect.all([
            incrementMetric(gatewayErrorsTotal, {
              kind: "run",
              workflow: workflowKey,
              code: gatewayErrorCode(error),
            }),
            incrementMetric(gatewayRunsCompletedTotal, {
              workflow: workflowKey,
              status: "failed",
            }),
            Effect.logError("Gateway run failed").pipe(
              Effect.annotateLogs({
                workflow: workflowKey,
                runId,
                source: gatewayTriggerSource(auth.triggeredBy),
                ...gatewayErrorAnnotations(error),
              }),
              Effect.withLogSpan("gateway:run"),
            ),
          ], { discard: true }),
        );
        this.broadcastEvent("run.completed", {
          runId,
          status: "failed",
          error: errorToJson(error),
        });
        throw error;
      })
      .then((result) => {
        if (result.status === "finished" || result.status === "failed" || result.status === "cancelled") {
          emitGatewayEffect(
            Effect.all([
              incrementMetric(gatewayRunsCompletedTotal, {
                workflow: workflowKey,
                status: result.status,
              }),
              Effect.logInfo("Gateway run completed").pipe(
                Effect.annotateLogs({
                  workflow: workflowKey,
                  runId,
                  status: result.status,
                  source: gatewayTriggerSource(auth.triggeredBy),
                  ...(result.error ? { error: result.error } : {}),
                }),
                Effect.withLogSpan("gateway:run"),
              ),
            ], { discard: true }),
          );
          this.broadcastEvent("run.completed", {
            runId,
            status: result.status,
            error: result.error,
          });
        }
      })
      .finally(() => {
        this.activeRuns.delete(runId);
        this.inflightRuns.delete(runId);
      });
    this.inflightRuns.set(
      runId,
      runPromise.then(() => undefined, () => undefined),
    );

    return { runId, workflow: workflowKey };
  }

  private async resumeRunIfNeeded(
    runId: string,
    workflowKey: string,
    adapter: SmithersDb,
    auth: RunStartAuthContext,
  ) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.activeRuns.has(runId)) {
        await delay(25);
        continue;
      }
      const run = await adapter.getRun(runId);
      if (!run) {
        return;
      }
      if (run.status === "finished" || run.status === "failed" || run.status === "cancelled") {
        return;
      }
      await this.startRun(workflowKey, {}, auth, runId, { resume: true });
      return;
    }
  }

  private handleSocket(ws: WebSocket, req: IncomingMessage) {
    const connection: ConnectionState = {
      connectionId: randomUUID(),
      transport: "ws",
      ws,
      seq: 0,
      authenticated: false,
      sessionToken: null,
      role: null,
      scopes: [],
      userId: null,
      subscribedRuns: null,
      heartbeatTimer: null,
    };
    this.connections.add(connection);
    emitGatewayEffect(
      Effect.all([
        incrementMetric(gatewayConnectionsTotal, { transport: "ws" }),
        updateMetric(gatewayConnectionsActive, 1, { transport: "ws" }),
      ], { discard: true }),
    );
    emitGatewayLog(
      "info",
      "Gateway connection opened",
      {
        ...gatewayContextAnnotations(connection),
        remoteAddress: req.socket.remoteAddress ?? null,
        activeConnections: this.connections.size,
      },
      "gateway:connect",
    );
    this.sendEvent(connection, "connect.challenge", {
      nonce: randomUUID(),
      ts: nowMs(),
    });

    ws.on("message", async (raw) => {
      this.recordMessageReceived("ws", "request");
      try {
        const frame = parseGatewayRequestFrame(raw, this.maxPayload);
        const response = await this.executeRpc(connection, frame, async () => {
          if (!connection.authenticated && frame.method !== "connect") {
            return responseError(frame.id, "UNAUTHORIZED", "Connect first");
          }

          if (frame.method === "connect") {
            return this.handleConnect(connection, req, frame.id, frame.params);
          }

          if (!hasScope(connection.scopes, frame.method)) {
            return responseError(frame.id, "FORBIDDEN", `Missing scope for ${frame.method}`);
          }

          return this.routeRequest(connection, frame);
        });
        this.sendResponse(connection, response);
      } catch (error: any) {
        emitGatewayEffect(
          incrementMetric(gatewayErrorsTotal, {
            kind: "frame",
            transport: "ws",
            code: gatewayErrorCode(error),
          }),
        );
        emitGatewayLog(
          isSmithersError(error) ? "warning" : "error",
          "Gateway websocket frame failed",
          {
            ...gatewayContextAnnotations(connection),
            ...gatewayErrorAnnotations(error),
          },
          "gateway:rpc:invalid",
        );
        if (isSmithersError(error)) {
          this.sendResponse(
            connection,
            responseError("invalid", error.code, error.summary),
          );
          return;
        }
        this.sendResponse(
          connection,
          responseError("server", "SERVER_ERROR", error?.message ?? "Gateway request failed"),
        );
      }
    });

    let cleanedUp = false;
    const cleanup = (reason: "close" | "error", details: Record<string, unknown> = {}) => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      if (connection.heartbeatTimer) {
        clearInterval(connection.heartbeatTimer);
      }
      this.connections.delete(connection);
      emitGatewayEffect(
        Effect.all([
          updateMetric(gatewayConnectionsActive, -1, { transport: "ws" }),
          incrementMetric(gatewayConnectionsClosedTotal, {
            transport: "ws",
            reason,
          }),
          ...(reason === "error"
            ? [
                incrementMetric(gatewayErrorsTotal, {
                  kind: "socket",
                  transport: "ws",
                }),
              ]
            : []),
        ], { discard: true }),
      );
      emitGatewayLog(
        reason === "error" ? "warning" : "info",
        "Gateway connection closed",
        {
          ...gatewayContextAnnotations(connection),
          activeConnections: this.connections.size,
          closeReason: reason,
          ...details,
        },
        "gateway:connect",
      );
    };

    ws.on("close", (code, reason) => {
      cleanup("close", {
        closeCode: code,
        closeMessage: rawDataToUtf8(reason),
      });
    });
    ws.on("error", (error) => {
      cleanup("error", gatewayErrorAnnotations(error));
    });
  }

  private startHeartbeat(connection: ConnectionState) {
    if (connection.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer);
    }
    connection.heartbeatTimer = setInterval(() => {
      emitGatewayEffect(incrementMetric(gatewayHeartbeatTicksTotal));
      this.sendEvent(connection, "tick", {
        ts: nowMs(),
      });
    }, this.heartbeatMs);
  }

  private async handleConnect(
    connection: ConnectionState,
    req: IncomingMessage,
    id: string,
    params: unknown,
  ): Promise<ResponseFrame> {
    const request = asObject(params) as ConnectRequest | null;
    if (!request) {
      return responseError(id, "INVALID_REQUEST", "Connect params must be an object");
    }
    if (
      typeof request.minProtocol !== "number" ||
      typeof request.maxProtocol !== "number" ||
      !request.client
    ) {
      return responseError(id, "INVALID_REQUEST", "Connect request is missing protocol negotiation fields");
    }
    try {
      assertPositiveFiniteInteger("minProtocol", request.minProtocol);
      assertPositiveFiniteInteger("maxProtocol", request.maxProtocol);
    } catch (error) {
      if (error instanceof SmithersError) {
        return responseError(id, error.code, error.summary);
      }
      throw error;
    }
    if (request.minProtocol > this.protocol || request.maxProtocol < this.protocol) {
      return responseError(id, "PROTOCOL_UNSUPPORTED", `Gateway protocol ${this.protocol} is not supported by the client`);
    }

    const authResult = await this.authenticate(req, request);
    if (authResult.ok === false) {
      this.recordAuthEvent(
        "ws",
        "failure",
        connection,
        {
          clientId: request.client.id,
          clientVersion: request.client.version,
          authCode: authResult.code,
          authMessage: authResult.message,
        },
      );
      return responseError(id, authResult.code, authResult.message);
    }

    connection.authenticated = true;
    connection.sessionToken = randomUUID();
    connection.role = authResult.role;
    connection.scopes = [...authResult.scopes];
    connection.userId = authResult.userId ?? null;
    connection.subscribedRuns = Array.isArray(request.subscribe)
      ? new Set(request.subscribe.filter((value): value is string => typeof value === "string"))
      : null;
    this.startHeartbeat(connection);
    this.recordAuthEvent(
      "ws",
      "success",
      connection,
      {
        clientId: request.client.id,
        clientVersion: request.client.version,
        scopeCount: connection.scopes.length,
      },
    );

    const hello: HelloResponse = {
      protocol: this.protocol,
      features: this.features,
      policy: { heartbeatMs: this.heartbeatMs },
      auth: {
        sessionToken: connection.sessionToken,
        role: authResult.role,
        scopes: authResult.scopes,
        userId: authResult.userId ?? null,
      },
      snapshot: await this.buildSnapshot(),
    };
    return responseOk(id, hello);
  }

  private async authenticate(req: IncomingMessage, request: ConnectRequest):
    Promise<
      | { ok: true; role: string; scopes: string[]; userId?: string }
      | { ok: false; code: string; message: string }
    > {
    const tokenFromRequest = "token" in (request.auth ?? {}) ? (request.auth as any).token : null;
    return this.authenticateRequest(req, typeof tokenFromRequest === "string" ? tokenFromRequest : null);
  }

  private async authenticateRequest(
    req: IncomingMessage,
    token: string | null,
  ): Promise<
      | { ok: true; role: string; scopes: string[]; userId?: string }
      | { ok: false; code: string; message: string }
    > {
    if (!this.auth) {
      return {
        ok: true,
        role: "operator",
        scopes: ["*"],
      };
    }

    if (this.auth.mode === "token") {
      if (!token || typeof token !== "string") {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "A bearer token is required",
        };
      }
      const grant = this.auth.tokens[token];
      if (!grant) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "Invalid token",
        };
      }
      return {
        ok: true,
        role: grant.role,
        scopes: grant.scopes,
        userId: grant.userId,
      };
    }

    if (this.auth.mode === "jwt") {
      if (!token || typeof token !== "string") {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "A bearer token is required",
        };
      }
      const verified = verifyJwtToken(token, this.auth);
      if (verified.ok === false) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: verified.message,
        };
      }
      const scopes = parseJwtScopes(
        verified.payload[this.auth.scopesClaim ?? "scope"],
      );
      const role =
        asString(verified.payload[this.auth.roleClaim ?? "role"]) ??
        this.auth.defaultRole ??
        "operator";
      const userId = asString(verified.payload[this.auth.userClaim ?? "sub"]);
      return {
        ok: true,
        role,
        scopes: scopes.length > 0 ? scopes : [...(this.auth.defaultScopes ?? [])],
        userId: userId ?? undefined,
      };
    }

    if (this.auth.mode === "trusted-proxy") {
      const allowedOrigins = this.auth.allowedOrigins ?? [];
      const origin = asString(req.headers.origin);
      if (allowedOrigins.length > 0 && (!origin || !allowedOrigins.includes(origin))) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "Origin is not allowed",
        };
      }

      const [userHeader = "x-user-id", scopesHeader = "x-user-scopes", roleHeader = "x-user-role"] =
        (this.auth.trustedHeaders ?? []).map((value) => value.toLowerCase());
      const userId = asString(req.headers[userHeader]);
      const scopesValue = asString(req.headers[scopesHeader]);
      const role = asString(req.headers[roleHeader]) ?? this.auth.defaultRole ?? "operator";
      const scopes = scopesValue
        ? scopesValue.split(/[,\s]+/).map((value) => value.trim()).filter(Boolean)
        : [...(this.auth.defaultScopes ?? ["*"])];
      return {
        ok: true,
        role,
        scopes,
        userId: userId ?? undefined,
      };
    }

    return {
      ok: false,
      code: "UNAUTHORIZED",
      message: "Unsupported auth mode",
    };
  }

  private async handleHttpRpc(req: IncomingMessage, res: ServerResponse) {
    const requestId = headerValue(req, "x-request-id") ?? randomUUID();
    const baseContext: GatewayRequestContext = {
      connectionId: `http:${requestId}`,
      transport: "http",
      role: null,
      scopes: [],
      userId: null,
      subscribedRuns: null,
    };
    let context: GatewayRequestContext = baseContext;
    this.recordMessageReceived("http", "request");
    try {
      const authResult = await this.authenticateRequest(req, bearerTokenFromHeaders(req));
      if (authResult.ok === false) {
        emitGatewayEffect(
          incrementMetric(gatewayErrorsTotal, {
            kind: "auth",
            transport: "http",
            code: authResult.code,
          }),
        );
        this.recordAuthEvent(
          "http",
          "failure",
          context,
          {
            requestId,
            authCode: authResult.code,
            authMessage: authResult.message,
          },
          "warning",
        );
        const response = responseError(requestId, authResult.code, authResult.message);
        return this.sendHttpRpcResponse(
          res,
          statusForRpcError(authResult.code),
          response,
        );
      }
      context = {
        ...baseContext,
        role: authResult.role,
        scopes: [...authResult.scopes],
        userId: authResult.userId ?? null,
      };
      this.recordAuthEvent(
        "http",
        "success",
        context,
        {
          requestId,
          scopeCount: authResult.scopes.length,
        },
        "debug",
      );

      const body = asObject(await readBody(req, this.maxBodyBytes));
      if (!body) {
        emitGatewayEffect(
          incrementMetric(gatewayErrorsTotal, {
            kind: "http",
            transport: "http",
            code: "INVALID_REQUEST",
          }),
        );
        emitGatewayLog(
          "warning",
          "Gateway HTTP RPC rejected",
          {
            ...gatewayContextAnnotations(context),
            requestId,
            errorCode: "INVALID_REQUEST",
            errorMessage: "RPC body must be a JSON object",
          },
          "gateway:http-rpc",
        );
        return this.sendHttpRpcResponse(
          res,
          400,
          responseError(
            requestId,
            "INVALID_REQUEST",
            "RPC body must be a JSON object",
          ),
        );
      }
      assertJsonPayloadWithinBounds("gateway frame", body, {
        maxArrayLength: GATEWAY_RPC_MAX_ARRAY_LENGTH,
        maxDepth: GATEWAY_RPC_MAX_DEPTH,
        maxStringLength: GATEWAY_RPC_MAX_STRING_LENGTH,
      });

      const method = validateGatewayMethodName(body.method);
      const bodyId = asString(body.id) ?? requestId;
      assertOptionalStringMaxLength("id", bodyId, GATEWAY_FRAME_ID_MAX_LENGTH);
      const frame: RequestFrame = {
        type: "req",
        id: bodyId,
        method,
        params: body.params,
      };
      const response = await this.executeRpc(context, frame, async () => {
        if (!hasScope(context.scopes, method)) {
          return responseError(bodyId, "FORBIDDEN", `Missing scope for ${method}`);
        }
        return this.routeRequest(context, frame);
      });

      return this.sendHttpRpcResponse(
        res,
        response.ok ? 200 : statusForRpcError(response.error?.code),
        response,
      );
    } catch (error: any) {
      emitGatewayEffect(
        incrementMetric(gatewayErrorsTotal, {
          kind: "http",
          transport: "http",
          code: gatewayErrorCode(error),
        }),
      );
      emitGatewayLog(
        isSmithersError(error) ? "warning" : "error",
        "Gateway HTTP RPC failed",
        {
          ...gatewayContextAnnotations(context),
          requestId,
          ...gatewayErrorAnnotations(error),
        },
        "gateway:http-rpc",
      );
      if (isSmithersError(error)) {
        return this.sendHttpRpcResponse(
          res,
          statusForRpcError(error.code),
          responseError(requestId, error.code, error.summary),
        );
      }
      const message = error?.message ?? "Gateway request failed";
      const status = message.includes("valid JSON") ? 400 : message.includes("exceeds") ? 413 : 500;
      return this.sendHttpRpcResponse(
        res,
        status,
        responseError(
          requestId,
          status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "INVALID_JSON" : "SERVER_ERROR",
          message,
        ),
      );
    }
  }

  private sendResponse(connection: ConnectionState, frame: ResponseFrame) {
    if (connection.ws.readyState !== connection.ws.OPEN) {
      return;
    }
    connection.ws.send(JSON.stringify(frame));
    this.recordMessageSent("ws", "response", {
      outcome: frame.ok ? "ok" : "error",
    });
  }

  private sendEvent(connection: ConnectionState, event: string, payload?: unknown, stateVersion = this.stateVersion) {
    if (connection.ws.readyState !== connection.ws.OPEN) {
      return;
    }
    connection.seq += 1;
    const frame: EventFrame = {
      type: "event",
      event,
      payload,
      seq: connection.seq,
      stateVersion,
    };
    connection.ws.send(JSON.stringify(frame));
    this.recordMessageSent("ws", "event", { event });
  }

  private broadcastEvent(event: string, payload?: unknown) {
    const runId = eventRunId(payload);
    this.stateVersion += 1;
    let recipientCount = 0;
    for (const connection of this.connections) {
      if (!connection.authenticated || !shouldDeliverEvent(connection, runId)) {
        continue;
      }
      recipientCount += 1;
      this.sendEvent(connection, event, payload, this.stateVersion);
    }
    emitGatewayLog(
      "debug",
      "Gateway event broadcast",
      {
        event,
        stateVersion: this.stateVersion,
        recipientCount,
        ...(runId ? { runId } : {}),
      },
      "gateway:broadcast",
    );
  }

  private async buildSnapshot() {
    const runs = await this.listRunsAcrossWorkflows(1_000);
    const approvals = await this.listPendingApprovals();
    return {
      runs: runs.filter((run) =>
        ["running", "waiting-approval", "waiting-event", "waiting-timer"].includes(run.status),
      ),
      approvals,
      stateVersion: this.stateVersion,
    };
  }

  private adapterForWorkflow(workflow: SmithersWorkflow<any>) {
    return new SmithersDb(workflow.db as any);
  }

  private async listRunsAcrossWorkflows(limit = 50, status?: string) {
    const results: any[] = [];
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      const rows = await adapter.listRuns(limit, status);
      for (const row of rows as any[]) {
        const config = parseJson<Record<string, unknown>>(row.configJson);
        results.push({
          ...row,
          workflowKey: asString(config?.gatewayWorkflowKey) ?? entry.key,
        });
      }
    }
    results.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
    return results.slice(0, limit);
  }

  private async listPendingApprovals() {
    const approvals: any[] = [];
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      const runs = await adapter.listRuns(1_000);
      for (const run of runs as any[]) {
        const pending = await adapter.listPendingApprovals(run.runId);
        const nodes = await adapter.listNodes(run.runId);
        const nodeByKey = new Map<string, any>();
        for (const node of nodes as any[]) {
          nodeByKey.set(`${node.nodeId}::${node.iteration ?? 0}`, node);
        }
        for (const approval of pending as any[]) {
          const node = nodeByKey.get(`${approval.nodeId}::${approval.iteration ?? 0}`);
          const request = parseApprovalRequest(
            parseJson<Record<string, unknown>>(approval.requestJson),
            node?.label ?? approval.nodeId,
          );
          approvals.push({
            runId: approval.runId,
            nodeId: approval.nodeId,
            iteration: approval.iteration ?? 0,
            requestTitle: request.title ?? node?.label ?? approval.nodeId,
            requestSummary: request.summary,
            requestedAtMs: approval.requestedAtMs ?? null,
            approvalMode: request.mode,
            options: request.options,
            allowedScopes: request.allowedScopes,
            allowedUsers: request.allowedUsers,
            autoApprove: request.autoApprove,
          });
        }
      }
    }
    approvals.sort((a, b) => (a.requestedAtMs ?? 0) - (b.requestedAtMs ?? 0));
    return approvals;
  }

  private async listCrons() {
    const rows: any[] = [];
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      const crons = await adapter.listCrons(false);
      for (const cron of crons as any[]) {
        const workflowKey = workflowKeyFromCronPath(cron.workflowPath) ?? entry.key;
        rows.push({
          ...cron,
          workflow: workflowKey,
        });
      }
    }
    rows.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
    return rows;
  }

  private async findCron(cronId: string) {
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      const crons = await adapter.listCrons(false);
      const match = (crons as any[]).find((cron) => cron.cronId === cronId);
      if (match) {
        return {
          cron: match,
          workflowKey: workflowKeyFromCronPath(match.workflowPath) ?? entry.key,
          adapter,
        };
      }
    }
    return null;
  }

  private async resolveRun(runId: string): Promise<ResolvedRun | null> {
    const active = this.runRegistry.get(runId);
    if (active) {
      return {
        workflowKey: active.workflowKey,
        workflow: active.workflow,
        adapter: this.adapterForWorkflow(active.workflow),
      };
    }

    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      const run = await adapter.getRun(runId);
      if (run) {
        return {
          workflowKey: entry.key,
          workflow: entry.workflow,
          adapter,
        };
      }
    }

    return null;
  }

  private handleSmithersEvent(event: SmithersEvent) {
    const mapped = this.mapEvent(event);
    if (!mapped) {
      return;
    }
    this.broadcastEvent(mapped.event, mapped.payload);
  }

  private mapEvent(event: SmithersEvent): { event: string; payload: unknown } | null {
    switch (event.type) {
      case "NodeStarted":
        return {
          event: "node.started",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "in-progress",
          },
        };
      case "NodeFinished":
        return {
          event: "node.finished",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "finished",
          },
        };
      case "NodeFailed":
        return {
          event: "node.failed",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            state: "failed",
            error: event.error,
          },
        };
      case "NodeOutput":
        return {
          event: "task.output",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            output: event.text,
            stream: event.stream,
          },
        };
      case "ApprovalRequested":
        return {
          event: "approval.requested",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
          },
        };
      case "ApprovalGranted":
        return {
          event: "approval.decided",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            approved: true,
          },
        };
      case "ApprovalAutoApproved":
        return {
          event: "approval.auto_approved",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
          },
        };
      case "ApprovalDenied":
        return {
          event: "approval.decided",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            approved: false,
          },
        };
      case "TaskHeartbeat":
        return {
          event: "task.heartbeat",
          payload: {
            runId: event.runId,
            nodeId: event.nodeId,
            iteration: event.iteration,
            attempt: event.attempt,
          },
        };
      case "RunFinished":
        return {
          event: "run.completed",
          payload: {
            runId: event.runId,
            status: "finished",
          },
        };
      case "RunFailed":
        return {
          event: "run.completed",
          payload: {
            runId: event.runId,
            status: "failed",
            error: event.error,
          },
        };
      case "RunCancelled":
        return {
          event: "run.completed",
          payload: {
            runId: event.runId,
            status: "cancelled",
          },
        };
      default:
        return null;
    }
  }

  private async routeRequest(connection: GatewayRequestContext, frame: RequestFrame): Promise<ResponseFrame> {
    const params = asObject(frame.params) ?? {};
    switch (frame.method) {
      case "health":
        return responseOk(frame.id, {
          protocol: this.protocol,
          features: this.features,
          stateVersion: this.stateVersion,
          uptimeMs: nowMs() - this.startedAtMs,
        });
      case "runs.list": {
        const limit = asOptionalPositiveInt(params.limit, "limit") ?? 50;
        const status = asString(params.status);
        return responseOk(frame.id, await this.listRunsAcrossWorkflows(limit, status));
      }
      case "runs.create": {
        const workflowKey = asString(params.workflow);
        if (!workflowKey) {
          return responseError(frame.id, "INVALID_REQUEST", "workflow is required");
        }
        if (!this.workflows.has(workflowKey)) {
          return responseError(frame.id, "NOT_FOUND", `Unknown workflow: ${workflowKey}`);
        }
        let input: Record<string, unknown>;
        try {
          input = validateGatewayRpcInput(params.input);
        } catch (error: any) {
          if (isSmithersError(error)) {
            return responseError(frame.id, error.code, error.summary);
          }
          throw error;
        }
        return responseOk(
          frame.id,
          await this.startRun(
            workflowKey,
            input,
            {
              triggeredBy: connection.userId ?? "gateway",
              scopes: [...connection.scopes],
              role: connection.role ?? "operator",
              subscribeConnection: connection,
            },
            asString(params.runId) ?? newRunId(),
            { resume: false },
          ),
        );
      }
      case "runs.get": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const run = await resolved.adapter.getRun(runId);
        if (!run) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const summary = await resolved.adapter.countNodesByState(runId);
        return responseOk(frame.id, {
          ...run,
          workflowKey: resolved.workflowKey,
          summary: summary.reduce((acc: Record<string, number>, row: any) => {
            acc[row.state] = row.count;
            return acc;
          }, {}),
        });
      }
      case "frames.list": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const limit = asOptionalPositiveInt(params.limit, "limit") ?? 50;
        const afterFrameNo = asOptionalPositiveInt(params.afterFrameNo, "afterFrameNo");
        return responseOk(frame.id, await resolved.adapter.listFrames(runId, limit, afterFrameNo));
      }
      case "frames.get": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const frameNo = asOptionalPositiveInt(params.frameNo, "frameNo");
        const frameRow = frameNo === undefined
          ? await resolved.adapter.getLastFrame(runId)
          : (await resolved.adapter.listFrames(runId, Math.max(frameNo + 1, 50))).find(
              (entry: any) => entry.frameNo === frameNo,
            );
        if (!frameRow) {
          return responseError(frame.id, "NOT_FOUND", "Frame not found");
        }
        return responseOk(frame.id, frameRow);
      }
      case "attempts.list": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const nodeId = asString(params.nodeId);
        if (nodeId) {
          const iteration = asNumber(params.iteration) ?? 0;
          return responseOk(frame.id, await resolved.adapter.listAttempts(runId, nodeId, iteration));
        }
        return responseOk(frame.id, await resolved.adapter.listAttemptsForRun(runId));
      }
      case "attempts.get": {
        const runId = asString(params.runId);
        const nodeId = asString(params.nodeId);
        const iteration = asNumber(params.iteration);
        const attempt = asNumber(params.attempt);
        if (!runId || !nodeId || iteration === undefined || attempt === undefined) {
          return responseError(frame.id, "INVALID_REQUEST", "runId, nodeId, iteration, and attempt are required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const row = await resolved.adapter.getAttempt(runId, nodeId, iteration, attempt);
        if (!row) {
          return responseError(frame.id, "NOT_FOUND", "Attempt not found");
        }
        return responseOk(frame.id, row);
      }
      case "runs.diff": {
        const leftRunId = asString(params.leftRunId);
        const rightRunId = asString(params.rightRunId);
        if (!leftRunId || !rightRunId) {
          return responseError(frame.id, "INVALID_REQUEST", "leftRunId and rightRunId are required");
        }
        const left = await this.resolveRun(leftRunId);
        const right = await this.resolveRun(rightRunId);
        if (!left || !right) {
          return responseError(frame.id, "NOT_FOUND", "Both runs must exist");
        }
        const leftSnapshot = await loadLatestSnapshot(left.adapter, leftRunId);
        const rightSnapshot = await loadLatestSnapshot(right.adapter, rightRunId);
        if (!leftSnapshot || !rightSnapshot) {
          return responseError(frame.id, "NOT_FOUND", "Snapshots not found for both runs");
        }
        return responseOk(frame.id, diffRawSnapshots(leftSnapshot, rightSnapshot));
      }
      case "approvals.list":
        return responseOk(frame.id, await this.listPendingApprovals());
      case "approvals.decide": {
        const runId = asString(params.runId);
        const nodeId = asString(params.nodeId);
        const approved = asBoolean(params.approved);
        const iteration = asNumber(params.iteration) ?? 0;
        if (!runId || !nodeId || approved === undefined) {
          return responseError(frame.id, "INVALID_REQUEST", "runId, nodeId, and approved are required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const approval = await resolved.adapter.getApproval(runId, nodeId, iteration);
        const request = parseApprovalRequest(
          parseJson<Record<string, unknown>>(
            typeof approval?.requestJson === "string" ? approval.requestJson : null,
          ),
          nodeId,
        );
        if (
          request.allowedUsers.length > 0 &&
          (!connection.userId || !request.allowedUsers.includes(connection.userId))
        ) {
          return responseError(frame.id, "FORBIDDEN", "User is not allowed to decide this approval");
        }
        if (
          request.allowedScopes.length > 0 &&
          !request.allowedScopes.some((scope) => hasScope(connection.scopes, scope))
        ) {
          return responseError(frame.id, "FORBIDDEN", "Connection is missing required approval scope");
        }
        const decision = params.decision;
        if (approved) {
          const validation = validateApprovalDecision(request, decision);
          if (!validation.ok) {
            return responseError(frame.id, validation.code, validation.message);
          }
        }
        if (approved) {
          await approveNode(
            resolved.adapter,
            runId,
            nodeId,
            iteration,
            asString(params.note),
            connection.userId ?? undefined,
            decision,
          );
        } else {
          await denyNode(
            resolved.adapter,
            runId,
            nodeId,
            iteration,
            asString(params.note),
            connection.userId ?? undefined,
            decision,
          );
        }
        await this.resumeRunIfNeeded(runId, resolved.workflowKey, resolved.adapter, {
          triggeredBy: connection.userId ?? "gateway",
          scopes: [...connection.scopes],
          role: connection.role ?? "operator",
          subscribeConnection: connection,
        });
        return responseOk(frame.id, { runId, nodeId, iteration, approved });
      }
      case "signals.send": {
        const runId = asString(params.runId);
        const signalName = asString(params.signalName);
        if (!runId || !signalName) {
          return responseError(frame.id, "INVALID_REQUEST", "runId and signalName are required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const delivered = await signalRun(
          resolved.adapter,
          runId,
          signalName,
          params.data ?? {},
          {
            correlationId: asString(params.correlationId),
            receivedBy: connection.userId,
          },
        );
        await this.resumeRunIfNeeded(runId, resolved.workflowKey, resolved.adapter, {
          triggeredBy: connection.userId ?? "gateway",
          scopes: [...connection.scopes],
          role: connection.role ?? "operator",
          subscribeConnection: connection,
        });
        return responseOk(frame.id, delivered);
      }
      case "runs.cancel": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const active = this.activeRuns.get(runId);
        if (!active) {
          return responseError(frame.id, "RUN_NOT_ACTIVE", "Run is not currently active");
        }
        active.abort.abort();
        return responseOk(frame.id, { runId, status: "cancelling" });
      }
      case "runs.rerun": {
        const runId = asString(params.runId);
        if (!runId) {
          return responseError(frame.id, "INVALID_REQUEST", "runId is required");
        }
        const resolved = await this.resolveRun(runId);
        if (!resolved) {
          return responseError(frame.id, "NOT_FOUND", `Run not found: ${runId}`);
        }
        const client = ((resolved.workflow.db as any).session?.client ?? (resolved.workflow.db as any).$client) as {
          query?: (sql: string) => { get: (...args: any[]) => any };
        } | null;
        const row = client?.query?.("SELECT payload FROM input WHERE run_id = ? LIMIT 1").get(runId) as {
          payload?: unknown;
        } | undefined;
        const input = typeof row?.payload === "string"
          ? parseJson<Record<string, unknown>>(row.payload) ?? {}
          : (row?.payload as Record<string, unknown> | undefined) ?? {};
        return this.routeRequest(connection, {
          type: "req",
          id: frame.id,
          method: "runs.create",
          params: {
            workflow: resolved.workflowKey,
            input,
            runId: asString(params.newRunId),
          },
        });
      }
      case "cron.list":
        return responseOk(frame.id, await this.listCrons());
      case "cron.add": {
        const workflowKey = asString(params.workflow);
        const pattern = asString(params.pattern);
        if (!workflowKey || !pattern) {
          return responseError(frame.id, "INVALID_REQUEST", "workflow and pattern are required");
        }
        const entry = this.workflows.get(workflowKey);
        if (!entry) {
          return responseError(frame.id, "NOT_FOUND", `Unknown workflow: ${workflowKey}`);
        }
        const cronId = asString(params.cronId) ?? randomUUID();
        const adapter = this.adapterForWorkflow(entry.workflow);
        const row = {
          cronId,
          pattern,
          workflowPath: cronWorkflowPath(workflowKey),
          enabled: asBoolean(params.enabled) ?? true,
          createdAtMs: nowMs(),
          lastRunAtMs: null,
          nextRunAtMs: nextCronRunAtMs(pattern),
          errorJson: null,
        };
        await adapter.upsertCron(row);
        return responseOk(frame.id, {
          ...row,
          workflow: workflowKey,
        });
      }
      case "cron.remove": {
        const cronId = asString(params.cronId);
        if (!cronId) {
          return responseError(frame.id, "INVALID_REQUEST", "cronId is required");
        }
        const resolvedCron = await this.findCron(cronId);
        if (!resolvedCron) {
          return responseError(frame.id, "NOT_FOUND", `Cron not found: ${cronId}`);
        }
        await resolvedCron.adapter.deleteCron(cronId);
        return responseOk(frame.id, { cronId, removed: true });
      }
      case "cron.trigger": {
        const cronId = asString(params.cronId);
        const workflowKey = asString(params.workflow);
        const resolvedCron = cronId ? await this.findCron(cronId) : null;
        const targetWorkflowKey = resolvedCron?.workflowKey ?? workflowKey;
        if (!targetWorkflowKey) {
          return responseError(frame.id, "INVALID_REQUEST", "cronId or workflow is required");
        }
        if (resolvedCron) {
          await resolvedCron.adapter.updateCronRunTime(
            resolvedCron.cron.cronId,
            nowMs(),
            nextCronRunAtMs(resolvedCron.cron.pattern),
            null,
          );
        }
        let input: Record<string, unknown>;
        try {
          input = validateGatewayRpcInput(params.input);
        } catch (error: any) {
          if (isSmithersError(error)) {
            return responseError(frame.id, error.code, error.summary);
          }
          throw error;
        }
        return responseOk(
          frame.id,
          await this.startRun(targetWorkflowKey, input, {
            triggeredBy: connection.userId ?? "gateway",
            scopes: [...connection.scopes],
            role: connection.role ?? "operator",
            subscribeConnection: connection,
          }, undefined, { resume: false }),
        );
      }
      default:
        return responseError(frame.id, "METHOD_NOT_FOUND", `Unknown method: ${frame.method}`);
    }
  }
}
