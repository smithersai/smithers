import type { SmithersEvent } from "../SmithersEvent";
import { SmithersError } from "../utils/errors";

const DEFAULT_BASE = "http://127.0.0.1:7331";

type RequestOptions = { baseUrl?: string; apiKey?: string };

function buildHeaders(opts?: RequestOptions, withJson = false) {
  const headers: Record<string, string> = {};
  if (withJson) headers["Content-Type"] = "application/json";
  if (opts?.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;
  return headers;
}

async function post(path: string, body: any, opts: RequestOptions = {}) {
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

export async function runWorkflow(args: {
  workflowPath: string;
  input: unknown;
  runId?: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  return post(
    "/v1/runs",
    { workflowPath: args.workflowPath, input: args.input, runId: args.runId },
    { baseUrl: args.baseUrl, apiKey: args.apiKey },
  );
}

export async function resume(args: {
  workflowPath: string;
  runId: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  return post(
    "/v1/runs",
    { workflowPath: args.workflowPath, runId: args.runId, resume: true },
    { baseUrl: args.baseUrl, apiKey: args.apiKey },
  );
}

export async function approve(args: {
  runId: string;
  nodeId: string;
  iteration?: number;
  note?: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  return post(
    `/v1/runs/${args.runId}/nodes/${args.nodeId}/approve`,
    { iteration: args.iteration ?? 0, note: args.note },
    { baseUrl: args.baseUrl, apiKey: args.apiKey },
  );
}

export async function deny(args: {
  runId: string;
  nodeId: string;
  iteration?: number;
  note?: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  return post(
    `/v1/runs/${args.runId}/nodes/${args.nodeId}/deny`,
    { iteration: args.iteration ?? 0, note: args.note },
    { baseUrl: args.baseUrl, apiKey: args.apiKey },
  );
}

export async function* streamEvents(args: {
  runId: string;
  baseUrl?: string;
  apiKey?: string;
}): AsyncIterable<SmithersEvent> {
  const base = args.baseUrl ?? DEFAULT_BASE;
  const res = await fetch(`${base}/v1/runs/${args.runId}/events`, {
    headers: buildHeaders(
      { baseUrl: args.baseUrl, apiKey: args.apiKey },
      false,
    ),
  });
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (line) {
        const json = line.slice(6);
        yield JSON.parse(json) as SmithersEvent;
      }
    }
  }
}

export async function getStatus(args: {
  runId: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  const base = args.baseUrl ?? DEFAULT_BASE;
  const res = await fetch(`${base}/v1/runs/${args.runId}`, {
    headers: buildHeaders(
      { baseUrl: args.baseUrl, apiKey: args.apiKey },
      false,
    ),
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

export async function getFrames(args: {
  runId: string;
  tail?: number;
  baseUrl?: string;
  apiKey?: string;
}) {
  const base = args.baseUrl ?? DEFAULT_BASE;
  const res = await fetch(
    `${base}/v1/runs/${args.runId}/frames?limit=${args.tail ?? 20}`,
    {
      headers: buildHeaders(
        { baseUrl: args.baseUrl, apiKey: args.apiKey },
        false,
      ),
    },
  );
  if (!res.ok) {
    throw new SmithersError("PI_HTTP_ERROR", `Smithers HTTP ${res.status}`, {
      baseUrl: base,
      path: `/v1/runs/${args.runId}/frames`,
      status: res.status,
    });
  }
  return res.json();
}

export async function cancel(args: {
  runId: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  return post(
    `/v1/runs/${args.runId}/cancel`,
    {},
    { baseUrl: args.baseUrl, apiKey: args.apiKey },
  );
}

export async function listRuns(
  args: {
    limit?: number;
    status?: string;
    baseUrl?: string;
    apiKey?: string;
  } = {},
) {
  const base = args.baseUrl ?? DEFAULT_BASE;
  const params = new URLSearchParams();
  if (args.limit !== undefined) params.set("limit", String(args.limit));
  if (args.status) params.set("status", args.status);
  const qs = params.toString();
  const res = await fetch(`${base}/v1/runs${qs ? `?${qs}` : ""}`, {
    headers: buildHeaders(
      { baseUrl: args.baseUrl, apiKey: args.apiKey },
      false,
    ),
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
