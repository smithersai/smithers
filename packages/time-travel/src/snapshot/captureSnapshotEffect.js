import { Effect, Metric } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { createHash } from "node:crypto";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { smithersSnapshots } from "../schema.js";
import { snapshotsCaptured } from "../snapshotsCaptured.js";
import { snapshotDuration } from "../snapshotDuration.js";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("./Snapshot.ts").Snapshot} Snapshot */
/** @typedef {import("./SnapshotData.ts").SnapshotData} SnapshotData */

/**
 * @param {SnapshotData} data
 * @returns {string}
 */
function serializeSnapshotContent(data) {
    return JSON.stringify({
        nodes: data.nodes,
        outputs: data.outputs,
        ralph: data.ralph,
        input: data.input,
    });
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {SnapshotData} data
 * @returns {Effect.Effect<Snapshot, SmithersError>}
 */
export function captureSnapshot(adapter, runId, frameNo, data) {
    return Effect.gen(function* () {
        const start = performance.now();
        const nodesJson = JSON.stringify(data.nodes);
        const outputsJson = JSON.stringify(data.outputs);
        const ralphJson = JSON.stringify(data.ralph);
        const inputJson = JSON.stringify(data.input);
        const contentHash = createHash("sha256").update(serializeSnapshotContent(data)).digest("hex");
        const ts = nowMs();
        const row = {
            runId,
            frameNo,
            nodesJson,
            outputsJson,
            ralphJson,
            inputJson,
            vcsPointer: data.vcsPointer ?? null,
            workflowHash: data.workflowHash ?? null,
            contentHash,
            createdAtMs: ts,
        };
        yield* Effect.tryPromise({
            try: () => adapter.db
                .insert(smithersSnapshots)
                .values(row)
                .onConflictDoUpdate({
                target: [smithersSnapshots.runId, smithersSnapshots.frameNo],
                set: row,
            }),
            catch: (cause) => toSmithersError(cause, "insert snapshot", {
                code: "DB_WRITE_FAILED",
                details: { frameNo, runId },
            }),
        });
        yield* Metric.increment(snapshotsCaptured);
        yield* Metric.update(snapshotDuration, performance.now() - start);
        return row;
    }).pipe(Effect.annotateLogs({ runId, frameNo: String(frameNo) }), Effect.withLogSpan("time-travel:capture-snapshot"));
}
