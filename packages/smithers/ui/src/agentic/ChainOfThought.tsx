/** @jsxImportSource react */
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { formatStatus, statusClass } from "../status";
import { useInjectUiCss } from "../styles";

export type ChainOfThoughtStepStatus = "pending" | "active" | "done";

export type ChainOfThoughtStep = {
  id: string;
  label: ReactNode;
  status?: ChainOfThoughtStepStatus;
  /**
   * Tool/progress detail for the step. This is user-visible progress detail,
   * never a channel for raw private chain-of-thought.
   */
  detail?: ReactNode;
};

type ChainOfThoughtOpenable = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export type ChainOfThoughtProps = Omit<ComponentProps<"div">, "children"> &
  ChainOfThoughtOpenable & {
    streaming?: boolean;
    title?: string;
  } & ({ steps: readonly ChainOfThoughtStep[]; children?: never } | { children: ReactNode; steps?: never });

/** Map chain-of-thought states into the shared status vocabulary. */
export function chainOfThoughtStepStatus(
  status: ChainOfThoughtStepStatus | undefined,
): "pending" | "running" | "complete" {
  if (status === "active") return "running";
  if (status === "done") return "complete";
  return "pending";
}

/**
 * Labelled polite live region announcing streaming state transitions. Kept
 * visually hidden (sui-sr-only), so the presentation carries no motion and is
 * reduced-motion safe by construction.
 */
function ChainOfThoughtLiveRegion({ title, announcement }: { title: string; announcement: string }) {
  return (
    <span
      data-slot="chain-of-thought-live"
      className="sui-sr-only"
      role="status"
      aria-live="polite"
      aria-label={`${title} status`}
    >
      {announcement}
    </span>
  );
}

/** Ordered, streaming-aware reasoning steps. */
export function ChainOfThought({
  streaming = false,
  title = "Chain of thought",
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  className,
  steps,
  children,
  ...props
}: ChainOfThoughtProps) {
  useInjectUiCss();
  const bodyId = `${useId()}-chain-of-thought-body`;
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(() => defaultOpen ?? streaming);
  const previousStreaming = useRef(streaming);
  const userToggled = useRef(false);
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const previous = previousStreaming.current;
    previousStreaming.current = streaming;
    if (previous !== streaming) {
      setAnnouncement(streaming ? `${title} in progress` : `${title} complete`);
    }
    if (previous === streaming || isControlled || userToggled.current) return;
    setUncontrolledOpen(streaming);
    onOpenChange?.(streaming);
  }, [isControlled, onOpenChange, streaming, title]);

  function toggle() {
    const next = !isOpen;
    userToggled.current = true;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <div
      data-slot="chain-of-thought"
      data-state={isOpen ? "open" : "closed"}
      data-streaming={streaming ? "true" : "false"}
      className={cn("sui-cot", className)}
      {...props}
    >
      <ChainOfThoughtLiveRegion title={title} announcement={announcement} />
      <button
        type="button"
        data-slot="chain-of-thought-trigger"
        className="sui-cot-trigger"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <span className="sui-cot-chevron" aria-hidden="true">
          ›
        </span>
        <span className="sui-cot-title" data-shimmer={streaming ? "true" : "false"}>
          {title}
        </span>
      </button>
      {isOpen ? (
        <div data-slot="chain-of-thought-body" id={bodyId} className="sui-cot-body">
          <ol className="sui-cot-steps">
            {steps
              ? steps.map((step) => {
                  const mapped = chainOfThoughtStepStatus(step.status);
                  return (
                    <li
                      key={step.id}
                      data-slot="chain-of-thought-step"
                      data-status={mapped}
                      data-status-class={statusClass(mapped)}
                      className="sui-cot-step"
                    >
                      <span className="sui-cot-step-dot" aria-hidden="true" />
                      <span className="sui-sr-only">{formatStatus(mapped)}: </span>
                      <span className="sui-cot-step-label">{step.label}</span>
                      {step.detail != null ? <div className="sui-cot-step-detail">{step.detail}</div> : null}
                    </li>
                  );
                })
              : children}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

export type ChainOfThoughtStepProps = Omit<ComponentProps<"li">, "children" | "title"> &
  ChainOfThoughtOpenable & {
    label: ReactNode;
    status?: ChainOfThoughtStepStatus;
    icon?: ReactNode;
    /** Step detail (tool/progress detail), collapsible; defaultOpen false. */
    children?: ReactNode;
  };

/** A single chain-of-thought step with optional collapsible detail. */
export function ChainOfThoughtStep({
  label,
  status,
  icon,
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  ...props
}: ChainOfThoughtStepProps) {
  useInjectUiCss();
  const baseId = useId();
  const detailId = `${baseId}-cot-step-detail`;
  const triggerId = `${baseId}-cot-step-trigger`;
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const mapped = chainOfThoughtStepStatus(status);
  const hasDetail = children != null;

  function toggle() {
    const next = !isOpen;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const iconSlot =
    icon != null ? (
      <span className="sui-cot-step-icon" aria-hidden="true">
        {icon}
      </span>
    ) : null;

  return (
    <li
      data-slot="chain-of-thought-step"
      data-status={mapped}
      data-status-class={statusClass(mapped)}
      className={cn("sui-cot-step", className)}
      {...props}
    >
      <span className="sui-cot-step-dot" aria-hidden="true" />
      <span className="sui-sr-only">{formatStatus(mapped)}: </span>
      {hasDetail ? (
        <button
          type="button"
          id={triggerId}
          className="sui-cot-step-trigger"
          aria-expanded={isOpen}
          aria-controls={detailId}
          onClick={toggle}
        >
          {iconSlot}
          <span className="sui-cot-step-label">{label}</span>
        </button>
      ) : (
        <>
          {iconSlot}
          <span className="sui-cot-step-label">{label}</span>
        </>
      )}
      {hasDetail && isOpen ? (
        <div role="region" id={detailId} aria-labelledby={triggerId} className="sui-cot-step-detail">
          {children}
        </div>
      ) : null}
    </li>
  );
}
