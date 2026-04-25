import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createExecutableDir, createTempRepo, prependPath, runSmithers, writeExecutable, } from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * @param {string} dbPath
 */
function openRepoDb(dbPath) {
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        sqlite,
        adapter: new SmithersDb(db),
    };
}

test("chat create starts an auto-hijacked run and returns JSON metadata", async () => {
    const repo = createTempRepo();
    repo.write("workspace/.gitkeep", "\n");
    const launchFile = repo.path("chat-create-launch.json");
    const binDir = createExecutableDir();
    writeExecutable(binDir, "codex", [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        'const target = process.env.SMITHERS_CHAT_CREATE_FILE;',
        'if (target) writeFileSync(target, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }), "utf8");',
        'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "chat-thread-1" }) + "\\n");',
        "setInterval(() => {}, 1000);",
        "",
    ].join("\n"));
    const result = runSmithers([
        "chat",
        "create",
        "--agent",
        "codex",
        "--cwd",
        "workspace",
    ], {
        cwd: repo.dir,
        format: "json",
        env: {
            ...prependPath(binDir),
            SMITHERS_CHAT_CREATE_FILE: launchFile,
        },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
        workflowName: "chat",
        agent: "codex",
    });
    expect(typeof result.json?.runId).toBe("string");
    const launched = JSON.parse(repo.read("chat-create-launch.json"));
    expect(launched.cwd).toBe(repo.path("workspace"));
    const { sqlite, adapter } = openRepoDb(repo.path("workspace", "smithers.db"));
    try {
        const run = await adapter.getRun(result.json.runId);
        expect(run).toMatchObject({
            runId: result.json.runId,
            workflowName: "chat",
            status: "cancelled",
        });
        const attempts = await adapter.listAttempts(result.json.runId, "chat", 0);
        expect(attempts).toHaveLength(1);
        const meta = JSON.parse(attempts[0].metaJson);
        expect(meta.agentEngine).toBe("codex");
        expect(meta.agentResume).toBe("chat-thread-1");
        expect(meta.hijackHandoff).toMatchObject({
            engine: "codex",
            mode: "native-cli",
            resume: "chat-thread-1",
        });
    }
    finally {
        sqlite.close();
    }
});
