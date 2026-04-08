import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { WebSocketServer, type WebSocket } from "ws";
import { runWorkflow } from "../engine";
import { approveNode, denyNode } from "../engine/approvals";
import { signalRun } from "../engine/signals";
import type { SmithersWorkflow } from "../SmithersWorkflow";
import type { SmithersEvent } from "../SmithersEvent";
import { SmithersDb } from "../db/adapter";
import { ensureSmithersTables } from "../db/ensure";
import { nowMs } from "../utils/time";
import { newRunId } from "../utils/ids";
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
};

type RegisteredWorkflow = {
  key: string;
  workflow: SmithersWorkflow<any>;
  schedule?: string;
};

type ActiveRunRecord = {
  workflowKey: string;
  workflow: SmithersWorkflow<any>;
  abort: AbortController;
  input: Record<string, unknown>;
};

type ConnectionState = {
  ws: WebSocket;
  seq: number;
  authenticated: boolean;
  sessionToken: string | null;
  role: string | null;
  scopes: string[];
  userId: string | null;
  subscribedRuns: Set<string> | null;
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
  subscribeConnection?: ConnectionState | null;
};

type MethodAccess = "read" | "execute" | "approve" | "admin";

const DEFAULT_PROTOCOL = 1;
const DEFAULT_HEARTBEAT_MS = 15_000;

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
  res.end(JSON.stringify(payload));
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

function asStringRecord(value: unknown): Record<string, unknown> | null {
  return asObject(value);
}

function responseOk(id: string, payload?: unknown): ResponseFrame {
  return { type: "res", id, ok: true, payload };
}

function responseError(id: string, code: string, message: string): ResponseFrame {
  return { type: "res", id, ok: false, error: { code, message } };
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
  const actualSignature = Buffer.from(encodedSignature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);
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
  readonly auth?: GatewayAuthConfig;
  readonly defaults?: GatewayDefaults;

  private readonly workflows = new Map<string, RegisteredWorkflow>();
  private readonly connections = new Set<ConnectionState>();
  private readonly runRegistry = new Map<string, ActiveRunRecord>();
  private readonly activeRuns = new Map<string, ActiveRunRecord>();
  private server: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private schedulerTimer: Timer | null = null;
  private stateVersion = 0;
  private readonly startedAtMs = nowMs();

  constructor(options: GatewayOptions = {}) {
    this.protocol = options.protocol ?? DEFAULT_PROTOCOL;
    this.features = [...(options.features ?? ["streaming", "runs"])];
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.auth = options.auth;
    this.defaults = options.defaults;
  }

  register(key: string, workflow: SmithersWorkflow<any>, options?: { schedule?: string }) {
    ensureSmithersTables(workflow.db as any);
    this.workflows.set(key, {
      key,
      workflow,
      schedule: options?.schedule,
    });
    return this;
  }

  async listen(options: { port?: number } = {}) {
    if (this.server) {
      return this.server;
    }

    const wsServer = new WebSocketServer({ noServer: true });
    const server = createServer((req, res) => {
      if ((req.method ?? "GET") === "GET" && (req.url ?? "/") === "/health") {
        return sendJson(res, 200, {
          ok: true,
          protocol: this.protocol,
          features: this.features,
          stateVersion: this.stateVersion,
        });
      }
      return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    });

    server.on("upgrade", (req, socket, head) => {
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
    for (const entry of this.workflows.values()) {
      const adapter = this.adapterForWorkflow(entry.workflow);
      const crons = await adapter.listCrons(true);
      for (const cron of crons as any[]) {
        const workflowKey = workflowKeyFromCronPath(cron.workflowPath);
        if (!workflowKey || workflowKey !== entry.key) {
          continue;
        }
        if (typeof cron.nextRunAtMs === "number" && cron.nextRunAtMs > now) {
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
          this.broadcastEvent("cron.triggered", {
            cronId: cron.cronId,
            workflow: workflowKey,
            runId: run.runId,
          });
        } catch (error: any) {
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
    if (auth.subscribeConnection) {
      if (!auth.subscribeConnection.subscribedRuns) {
        auth.subscribeConnection.subscribedRuns = new Set();
      }
      auth.subscribeConnection.subscribedRuns.add(runId);
    }

    void runWorkflow(entry.workflow, {
      runId,
      input,
      resume: options?.resume,
      signal: abort.signal,
      onProgress: (event) => this.handleSmithersEvent(event),
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
      .then((result) => {
        if (result.status === "finished" || result.status === "failed" || result.status === "cancelled") {
          this.broadcastEvent("run.completed", {
            runId,
            status: result.status,
            error: result.error,
          });
        }
      })
      .finally(() => {
        this.activeRuns.delete(runId);
      });

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
    this.sendEvent(connection, "connect.challenge", {
      nonce: randomUUID(),
      ts: nowMs(),
    });

    ws.on("message", async (raw) => {
      try {
        const frame = JSON.parse(String(raw)) as RequestFrame;
        if (!frame || frame.type !== "req" || typeof frame.id !== "string" || typeof frame.method !== "string") {
          this.sendResponse(connection, responseError("invalid", "INVALID_FRAME", "Expected a request frame"));
          return;
        }

        if (!connection.authenticated && frame.method !== "connect") {
          this.sendResponse(connection, responseError(frame.id, "UNAUTHORIZED", "Connect first"));
          return;
        }

        if (frame.method === "connect") {
          const response = await this.handleConnect(connection, req, frame.id, frame.params);
          this.sendResponse(connection, response);
          return;
        }

        if (!hasScope(connection.scopes, frame.method)) {
          this.sendResponse(connection, responseError(frame.id, "FORBIDDEN", `Missing scope for ${frame.method}`));
          return;
        }

        const response = await this.routeRequest(connection, frame);
        this.sendResponse(connection, response);
      } catch (error: any) {
        this.sendResponse(
          connection,
          responseError("server", "SERVER_ERROR", error?.message ?? "Gateway request failed"),
        );
      }
    });

    const cleanup = () => {
      if (connection.heartbeatTimer) {
        clearInterval(connection.heartbeatTimer);
      }
      this.connections.delete(connection);
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  private startHeartbeat(connection: ConnectionState) {
    if (connection.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer);
    }
    connection.heartbeatTimer = setInterval(() => {
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
    if (request.minProtocol > this.protocol || request.maxProtocol < this.protocol) {
      return responseError(id, "PROTOCOL_UNSUPPORTED", `Gateway protocol ${this.protocol} is not supported by the client`);
    }

    const authResult = await this.authenticate(req, request);
    if (!authResult.ok) {
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
    if (!this.auth) {
      return {
        ok: true,
        role: "operator",
        scopes: ["*"],
      };
    }

    if (this.auth.mode === "token") {
      const token = "token" in (request.auth ?? {}) ? (request.auth as any).token : null;
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
      const token = "token" in (request.auth ?? {}) ? (request.auth as any).token : null;
      if (!token || typeof token !== "string") {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "A bearer token is required",
        };
      }
      const verified = verifyJwtToken(token, this.auth);
      if (!verified.ok) {
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

  private sendResponse(connection: ConnectionState, frame: ResponseFrame) {
    if (connection.ws.readyState !== connection.ws.OPEN) {
      return;
    }
    connection.ws.send(JSON.stringify(frame));
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
  }

  private broadcastEvent(event: string, payload?: unknown) {
    const runId = eventRunId(payload);
    this.stateVersion += 1;
    for (const connection of this.connections) {
      if (!connection.authenticated || !shouldDeliverEvent(connection, runId)) {
        continue;
      }
      this.sendEvent(connection, event, payload, this.stateVersion);
    }
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

  private async routeRequest(connection: ConnectionState, frame: RequestFrame): Promise<ResponseFrame> {
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
        const limit = asNumber(params.limit) ?? 50;
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
        const input = asObject(params.input) ?? {};
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
        const limit = asNumber(params.limit) ?? 50;
        const afterFrameNo = asNumber(params.afterFrameNo);
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
        const frameNo = asNumber(params.frameNo);
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
          parseJson<Record<string, unknown>>(approval?.requestJson),
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
        return responseOk(
          frame.id,
          await this.startRun(targetWorkflowKey, asObject(params.input) ?? {}, {
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
