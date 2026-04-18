import type { SmithersDb } from "@smithers-orchestrator/db/adapter";

export type RunRewindCommandInput = {
    adapter: SmithersDb;
    runId: string;
    frameNo: number;
    yes?: boolean;
    json?: boolean;
    confirm?: () => Promise<boolean>;
    onResult?: (result: unknown) => void;
    stdin: NodeJS.ReadStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
};
