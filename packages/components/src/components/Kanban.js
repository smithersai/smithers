// @smithers-type-exports-begin
/** @typedef {import("./ColumnDef.ts").ColumnDef} ColumnDef */
/** @typedef {import("./KanbanProps.ts").KanbanProps} KanbanProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Parallel } from "./Parallel.js";
import { Loop } from "./Ralph.js";
import { Task } from "./Task.js";
/**
 * <Kanban> — Process items through columns with pluggable ticket source.
 *
 * Composes Loop, Sequence, Parallel, and Task to create a board where items
 * flow through columns. Each column processes items via its assigned agent.
 * Items in the same column can be processed in parallel.
 * @param {KanbanProps} props
 */
export function Kanban(props) {
    if (props.skipIf)
        return null;
    const { id, columns, useTickets, agents, maxConcurrency, onComplete, until = false, maxIterations = 5, children, } = props;
    const prefix = id ?? "kanban";
    const tickets = useTickets();
    // Build a Sequence of columns. Each column processes all tickets in Parallel.
    const columnElements = columns.map((col, colIdx) => {
        const agent = agents?.[col.name] ?? col.agent;
        const taskElements = tickets.map((item) => {
            const taskId = `${prefix}-${col.name}-${item.id}`;
            const taskProps = col.task ?? {};
            const prompt = col.prompt
                ? col.prompt({ item, column: col.name })
                : `Process item ${item.id} in column "${col.name}".`;
            return React.createElement(Task, {
                ...taskProps,
                key: `${col.name}-${item.id}`,
                id: taskId,
                output: col.output,
                agent,
                continueOnFail: taskProps.continueOnFail ?? true,
                label: taskProps.label ?? `${col.name}: ${item.id}`,
                children: prompt,
            });
        });
        return React.createElement(Parallel, {
            key: `col-${colIdx}-${col.name}`,
            id: `${prefix}-col-${col.name}`,
            maxConcurrency,
        }, ...taskElements);
    });
    const sequence = React.createElement(Sequence, null, ...columnElements);
    const loop = React.createElement(Loop, {
        id: `${prefix}-loop`,
        until,
        maxIterations,
        onMaxReached: "return-last",
    }, sequence);
    if (!onComplete) {
        return loop;
    }
    return React.createElement(Sequence, null, loop, React.createElement(Task, {
        key: `${prefix}-complete`,
        id: `${prefix}-complete`,
        output: onComplete,
        label: "Board complete",
        children: children ?? null,
    }));
}
