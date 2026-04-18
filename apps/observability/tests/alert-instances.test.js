import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";
const ALERT_CLI_TIMEOUT_MS = 15_000;
function createAdapter() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        sqlite,
        adapter: new SmithersDb(db),
    };
}
/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        sqlite,
        adapter: new SmithersDb(db),
    };
}
/**
 * @param {Partial<AlertRow>} [overrides]
 * @returns {AlertRow}
 */
function alertRow(overrides = {}) {
    return {
        alertId: "alert-1",
        runId: "run-1",
        policyName: "run_failed",
        severity: "critical",
        status: "firing",
        firedAtMs: 1_000,
        resolvedAtMs: null,
        acknowledgedAtMs: null,
        message: "Run failed",
        detailsJson: '{"source":"test"}',
        fingerprint: null,
        nodeId: null,
        iteration: null,
        owner: null,
        runbook: null,
        labelsJson: null,
        reactionJson: null,
        sourceEventType: null,
        firstFiredAtMs: null,
        lastFiredAtMs: null,
        occurrenceCount: 1,
        silencedUntilMs: null,
        acknowledgedBy: null,
        resolvedBy: null,
        ...overrides,
    };
}
describe("alert persistence", () => {
    test("insertAlert and getAlert round-trip", async () => {
        const { sqlite, adapter } = createAdapter();
        try {
            const row = alertRow();
            const inserted = await adapter.insertAlert(row);
            const alert = await adapter.getAlert(row.alertId);
            expect(inserted).toEqual(row);
            expect(alert).toEqual(row);
        }
        finally {
            sqlite.close();
        }
    });
    test("listAlerts orders active alerts ahead of resolved alerts", async () => {
        const { sqlite, adapter } = createAdapter();
        try {
            await adapter.insertAlert(alertRow({
                alertId: "resolved-alert",
                status: "resolved",
                firedAtMs: 1_000,
                resolvedAtMs: 2_000,
            }));
            await adapter.insertAlert(alertRow({
                alertId: "active-alert",
                policyName: "approval_wait_exceeded",
                severity: "warning",
                firedAtMs: 3_000,
                message: "Approval has been waiting too long",
            }));
            const allAlerts = await adapter.listAlerts();
            const activeAlerts = await adapter.listAlerts(100, ["firing", "acknowledged", "silenced"]);
            expect(allAlerts.map((alert) => alert.alertId)).toEqual([
                "active-alert",
                "resolved-alert",
            ]);
            expect(activeAlerts.map((alert) => alert.alertId)).toEqual(["active-alert"]);
        }
        finally {
            sqlite.close();
        }
    });
    test("acknowledgeAlert, silenceAlert, and resolveAlert transition alert state", async () => {
        const { sqlite, adapter } = createAdapter();
        try {
            await adapter.insertAlert(alertRow({ alertId: "ack-alert" }));
            await adapter.insertAlert(alertRow({ alertId: "silence-alert" }));
            await adapter.insertAlert(alertRow({ alertId: "resolve-alert" }));
            const acknowledged = await adapter.acknowledgeAlert("ack-alert", 5_000);
            const silenced = await adapter.silenceAlert("silence-alert");
            const resolved = await adapter.resolveAlert("resolve-alert", 7_000);
            expect(acknowledged?.status).toBe("acknowledged");
            expect(acknowledged?.acknowledgedAtMs).toBe(5_000);
            expect(silenced?.status).toBe("silenced");
            expect(silenced?.resolvedAtMs).toBeNull();
            expect(resolved?.status).toBe("resolved");
            expect(resolved?.resolvedAtMs).toBe(7_000);
        }
        finally {
            sqlite.close();
        }
    });
});
describe("smithers alerts CLI", () => {
    test("alerts list shows only active alerts", async () => {
        const repo = createTempRepo();
        const { sqlite, adapter } = openRepoDb(repo);
        try {
            await adapter.insertAlert(alertRow({
                alertId: "cli-firing",
                message: "CLI firing alert",
                firedAtMs: Date.now() - 5_000,
            }));
            await adapter.insertAlert(alertRow({
                alertId: "cli-silenced",
                status: "silenced",
                message: "CLI silenced alert",
                firedAtMs: Date.now() - 4_000,
            }));
            await adapter.insertAlert(alertRow({
                alertId: "cli-resolved",
                status: "resolved",
                message: "CLI resolved alert",
                firedAtMs: Date.now() - 3_000,
                resolvedAtMs: Date.now() - 1_000,
            }));
            const humanResult = runSmithers(["alerts", "list"], {
                cwd: repo.dir,
                format: null,
            });
            expect(humanResult.exitCode).toBe(0);
            expect(humanResult.stdout).toContain("cli-firing");
            expect(humanResult.stdout).toContain("cli-silenced");
            expect(humanResult.stdout).not.toContain("cli-resolved");
            const jsonResult = runSmithers(["alerts", "list"], {
                cwd: repo.dir,
                format: "json",
            });
            expect(jsonResult.exitCode).toBe(0);
            const payload = jsonResult.json;
            expect(payload.alerts?.map((alert) => alert.alertId)).toEqual([
                "cli-firing",
                "cli-silenced",
            ]);
        }
        finally {
            sqlite.close();
        }
    }, ALERT_CLI_TIMEOUT_MS);
    test("alerts ack, silence, and resolve update persisted alert status", async () => {
        const repo = createTempRepo();
        const { sqlite, adapter } = openRepoDb(repo);
        try {
            await adapter.insertAlert(alertRow({ alertId: "cli-ack" }));
            await adapter.insertAlert(alertRow({ alertId: "cli-silence" }));
            await adapter.insertAlert(alertRow({ alertId: "cli-resolve" }));
            const ackResult = runSmithers(["alerts", "ack", "cli-ack"], {
                cwd: repo.dir,
                format: "json",
            });
            expect(ackResult.exitCode).toBe(0);
            expect(ackResult.json?.status).toBe("acknowledged");
            const silenceResult = runSmithers(["alerts", "silence", "cli-silence"], {
                cwd: repo.dir,
                format: "json",
            });
            expect(silenceResult.exitCode).toBe(0);
            expect(silenceResult.json?.status).toBe("silenced");
            const resolveResult = runSmithers(["alerts", "resolve", "cli-resolve"], {
                cwd: repo.dir,
                format: "json",
            });
            expect(resolveResult.exitCode).toBe(0);
            expect(resolveResult.json?.status).toBe("resolved");
            expect((await adapter.getAlert("cli-ack"))?.status).toBe("acknowledged");
            expect((await adapter.getAlert("cli-ack"))?.acknowledgedAtMs).toEqual(expect.any(Number));
            expect((await adapter.getAlert("cli-silence"))?.status).toBe("silenced");
            expect((await adapter.getAlert("cli-resolve"))?.status).toBe("resolved");
            expect((await adapter.getAlert("cli-resolve"))?.resolvedAtMs).toEqual(expect.any(Number));
        }
        finally {
            sqlite.close();
        }
    }, ALERT_CLI_TIMEOUT_MS);
});
