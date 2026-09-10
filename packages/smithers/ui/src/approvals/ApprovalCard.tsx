/** @jsxImportSource react */
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { safeHref } from "../internal/safeHref";
import {
  Confirmation,
  ConfirmationActions,
  ConfirmationAction,
  ConfirmationRequest,
  ConfirmationAccepted,
  ConfirmationRejected,
  type ApprovalState,
} from "./Confirmation";

export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";

export type ApprovalResource = {
  id: string;
  label: string;
  kind?: string;
  href?: string;
};

export type ApprovalCardProps = Omit<ComponentProps<"div">, "children" | "title"> & {
  title: ReactNode;
  state: ApprovalState;
  summary?: ReactNode;
  risk?: ApprovalRiskLevel;
  proposedActions?: readonly ReactNode[];
  resources?: readonly ApprovalResource[];
  note?: string;
  defaultNote?: string;
  onNoteChange?: (note: string) => void;
  noteEditor?: ReactNode;
  onApprove?: (note?: string) => void;
  onDeny?: (note?: string) => void;
  children?: ReactNode;
};

/**
 * Rich approval request card: title + risk badge + summary, the proposed
 * action list, the affected resources, an optional reviewer note (controlled
 * or uncontrolled, or a custom noteEditor slot), and approve/deny actions
 * wired through the Confirmation state machine.
 */
export function ApprovalCard({
  title,
  state,
  summary,
  risk,
  proposedActions,
  resources,
  note: controlledNote,
  defaultNote,
  onNoteChange,
  noteEditor,
  onApprove,
  onDeny,
  children,
  className,
  ...props
}: ApprovalCardProps) {
  useInjectUiCss();
  const [uncontrolledNote, setUncontrolledNote] = useState(defaultNote ?? "");
  const isNoteControlled = controlledNote !== undefined;
  const note = isNoteControlled ? controlledNote : uncontrolledNote;

  function setNote(next: string) {
    if (!isNoteControlled) setUncontrolledNote(next);
    onNoteChange?.(next);
  }

  const showNote =
    noteEditor !== undefined || onNoteChange !== undefined || defaultNote !== undefined || controlledNote !== undefined;

  return (
    <div data-slot="approval-card" data-state={state} className={cn("sui-approval-card", className)} {...props}>
      <div className="sui-approval-header">
        <div data-slot="approval-card-title" className="sui-approval-title">
          {title}
        </div>
        {risk !== undefined ? <ApprovalRisk level={risk} /> : null}
      </div>
      <Confirmation state={state}>
        <ConfirmationRequest>
          {summary !== undefined ? <div className="sui-approval-summary">{summary}</div> : null}
          {proposedActions !== undefined && proposedActions.length > 0 ? (
            <ul data-slot="approval-card-proposed-actions" className="sui-approval-actions-list">
              {proposedActions.map((action, index) => (
                <li key={index}>{action}</li>
              ))}
            </ul>
          ) : null}
          {resources !== undefined && resources.length > 0 ? <ApprovalResources resources={resources} /> : null}
          {noteEditor !== undefined ? (
            noteEditor
          ) : showNote ? (
            <ApprovalNote value={note} onValueChange={setNote} />
          ) : null}
          {children}
        </ConfirmationRequest>
        {state === "requested" || state === "failed-submission" ? (
          <ConfirmationActions>
            <ConfirmationAction decision="approve" onDecide={() => onApprove?.(note === "" ? undefined : note)} />
            <ConfirmationAction decision="deny" onDecide={() => onDeny?.(note === "" ? undefined : note)} />
          </ConfirmationActions>
        ) : null}
        <ConfirmationAccepted />
        <ConfirmationRejected />
      </Confirmation>
    </div>
  );
}

export type ApprovalRiskProps = Omit<ComponentProps<"span">, "children"> & {
  level: ApprovalRiskLevel;
};

/** Risk badge over warning/destructive tokens. */
export function ApprovalRisk({ level, className, ...props }: ApprovalRiskProps) {
  useInjectUiCss();
  return (
    <span data-slot="approval-risk" data-level={level} className={cn("sui-approval-risk", className)} {...props}>
      <span className="sui-sr-only">Risk: </span>
      {level}
    </span>
  );
}

export type ApprovalResourcesProps = Omit<ComponentProps<"div">, "children"> & {
  resources: readonly ApprovalResource[];
};

/** The resources an approval decision affects. */
export function ApprovalResources({ resources, className, ...props }: ApprovalResourcesProps) {
  useInjectUiCss();
  return (
    <div data-slot="approval-resources" className={cn("sui-approval-resources", className)} {...props}>
      {resources.map((resource) => {
        const href = resource.href === undefined ? undefined : safeHref(resource.href);
        return (
          <div key={resource.id} data-slot="approval-resource" className="sui-approval-resource">
            {resource.kind !== undefined ? <span className="sui-approval-resource-kind">{resource.kind}</span> : null}
            {href !== undefined ? <a href={href}>{resource.label}</a> : <span>{resource.label}</span>}
          </div>
        );
      })}
    </div>
  );
}

export type ApprovalNoteProps = Omit<ComponentProps<"div">, "children"> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  readOnly?: boolean;
  label?: string;
};

/** Labeled reviewer-note textarea; readOnly renders the note non-editable. */
export function ApprovalNote({
  value: controlledValue,
  defaultValue,
  onValueChange,
  readOnly = false,
  label = "Note",
  className,
  ...props
}: ApprovalNoteProps) {
  useInjectUiCss();
  const textareaId = useId();
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? "");
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : uncontrolledValue;
  return (
    <div data-slot="approval-note" className={cn("sui-approval-note", className)} {...props}>
      <label className="sui-approval-note-label" htmlFor={textareaId}>
        {label}
      </label>
      <textarea
        id={textareaId}
        className="sui-approval-note-input"
        value={value}
        readOnly={readOnly}
        onChange={(event) => {
          const next = event.target.value;
          if (!isControlled) setUncontrolledValue(next);
          onValueChange?.(next);
        }}
      />
    </div>
  );
}
