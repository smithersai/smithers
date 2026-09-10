/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { Button } from "../button";

export type ApprovalState =
  | "synchronizing"
  | "requested"
  | "approving"
  | "denying"
  | "approved"
  | "denied"
  | "expired"
  | "unavailable"
  | "failed-submission";

/** Map approval states onto the shared status vocabulary (freeze v2 §0.6). */
export function approvalStateToStatus(state: ApprovalState): string {
  switch (state) {
    case "synchronizing":
      return "pending";
    case "requested":
      return "waiting-approval";
    case "approving":
    case "denying":
      return "running";
    case "approved":
      return "ok";
    case "denied":
      return "denied";
    case "expired":
      return "stale";
    case "unavailable":
      return "missing";
    case "failed-submission":
      return "error";
  }
}

/**
 * The screen-reader label for each approval state. Distinct for all nine
 * states — unlike the shared status vocabulary, which collapses approving /
 * denying and renames approved/expired/unavailable — so the live region
 * announces the actual decision lifecycle.
 */
export function approvalStateLabel(state: ApprovalState): string {
  switch (state) {
    case "synchronizing":
      return "Synchronizing approval";
    case "requested":
      return "Waiting for approval";
    case "approving":
      return "Approving";
    case "denying":
      return "Denying";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "expired":
      return "Approval expired";
    case "unavailable":
      return "Approval unavailable";
    case "failed-submission":
      return "Approval submission failed";
  }
}

type ConfirmationContextValue = {
  state: ApprovalState;
};

const ConfirmationContext = createContext<ConfirmationContextValue | null>(null);

function useConfirmationState(): ApprovalState {
  const ctx = useContext(ConfirmationContext);
  if (!ctx) throw new Error("Confirmation parts must render inside <Confirmation>");
  return ctx.state;
}

export type ConfirmationProps = Omit<ComponentProps<"div">, "children"> & {
  state: ApprovalState;
  children: ReactNode;
};

function updateRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

/**
 * Human-in-the-loop approval gate anatomy (AI Elements Confirmation). The
 * root carries the state; parts self-show/hide from it:
 * - ConfirmationRequest: synchronizing | requested | approving | denying
 * - ConfirmationActions: requested | failed-submission
 * - ConfirmationAccepted: approved; ConfirmationRejected: denied
 * - expired | unavailable render a muted state note; failed-submission renders
 *   a destructive failure note next to the retryable actions.
 * AI SDK mapping: approval-requested→requested, approval-responded→approved|denied,
 * output-denied→denied.
 */
export function Confirmation({ state, children, className, ref, tabIndex, ...props }: ConfirmationProps) {
  useInjectUiCss();
  const status = approvalStateToStatus(state);
  const rootRef = useRef<HTMLDivElement>(null);
  const previousState = useRef(state);
  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      updateRef(ref, node);
    },
    [ref],
  );

  useEffect(() => {
    const previous = previousState.current;
    previousState.current = state;
    if (previous !== "approving" && previous !== "denying") return;
    if (state === "failed-submission") {
      rootRef.current
        ?.querySelector<HTMLButtonElement>(`[data-decision='${previous === "approving" ? "approve" : "deny"}']`)
        ?.focus();
    } else if (state === "approved" || state === "denied") {
      rootRef.current?.focus();
    }
  }, [state]);

  return (
    <ConfirmationContext.Provider value={{ state }}>
      <div
        ref={setRootRef}
        data-slot="confirmation"
        data-state={state}
        data-status={status}
        tabIndex={tabIndex ?? -1}
        className={cn("sui-confirm", className)}
        {...props}
      >
        {children}
        {state === "expired" || state === "unavailable" ? (
          <div data-slot="confirmation-note" className="sui-confirm-note">
            {state === "expired" ? "This approval request has expired." : "This approval is unavailable."}
          </div>
        ) : null}
        {state === "failed-submission" ? (
          <div data-slot="confirmation-note" className="sui-confirm-note sui-confirm-failure">
            Submission failed — check the connection and try again.
          </div>
        ) : null}
        <span className="sui-sr-only" role="status" aria-live="polite">
          {approvalStateLabel(state)}
        </span>
      </div>
    </ConfirmationContext.Provider>
  );
}

export function ConfirmationTitle({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="confirmation-title" className={cn("sui-confirm-title", className)} {...props} />;
}

/** Request body; visible while synchronizing, requested, approving, or denying. */
export function ConfirmationRequest({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const state = useConfirmationState();
  if (state !== "synchronizing" && state !== "requested" && state !== "approving" && state !== "denying") {
    return null;
  }
  return <div data-slot="confirmation-request" className={cn("sui-confirm-request", className)} {...props} />;
}

/** Resolution body; visible once approved. */
export function ConfirmationAccepted({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const state = useConfirmationState();
  if (state !== "approved") return null;
  return (
    <div data-slot="confirmation-accepted" className={cn("sui-confirm-accepted", className)} {...props}>
      {children ?? "Approved"}
    </div>
  );
}

/** Resolution body; visible once denied. */
export function ConfirmationRejected({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const state = useConfirmationState();
  if (state !== "denied") return null;
  return (
    <div data-slot="confirmation-rejected" className={cn("sui-confirm-rejected", className)} {...props}>
      {children ?? "Denied"}
    </div>
  );
}

/** Action row; visible while requested or after a failed submission (retry). */
export function ConfirmationActions({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const state = useConfirmationState();
  if (state !== "requested" && state !== "failed-submission") return null;
  return (
    <div
      data-slot="confirmation-actions"
      role="group"
      aria-label="Approval actions"
      className={cn("sui-confirm-actions", className)}
      {...props}
    />
  );
}

export type ConfirmationActionProps = Omit<ComponentProps<"button">, "children"> & {
  decision: "approve" | "deny";
  onDecide?: (decision: "approve" | "deny") => void;
  children?: ReactNode;
};

/** Approve (solid primary) or deny (destructive outline) button. */
export function ConfirmationAction({
  decision,
  onDecide,
  children,
  className,
  onClick,
  disabled,
  ...props
}: ConfirmationActionProps) {
  useInjectUiCss();
  const state = useConfirmationState();
  const busy = state === "approving" || state === "denying";
  return (
    <Button
      type="button"
      data-slot="confirmation-action"
      data-decision={decision}
      variant={decision === "approve" ? "solid" : "destructive"}
      className={cn("sui-confirm-action", className)}
      disabled={busy ? true : disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onDecide?.(decision);
      }}
      {...props}
    >
      {children ?? (decision === "approve" ? "Approve" : "Deny")}
    </Button>
  );
}
