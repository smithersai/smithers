/** @jsxImportSource react */
import {
  Children,
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

type MessageBranchContextValue = {
  count: number;
  index: number;
  setIndex: (index: number) => void;
};

const MessageBranchContext = createContext<MessageBranchContextValue | null>(null);

function useMessageBranch(part: string): MessageBranchContextValue {
  const ctx = useContext(MessageBranchContext);
  if (!ctx) throw new Error(`${part} must be used inside <MessageBranch>`);
  return ctx;
}

function useBranchLaneCss(): void {
  useInjectUiCss();
}

export type MessageBranchProps = Omit<ComponentProps<"div">, "children"> & {
  /** Total number of alternate responses. */
  count: number;
  /** Controlled active branch index (0-based). */
  index?: number;
  /** Uncontrolled initial branch index. */
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  children?: ReactNode;
};

/** Alternate-response navigator: branch content plus prev/next paging. */
export function MessageBranch({
  count,
  index,
  defaultIndex = 0,
  onIndexChange,
  className,
  children,
  ...props
}: MessageBranchProps) {
  useBranchLaneCss();
  const [internalIndex, setInternalIndex] = useState(defaultIndex);
  const safeCount = Number.isFinite(count) ? Math.max(Math.floor(count), 0) : 0;
  const maxIndex = safeCount - 1;
  // Zero branches means there is no active branch: index -1 renders "0 of 0"
  // and hides every panel instead of pointing at a nonexistent first branch.
  const current = safeCount === 0 ? -1 : Math.min(Math.max(index ?? internalIndex, 0), maxIndex);
  // Reconcile the uncontrolled state itself, silently: a count-driven clamp is
  // not a user navigation, and a later count increase keeps the clamped spot.
  // A transient empty state is exempt so the user's branch survives it.
  useEffect(() => {
    if (safeCount > 0 && index === undefined && internalIndex !== current) {
      setInternalIndex(current);
    }
  }, [safeCount, index, internalIndex, current]);
  const setIndex = (next: number) => {
    const clamped = safeCount === 0 ? -1 : Math.min(Math.max(next, 0), maxIndex);
    if (index === undefined) setInternalIndex(clamped);
    onIndexChange?.(clamped);
  };
  return (
    <MessageBranchContext.Provider value={{ count: safeCount, index: current, setIndex }}>
      <div
        data-slot="message-branch"
        data-branch-index={current}
        data-branch-count={safeCount}
        className={cn("sui-msg-branch", className)}
        {...props}
      >
        {children}
      </div>
    </MessageBranchContext.Provider>
  );
}

/** Region hosting the active branch's rendered response. */
export function MessageBranchContent({ className, children, ...props }: ComponentProps<"div">) {
  useBranchLaneCss();
  const { index } = useMessageBranch("MessageBranchContent");
  const branches = Children.toArray(children);
  return (
    <>
      {branches.map((branch, branchIndex) => (
        <div
          key={(branch as ReactElement).key ?? branchIndex}
          data-slot="message-branch-content"
          className={cn("sui-msg-branch-content", className)}
          hidden={branchIndex !== index}
          aria-hidden={branchIndex !== index ? true : undefined}
          {...props}
        >
          {branch}
        </div>
      ))}
    </>
  );
}

/** Grouped prev/next/page controls for branch navigation. */
export function MessageBranchSelector({ className, ...props }: ComponentProps<"div">) {
  useBranchLaneCss();
  return (
    <div
      data-slot="message-branch-selector"
      role="group"
      aria-label="Response branches"
      className={cn("sui-msg-branch-selector", className)}
      {...props}
    />
  );
}

/** Step to the previous branch; disabled at the first branch. */
export function MessageBranchPrevious({ className, onClick, disabled, ...props }: ComponentProps<"button">) {
  useBranchLaneCss();
  const { index, setIndex } = useMessageBranch("MessageBranchPrevious");
  const atStart = index <= 0;
  return (
    <button
      type="button"
      data-slot="message-branch-previous"
      aria-label="Previous response"
      disabled={disabled ?? atStart}
      className={cn("sui-msg-branch-button", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setIndex(index - 1);
      }}
      {...props}
    >
      <span aria-hidden="true">‹</span>
    </button>
  );
}

/** Step to the next branch; disabled at the last branch. */
export function MessageBranchNext({ className, onClick, disabled, ...props }: ComponentProps<"button">) {
  useBranchLaneCss();
  const { count, index, setIndex } = useMessageBranch("MessageBranchNext");
  const atEnd = index >= count - 1;
  return (
    <button
      type="button"
      data-slot="message-branch-next"
      aria-label="Next response"
      disabled={disabled ?? atEnd}
      className={cn("sui-msg-branch-button", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setIndex(index + 1);
      }}
      {...props}
    >
      <span aria-hidden="true">›</span>
    </button>
  );
}

/** Polite '<index+1> of <count>' page indicator. */
export function MessageBranchPage({ className, ...props }: ComponentProps<"span">) {
  useBranchLaneCss();
  const { count, index } = useMessageBranch("MessageBranchPage");
  return (
    <span
      data-slot="message-branch-page"
      aria-live="polite"
      className={cn("sui-msg-branch-page", className)}
      {...props}
    >
      {index + 1} of {count}
    </span>
  );
}
