/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { formatStatus, normalizeStatus, statusClass } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";
import { formatDuration } from "../internal/formatDuration";

export type TaskItemProps = Omit<ComponentProps<"div">, "children"> & {
  label: ReactNode;
  status: string;
  files?: readonly string[];
  elapsedSeconds?: number;
  children?: ReactNode;
};

export type TaskItemFileProps = Omit<ComponentProps<"span">, "children"> & {
  name: string;
  icon?: ReactNode;
};

/** A file chip associated with a task, with an optional leading icon. */
export function TaskItemFile({ name, icon, className, ...props }: TaskItemFileProps) {
  useInjectUiCss();
  return (
    <span data-slot="task-item-file" className={cn("sui-taskitem-file", className)} {...props}>
      {icon !== undefined ? (
        <span className="sui-taskitem-file-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {name}
    </span>
  );
}

/** A compact status-aware unit-of-work row for plans and standalone lists. */
export function TaskItem({ label, status, files, elapsedSeconds, className, children, ...props }: TaskItemProps) {
  useInjectUiCss();
  const normalized = normalizeStatus(status);
  const tone = statusClass(status);

  return (
    <div
      data-slot="task-item"
      data-status={normalized}
      className={cn("sui-taskitem", `sui-taskitem-${tone}`, className)}
      {...props}
    >
      <span className="sui-taskitem-dot" aria-hidden="true" />
      <span className="sui-sr-only">{formatStatus(status)}: </span>
      <span className="sui-taskitem-label">{label}</span>
      {children}
      {files && files.length > 0 ? (
        <span data-slot="task-item-files" className="sui-taskitem-files">
          {files.map((file) => (
            <span className="sui-taskitem-file" key={file}>
              {file}
            </span>
          ))}
        </span>
      ) : null}
      {elapsedSeconds !== undefined ? (
        <span className="sui-taskitem-elapsed">{formatDuration(elapsedSeconds)}</span>
      ) : null}
    </div>
  );
}
