import type { SmithersDb } from "@smithers-orchestrator/db/adapter";
export declare function NodeInspector({ adapter, runId, node, onClose, }: {
    adapter: SmithersDb;
    runId: string;
    node: any;
    onClose: () => void;
}): import("react/jsx-runtime").JSX.Element;
