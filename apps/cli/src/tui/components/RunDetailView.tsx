import type { SmithersDb } from "@smithers-orchestrator/db/adapter";
export declare function RunDetailView({ adapter, runId, onBack, onSelectNode, }: {
    adapter: SmithersDb;
    runId: string;
    onBack: () => void;
    onSelectNode: (nodeId: string | null) => void;
}): import("react/jsx-runtime").JSX.Element;
