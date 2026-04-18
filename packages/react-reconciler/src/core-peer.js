
/** @typedef {import("@smithers-orchestrator/graph/types").ExtractGraph} ExtractGraph */
const GRAPH_SPECIFIER = "@smithers-orchestrator/graph";
const LOCAL_GRAPH_SPECIFIER = "../../graph/src/index.js";
/**
 * @param {string} specifier
 * @returns {Promise<CoreModule | null>}
 */
async function importCoreModule(specifier) {
    try {
        return (await import(specifier));
    }
    catch {
        return null;
    }
}
/**
 * @returns {Promise<ExtractGraph>}
 */
export async function resolveExtractGraph() {
    const modules = [
        await importCoreModule(GRAPH_SPECIFIER),
        await importCoreModule(LOCAL_GRAPH_SPECIFIER),
    ];
    for (const mod of modules) {
        const fn = mod?.extractGraph;
        if (typeof fn === "function") {
            return fn;
        }
    }
    throw new Error("Unable to load extractGraph from @smithers-orchestrator/graph. " +
        "Install @smithers-orchestrator/graph and ensure it exports extractGraph.");
}
