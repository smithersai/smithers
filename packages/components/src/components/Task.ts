import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { CachePolicy } from "@smithers/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";
import type { ScorersMap } from "@smithers/scorers/types";
import type { TaskMemoryConfig } from "@smithers/memory/types";
import type { InferOutputEntry } from "@smithers/driver/OutputAccessor";
/**
 * Valid output targets: a Zod schema (recommended with createSmithers),
 * a Drizzle table object, or a string key (escape hatch).
 */
export type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
export type DepsSpec = Record<string, OutputTarget>;
type InferDepValue<T> = T extends string ? unknown : InferOutputEntry<T>;
export type InferDeps<D extends DepsSpec> = {
    [K in keyof D]: InferDepValue<D[K]>;
};
export type TaskProps<Row, Output extends OutputTarget = OutputTarget, D extends DepsSpec = {}> = {
    key?: string;
    id: string;
    /** Where to store the task's result. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
    output: Output;
    /**
     * Optional Zod schema describing the expected agent output shape.
     * When `output` is already a ZodObject this is inferred automatically.
     * Used for validation and to inject schema examples into MDX prompts.
     */
    outputSchema?: import("zod").ZodObject<any>;
    /** Agent or array of agents [primary, fallback1, fallback2, ...]. Tries in order on retries. */
    agent?: AgentLike | AgentLike[];
    /** Convenience alias for a single retry fallback without exposing array syntax in JSX. */
    fallbackAgent?: AgentLike;
    /** Explicit dependency on other task node IDs. The task will not run until all listed tasks complete. */
    dependsOn?: string[];
    /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
    needs?: Record<string, string>;
    /** Render-time typed dependencies. Keys resolve from task ids of the same name, or from matching `needs` entries. */
    deps?: D;
    skipIf?: boolean;
    needsApproval?: boolean;
    /** When paired with `needsApproval`, do not block unrelated downstream flow while the approval is pending. */
    async?: boolean;
    timeoutMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatTimeout?: number;
    /** Disable retries entirely. Equivalent to retries={0}. */
    noRetry?: boolean;
    retries?: number;
    retryPolicy?: RetryPolicy;
    continueOnFail?: boolean;
    cache?: CachePolicy;
    /** Optional scorers to evaluate this task's output after completion. */
    scorers?: ScorersMap;
    /** Optional cross-run memory configuration. */
    memory?: TaskMemoryConfig;
    allowTools?: string[];
    label?: string;
    meta?: Record<string, unknown>;
    /** @internal Used by createSmithers() to bind tasks to the correct workflow context. */
    smithersContext?: React.Context<any>;
    children?: string | Row | (() => Row | Promise<Row>) | React.ReactNode | ((deps: InferDeps<D>) => Row | React.ReactNode);
};
/**
 * Render a prompt React node to plain markdown text.
 *
 * If the prompt is a React element (e.g. a compiled MDX component), we inject
 * `markdownComponents` via the standard MDX `components` prop so that
 * renderToStaticMarkup outputs clean markdown instead of HTML.
 * No HTML tag stripping or entity decoding needed.
 */
export declare function renderPromptToText(prompt: any): string;
export declare function Task<Row, Output extends OutputTarget = OutputTarget, D extends DepsSpec = {}>(props: TaskProps<Row, Output, D>): React.DOMElement<any, Element> | null;
export {};
