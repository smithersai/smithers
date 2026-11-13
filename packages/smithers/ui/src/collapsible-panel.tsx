/** @jsxImportSource react */
import { useState, type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { StatusPill } from "./status-pill";
import { useInjectUiCss } from "./styles";

const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, [role="button"]';

export type CollapsiblePanelProps = Omit<ComponentProps<"section">, "title"> & {
  /** Header label. */
  title: ReactNode;
  /**
   * A run/node status string (e.g. "running", "ok", "failed"). Renders a
   * {@link StatusPill} in the header, so the glyph and tint come from the
   * shared `status.ts` vocabulary rather than being re-derived here.
   */
  status?: string;
  /** Override the status pill label (defaults to the humanized status). */
  statusLabel?: string;
  /** Optional secondary line in the header (e.g. "3 files", "tests passing"). */
  meta?: ReactNode;
  /** Initial open state when uncontrolled (default true). */
  defaultOpen?: boolean;
  /** Controlled open state; pair with {@link CollapsiblePanelProps.onOpenChange}. */
  open?: boolean;
  /** Fired with the next open state whenever the header toggles. */
  onOpenChange?: (open: boolean) => void;
  /** Force the empty fallback even when children are present (e.g. still loading). */
  pending?: boolean;
  /** Fallback shown when the body has no content (or {@link CollapsiblePanelProps.pending}). */
  emptyText?: ReactNode;
  children?: ReactNode;
};

/** Whether the rendered children collapse to nothing (so the fallback shows). */
function isEmptyContent(children: ReactNode): boolean {
  if (children == null || children === false || children === true || children === "") return true;
  if (Array.isArray(children)) return children.every(isEmptyContent);
  return false;
}

/**
 * A collapsible titled section: a status pill/glyph, an optional meta line, a
 * pending/empty fallback, and collapsible children. This is the shared shape
 * workflow UIs previously duplicated as `Panel` and `PhaseCard`. Open state is
 * uncontrolled by default (starts open); pass `open`/`onOpenChange` to drive it.
 * Styled entirely through the ui tokens and the shared {@link StatusPill}, with
 * no coupling to any workflow's node shape.
 */
export function CollapsiblePanel({
  title,
  status,
  statusLabel,
  meta,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  pending = false,
  emptyText,
  className,
  children,
  ...props
}: CollapsiblePanelProps) {
  useInjectUiCss();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  function toggle() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  }

  function onClick(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return;
    const interactive = event.target.closest(INTERACTIVE_SELECTOR);
    if (interactive !== null && interactive !== event.currentTarget) return;
    toggle();
  }

  const showFallback = pending || isEmptyContent(children);

  return (
    <section
      data-slot="collapsible-panel"
      data-state={open ? "open" : "closed"}
      className={cn("sui-collapsible", className)}
      {...props}
    >
      <div
        className="sui-collapsible-header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <span className="sui-collapsible-heading">
          <span className="sui-collapsible-title">{title}</span>
          {status !== undefined ? <StatusPill status={status} label={statusLabel} /> : null}
        </span>
        {meta != null ? <span className="sui-collapsible-meta">{meta}</span> : null}
        <span className="sui-collapsible-toggle" aria-hidden>
          {open ? "collapse" : "expand"}
        </span>
      </div>
      {open ? (
        showFallback ? (
          isEmptyContent(emptyText) ? null : <div className="sui-collapsible-empty">{emptyText}</div>
        ) : (
          <div className="sui-collapsible-body">{children}</div>
        )
      ) : null}
    </section>
  );
}
