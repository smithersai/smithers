import React from "react";
import { DEFAULT_MERGE_QUEUE_CONCURRENCY } from "@smithers/graph/constants";
/** @typedef {import("./MergeQueue.ts").MergeQueueProps} MergeQueueProps */

/**
 * @param {MergeQueueProps} props
 */
export function MergeQueue(props) {
    if (props.skipIf)
        return null;
    const next = {
        maxConcurrency: props.maxConcurrency ?? DEFAULT_MERGE_QUEUE_CONCURRENCY,
        id: props.id,
    };
    return React.createElement("smithers:merge-queue", next, props.children);
}
