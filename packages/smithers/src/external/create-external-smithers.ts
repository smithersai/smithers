import React from "react";
import type { SmithersWorkflow } from "@smithers/react/SmithersWorkflow";
import type { SmithersCtx } from "@smithers/driver/SmithersCtx";
import type { SchemaRegistryEntry } from "@smithers/core/SchemaRegistryEntry";
import type { AgentLike } from "@smithers/core/AgentLike";
import type { OutputSnapshot } from "@smithers/driver/OutputSnapshot";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { zodToTable } from "@smithers/db/zodToTable";
import { zodToCreateTableSQL } from "@smithers/db/zodToCreateTableSQL";
import { camelToSnake } from "@smithers/db/utils/camelToSnake";
import { SmithersError } from "@smithers/errors/SmithersError";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { z } from "zod";

export type SerializedCtx = {
  runId: string;
  iteration: number;
  iterations: Record<string, number>;
  input: any;
  outputs: OutputSnapshot;
};

export type HostNodeJson =
  | { kind: "element"; tag: string; props: Record<string, string>; rawProps: Record<string, any>; children: HostNodeJson[] }
  | { kind: "text"; text: string };

export type ExternalSmithersConfig<S extends Record<string, z.ZodObject<any>>> = {
  schemas: S;
  agents: Record<string, AgentLike>;
  /** Synchronous build function that returns a HostNode JSON tree. */
  buildFn: (ctx: SerializedCtx) => HostNodeJson;
  dbPath?: string;
};

/**
 * Serialize a SmithersCtx into a plain JSON-safe object for external processes.
 */
export function serializeCtx(ctx: SmithersCtx<any>): SerializedCtx {
  const outputs: OutputSnapshot = {};
  const outputsFn = ctx.outputs as any;
  if (outputsFn && typeof outputsFn === "function") {
    for (const key of Object.keys(outputsFn)) {
      if (Array.isArray(outputsFn[key])) {
        outputs[key] = outputsFn[key];
      }
    }
  }

  return {
    runId: ctx.runId,
    iteration: ctx.iteration,
    iterations: ctx.iterations ?? {},
    input: ctx.input,
    outputs,
  };
}

/**
 * Convert a HostNodeJson tree to React elements, resolving string agent references.
 */
export function hostNodeToReact(
  node: HostNodeJson,
  agents: Record<string, AgentLike>,
): React.ReactNode {
  if (node.kind === "text") return node.text;

  const rawProps = { ...node.rawProps };

  if (typeof rawProps.agent === "string") {
    const agentName = rawProps.agent;
    const resolved = agents[agentName];
    if (!resolved) {
      throw new SmithersError(
        "UNKNOWN_AGENT",
        `Task "${rawProps.id ?? "?"}" references agent "${agentName}" which is not in the agents registry. Available: ${Object.keys(agents).join(", ") || "(none)"}`,
      );
    }
    rawProps.agent = resolved;
  }

  const children = node.children.map((child) => hostNodeToReact(child, agents));
  return React.createElement(node.tag, rawProps, ...children);
}

/**
 * Create a SmithersWorkflow from an external build function (e.g. Python subprocess).
 *
 * Schemas and agents are defined in TS. The build function produces a HostNode JSON tree
 * that maps 1:1 to what the JSX renderer would produce.
 */
export function createExternalSmithers<S extends Record<string, z.ZodObject<any>>>(
  config: ExternalSmithersConfig<S>,
): SmithersWorkflow<S> & { tables: Record<string, any>; cleanup: () => void } {
  const { schemas, agents, buildFn } = config;

  const dbPath = config.dbPath
    ? resolve(config.dbPath)
    : join(mkdtempSync(join(tmpdir(), "smithers-ext-")), "smithers.db");

  const sqlite = new Database(dbPath);
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA busy_timeout = 5000");
  sqlite.run("PRAGMA foreign_keys = ON");

  let dbClosed = false;
  const closeDb = () => {
    if (dbClosed) return;
    dbClosed = true;
    try { sqlite.close(); } catch {}
  };
  process.on("exit", closeDb);

  const inputTable = sqliteTable("input", {
    runId: text("run_id").primaryKey(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
  });
  sqlite.exec(`CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`);

  const tables: Record<string, any> = {};
  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue;
    const tableName = camelToSnake(name);
    tables[name] = zodToTable(tableName, zodSchema);
    sqlite.run(zodToCreateTableSQL(tableName, zodSchema));
  }

  const drizzleSchema: Record<string, any> = { input: inputTable };
  for (const [key, table] of Object.entries(tables)) {
    drizzleSchema[key] = table;
  }
  const db = drizzle(sqlite, { schema: drizzleSchema });

  const schemaRegistry = new Map<string, SchemaRegistryEntry>();
  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue;
    schemaRegistry.set(name, { table: tables[name], zodSchema });
  }

  const zodToKeyName = new Map<z.ZodObject<any>, string>();
  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue;
    zodToKeyName.set(zodSchema, name);
  }

  return {
    db,
    build: (ctx: SmithersCtx<S>) => {
      const serialized = serializeCtx(ctx);
      const hostNode = buildFn(serialized);
      return hostNodeToReact(hostNode, agents) as React.ReactElement;
    },
    opts: {},
    schemaRegistry,
    zodToKeyName,
    tables,
    cleanup: closeDb,
  } as SmithersWorkflow<S> & { tables: Record<string, any>; cleanup: () => void };
}
