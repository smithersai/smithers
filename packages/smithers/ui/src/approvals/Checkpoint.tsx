/** @jsxImportSource react */
/**
 * Presentational rows for rc.0 checkpoints, which are pinned git trees taken
 * per cell call. Optional actions are host wiring for `@smthrs/time-travel`
 * library operations, not Smithers control-plane or CLI capabilities.
 */
import { type ComponentProps, createContext, type ReactNode, useContext } from "react";
import { Button } from "../button";
import { cn } from "../cn";
import { Spinner } from "../spinner";
import { useInjectUiCss } from "../styles";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";

export type CheckpointModel = {
  id: string;
  label?: string;
  frameNo?: number;
  messageIndex?: number;
  timestampMs?: number;
  messageCount?: number;
};

// Keep this vocabulary aligned with the release policy.
export type CheckpointActionKind = "fork" | "replay" | "rewind";

const CHECKPOINT_ACTION_LABELS: Readonly<Record<CheckpointActionKind, string>> = {
  fork: "Fork",
  replay: "Replay",
  rewind: "Rewind",
};

export const CHECKPOINT_ACTION_KINDS: readonly CheckpointActionKind[] = ["fork", "replay", "rewind"];

type CheckpointContextValue = {
  checkpoint: CheckpointModel;
  current: boolean;
};

const CheckpointContext = createContext<CheckpointContextValue | null>(null);

/** Read the enclosing Checkpoint's model; throws outside a Checkpoint. */
export function useCheckpoint(): CheckpointContextValue {
  const ctx = useContext(CheckpointContext);
  if (!ctx) throw new Error("Checkpoint parts must render inside <Checkpoint>");
  return ctx;
}

export type CheckpointProps = Omit<ComponentProps<"div">, "children"> & {
  checkpoint: CheckpointModel;
  current?: boolean;
  children?: ReactNode;
};

/**
 * A presentational row over an rc.0 pinned-tree checkpoint. With no children
 * it renders the default anatomy: icon, label, and metadata. Compose
 * CheckpointIcon, CheckpointMetadata, and CheckpointActions for host controls.
 */
export function Checkpoint({ checkpoint, current = false, children, className, ...props }: CheckpointProps) {
  useInjectUiCss();
  return (
    <CheckpointContext.Provider value={{ checkpoint, current }}>
      <div
        data-slot="checkpoint"
        data-checkpoint-id={checkpoint.id}
        data-current={current ? "true" : "false"}
        aria-current={current ? "true" : undefined}
        className={cn("sui-checkpoint", className)}
        {...props}
      >
        {children ?? (
          <>
            <CheckpointIcon />
            <span className="sui-checkpoint-label">{checkpoint.label ?? checkpoint.id}</span>
            <CheckpointMetadata />
          </>
        )}
      </div>
    </CheckpointContext.Provider>
  );
}

function BookmarkGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M3 1.5h6a.5.5 0 0 1 .5.5v8.2a.2.2 0 0 1-.32.16L6 7.6l-3.18 2.76a.2.2 0 0 1-.32-.16V2a.5.5 0 0 1 .5-.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Bookmark glyph; decorative (aria-hidden). */
export function CheckpointIcon({ className, children, ...props }: ComponentProps<"span">) {
  useInjectUiCss();
  return (
    <span data-slot="checkpoint-icon" aria-hidden="true" className={cn("sui-checkpoint-icon", className)} {...props}>
      {children ?? <BookmarkGlyph />}
    </span>
  );
}

/** Timestamp + message count from the checkpoint model. */
export function CheckpointMetadata({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  const { checkpoint } = useCheckpoint();
  return (
    <div data-slot="checkpoint-metadata" className={cn("sui-checkpoint-metadata", className)} {...props}>
      {checkpoint.frameNo !== undefined ? <span>frame {checkpoint.frameNo}</span> : null}
      {checkpoint.timestampMs !== undefined ?
        (
          <time dateTime={new Date(checkpoint.timestampMs).toISOString()}>
            {new Date(checkpoint.timestampMs).toLocaleString()}
          </time>
        ) :
        null}
      {checkpoint.messageCount !== undefined ? <span>{checkpoint.messageCount} messages</span> : null}
    </div>
  );
}

export type CheckpointTriggerProps = Omit<ComponentProps<"button">, "children"> & {
  tooltip?: string;
  children?: ReactNode;
};

/** Ghost sm trigger button, optionally wrapped in a ui Tooltip. */
export function CheckpointTrigger({ tooltip, children, className, ...props }: CheckpointTriggerProps) {
  useInjectUiCss();
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-slot="checkpoint-trigger"
      className={cn("sui-checkpoint-trigger", className)}
      {...props}
    >
      {children ?? (
        <>
          <BookmarkGlyph /> Checkpoint
        </>
      )}
    </Button>
  );
  if (tooltip === undefined) return button;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export type CheckpointActionsProps = Omit<ComponentProps<"div">, "children"> & {
  actions?: readonly CheckpointActionKind[];
  onAction: (kind: CheckpointActionKind) => void;
  busy?: CheckpointActionKind | null;
  disabled?: readonly CheckpointActionKind[];
};

/**
 * Host-wired fork, replay, and rewind library operations. `busy` disables
 * every action and spins the busy one; `disabled` greys individual kinds.
 */
export function CheckpointActions({
  actions = CHECKPOINT_ACTION_KINDS,
  onAction,
  busy = null,
  disabled,
  className,
  ...props
}: CheckpointActionsProps) {
  useInjectUiCss();
  return (
    <div
      data-slot="checkpoint-actions"
      role="group"
      aria-label="Checkpoint actions"
      className={cn("sui-checkpoint-actions", className)}
      {...props}
    >
      {actions.map((kind) => {
        const isBusy = busy === kind;
        const isDisabled = busy !== null || disabled?.includes(kind) === true;
        return (
          <Button
            key={kind}
            type="button"
            variant="ghost"
            size="sm"
            data-slot="checkpoint-action"
            data-action={kind}
            className="sui-checkpoint-action"
            disabled={isDisabled}
            onClick={() => onAction(kind)}
          >
            {isBusy ? <Spinner size="sm" /> : null}
            {CHECKPOINT_ACTION_LABELS[kind]}
          </Button>
        );
      })}
    </div>
  );
}
