/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type TokenUsageModel = {
  usedTokens?: number;
  maxTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  modelId?: string;
};

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** Percentage is derived ONLY when both used and max tokens are present. */
export function contextUsagePercent(usage: TokenUsageModel): number | undefined {
  if (usage.usedTokens === undefined || usage.maxTokens === undefined || usage.maxTokens <= 0) return undefined;
  return Math.min(100, Math.round((usage.usedTokens / usage.maxTokens) * 100));
}

/** Human/screen-reader summary of the usage model, used as the default trigger name. */
export function contextUsageSummary(usage: TokenUsageModel): string {
  const percent = contextUsagePercent(usage);
  if (percent !== undefined) {
    return `Context usage: ${formatCount(usage.usedTokens!)} of ${formatCount(usage.maxTokens!)} tokens (${percent}%)`;
  }
  if (usage.usedTokens !== undefined) {
    return `Context usage: ${formatCount(usage.usedTokens)} tokens used`;
  }
  return "Context usage: unknown";
}

type ContextUsageContextValue = {
  usage: TokenUsageModel;
  open: boolean;
  triggerId: string;
  contentId: string;
  toggle: () => void;
  close: (restoreFocus: boolean) => void;
  scheduleHoverOpen: () => void;
  cancelHoverOpen: (closeIfHoverOpened: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
};

const ContextUsageContext = createContext<ContextUsageContextValue | null>(null);

function useContextUsage(part: string): ContextUsageContextValue {
  const ctx = useContext(ContextUsageContext);
  if (!ctx) throw new Error(`${part} must be used inside <ContextUsage>`);
  return ctx;
}

const HOVER_OPEN_DELAY_MS = 300;

export type ContextUsageProps = Omit<ComponentProps<"div">, "children"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  usage: TokenUsageModel;
  openOnHover?: boolean;
  children?: ReactNode;
};

/**
 * Context-window usage disclosure. The trigger shows a percentage only when
 * it can be derived from used+max tokens; otherwise the used count or an
 * honest em-dash. There is NO pricing database: cost arrives via `costUsd`.
 */
export function ContextUsage({
  usage,
  open,
  defaultOpen = false,
  onOpenChange,
  openOnHover = true,
  className,
  children,
  onMouseLeave,
  onBlur,
  ...props
}: ContextUsageProps) {
  useInjectUiCss();
  const triggerId = `${useId()}-ctx-trigger`;
  const contentId = `${useId()}-ctx-content`;
  const isControlled = open !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = isControlled ? open : uncontrolledOpen;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverOpened = useRef(false);

  function cancelHoverTimer() {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  useEffect(() => cancelHoverTimer, []);

  useEffect(() => {
    if (isOpen) {
      cancelHoverTimer();
    } else {
      hoverOpened.current = false;
    }
  }, [isOpen]);

  function setOpen(next: boolean) {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  function toggle() {
    cancelHoverTimer();
    hoverOpened.current = false;
    setOpen(!isOpen);
  }

  function close(restoreFocus: boolean) {
    cancelHoverTimer();
    hoverOpened.current = false;
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function scheduleHoverOpen() {
    if (!openOnHover || isOpen) return;
    cancelHoverTimer();
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      hoverOpened.current = true;
      if (!isControlled) setUncontrolledOpen(true);
      onOpenChange?.(true);
    }, HOVER_OPEN_DELAY_MS);
  }

  function cancelHoverOpen(closeIfHoverOpened: boolean) {
    cancelHoverTimer();
    if (closeIfHoverOpened && hoverOpened.current) {
      hoverOpened.current = false;
      if (!isControlled) setUncontrolledOpen(false);
      onOpenChange?.(false);
    }
  }

  function onFocusOut(event: React.FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget;
    if (!(next instanceof Node && event.currentTarget.contains(next))) {
      cancelHoverOpen(true);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && isOpen) {
      event.stopPropagation();
      close(true);
    }
    props.onKeyDown?.(event);
  }

  const value: ContextUsageContextValue = {
    usage,
    open: isOpen,
    triggerId,
    contentId,
    toggle,
    close,
    scheduleHoverOpen,
    cancelHoverOpen,
    triggerRef,
  };

  return (
    <ContextUsageContext.Provider value={value}>
      <div
        data-slot="context-usage"
        data-state={isOpen ? "open" : "closed"}
        className={cn("sui-ctx", className)}
        onMouseLeave={(event) => {
          cancelHoverOpen(true);
          onMouseLeave?.(event);
        }}
        {...props}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          onFocusOut(event);
          onBlur?.(event);
        }}
      >
        {children ?? (
          <>
            <ContextTrigger />
            {isOpen ? (
              <ContextContent>
                <ContextContentHeader />
                <ContextContentBody>
                  <ContextInputUsage />
                  <ContextOutputUsage />
                  <ContextReasoningUsage />
                  <ContextCacheUsage />
                </ContextContentBody>
                <ContextContentFooter />
              </ContextContent>
            ) : null}
          </>
        )}
      </div>
    </ContextUsageContext.Provider>
  );
}

export function ContextTrigger({
  className,
  children,
  onClick,
  onMouseEnter,
  onFocus,
  ...props
}: ComponentProps<"button">) {
  useInjectUiCss();
  const ctx = useContextUsage("ContextTrigger");
  const percent = contextUsagePercent(ctx.usage);
  const label =
    percent !== undefined
      ? `${percent}%`
      : ctx.usage.usedTokens !== undefined
        ? formatCount(ctx.usage.usedTokens)
        : "—";
  return (
    <button
      type="button"
      ref={ctx.triggerRef}
      id={ctx.triggerId}
      data-slot="context-trigger"
      className={cn("sui-ctx-trigger", className)}
      aria-expanded={ctx.open}
      aria-controls={ctx.contentId}
      aria-label={children === undefined ? contextUsageSummary(ctx.usage) : undefined}
      onClick={(event) => {
        ctx.toggle();
        onClick?.(event);
      }}
      onMouseEnter={(event) => {
        ctx.scheduleHoverOpen();
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        ctx.scheduleHoverOpen();
        onFocus?.(event);
      }}
      {...props}
    >
      {children ?? <span className="sui-ctx-trigger-label">{label}</span>}
    </button>
  );
}

export function ContextContent({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const ctx = useContextUsage("ContextContent");
  if (!ctx.open) return null;
  return (
    <div
      id={ctx.contentId}
      role="region"
      aria-labelledby={ctx.triggerId}
      data-slot="context-content"
      className={cn("sui-ctx-content", className)}
      {...props}
    >
      {children ?? (
        <>
          <ContextContentHeader />
          <ContextContentBody>
            <ContextInputUsage />
            <ContextOutputUsage />
            <ContextReasoningUsage />
            <ContextCacheUsage />
          </ContextContentBody>
          <ContextContentFooter />
        </>
      )}
    </div>
  );
}

export function ContextContentHeader({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const { usage } = useContextUsage("ContextContentHeader");
  const percent = contextUsagePercent(usage);
  return (
    <div data-slot="context-content-header" className={cn("sui-ctx-header", className)} {...props}>
      {children ?? (
        <>
          <span className="sui-ctx-header-title">{usage.modelId ?? "Context usage"}</span>
          <span className="sui-ctx-header-value">
            {percent !== undefined
              ? `${formatCount(usage.usedTokens!)} / ${formatCount(usage.maxTokens!)} (${percent}%)`
              : usage.usedTokens !== undefined
                ? formatCount(usage.usedTokens)
                : "—"}
          </span>
        </>
      )}
    </div>
  );
}

export function ContextContentBody({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="context-content-body" className={cn("sui-ctx-body", className)} {...props} />;
}

export function ContextContentFooter({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const { usage } = useContextUsage("ContextContentFooter");
  return (
    <div data-slot="context-content-footer" className={cn("sui-ctx-footer", className)} {...props}>
      {children ??
        (usage.costUsd !== undefined ? <span className="sui-ctx-cost">Cost {formatCost(usage.costUsd)}</span> : null)}
    </div>
  );
}

type UsageRowProps = ComponentProps<"div"> & { label: string; value: ReactNode };

function UsageRow({ label, value, className, ...props }: UsageRowProps) {
  return (
    <div className={cn("sui-ctx-row", className)} {...props}>
      <span className="sui-ctx-row-label">{label}</span>
      <span className="sui-ctx-row-value">{value}</span>
    </div>
  );
}

function tokenValue(n: number | undefined): string {
  return n === undefined ? "—" : formatCount(n);
}

export function ContextInputUsage({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const { usage } = useContextUsage("ContextInputUsage");
  return (
    <UsageRow
      data-slot="context-input-usage"
      label="Input"
      value={children ?? tokenValue(usage.inputTokens)}
      className={className}
      {...props}
    />
  );
}

export function ContextOutputUsage({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const { usage } = useContextUsage("ContextOutputUsage");
  return (
    <UsageRow
      data-slot="context-output-usage"
      label="Output"
      value={children ?? tokenValue(usage.outputTokens)}
      className={className}
      {...props}
    />
  );
}

export function ContextReasoningUsage({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const { usage } = useContextUsage("ContextReasoningUsage");
  return (
    <UsageRow
      data-slot="context-reasoning-usage"
      label="Reasoning"
      value={children ?? tokenValue(usage.reasoningTokens)}
      className={className}
      {...props}
    />
  );
}

export function ContextCacheUsage({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const { usage } = useContextUsage("ContextCacheUsage");
  return (
    <UsageRow
      data-slot="context-cache-usage"
      label="Cache"
      value={children ?? tokenValue(usage.cachedInputTokens)}
      className={className}
      {...props}
    />
  );
}
