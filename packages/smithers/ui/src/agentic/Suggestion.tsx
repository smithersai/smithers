/** @jsxImportSource react */
import { useRef, type ComponentProps, type ReactNode, type WheelEvent, type KeyboardEvent } from "react";
import { cn } from "../cn";
import { prefersReducedMotion, useInjectUiCss } from "../styles";

export type SuggestionProps = Omit<ComponentProps<"button">, "onClick" | "children" | "value"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
  children?: ReactNode;
};

/** Ghost pill carrying one prompt suggestion; fires onClick with the suggestion text. */
export function Suggestion({ suggestion, onClick, children, className, type, ...props }: SuggestionProps) {
  useInjectUiCss();
  return (
    <button
      type={type ?? "button"}
      data-slot="suggestion"
      className={cn("sui-suggestion", className)}
      onClick={() => onClick?.(suggestion)}
      {...props}
    >
      {children ?? suggestion}
    </button>
  );
}

export type SuggestionGroupProps = ComponentProps<"div">;

const ARROW_SCROLL_PX = 160;

/** Horizontally scrollable row of prompt suggestion chips (not a tablist). */
export function SuggestionGroup({ className, children, role, onWheel, onKeyDown, ...props }: SuggestionGroupProps) {
  useInjectUiCss();
  const ref = useRef<HTMLDivElement | null>(null);

  function scrollByPx(delta: number) {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      el.scrollLeft += delta;
    } else {
      el.scrollBy({ left: delta, behavior: "smooth" });
    }
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    const el = ref.current;
    if (el && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      el.scrollLeft += event.deltaY;
    }
    onWheel?.(event);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") {
      scrollByPx(ARROW_SCROLL_PX);
    } else if (event.key === "ArrowLeft") {
      scrollByPx(-ARROW_SCROLL_PX);
    }
    onKeyDown?.(event);
  }

  return (
    <div
      ref={ref}
      data-slot="suggestion-group"
      role={role ?? "group"}
      aria-label="Suggestions"
      className={cn("sui-suggestion-group", "sui-scroll-fade", className)}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {children}
    </div>
  );
}
