/** @jsxImportSource react */
import { cn } from "@smthrs/ui-css";
import { type ComponentProps, useRef, useState } from "react";

/**
 * The policy a preview's document runs under, as decision 0017's app frame
 * does: inline script and style only, images and fonts only from `data:` and
 * `blob:`, and no network at all: no fetch, no form, no frame, no base URL.
 */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The frame's sandbox: scripts run, in an opaque origin, so nothing in the
 * page reaches the app, its storage or its cookies; no popups, top
 * navigation, forms, downloads or dialogs.
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts";

/**
 * The document a preview shows: `html` with the policy and a `<base
 * target="_blank">` ahead of anything it holds, so the policy covers every
 * script and a link opens a popup the sandbox refuses instead of leaving.
 * The file's own doctype is dropped for one ahead of the policy.
 */
export const previewDocument = (html: string): string =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">` +
  `<base target="_blank">${html.replace(/^﻿?\s*<!doctype[^>]*>/i, "")}`;

export type HtmlPreviewProps = Omit<ComponentProps<"iframe">, "src" | "srcDoc" | "sandbox" | "title"> & {
  /** The page's HTML, as the repository holds it. */
  html: string;
  /** The frame's accessible name, such as the file's path. */
  title: string;
};

/**
 * An HTML file rendered live, as CodePen's result pane: a sandboxed frame
 * whose document runs under {@link HTML_PREVIEW_CSP}. A page that navigates
 * itself anyway (a script setting `location`, a link aimed at `_self`) is put
 * back: the frame's second load remounts it on the file, as decision 0017
 * tears down an app frame that navigates.
 */
export function HtmlPreview({ html, title, className, onLoad, ...props }: HtmlPreviewProps) {
  const [mount, setMount] = useState(0);
  const loads = useRef(0);
  return (
    <iframe
      key={mount}
      className={cn("sui-html-preview", className)}
      title={title}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={previewDocument(html)}
      onLoad={(event) => {
        loads.current += 1;
        if (loads.current > 1) {
          loads.current = 0;
          setMount((value) => value + 1);
          return;
        }
        onLoad?.(event);
      }}
      {...props}
    />
  );
}
