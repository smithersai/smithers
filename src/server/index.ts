import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runWorkflow } from "../engine";
import { newRunId } from "../utils/ids";
import type { SmithersWorkflow } from "../types";
import { SmithersDb } from "../db/adapter";
import { ensureSmithersTables } from "../db/ensure";
import { approveNode, denyNode } from "../engine/approvals";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

type RunRecord = {
  workflow: SmithersWorkflow<any>;
  abort: AbortController;
  workflowPath: string;
};

const runs = new Map<string, RunRecord>();

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  return JSON.parse(body);
}

async function loadWorkflow(workflowPath: string): Promise<SmithersWorkflow<any>> {
  const abs = resolve(process.cwd(), workflowPath);
  const mod = await import(pathToFileURL(abs).href);
  if (!mod.default) throw new Error("Workflow must export default");
  return mod.default as SmithersWorkflow<any>;
}

function sendJson(res: ServerResponse, status: number, payload: any) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export function startServer(opts: { port?: number; db?: BunSQLiteDatabase<any> } = {}) {
  const port = opts.port ?? 7331;
  const serverDb = opts.db ?? null;
  if (serverDb) {
    ensureSmithersTables(serverDb);
  }
  const serverAdapter = serverDb ? new SmithersDb(serverDb) : null;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const method = req.method ?? "GET";

      function adapterForRun(runId: string): SmithersDb | null {
        if (serverAdapter) return serverAdapter;
        const record = runs.get(runId);
        if (!record) return null;
        return new SmithersDb(record.workflow.db as any);
      }

      if (method === "POST" && url.pathname === "/v1/runs") {
        const body = await readBody(req);
        const workflow = await loadWorkflow(body.workflowPath);
        ensureSmithersTables(workflow.db as any);
        const abort = new AbortController();
        const runId = body.runId ?? newRunId();
        const record: RunRecord = { workflow, abort, workflowPath: body.workflowPath };
        runs.set(runId, record);

        runWorkflow(workflow, {
          runId,
          input: body.input ?? {},
          resume: body.resume ?? false,
          maxConcurrency: body.config?.maxConcurrency,
          signal: abort.signal,
          workflowPath: body.workflowPath,
        }).then((result) => {
          const id = result.runId;
          if (serverDb) {
            const rec = runs.get(id);
            if (rec) {
              runs.delete(id);
            }
          }
        });

        sendJson(res, 200, { runId });
        return;
      }

      const resumeMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/resume$/);
      if (method === "POST" && resumeMatch) {
        const runId = resumeMatch[1]!;
        const body = await readBody(req);
        const workflow = await loadWorkflow(body.workflowPath);
        ensureSmithersTables(workflow.db as any);
        const abort = new AbortController();
        const record: RunRecord = { workflow, abort, workflowPath: body.workflowPath };
        runs.set(runId, record);

        runWorkflow(workflow, {
          runId,
          input: body.input ?? {},
          resume: true,
          maxConcurrency: body.config?.maxConcurrency,
          signal: abort.signal,
          workflowPath: body.workflowPath,
        }).then(() => {
          if (serverDb) {
            const rec = runs.get(runId);
            if (rec) {
              runs.delete(runId);
            }
          }
        });

        sendJson(res, 200, { runId });
        return;
      }

      const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch) {
        const runId = cancelMatch[1]!;
        const record = runs.get(runId);
        if (!record) {
          return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        }
        record.abort.abort();
        return sendJson(res, 200, { runId });
      }

      const runEventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (method === "GET" && runEventsMatch) {
        const runId = runEventsMatch[1]!;
        const adapter = adapterForRun(runId);
        if (!adapter) {
          return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        }
        const run = await adapter.getRun(runId);
        if (!run) {
          return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        let closed = false;
        let lastSeq = Number(url.searchParams.get("afterSeq") ?? -1);
        if (!Number.isFinite(lastSeq)) lastSeq = -1;
        const poll = async () => {
          if (closed || res.writableEnded) return;
          const events = await adapter.listEvents(runId, lastSeq, 200);
          for (const ev of events) {
            lastSeq = ev.seq;
            if (res.writableEnded) break;
            res.write(`event: smithers\n`);
            res.write(`data: ${ev.payloadJson}\n\n`);
          }
          const runRow = await adapter.getRun(runId);
          if (runRow && ["finished", "failed", "cancelled"].includes(runRow.status) && events.length === 0) {
            closed = true;
            res.end();
          }
        };
        req.on("close", () => {
          closed = true;
        });
        (async () => {
          while (!closed && !res.writableEnded) {
            await poll();
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        })();
        return;
      }

      const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch) {
        const runId = runMatch[1]!;
        const adapter = adapterForRun(runId);
        if (!adapter) {
          return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        }
        const run = await adapter.getRun(runId);
        if (!run) {
          return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        }
        const summary = await adapter.countNodesByState(runId);
        return sendJson(res, 200, {
          runId,
          workflowName: run?.workflowName ?? "workflow",
          status: run?.status ?? "unknown",
          startedAtMs: run?.startedAtMs ?? null,
          finishedAtMs: run?.finishedAtMs ?? null,
          summary: summary.reduce((acc: any, row: any) => {
            acc[row.state] = row.count;
            return acc;
          }, {}),
        });
      }

      const framesMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/frames$/);
      if (method === "GET" && framesMatch) {
        const runId = framesMatch[1]!;
        const adapter = adapterForRun(runId);
        if (!adapter) {
          return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        }
        const run = await adapter.getRun(runId);
        if (!run) {
          return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        }
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const after = url.searchParams.get("afterFrameNo");
        const frames = await adapter.listFrames(runId, limit, after ? Number(after) : undefined);
        return sendJson(res, 200, frames);
      }

      const approveMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/nodes\/([^/]+)\/approve$/);
      if (method === "POST" && approveMatch) {
        const runId = approveMatch[1]!;
        const nodeId = approveMatch[2]!;
        const body = await readBody(req);
        const adapter = adapterForRun(runId);
        if (!adapter) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        await approveNode(adapter, runId, nodeId, body.iteration ?? 0, body.note, body.decidedBy);
        return sendJson(res, 200, { runId });
      }

      const denyMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/nodes\/([^/]+)\/deny$/);
      if (method === "POST" && denyMatch) {
        const runId = denyMatch[1]!;
        const nodeId = denyMatch[2]!;
        const body = await readBody(req);
        const adapter = adapterForRun(runId);
        if (!adapter) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Run not found" } });
        await denyNode(adapter, runId, nodeId, body.iteration ?? 0, body.note, body.decidedBy);
        return sendJson(res, 200, { runId });
      }

      if (method === "GET" && url.pathname === "/v1/runs") {
        if (!serverAdapter) {
          return sendJson(res, 400, { error: { code: "DB_NOT_CONFIGURED", message: "Server DB not configured" } });
        }
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const status = url.searchParams.get("status") ?? undefined;
        const runs = await serverAdapter.listRuns(limit, status);
        return sendJson(res, 200, runs);
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    } catch (err: any) {
      sendJson(res, 500, { error: { code: "SERVER_ERROR", message: err?.message ?? "Unknown error" } });
    }
  });

  server.listen(port);
  return server;
}
