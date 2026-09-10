/** @jsxImportSource react */
import { type ComponentProps, createContext, type ReactNode, useContext, useId, useState } from "react";
import { cn } from "../cn";
import { formatStatus, statusClass } from "../status";
import { useInjectUiCss } from "../styles";

export type PlanStepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export type PlanProps = Omit<ComponentProps<"section">, "children" | "title"> & {
  streaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
};

/** Map plan states onto the shared status vocabulary. */
export function planStepStatus(status: PlanStepStatus): "pending" | "running" | "complete" | "failed" | "skipped" {
  switch (status) {
    case "active":
      return "running";
    case "done":
      return "complete";
    default:
      return status;
  }
}

type PlanContextValue = {
  open: boolean;
  toggle: () => void;
  streaming: boolean;
  triggerId: string | undefined;
  contentId: string | undefined;
};

const PlanContext = createContext<PlanContextValue | null>(null);

function usePlanContext(part: string): PlanContextValue {
  const context = useContext(PlanContext);
  if (!context) throw new Error(`${part} must render inside <Plan>`);
  return context;
}

function usePlanCss(): void {
  useInjectUiCss();
}

/** Header row of a compound Plan; hosts PlanTrigger, PlanTitle, PlanAction. */
export function PlanHeader({ className, ...props }: ComponentProps<"div">) {
  usePlanCss();
  usePlanContext("PlanHeader");
  return <div data-slot="plan-header" className={cn("sui-plan-header", className)} {...props} />;
}

/** Title text of a compound Plan; shimmers while the plan streams. */
export function PlanTitle({ className, ...props }: ComponentProps<"div">) {
  usePlanCss();
  const { streaming } = usePlanContext("PlanTitle");
  return (
    <div
      data-slot="plan-title"
      data-shimmer={streaming ? "true" : "false"}
      className={cn("sui-plan-title", className)}
      {...props}
    />
  );
}

/** Optional descriptive text under the plan header. */
export function PlanDescription({ className, ...props }: ComponentProps<"div">) {
  usePlanCss();
  usePlanContext("PlanDescription");
  return <div data-slot="plan-description" className={cn("sui-plan-description", className)} {...props} />;
}

/** Compound-mode disclosure trigger toggling the Plan body. */
export function PlanTrigger({ className, children, onClick, ...props }: ComponentProps<"button">) {
  usePlanCss();
  const { open, toggle, triggerId, contentId } = usePlanContext("PlanTrigger");
  return (
    <button
      type="button"
      data-slot="plan-trigger"
      id={triggerId}
      className={cn("sui-plan-trigger", className)}
      aria-expanded={open}
      aria-controls={contentId}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) toggle();
      }}
      {...props}
    >
      <span className="sui-plan-chevron" aria-hidden="true">
        ›
      </span>
      {children}
    </button>
  );
}

/** Compound-mode body region of a Plan; mounted only while open. */
export function PlanContent({ className, ...props }: ComponentProps<"div">) {
  usePlanCss();
  const { open, triggerId, contentId } = usePlanContext("PlanContent");
  if (!open) return null;
  return (
    <div
      data-slot="plan-content"
      role="region"
      id={contentId}
      aria-labelledby={triggerId}
      className={cn("sui-plan-content", className)}
      {...props}
    />
  );
}

export type PlanStepProps = Omit<ComponentProps<"li">, "children" | "title"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  label: ReactNode;
  status?: PlanStepStatus;
  children?: ReactNode;
};

/**
 * A single collapsible plan step in the compound anatomy.
 */
export function PlanStep({
  label,
  status = "pending",
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  children,
  ...props
}: PlanStepProps) {
  usePlanCss();
  usePlanContext("PlanStep");
  const bodyId = useId();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const mapped = planStepStatus(status);
  const hasDetail = children !== undefined && children !== null;

  function toggleDetail() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <li
      data-slot="plan-step"
      data-status={mapped}
      data-status-class={statusClass(mapped)}
      data-state={open ? "open" : "closed"}
      className={cn("sui-plan-step", className)}
      {...props}
    >
      <div className="sui-plan-step-row">
        <span className="sui-plan-step-dot" aria-hidden="true" />
        <span className="sui-sr-only">
          {formatStatus(mapped)}:{" "}
        </span>
        <span className="sui-plan-step-label">{label}</span>
        {hasDetail ?
          (
            <button
              type="button"
              data-slot="plan-step-toggle"
              className="sui-plan-step-toggle"
              aria-expanded={open}
              aria-controls={bodyId}
              aria-label={typeof label === "string" ? `Details: ${label}` : "Step details"}
              onClick={toggleDetail}
            >
              Details
            </button>
          ) :
          null}
      </div>
      {hasDetail && open ?
        (
          <div data-slot="plan-step-detail" id={bodyId} className="sui-plan-step-detail">
            {children}
          </div>
        ) :
        null}
    </li>
  );
}

/** A small ghost button for plan-level actions (header or footer). */
export function PlanAction({ className, type, ...props }: ComponentProps<"button">) {
  usePlanCss();
  usePlanContext("PlanAction");
  return (
    <button type={type ?? "button"} data-slot="plan-action" className={cn("sui-plan-action", className)} {...props} />
  );
}

/** Footer row of a compound Plan. */
export function PlanFooter({ className, ...props }: ComponentProps<"div">) {
  usePlanCss();
  usePlanContext("PlanFooter");
  return <div data-slot="plan-footer" className={cn("sui-plan-footer", className)} {...props} />;
}

/** Structured, collapsible progress plan. */
export function Plan({
  streaming = false,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  className,
  children,
  ...props
}: PlanProps) {
  usePlanCss();
  const triggerId = useId();
  const contentId = useId();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  function toggle() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <PlanContext.Provider value={{ open, toggle, streaming, triggerId, contentId }}>
      <section
        data-slot="plan"
        data-state={open ? "open" : "closed"}
        data-streaming={streaming ? "true" : "false"}
        className={cn("sui-plan", className)}
        {...props}
      >
        {children}
      </section>
    </PlanContext.Provider>
  );
}
