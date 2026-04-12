import type { SmithersDb } from "@smithers/db/adapter";
export declare function ChatPane({ adapter, runId, focused, filterNodeId, }: {
    adapter: SmithersDb;
    runId: string;
    focused: boolean;
    filterNodeId?: string;
}): import("react/jsx-runtime").JSX.Element;
