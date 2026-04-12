import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, desc, eq } from "drizzle-orm";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Schedule,
  Schema,
} from "effect";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import React from "react";
import type { CachePolicy } from "@smithers/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";
import { SmithersDb } from "@smithers/db/adapter";
import { runWorkflow } from "../index";
import { ignoreSyncError } from "@smithers/driver/interop";
import { requireTaskRuntime } from "@smithers/driver/task-runtime";
import {
  Branch,
  Loop,
  Parallel,
  Sequence,
  Task,
  Worktree,
  Workflow,
} from "@smithers/components/components/index";
import { camelToSnake } from "@smithers/db/utils/camelToSnake";
import { SmithersError } from "@smithers/errors/SmithersError";

type AnySchema = any;
type AnyEffect = any;

type BuilderStepContext = Record<string, unknown> & {
  input: unknown;
  executionId: string;
  stepId: string;
  attempt: number;
  signal: AbortSignal;
  iteration: number;
  heartbeat: (data?: unknown) => void;
  lastHeartbeat: unknown | null;
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
    throw new SmithersError("MISSING_OUTPUT", `Missing output for step "${handle.id}"`, {
      nodeId: handle.id,
    });
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
    heartbeat: runtime?.heartbeat ?? (() => {}),
    lastHeartbeat: runtime?.lastHeartbeat ?? null,
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
    heartbeat: runtime?.heartbeat ?? (() => {}),
    lastHeartbeat: runtime?.lastHeartbeat ?? null,
    loop: { iteration: iteration + 1 },
  };
}

async function resolveEffectResult(
  value: unknown,
  env: any,
  signal: AbortSignal,
) {
  if ((Effect as any).isEffect?.(value)) {
    return await Effect.runPromise(
      (value as any).pipe(Effect.provide(env)),
      { signal },
    );
  }
  if (value && typeof (value as PromiseLike<unknown>).then === "function") {
    const resolved = await value;
    if ((Effect as any).isEffect?.(resolved)) {
      return await Effect.runPromise(
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
      decidedAt: null,
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

function assertUniqueHandleIds(handles: BuilderStepHandle[]) {
  const seen = new Set<string>();
  for (const handle of handles) {
    if (seen.has(handle.id)) {
      throw new SmithersError("DUPLICATE_ID", `Duplicate step id "${handle.id}"`, {
        kind: handle.kind,
        id: handle.id,
      });
    }
    seen.add(handle.id);
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
        throw new SmithersError("NESTED_LOOP", "Nested builder loops are not supported.");
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
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA busy_timeout = 5000");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run(
    `CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`,
  );
  for (const handle of handles) {
    sqlite.run(
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
    return new SmithersError("WORKFLOW_EXECUTION_FAILED", result.error, {
      status: result.status,
    });
  }
  return new SmithersError(
    "WORKFLOW_EXECUTION_FAILED",
    `Workflow execution ended with status "${result.status}"`,
    { status: result.status },
  );
}

type BuiltSmithersWorkflow = {
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
      assertUniqueHandleIds(handles);

      return {
        execute(input: unknown, opts?: Omit<Parameters<typeof runWorkflow>[1], "input">) {
          return Effect.gen(function* () {
            const env = yield* Effect.context<any>();
            const sqliteConfig = yield* SmithersSqlite;
            const decodedInput = decodeSchema(options.input, input);
            const encodedInput = JSON.parse(
              JSON.stringify(encodeSchema(options.input, decodedInput) ?? {}),
            ) as Record<string, unknown>;

            return yield* Effect.acquireUseRelease(
              Effect.sync(() => createBuilderDb(sqliteConfig.filename, handles)),
              (runtime) =>
                Effect.promise(async () => {
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

                  const result = await Effect.runPromise(runWorkflow(workflow, {
                    ...opts,
                    input: encodedInput as Record<string, unknown>,
                  }));

                  if (result.status === "finished") {
                    return await extractResult(root, runtime.db, result.runId, decodedInput);
                  }
                  if (
                    result.status === "waiting-approval" ||
                    result.status === "waiting-timer"
                  ) {
                    return result;
                  }
                  throw normalizeExecutionError(result);
                }),
              (runtime) => ignoreSyncError("close builder sqlite", () => runtime.sqlite.close()),
            );
          });
        },
      };
    },
  };
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

export const Smithers = {
  sqlite,
};
