import type { SmithersDb } from "@smithers-orchestrator/db/adapter";
export declare function NodeDetailView({ adapter, runId, nodeId, onBack, }: {
    adapter: SmithersDb;
    runId: string;
    nodeId: string | null;
    onBack: () => void;
}): import("react/jsx-runtime").JSX.Element;
