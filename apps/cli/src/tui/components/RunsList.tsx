import type { SmithersDb } from "@smithers-orchestrator/db/adapter";
export declare function RunsList({ adapter, focused, onChange, onSubmit, }: {
    adapter: SmithersDb;
    focused: boolean;
    onChange: (runId: string) => void;
    onSubmit: (runId: string) => void;
}): import("react/jsx-runtime").JSX.Element;
