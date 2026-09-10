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
import { useInjectUiCss } from "../styles";

export type ReasoningProps = Omit<ComponentProps<"div">, "children"> & {
  streaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  title?: string;
  composed?: boolean;
  children?: ReactNode;
};

type ReasoningContextValue = {
  open: boolean;
  toggle: () => void;
  bodyId: string;
  triggerId: string;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

function useReasoningContext(part: string): ReasoningContextValue {
  const context = useContext(ReasoningContext);
  if (!context) throw new Error(`${part} must be rendered inside <Reasoning composed>`);
  return context;
}

function formatDuration(n: number): string {
  if (n < 60) return `${Math.round(n)}s`;
  return `${Math.floor(n / 60)}m ${String(Math.round(n % 60)).padStart(2, "0")}s`;
}

/**
 * Labelled polite live region announcing streaming state transitions. Kept
 * visually hidden (sui-sr-only), so the presentation carries no motion and is
 * reduced-motion safe by construction.
 */
function ReasoningLiveRegion({ title, announcement }: { title: string; announcement: string }) {
  return (
    <span
      data-slot="reasoning-live"
      className="sui-sr-only"
      role="status"
      aria-live="polite"
      aria-label={`${title} status`}
    >
      {announcement}
    </span>
  );
}

/** Collapsible, streaming-aware container for provider-safe reasoning summaries. */
export function Reasoning({
  streaming = false,
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  duration,
  title = "Reasoning",
  composed = false,
  className,
  children,
  ...props
}: ReasoningProps) {
  useInjectUiCss();
  const baseId = useId();
  const bodyId = `${baseId}-reasoning-body`;
  const triggerId = `${baseId}-reasoning-trigger`;
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
    <ReasoningContext.Provider value={{ open: isOpen, toggle, bodyId, triggerId }}>
      <div
        data-slot="reasoning"
        data-state={isOpen ? "open" : "closed"}
        data-streaming={streaming ? "true" : "false"}
        className={cn("sui-reasoning", className)}
        {...props}
      >
        <ReasoningLiveRegion title={title} announcement={announcement} />
        {composed ? (
          children
        ) : (
          <>
            <button
              type="button"
              data-slot="reasoning-trigger"
              className="sui-reasoning-trigger"
              aria-expanded={isOpen}
              aria-controls={bodyId}
              onClick={toggle}
            >
              <span className="sui-reasoning-chevron" aria-hidden="true">
                ›
              </span>
              <span className="sui-reasoning-title" data-shimmer={streaming ? "true" : "false"}>
                {title}
              </span>
              {!streaming && duration != null ? (
                <span data-slot="reasoning-duration" className="sui-reasoning-duration">
                  Thought for {formatDuration(duration)}
                </span>
              ) : null}
            </button>
            {isOpen ? (
              <div data-slot="reasoning-body" id={bodyId} className="sui-reasoning-body">
                {children}
              </div>
            ) : null}
          </>
        )}
      </div>
    </ReasoningContext.Provider>
  );
}

export type ReasoningTriggerProps = ComponentProps<"button">;

/** Disclosure trigger for a composed Reasoning. */
export function ReasoningTrigger({ className, children, onClick, ...props }: ReasoningTriggerProps) {
  useInjectUiCss();
  const context = useReasoningContext("ReasoningTrigger");
  return (
    <button
      type="button"
      id={context.triggerId}
      data-slot="reasoning-trigger"
      className={cn("sui-reasoning-trigger", className)}
      aria-expanded={context.open}
      aria-controls={context.bodyId}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context.toggle();
      }}
      {...props}
    >
      <span className="sui-reasoning-chevron" aria-hidden="true">
        ›
      </span>
      {children}
    </button>
  );
}

export type ReasoningContentProps = ComponentProps<"div">;

/** Content region for a composed Reasoning; renders only while open. */
export function ReasoningContent({ className, ...props }: ReasoningContentProps) {
  useInjectUiCss();
  const context = useReasoningContext("ReasoningContent");
  if (!context.open) return null;
  return (
    <div
      role="region"
      aria-labelledby={context.triggerId}
      id={context.bodyId}
      data-slot="reasoning-content"
      className={cn("sui-reasoning-body", className)}
      {...props}
    />
  );
}

export type ReasoningSummaryProps = Omit<ComponentProps<"div">, "children"> & {
  /**
   * A provider-safe reasoning SUMMARY: text the provider/harness explicitly
   * labelled as a summary in its output payload (e.g. `reasoningSummary`
   * fields, summary-typed parts). Summaries only — never a thinking or
   * reasoning transcript, visible or otherwise. This API does not accept,
   * request, or assume access to raw private chain-of-thought.
   */
  text: string;
  streaming?: boolean;
  label?: string;
};

/**
 * Presentation of a provider-disclosed reasoning summary under a 'Thinking'
 * label. Renders provider-safe summaries only; raw private chain-of-thought is
 * never available to this component and must never be disclosed through it.
 */
export function ReasoningSummary({
  text,
  streaming = false,
  label = "Thinking",
  className,
  ...props
}: ReasoningSummaryProps) {
  useInjectUiCss();
  return (
    <div
      data-slot="reasoning-summary"
      data-streaming={streaming ? "true" : "false"}
      className={cn("sui-reasoning-summary", className)}
      {...props}
    >
      <span className="sui-reasoning-summary-label" data-streaming={streaming ? "true" : "false"}>
        {label}
      </span>
      <div className="sui-reasoning-summary-text">{text}</div>
    </div>
  );
}
