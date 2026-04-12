import { Layer } from "effect";
import type { CachePolicy } from "@smithers/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";
type AnySchema = any;
type AnyEffect = any;
type BuilderStepContext = Record<string, unknown> & {
    input: unknown;
    executionId: string;
    stepId: string;
    attempt: number;
    signal: AbortSignal;
    iteration: number;
    heartbeat: (data?: unknown) => void;
    lastHeartbeat: unknown | null;
};
type ApprovalOptions = {
    needs?: Record<string, BuilderStepHandle>;
    request: (ctx: Record<string, unknown>) => {
        title: string;
        summary?: string | null;
    };
    onDeny?: "fail" | "continue" | "skip";
};
type SequenceNode = {
    kind: "sequence";
    children: BuilderNode[];
};
type ParallelNode = {
    kind: "parallel";
    children: BuilderNode[];
    maxConcurrency?: number;
};
type LoopNode = {
    kind: "loop";
    id?: string;
    children: BuilderNode;
    until: (outputs: Record<string, unknown>) => boolean;
    maxIterations?: number;
    onMaxReached?: "fail" | "return-last";
    handles?: BuilderStepHandle[];
};
type MatchNode = {
    kind: "match";
    source: BuilderStepHandle;
    when: (value: any) => boolean;
    then: BuilderNode;
    else?: BuilderNode;
};
type BranchNode = {
    kind: "branch";
    condition: (ctx: Record<string, unknown>) => boolean;
    needs?: Record<string, BuilderStepHandle>;
    then: BuilderNode;
    else?: BuilderNode;
};
type WorktreeNode = {
    kind: "worktree";
    id?: string;
    path: string;
    branch?: string;
    skipIf?: (ctx: Record<string, unknown>) => boolean;
    needs?: Record<string, BuilderStepHandle>;
    children: BuilderNode;
};
export type BuilderNode = BuilderStepHandle | SequenceNode | ParallelNode | LoopNode | MatchNode | BranchNode | WorktreeNode;
export type BuilderStepHandle = {
    kind: "step" | "approval";
    id: string;
    localId: string;
    tableKey: string;
    tableName: string;
    table: any;
    output: AnySchema;
    needs: Record<string, BuilderStepHandle>;
    run?: (ctx: BuilderStepContext) => AnyEffect;
    request?: ApprovalOptions["request"];
    onDeny?: "fail" | "continue" | "skip";
    retries: number;
    retryPolicy?: RetryPolicy;
    timeoutMs: number | null;
    skipIf?: (ctx: BuilderStepContext) => boolean;
    loopId?: string;
    cache?: CachePolicy;
};
export type SmithersSqliteOptions = {
    filename: string;
};
declare function sqlite(options: SmithersSqliteOptions): Layer.Layer<SmithersSqliteOptions, never, never>;
export declare const Smithers: {
    sqlite: typeof sqlite;
};
export {};
