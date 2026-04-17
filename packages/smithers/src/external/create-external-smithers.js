// @smithers-type-exports-begin
/**
 * @template S
 * @typedef {import("./ExternalSmithersConfig.ts").ExternalSmithersConfig<S>} ExternalSmithersConfig
 */
/** @typedef {import("./HostNodeJson.ts").HostNodeJson} HostNodeJson */
/** @typedef {import("./SerializedCtx.ts").SerializedCtx} SerializedCtx */
// @smithers-type-exports-end

import React from "react";
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
/** @typedef {import("@smithers/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("@smithers/components/SmithersWorkflow").SmithersWorkflow<any>} SmithersWorkflow */
/**
 * Serialize a SmithersCtx into a plain JSON-safe object for external processes.
 * @param {import("@smithers/driver/SmithersCtx").SmithersCtx<any>} ctx
 * @returns {SerializedCtx}
 */
export function serializeCtx(ctx) {
    const outputs = {};
    const outputsFn = ctx.outputs;
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
 * @param {HostNodeJson} node
 * @param {Record<string, AgentLike>} agents
 * @returns {React.ReactNode}
 */
export function hostNodeToReact(node, agents) {
    if (node.kind === "text")
        return node.text;
    const rawProps = { ...node.rawProps };
    if (typeof rawProps.agent === "string") {
        const agentName = rawProps.agent;
        const resolved = agents[agentName];
        if (!resolved) {
            throw new SmithersError("UNKNOWN_AGENT", `Task "${rawProps.id ?? "?"}" references agent "${agentName}" which is not in the agents registry. Available: ${Object.keys(agents).join(", ") || "(none)"}`);
        }
        rawProps.agent = resolved;
    }
    const children = node.children.map((child) => hostNodeToReact(child, agents));
    return React.createElement(node.tag, rawProps, ...children);
}
/**
 * Create a SmithersWorkflow from an external build function.
 *
 * Schemas and agents are defined in TS. The build function produces a HostNode JSON tree
 * that maps 1:1 to what the JSX renderer would produce.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} S
 * @param {ExternalSmithersConfig<S>} config
 * @returns {import("@smithers/components/SmithersWorkflow").SmithersWorkflow<S> & { tables: Record<string, any>; cleanup: () => void }}
 */
export function createExternalSmithers(config) {
    const { schemas, agents, buildFn } = config;
    const dbPath = config.dbPath
        ? resolve(config.dbPath)
        : join(mkdtempSync(join(tmpdir(), "smithers-ext-")), "smithers.db");
    const sqlite = new Database(dbPath);
    sqlite.run("PRAGMA journal_mode = WAL");
    // 30s timeout: concurrent worktrees each spawn agent processes that all write
    // to smithers.db simultaneously. 5s is too short and causes SQLITE_IOERR_VNODE
    // on macOS when the VFS can't acquire the WAL shared-memory lock in time.
    sqlite.run("PRAGMA busy_timeout = 30000");
    // NORMAL is safe in WAL mode (no data loss on crash) and reduces fsync
    // stalls that contribute to WAL checkpoint contention across processes.
    sqlite.run("PRAGMA synchronous = NORMAL");
    // Ensure no exclusive lock is held, allowing multiple readers/writers.
    sqlite.run("PRAGMA locking_mode = NORMAL");
    sqlite.run("PRAGMA foreign_keys = ON");
    let dbClosed = false;
    const closeDb = () => {
        if (dbClosed)
            return;
        dbClosed = true;
        try {
            sqlite.close();
        }
        catch { }
    };
    process.on("exit", closeDb);
    const inputTable = sqliteTable("input", {
        runId: text("run_id").primaryKey(),
        payload: text("payload", { mode: "json" }).$type(),
    });
    sqlite.exec(`CREATE TABLE IF NOT EXISTS "input" (run_id TEXT PRIMARY KEY, payload TEXT)`);
    const tables = {};
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        const tableName = camelToSnake(name);
        tables[name] = zodToTable(tableName, zodSchema);
        sqlite.run(zodToCreateTableSQL(tableName, zodSchema));
    }
    const drizzleSchema = { input: inputTable };
    for (const [key, table] of Object.entries(tables)) {
        drizzleSchema[key] = table;
    }
    const db = drizzle(sqlite, { schema: drizzleSchema });
    const schemaRegistry = new Map();
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        schemaRegistry.set(name, { table: tables[name], zodSchema });
    }
    const zodToKeyName = new Map();
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        zodToKeyName.set(zodSchema, name);
    }
    return {
        db,
        build: (ctx) => {
            const serialized = serializeCtx(ctx);
            const hostNode = buildFn(serialized);
            return hostNodeToReact(hostNode, agents);
        },
        opts: {},
        schemaRegistry,
        zodToKeyName,
        tables,
        cleanup: closeDb,
    };
}
