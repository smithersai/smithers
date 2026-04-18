import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { renderPrettyOutput, runOutputOnce } from "../src/output.js";

function makeStream() {
    let out = "";
    return {
        write(chunk) { out += String(chunk); },
        get value() { return out; },
    };
}

async function openMemoryDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { sqlite, adapter: new SmithersDb(db) };
}

describe("renderPrettyOutput", () => {
    test("returns (pending) when row is null and status pending", () => {
        expect(renderPrettyOutput({ status: "pending", row: null, schema: null })).toBe("(pending)");
    });
    test("returns (failed) when row is null and status failed", () => {
        expect(renderPrettyOutput({ status: "failed", row: null, schema: null })).toBe("(failed)");
    });
    test("renders schema fields in declared order", () => {
        const response = {
            status: "produced",
            row: { c: 3, a: 1, b: 2 },
            schema: { fields: [
                { name: "a", type: "number", optional: false, nullable: false },
                { name: "b", type: "number", optional: false, nullable: false },
                { name: "c", type: "number", optional: false, nullable: false },
            ] },
        };
        const rendered = renderPrettyOutput(response);
        const lines = rendered.split("\n");
        expect(lines[0]).toBe("a: 1");
        expect(lines[1]).toBe("b: 2");
        expect(lines[2]).toBe("c: 3");
    });
    test("appends extra row keys after declared schema fields", () => {
        const response = {
            status: "produced",
            row: { a: 1, extra: "hi" },
            schema: { fields: [
                { name: "a", type: "number", optional: false, nullable: false },
            ] },
        };
        const rendered = renderPrettyOutput(response);
        expect(rendered).toBe("a: 1\nextra: hi");
    });
});

describe("runOutputOnce", () => {
    test("maps InvalidRunId to exit 1", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runOutputOnce({
                adapter,
                runId: "!!bad!!",
                nodeId: "task-a",
                json: true,
                pretty: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("InvalidRunId");
        } finally {
            sqlite.close();
        }
    });

    test("maps RunNotFound to exit 1", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runOutputOnce({
                adapter,
                runId: "missing-run",
                nodeId: "task-a",
                json: true,
                pretty: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("RunNotFound");
        } finally {
            sqlite.close();
        }
    });
});
