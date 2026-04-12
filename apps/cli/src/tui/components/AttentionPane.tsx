import type { SmithersDb } from "@smithers/db/adapter";
export declare function AttentionPane({ adapter, focused, onSelectRun, }: {
    adapter: SmithersDb;
    focused: boolean;
    onSelectRun?: (runId: string) => void;
}): import("react/jsx-runtime").JSX.Element;
