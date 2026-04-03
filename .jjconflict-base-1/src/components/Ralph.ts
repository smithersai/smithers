import React from "react";

export type LoopProps = {
  id?: string;
  until: boolean;
  maxIterations?: number;
  onMaxReached?: "fail" | "return-last";
  skipIf?: boolean;
  children?: React.ReactNode;
};

export function Loop(props: LoopProps) {
  if (props.skipIf) return null;
  return React.createElement("smithers:ralph", props, props.children);
}

/** @deprecated Use `Loop` instead. */
export type RalphProps = LoopProps;

/** @deprecated Use `Loop` instead. */
export const Ralph = Loop;
