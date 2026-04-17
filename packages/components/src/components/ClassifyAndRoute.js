// @smithers-type-exports-begin
/** @typedef {import("./ClassifyAndRouteProps.ts").ClassifyAndRouteProps} ClassifyAndRouteProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Parallel } from "./Parallel.js";
import { Task } from "./Task.js";
/** @typedef {import("@smithers/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./CategoryConfig.ts").CategoryConfig} CategoryConfig */

/**
 * @param {AgentLike | CategoryConfig} value
 * @returns {value is CategoryConfig}
 */
function isConfig(value) {
    return "agent" in value && typeof value.generate !== "function";
}
/**
 * <ClassifyAndRoute> — Classify items then route to category-specific agents.
 *
 * Composes Sequence, Task, and Parallel. First a classifier Task assigns items
 * to categories, then a Parallel block routes each classified item to the
 * appropriate category agent.
 * @param {ClassifyAndRouteProps} props
 */
export function ClassifyAndRoute(props) {
    if (props.skipIf)
        return null;
    const { id, items, categories, classifierAgent, classifierOutput, routeOutput, classificationResult, maxConcurrency, children, } = props;
    const prefix = id ?? "classify-and-route";
    const itemList = Array.isArray(items) ? items : [items];
    const categoryNames = Object.keys(categories);
    // Step 1: Classification task
    const classifyTask = React.createElement(Task, {
        key: `${prefix}-classify`,
        id: `${prefix}-classify`,
        output: classifierOutput,
        agent: classifierAgent,
        label: "Classify items",
        children: children ??
            `Classify the following items into categories: ${categoryNames.join(", ")}.\n\nItems:\n${JSON.stringify(itemList, null, 2)}`,
    });
    // Step 2: Route each classified item to its category agent
    const classifications = classificationResult?.classifications ?? [];
    const routeElements = classifications.map((c, idx) => {
        const catKey = c.category;
        const catEntry = categories[catKey];
        if (!catEntry)
            return null;
        const agent = isConfig(catEntry) ? catEntry.agent : catEntry;
        const output = isConfig(catEntry) ? (catEntry.output ?? routeOutput) : routeOutput;
        const prompt = isConfig(catEntry) && catEntry.prompt
            ? catEntry.prompt(c)
            : `Handle item classified as "${catKey}":\n${JSON.stringify(c, null, 2)}`;
        return React.createElement(Task, {
            key: `${prefix}-route-${c.itemId ?? idx}`,
            id: `${prefix}-route-${c.itemId ?? idx}`,
            output,
            agent,
            continueOnFail: true,
            label: `Route: ${catKey}${c.itemId ? ` (${c.itemId})` : ""}`,
            children: prompt,
        });
    }).filter(Boolean);
    const sequenceChildren = [classifyTask];
    if (routeElements.length > 0) {
        sequenceChildren.push(React.createElement(Parallel, {
            key: `${prefix}-routes`,
            id: `${prefix}-routes`,
            maxConcurrency,
        }, ...routeElements));
    }
    return React.createElement(Sequence, null, ...sequenceChildren);
}
