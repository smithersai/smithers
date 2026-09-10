/** @jsxImportSource react */
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type CompactGroupProps = Omit<ComponentProps<"div">, "children"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Number of compacted turns collapsed inside. */
  count: number;
  /** Trigger label; defaults to '<count> earlier messages'. */
  label?: ReactNode;
  children: ReactNode;
};

/** Collapsed run of compacted conversation turns behind a disclosure. */
export function CompactGroup({
  open,
  defaultOpen = false,
  onOpenChange,
  count,
  label,
  className,
  children,
  ...props
}: CompactGroupProps) {
  useInjectUiCss();
  const triggerId = useId();
  const contentId = useId();
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = open ?? internalOpen;
  const requestOpen = (next: boolean) => {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  return (
    <div
      data-slot="compact-group"
      data-open={isOpen ? "true" : "false"}
      className={cn("sui-compact-group", className)}
      {...props}
    >
      <button
        type="button"
        data-slot="compact-group-trigger"
        id={triggerId}
        className="sui-compact-group-trigger"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={() => requestOpen(!isOpen)}
      >
        <span aria-hidden="true" className="sui-compact-group-chevron">
          ▸
        </span>
        <span>{label ?? `${count} earlier messages`}</span>
      </button>
      {isOpen ? (
        <div
          data-slot="compact-group-content"
          id={contentId}
          role="region"
          aria-labelledby={triggerId}
          className="sui-compact-group-content"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
