/** @jsxImportSource react */
import { cn } from "@smthrs/ui-css";
import type { ComponentProps } from "react";

/**
 * The policy a preview's document runs under, as decision 0017's app frame
 * does: inline script and style only, images and fonts only from `data:` and
 * `blob:`, and no fetch, form, frame or base URL. A policy can't stop a
 * document navigating itself, but the browser checks every navigation of a
 * frame against its parent's `frame-src` before it sends a request: the guard
 * document around the page runs under this policy too, so its `'none'` holds
 * the page's frame on its `srcdoc`.
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
 * The guard's script: on a navigation the policy blocks, or a second load of
 * the page's frame (a reload), it removes the frame and shows the note in its
 * place, so a page that navigates is stopped instead of looping.
 */
const guardScript =
  "const frame=document.querySelector(\"iframe\"),note=document.querySelector(\"p\");let loads=0;" +
  "const stop=()=>{frame.remove();note.hidden=false};" +
  "frame.addEventListener(\"load\",()=>{loads+=1;if(loads>1)stop()});" +
  "document.addEventListener(\"securitypolicyviolation\",stop)";

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

const attribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The document the preview's frame holds: the guard, under
 * {@link HTML_PREVIEW_CSP}, around a second sandboxed frame named `title`
 * whose `srcdoc` is {@link previewDocument} of `html`, and the note a stopped
 * page leaves. A `srcdoc` document inherits its parent's policy, so the guard
 * can be no stricter than the page's own.
 */
export const guardDocument = (html: string, title: string): string =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">` +
  "<style>html,body{height:100%;margin:0}iframe{display:block;width:100%;height:100%;border:0}" +
  "p{margin:1rem;font:14px system-ui,sans-serif;color:GrayText}</style>" +
  `<iframe sandbox="${HTML_PREVIEW_SANDBOX}" referrerpolicy="no-referrer" title="${attribute(title)}" ` +
  `srcdoc="${attribute(previewDocument(html))}"></iframe>` +
  "<p hidden>This page tried to leave the preview, so it was stopped.</p>" +
  `<script>${guardScript}</script>`;

export type HtmlPreviewProps = Omit<ComponentProps<"iframe">, "src" | "srcDoc" | "sandbox" | "title"> & {
  /** The page's HTML, as the repository holds it. */
  html: string;
  /** The frame's accessible name, such as the file's path. */
  title: string;
};

/**
 * An HTML file rendered live, as CodePen's result pane: a sandboxed frame
 * holding {@link guardDocument}, whose own sandboxed frame runs the page under
 * {@link HTML_PREVIEW_CSP}. A page that navigates itself (a script setting
 * `location`, a meta refresh, a link aimed at `_self`) requests nothing: the
 * guard's `frame-src` blocks it, and the guard replaces the page with a note,
 * as decision 0017 tears down an app frame that navigates.
 */
export function HtmlPreview({ html, title, className, ...props }: HtmlPreviewProps) {
  return (
    <iframe
      className={cn("sui-html-preview", className)}
      title={title}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={guardDocument(html, title)}
      {...props}
    />
  );
}
