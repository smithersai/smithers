import type { SmithersDb } from "@smithers-orchestrator/db/adapter";

export type RunDiffCommandInput = {
    adapter: SmithersDb;
    runId: string;
    nodeId: string;
    iteration?: number;
    stat?: boolean;
    json?: boolean;
    color?: boolean;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
};
