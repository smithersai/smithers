import React from "react";
export type WorkflowProps = {
    name: string;
    cache?: boolean;
    children?: React.ReactNode;
};
export declare function Workflow(props: WorkflowProps): React.DOMElement<WorkflowProps, Element>;
