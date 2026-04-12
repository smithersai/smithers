// @smithers-type-exports-begin
/** @typedef {import("./Sandbox.ts").SandboxRuntime} SandboxRuntime */
/** @typedef {import("./Sandbox.ts").SandboxVolumeMount} SandboxVolumeMount */
/** @typedef {import("./Sandbox.ts").SandboxWorkspaceSpec} SandboxWorkspaceSpec */
// @smithers-type-exports-end

import React from "react";
/** @typedef {import("./Sandbox.ts").SandboxProps} SandboxProps */

/**
 * @param {SandboxProps} props
 */
export function Sandbox(props) {
    if (props.skipIf)
        return null;
    return React.createElement("smithers:sandbox", {
        id: props.id,
        key: props.key,
        output: props.output,
        runtime: props.runtime ?? "bubblewrap",
        allowNetwork: props.allowNetwork,
        reviewDiffs: props.reviewDiffs,
        autoAcceptDiffs: props.autoAcceptDiffs,
        image: props.image,
        env: props.env,
        ports: props.ports,
        volumes: props.volumes,
        memoryLimit: props.memoryLimit,
        cpuLimit: props.cpuLimit,
        command: props.command,
        workspace: props.workspace,
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
        __smithersSandboxWorkflow: props.workflow,
        __smithersSandboxInput: props.input,
        __smithersSandboxRuntime: props.runtime ?? "bubblewrap",
        __smithersSandboxChildren: props.children,
    });
}
