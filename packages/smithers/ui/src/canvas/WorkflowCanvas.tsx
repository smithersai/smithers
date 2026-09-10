/** @jsxImportSource react */
import {
  useEffect,
  useRef,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Badge } from "../badge";
import { cn } from "../cn";
import { formatStatus, statusClass, type StatusClass } from "../status";
import { StatusPill } from "../status-pill";
import { useInjectUiCss } from "../styles";

/**
 * Renderer-neutral workflow canvas anatomy: the visual language a graph
 * renderer (a ReactFlow layer, for example) composes into its node/edge
 * renderers. Purely presentational and props-driven — `@xyflow/react` never
 * enters this package. Geometry, pan/zoom, and selection behavior belong to
 * the renderer; these parts cover cards, legends, and overlay chrome only.
 */

function useCanvasCss(): void {
  useInjectUiCss();
}

const TOOLBAR_ITEM_SELECTOR = "button, [href], input, select, textarea, [tabindex]";

function isDisabledItem(el: HTMLElement): boolean {
  return el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
}

function toolbarItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TOOLBAR_ITEM_SELECTOR)).filter((el) => !isDisabledItem(el));
}

const ROVING_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * ARIA toolbar keyboard contract: one tab stop into the cluster, then Arrow
 * keys (either axis) / Home / End move between items with a roving tabindex.
 * Disabled (or aria-disabled) items are never assigned the roving tab stop
 * and never receive roved focus; modifier-key chords pass through untouched
 * so browser/OS shortcuts keep working.
 */
function useRovingTabIndex(ref: RefObject<HTMLElement | null>) {
  const currentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Sweep disabled items out of the tab order even if a previous pass
    // left them with tabIndex 0.
    for (const el of root.querySelectorAll<HTMLElement>(TOOLBAR_ITEM_SELECTOR)) {
      if (isDisabledItem(el)) el.tabIndex = -1;
    }
    const items = toolbarItems(root);
    if (items.length === 0) return;
    let index = currentRef.current ? items.indexOf(currentRef.current) : -1;
    if (index === -1) index = 0;
    items.forEach((el, i) => {
      el.tabIndex = i === index ? 0 : -1;
    });
    currentRef.current = items[index]!;
  });

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const { key } = event;
    if (!ROVING_KEYS.has(key)) return;
    const root = ref.current;
    if (!root) return;
    const items = toolbarItems(root);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    event.preventDefault();
    const next = key === "Home"
      ? 0
      : key === "End"
      ? items.length - 1
      : key === "ArrowRight" || key === "ArrowDown"
      ? (current + 1) % items.length
      : (current - 1 + items.length) % items.length;
    items.forEach((el, i) => {
      el.tabIndex = i === next ? 0 : -1;
    });
    currentRef.current = items[next]!;
    items[next]!.focus();
  }

  return onKeyDown;
}

/** Non-color status signifier shapes, one per shared status class. */
const STATUS_CLASS_GLYPH: Record<StatusClass, string> = {
  ok: "\u2713",
  bad: "\u2715",
  run: "\u25CF",
  warn: "\u25B2",
  muted: "\u25CB",
};

export type WorkflowCanvasProps = ComponentProps<"div">;

/**
 * The labelled region a renderer paints its canvas into. `role="group"` (not
 * `role="application"`: no application-mode keyboard contract exists at this
 * layer — pan/zoom/selection keys are the renderer's model).
 */
export function WorkflowCanvas({ className, role, "aria-label": ariaLabel, children, ...props }: WorkflowCanvasProps) {
  useCanvasCss();
  return (
    <div
      data-slot="workflow-canvas"
      role={role ?? "group"}
      aria-label={ariaLabel ?? "Workflow canvas"}
      className={cn("sui-canvas", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export type WorkflowNodeProps = Omit<ComponentProps<"div">, "children" | "title"> & {
  /** Card title; renders in the header row. */
  title?: ReactNode;
  /** Run/node status string, rendered as a StatusPill. */
  status?: string;
  /** Node kind discriminator (e.g. "agent", "approval"), rendered as a Badge. */
  kind?: string;
  /**
   * Selected ring (data-selected + aria-selected), driven by the renderer's
   * selection state. Providing it puts the node in a selection model: the
   * card renders with `role="option"` (a role that supports aria-selected,
   * so the state survives into the accessibility tree) instead of the
   * generic div role, where aria-selected is unsupported and stripped.
   * `role="option"` has a required context: the renderer MUST provide an
   * owning selection-model ancestor (e.g. `WorkflowCanvas role="listbox"`)
   * or strip the option semantics in its own node wrapper, or the option is
   * orphaned in the accessibility tree.
   */
  selected?: boolean;
  children?: ReactNode;
};

/**
 * One node card. With `title`/`kind`/`status` props it renders its own header
 * row; children render verbatim after it (or compose WorkflowNodeHeader /
 * WorkflowNodeContent directly and pass no header props). Renderer handles
 * (ReactFlow `<Handle>`s) are passed as children by the renderer.
 */

export function WorkflowNode({ title, status, kind, selected, className, children, ...props }: WorkflowNodeProps) {
  useCanvasCss();
  const hasHeader = title != null || kind !== undefined || status !== undefined;
  return (
    <div
      data-slot="workflow-node"
      data-status={status}
      data-kind={kind}
      data-selected={selected ? "true" : "false"}
      role={selected !== undefined ? "option" : undefined}
      aria-selected={selected !== undefined ? selected : undefined}
      className={cn("sui-canvas-node", className)}
      {...props}
    >
      {hasHeader ?
        (
          <WorkflowNodeHeader>
            {kind !== undefined ?
              (
                <Badge variant="muted" className="sui-canvas-node-kind">
                  {kind}
                </Badge>
              ) :
              null}
            {title != null ? <span className="sui-canvas-node-title">{title}</span> : null}
            {status !== undefined ? <WorkflowNodeStatus status={status} /> : null}
          </WorkflowNodeHeader>
        ) :
        null}
      {children}
    </div>
  );
}

export function WorkflowNodeHeader({ className, ...props }: ComponentProps<"div">) {
  useCanvasCss();
  return <div data-slot="workflow-node-header" className={cn("sui-canvas-node-header", className)} {...props} />;
}

export function WorkflowNodeContent({ className, ...props }: ComponentProps<"div">) {
  useCanvasCss();
  return <div data-slot="workflow-node-content" className={cn("sui-canvas-node-content", className)} {...props} />;
}

export type WorkflowNodeStatusProps = Omit<ComponentProps<"span">, "children"> & {
  /** Any status string; piped through the shared status vocabulary. */
  status: string;
};

export function WorkflowNodeStatus({ status, className, ...props }: WorkflowNodeStatusProps) {
  useCanvasCss();
  return (
    <StatusPill
      status={status}
      data-slot="workflow-node-status"
      className={cn("sui-canvas-node-status", className)}
      {...props}
    />
  );
}

export type WorkflowEdgeProps = Omit<ComponentProps<"span">, "children"> & {
  /** Source node id/label. */
  from?: string;
  /** Target node id/label. */
  to?: string;
  /** Optional edge label (e.g. a condition). */
  label?: ReactNode;
  /** Edge status; colors the leading dot via the shared status classes. */
  status?: string;
};

/**
 * The legend/inline representation of an edge (`from → to` with an optional
 * label and status dot). Drawing the edge geometry is the renderer's job.
 */
export function WorkflowEdge({ from, to, label, status, className, ...props }: WorkflowEdgeProps) {
  useCanvasCss();
  return (
    <span
      data-slot="workflow-edge"
      data-status={status}
      data-status-class={status !== undefined ? statusClass(status) : undefined}
      className={cn("sui-canvas-edge", className)}
      {...props}
    >
      {status !== undefined ?
        (
          <>
            <span aria-hidden className="sui-canvas-edge-glyph">
              {STATUS_CLASS_GLYPH[statusClass(status)]}
            </span>
            <span className="sui-sr-only">{formatStatus(status)}</span>
          </>
        ) :
        null}
      {from !== undefined ? <span className="sui-canvas-edge-end">{from}</span> : null}
      {from !== undefined && to !== undefined ?
        (
          <>
            <span aria-hidden className="sui-canvas-edge-arrow">
              →
            </span>
            <span className="sui-sr-only">to</span>
          </>
        ) :
        null}
      {to !== undefined ? <span className="sui-canvas-edge-end">{to}</span> : null}
      {label != null ? <span className="sui-canvas-edge-label">{label}</span> : null}
    </span>
  );
}

export type WorkflowConnectionProps = Omit<ComponentProps<"span">, "children"> & {
  /** Pending-connection validity, as reported by the renderer. */
  status?: "valid" | "invalid" | "pending";
};

/**
 * The legend/inline representation of an in-progress connection drag. The
 * live drag line itself is painted by the renderer.
 */
export function WorkflowConnection({ status = "pending", className, ...props }: WorkflowConnectionProps) {
  useCanvasCss();
  return (
    <span
      data-slot="workflow-connection"
      data-status={status}
      className={cn("sui-canvas-connection", className)}
      {...props}
    >
      <span className="sui-sr-only">{`Connection ${status}`}</span>
    </span>
  );
}

export type WorkflowControlsProps = Omit<ComponentProps<"div">, "children"> & {
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFitView?: () => void;
  children?: ReactNode;
};

/**
 * Zoom/fit control cluster. Each button renders only when its callback is
 * provided; the actual zoom behavior lives in the renderer, which wires these
 * callbacks to its viewport API. Keyboard follows the ARIA toolbar contract:
 * one tab stop in, then Arrow keys / Home / End rove between buttons.
 */
export function WorkflowControls({
  onZoomIn,
  onZoomOut,
  onFitView,
  className,
  children,
  onKeyDown,
  ...props
}: WorkflowControlsProps) {
  useCanvasCss();
  const ref = useRef<HTMLDivElement>(null);
  const rove = useRovingTabIndex(ref);
  return (
    <div
      ref={ref}
      data-slot="workflow-controls"
      role="toolbar"
      aria-label="Canvas controls"
      className={cn("sui-canvas-controls", className)}
      onKeyDown={(event) => {
        rove(event);
        onKeyDown?.(event);
      }}
      {...props}
    >
      {onZoomIn ?
        (
          <button type="button" aria-label="Zoom in" className="sui-canvas-controls-button" onClick={onZoomIn}>
            <span aria-hidden>+</span>
          </button>
        ) :
        null}
      {onZoomOut ?
        (
          <button type="button" aria-label="Zoom out" className="sui-canvas-controls-button" onClick={onZoomOut}>
            <span aria-hidden>−</span>
          </button>
        ) :
        null}
      {onFitView ?
        (
          <button type="button" aria-label="Fit view" className="sui-canvas-controls-button" onClick={onFitView}>
            <span aria-hidden>⤢</span>
          </button>
        ) :
        null}
      {children}
    </div>
  );
}

export type WorkflowPanelProps = ComponentProps<"div"> & {
  /** Canvas corner the overlay anchors to. */
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
};

/** Positioned overlay slot for canvas chrome (controls, legends, panels). */
export function WorkflowPanel({ position = "top-left", className, ...props }: WorkflowPanelProps) {
  useCanvasCss();
  return (
    <div data-slot="workflow-panel" data-position={position} className={cn("sui-canvas-panel", className)} {...props} />
  );
}

export function WorkflowToolbar({
  className,
  role,
  "aria-label": ariaLabel,
  onKeyDown,
  ...props
}: ComponentProps<"div">) {
  useCanvasCss();
  const ref = useRef<HTMLDivElement>(null);
  const rove = useRovingTabIndex(ref);
  return (
    <div
      ref={ref}
      data-slot="workflow-toolbar"
      role={role ?? "toolbar"}
      aria-label={ariaLabel ?? "Workflow toolbar"}
      className={cn("sui-canvas-toolbar", className)}
      onKeyDown={(event) => {
        rove(event);
        onKeyDown?.(event);
      }}
      {...props}
    />
  );
}

/**
 * Minimap seam frame. The base anatomy only provides the labelled frame; the
 * renderer parks its own MiniMap widget inside.
 */
export function WorkflowMinimap({ className, "aria-label": ariaLabel, ...props }: ComponentProps<"div">) {
  useCanvasCss();
  return (
    <div
      data-slot="workflow-minimap"
      aria-label={ariaLabel ?? "Workflow minimap"}
      className={cn("sui-canvas-minimap", className)}
      {...props}
    />
  );
}
