/** @jsxImportSource react */
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type StackFrameData = {
  functionName?: string;
  file?: string;
  line?: number;
  column?: number;
  raw?: string;
};

/** Extract file/line/column from a location string, incl. V8 eval wrappers. */
function parseLocation(loc: string): Pick<StackFrameData, "file" | "line" | "column"> | null {
  // V8 eval form: "eval at <fn> (<file:line:col>), <file:line:col>" — the
  // actionable location is the trailing one.
  const evalSplit = loc.lastIndexOf("), ");
  const target = evalSplit >= 0 ? loc.slice(evalSplit + 3) : loc;
  const match = /^(?<file>.+):(?<line>\d+):(?<column>\d+)\)?$/.exec(target.trim());
  if (!match?.groups) return null;
  return {
    file: match.groups.file,
    line: Number.parseInt(match.groups.line, 10),
    column: Number.parseInt(match.groups.column, 10),
  };
}

/**
 * Frozen stack grammar helper: V8 (`at fn (file:line:col)`, anonymous and
 * eval forms) plus JSC/Bun (`fn@file:line:col`). Unmatched lines become
 * `{ raw: line }` frames and are never dropped.
 */
export function parseStackTrace(text: string): StackFrameData[] {
  const frames: StackFrameData[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const v8 = /^at\s+(?:(?<fn>.*?)\s+\((?<paren>.*)\)|(?<bare>[^()]+))$/.exec(trimmed);
    if (v8?.groups) {
      const loc = v8.groups.paren ?? v8.groups.bare ?? "";
      const parsed = parseLocation(loc);
      if (parsed) {
        frames.push({ functionName: v8.groups.fn || undefined, ...parsed });
        continue;
      }
      frames.push({ raw: line });
      continue;
    }

    const jsc = /^(?<fn>[^@]*)@(?<loc>.+)$/.exec(trimmed);
    if (jsc?.groups) {
      const parsed = parseLocation(jsc.groups.loc ?? "");
      if (parsed) {
        frames.push({ functionName: jsc.groups.fn || undefined, ...parsed });
        continue;
      }
    }

    frames.push({ raw: line });
  }
  return frames;
}

export type StackTraceProps = Omit<ComponentProps<"div">, "children"> & {
  frames?: readonly StackFrameData[];
  /** Verbatim trace text, rendered as a <pre> when no frames are given. */
  raw?: string;
  title?: ReactNode;
  onFrameClick?: (frame: StackFrameData) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** Collapsible stack trace over structured frames (or verbatim raw text). */
export function StackTrace({
  frames,
  raw,
  title,
  onFrameClick,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  ...props
}: StackTraceProps) {
  useInjectUiCss();
  const triggerId = useId();
  const contentId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  function toggle() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const hasFrames = frames !== undefined && frames.length > 0;

  return (
    <div
      data-slot="stack-trace"
      data-state={open ? "open" : "closed"}
      className={cn("sui-stack", className)}
      {...props}
    >
      <button
        type="button"
        id={triggerId}
        data-slot="stack-trace-trigger"
        className="sui-stack-trigger"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
      >
        {title ?? "Stack trace"}
        {hasFrames ? <span className="sui-stack-count">{frames.length} frames</span> : null}
      </button>
      {open ? (
        <div
          data-slot="stack-trace-content"
          id={contentId}
          role="region"
          aria-labelledby={triggerId}
          className="sui-stack-content"
        >
          {hasFrames ? (
            <ol className="sui-stack-frames">
              {frames.map((frame, index) => (
                <StackFrame key={index} frame={frame} onFrameClick={onFrameClick} />
              ))}
            </ol>
          ) : (
            <pre className="sui-stack-raw">{raw ?? ""}</pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

export type StackFrameProps = Omit<ComponentProps<"li">, "children"> & {
  frame: StackFrameData;
  onFrameClick?: (frame: StackFrameData) => void;
};

/** One frame row; renders a button only when the onFrameClick seam is used. */
export function StackFrame({ frame, onFrameClick, className, ...props }: StackFrameProps) {
  useInjectUiCss();
  const body = frame.raw !== undefined ? (
    <span className="sui-stack-frame-loc">{frame.raw}</span>
  ) : (
    <>
      <span className="sui-stack-frame-fn">{frame.functionName ?? "(anonymous)"}</span>{" "}
      <span className="sui-stack-frame-loc">
        {frame.file}
        {frame.line !== undefined ? `:${frame.line}` : ""}
        {frame.column !== undefined ? `:${frame.column}` : ""}
      </span>
    </>
  );
  return (
    <li data-slot="stack-frame" className={cn("sui-stack-frame", className)} {...props}>
      {onFrameClick ? (
        <button type="button" className="sui-stack-frame-button" onClick={() => onFrameClick(frame)}>
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}
