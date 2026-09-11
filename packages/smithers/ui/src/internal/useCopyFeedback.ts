import { useEffect, useRef, useState } from "react";
import { type CopyFailureCode, copyToClipboard } from "./copyToClipboard";

export type UseCopyFeedbackOptions = {
  value: string;
  onCopy?: (value: string) => void | Promise<void>;
  onCopyError?: (error: { code: CopyFailureCode; cause: unknown; }) => void;
  copiedDurationMs?: number;
};

/**
 * Internal copy-button state machine shared by CodeBlock, Snippet and
 * SecretField: ignores clicks while a copy is in flight, drops results that
 * settle after unmount, reports failures, and resets "copied" after
 * copiedDurationMs.
 */
export function useCopyFeedback({ value, onCopy, onCopyError, copiedDurationMs = 2_000 }: UseCopyFeedbackOptions) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyInFlightRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  async function copy() {
    if (copyInFlightRef.current) return;
    copyInFlightRef.current = true;
    const result = await copyToClipboard(value, onCopy);
    copyInFlightRef.current = false;
    if (!mountedRef.current) return;
    if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = undefined;
    if (!result.ok) {
      setCopied(false);
      setCopyFailed(true);
      onCopyError?.({ code: result.code, cause: result.cause });
      return;
    }
    setCopyFailed(false);
    setCopied(true);
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = undefined;
      setCopied(false);
    }, copiedDurationMs);
  }

  return { copied, copyFailed, copy };
}
