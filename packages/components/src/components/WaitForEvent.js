import React from "react";
import { getTaskRuntime } from "@smithers/driver/task-runtime";
import { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("./WaitForEventProps.ts").WaitForEventProps} WaitForEventProps */

/**
 * @param {WaitForEventProps} props
 */
export function WaitForEvent(props) {
    if (props.skipIf)
        return null;
    const eventMeta = {
        event: props.event,
        ...(props.correlationId ? { correlationId: props.correlationId } : {}),
        ...(props.onTimeout ? { onTimeout: props.onTimeout } : {}),
        ...props.meta,
    };
    return React.createElement("smithers:wait-for-event", {
        id: props.id,
        key: props.key,
        event: props.event,
        correlationId: props.correlationId,
        output: props.output,
        outputSchema: props.outputSchema,
        timeoutMs: props.timeoutMs,
        onTimeout: props.onTimeout ?? "fail",
        waitAsync: props.async === true,
        dependsOn: props.dependsOn,
        needs: props.needs,
        label: props.label ?? `wait:${props.event}`,
        meta: Object.keys(eventMeta).length > 0 ? eventMeta : undefined,
        __smithersEventName: props.event,
        __smithersCorrelationId: props.correlationId,
        __smithersOnTimeout: props.onTimeout ?? "fail",
    });
}
