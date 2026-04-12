import type { SmithersDb } from "@smithers/db/adapter";
export declare function DetailsPane({ adapter, runId, focused, onInspectNode, }: {
    adapter: SmithersDb;
    runId: string;
    focused: boolean;
    onInspectNode?: (node: any) => void;
}): import("react/jsx-runtime").JSX.Element;
