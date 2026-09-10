/** @jsxImportSource react */
import { createContext, useContext, useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { StatusPill } from "../status-pill";
import { useInjectUiCss } from "../styles";

type AgentTaskContextValue = {
  open: boolean;
  toggle: () => void;
  title: ReactNode;
  status: string | undefined;
  triggerId: string;
  contentId: string;
};

const AgentTaskContext = createContext<AgentTaskContextValue | null>(null);

function useAgentTaskContext(): AgentTaskContextValue {
  const context = useContext(AgentTaskContext);
  if (!context) throw new Error("AgentTask parts must render inside <AgentTask>");
  return context;
}

export type AgentTaskProps = Omit<ComponentProps<"div">, "children" | "title"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  status?: string;
  children?: ReactNode;
};

/**
 * A collapsible unit-of-work card: trigger row with title + status pill, and
 * a body region hosting TaskItem rows or any detail content.
 */
export function AgentTask({
  title,
  status,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  children,
  ...props
}: AgentTaskProps) {
  useInjectUiCss();
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
    <AgentTaskContext.Provider value={{ open, toggle, title, status, triggerId, contentId }}>
      <div
        data-slot="agent-task"
        data-state={open ? "open" : "closed"}
        data-status={status}
        className={cn("sui-agenttask", className)}
        {...props}
      >
        {children}
      </div>
    </AgentTaskContext.Provider>
  );
}

/** Disclosure trigger for an AgentTask; shows the task title and status pill. */
export function AgentTaskTrigger({ className, children, onClick, ...props }: ComponentProps<"button">) {
  useInjectUiCss();
  const { open, toggle, title, status, triggerId, contentId } = useAgentTaskContext();
  return (
    <button
      type="button"
      data-slot="agent-task-trigger"
      id={triggerId}
      className={cn("sui-agenttask-trigger", className)}
      aria-expanded={open}
      aria-controls={contentId}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) toggle();
      }}
      {...props}
    >
      <span className="sui-agenttask-chevron" aria-hidden="true">
        ›
      </span>
      {children ?? (
        <>
          <span className="sui-agenttask-title">{title}</span>
          {status !== undefined ? <StatusPill status={status} /> : null}
        </>
      )}
    </button>
  );
}

export type AgentTaskContentProps = ComponentProps<"div"> & {
  forceMount?: boolean;
};

/** Body region of an AgentTask; optionally remains mounted for exit animations. */
export function AgentTaskContent({ className, forceMount = false, ...props }: AgentTaskContentProps) {
  useInjectUiCss();
  const { open, triggerId, contentId } = useAgentTaskContext();
  if (!open && !forceMount) return null;
  return (
    <div
      data-slot="agent-task-content"
      role="region"
      id={contentId}
      aria-labelledby={triggerId}
      aria-hidden={!open}
      data-state={open ? "open" : "closed"}
      className={cn("sui-agenttask-content", className)}
      {...props}
    />
  );
}

/** A list grouping several AgentTask units. */
export function AgentTaskGroup({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="agent-task-group" role="list" className={cn("sui-agenttask-group", className)} {...props} />;
}
