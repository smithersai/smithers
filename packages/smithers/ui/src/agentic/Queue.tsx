/** @jsxImportSource react */
import { createContext, useContext, useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { formatStatus, normalizeStatus, statusClass } from "../status";
import { useInjectUiCss } from "../styles";

function useQueueCss(): void {
  useInjectUiCss();
}

type QueueSectionContextValue = {
  open: boolean;
  toggle: () => void;
  triggerId: string;
  contentId: string;
};

const QueueSectionContext = createContext<QueueSectionContextValue | null>(null);

type QueueItemContextValue = {
  status: string | undefined;
  completed: boolean;
};

const QueueItemContext = createContext<QueueItemContextValue>({ status: undefined, completed: false });

/** Region grouping queued work into collapsible sections. */
export function Queue({ className, ...props }: ComponentProps<"div">) {
  useQueueCss();
  return <div data-slot="queue" role="region" aria-label="Queue" className={cn("sui-queue", className)} {...props} />;
}

export type QueueSectionProps = Omit<ComponentProps<"div">, "children"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
};

/** A collapsible section of the queue; open by default. */
export function QueueSection({
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  className,
  children,
  ...props
}: QueueSectionProps) {
  useQueueCss();
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
    <QueueSectionContext.Provider value={{ open, toggle, triggerId, contentId }}>
      <div
        data-slot="queue-section"
        data-state={open ? "open" : "closed"}
        className={cn("sui-queue-section", className)}
        {...props}
      >
        {children}
      </div>
    </QueueSectionContext.Provider>
  );
}

/** Disclosure trigger for a QueueSection. */
export function QueueSectionTrigger({ className, children, onClick, ...props }: ComponentProps<"button">) {
  useQueueCss();
  const context = useContext(QueueSectionContext);
  if (!context) throw new Error("QueueSectionTrigger must render inside <QueueSection>");
  const { open, toggle, triggerId, contentId } = context;
  return (
    <button
      type="button"
      data-slot="queue-section-trigger"
      id={triggerId}
      className={cn("sui-queue-section-trigger", className)}
      aria-expanded={open}
      aria-controls={contentId}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) toggle();
      }}
      {...props}
    >
      <span className="sui-queue-section-chevron" aria-hidden="true">
        ›
      </span>
      {children}
    </button>
  );
}

export type QueueSectionLabelProps = Omit<ComponentProps<"span">, "children"> & {
  label: ReactNode;
  count?: number;
  icon?: ReactNode;
};

/** Label row for a queue section: optional icon, label text, and item count. */
export function QueueSectionLabel({ label, count, icon, className, ...props }: QueueSectionLabelProps) {
  useQueueCss();
  return (
    <span data-slot="queue-section-label" className={cn("sui-queue-section-label", className)} {...props}>
      {icon !== undefined ? (
        <span className="sui-queue-section-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {label}
      {count !== undefined ? <span className="sui-queue-section-count">{count}</span> : null}
    </span>
  );
}

/** Body region of a queue section; mounted only while open. */
export function QueueSectionContent({ className, ...props }: ComponentProps<"div">) {
  useQueueCss();
  const context = useContext(QueueSectionContext);
  if (!context) throw new Error("QueueSectionContent must render inside <QueueSection>");
  const { open, triggerId, contentId } = context;
  if (!open) return null;
  return (
    <div
      data-slot="queue-section-content"
      role="region"
      id={contentId}
      aria-labelledby={triggerId}
      className={cn("sui-queue-section-content", className)}
      {...props}
    />
  );
}

/** The list of queue items inside a section. */
export function QueueList({ className, ...props }: ComponentProps<"ul">) {
  useQueueCss();
  return <ul data-slot="queue-list" role="list" className={cn("sui-queue-list", className)} {...props} />;
}

export type QueueItemProps = Omit<ComponentProps<"li">, "title"> & {
  completed?: boolean;
  status?: string;
};

function resolveQueueItem(status: string | undefined, completed: boolean | undefined): QueueItemContextValue {
  const resolvedStatus = status !== undefined ? status : completed === true ? "completed" : undefined;
  return {
    status: resolvedStatus,
    completed: normalizeStatus(resolvedStatus) === "completed",
  };
}

/**
 * A single queued unit of work. `status` wins over `completed` when both are
 * given; `completed` alone is equivalent to status "completed".
 */
export function QueueItem({ completed, status, className, children, ...props }: QueueItemProps) {
  useQueueCss();
  const resolved = resolveQueueItem(status, completed);
  return (
    <QueueItemContext.Provider value={resolved}>
      <li
        data-slot="queue-item"
        data-status={resolved.status !== undefined ? normalizeStatus(resolved.status) : undefined}
        data-status-class={statusClass(resolved.status)}
        data-completed={resolved.completed ? "true" : "false"}
        className={cn("sui-queue-item", className)}
        {...props}
      >
        {children}
      </li>
    </QueueItemContext.Provider>
  );
}

export type QueueItemIndicatorProps = Omit<ComponentProps<"span">, "children"> & {
  completed?: boolean;
  status?: string;
};

/** Status dot/check for a queue item; inherits the item status from context. */
export function QueueItemIndicator({ completed, status, className, ...props }: QueueItemIndicatorProps) {
  useQueueCss();
  const context = useContext(QueueItemContext);
  const resolved = status !== undefined || completed !== undefined ? resolveQueueItem(status, completed) : context;
  return (
    <span
      data-slot="queue-item-indicator"
      data-status-class={statusClass(resolved.status)}
      className={cn("sui-queue-item-indicator", className)}
      {...props}
    >
      <span aria-hidden="true">{resolved.completed ? "✓" : ""}</span>
      <span className="sui-sr-only">{formatStatus(resolved.status)}: </span>
    </span>
  );
}

/** Primary text of a queue item; struck through while completed. */
export function QueueItemContent({ className, ...props }: ComponentProps<"div">) {
  useQueueCss();
  const { completed } = useContext(QueueItemContext);
  return (
    <div
      data-slot="queue-item-content"
      data-completed={completed ? "true" : "false"}
      className={cn("sui-queue-item-content", className)}
      {...props}
    />
  );
}

/** Secondary descriptive text of a queue item. */
export function QueueItemDescription({ className, ...props }: ComponentProps<"div">) {
  useQueueCss();
  return <div data-slot="queue-item-description" className={cn("sui-queue-item-description", className)} {...props} />;
}
