/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";
import { formatBytes, type JsonValueData, jsonValueText } from "./jsonValueText";

export type JsonValueProps = Omit<ComponentProps<"details">, "children" | "open"> & {
  value: JsonValueData;
  /** What the value is, such as `Input` or `Output`: the disclosure's name. */
  label: string;
  /** Open on first render; the person toggles it after. */
  defaultOpen?: boolean;
};

/**
 * A redacted, clipped value as text in a disclosure: its label and size, a
 * `Clipped` marker when the host cut it, and the text in a `<pre>`,
 * pretty-printed when it is whole JSON. Never renders the value as markup.
 */
export function JsonValue({ value, label, defaultOpen = false, className, ...props }: JsonValueProps) {
  useInjectUiCss();
  return (
    <details
      data-slot="json-value"
      data-clipped={value.clipped ? "true" : undefined}
      className={cn("sui-json-value", className)}
      open={defaultOpen}
      {...props}
    >
      <summary className="sui-json-value-summary">
        <span className="sui-json-value-label">{label}</span>
        <span className="sui-json-value-size">{formatBytes(value.bytes)}</span>
        {value.clipped ? <span className="sui-json-value-clipped">Clipped</span> : null}
      </summary>
      <pre className="sui-json-value-text">{jsonValueText(value)}</pre>
    </details>
  );
}
