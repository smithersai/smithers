import type { SmithersDb } from "@smithers-orchestrator/db/adapter";

export type RunOutputCommandInput = {
    adapter: SmithersDb;
    runId: string;
    nodeId: string;
    iteration?: number;
    pretty?: boolean;
    workflow?: unknown;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
};
