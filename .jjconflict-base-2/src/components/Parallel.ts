import React from "react";

export type ParallelProps = {
  id?: string;
  maxConcurrency?: number;
  skipIf?: boolean;
  children?: React.ReactNode;
};

export function Parallel(props: ParallelProps) {
  if (props.skipIf) return null;
  // Align prop sanitization with other structural components
  const next: { maxConcurrency?: number; id?: string } = {
    maxConcurrency: props.maxConcurrency,
    id: props.id,
  };
  return React.createElement("smithers:parallel", next, props.children);
}
