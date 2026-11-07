/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { Button } from "../button";
import { cn } from "@smthrs/ui-css";
import { EmptyState } from "../empty-state";
import { Markdown, type MarkdownLinkClick } from "../primitives/markdown";
import { useInjectUiCss } from "../styles";
import { webPageTarget, type WebPageTarget } from "../web-page/webPageUrl";

/**
 * The docs page a view may show and link to, or `null` to refuse: an absolute
 * `https:` or `http:` URL with no username or password, parsed, never the raw
 * input. Every other scheme, and relative input, is refused.
 */
export function docsPageTarget(url: string): WebPageTarget | null {
  return webPageTarget(url);
}

export type DocsPageViewProps = Omit<ComponentProps<"article">, "children" | "title" | "ref" | "dangerouslySetInnerHTML"> & {
  /** The page's title, drawn as its heading. */
  title: string;
  /** The page's URL on its docs site. Anything `docsPageTarget` refuses shows `Can't show this page`. */
  url: string;
  /** The page's Markdown. It is someone else's text: drawn as a document, never as HTML. */
  text: string;
  /** Whether `text` is only the start of the page: a `Shortened` line follows it. */
  truncated?: boolean;
  /** `inline` is a bounded height with its own scroll, for a message; `full` fills its container. */
  size?: "inline" | "full";
  /** The heading's level: 2 unless set. */
  headingLevel?: 1 | 2 | 3;
  /** Controls placed in the top bar before `Open on site`. */
  actions?: ReactNode;
  /** Intercept a link in the page; its href is already resolved against `url`. */
  onLinkClick?: MarkdownLinkClick;
};

/** Whether the Markdown opens with its own top heading (`# …`), which is then the page's title: drawn once. */
const opensWithTitle = (text: string): boolean => /^\s*# \S/.test(text);

/**
 * One page of a docs site, read from its Markdown: a bar with the site's origin
 * and an `Open on site` link, the page's title as a heading unless the page
 * opens with its own `# ` heading, then the page.
 * Relative links in the page resolve against the page's URL, so they open on
 * the docs site, never on the host.
 */
export function DocsPageView({
  title,
  url,
  text,
  truncated = false,
  size = "inline",
  headingLevel = 2,
  actions,
  onLinkClick,
  className,
  ...props
}: DocsPageViewProps) {
  useInjectUiCss();
  const target = docsPageTarget(url);
  if (target === null) {
    return <EmptyState {...props} className={className} title="Can't show this page" data-slot="docs-page-view" data-refused="true" />;
  }
  const Heading = `h${headingLevel}` as const;
  return (
    <article {...props} className={cn("sui-docs-page-view", className)} data-slot="docs-page-view" data-size={size}>
      <div className="sui-docs-page-bar">
        <span data-slot="docs-page-origin" className="sui-docs-page-origin">
          {target.origin}
        </span>
        <span data-slot="docs-page-actions" className="sui-docs-page-actions">
          {actions}
          <Button asChild variant="outline" size="sm">
            <a data-slot="docs-page-open" href={target.href} target="_blank" rel="noopener noreferrer">
              Open on site
            </a>
          </Button>
        </span>
      </div>
      <div className="sui-docs-page-body" data-slot="docs-page-body">
        {opensWithTitle(text) ? null : <Heading className="sui-docs-page-title">{title}</Heading>}
        <Markdown
          content={text}
          variant="document"
          baseUrl={target.href}
          {...(onLinkClick ? { onLinkClick } : {})}
        />
        {truncated ? (
          <p data-slot="docs-page-truncated" className="sui-docs-page-truncated">
            Shortened
          </p>
        ) : null}
      </div>
    </article>
  );
}
