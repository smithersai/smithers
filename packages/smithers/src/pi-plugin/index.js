import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("@smithers/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {{ baseUrl?: string; apiKey?: string }} RequestOptions */

const DEFAULT_BASE = "http://127.0.0.1:7331";
/**
 * @param {RequestOptions} [opts]
 */
function buildHeaders(opts, withJson = false) {
    /** @type {Record<string, string>} */
    const headers = {};
    if (withJson)
        headers["Content-Type"] = "application/json";
    if (opts?.apiKey)
        headers["Authorization"] = `Bearer ${opts.apiKey}`;
    return headers;
}
/**
 * @param {string} path
 * @param {unknown} body
 * @param {RequestOptions} [opts]
 * @returns {Promise<unknown>}
 */
async function post(path, body, opts = {}) {
    const base = opts.baseUrl ?? DEFAULT_BASE;
    const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: buildHeaders(opts, true),
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
        throw new SmithersError("PI_HTTP_ERROR", `Smithers HTTP ${res.status}`, {
            baseUrl: base,
            path,
            status: res.status,
        });
    }
    return res.json();
}
/**
 * @param {{ workflowPath: string; input: unknown; runId?: string; baseUrl?: string; apiKey?: string; }} args
 * @returns {Promise<unknown>}
 */
export async function runWorkflow(args) {
    return post("/v1/runs", { workflowPath: args.workflowPath, input: args.input, runId: args.runId }, { baseUrl: args.baseUrl, apiKey: args.apiKey });
}
/**
 * @param {{ workflowPath: string; runId: string; baseUrl?: string; apiKey?: string; }} args
 * @returns {Promise<unknown>}
 */
export async function resume(args) {
    return post("/v1/runs", { workflowPath: args.workflowPath, runId: args.runId, resume: true }, { baseUrl: args.baseUrl, apiKey: args.apiKey });
}
/**
 * @param {{ runId: string; nodeId: string; iteration?: number; note?: string; baseUrl?: string; apiKey?: string; }} args
 * @returns {Promise<unknown>}
 */
export async function approve(args) {
    return post(`/v1/runs/${args.runId}/nodes/${args.nodeId}/approve`, { iteration: args.iteration ?? 0, note: args.note }, { baseUrl: args.baseUrl, apiKey: args.apiKey });
}
/**
 * @param {{ runId: string; nodeId: string; iteration?: number; note?: string; baseUrl?: string; apiKey?: string; }} args
 * @returns {Promise<unknown>}
 */
export async function deny(args) {
    return post(`/v1/runs/${args.runId}/nodes/${args.nodeId}/deny`, { iteration: args.iteration ?? 0, note: args.note }, { baseUrl: args.baseUrl, apiKey: args.apiKey });
}
/**
 * @param {{ runId: string; baseUrl?: string; apiKey?: string; }} args
 * @returns {AsyncIterable<SmithersEvent>}
 */
export async function* streamEvents(args) {
    const base = args.baseUrl ?? DEFAULT_BASE;
    const res = await fetch(`${base}/v1/runs/${args.runId}/events`, {
        headers: buildHeaders({ baseUrl: args.baseUrl, apiKey: args.apiKey }, false),
    });
    if (!res.ok || !res.body)
        return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
                const json = line.slice(6);
                yield JSON.parse(json);
            }
        }
    }
}
/**
 * @param {{ runId: string; baseUrl?: string; apiKey?: string; }} args
 * @returns {Promise<unknown>}
 */
export async function getStatus(args) {
    const base = args.baseUrl ?? DEFAULT_BASE;
    const res = await fetch(`${base}/v1/runs/${args.runId}`, {
        headers: buildHeaders({ baseUrl: args.baseUrl, apiKey: args.apiKey }, false),
    });
    if (!res.ok) {
        throw new SmithersError("PI_HTTP_ERROR", `Smithers HTTP ${res.status}`, {
            baseUrl: base,
            path: `/v1/runs/${args.runId}`,
            status: res.status,
        });
    }
    return res.json();
}
/**
 * @param {{ runId: string; tail?: number; baseUrl?: string; apiKey?: string; }} args
 * @returns {Promise<unknown>}
 */
export async function getFrames(args) {
    const base = args.baseUrl ?? DEFAULT_BASE;
    const res = await fetch(`${base}/v1/runs/${args.runId}/frames?limit=${args.tail ?? 20}`, {
        headers: buildHeaders({ baseUrl: args.baseUrl, apiKey: args.apiKey }, false),
    });
    if (!res.ok) {
        throw new SmithersError("PI_HTTP_ERROR", `Smithers HTTP ${res.status}`, {
            baseUrl: base,
            path: `/v1/runs/${args.runId}/frames`,
            status: res.status,
        });
    }
    return res.json();
}
/**
 * @param {{ runId: string; baseUrl?: string; apiKey?: string; }} args
 * @returns {Promise<unknown>}
 */
export async function cancel(args) {
    return post(`/v1/runs/${args.runId}/cancel`, {}, { baseUrl: args.baseUrl, apiKey: args.apiKey });
}
/**
 * @param {{ limit?: number; status?: string; baseUrl?: string; apiKey?: string; }} [args]
 * @returns {Promise<unknown>}
 */
export async function listRuns(args = {}) {
    const base = args.baseUrl ?? DEFAULT_BASE;
    const params = new URLSearchParams();
    if (args.limit !== undefined)
        params.set("limit", String(args.limit));
    if (args.status)
        params.set("status", args.status);
    const qs = params.toString();
    const res = await fetch(`${base}/v1/runs${qs ? `?${qs}` : ""}`, {
        headers: buildHeaders({ baseUrl: args.baseUrl, apiKey: args.apiKey }, false),
    });
    if (!res.ok) {
        throw new SmithersError("PI_HTTP_ERROR", `Smithers HTTP ${res.status}`, {
            baseUrl: base,
            path: `/v1/runs${qs ? `?${qs}` : ""}`,
            status: res.status,
        });
    }
    return res.json();
}
