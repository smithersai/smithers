/** @jsxImportSource react */
import { type ComponentProps, type ReactNode, useState } from "react";
import { Button } from "../button";
import { cn } from "@smthrs/ui-css";
import { EmptyState } from "../empty-state";
import { useInjectUiCss } from "../styles";
import { hostOrigin } from "./hostOrigin";
import { PagePreview, type WebPagePreview } from "./PagePreview";
import { framedPageTarget } from "./webPageUrl";

/**
 * The frame's sandbox. `allow-same-origin` keeps the page's own cookies and
 * storage so ordinary sites work. It is safe only because `framedPageTarget`
 * refuses the host's site and the host serves its own pages with
 * `frame-ancestors 'none'`, so a redirect inside the frame cannot land on the
 * host's origin. No top navigation, no downloads.
 */
export const WEB_PAGE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

export type WebPageViewProps = Omit<ComponentProps<"figure">, "children" | "title" | "ref" | "dangerouslySetInnerHTML"> & {
  /** The page to show. Anything `framedPageTarget` refuses shows `Can't show this page`. */
  url: string;
  /** `inline` is a fixed-height frame for a message; `full` fills its container. */
  size?: "inline" | "full";
  /** The frame's accessible name. Defaults to `Web page from <host>`. */
  title?: string;
  /** Controls placed in the top bar before `Open in new tab`. */
  actions?: ReactNode;
  /** What the page says about itself, shown over the frame until it loads. */
  preview?: WebPagePreview;
};

/**
 * An outside web page in a sandboxed frame, under a bar with its origin and an
 * always-visible `Open in new tab` link. Until the frame loads, its preview
 * (icon, title, description, domain) covers it, so a page that never loads
 * still says what it is. Many sites refuse framing and the page cannot tell:
 * check before framing (`@smthrs/views`' `WebPage.check`) and show a
 * `WebLinkCard` for a page that refuses.
 */
export function WebPageView({ url, size = "inline", title, actions, preview = {}, className, ...props }: WebPageViewProps) {
  useInjectUiCss();
  const [loaded, setLoaded] = useState<string | null>(null);
  const target = framedPageTarget(url, hostOrigin());
  if (target === null) {
    return <EmptyState {...props} className={className} title="Can't show this page" data-slot="web-page-view" data-refused="true" />;
  }
  const pending = loaded !== target.href;
  return (
    <figure
      {...props}
      className={cn("sui-web-page-view", className)}
      data-slot="web-page-view"
      data-size={size}
      data-state={pending ? "loading" : "loaded"}
    >
      <figcaption className="sui-web-page-bar">
        <span data-slot="web-page-origin" className="sui-web-page-origin">
          {target.origin}
        </span>
        <span data-slot="web-page-actions" className="sui-web-page-actions">
          {actions}
          <Button asChild variant="outline" size="sm">
            <a data-slot="web-page-open" href={target.href} target="_blank" rel="noopener noreferrer">
              Open in new tab
            </a>
          </Button>
        </span>
      </figcaption>
      <div className="sui-web-page-stage">
        <iframe
          data-slot="web-page-frame"
          className="sui-web-page-frame"
          title={title ?? `Web page from ${target.host}`}
          src={target.href}
          sandbox={WEB_PAGE_SANDBOX}
          referrerPolicy="no-referrer"
          loading="lazy"
          onLoad={() => setLoaded(target.href)}
        />
        {pending ? (
          <div data-slot="web-page-pending" className="sui-web-page-pending" aria-hidden="true">
            <PagePreview target={target} preview={preview} />
          </div>
        ) : null}
      </div>
    </figure>
  );
}
