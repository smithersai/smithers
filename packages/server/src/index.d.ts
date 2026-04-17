import * as node_http from 'node:http';
import { IncomingMessage as IncomingMessage$1, ServerResponse as ServerResponse$1 } from 'node:http';
import * as _smithers_observability_SmithersEvent from '@smithers/observability/SmithersEvent';
import * as _smithers_components_SmithersWorkflow from '@smithers/components/SmithersWorkflow';
import { SmithersWorkflow as SmithersWorkflow$1 } from '@smithers/components/SmithersWorkflow';
import { Effect } from 'effect';
import * as _smithers_db_adapter from '@smithers/db/adapter';
import { SmithersDb as SmithersDb$4 } from '@smithers/db/adapter';
import * as hono_types from 'hono/types';
import { Hono } from 'hono';
import * as effect_Fiber from 'effect/Fiber';
import * as _smithers_protocol_errors from '@smithers/protocol/errors';
import * as _smithers_devtools_snapshotSerializer from '@smithers/devtools/snapshotSerializer';
import * as _smithers_protocol_devtools from '@smithers/protocol/devtools';
import { selectOutputRow } from '@smithers/db/output';
import * as _smithers_time_travel_jumpToFrame from '@smithers/time-travel/jumpToFrame';
export { JumpToFrameError } from '@smithers/time-travel/jumpToFrame';

type ServerOptions$1 = {
    port?: number;
    db?: unknown;
    authToken?: string;
    maxBodyBytes?: number;
    rootDir?: string;
    allowNetwork?: boolean;
};

type ResponseFrame$1 = {
    type: "res";
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: {
        code: string;
        message: string;
    };
};

type RequestFrame$1 = {
    type: "req";
    id: string;
    method: string;
    params?: unknown;
};

type GatewayWebhookSignalConfig$1 = {
    name: string;
    correlationIdPath?: string;
    runIdPath?: string;
    payloadPath?: string;
};

type GatewayWebhookRunConfig$1 = {
    enabled?: boolean;
    inputPath?: string;
};

type GatewayWebhookConfig$1 = {
    secret: string;
    signatureHeader?: string;
    signaturePrefix?: string;
    signal?: GatewayWebhookSignalConfig$1;
    run?: GatewayWebhookRunConfig$1;
};

type GatewayTokenGrant$1 = {
    role: string;
    scopes: string[];
    userId?: string;
};

type GatewayAuthConfig$1 = {
    mode: "token";
    tokens: Record<string, GatewayTokenGrant$1>;
} | {
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
} | {
    mode: "trusted-proxy";
    trustedHeaders?: string[];
    allowedOrigins?: string[];
    defaultRole?: string;
    defaultScopes?: string[];
};

type GatewayDefaults$1 = {
    cliAgentTools?: "all" | "explicit-only";
};

type GatewayOptions$1 = {
    protocol?: number;
    features?: string[];
    heartbeatMs?: number;
    auth?: GatewayAuthConfig$1;
    defaults?: GatewayDefaults$1;
    maxBodyBytes?: number;
    maxPayload?: number;
    maxConnections?: number;
};

type ConnectRequest$1 = {
    minProtocol: number;
    maxProtocol: number;
    client: {
        id: string;
        version: string;
        platform: string;
    };
    auth?: {
        token: string;
    } | {
        password: string;
    };
    subscribe?: string[];
};

type HelloResponse$1 = {
    protocol: number;
    features: string[];
    policy: {
        heartbeatMs: number;
    };
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

type EventFrame$1 = {
    type: "event";
    event: string;
    payload?: unknown;
    seq: number;
    stateVersion: number;
};

/**
 * @param {unknown} method
 * @returns {string}
 */
declare function validateGatewayMethodName(method: unknown): string;
/**
 * @param {unknown} raw
 * @returns {RequestFrame}
 */
declare function parseGatewayRequestFrame(raw: unknown, maxPayloadBytes?: number): RequestFrame;
/**
 * @param {unknown} value
 * @returns {number}
 */
declare function getGatewayInputDepth(value: unknown): number;
/**
 * @param {unknown} value
 * @returns {number}
 */
declare function assertGatewayInputDepthWithinBounds(value: unknown, maxDepth?: number): number;
/**
 * @param {string | undefined} code
 */
declare function statusForRpcError(code: string | undefined): 401 | 403 | 404 | 400 | 409 | 413 | 429 | 501 | 500;
declare const GATEWAY_RPC_MAX_PAYLOAD_BYTES: 1048576;
declare const GATEWAY_RPC_MAX_DEPTH: 32;
declare const GATEWAY_RPC_MAX_ARRAY_LENGTH: 256;
declare const GATEWAY_RPC_MAX_STRING_LENGTH: number;
declare const GATEWAY_METHOD_NAME_MAX_LENGTH: 64;
declare const GATEWAY_FRAME_ID_MAX_LENGTH: 128;
declare const GATEWAY_RPC_INPUT_MAX_BYTES: 1048576;
declare const GATEWAY_RPC_INPUT_MAX_DEPTH: 32;
declare class Gateway {
    /**
   * @param {GatewayOptions} [options]
   */
    constructor(options?: GatewayOptions);
    protocol: number;
    features: string[];
    heartbeatMs: number;
    maxBodyBytes: number;
    maxPayload: number;
    maxConnections: number;
    auth: GatewayAuthConfig$1 | undefined;
    defaults: GatewayDefaults$1 | undefined;
    workflows: Map<any, any>;
    connections: Set<any>;
    runRegistry: Map<any, any>;
    activeRuns: Map<any, any>;
    inflightRuns: Map<any, any>;
    devtoolsSubscribers: Map<any, any>;
    /** Absolute active subscriber count per runId (gauge source of truth). */
    devtoolsSubscriberCounts: Map<any, any>;
    /** Flagged subscriber IDs that should force a snapshot on their next emit. */
    devtoolsInvalidateFlags: Set<any>;
    server: null;
    wsServer: null;
    schedulerTimer: null;
    stateVersion: number;
    startedAtMs: number;
    authModeLabel(): string;
    /**
   * @param {string} [runId]
   * @returns {number}
   */
    getDevToolsSubscriberCount(runId?: string): number;
    /**
   * Record a single subscribe attempt outcome. Centralised so that invalid
   * runId, missing run, SeqOutOfRange, etc. still update
   * `smithers_devtools_subscribe_total{result="error"}`.
   *
   * @param {"ok" | "error"} result
   */
    recordDevToolsSubscribeAttempt(result: "ok" | "error"): void;
    /**
   * Push the absolute active-subscriber count to the Prometheus gauge. The
   * `runId` is hashed for bounded cardinality.
   *
   * @param {string} runId
   */
    publishDevToolsActiveSubscribersGauge(runId: string): void;
    /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {string} runId
   * @returns {AbortController}
   */
    registerDevToolsSubscriber(connection: ConnectionState, streamId: string, runId: string): AbortController;
    /**
   * @param {ConnectionState} connection
   * @param {string} streamId
   * @param {Record<string, unknown>} [details]
   */
    unregisterDevToolsSubscriber(connection: ConnectionState, streamId: string, details?: Record<string, unknown>): void;
    /**
   * Flag every active subscriber for `runId` to rebaseline on its next emit.
   * Called when the gateway observes `TimeTravelJumped` for that run.
   *
   * @param {string} runId
   */
    invalidateDevToolsSubscribersForRun(runId: string): void;
    /**
   * Authorize a devtools request against the connection's `subscribe` set.
   *
   * If the client provided a `subscribe` filter at `connect` time, the run
   * must be in that set before any DB lookup happens.
   *
   * @param {ConnectionState | null | undefined} connection
   * @param {string} runId
   * @returns {boolean}
   */
    isDevToolsRunAuthorized(connection: ConnectionState | null | undefined, runId: string): boolean;
    /**
   * @param {ConnectionState} connection
   */
    cleanupDevToolsSubscribers(connection: ConnectionState): void;
    /**
   * @param {GatewayTransport} transport
   * @param {string} frameType
   * @param {GatewayMetricLabels} [labels]
   */
    recordMessageReceived(transport: GatewayTransport, frameType: string, labels?: GatewayMetricLabels): void;
    /**
   * @param {GatewayTransport} transport
   * @param {string} frameType
   * @param {GatewayMetricLabels} [labels]
   */
    recordMessageSent(transport: GatewayTransport, frameType: string, labels?: GatewayMetricLabels): void;
    /**
   * @param {GatewayTransport} transport
   * @param {"success" | "failure"} outcome
   * @param {GatewayRequestContext} context
   * @param {Record<string, unknown>} [details]
   * @param {"debug" | "info" | "warning"} [level]
   */
    recordAuthEvent(transport: GatewayTransport, outcome: "success" | "failure", context: GatewayRequestContext, details?: Record<string, unknown>, level?: "debug" | "info" | "warning"): void;
    /**
   * @param {GatewayRequestContext} context
   * @param {RequestFrame} frame
   * @param {() => Promise<ResponseFrame>} handler
   * @returns {Promise<ResponseFrame>}
   */
    executeRpc(context: GatewayRequestContext, frame: RequestFrame, handler: () => Promise<ResponseFrame>): Promise<ResponseFrame>;
    /**
   * @param {GatewayRequestContext} context
   * @param {RequestFrame} frame
   * @param {ResponseFrame} response
   * @returns {Effect.Effect<void>}
   */
    rpcSuccessEffect(context: GatewayRequestContext, frame: RequestFrame, response: ResponseFrame): Effect.Effect<void>;
    /**
   * @param {ServerResponse} res
   * @param {number} status
   * @param {ResponseFrame} response
   */
    sendHttpRpcResponse(res: ServerResponse, status: number, response: ResponseFrame): void;
    /**
   * @param {SmithersDb} adapter
   * @param {string} runId
   * @param {string} signalName
   * @param {string | null} correlationId
   */
    runWaitsForSignal(adapter: SmithersDb$4, runId: string, signalName: string, correlationId: string | null): Promise<boolean>;
    /**
   * @param {RegisteredWorkflow} entry
   * @param {string} signalName
   * @param {string | null} correlationId
   * @param {string} [explicitRunId]
   */
    findMatchingWebhookRuns(entry: RegisteredWorkflow, signalName: string, correlationId: string | null, explicitRunId?: string): Promise<any[]>;
    /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} workflowKey
   */
    handleWebhook(req: IncomingMessage, res: ServerResponse, workflowKey: string): Promise<void>;
    /**
   * @param {string} key
   * @param {SmithersWorkflow<any>} workflow
   * @param {{ schedule?: string; webhook?: GatewayWebhookConfig }} [options]
   */
    register(key: string, workflow: SmithersWorkflow<any>, options?: {
        schedule?: string;
        webhook?: GatewayWebhookConfig;
    }): this;
    /**
   * @param {{ port?: number }} [options]
   */
    listen(options?: {
        port?: number;
    }): Promise<node_http.Server<typeof node_http.IncomingMessage, typeof node_http.ServerResponse>>;
    close(): Promise<void>;
    startScheduler(): void;
    syncRegisteredSchedules(): Promise<void>;
    processDueCrons(): Promise<void>;
    /**
   * @param {string} workflowKey
   * @param {Record<string, unknown>} input
   * @param {RunStartAuthContext} auth
   * @param {string} [runId]
   * @param {{ resume?: boolean }} [options]
   */
    startRun(workflowKey: string, input: Record<string, unknown>, auth: RunStartAuthContext, runId?: string, options?: {
        resume?: boolean;
    }): Promise<{
        runId: string;
        workflow: string;
    }>;
    /**
   * @param {string} runId
   * @param {string} workflowKey
   * @param {SmithersDb} adapter
   * @param {RunStartAuthContext} auth
   */
    resumeRunIfNeeded(runId: string, workflowKey: string, adapter: SmithersDb$4, auth: RunStartAuthContext): Promise<void>;
    /**
   * @param {WebSocket} ws
   * @param {IncomingMessage} req
   */
    handleSocket(ws: WebSocket, req: IncomingMessage): void;
    /**
   * @param {ConnectionState} connection
   */
    startHeartbeat(connection: ConnectionState): void;
    /**
   * @param {ConnectionState} connection
   * @param {IncomingMessage} req
   * @param {string} id
   * @param {unknown} params
   * @returns {Promise<ResponseFrame>}
   */
    handleConnect(connection: ConnectionState, req: IncomingMessage, id: string, params: unknown): Promise<ResponseFrame>;
    /**
   * @param {IncomingMessage} req
   * @param {ConnectRequest} request
   * @returns {Promise< | { ok: true; role: string; scopes: string[]; userId?: string } | { ok: false; code: string; message: string } >}
   */
    authenticate(req: IncomingMessage, request: ConnectRequest): Promise<{
        ok: true;
        role: string;
        scopes: string[];
        userId?: string;
    } | {
        ok: false;
        code: string;
        message: string;
    }>;
    /**
   * @param {IncomingMessage} req
   * @param {string | null} token
   * @returns {Promise< | { ok: true; role: string; scopes: string[]; userId?: string } | { ok: false; code: string; message: string } >}
   */
    authenticateRequest(req: IncomingMessage, token: string | null): Promise<{
        ok: true;
        role: string;
        scopes: string[];
        userId?: string;
    } | {
        ok: false;
        code: string;
        message: string;
    }>;
    /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
    handleHttpRpc(req: IncomingMessage, res: ServerResponse): Promise<void>;
    /**
   * @param {ConnectionState} connection
   * @param {ResponseFrame} frame
   */
    sendResponse(connection: ConnectionState, frame: ResponseFrame): void;
    /**
   * @param {ConnectionState} connection
   * @param {string} event
   * @param {unknown} [payload]
   */
    sendEvent(connection: ConnectionState, event: string, payload?: unknown, stateVersion?: number): void;
    /**
   * @param {string} event
   * @param {unknown} [payload]
   */
    broadcastEvent(event: string, payload?: unknown): void;
    buildSnapshot(): Promise<{
        runs: any[];
        approvals: {
            runId: any;
            nodeId: any;
            iteration: any;
            requestTitle: any;
            requestSummary: any;
            requestedAtMs: any;
            approvalMode: any;
            options: any;
            allowedScopes: any;
            allowedUsers: any;
            autoApprove: any;
        }[];
        stateVersion: number;
    }>;
    /**
   * @param {SmithersWorkflow<any>} workflow
   */
    adapterForWorkflow(workflow: SmithersWorkflow<any>): SmithersDb$4;
    /**
   * @param {string} [status]
   */
    listRunsAcrossWorkflows(limit?: number, status?: string): Promise<any[]>;
    listPendingApprovals(): Promise<{
        runId: any;
        nodeId: any;
        iteration: any;
        requestTitle: any;
        requestSummary: any;
        requestedAtMs: any;
        approvalMode: any;
        options: any;
        allowedScopes: any;
        allowedUsers: any;
        autoApprove: any;
    }[]>;
    listCrons(): Promise<any[]>;
    /**
   * @param {string} cronId
   */
    findCron(cronId: string): Promise<{
        cron: any;
        workflowKey: any;
        adapter: SmithersDb$4;
    } | null>;
    /**
   * @param {string} runId
   * @returns {Promise<ResolvedRun | null>}
   */
    resolveRun(runId: string): Promise<ResolvedRun | null>;
    /**
   * @param {SmithersEvent} event
   */
    handleSmithersEvent(event: SmithersEvent$1): void;
    /**
   * @param {SmithersEvent} event
   * @returns {{ event: string; payload: unknown } | null}
   */
    mapEvent(event: SmithersEvent$1): {
        event: string;
        payload: unknown;
    } | null;
    /**
   * @param {GatewayRequestContext} connection
   * @param {RequestFrame} frame
   * @returns {Promise<ResponseFrame>}
   */
    routeRequest(connection: GatewayRequestContext, frame: RequestFrame): Promise<ResponseFrame>;
}
type EventFrame = EventFrame$1;
type GatewayDefaults = GatewayDefaults$1;
type GatewayTokenGrant = GatewayTokenGrant$1;
type HelloResponse = HelloResponse$1;
type GatewayWebhookRunConfig = GatewayWebhookRunConfig$1;
type GatewayWebhookSignalConfig = GatewayWebhookSignalConfig$1;
type ConnectRequest = ConnectRequest$1;
type GatewayAuthConfig = GatewayAuthConfig$1;
type GatewayOptions = GatewayOptions$1;
type GatewayWebhookConfig = GatewayWebhookConfig$1;
type IncomingMessage = node_http.IncomingMessage;
type RequestFrame = RequestFrame$1;
type ResponseFrame = ResponseFrame$1;
type ServerResponse = node_http.ServerResponse;
type SmithersWorkflow = _smithers_components_SmithersWorkflow.SmithersWorkflow<any>;
type SmithersEvent$1 = _smithers_observability_SmithersEvent.SmithersEvent;
type GatewayMetricLabels = Record<string, string | number | null | undefined>;
type GatewayTransport = "ws" | "http";
type GatewayRequestContext = {
    connectionId?: string;
    role?: string;
    scopes?: string[];
    userId?: string | null;
    origin?: string;
    transport?: GatewayTransport;
};
type ConnectionState = {
    id: string;
    ws?: unknown;
    role: string;
    scopes: string[];
    userId: string | null;
    subscribe?: Set<string>;
    heartbeat?: unknown;
    lastActivity?: number;
    closed?: boolean;
} & Record<string, unknown>;
type RunStartAuthContext = {
    role: string;
    scopes: string[];
    userId?: string | null;
    connectionId?: string;
};
type RegisteredWorkflow = {
    workflow: SmithersWorkflow;
    adapter: SmithersDb$4;
    key: string;
    schedule?: string;
    webhook?: GatewayWebhookConfig;
};
type ResolvedRun = {
    runId: string;
    workflowKey: string;
    workflow: SmithersWorkflow;
    adapter: SmithersDb$4;
};

type ServeOptions$1 = {
    workflow: SmithersWorkflow$1<any>;
    adapter: SmithersDb$4;
    runId: string;
    abort: AbortController;
    authToken?: string;
    metrics?: boolean;
};

/**
 * @param {ServeOptions} opts
 */
declare function createServeApp(opts: ServeOptions): Hono<hono_types.BlankEnv, hono_types.BlankSchema, "/">;
type ServeOptions = ServeOptions$1;

/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 * @param {{ signal?: AbortSignal }} [options]
 */
declare function runPromise<A, E, R>(effect: Effect.Effect<A, E, R>, options?: {
    signal?: AbortSignal;
}): Promise<A>;
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
declare function runFork<A, E, R>(effect: Effect.Effect<A, E, R>): effect_Fiber.RuntimeFiber<A, E>;
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
declare function runSync<A, E, R>(effect: Effect.Effect<A, E, R>): A;

declare const NODE_OUTPUT_MAX_BYTES: number;

declare const NODE_OUTPUT_WARN_BYTES: 1048576;

/** @typedef {import("@smithers/protocol/errors").NodeOutputErrorCode} NodeOutputErrorCode */
declare class NodeOutputRouteError extends Error {
    /**
     * @param {NodeOutputErrorCode} code
     * @param {string} message
     */
    constructor(code: NodeOutputErrorCode, message: string);
    /** @type {NodeOutputErrorCode} */
    code: NodeOutputErrorCode;
}
type NodeOutputErrorCode = _smithers_protocol_errors.NodeOutputErrorCode;

/**
 * @returns {DevToolsNode}
 */
declare function emptyDevToolsRoot(): DevToolsNode;
/**
 * @param {string} runId
 * @returns {string}
 */
declare function validateRunId(runId: string): string;
/**
 * @param {unknown} frameNo
 * @param {number} latestFrameNo
 * @returns {number}
 */
declare function validateRequestedFrameNo(frameNo: unknown, latestFrameNo: number): number;
/**
 * @param {unknown} xml
 * @param {(warning: SnapshotSerializerWarning) => void} [onWarning]
 * @returns {DevToolsNode}
 */
declare function parseXmlToDevToolsRoot(xml: unknown, onWarning?: (warning: SnapshotSerializerWarning$1) => void): DevToolsNode;
/**
 * @param {{
 *   runId: string;
 *   frameNo: number;
 *   xmlJson: string;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 * }} input
 * @returns {DevToolsSnapshot}
 */
declare function snapshotFromFrameRow(input: {
    runId: string;
    frameNo: number;
    xmlJson: string;
    onWarning?: (warning: SnapshotSerializerWarning$1) => void;
}): DevToolsSnapshot;
/**
 * Validate a frameNo input before any DB or reconciler call so that oversized
 * or malformed numeric inputs never reach the adapter.
 *
 * @param {unknown} frameNo
 * @returns {void}
 */
declare function validateFrameNoInput(frameNo: unknown): void;
/**
 * Validate a fromSeq input before any DB or reconciler call.
 *
 * @param {unknown} fromSeq
 * @returns {void}
 */
declare function validateFromSeqInput(fromSeq: unknown): void;
/**
 * @param {{
 *   adapter: SmithersDb;
 *   runId: string;
 *   frameNo?: number;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 * }} input
 * @returns {Promise<DevToolsSnapshot>}
 */
declare function getDevToolsSnapshotRoute(input: {
    adapter: SmithersDb$3;
    runId: string;
    frameNo?: number;
    onWarning?: (warning: SnapshotSerializerWarning$1) => void;
}): Promise<DevToolsSnapshot>;
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers/protocol/devtools").DevToolsNode} DevToolsNode */
/** @typedef {import("@smithers/protocol/devtools").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("@smithers/protocol/devtools").DevToolsNodeType} DevToolsNodeType */
/** @typedef {import("@smithers/devtools/snapshotSerializer").SnapshotSerializerWarning} SnapshotSerializerWarning */
declare const DEVTOOLS_RUN_ID_PATTERN: RegExp;
declare const DEVTOOLS_MAX_FRAME_NO: 2147483647;
declare const DEVTOOLS_TREE_MAX_DEPTH: 256;
declare class DevToolsRouteError extends Error {
    /**
   * @param {string} code
   * @param {string} message
   * @param {string} [hint]
   */
    constructor(code: string, message: string, hint?: string);
    code: string;
    hint: string | undefined;
}
declare const DEVTOOLS_EMPTY_ROOT_ID: 0;
type SmithersDb$3 = _smithers_db_adapter.SmithersDb;
type DevToolsNode = _smithers_protocol_devtools.DevToolsNode;
type DevToolsSnapshot = _smithers_protocol_devtools.DevToolsSnapshot;
type DevToolsNodeType = _smithers_protocol_devtools.DevToolsNodeType;
type SnapshotSerializerWarning$1 = _smithers_devtools_snapshotSerializer.SnapshotSerializerWarning;

type DiffSummary$1 = {
    filesChanged: number;
    added: number;
    removed: number;
    files: Array<{
        path: string;
        added: number;
        removed: number;
    }>;
};

type GetNodeDiffRouteResult$1 = {
    ok: true;
    payload: any;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
    };
};

/**
 * @param {{
 *   runId: unknown;
 *   nodeId: unknown;
 *   iteration: unknown;
 *   resolveRun: (runId: string) => Promise<{ adapter: SmithersDb } | null>;
 *   emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
 *   computeDiffBundleImpl?: (baseRef: string, cwd: string, seq?: number) => Promise<any>;
 *   computeDiffBundleBetweenRefsImpl?: (baseRef: string, targetRef: string, cwd: string, seq?: number) => Promise<any>;
 *   getCurrentPointerImpl?: (cwd: string) => Promise<string | null>;
 *   resolveCommitPointerImpl?: (pointer: string, cwd: string) => Promise<string | null>;
 *   restorePointerImpl?: (pointer: string, cwd: string) => Promise<{ success: boolean; error?: string }>;
 *   nowMs?: () => number;
 *   stat?: boolean;
 * }} opts
 * @returns {Promise<GetNodeDiffRouteResult>}
 */
declare function getNodeDiffRoute({ runId: rawRunId, nodeId: rawNodeId, iteration: rawIteration, resolveRun, emitEffect, computeDiffBundleImpl, computeDiffBundleBetweenRefsImpl, getCurrentPointerImpl, resolveCommitPointerImpl, restorePointerImpl, nowMs, stat, }: {
    runId: unknown;
    nodeId: unknown;
    iteration: unknown;
    resolveRun: (runId: string) => Promise<{
        adapter: SmithersDb$2;
    } | null>;
    emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
    computeDiffBundleImpl?: (baseRef: string, cwd: string, seq?: number) => Promise<any>;
    computeDiffBundleBetweenRefsImpl?: (baseRef: string, targetRef: string, cwd: string, seq?: number) => Promise<any>;
    getCurrentPointerImpl?: (cwd: string) => Promise<string | null>;
    resolveCommitPointerImpl?: (pointer: string, cwd: string) => Promise<string | null>;
    restorePointerImpl?: (pointer: string, cwd: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    nowMs?: () => number;
    stat?: boolean;
}): Promise<GetNodeDiffRouteResult>;
type SmithersDb$2 = _smithers_db_adapter.SmithersDb;
type AttemptRow = _smithers_db_adapter.AttemptRow;
type GetNodeDiffRouteResult = GetNodeDiffRouteResult$1;
type DiffSummary = DiffSummary$1;

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers/db/adapter").AttemptRow} AttemptRow */
/** @typedef {import("./GetNodeDiffRouteResult.js").GetNodeDiffRouteResult} GetNodeDiffRouteResult */
/** @typedef {import("./DiffSummary.js").DiffSummary} DiffSummary */
declare const RUN_ID_PATTERN: RegExp;
declare const NODE_ID_PATTERN: RegExp;
declare const ITERATION_MAX: 2147483647;
/**
 * Compute a lightweight per-file / total summary of a DiffBundle without
 * retaining full patch text. Counts lines starting with "+"/"-" excluding
 * file headers ("+++"/"---").
 *
 * @param {{ patches?: Array<{ path: string; diff?: string }> }} bundle
 * @returns {DiffSummary}
 */
declare function summarizeBundle(bundle: {
    patches?: Array<{
        path: string;
        diff?: string;
    }>;
}): DiffSummary;

type NodeOutputResponse$1 = {
    status: "produced" | "pending" | "failed";
    row: Record<string, unknown> | null;
    schema: {
        fields: Array<{
            name: string;
            type: "string" | "number" | "boolean" | "object" | "array" | "null" | "unknown";
            optional: boolean;
            nullable: boolean;
            description?: string;
            enum?: readonly unknown[];
        }>;
    } | null;
    partial?: Record<string, unknown> | null;
};

/**
 * Resolve per-node output row plus schema hints for DevTools rendering.
 *
 * @param {{
 *   runId: unknown;
 *   nodeId: unknown;
 *   iteration: unknown;
 *   resolveRun: (runId: string) => Promise<{ workflow: any; adapter: any } | null>;
 *   selectOutputRowImpl?: typeof selectOutputRow;
 *   emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
 * }} params
 * @returns {Promise<NodeOutputResponse>}
 */
declare function getNodeOutputRoute(params: {
    runId: unknown;
    nodeId: unknown;
    iteration: unknown;
    resolveRun: (runId: string) => Promise<{
        workflow: any;
        adapter: any;
    } | null>;
    selectOutputRowImpl?: typeof selectOutputRow;
    emitEffect?: (effect: Effect.Effect<void>) => Promise<unknown>;
}): Promise<NodeOutputResponse>;
type NodeOutputResponse = NodeOutputResponse$1;

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("@smithers/time-travel/jumpToFrame").JumpResult} JumpResult */
/**
 * Gateway wrapper around time-travel jump orchestration.
 *
 * The gateway has no direct hook into the engine's in-memory reconciler
 * (reconciler state is DB-backed: frames, nodes, attempts). We wire real
 * capture/restore/rebuild functions that operate on the run's DB state so
 * that the transaction rollback path inside jumpToFrame has meaningful
 * inputs, and callers can plug in an in-memory reconciler if they have one.
 *
 * @param {{
 *   adapter: SmithersDb;
 *   runId: unknown;
 *   frameNo: unknown;
 *   confirm?: unknown;
 *   caller?: string;
 *   pauseRunLoop?: () => Promise<void> | void;
 *   resumeRunLoop?: () => Promise<void> | void;
 *   emitEvent?: (event: SmithersEvent) => Promise<void> | void;
 *   captureReconcilerState?: () => Promise<unknown> | unknown;
 *   restoreReconcilerState?: (snapshot: unknown) => Promise<void> | void;
 *   rebuildReconcilerState?: (xmlJson: string) => Promise<void> | void;
 *   onLog?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => Promise<void> | void;
 * }} input
 * @returns {Promise<JumpResult>}
 */
declare function jumpToFrameRoute(input: {
    adapter: SmithersDb$1;
    runId: unknown;
    frameNo: unknown;
    confirm?: unknown;
    caller?: string;
    pauseRunLoop?: () => Promise<void> | void;
    resumeRunLoop?: () => Promise<void> | void;
    emitEvent?: (event: SmithersEvent) => Promise<void> | void;
    captureReconcilerState?: () => Promise<unknown> | unknown;
    restoreReconcilerState?: (snapshot: unknown) => Promise<void> | void;
    rebuildReconcilerState?: (xmlJson: string) => Promise<void> | void;
    onLog?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => Promise<void> | void;
}): Promise<JumpResult>;

type SmithersDb$1 = _smithers_db_adapter.SmithersDb;
type SmithersEvent = _smithers_observability_SmithersEvent.SmithersEvent;
type JumpResult = _smithers_time_travel_jumpToFrame.JumpResult;

/**
 * @param {{
 *   adapter: SmithersDb;
 *   runId: string;
 *   fromSeq?: number;
 *   subscriberId?: string;
 *   pollIntervalMs?: number;
 *   maxBufferedEvents?: number;
 *   signal?: AbortSignal;
 *   invalidateSnapshot?: () => boolean;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 *   onLog?: (level: "debug" | "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
 *   onEvent?: (event: DevToolsEvent, stats: { bytes: number; durationMs: number; opCount?: number; frameNo?: number }) => void;
 *   onClose?: (summary: { eventsDelivered: number; durationMs: number; errorCode?: string }) => void;
 * }} input
 * @returns {AsyncIterable<DevToolsEvent>}
 */
declare function streamDevToolsRoute(input: {
    adapter: SmithersDb;
    runId: string;
    fromSeq?: number;
    subscriberId?: string;
    pollIntervalMs?: number;
    maxBufferedEvents?: number;
    signal?: AbortSignal;
    invalidateSnapshot?: () => boolean;
    onWarning?: (warning: SnapshotSerializerWarning) => void;
    onLog?: (level: "debug" | "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
    onEvent?: (event: DevToolsEvent, stats: {
        bytes: number;
        durationMs: number;
        opCount?: number;
        frameNo?: number;
    }) => void;
    onClose?: (summary: {
        eventsDelivered: number;
        durationMs: number;
        errorCode?: string;
    }) => void;
}): AsyncIterable<DevToolsEvent>;
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers/protocol/devtools").DevToolsEvent} DevToolsEvent */
/** @typedef {import("@smithers/protocol/devtools").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("@smithers/devtools/snapshotSerializer").SnapshotSerializerWarning} SnapshotSerializerWarning */
declare const DEVTOOLS_REBASELINE_INTERVAL: 50;
declare const DEVTOOLS_BACKPRESSURE_LIMIT: 1000;
declare const DEVTOOLS_POLL_INTERVAL_MS: 25;
type SmithersDb = _smithers_db_adapter.SmithersDb;
type DevToolsEvent = _smithers_protocol_devtools.DevToolsEvent;
type SnapshotSerializerWarning = _smithers_devtools_snapshotSerializer.SnapshotSerializerWarning;

/**
 * @param {ServerOptions} [opts]
 */
declare function startServerEffect(opts?: ServerOptions): Effect.Effect<node_http.Server<typeof IncomingMessage$1, typeof ServerResponse$1>, never, never>;
/**
 * @param {ServerOptions} [opts]
 */
declare function startServer(opts?: ServerOptions): node_http.Server<typeof IncomingMessage$1, typeof ServerResponse$1>;

type ServerOptions = ServerOptions$1;

export { type AttemptRow, type ConnectRequest, type ConnectionState, DEVTOOLS_BACKPRESSURE_LIMIT, DEVTOOLS_EMPTY_ROOT_ID, DEVTOOLS_MAX_FRAME_NO, DEVTOOLS_POLL_INTERVAL_MS, DEVTOOLS_REBASELINE_INTERVAL, DEVTOOLS_RUN_ID_PATTERN, DEVTOOLS_TREE_MAX_DEPTH, type DevToolsEvent, type DevToolsNode, type DevToolsNodeType, DevToolsRouteError, type DiffSummary, type EventFrame, GATEWAY_FRAME_ID_MAX_LENGTH, GATEWAY_METHOD_NAME_MAX_LENGTH, GATEWAY_RPC_INPUT_MAX_BYTES, GATEWAY_RPC_INPUT_MAX_DEPTH, GATEWAY_RPC_MAX_ARRAY_LENGTH, GATEWAY_RPC_MAX_DEPTH, GATEWAY_RPC_MAX_PAYLOAD_BYTES, GATEWAY_RPC_MAX_STRING_LENGTH, Gateway, type GatewayAuthConfig, type GatewayDefaults, type GatewayMetricLabels, type GatewayOptions, type GatewayRequestContext, type GatewayTokenGrant, type GatewayTransport, type GatewayWebhookConfig, type GatewayWebhookRunConfig, type GatewayWebhookSignalConfig, type GetNodeDiffRouteResult, type HelloResponse, ITERATION_MAX, type IncomingMessage, type JumpResult, NODE_ID_PATTERN, NODE_OUTPUT_MAX_BYTES, NODE_OUTPUT_WARN_BYTES, type NodeOutputErrorCode, type NodeOutputResponse, NodeOutputRouteError, RUN_ID_PATTERN, type RegisteredWorkflow, type RequestFrame, type ResolvedRun, type ResponseFrame, type RunStartAuthContext, type ServeOptions, type ServerOptions, type ServerResponse, type SmithersWorkflow, assertGatewayInputDepthWithinBounds, createServeApp, emptyDevToolsRoot, getDevToolsSnapshotRoute, getGatewayInputDepth, getNodeDiffRoute, getNodeOutputRoute, jumpToFrameRoute, parseGatewayRequestFrame, parseXmlToDevToolsRoot, runFork, runPromise, runSync, snapshotFromFrameRow, startServer, startServerEffect, statusForRpcError, streamDevToolsRoute, summarizeBundle, validateFrameNoInput, validateFromSeqInput, validateGatewayMethodName, validateRequestedFrameNo, validateRunId };
