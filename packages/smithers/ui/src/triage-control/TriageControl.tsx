/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Badge } from "../badge";
import { Button } from "../button";
import { cn } from "@smthrs/ui-css";
import {
  PENDING_WORDS,
  TRIAGE_VARIANTS,
  TRIAGE_WORDS,
  type IssuesViewPending,
  type IssuesViewTriage,
} from "../issues-view/IssuesView";
import { useInjectUiCss } from "../styles";

export type TriageControlProps = Omit<ComponentProps<"div">, "children"> & {
  /** The issue's triage, as its labels on GitHub say. */
  state: IssuesViewTriage;
  /** This device's triage write still on its way or refused: a `Requested` or `Not sent` chip. */
  pending?: IssuesViewPending;
  /** Shows `Accept` unless the issue is accepted. Absent: no button. */
  onAccept?: () => void;
  /** Shows `Not accepted` unless the issue is not accepted. Absent: no button. */
  onReject?: () => void;
  /** Shows `Run triage again`. Absent: no button. */
  onRunAgain?: () => void;
  /** Disables every button shown. */
  disabled?: boolean;
};

/**
 * An issue's triage: its state chip, a pending chip for this device's write,
 * and the buttons the person may press. A button whose handler is absent is
 * not rendered, so a person who can't act sees the state only. The group is
 * named `Triage` unless the host passes its own `aria-label`.
 */
export function TriageControl({
  state,
  pending,
  onAccept,
  onReject,
  onRunAgain,
  disabled = false,
  className,
  ...props
}: TriageControlProps) {
  useInjectUiCss();
  return (
    <div
      role="group"
      aria-label="Triage"
      data-slot="triage-control"
      data-triage={state}
      data-pending={pending}
      className={cn("sui-triage-control", className)}
      {...props}
    >
      <Badge variant={TRIAGE_VARIANTS[state]} className="sui-triage-state" data-triage={state}>
        {TRIAGE_WORDS[state]}
      </Badge>
      {pending === undefined ? null : (
        <Badge variant={pending === "not_sent" ? "destructive" : "muted"} className="sui-triage-pending">
          {PENDING_WORDS[pending]}
        </Badge>
      )}
      {onAccept === undefined || state === "accepted" ? null : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => onAccept()}>
          Accept
        </Button>
      )}
      {onReject === undefined || state === "not_accepted" ? null : (
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => onReject()}>
          Not accepted
        </Button>
      )}
      {onRunAgain === undefined ? null : (
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onRunAgain()}>
          Run triage again
        </Button>
      )}
    </div>
  );
}
