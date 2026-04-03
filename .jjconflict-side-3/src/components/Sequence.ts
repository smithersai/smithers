import React from "react";

export type SequenceProps = {
  skipIf?: boolean;
  children?: React.ReactNode;
};

export function Sequence(props: SequenceProps) {
  if (props.skipIf) return null;
  return React.createElement("smithers:sequence", props, props.children);
}
