/** @jsxImportSource react */
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { cn } from "../cn";
import { type CopyFailureCode, copyToClipboard } from "../internal/copyToClipboard";
import { useInjectUiCss } from "../styles";

export type SnippetProps = Omit<ComponentProps<"div">, "children"> & {
  code: string;
  language?: string;
  onCopyCode?: (code: string) => void | Promise<void>;
  onCopyError?: (error: { code: CopyFailureCode; cause: unknown; }) => void;
};

/**
 * One-line command/code chip with a copy affordance. Copy seam matches
 * CodeBlock: onCopyCode wins, else navigator.clipboard when available, else
 * the button is hidden.
 */
export function Snippet({ code, language, onCopyCode, onCopyError, className, ...props }: SnippetProps) {
  useInjectUiCss();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyInFlightRef = useRef(false);
  const mountedRef = useRef(false);
  const hasClipboard = typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
  const canCopy = onCopyCode !== undefined || hasClipboard;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  async function copyCode() {
    if (copyInFlightRef.current) return;
    copyInFlightRef.current = true;
    const result = await copyToClipboard(code, onCopyCode);
    copyInFlightRef.current = false;
    if (!mountedRef.current) return;
    if (!result.ok) {
      if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = undefined;
      setCopied(false);
      setCopyFailed(true);
      onCopyError?.({ code: result.code, cause: result.cause });
      return;
    }
    setCopyFailed(false);
    setCopied(true);
    if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = undefined;
      setCopied(false);
    }, 2_000);
  }

  return (
    <div
      data-slot="snippet"
      data-language={language}
      data-copied={copied ? "true" : "false"}
      className={cn("sui-snippet", className)}
      {...props}
      data-copy-failed={copyFailed ? "true" : undefined}
    >
      <code className="sui-snippet-code">{code}</code>
      {canCopy ?
        (
          <button
            type="button"
            data-slot="snippet-copy"
            className="sui-snippet-copy"
            aria-label="Copy code"
            onClick={() => {
              void copyCode();
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        ) :
        null}
    </div>
  );
}
