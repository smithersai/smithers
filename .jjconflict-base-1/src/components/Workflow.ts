import React from "react";

export type WorkflowProps = {
  name: string;
  cache?: boolean;
  children?: React.ReactNode;
};

export function Workflow(props: WorkflowProps) {
  return React.createElement("smithers:workflow", props, props.children);
}
