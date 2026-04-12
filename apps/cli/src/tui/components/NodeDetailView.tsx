import type { SmithersDb } from "@smithers/db/adapter";
export declare function NodeDetailView({ adapter, runId, nodeId, onBack, }: {
    adapter: SmithersDb;
    runId: string;
    nodeId: string | null;
    onBack: () => void;
}): import("react/jsx-runtime").JSX.Element;
