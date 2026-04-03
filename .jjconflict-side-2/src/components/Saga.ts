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

function SagaStep(_props: SagaStepProps): React.ReactElement | null {
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
 */
export function Saga(props: SagaProps): React.ReactElement | null {
  if (props.skipIf) return null;

  const { steps, children, onFailure = "compensate", id, ...rest } = props;

  // Collect steps from either the `steps` prop or Saga.Step children.
  let resolvedSteps: SagaStepDef[] = [];
  if (steps && steps.length > 0) {
    resolvedSteps = steps;
  } else if (children) {
    // Walk children to extract Saga.Step elements.
    const childArr = React.Children.toArray(children);
    for (const child of childArr) {
      if (
        React.isValidElement(child) &&
        (child.type === SagaStep || (child.type as any).__isSagaStep)
      ) {
        const stepProps = child.props as SagaStepProps;
        resolvedSteps.push({
          id: stepProps.id,
          action: stepProps.children,
          compensation: stepProps.compensation,
        });
      }
    }
  }

  // Build the host element props with step metadata.
  const sagaProps: Record<string, any> = {
    ...rest,
    id,
    onFailure,
    __sagaSteps: resolvedSteps.map((s) => ({
      id: s.id,
      label: s.label,
    })),
  };

  // Render actions as sequential children of the saga host element.
  // Compensations are stored as metadata for the engine to use on rollback.
  const actionChildren = resolvedSteps.map((step) =>
    React.cloneElement(step.action, { key: `saga-action-${step.id}` }),
  );

  // Store compensation elements on the host props for the engine.
  sagaProps.__sagaCompensations = resolvedSteps.reduce(
    (acc, step) => {
      acc[step.id] = step.compensation;
      return acc;
    },
    {} as Record<string, React.ReactElement>,
  );

  return React.createElement(
    "smithers:saga",
    sagaProps,
    ...actionChildren,
  );
}

// Mark SagaStep for identification.
(SagaStep as any).__isSagaStep = true;

Saga.Step = SagaStep;
