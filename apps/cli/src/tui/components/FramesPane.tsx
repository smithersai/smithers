import type { SmithersDb } from "@smithers-orchestrator/db/adapter";
export declare function FramesPane({ adapter, runId, focused, filterNodeId, nodeAttempt, }: {
    adapter: SmithersDb;
    runId: string;
    focused: boolean;
    filterNodeId?: string;
    nodeAttempt?: any;
}): import("react/jsx-runtime").JSX.Element;
