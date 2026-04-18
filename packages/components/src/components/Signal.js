import React from "react";
import { z } from "zod";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { stripAutoColumns } from "@smithers-orchestrator/db/react-output";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { WaitForEvent } from "./WaitForEvent.js";
/**
 * @template Schema
 * @typedef {import("./SignalProps.ts").SignalProps<Schema>} SignalProps
 */

/**
 * @template Schema
 * @param {SignalProps<Schema>} props
 */
export function Signal(props) {
    if (props.skipIf)
        return null;
    const smithersContext = props.smithersContext ?? SmithersContext;
    const ctx = React.useContext(smithersContext);
    const waitNode = React.createElement(WaitForEvent, {
        id: props.id,
        key: props.key,
        event: props.id,
        correlationId: props.correlationId,
        output: props.schema,
        outputSchema: props.schema,
        timeoutMs: props.timeoutMs,
        onTimeout: props.onTimeout,
        async: props.async,
        dependsOn: props.dependsOn,
        needs: props.needs,
        label: props.label ?? `signal:${props.id}`,
        meta: props.meta,
    });
    if (!props.children) {
        return waitNode;
    }
    if (!ctx) {
        throw new SmithersError("CONTEXT_OUTSIDE_WORKFLOW", "Signal children require a workflow context. Build the workflow with createSmithers().");
    }
    const signalRow = ctx.outputMaybe(props.schema, { nodeId: props.id });
    if (signalRow === undefined) {
        return waitNode;
    }
    const signalData = props.schema.parse(stripAutoColumns(signalRow));
    return React.createElement(React.Fragment, null, waitNode, props.children(signalData));
}
