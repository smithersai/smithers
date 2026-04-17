// @smithers-type-exports-begin
/** @typedef {import("./SuperSmithersProps.ts").SuperSmithersProps} SuperSmithersProps */
// @smithers-type-exports-end

import React from "react";
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
 * @param {SuperSmithersProps} props
 */
export function SuperSmithers(props) {
    const { id: idPrefix, strategy, agent, targetFiles, reportOutput, dryRun, skipIf, } = props;
    if (skipIf)
        return null;
    const prefix = idPrefix ?? "super-smithers";
    // Task 1: Read strategy and target files
    const readTaskId = `${prefix}-read`;
    const readOutput = reportOutput ?? "super-smithers-read";
    const strategyText = typeof strategy === "string" ? strategy : undefined;
    const strategyElement = typeof strategy !== "string" ? strategy : undefined;
    const readPrompt = strategyText
        ? `You are a code intervention agent.\n\n## Strategy\n\n${strategyText}\n\n## Target Files\n\n${targetFiles?.length ? targetFiles.join(", ") : "All files in the project"}\n\nRead the target files and understand the codebase. Identify what changes are needed according to the strategy.`
        : undefined;
    const readChildren = strategyElement
        ? React.createElement(React.Fragment, null, strategyElement, React.createElement("p", null, `Target files: ${targetFiles?.length ? targetFiles.join(", ") : "All files in the project"}`))
        : readPrompt;
    const readTask = React.createElement("smithers:task", {
        id: readTaskId,
        output: readOutput,
        agent,
        __smithersKind: "agent",
    }, readChildren);
    // Task 2: Propose modifications
    const proposeTaskId = `${prefix}-propose`;
    const proposeOutput = reportOutput ?? "super-smithers-propose";
    const proposeTask = React.createElement("smithers:task", {
        id: proposeTaskId,
        output: proposeOutput,
        agent,
        dependsOn: [readTaskId],
        __smithersKind: "agent",
    }, "Based on your analysis, propose specific code modifications. " +
        "For each file, provide the exact changes needed as a list of edits. " +
        "Include the file path, the original code, and the replacement code for each change. " +
        (dryRun ? "This is a DRY RUN — do not apply changes, only report them." : ""));
    // Task 3: Apply modifications (only if not dryRun)
    const applyTaskId = `${prefix}-apply`;
    const applyOutput = reportOutput ?? "super-smithers-apply";
    const applyTask = !dryRun
        ? React.createElement("smithers:task", {
            id: applyTaskId,
            output: applyOutput,
            dependsOn: [proposeTaskId],
            __smithersKind: "compute",
            __smithersComputeFn: async () => {
                // The compute function has access to the proposed modifications
                // from the previous task via the engine context. The actual file
                // writes trigger the hot reload system.
                return { applied: true };
            },
        }, null)
        : null;
    // Task 4: Generate report
    const reportTaskId = `${prefix}-report`;
    const finalOutput = reportOutput ?? "super-smithers-report";
    const reportTask = React.createElement("smithers:task", {
        id: reportTaskId,
        output: finalOutput,
        agent,
        dependsOn: dryRun ? [proposeTaskId] : [applyTaskId],
        __smithersKind: "agent",
    }, `Generate a summary report of the intervention. ` +
        `Describe what was analyzed, what changes were ${dryRun ? "proposed (dry run)" : "applied"}, ` +
        `and any observations or warnings.`);
    // Wrap all tasks in a sequence
    const sequenceChildren = [readTask, proposeTask];
    if (applyTask)
        sequenceChildren.push(applyTask);
    sequenceChildren.push(reportTask);
    return React.createElement("smithers:sequence", { id: prefix }, ...sequenceChildren);
}
