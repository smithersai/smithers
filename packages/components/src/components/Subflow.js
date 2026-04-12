import React from "react";
/** @typedef {import("./Subflow.ts").SubflowProps} SubflowProps */

/**
 * @param {SubflowProps} props
 */
export function Subflow(props) {
    if (props.skipIf)
        return null;
    return React.createElement("smithers:subflow", {
        id: props.id,
        key: props.key,
        workflow: props.workflow,
        input: props.input,
        mode: props.mode ?? "childRun",
        output: props.output,
        timeoutMs: props.timeoutMs,
        heartbeatTimeoutMs: props.heartbeatTimeoutMs,
        heartbeatTimeout: props.heartbeatTimeout,
        retries: props.retries,
        retryPolicy: props.retryPolicy,
        continueOnFail: props.continueOnFail,
        cache: props.cache,
        dependsOn: props.dependsOn,
        needs: props.needs,
        label: props.label ?? props.id,
        meta: props.meta,
        __smithersSubflowWorkflow: props.workflow,
        __smithersSubflowInput: props.input,
        __smithersSubflowMode: props.mode ?? "childRun",
    });
}
