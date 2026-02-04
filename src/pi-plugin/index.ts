import type { SmithersEvent } from "../types";

const DEFAULT_BASE = "http://127.0.0.1:7331";

async function post(path: string, body: any, base = DEFAULT_BASE) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function runWorkflow(args: { workflowPath: string; input: unknown; runId?: string }) {
  return post("/v1/runs", { workflowPath: args.workflowPath, input: args.input, runId: args.runId });
}

export async function resume(args: { workflowPath: string; runId: string }) {
  return post("/v1/runs", { workflowPath: args.workflowPath, runId: args.runId, resume: true });
}

export async function approve(args: { runId: string; nodeId: string; iteration?: number; note?: string }) {
  return post(`/v1/runs/${args.runId}/nodes/${args.nodeId}/approve`, { iteration: args.iteration ?? 0, note: args.note });
}

export async function deny(args: { runId: string; nodeId: string; iteration?: number; note?: string }) {
  return post(`/v1/runs/${args.runId}/nodes/${args.nodeId}/deny`, { iteration: args.iteration ?? 0, note: args.note });
}

export async function* streamEvents(args: { runId: string; baseUrl?: string }): AsyncIterable<SmithersEvent> {
  const base = args.baseUrl ?? DEFAULT_BASE;
  const res = await fetch(`${base}/v1/runs/${args.runId}/events`);
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

export async function getStatus(args: { runId: string; baseUrl?: string }) {
  const base = args.baseUrl ?? DEFAULT_BASE;
  const res = await fetch(`${base}/v1/runs/${args.runId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getFrames(args: { runId: string; tail?: number; baseUrl?: string }) {
  const base = args.baseUrl ?? DEFAULT_BASE;
  const res = await fetch(`${base}/v1/runs/${args.runId}/frames?limit=${args.tail ?? 20}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
