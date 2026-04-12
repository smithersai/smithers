import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./Task";
export type SuperSmithersProps = {
    /** Optional ID prefix for all generated task IDs. */
    id?: string;
    /** Markdown string or MDX component describing the intervention strategy. */
    strategy: string | React.ReactElement;
    /** Agent that reads code and decides modifications. */
    agent: AgentLike;
    /** Glob patterns of files the agent can modify. */
    targetFiles?: string[];
    /** Output schema for the intervention report (Zod object). */
    reportOutput?: OutputTarget;
    /** If true, reports changes without applying them. */
    dryRun?: boolean;
    /** Standard skip predicate. */
    skipIf?: boolean;
};
/**
 * SuperSmithers — a workflow wrapper that reads and modifies source code
 * to intervene via hot reload. Takes a markdown strategy doc and an agent
 * that decides what to change.
 *
 * Only meaningful in hot-reload mode: the agent reads source files, proposes
 * modifications, and (unless `dryRun` is set) writes them to disk, triggering
 * the hot reload system to pick up the changes.
 *
 * Internally expands to a sequence of tasks:
 * 1. Agent reads the strategy doc and target files
 * 2. Agent proposes modifications
 * 3. (If not dryRun) Compute task writes modifications to disk
 * 4. Agent generates a report of what changed
 *
 * ```tsx
 * <SuperSmithers
 *   id="refactor"
 *   strategy={strategyMd}
 *   agent={codeAgent}
 *   targetFiles={["src/**\/*.ts"]}
 *   reportOutput={outputs.report}
 * />
 * ```
 */
export declare function SuperSmithers(props: SuperSmithersProps): React.ReactElement<{
    id: string;
}, string | React.JSXElementConstructor<any>> | null;
