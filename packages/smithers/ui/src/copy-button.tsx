/** @jsxImportSource react */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "./button";

export type CopyButtonProps = Omit<ButtonProps, "onClick" | "children" | "loading"> & {
  /**
   * Copies, in the host's way: resolves once the text is on the clipboard and
   * rejects when it isn't. The button never touches the clipboard itself, so a
   * host that copies through its own channel says truthfully whether it did.
   */
  onCopy: () => void | Promise<void>;
  /** The label, such as "Copy path". */
  children: ReactNode;
  /** Shown in place of the label once the copy resolved. Defaults to "Copied". */
  copiedLabel?: ReactNode;
  /** How long the copied label shows, in milliseconds. Defaults to 2,000. */
  copiedDurationMs?: number;
};

/**
 * A button that copies through `onCopy` and says so: "Copied" for a moment
 * when it resolved, `data-copy-failed` when it rejected. Clicks while a copy
 * is in flight (`data-copying`) are ignored; it shows no loading state, since
 * a copy settles in moments.
 */
export function CopyButton({
  onCopy,
  children,
  copiedLabel = "Copied",
  copiedDurationMs = 2_000,
  ...props
}: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const copy = async () => {
    if (state === "copying") return;
    clearTimeout(timer.current);
    setState("copying");
    let next: "copied" | "failed" = "copied";
    try {
      await onCopy();
    } catch {
      next = "failed";
    }
    if (!mounted.current) return;
    clearTimeout(timer.current);
    setState(next);
    if (next === "copied") timer.current = setTimeout(() => setState("idle"), copiedDurationMs);
  };
  return (
    <Button
      data-slot="copy-button"
      data-copied={state === "copied" ? "true" : "false"}
      data-copy-failed={state === "failed" ? "true" : undefined}
      data-copying={state === "copying" ? "true" : undefined}
      onClick={() => void copy()}
      {...props}
    >
      {state === "copied" ? copiedLabel : children}
    </Button>
  );
}
