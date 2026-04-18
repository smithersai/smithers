/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} _SmithersDb */
/** @typedef {import("../adapter/NodeDiffCacheRow.ts").NodeDiffCacheRow} _NodeDiffCacheRow */
/** @typedef {{ bundle: unknown; sizeBytes: number; cacheResult: "hit" | "miss" }} NodeDiffCacheResult */

const NODE_DIFF_MAX_BYTES = 50 * 1024 * 1024;
/** @type {WeakMap<object, Map<string, Promise<NodeDiffCacheResult>>>} */
const inflightByDb = new WeakMap();
/**
 * @param {object} dbKey
 * @returns {Map<string, Promise<NodeDiffCacheResult>>}
 */
function getInflightMap(dbKey) {
    const existing = inflightByDb.get(dbKey);
    if (existing) return existing;
    /** @type {Map<string, Promise<NodeDiffCacheResult>>} */
    const created = new Map();
    inflightByDb.set(dbKey, created);
    return created;
}
export class NodeDiffTooLargeError extends Error {
    code = "DiffTooLarge";
    /** @type {number} */
    sizeBytes;
    /** @param {number} sizeBytes */
    constructor(sizeBytes) {
        super(`Serialized diff exceeds ${NODE_DIFF_MAX_BYTES} bytes`);
        this.name = "NodeDiffTooLargeError";
        this.sizeBytes = sizeBytes;
    }
}
export class NodeDiffCache {
    /** @type {_SmithersDb} */
    adapter;
    /** @type {{ warn?: (message: string, details?: Record<string, unknown>) => void }} */
    logger;
    /**
     * @param {_SmithersDb} adapter
     * @param {{ warn?: (message: string, details?: Record<string, unknown>) => void }} [logger]
     */
    constructor(adapter, logger = {}) {
        this.adapter = adapter;
        this.logger = logger;
    }
    /**
     * @param {{ runId: string; nodeId: string; iteration: number; baseRef: string; }} key
     * @returns {string}
     */
    static keyString(key) {
        return `${key.runId}::${key.nodeId}::${key.iteration}::${key.baseRef}`;
    }
    /**
     * @param {{ runId: string; nodeId: string; iteration: number; baseRef: string; }} key
     * @returns {Promise<{ bundle: unknown; sizeBytes: number; } | null>}
     */
    async get(key) {
        const row = await this.adapter.getNodeDiffCache(key.runId, key.nodeId, key.iteration, key.baseRef);
        if (!row || typeof row.diffJson !== "string") return null;
        try {
            const bundle = JSON.parse(row.diffJson);
            const sizeBytes = Number(row.sizeBytes ?? Buffer.byteLength(row.diffJson, "utf8"));
            return {
                bundle,
                sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : Buffer.byteLength(row.diffJson, "utf8"),
            };
        } catch {
            this.logger.warn?.("Failed to parse cached node diff JSON; treating as miss.", {
                runId: key.runId, nodeId: key.nodeId, iteration: key.iteration,
            });
            return null;
        }
    }
    /**
     * @param {{ runId: string; nodeId: string; iteration: number; baseRef: string; }} key
     * @param {() => Promise<unknown>} compute
     * @returns {Promise<NodeDiffCacheResult>}
     */
    async getOrCompute(key, compute) {
        const hit = await this.get(key);
        if (hit) return { bundle: hit.bundle, sizeBytes: hit.sizeBytes, cacheResult: "hit" };
        const adapterWithDb = /** @type {_SmithersDb & { db?: object }} */ (this.adapter);
        const inflight = getInflightMap(adapterWithDb.db ?? this.adapter);
        const inflightKey = NodeDiffCache.keyString(key);
        const pending = inflight.get(inflightKey);
        if (pending) return pending;
        const computePromise = (async () => {
            const bundle = await compute();
            const diffJson = JSON.stringify(bundle);
            const sizeBytes = Buffer.byteLength(diffJson, "utf8");
            if (sizeBytes > NODE_DIFF_MAX_BYTES) throw new NodeDiffTooLargeError(sizeBytes);
            /** @type {_NodeDiffCacheRow} */
            const row = {
                runId: key.runId, nodeId: key.nodeId, iteration: key.iteration, baseRef: key.baseRef,
                diffJson, computedAtMs: Date.now(), sizeBytes,
            };
            try {
                await this.adapter.upsertNodeDiffCache(row);
            } catch (error) {
                this.logger.warn?.("Failed writing node diff cache row.", {
                    runId: key.runId, nodeId: key.nodeId, iteration: key.iteration,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return { bundle, sizeBytes, cacheResult: /** @type {const} */ ("miss") };
        })().finally(() => { inflight.delete(inflightKey); });
        inflight.set(inflightKey, computePromise);
        return computePromise;
    }
    /**
     * @param {string} runId
     * @param {number} targetFrameNo
     * @returns {ReturnType<_SmithersDb["invalidateNodeDiffsAfterFrame"]>}
     */
    invalidateAfterFrame(runId, targetFrameNo) {
        return this.adapter.invalidateNodeDiffsAfterFrame(runId, targetFrameNo);
    }
    /**
     * @param {string} [runId]
     * @returns {ReturnType<_SmithersDb["countNodeDiffCacheRows"]>}
     */
    countRows(runId) {
        return this.adapter.countNodeDiffCacheRows(runId);
    }
}
export { NODE_DIFF_MAX_BYTES };
