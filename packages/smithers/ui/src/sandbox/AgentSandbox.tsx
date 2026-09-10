/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import { EmptyState } from "../empty-state";
import { formatStatus } from "../status";
import { StatusPill } from "../status-pill";
import { useInjectUiCss } from "../styles";

export type SandboxState = "provisioning" | "ready" | "disconnected" | "suspended" | "failed" | "destroyed";

/** Map sandbox lifecycle states onto the shared status vocabulary. */
export function sandboxStateToStatus(state: SandboxState): string {
  switch (state) {
    case "provisioning":
      return "pending";
    case "ready":
      return "ready";
    case "disconnected":
      return "waiting";
    case "suspended":
      return "paused";
    case "failed":
      return "failed";
    case "destroyed":
      return "cancelled";
  }
}

type SandboxContextValue = {
  state: SandboxState;
  workspace?: string;
  repository?: string;
  open: boolean;
  triggerId: string;
  contentId: string;
};

const SandboxContext = createContext<SandboxContextValue | null>(null);

export type SandboxProps = Omit<ComponentProps<"div">, "children"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  state: SandboxState;
  workspace?: string;
  repository?: string;
  children?: ReactNode;
};

const STATE_EMPTY: Record<Exclude<SandboxState, "ready">, { title: string; description: string }> = {
  provisioning: { title: "Sandbox is provisioning", description: "The sandbox environment is being set up." },
  disconnected: { title: "Sandbox disconnected", description: "The connection to the sandbox was lost." },
  suspended: { title: "Sandbox suspended", description: "The sandbox is paused and can be reconnected." },
  failed: { title: "Sandbox failed", description: "The sandbox environment failed to start." },
  destroyed: { title: "Sandbox destroyed", description: "The sandbox environment has been torn down." },
};

/**
 * Collapsible sandbox environment unit: lifecycle state plus workspace /
 * repository identity. Never fabricates execution output — content renders
 * only what props provide, and non-ready states explain themselves through an
 * EmptyState.
 */
export function Sandbox({
  state,
  workspace,
  repository,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  className,
  children,
  ...props
}: SandboxProps) {
  useInjectUiCss();
  const triggerId = useId();
  const contentId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  // Lifecycle changes are announced through a persistent visually-hidden live
  // region so screen-reader users hear provisioning/ready/disconnected/
  // suspended/failed/destroyed transitions they cannot see. Mounting is not
  // announced — only genuine state changes are.
  const [announcement, setAnnouncement] = useState("");
  const previousState = useRef(state);
  useEffect(() => {
    if (previousState.current === state) return;
    previousState.current = state;
    setAnnouncement(`Sandbox ${state}`);
  }, [state]);

  function toggle() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <div
      data-slot="agent-sandbox"
      data-state={open ? "open" : "closed"}
      data-sandbox-state={state}
      className={cn("sui-sandbox", className)}
      {...props}
    >
      <SandboxContext.Provider value={{ state, workspace, repository, open, triggerId, contentId }}>
        <span data-slot="agent-sandbox-live" role="status" aria-live="polite" className="sui-sr-only">
          {announcement}
        </span>
        <button
          type="button"
          id={triggerId}
          data-slot="agent-sandbox-trigger"
          className="sui-sandbox-trigger"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={toggle}
        >
          <span className="sui-sandbox-chevron" aria-hidden="true">
            ›
          </span>
          <span>Sandbox</span>
        </button>
        {children ?? (
          <>
            <SandboxHeader>
              <SandboxStatus state={state} />
            </SandboxHeader>
            <SandboxContent />
          </>
        )}
      </SandboxContext.Provider>
    </div>
  );
}

export function SandboxHeader({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const ctx = useContext(SandboxContext);
  return (
    <div data-slot="agent-sandbox-header" className={cn("sui-sandbox-header", className)} {...props}>
      {ctx && (ctx.workspace !== undefined || ctx.repository !== undefined) ? (
        <span className="sui-sandbox-identity">
          {ctx.repository !== undefined ? (
            <span data-slot="agent-sandbox-repository" className="sui-sandbox-repository">
              {ctx.repository}
            </span>
          ) : null}
          {ctx.workspace !== undefined ? (
            <span data-slot="agent-sandbox-workspace" className="sui-sandbox-workspace">
              {ctx.workspace}
            </span>
          ) : null}
        </span>
      ) : null}
      {children}
    </div>
  );
}

export type SandboxStatusProps = Omit<ComponentProps<"span">, "children"> & {
  state: SandboxState;
};

export function SandboxStatus({ state, className, ...props }: SandboxStatusProps) {
  useInjectUiCss();
  return (
    <StatusPill
      status={sandboxStateToStatus(state)}
      label={formatStatus(state)}
      data-slot="agent-sandbox-status"
      data-sandbox-state={state}
      className={cn("sui-sandbox-status", className)}
      {...props}
    />
  );
}

export type SandboxActionsProps = Omit<ComponentProps<"div">, "children"> & {
  onRetry?: () => void;
  onReconnect?: () => void;
  children?: ReactNode;
};

export function SandboxActions({ onRetry, onReconnect, className, children, ...props }: SandboxActionsProps) {
  useInjectUiCss();
  const ctx = useContext(SandboxContext);
  const showRetry = onRetry !== undefined && (ctx === null || ctx.state === "failed");
  const showReconnect =
    onReconnect !== undefined && (ctx === null || ctx.state === "disconnected" || ctx.state === "suspended");
  return (
    <div
      data-slot="agent-sandbox-actions"
      role="group"
      aria-label="Sandbox actions"
      className={cn("sui-sandbox-actions", className)}
      {...props}
    >
      {showRetry ? (
        <button type="button" data-slot="agent-sandbox-retry" className="sui-sandbox-action" onClick={onRetry}>
          Retry
        </button>
      ) : null}
      {showReconnect ? (
        <button type="button" data-slot="agent-sandbox-reconnect" className="sui-sandbox-action" onClick={onReconnect}>
          Reconnect
        </button>
      ) : null}
      {children}
    </div>
  );
}

export function SandboxContent({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const ctx = useContext(SandboxContext);
  if (ctx !== null && !ctx.open) return null;
  const empty = ctx !== null && ctx.state !== "ready" ? STATE_EMPTY[ctx.state] : null;
  return (
    <div
      data-slot="agent-sandbox-content"
      role="region"
      id={ctx?.contentId}
      aria-labelledby={ctx?.triggerId}
      className={cn("sui-sandbox-content", className)}
      {...props}
    >
      {children ?? (empty ? <EmptyState title={empty.title} description={empty.description} /> : null)}
    </div>
  );
}
