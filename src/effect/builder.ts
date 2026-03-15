import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, desc, eq } from "drizzle-orm";
import {
  Context,
  Duration,
  Effect,
  Exit,
  JSONSchema,
  Layer,
  Schedule,
  Schema,
} from "effect";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import React from "react";
import { decode as parseToon } from "@toon-format/toon";
import type { AgentLike } from "../AgentLike";
import type { CachePolicy } from "../CachePolicy";
import type { RetryPolicy } from "../RetryPolicy";
import {
  AnthropicAgent,
  ClaudeCodeAgent,
  CodexAgent,
  ForgeAgent,
  GeminiAgent,
  KimiAgent,
  OpenAIAgent,
  PiAgent,
} from "../agents";
import { SmithersDb } from "../db/adapter";
import { runWorkflow } from "../engine";
import { runPromise } from "./runtime";
import { requireTaskRuntime } from "./task-runtime";
import {
  Branch,
  Loop,
  Parallel,
  Sequence,
  Task,
  Worktree,
  Workflow,
} from "../components";
import { camelToSnake } from "../camelToSnake";

type AnySchema = any;
type AnyEffect = any;

type BuilderStepContext = Record<string, unknown> & {
  input: unknown;
  executionId: string;
  stepId: string;
  attempt: number;
  signal: AbortSignal;
  iteration: number;
};

type StepOptions = {
  output: AnySchema;
  run: (ctx: BuilderStepContext) => AnyEffect;
  needs?: Record<string, BuilderStepHandle>;
  retry?: any;
  retryPolicy?: RetryPolicy;
  timeout?: unknown;
  cache?: CachePolicy;
  skipIf?: (ctx: BuilderStepContext) => boolean;
};

type ApprovalOptions = {
  needs?: Record<string, BuilderStepHandle>;
  request: (ctx: Record<string, unknown>) => {
    title: string;
    summary?: string | null;
  };
  onDeny?: "fail" | "continue" | "skip";
};

type MatchOptions = {
  when: (value: any) => boolean;
  then: () => BuilderNode;
  else?: () => BuilderNode;
};

type SequenceNode = {
  kind: "sequence";
  children: BuilderNode[];
};

type ParallelNode = {
  kind: "parallel";
  children: BuilderNode[];
  maxConcurrency?: number;
};

type LoopNode = {
  kind: "loop";
  id?: string;
  children: BuilderNode;
  until: (outputs: Record<string, unknown>) => boolean;
  maxIterations?: number;
  onMaxReached?: "fail" | "return-last";
  handles?: BuilderStepHandle[];
};

type MatchNode = {
  kind: "match";
  source: BuilderStepHandle;
  when: (value: any) => boolean;
  then: BuilderNode;
  else?: BuilderNode;
};

type BranchNode = {
  kind: "branch";
  condition: (ctx: Record<string, unknown>) => boolean;
  needs?: Record<string, BuilderStepHandle>;
  then: BuilderNode;
  else?: BuilderNode;
};

type WorktreeNode = {
  kind: "worktree";
  id?: string;
  path: string;
  branch?: string;
  skipIf?: (ctx: Record<string, unknown>) => boolean;
  needs?: Record<string, BuilderStepHandle>;
  children: BuilderNode;
};

export type BuilderNode =
  | BuilderStepHandle
  | SequenceNode
  | ParallelNode
  | LoopNode
  | MatchNode
  | BranchNode
  | WorktreeNode;

export type BuilderStepHandle = {
  kind: "step" | "approval";
  id: string;
  localId: string;
  tableKey: string;
  tableName: string;
  table: any;
  output: AnySchema;
  needs: Record<string, BuilderStepHandle>;
  run?: (ctx: BuilderStepContext) => AnyEffect;
  request?: ApprovalOptions["request"];
  onDeny?: "fail" | "continue" | "skip";
  retries: number;
  retryPolicy?: RetryPolicy;
  timeoutMs: number | null;
  skipIf?: (ctx: BuilderStepContext) => boolean;
  loopId?: string;
  cache?: CachePolicy;
};

type ComponentDefinition = {
  kind: "component-definition";
  name: string;
  buildWithPrefix: (prefix: string, params: Record<string, unknown>) => BuilderNode;
};

type BuilderApi = {
  step: (id: string, options: StepOptions) => BuilderStepHandle;
  approval: (id: string, options: ApprovalOptions) => BuilderStepHandle;
  sequence: (...nodes: BuilderNode[]) => BuilderNode;
  parallel: (...args: Array<BuilderNode | { maxConcurrency?: number }>) => BuilderNode;
  loop: (options: {
    id?: string;
    children: BuilderNode;
    until: (outputs: Record<string, unknown>) => boolean;
    maxIterations?: number;
    onMaxReached?: "fail" | "return-last";
  }) => BuilderNode;
  match: (source: BuilderStepHandle, options: MatchOptions) => BuilderNode;
  component: (
    instanceId: string,
    definition: ComponentDefinition,
    params: Record<string, unknown>,
  ) => BuilderNode;
};

export type SmithersSqliteOptions = {
  filename: string;
};

const SmithersSqlite = Context.GenericTag<SmithersSqliteOptions>(
  "smithers/effect/sqlite",
);

class ApprovalDecision extends Schema.Class<ApprovalDecision>("ApprovalDecision")({
  approved: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
  decidedBy: Schema.NullOr(Schema.String),
  decidedAt: Schema.NullOr(Schema.String),
}) {}

function createPayloadTable(name: string) {
  return sqliteTable(
    name,
    {
      runId: text("run_id").notNull(),
      nodeId: text("node_id").notNull(),
      iteration: integer("iteration").notNull().default(0),
      payload: text("payload", { mode: "json" }).$type<Record<string, unknown> | null>(),
    },
    (t) => ({
      pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
    }),
  );
}

function sanitizeIdentifier(value: string): string {
  const snake = camelToSnake(value)
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return snake || "node";
}

function makeTableName(id: string): string {
  return `smithers_${sanitizeIdentifier(id)}`;
}

function createBuilder(prefix = ""): BuilderApi {
  const applyPrefix = (id: string) => (prefix ? `${prefix}.${id}` : id);

  const step = (id: string, options: StepOptions): BuilderStepHandle => {
    const fullId = applyPrefix(id);
    const tableName = makeTableName(fullId);
    return {
      kind: "step",
      id: fullId,
      localId: id,
      tableKey: sanitizeIdentifier(fullId),
      tableName,
      table: createPayloadTable(tableName),
      output: options.output,
      needs: options.needs ?? {},
      run: options.run,
      retries: deriveRetryCount(options.retry),
      retryPolicy: options.retryPolicy ?? deriveRetryPolicy(options.retry),
      timeoutMs: durationToMs(options.timeout),
      skipIf: options.skipIf,
      cache: options.cache,
    };
  };

  const approval = (id: string, options: ApprovalOptions): BuilderStepHandle => {
    const fullId = applyPrefix(id);
    const tableName = makeTableName(fullId);
    return {
      kind: "approval",
      id: fullId,
      localId: id,
      tableKey: sanitizeIdentifier(fullId),
      tableName,
      table: createPayloadTable(tableName),
      output: ApprovalDecision,
      needs: options.needs ?? {},
      request: options.request,
      onDeny: options.onDeny ?? "fail",
      retries: 0,
      timeoutMs: null,
    };
  };

  return {
    step,
    approval,
    sequence: (...nodes) => ({ kind: "sequence", children: nodes }),
    parallel: (...args) => {
      let maxConcurrency: number | undefined;
      const items = [...args];
      const last = items[items.length - 1];
      if (
        last &&
        typeof last === "object" &&
        !Array.isArray(last) &&
        !isBuilderNode(last) &&
        "maxConcurrency" in last
      ) {
        maxConcurrency = Number((last as any).maxConcurrency);
        items.pop();
      }
      return {
        kind: "parallel",
        children: items as BuilderNode[],
        maxConcurrency,
      };
    },
    loop: (options) => ({
      kind: "loop",
      id: options.id ? applyPrefix(options.id) : undefined,
      children: options.children,
      until: options.until,
      maxIterations: options.maxIterations,
      onMaxReached: options.onMaxReached,
    }),
    match: (source, options) => ({
      kind: "match",
      source,
      when: options.when,
      then: options.then(),
      else: options.else?.(),
    }),
    component: (instanceId, definition, params) =>
      definition.buildWithPrefix(applyPrefix(instanceId), params),
  };
}

function isBuilderNode(value: unknown): value is BuilderNode {
  if (!value || typeof value !== "object") return false;
  const kind = (value as any).kind;
  return kind === "step" ||
    kind === "approval" ||
    kind === "sequence" ||
    kind === "parallel" ||
    kind === "loop" ||
    kind === "match" ||
    kind === "branch" ||
    kind === "worktree";
}

function durationToMs(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === "string") {
    const trimmed = input.trim();
    const match = trimmed.match(/^(-?\d+(?:\.\d+)?)(ms|s|m|h)$/i);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        const unit = match[2]!.toLowerCase();
        const factor =
          unit === "ms"
            ? 1
            : unit === "s"
              ? 1000
              : unit === "m"
                ? 60_000
                : 3_600_000;
        return Math.max(0, Math.floor(value * factor));
      }
    }
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.max(0, Math.floor(input));
  }
  try {
    return Math.max(0, Math.floor(Duration.toMillis(Duration.decode(input as any))));
  } catch {
    return null;
  }
}

function deriveRetryPolicy(retry: unknown): RetryPolicy | undefined {
  if (!retry || typeof retry !== "object") return undefined;
  const backoff = (retry as any).backoff;
  const initialDelayMs = durationToMs((retry as any).initialDelay);
  if (
    backoff !== "fixed" &&
    backoff !== "linear" &&
    backoff !== "exponential" &&
    initialDelayMs == null
  ) {
    return undefined;
  }
  return {
    backoff:
      backoff === "fixed" || backoff === "linear" || backoff === "exponential"
        ? backoff
        : undefined,
    initialDelayMs: initialDelayMs ?? undefined,
  };
}

function deriveRetryCount(retry: unknown): number {
  if (retry == null) return 0;
  if (typeof retry === "number" && Number.isFinite(retry)) {
    return Math.max(0, Math.floor(retry));
  }
  if (typeof retry === "object" && retry !== null) {
    const maxAttempts = (retry as any).maxAttempts;
    if (typeof maxAttempts === "number" && Number.isFinite(maxAttempts)) {
      return Math.max(0, Math.floor(maxAttempts - 1));
    }
  }
  try {
    const driver = Effect.runSync(Schedule.driver(retry as any));
    let count = 0;
    while (count < 100) {
      const exit = Effect.runSyncExit(driver.next(undefined) as any);
      if (Exit.isFailure(exit)) {
        return count;
      }
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

function decodeSchema<T>(schema: AnySchema, value: unknown): T {
  return Schema.decodeUnknownSync(schema)(value) as T;
}

function encodeSchema(schema: AnySchema, value: unknown) {
  return Schema.encodeSync(schema)(value as any);
}

function resolveHandleIteration(
  handle: BuilderStepHandle,
  ctx: {
    iteration?: number;
    iterations?: Record<string, number>;
  },
): number {
  if (handle.loopId) {
    return ctx.iterations?.[handle.loopId] ?? 0;
  }
  return 0;
}

function stripPersistedKeys(row: Record<string, unknown>) {
  const { runId, nodeId, iteration, payload, ...rest } = row as any;
  if (payload !== undefined) return payload;
  return rest;
}

function readHandleMaybe(
  handle: BuilderStepHandle,
  ctx: any,
): unknown {
  const iteration = resolveHandleIteration(handle, ctx);
  const row = ctx.outputMaybe(handle.tableName, {
    nodeId: handle.id,
    iteration,
  }) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return decodeSchema(handle.output, stripPersistedKeys(row));
}

function readHandle(
  handle: BuilderStepHandle,
  ctx: any,
): unknown {
  const value = readHandleMaybe(handle, ctx);
  if (value === undefined) {
    throw new Error(`Missing output for step "${handle.id}"`);
  }
  return value;
}

function buildUserContext(
  handle: BuilderStepHandle,
  ctx: any,
  decodedInput: unknown,
  runtime?: ReturnType<typeof requireTaskRuntime>,
): BuilderStepContext {
  const data: Record<string, unknown> = {};
  for (const [key, dependency] of Object.entries(handle.needs)) {
    data[key] = readHandle(dependency, ctx);
  }
  return {
    ...data,
    input: decodedInput,
    executionId: runtime?.runId ?? ctx.runId,
    stepId: handle.id,
    attempt: runtime?.attempt ?? 1,
    signal: runtime?.signal ?? new AbortController().signal,
    iteration: runtime?.iteration ?? resolveHandleIteration(handle, ctx),
  };
}

function buildNeedsContext(
  needs: Record<string, BuilderStepHandle> | undefined,
  ctx: any,
  decodedInput: unknown,
  runtime?: ReturnType<typeof requireTaskRuntime>,
) {
  const data: Record<string, unknown> = {};
  if (needs) {
    for (const [key, dependency] of Object.entries(needs)) {
      data[key] = readHandleMaybe(dependency, ctx);
    }
  }
  const iteration =
    runtime?.iteration ??
    (typeof ctx?.iteration === "number" ? ctx.iteration : 0);
  return {
    ...data,
    input: decodedInput,
    executionId: runtime?.runId ?? ctx.runId,
    stepId: runtime?.stepId ?? "",
    attempt: runtime?.attempt ?? 1,
    signal: runtime?.signal ?? new AbortController().signal,
    iteration,
    loop: { iteration: iteration + 1 },
  };
}

async function resolveEffectResult(
  value: unknown,
  env: any,
  signal: AbortSignal,
) {
  if ((Effect as any).isEffect?.(value)) {
    return await runPromise(
      (value as any).pipe(Effect.provide(env)),
      { signal },
    );
  }
  if (value && typeof (value as PromiseLike<unknown>).then === "function") {
    const resolved = await value;
    if ((Effect as any).isEffect?.(resolved)) {
      return await runPromise(
        (resolved as any).pipe(Effect.provide(env)),
        { signal },
      );
    }
    return resolved;
  }
  return value;
}

async function executeStepHandle(
  handle: BuilderStepHandle,
  ctx: any,
  decodedInput: unknown,
  env: any,
) {
  const runtime = requireTaskRuntime();
  if (handle.kind === "approval") {
    const adapter = new SmithersDb(runtime.db);
    const approval = await adapter.getApproval(
      runtime.runId,
      handle.id,
      runtime.iteration,
    );
    return encodeSchema(ApprovalDecision, {
      approved: approval?.status === "approved",
      note: approval?.note ?? null,
      decidedBy: approval?.decidedBy ?? null,
      decidedAt:
        typeof approval?.decidedAtMs === "number"
          ? new Date(approval.decidedAtMs).toISOString()
          : null,
    });
  }

  const userCtx = buildUserContext(handle, ctx, decodedInput, runtime);
  const output = await resolveEffectResult(handle.run?.(userCtx), env, runtime.signal);
  const decoded = decodeSchema(handle.output, output);
  return encodeSchema(handle.output, decoded);
}

function evaluateSkip(
  handle: BuilderStepHandle,
  ctx: any,
  decodedInput: unknown,
): boolean {
  if (!handle.skipIf) return false;
  try {
    return Boolean(handle.skipIf(buildUserContext(handle, ctx, decodedInput)));
  } catch {
    return false;
  }
}

function renderNode(
  node: BuilderNode,
  ctx: any,
  decodedInput: unknown,
  env: any,
): React.ReactNode {
  if (node.kind === "step" || node.kind === "approval") {
    const requestInfo =
      node.kind === "approval"
        ? (() => {
            if (!node.request) return null;
            const entries = Object.entries(node.needs).map(([key, dep]) => [
              key,
              readHandleMaybe(dep, ctx),
            ]);
            if (entries.some(([, value]) => value === undefined)) {
              return null;
            }
            return node.request(Object.fromEntries(entries));
          })()
        : null;
    const compute = () => executeStepHandle(node, ctx, decodedInput, env);
    const needsMap =
      Object.keys(node.needs).length > 0
        ? Object.fromEntries(
            Object.entries(node.needs).map(([key, dep]) => [key, dep.id]),
          )
        : undefined;
    return (
      React.createElement(Task as any, {
        id: node.id,
        output: node.table,
        retries: node.retries,
        retryPolicy: node.retryPolicy,
        timeoutMs: node.timeoutMs,
        cache: node.cache,
        skipIf: evaluateSkip(node, ctx, decodedInput),
        needsApproval: node.kind === "approval",
        approvalMode: node.kind === "approval" ? "decision" : undefined,
        approvalOnDeny: node.kind === "approval" ? node.onDeny : undefined,
        needs: needsMap,
        dependsOn: Object.values(node.needs).map((dep) => dep.id),
        label: requestInfo?.title,
        meta: requestInfo?.summary
          ? { requestSummary: requestInfo.summary }
          : undefined,
        children: compute as any,
      })
    );
  }

  if (node.kind === "sequence") {
    return React.createElement(
      Sequence,
      null,
      node.children.map((child, index) =>
        React.createElement(
          React.Fragment,
          { key: `sequence-${index}` },
          renderNode(child, ctx, decodedInput, env),
        )
      ),
    );
  }

  if (node.kind === "parallel") {
    return React.createElement(
      Parallel,
      { maxConcurrency: node.maxConcurrency },
      node.children.map((child, index) =>
        React.createElement(
          React.Fragment,
          { key: `parallel-${index}` },
          renderNode(child, ctx, decodedInput, env),
        )
      ),
    );
  }

  if (node.kind === "loop") {
    const outputs: Record<string, unknown> = {};
    for (const handle of node.handles ?? []) {
      outputs[handle.localId] = readHandleMaybe(handle, ctx);
    }
    const iteration =
      (node.id && ctx?.iterations && typeof ctx.iterations[node.id] === "number")
        ? ctx.iterations[node.id]
        : (typeof ctx?.iteration === "number" ? ctx.iteration : 0);
    const evalCtx = {
      ...outputs,
      input: decodedInput,
      iteration,
      loop: { iteration: iteration + 1 },
    };
    return React.createElement(
      Loop,
      {
        id: node.id,
        until: Boolean(node.until(evalCtx)),
        maxIterations: node.maxIterations,
        onMaxReached: node.onMaxReached,
      },
      renderNode(node.children, ctx, decodedInput, env),
    );
  }

  if (node.kind === "branch") {
    const baseCtx = buildNeedsContext(node.needs, ctx, decodedInput);
    const chooseThen = Boolean(node.condition(baseCtx));
    return React.createElement(Branch, {
      if: chooseThen,
      then: React.createElement(
        React.Fragment,
        null,
        renderNode(node.then, ctx, decodedInput, env),
      ),
      else: node.else
        ? React.createElement(
            React.Fragment,
            null,
            renderNode(node.else, ctx, decodedInput, env),
          )
        : undefined,
    });
  }

  if (node.kind === "worktree") {
    const baseCtx = buildNeedsContext(node.needs, ctx, decodedInput);
    const skip = node.skipIf ? Boolean(node.skipIf(baseCtx)) : false;
    return React.createElement(
      Worktree,
      { id: node.id, path: node.path, branch: node.branch, skipIf: skip },
      renderNode(node.children, ctx, decodedInput, env),
    );
  }

  if (node.kind === "match") {
    const sourceValue = readHandleMaybe(node.source, ctx);
    const chooseThen = sourceValue !== undefined && node.when(sourceValue);
    return React.createElement(Branch, {
      if: chooseThen,
      then: React.createElement(
        React.Fragment,
        null,
        renderNode(node.then, ctx, decodedInput, env),
      ),
      else: node.else
        ? React.createElement(
            React.Fragment,
            null,
            renderNode(node.else, ctx, decodedInput, env),
          )
        : undefined,
    });
  }

  return null;
}

function collectHandles(node: BuilderNode, out: BuilderStepHandle[] = []) {
  switch (node.kind) {
    case "step":
    case "approval":
      out.push(node);
      return out;
    case "sequence":
    case "parallel":
      for (const child of node.children) collectHandles(child, out);
      return out;
    case "loop":
      collectHandles(node.children, out);
      return out;
    case "match":
      collectHandles(node.then, out);
      if (node.else) collectHandles(node.else, out);
      return out;
    case "branch":
      collectHandles(node.then, out);
      if (node.else) collectHandles(node.else, out);
      return out;
    case "worktree":
      collectHandles(node.children, out);
      return out;
  }
}

function registerPluginHandles(env: ToonEnv, node: BuilderNode) {
  const handles = collectHandles(node);
  for (const handle of handles) {
    const existing = env.handles.get(handle.id);
    if (existing && existing !== handle) {
      throw new Error(`Duplicate step id "${handle.id}"`);
    }
    if (!existing) {
      if (env.seenIds.has(handle.id)) {
        throw new Error(`Duplicate step id "${handle.id}"`);
      }
      env.seenIds.add(handle.id);
      env.handles.set(handle.id, handle);
    }
  }
}

function annotateLoops(node: BuilderNode, activeLoopId?: string): BuilderStepHandle[] {
  switch (node.kind) {
    case "step":
    case "approval":
      node.loopId = activeLoopId;
      return [node];
    case "sequence":
    case "parallel":
      return node.children.flatMap((child) => annotateLoops(child, activeLoopId));
    case "loop": {
      if (activeLoopId) {
        throw new Error("Nested builder loops are not supported.");
      }
      const handles = annotateLoops(node.children, node.id ?? "__loop__");
      node.handles = handles;
      return handles;
    }
    case "match":
      return [
        ...annotateLoops(node.then, activeLoopId),
        ...(node.else ? annotateLoops(node.else, activeLoopId) : []),
      ];
    case "branch":
      return [
        ...annotateLoops(node.then, activeLoopId),
        ...(node.else ? annotateLoops(node.else, activeLoopId) : []),
      ];
    case "worktree":
      return annotateLoops(node.children, activeLoopId);
  }
}

function createInputTable() {
  return sqliteTable("input", {
    runId: text("run_id").primaryKey(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
  });
}

function createBuilderDb(filename: string, handles: BuilderStepHandle[]) {
  const sqlite = new Database(filename);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`,
  );
  for (const handle of handles) {
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS "${handle.tableName}" (` +
        `run_id TEXT NOT NULL, ` +
        `node_id TEXT NOT NULL, ` +
        `iteration INTEGER NOT NULL DEFAULT 0, ` +
        `payload TEXT, ` +
        `PRIMARY KEY (run_id, node_id, iteration)` +
      `)`,
    );
  }

  const inputTable = createInputTable();
  const schema: Record<string, any> = { input: inputTable };
  for (const handle of handles) {
    schema[handle.tableKey] = handle.table;
  }
  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    inputTable,
    schema,
  };
}

async function readLatestHandleResult(
  db: any,
  runId: string,
  handle: BuilderStepHandle,
) {
  const rows = await db
    .select()
    .from(handle.table)
    .where(and(eq(handle.table.runId, runId), eq(handle.table.nodeId, handle.id)))
    .orderBy(desc(handle.table.iteration))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return decodeSchema(handle.output, stripPersistedKeys(row));
}

async function extractResult(
  node: BuilderNode,
  db: any,
  runId: string,
  decodedInput?: unknown,
): Promise<unknown> {
  switch (node.kind) {
    case "step":
    case "approval":
      return readLatestHandleResult(db, runId, node);
    case "sequence": {
      const last = node.children[node.children.length - 1];
      return last ? extractResult(last, db, runId, decodedInput) : undefined;
    }
    case "parallel":
      return Promise.all(node.children.map((child) => extractResult(child, db, runId, decodedInput)));
    case "loop":
      return extractResult(node.children, db, runId, decodedInput);
    case "match": {
      const source = await readLatestHandleResult(db, runId, node.source);
      if (source !== undefined && node.when(source)) {
        return extractResult(node.then, db, runId, decodedInput);
      }
      return node.else ? extractResult(node.else, db, runId, decodedInput) : undefined;
    }
    case "branch": {
      const ctx: Record<string, unknown> = {
        input: decodedInput ?? {},
        iteration: 0,
        loop: { iteration: 1 },
      };
      if (node.needs) {
        for (const [key, handle] of Object.entries(node.needs)) {
          ctx[key] = await readLatestHandleResult(db, runId, handle);
        }
      }
      if (node.condition(ctx)) {
        return extractResult(node.then, db, runId, decodedInput);
      }
      return node.else ? extractResult(node.else, db, runId, decodedInput) : undefined;
    }
    case "worktree":
      return extractResult(node.children, db, runId, decodedInput);
  }
}

function normalizeExecutionError(result: { status: string; error?: unknown }) {
  if (result.error instanceof Error) return result.error;
  if (typeof result.error === "string" && result.error.length > 0) {
    return new Error(result.error);
  }
  return new Error(`Workflow execution ended with status "${result.status}"`);
}

export type BuiltSmithersWorkflow = {
  execute: (
    input: unknown,
    opts?: Omit<Parameters<typeof runWorkflow>[1], "input">,
  ) => AnyEffect;
};

function createWorkflow(options: { name: string; input: AnySchema }) {
  return {
    build(buildGraph: ($: BuilderApi) => BuilderNode): BuiltSmithersWorkflow {
      const root = buildGraph(createBuilder());
      annotateLoops(root);
      const handles = collectHandles(root);

      return {
        execute(input: unknown, opts?: Omit<Parameters<typeof runWorkflow>[1], "input">) {
          return Effect.gen(function* () {
            const env = yield* Effect.context<any>();
            const sqliteConfig = yield* SmithersSqlite;
            const decodedInput = decodeSchema(options.input, input);
            const encodedInput = JSON.parse(
              JSON.stringify(encodeSchema(options.input, decodedInput) ?? {}),
            ) as Record<string, unknown>;

            return yield* Effect.promise(async () => {
              const runtime = createBuilderDb(sqliteConfig.filename, handles);
              try {
                const workflow = {
                  db: runtime.db,
                  build: (ctx: any) =>
                    React.createElement(
                      Workflow,
                      { name: options.name },
                      renderNode(ctx && root ? root : root, ctx, decodedInput, env),
                    ),
                  opts: {},
                } as any;

                const result = await runWorkflow(workflow, {
                  ...(opts ?? {}),
                  input: encodedInput as Record<string, unknown>,
                });

                if (result.status === "finished") {
                  return await extractResult(root, runtime.db, result.runId, decodedInput);
                }
                if (result.status === "waiting-approval") {
                  return result;
                }
                throw normalizeExecutionError(result);
              } finally {
                try {
                  runtime.sqlite.close();
                } catch {}
              }
            });
          });
        },
      };
    },
  };
}

type ToonSchemaEntry = {
  schema: AnySchema;
  jsonSchema?: unknown;
};

type ToonComponentDef = {
  name: string;
  params?: Record<string, unknown>;
  steps: any[];
};

type ToonPluginNodeHandler = (
  node: any,
  env: ToonEnv,
  helpers: {
    compileNode: (node: any, env: ToonEnv) => BuilderNode;
    compileNodes: (nodes: any[], env: ToonEnv) => BuilderNode;
  },
) => BuilderNode;

type ToonPlugin = {
  name?: string;
  nodes?: Record<string, ToonPluginNodeHandler>;
  services?: Record<string, unknown>;
  layers?: Layer<never, never, never> | Layer<never, never, never>[];
};

type ToonEnv = {
  builder: BuilderApi;
  handles: Map<string, BuilderStepHandle>;
  seenIds: Set<string>;
  schemas: Map<string, ToonSchemaEntry>;
  agents: Map<string, AgentLike>;
  components: Map<string, ToonComponentDef>;
  services: Map<string, unknown>;
  workflows: Map<string, string>;
  pluginNodes: Map<string, ToonPluginNodeHandler>;
  baseDir: string;
  componentId?: string;
  componentParams?: Record<string, unknown>;
  componentParamDeps?: Set<string>;
};

type TemplateNode =
  | { type: "text"; value: string }
  | { type: "expr"; expr: string };

const TOON_RESERVED = new Set([
  "input",
  "params",
  "loop",
  "id",
  "true",
  "false",
  "null",
  "steps",
  "executionId",
  "stepId",
  "attempt",
  "signal",
  "iteration",
  "services",
]);

function parseTemplate(source: string): TemplateNode[] {
  const input = String(source ?? "");
  const nodes: TemplateNode[] = [];
  let textBuf = "";
  const len = input.length;
  let i = 0;

  const pushText = () => {
    if (textBuf) {
      nodes.push({ type: "text", value: textBuf });
      textBuf = "";
    }
  };

  while (i < len) {
    if (input.startsWith("{{", i)) {
      textBuf += "{";
      i += 2;
      continue;
    }
    if (input.startsWith("}}", i)) {
      textBuf += "}";
      i += 2;
      continue;
    }
    if (input[i] === "{") {
      // Depth-aware brace matching — skip braces inside string literals
      let depth = 1;
      let j = i + 1;
      while (j < len && depth > 0) {
        const ch = input[j]!;
        if (ch === "'" || ch === '"' || ch === "`") {
          const quote = ch;
          j += 1;
          while (j < len) {
            if (input[j] === "\\") {
              j += 2;
              continue;
            }
            if (input[j] === quote) {
              j += 1;
              break;
            }
            j += 1;
          }
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (depth > 0) j += 1;
      }
      if (depth !== 0) {
        textBuf += input.slice(i);
        i = len;
        break;
      }
      const expr = input.slice(i + 1, j).trim();
      pushText();
      nodes.push({ type: "expr", expr });
      i = j + 1;
      continue;
    }
    textBuf += input[i]!;
    i += 1;
  }
  pushText();
  return nodes;
}

function evaluateExpression(expr: string, ctx: Record<string, unknown>): any {
  const trimmed = (expr ?? "").trim();
  if (!trimmed) return undefined;
  // Rewrite hyphenated context keys to bracket notation
  let processed = trimmed;
  for (const key of Object.keys(ctx)) {
    if (key.includes("-")) {
      processed = processed.replace(
        new RegExp(`\\b${key.replace(/-/g, "\\-")}\\b`, "g"),
        `__ctx__["${key}"]`,
      );
    }
  }
  const keys = Object.keys(ctx).filter((k) => !k.includes("-"));
  const values = keys.map((k) => ctx[k]);
  try {
    const fn = new Function("__ctx__", ...keys, `return (${processed});`);
    return fn(ctx, ...values);
  } catch {
    return undefined;
  }
}

function collectDepsFromExpression(expr: string, knownStepIds?: Set<string>): Set<string> {
  const deps = new Set<string>();
  const raw = (expr ?? "").trim();
  if (!raw) return deps;
  // Strip string literals to avoid false positives
  const stripped = raw.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
  // Extract identifiers (word chars, may include dots and hyphens for step IDs)
  const matches = stripped.match(/[A-Za-z_$][A-Za-z0-9_$-]*/g);
  if (!matches) return deps;
  for (const m of matches) {
    const root = m.split(".")[0]!;
    if (TOON_RESERVED.has(root)) continue;
    // JS keywords/builtins to ignore
    if (JS_KEYWORDS.has(root)) continue;
    if (knownStepIds) {
      if (knownStepIds.has(root)) deps.add(root);
    } else {
      deps.add(root);
    }
  }
  return deps;
}

const JS_KEYWORDS = new Set([
  "break", "case", "catch", "continue", "debugger", "default", "delete",
  "do", "else", "finally", "for", "function", "if", "in", "instanceof",
  "new", "return", "switch", "this", "throw", "try", "typeof", "var",
  "void", "while", "with", "class", "const", "enum", "export", "extends",
  "import", "super", "implements", "interface", "let", "package", "private",
  "protected", "public", "static", "yield", "undefined", "NaN", "Infinity",
  "Math", "Date", "JSON", "String", "Number", "Boolean", "Array", "Object",
  "RegExp", "Error", "Map", "Set", "Promise", "Symbol", "parseInt",
  "parseFloat", "isNaN", "isFinite", "console", "window", "document",
  "globalThis", "eval", "arguments", "of", "from",
]);

function collectDepsFromTemplate(template: string, knownStepIds?: Set<string>): Set<string> {
  const deps = new Set<string>();
  const nodes = parseTemplate(template ?? "");
  for (const node of nodes) {
    if (node.type === "expr") {
      for (const dep of collectDepsFromExpression(node.expr, knownStepIds)) deps.add(dep);
    }
  }
  return deps;
}

function formatTemplateValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderTemplateNodes(nodes: TemplateNode[], ctx: any): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += node.value;
    } else if (node.type === "expr") {
      const value = evaluateExpression(node.expr, ctx);
      out += formatTemplateValue(value);
    }
  }
  return out;
}

function renderTemplate(template: string, ctx: any): string {
  return renderTemplateNodes(parseTemplate(template ?? ""), ctx);
}

function resolveTemplateValue(template: string, ctx: any): any {
  const nodes = parseTemplate(template ?? "");
  if (nodes.length === 1 && nodes[0]!.type === "expr") {
    return evaluateExpression((nodes[0] as any).expr, ctx);
  }
  return renderTemplateNodes(nodes, ctx);
}

function applyComponentId(value: unknown, id?: string): unknown {
  if (!id) return value;
  if (typeof value === "string") {
    return value.replace(/\{id\}/g, id);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveImportPath(spec: string, baseDir: string): string {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    return resolve(baseDir, spec);
  }
  return spec;
}

async function importModule(spec: string, baseDir: string): Promise<any> {
  const resolved = resolveImportPath(spec, baseDir);
  if (resolved.startsWith(".") || resolved.startsWith("/")) {
    return await import(pathToFileURL(resolved).href);
  }
  return await import(resolved);
}

function buildJsonSchema(schema: AnySchema): unknown | undefined {
  try {
    return JSONSchema.make(schema as any);
  } catch {
    return undefined;
  }
}

function parseSchemaType(
  def: unknown,
  registry: Map<string, ToonSchemaEntry>,
  label: string,
): AnySchema {
  if (typeof def === "string") {
    let raw = def.trim();
    let optional = false;
    if (raw.endsWith("?")) {
      optional = true;
      raw = raw.slice(0, -1).trim();
    }
    if (raw.endsWith("[]")) {
      const inner = raw.slice(0, -2).trim();
      const innerSchema = parseSchemaType(inner, registry, label);
      const arraySchema = Schema.Array(innerSchema);
      return optional ? Schema.optional(arraySchema) : arraySchema;
    }
    if (raw.includes("|")) {
      const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
      const literals = parts.map((p) => p.replace(/^['"]|['"]$/g, ""));
      const schema = Schema.Literal(...(literals as [string, ...string[]]));
      return optional ? Schema.optional(schema) : schema;
    }
    if (raw.startsWith("\"") && raw.endsWith("\"")) {
      const schema = Schema.Literal(raw.slice(1, -1));
      return optional ? Schema.optional(schema) : schema;
    }
    if (registry.has(raw)) {
      const schema = registry.get(raw)!.schema;
      return optional ? Schema.optional(schema) : schema;
    }
    if (raw === "string") {
      const schema = Schema.String;
      return optional ? Schema.optional(schema) : schema;
    }
    if (raw === "number") {
      const schema = Schema.Number;
      return optional ? Schema.optional(schema) : schema;
    }
    if (raw === "boolean") {
      const schema = Schema.Boolean;
      return optional ? Schema.optional(schema) : schema;
    }
    throw new Error(`Unknown schema type "${raw}" for ${label}`);
  }
  if (Array.isArray(def)) {
    if (def.length === 1 && isRecord(def[0])) {
      return Schema.Array(parseSchemaType(def[0], registry, label));
    }
    throw new Error(`Unsupported schema array definition for ${label}`);
  }
  if (isRecord(def)) {
    const fields: Record<string, AnySchema> = {};
    for (const [key, value] of Object.entries(def)) {
      const optional = key.endsWith("?");
      const fieldKey = optional ? key.slice(0, -1) : key;
      const fieldSchema = parseSchemaType(value, registry, `${label}.${fieldKey}`);
      fields[fieldKey] = optional ? Schema.optional(fieldSchema) : fieldSchema;
    }
    return Schema.Struct(fields);
  }
  throw new Error(`Invalid schema definition for ${label}`);
}

function parseSchemaEntry(
  def: unknown,
  registry: Map<string, ToonSchemaEntry>,
  label: string,
): ToonSchemaEntry {
  const schema = parseSchemaType(def, registry, label);
  return { schema, jsonSchema: buildJsonSchema(schema) };
}

function buildTemplateContext(
  base: Record<string, unknown>,
  params?: Record<string, unknown>,
  componentId?: string,
): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...base };
  const iteration =
    typeof (base as any).iteration === "number" ? (base as any).iteration : 0;
  ctx.loop = { iteration: iteration + 1 };
  if (params) ctx.params = params;
  if (componentId) ctx.id = componentId;

  const steps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      key === "input" ||
      key === "executionId" ||
      key === "stepId" ||
      key === "attempt" ||
      key === "signal" ||
      key === "iteration"
    ) {
      continue;
    }
    steps[key] = value;
  }
  ctx.steps = steps;
  return ctx;
}

function buildRunContext(
  base: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
  componentId: string | undefined,
  services: Map<string, unknown>,
): Record<string, unknown> {
  const full = buildTemplateContext(base, params, componentId);
  const serviceEntries = Array.from(services.entries());
  const serviceCtx =
    serviceEntries.length > 0 ? Object.fromEntries(serviceEntries) : {};
  const helpers = { Effect, Context, Schema, Layer, Duration, Schedule };
  return {
    ...helpers,
    ...serviceCtx,
    services: serviceCtx,
    ...full,
  };
}

function resolveComponentParams(
  params: Record<string, unknown> | undefined,
  baseCtx: Record<string, unknown>,
  componentId?: string,
): Record<string, unknown> {
  if (!params) return {};
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      const ctx = buildTemplateContext(baseCtx, undefined, componentId);
      resolved[key] = resolveTemplateValue(value, ctx);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

function createRunFunction(code: string): (ctx: any) => Promise<any> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;
  const body = `with (ctx) { ${code} }`;
  return new AsyncFunction("ctx", body);
}

function parseHandlerRef(spec: string, baseDir: string): { modulePath: string; exportName?: string } {
  const [pathPart, exportName] = spec.split("#");
  const resolved = resolveImportPath(pathPart, baseDir);
  return { modulePath: resolved, exportName: exportName || undefined };
}

function buildNeedsMap(env: ToonEnv, deps: Set<string>): Record<string, BuilderStepHandle> {
  const needs: Record<string, BuilderStepHandle> = {};
  for (const id of deps) {
    const handle = env.handles.get(id);
    if (!handle) {
      throw new Error(`Unknown dependency "${id}"`);
    }
    needs[id] = handle;
  }
  return needs;
}

function buildPromptInstructions(prompt: string, jsonSchema: unknown | undefined): string {
  if (!jsonSchema) return prompt;
  const schemaDesc = JSON.stringify(jsonSchema, null, 2);
  const jsonInstructions = [
    "**REQUIRED OUTPUT** — You MUST end your response with a JSON object in a code fence matching this schema:",
    "```json",
    schemaDesc,
    "```",
    "Output the JSON at the END of your response. The workflow will fail without it.",
  ].join("\n");
  return [
    "IMPORTANT: After completing the task below, you MUST output a JSON object in a ```json code fence at the very end of your response. Do NOT forget this — the workflow fails without it.",
    "",
    prompt,
    "",
    "",
    jsonInstructions,
  ].join("\n");
}

function extractAgentOutput(result: any): any {
  let output: any;
  try {
    if (result && result._output !== undefined && result._output !== null) {
      output = result._output;
    } else if (result && result.output !== undefined && result.output !== null) {
      output = result.output;
    }
  } catch {
    // ignore
  }
  if (output === undefined) {
    const text = (result?.text ?? "").toString();

    const tryParseJson = (raw: string): any | undefined => {
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    };

    const extractBalancedJson = (str: string): string | null => {
      const start = str.indexOf("{");
      if (start === -1) return null;
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < str.length; i++) {
        const c = str[i]!;
        if (escape) {
          escape = false;
          continue;
        }
        if (c === "\\") {
          escape = true;
          continue;
        }
        if (c === '"' && !escape) {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) return str.slice(start, i + 1);
        }
      }
      return null;
    };

    const extractLastBalancedJson = (str: string): string | null => {
      let pos = str.lastIndexOf("{");
      while (pos >= 0) {
        const json = extractBalancedJson(str.slice(pos));
        if (json) return json;
        pos = str.lastIndexOf("{", pos - 1);
      }
      return null;
    };

    const fenceMatch = text.match(/```json([\s\S]*?)```/i);
    if (fenceMatch) {
      const json = tryParseJson(fenceMatch[1]!.trim());
      if (json !== undefined) output = json;
    }
    if (output === undefined) {
      const trimmed = text.trim();
      const direct = tryParseJson(trimmed);
      if (direct !== undefined) {
        output = direct;
      } else {
        const extracted = extractLastBalancedJson(text);
        if (extracted) {
          const parsed = tryParseJson(extracted);
          if (parsed !== undefined) output = parsed;
        }
      }
    }
  }
  if (typeof output === "string") {
    try {
      return JSON.parse(output);
    } catch {
      return output;
    }
  }
  return output;
}

async function buildAgentFromConfig(name: string, config: Record<string, any>): Promise<AgentLike> {
  const type = config.type;
  const opts = { ...config };
  delete opts.type;
  if (!opts.id) opts.id = name;
  if (!type || typeof type !== "string") {
    throw new Error(`Agent "${name}" is missing a valid type`);
  }
  switch (type) {
    case "anthropic":
      if (!opts.model) {
        throw new Error(`Agent "${name}" (type: anthropic) requires "model"`);
      }
      return new AnthropicAgent(opts as any);
    case "claude-code":
      return new ClaudeCodeAgent(opts);
    case "codex":
      return new CodexAgent(opts);
    case "gemini":
      return new GeminiAgent(opts);
    case "openai":
      if (!opts.model) {
        throw new Error(`Agent "${name}" (type: openai) requires "model"`);
      }
      return new OpenAIAgent(opts as any);
    case "pi":
      return new PiAgent(opts);
    case "kimi":
      return new KimiAgent(opts);
    case "forge":
      return new ForgeAgent(opts);
    case "api": {
      const providerName = opts.provider;
      const modelName = opts.model;
      if (!providerName || !modelName) {
        throw new Error(`Agent "${name}" (type: api) requires "provider" and "model"`);
      }
      const rest = { ...opts };
      delete (rest as any).provider;
      delete (rest as any).model;
      if (providerName === "anthropic") {
        return new AnthropicAgent({
          model: modelName,
          ...rest,
        });
      }
      if (providerName === "openai") {
        return new OpenAIAgent({
          model: modelName,
          ...rest,
        });
      }
      throw new Error(`Unsupported api provider "${providerName}" for agent "${name}"`);
    }
    default:
      throw new Error(`Unknown agent type "${type}" for "${name}"`);
  }
}

function coerceUseList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.length > 0) return raw.split(",").map((s) => s.trim());
  return [];
}

async function resolveImportedSchemas(
  imports: any,
  baseDir: string,
): Promise<Map<string, ToonSchemaEntry>> {
  const out = new Map<string, ToonSchemaEntry>();
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    const use = coerceUseList(entry?.use);
    if (!from || use.length === 0) continue;
    const mod = await importModule(from, baseDir);
    for (const name of use) {
      const value = mod[name];
      if (!value) throw new Error(`Schema "${name}" not found in ${from}`);
      out.set(name, { schema: value, jsonSchema: buildJsonSchema(value) });
    }
  }
  return out;
}

async function resolveImportedAgents(
  imports: any,
  baseDir: string,
): Promise<Map<string, AgentLike>> {
  const out = new Map<string, AgentLike>();
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    const use = coerceUseList(entry?.use);
    if (!from || use.length === 0) continue;
    const mod = await importModule(from, baseDir);
    for (const name of use) {
      const value = mod[name];
      if (!value || typeof value.generate !== "function") {
        throw new Error(`Agent "${name}" not found in ${from}`);
      }
      out.set(name, value as AgentLike);
    }
  }
  return out;
}

async function resolveImportedServices(
  imports: any,
  baseDir: string,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    const use = coerceUseList(entry?.use);
    if (!from || use.length === 0) continue;
    const mod = await importModule(from, baseDir);
    for (const name of use) {
      const value = mod[name];
      if (value === undefined) {
        throw new Error(`Service "${name}" not found in ${from}`);
      }
      out.set(name, value);
    }
  }
  return out;
}

async function resolveImportedWorkflows(
  imports: any,
  baseDir: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    const alias = String(entry?.as ?? "");
    if (!from || !alias) continue;
    const resolved = resolveImportPath(from, baseDir);
    const absPath =
      resolved.startsWith(".") || resolved.startsWith("/")
        ? resolved
        : resolve(baseDir, resolved);
    if (out.has(alias)) {
      throw new Error(`Duplicate workflow alias "${alias}" in ${from}`);
    }
    out.set(alias, absPath);
  }
  return out;
}

async function resolveImportedPlugins(
  imports: any,
  baseDir: string,
): Promise<{
  plugins: ToonPlugin[];
  pluginNodes: Map<string, ToonPluginNodeHandler>;
  services: Map<string, unknown>;
  layers: Layer<never, never, never>[];
}> {
  const plugins: ToonPlugin[] = [];
  const pluginNodes = new Map<string, ToonPluginNodeHandler>();
  const services = new Map<string, unknown>();
  const layers: Layer<never, never, never>[] = [];
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    if (!from) continue;
    const mod = await importModule(from, baseDir);
    const exported =
      mod?.toonPlugin ?? mod?.plugin ?? mod?.default ?? mod;
    const pluginFactory =
      typeof exported === "function" ? exported : () => exported;
    const plugin = await pluginFactory(entry?.config ?? {});
    if (!plugin || typeof plugin !== "object") {
      throw new Error(`Plugin "${from}" did not export a plugin object`);
    }
    plugins.push(plugin as ToonPlugin);
    const nodes = (plugin as ToonPlugin).nodes;
    if (nodes && typeof nodes === "object") {
      for (const [kind, handler] of Object.entries(nodes)) {
        if (typeof handler !== "function") continue;
        pluginNodes.set(kind, handler as ToonPluginNodeHandler);
      }
    }
    const pluginServices = (plugin as ToonPlugin).services;
    if (pluginServices && typeof pluginServices === "object") {
      for (const [name, value] of Object.entries(pluginServices)) {
        services.set(name, value);
      }
    }
    const pluginLayers = (plugin as ToonPlugin).layers;
    if (Array.isArray(pluginLayers)) {
      layers.push(...(pluginLayers as Layer<never, never, never>[]));
    } else if (pluginLayers) {
      layers.push(pluginLayers as Layer<never, never, never>);
    }
  }
  return { plugins, pluginNodes, services, layers };
}

const toonModuleCache = new Map<
  string,
  Promise<{
    schemas: Map<string, ToonSchemaEntry>;
    components: Map<string, ToonComponentDef>;
    services: Map<string, unknown>;
    pluginNodes: Map<string, ToonPluginNodeHandler>;
    layers: Layer<never, never, never>[];
  }>
>();

async function loadToonModule(absPath: string): Promise<{
  schemas: Map<string, ToonSchemaEntry>;
  components: Map<string, ToonComponentDef>;
  services: Map<string, unknown>;
  pluginNodes: Map<string, ToonPluginNodeHandler>;
  layers: Layer<never, never, never>[];
}> {
  const cached = toonModuleCache.get(absPath);
  if (cached) return cached;
  const promise = (async () => {
    const rawText = readFileSync(absPath, "utf8");
    const data = parseToon(rawText);
    if (!isRecord(data)) {
      throw new Error(`Invalid TOON file: ${absPath}`);
    }
    const baseDir = dirname(absPath);
    const imports = isRecord(data.imports) ? data.imports : {};
    const importSchemas = await resolveImportedSchemas(imports.schemas, baseDir);
    const importServices = await resolveImportedServices(imports.services, baseDir);
    const importPlugins = await resolveImportedPlugins(imports.plugins, baseDir);
    const importComponents = await resolveImportedComponents(imports.components, baseDir);

    const schemas = new Map<string, ToonSchemaEntry>(importSchemas);
    for (const [name, entry] of importComponents.schemas) {
      if (!schemas.has(name)) schemas.set(name, entry);
    }
    if (isRecord(data.schemas)) {
      for (const [name, def] of Object.entries(data.schemas)) {
        if (schemas.has(name)) {
          throw new Error(`Duplicate schema "${name}" in ${absPath}`);
        }
        schemas.set(name, parseSchemaEntry(def, schemas, name));
      }
    }

    const components = new Map<string, ToonComponentDef>(importComponents.components);
    if (isRecord(data.components)) {
      for (const [name, def] of Object.entries(data.components)) {
        if (components.has(name)) {
          throw new Error(`Duplicate component "${name}" in ${absPath}`);
        }
        if (!isRecord(def) || !Array.isArray((def as any).steps)) {
          throw new Error(`Component "${name}" is missing steps`);
        }
        components.set(name, {
          name,
          params: isRecord((def as any).params) ? (def as any).params : undefined,
          steps: (def as any).steps,
        });
      }
    }

    const services = new Map<string, unknown>(importComponents.services);
    for (const [name, value] of importServices) {
      services.set(name, value);
    }
    for (const [name, value] of importPlugins.services) {
      services.set(name, value);
    }

    const pluginNodes = new Map<string, ToonPluginNodeHandler>(importComponents.pluginNodes);
    for (const [kind, handler] of importPlugins.pluginNodes) {
      pluginNodes.set(kind, handler);
    }

    const layers = [...importComponents.layers, ...importPlugins.layers];

    return { schemas, components, services, pluginNodes, layers };
  })();
  toonModuleCache.set(absPath, promise);
  return promise;
}

async function resolveImportedComponents(
  imports: any,
  baseDir: string,
): Promise<{
  components: Map<string, ToonComponentDef>;
  schemas: Map<string, ToonSchemaEntry>;
  services: Map<string, unknown>;
  pluginNodes: Map<string, ToonPluginNodeHandler>;
  layers: Layer<never, never, never>[];
}> {
  const components = new Map<string, ToonComponentDef>();
  const schemas = new Map<string, ToonSchemaEntry>();
  const services = new Map<string, unknown>();
  const pluginNodes = new Map<string, ToonPluginNodeHandler>();
  const layers: Layer<never, never, never>[] = [];
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    const use = coerceUseList(entry?.use);
    if (!from || use.length === 0) continue;
    const resolved = resolveImportPath(from, baseDir);
    const absPath =
      resolved.startsWith(".") || resolved.startsWith("/")
        ? resolved
        : resolve(baseDir, resolved);
    const module = await loadToonModule(absPath);
    for (const [schemaName, schemaEntry] of module.schemas) {
      if (!schemas.has(schemaName)) schemas.set(schemaName, schemaEntry);
    }
    for (const name of use) {
      const def = module.components.get(name);
      if (!def) throw new Error(`Component "${name}" not found in ${from}`);
      components.set(name, def);
    }
    for (const [name, value] of module.services) {
      if (!services.has(name)) services.set(name, value);
    }
    for (const [kind, handler] of module.pluginNodes) {
      if (!pluginNodes.has(kind)) pluginNodes.set(kind, handler);
    }
    if (module.layers.length > 0) {
      layers.push(...module.layers);
    }
  }
  return { components, schemas, services, pluginNodes, layers };
}

function compileNodes(nodes: any[], env: ToonEnv): BuilderNode {
  const compiled: BuilderNode[] = nodes.map((node) => compileNode(node, env));
  if (compiled.length === 1) return compiled[0]!;
  return env.builder.sequence(...compiled);
}

function compileNode(node: any, env: ToonEnv): BuilderNode {
  if (!isRecord(node)) {
    throw new Error("Invalid TOON node");
  }
  const kind = node.kind;
  if (kind === "sequence") {
    const children = Array.isArray(node.children) ? node.children : [];
    return env.builder.sequence(...children.map((child: any) => compileNode(child, env)));
  }
  if (kind === "parallel") {
    const children = Array.isArray(node.children) ? node.children : [];
    const compiled = children.map((child: any) => compileNode(child, env));
    const maxConcurrency = node.maxConcurrency ?? undefined;
    return maxConcurrency === undefined
      ? env.builder.parallel(...compiled)
      : env.builder.parallel(...compiled, { maxConcurrency });
  }
  if (kind === "loop") {
    const children = Array.isArray(node.children) ? node.children : [];
    const childNode = compileNodes(children, env);
    const untilRaw = applyComponentId(node.until ?? "", env.componentId) as string;
    const untilFn = (ctx: Record<string, unknown>) => {
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildTemplateContext(ctx, params, env.componentId);
      return Boolean(evaluateExpression(untilRaw, fullCtx));
    };
    return env.builder.loop({
      id: node.id ? String(applyComponentId(node.id, env.componentId)) : undefined,
      children: childNode,
      until: untilFn,
      maxIterations: typeof node.maxIterations === "number" ? node.maxIterations : undefined,
      onMaxReached: node.onMaxReached === "fail" ? "fail" : node.onMaxReached === "return-last" ? "return-last" : undefined,
    });
  }
  if (kind === "branch") {
    const conditionRaw = applyComponentId(node.condition ?? "", env.componentId) as string;
    const deps = collectDepsFromExpression(conditionRaw, env.seenIds);
    const needs = buildNeedsMap(env, deps);
    const thenNodes = Array.isArray(node.then) ? node.then : [];
    const elseNodes = Array.isArray(node.else) ? node.else : [];
    const thenNode = compileNodes(thenNodes, env);
    const elseNode = elseNodes.length ? compileNodes(elseNodes, env) : undefined;
    return {
      kind: "branch",
      needs,
      condition: (ctx: Record<string, unknown>) => {
        const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
        const fullCtx = buildTemplateContext(ctx, params, env.componentId);
        return Boolean(evaluateExpression(conditionRaw, fullCtx));
      },
      then: thenNode,
      else: elseNode,
    };
  }
  if (kind === "worktree") {
    const children = Array.isArray(node.children) ? node.children : [];
    const childNode = compileNodes(children, env);
    const skipIfRaw = node.skipIf ? String(applyComponentId(node.skipIf, env.componentId)) : undefined;
    const skipDeps = skipIfRaw ? collectDepsFromExpression(skipIfRaw, env.seenIds) : new Set<string>();
    const needs = skipDeps.size ? buildNeedsMap(env, skipDeps) : undefined;
    return {
      kind: "worktree",
      id: node.id ? String(applyComponentId(node.id, env.componentId)) : undefined,
      path: String(node.path ?? ""),
      branch: node.branch ? String(node.branch) : undefined,
      needs,
      skipIf: skipIfRaw
        ? (ctx: Record<string, unknown>) => {
            const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
            const fullCtx = buildTemplateContext(ctx, params, env.componentId);
            return Boolean(evaluateExpression(skipIfRaw, fullCtx));
          }
        : undefined,
      children: childNode,
    };
  }
  if (kind === "workflow") {
    const id = String(applyComponentId(node.id, env.componentId) ?? "");
    if (!id) throw new Error("Workflow node missing id");
    if (env.seenIds.has(id)) throw new Error(`Duplicate step id "${id}"`);
    env.seenIds.add(id);
    const alias = String(node.use ?? "");
    if (!alias) throw new Error(`Workflow step "${id}" is missing "use"`);
    const workflowPath = env.workflows.get(alias);
    if (!workflowPath) throw new Error(`Workflow "${alias}" not found`);
    const inputDef = isRecord(node.input) ? node.input : {};
    const deps = new Set<string>();
    for (const value of Object.values(inputDef)) {
      if (typeof value === "string") {
        const applied = String(applyComponentId(value, env.componentId));
        if (applied.includes("{")) {
          for (const dep of collectDepsFromTemplate(applied, env.seenIds)) deps.add(dep);
        } else {
          for (const dep of collectDepsFromExpression(applied, env.seenIds)) deps.add(dep);
        }
      }
    }
    if (env.componentParamDeps) {
      for (const dep of env.componentParamDeps) deps.add(dep);
    }
    const needs = deps.size ? buildNeedsMap(env, deps) : {};
    const runFn = async (ctx: any) => {
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildRunContext(ctx, params, env.componentId, env.services);
      const input: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(inputDef)) {
        if (typeof value === "string") {
          const applied = String(applyComponentId(value, env.componentId));
          input[key] = applied.includes("{")
            ? resolveTemplateValue(applied, fullCtx)
            : evaluateExpression(applied, fullCtx);
        } else {
          input[key] = value;
        }
      }
      const workflow = await getToonWorkflow(workflowPath);
      return (workflow as any).execute(input, { workflowPath });
    };
    const handle = env.builder.step(id, {
      output: Schema.Unknown,
      run: runFn,
      needs,
    });
    env.handles.set(id, handle);
    return handle;
  }
  if (kind === "component") {
    const instanceId = String(node.id ?? "").trim();
    if (!instanceId) throw new Error("Component instance is missing id");
    const useName = String(node.use ?? "");
    const def = env.components.get(useName);
    if (!def) throw new Error(`Component "${useName}" not found`);
    const withParams = isRecord(node.with) ? node.with : {};
    const appliedParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(withParams)) {
      appliedParams[key] = applyComponentId(value, env.componentId);
    }
    const paramDeps = new Set<string>();
    for (const value of Object.values(appliedParams)) {
      if (typeof value === "string") {
        for (const dep of collectDepsFromTemplate(value, env.seenIds)) paramDeps.add(dep);
      }
    }
    const nextEnv: ToonEnv = {
      ...env,
      componentId: instanceId,
      componentParams: appliedParams,
      componentParamDeps: paramDeps,
    };
    return compileNodes(def.steps, nextEnv);
  }
  if (kind === "approval") {
    const id = String(applyComponentId(node.id, env.componentId) ?? "");
    if (!id) throw new Error("Approval node missing id");
    if (env.seenIds.has(id)) throw new Error(`Duplicate step id "${id}"`);
    env.seenIds.add(id);
    const deps = new Set<string>();
    for (const dep of coerceUseList(node.needs)) {
      deps.add(String(applyComponentId(dep, env.componentId)));
    }
    const titleTemplate = applyComponentId(node.request?.title ?? "", env.componentId) as string;
    const summaryTemplate = node.request?.summary
      ? String(applyComponentId(node.request.summary, env.componentId))
      : undefined;
    for (const dep of collectDepsFromTemplate(titleTemplate, env.seenIds)) deps.add(dep);
    if (summaryTemplate) {
      for (const dep of collectDepsFromTemplate(summaryTemplate, env.seenIds)) deps.add(dep);
    }
    const needs = buildNeedsMap(env, deps);
    const request = (ctx: Record<string, unknown>) => {
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildTemplateContext(ctx, params, env.componentId);
      return {
        title: renderTemplate(titleTemplate, fullCtx),
        summary: summaryTemplate ? renderTemplate(summaryTemplate, fullCtx) : null,
      };
    };
    const handle = env.builder.approval(id, {
      needs,
      request,
      onDeny: node.onDeny === "continue" || node.onDeny === "skip" ? node.onDeny : "fail",
    });
    env.handles.set(id, handle);
    return handle;
  }

  if (typeof kind === "string" && kind.length > 0) {
    const handler = env.pluginNodes.get(kind);
    if (handler) {
      const result = handler(node, env, {
        compileNode,
        compileNodes,
      });
      registerPluginHandles(env, result);
      return result;
    }
    throw new Error(`Unknown TOON node kind "${kind}"`);
  }

  const id = String(applyComponentId(node.id, env.componentId) ?? "");
  if (!id) throw new Error("Step node missing id");
  if (env.seenIds.has(id)) throw new Error(`Duplicate step id "${id}"`);
  env.seenIds.add(id);

  const outputDef = node.output;
  let outputEntry: ToonSchemaEntry | undefined;
  if (typeof outputDef === "string" && env.schemas.has(outputDef)) {
    outputEntry = env.schemas.get(outputDef);
  } else if (outputDef !== undefined) {
    outputEntry = parseSchemaEntry(outputDef, env.schemas, id);
  }
  if (!outputEntry) {
    throw new Error(`Step "${id}" is missing output schema`);
  }

  const prompt = node.prompt !== undefined ? String(applyComponentId(node.prompt, env.componentId)) : undefined;
  const runCode = node.run !== undefined ? String(node.run) : undefined;
  const handlerRef = node.handler !== undefined ? String(node.handler) : undefined;
  const hasPrompt = typeof prompt === "string";
  const hasRun = typeof runCode === "string";
  const hasHandler = typeof handlerRef === "string";

  if ((hasPrompt ? 1 : 0) + (hasRun ? 1 : 0) + (hasHandler ? 1 : 0) !== 1) {
    throw new Error(`Step "${id}" must define exactly one of prompt, run, or handler`);
  }

  const deps = new Set<string>();
  const needsRaw = coerceUseList(node.needs);
  for (const dep of needsRaw) {
    deps.add(String(applyComponentId(dep, env.componentId)));
  }

  if (prompt) {
    for (const dep of collectDepsFromTemplate(prompt, env.seenIds)) deps.add(dep);
  }
  const skipIfRaw = node.skipIf !== undefined ? String(applyComponentId(node.skipIf, env.componentId)) : undefined;
  if (skipIfRaw) {
    for (const dep of collectDepsFromExpression(skipIfRaw, env.seenIds)) deps.add(dep);
  }
  if (env.componentParamDeps) {
    for (const dep of env.componentParamDeps) deps.add(dep);
  }

  let cachePolicy: CachePolicy | undefined;
  if (isRecord(node.cache)) {
    const version =
      node.cache.version !== undefined && node.cache.version !== null
        ? String(node.cache.version)
        : undefined;
    const rawBy = Array.isArray(node.cache.by)
      ? node.cache.by
      : node.cache.by !== undefined
        ? [node.cache.by]
        : [];
    const byEntries = rawBy
      .map((value: any) => String(applyComponentId(value, env.componentId)))
      .filter((value: string) => value.length > 0);
    for (const entry of byEntries) {
      if (entry.includes("{")) {
        for (const dep of collectDepsFromTemplate(entry, env.seenIds)) deps.add(dep);
      } else {
        for (const dep of collectDepsFromExpression(entry, env.seenIds)) deps.add(dep);
      }
    }
    if (byEntries.length > 0 || version) {
      cachePolicy = {
        version,
        by: (ctx: any) => {
          const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
          const fullCtx = buildRunContext(ctx, params, env.componentId, env.services);
          const payload: Record<string, unknown> = {};
          for (const entry of byEntries) {
            payload[entry] = entry.includes("{")
              ? resolveTemplateValue(entry, fullCtx)
              : evaluateExpression(entry, fullCtx);
          }
          return payload;
        },
      };
    }
  }

  const needs = deps.size ? buildNeedsMap(env, deps) : {};

  let runFn: (ctx: any) => any;
  if (hasPrompt) {
    const agentName = String(node.agent ?? "");
    if (!agentName) {
      throw new Error(`Prompt step "${id}" requires an agent`);
    }
    const agent = env.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent "${agentName}" not found for step "${id}"`);
    }
    const timeoutMs = durationToMs(node.timeout);
    runFn = async (ctx: any) => {
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildTemplateContext(ctx, params, env.componentId);
      const renderedPrompt = renderTemplate(prompt, fullCtx);
      const finalPrompt = buildPromptInstructions(renderedPrompt, outputEntry!.jsonSchema);
      const result = await agent.generate({
        prompt: finalPrompt,
        abortSignal: ctx.signal,
        timeout: timeoutMs ? { totalMs: timeoutMs } : undefined,
      });
      return extractAgentOutput(result);
    };
  } else if (hasRun) {
    const fn = createRunFunction(runCode!);
    runFn = async (ctx: any) => {
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildRunContext(ctx, params, env.componentId, env.services);
      return await fn(fullCtx);
    };
  } else {
    const handler = parseHandlerRef(handlerRef!, env.baseDir);
    let cached: { mod?: any; fn?: any } = {};
    runFn = async (ctx: any) => {
      if (!cached.fn) {
        const mod = await importModule(handler.modulePath, env.baseDir);
        const fn = handler.exportName ? mod[handler.exportName] : mod.default;
        if (typeof fn !== "function") {
          throw new Error(`Handler "${handlerRef}" did not export a function`);
        }
        cached.mod = mod;
        cached.fn = fn;
      }
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildRunContext(ctx, params, env.componentId, env.services);
      return await cached.fn(fullCtx);
    };
  }

  // Support retry as: number, {maxAttempts, backoff, initialDelay}, or flat maxAttempts field
  const retrySource = node.retry;
  const flatMaxAttempts = typeof node.maxAttempts === "number" ? node.maxAttempts : undefined;
  const retryCount =
    typeof retrySource === "number"
      ? Math.max(0, Math.floor(retrySource))
      : typeof retrySource?.maxAttempts === "number"
        ? Math.max(0, Math.floor(retrySource.maxAttempts - 1))
        : flatMaxAttempts !== undefined
          ? Math.max(0, Math.floor(flatMaxAttempts - 1))
          : undefined;
  const retryPolicy: RetryPolicy | undefined =
    retrySource && typeof retrySource === "object"
      ? {
          backoff:
            retrySource.backoff === "exponential" ||
            retrySource.backoff === "linear" ||
            retrySource.backoff === "fixed"
              ? retrySource.backoff
              : undefined,
          initialDelayMs: durationToMs(retrySource.initialDelay) ?? undefined,
        }
      : undefined;

  const handle = env.builder.step(id, {
    output: outputEntry.schema,
    run: runFn,
    needs,
    retry: retryCount,
    retryPolicy,
    timeout: node.timeout,
    cache: cachePolicy,
    skipIf: skipIfRaw
      ? (ctx: any) => {
          const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
          const fullCtx = buildTemplateContext(ctx, params, env.componentId);
          return Boolean(evaluateExpression(skipIfRaw, fullCtx));
        }
      : undefined,
  });
  env.handles.set(id, handle);
  return handle;
}

async function compileToon(absPath: string): Promise<{
  name: string;
  inputSchema: AnySchema;
  buildGraph: (builder: BuilderApi) => BuilderNode;
  pluginLayers: Layer<never, never, never>[];
}> {
  const rawText = readFileSync(absPath, "utf8");
  const data = parseToon(rawText);
  if (!isRecord(data)) {
    throw new Error(`Invalid TOON file: ${absPath}`);
  }
  const name = String(data.name ?? "").trim();
  if (!name) throw new Error(`TOON workflow missing name: ${absPath}`);
  const baseDir = dirname(absPath);

  const imports = isRecord(data.imports) ? data.imports : {};
  const importedSchemas = await resolveImportedSchemas(imports.schemas, baseDir);
  const importedServices = await resolveImportedServices(imports.services, baseDir);
  const importedAgents = await resolveImportedAgents(imports.agents, baseDir);
  const importedComponents = await resolveImportedComponents(imports.components, baseDir);
  const importedWorkflows = await resolveImportedWorkflows(imports.workflows, baseDir);
  const importedPlugins = await resolveImportedPlugins(imports.plugins, baseDir);

  const schemas = new Map<string, ToonSchemaEntry>(importedSchemas);
  for (const [schemaName, schemaEntry] of importedComponents.schemas) {
    if (!schemas.has(schemaName)) schemas.set(schemaName, schemaEntry);
  }
  if (isRecord(data.schemas)) {
    for (const [schemaName, def] of Object.entries(data.schemas)) {
      if (schemas.has(schemaName)) {
        throw new Error(`Duplicate schema "${schemaName}" in ${absPath}`);
      }
      schemas.set(schemaName, parseSchemaEntry(def, schemas, schemaName));
    }
  }

  const components = new Map<string, ToonComponentDef>(importedComponents.components);
  if (isRecord(data.components)) {
    for (const [compName, def] of Object.entries(data.components)) {
      if (components.has(compName)) {
        throw new Error(`Duplicate component "${compName}" in ${absPath}`);
      }
      if (!isRecord(def) || !Array.isArray((def as any).steps)) {
        throw new Error(`Component "${compName}" is missing steps`);
      }
      components.set(compName, {
        name: compName,
        params: isRecord((def as any).params) ? (def as any).params : undefined,
        steps: (def as any).steps,
      });
    }
  }

  const agents = new Map<string, AgentLike>(importedAgents);
  if (isRecord(data.agents)) {
    // Object form: agents: { name: { type, model, ... } }
    for (const [agentName, def] of Object.entries(data.agents)) {
      if (!isRecord(def)) {
        throw new Error(`Agent "${agentName}" definition must be an object`);
      }
      const agent = await buildAgentFromConfig(agentName, def);
      agents.set(agentName, agent);
    }
  } else if (Array.isArray(data.agents)) {
    // Tabular form: agents[N]{name,type,model,...}: rows
    for (const row of data.agents) {
      if (!isRecord(row) || typeof row.name !== "string") {
        throw new Error(`Agent array entry must have a "name" field`);
      }
      const agentName = row.name;
      const def = { ...row };
      delete (def as any).name;
      const agent = await buildAgentFromConfig(agentName, def);
      agents.set(agentName, agent);
    }
  }

  const services = new Map<string, unknown>(importedComponents.services);
  for (const [name, value] of importedServices) {
    services.set(name, value);
  }
  for (const [name, value] of importedPlugins.services) {
    services.set(name, value);
  }

  const workflows = new Map<string, string>(importedWorkflows);

  const pluginNodes = new Map<string, ToonPluginNodeHandler>(importedComponents.pluginNodes);
  for (const [kind, handler] of importedPlugins.pluginNodes) {
    pluginNodes.set(kind, handler);
  }
  const pluginLayers = [
    ...importedComponents.layers,
    ...importedPlugins.layers,
  ];

  const inputDef = data.input;
  if (!inputDef) throw new Error(`TOON workflow "${name}" missing input schema`);
  const inputSchema = typeof inputDef === "string" && schemas.has(inputDef)
    ? schemas.get(inputDef)!.schema
    : parseSchemaEntry(inputDef, schemas, "input").schema;

  const steps = Array.isArray(data.steps) ? data.steps : [];
  if (steps.length === 0) {
    throw new Error(`TOON workflow "${name}" has no steps`);
  }
  const buildGraph = (builder: BuilderApi) => {
    const env: ToonEnv = {
      builder,
      handles: new Map<string, BuilderStepHandle>(),
      seenIds: new Set<string>(),
      schemas,
      agents,
      components,
      services,
      workflows,
      pluginNodes,
      baseDir,
    };
    return compileNodes(steps, env);
  };

  return { name, inputSchema, buildGraph, pluginLayers };
}

const toonWorkflowCache = new Map<string, Promise<BuiltSmithersWorkflow>>();

function getToonWorkflow(path: string): Promise<BuiltSmithersWorkflow> {
  const absPath = resolve(process.cwd(), path);
  const cached = toonWorkflowCache.get(absPath);
  if (cached) return cached;
  const promise = compileToon(absPath).then((compiled) => {
    const workflow = createWorkflow({ name: compiled.name, input: compiled.inputSchema }).build(
      ($) => compiled.buildGraph($),
    );
    if (compiled.pluginLayers.length === 0) return workflow;
    const merged = Layer.mergeAll(...compiled.pluginLayers);
    return {
      execute: (input: unknown, opts?: Omit<Parameters<typeof runWorkflow>[1], "input">) =>
        workflow.execute(input, opts).pipe(Effect.provide(merged)),
    } as BuiltSmithersWorkflow;
  });
  toonWorkflowCache.set(absPath, promise);
  return promise;
}

function createComponent(options: { name: string; params?: Record<string, unknown> }) {
  return {
    build(
      buildGraph: ($: BuilderApi, params: Record<string, unknown>) => BuilderNode,
    ): ComponentDefinition {
      return {
        kind: "component-definition",
        name: options.name,
        buildWithPrefix(prefix: string, params: Record<string, unknown>) {
          return buildGraph(createBuilder(prefix), params);
        },
      };
    },
  };
}

function sqlite(options: SmithersSqliteOptions) {
  return Layer.succeed(SmithersSqlite, options);
}

function loadToon(path: string): BuiltSmithersWorkflow {
  return {
    execute(input: unknown, opts?: Omit<Parameters<typeof runWorkflow>[1], "input">) {
      return Effect.gen(function* () {
        const workflow = yield* Effect.promise(() => getToonWorkflow(path));
        return yield* (workflow as any).execute(input, opts);
      });
    },
  };
}

export const Smithers = {
  workflow: createWorkflow,
  component: createComponent,
  sqlite,
  loadToon,
};

export type { ComponentDefinition };
