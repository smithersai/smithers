import React from "react";
import { DEFAULT_MERGE_QUEUE_CONCURRENCY } from "../constants";

/**
 * Queue tasks so that at most `maxConcurrency` run concurrently across the group.
 * Defaults to 1, providing an easy merge queue primitive.
 */
export type MergeQueueProps = {
  id?: string;
  maxConcurrency?: number; // defaults to 1
  skipIf?: boolean;
  children?: React.ReactNode;
};

export function MergeQueue(props: MergeQueueProps) {
  if (props.skipIf) return null;
  const next: { maxConcurrency: number; id?: string } = {
    maxConcurrency: props.maxConcurrency ?? DEFAULT_MERGE_QUEUE_CONCURRENCY,
    id: props.id,
  };
  return React.createElement("smithers:merge-queue", next, props.children);
}
