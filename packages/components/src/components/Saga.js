// @smithers-type-exports-begin
/** @typedef {import("./SagaProps.ts").SagaProps} SagaProps */
/** @typedef {import("./SagaStepDef.ts").SagaStepDef} SagaStepDef */
// @smithers-type-exports-end

import React from "react";
import { forceContinueOnFail } from "./control-flow-utils.js";
/** @typedef {import("./SagaStepProps.ts").SagaStepProps} SagaStepProps */

/**
 * @param {SagaStepProps} _props
 * @returns {React.ReactElement | null}
 */
function SagaStep(_props) {
    // SagaStep is a declarative marker — the Saga component reads its props
    // directly from the children array. It does not render on its own.
    return null;
}
/**
 * Forward steps with registered compensations executed in reverse on failure/cancel.
 *
 * Use the `steps` prop for an array-driven API, or nest `<Saga.Step>` children
 * for a declarative JSX style.
 *
 * Renders to `<smithers:saga>`.
 * @param {SagaProps} props
 */
export function Saga(props) {
    if (props.skipIf)
        return null;
    const { steps, children, onFailure = "compensate", id, ...rest } = props;
    // Collect steps from either the `steps` prop or Saga.Step children.
    let resolvedSteps = [];
    if (steps && steps.length > 0) {
        resolvedSteps = steps;
    }
    else if (children) {
        // Walk children to extract Saga.Step elements.
        const childArr = React.Children.toArray(children);
        for (const child of childArr) {
            if (React.isValidElement(child) &&
                (child.type === SagaStep || child.type.__isSagaStep)) {
                const stepProps = child.props;
                resolvedSteps.push({
                    id: stepProps.id,
                    action: stepProps.children,
                    compensation: stepProps.compensation,
                });
            }
        }
    }
    // Build the host element props with step metadata.
    const sagaProps = {
        ...rest,
        id,
        onFailure,
        __sagaSteps: resolvedSteps.map((s) => ({
            id: s.id,
            label: s.label,
        })),
    };
    const actionChildren = resolvedSteps.map((step) => React.cloneElement(forceContinueOnFail(step.action), {
        key: `saga-action-${step.id}`,
    }));
    const compensationChildren = resolvedSteps.map((step) => React.cloneElement(step.compensation, {
        key: `saga-compensation-${step.id}`,
    }));
    // Store compensation elements on the host props for the engine.
    sagaProps.__sagaCompensations = resolvedSteps.reduce((acc, step) => {
        acc[step.id] = step.compensation;
        return acc;
    }, {});
    return React.createElement("smithers:saga", sagaProps, React.createElement("smithers:saga-actions", null, ...actionChildren), React.createElement("smithers:saga-compensations", null, ...compensationChildren));
}
// Mark SagaStep for identification.
SagaStep.__isSagaStep = true;
Saga.Step = SagaStep;
