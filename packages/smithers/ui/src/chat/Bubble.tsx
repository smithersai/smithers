/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cva } from "class-variance-authority";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

const bubbleVariantClasses = cva("sui-bubble", {
  variants: {
    variant: {
      user: "sui-bubble-user",
      assistant: "sui-bubble-assistant",
      system: "sui-bubble-system",
    },
  },
  defaultVariants: {
    variant: "assistant",
  },
});

export const bubbleVariants: (props?: { variant?: "user" | "assistant" | "system" }) => string = (props) =>
  bubbleVariantClasses(props);

export type BubbleProps = ComponentProps<"div"> & {
  variant?: "user" | "assistant" | "system";
  align?: "start" | "end" | "center";
  collapsible?: boolean;
  collapsedHeight?: number;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  expandLabel?: string;
  collapseLabel?: string;
  /** Compound mode: children render verbatim; compose BubbleContent/Actions/Reactions. */
  composed?: boolean;
};

type BubbleContextValue = {
  contentId: string;
  registerContent: (el: HTMLDivElement | null) => void;
};

const BubbleContext = createContext<BubbleContextValue | null>(null);

type BubbleStyle = CSSProperties & { "--sui-bubble-clamp"?: string };

function useBubbleLaneCss(): void {
  useInjectUiCss();
}

/** Message surface with role variants and mounted-content clamp disclosure. */
export function Bubble({
  variant = "assistant",
  align,
  collapsible = false,
  collapsedHeight = 320,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  expandLabel = "Show more",
  collapseLabel = "Show less",
  composed = false,
  className,
  style,
  children,
  ...props
}: BubbleProps) {
  useBubbleLaneCss();
  const bodyId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const [overflows, setOverflows] = useState(collapsible);
  const isExpanded = expanded ?? internalExpanded;
  const resolvedAlign = align ?? (variant === "user" ? "end" : variant === "system" ? "center" : "start");

  useLayoutEffect(() => {
    if (!collapsible) return;
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") {
      setOverflows(true);
      return;
    }
    const measure = () => setOverflows(content.scrollHeight > collapsedHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [collapsible, collapsedHeight, composed]);

  const requestExpanded = (next: boolean) => {
    if (expanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  };

  const rootStyle: BubbleStyle = collapsible
    ? { ...(style as BubbleStyle), "--sui-bubble-clamp": `${collapsedHeight}px` }
    : (style as BubbleStyle);

  if (composed) {
    return (
      <BubbleContext.Provider
        value={{
          contentId: bodyId,
          registerContent: (el) => {
            contentRef.current = el;
          },
        }}
      >
        <div
          data-slot="bubble"
          data-variant={variant}
          data-align={resolvedAlign}
          data-expanded={collapsible ? String(isExpanded) : undefined}
          className={cn(bubbleVariants({ variant }), className)}
          style={rootStyle}
          {...props}
        >
          {children}
          {collapsible && overflows ? (
            <button
              type="button"
              data-slot="bubble-toggle"
              className="sui-bubble-toggle"
              aria-expanded={isExpanded}
              aria-controls={bodyId}
              onClick={() => requestExpanded(!isExpanded)}
            >
              {isExpanded ? collapseLabel : expandLabel}
            </button>
          ) : null}
        </div>
      </BubbleContext.Provider>
    );
  }

  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={resolvedAlign}
      data-expanded={collapsible ? String(isExpanded) : undefined}
      className={cn(bubbleVariants({ variant }), className)}
      style={rootStyle}
      {...props}
    >
      <div ref={contentRef} data-slot="bubble-content" id={bodyId} className="sui-bubble-content">
        {children}
      </div>
      {collapsible && overflows ? (
        <button
          type="button"
          data-slot="bubble-toggle"
          className="sui-bubble-toggle"
          aria-expanded={isExpanded}
          aria-controls={bodyId}
          onClick={() => requestExpanded(!isExpanded)}
        >
          {isExpanded ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </div>
  );
}

/** Clamp target in composed mode: carries the bubble body's id and clamp class. */
export function BubbleContent({ className, id, ...props }: ComponentProps<"div">) {
  useBubbleLaneCss();
  const ctx = useContext(BubbleContext);
  return (
    <div
      ref={ctx?.registerContent}
      data-slot="bubble-content"
      id={id ?? ctx?.contentId}
      className={cn("sui-bubble-content", className)}
      {...props}
    />
  );
}

/** Toolbar row under the bubble body. */
export function BubbleActions({ className, ...props }: ComponentProps<"div">) {
  useBubbleLaneCss();
  return (
    <div
      data-slot="bubble-actions"
      role="toolbar"
      aria-label="Message actions"
      className={cn("sui-bubble-actions", className)}
      {...props}
    />
  );
}

export type BubbleReaction = {
  key: string;
  label: string;
  count?: number;
  icon?: ReactNode;
  pressed?: boolean;
};

export type BubbleReactionsProps = Omit<ComponentProps<"div">, "children"> & {
  reactions: readonly BubbleReaction[];
  onToggle?: (key: string) => void;
};

/** Toggleable reaction pills with aria-pressed state. */
export function BubbleReactions({ reactions, onToggle, className, ...props }: BubbleReactionsProps) {
  useBubbleLaneCss();
  return (
    <div data-slot="bubble-reactions" className={cn("sui-bubble-reactions", className)} {...props}>
      {reactions.map((reaction) => (
        <button
          key={reaction.key}
          type="button"
          data-slot="bubble-reaction"
          className="sui-bubble-reaction"
          aria-pressed={reaction.pressed ?? false}
          aria-label={reaction.count !== undefined ? `${reaction.label}, ${reaction.count}` : reaction.label}
          onClick={() => onToggle?.(reaction.key)}
        >
          {reaction.icon ? <span aria-hidden="true">{reaction.icon}</span> : null}
          <span aria-hidden="true">{reaction.label}</span>
          {reaction.count !== undefined ? <span aria-hidden="true">{reaction.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
