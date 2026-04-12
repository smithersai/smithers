import React from "react";
export type SagaStepDef = {
    id: string;
    action: React.ReactElement;
    compensation: React.ReactElement;
    label?: string;
};
export type SagaProps = {
    id?: string;
    steps?: SagaStepDef[];
    onFailure?: "compensate" | "compensate-and-fail" | "fail";
    skipIf?: boolean;
    children?: React.ReactNode;
};
export type SagaStepProps = {
    id: string;
    compensation: React.ReactElement;
    children: React.ReactElement;
};
declare function SagaStep(_props: SagaStepProps): React.ReactElement | null;
/**
 * Forward steps with registered compensations executed in reverse on failure/cancel.
 *
 * Use the `steps` prop for an array-driven API, or nest `<Saga.Step>` children
 * for a declarative JSX style.
 *
 * Renders to `<smithers:saga>`.
 */
export declare function Saga(props: SagaProps): React.ReactElement | null;
export declare namespace Saga {
    var Step: typeof SagaStep;
}
export {};
