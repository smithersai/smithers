import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
export type CategoryConfig = {
    agent: AgentLike;
    /** Output schema for this category's route handler. Overrides `routeOutput`. */
    output?: OutputTarget;
    /** Optional prompt for the route handler. Receives the classified item. */
    prompt?: (item: unknown) => string;
};
export type ClassifyAndRouteProps = {
    id?: string;
    /** Items to classify. A single item or an array of items. */
    items: unknown | unknown[];
    /** Record mapping category names to agents or config objects. */
    categories: Record<string, AgentLike | CategoryConfig>;
    /** Agent that classifies items into categories. */
    classifierAgent: AgentLike;
    /** Output schema for the classification task. */
    classifierOutput: OutputTarget;
    /** Default output schema for routed work. Can be overridden per-category. */
    routeOutput: OutputTarget;
    /** Classification result used to drive routing. Typically from ctx.outputMaybe(). */
    classificationResult?: {
        classifications: Array<{
            itemId?: string;
            category: string;
            [key: string]: unknown;
        }>;
    } | null;
    /** Max parallel routes. */
    maxConcurrency?: number;
    skipIf?: boolean;
    children?: React.ReactNode;
};
/**
 * <ClassifyAndRoute> — Classify items then route to category-specific agents.
 *
 * Composes Sequence, Task, and Parallel. First a classifier Task assigns items
 * to categories, then a Parallel block routes each classified item to the
 * appropriate category agent.
 */
export declare function ClassifyAndRoute(props: ClassifyAndRouteProps): React.FunctionComponentElement<import("./Sequence").SequenceProps> | null;
export {};
