import React from "react";

export type BranchProps = {
  if: boolean;
  then: React.ReactElement;
  else?: React.ReactElement | null;
  skipIf?: boolean;
};

export function Branch(props: BranchProps) {
  if (props.skipIf) return null;
  const chosen = props.if ? props.then : (props.else ?? null);
  return React.createElement("smithers:branch", props, chosen);
}
