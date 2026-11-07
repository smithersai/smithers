/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Button } from "../button";
import { Card } from "../card";
import { cn } from "@smthrs/ui-css";
import { EmptyState } from "../empty-state";
import { Kbd } from "../kbd";
import { useInjectUiCss } from "../styles";
import { hostOrigin } from "./hostOrigin";
import { PagePreview, type WebPagePreview } from "./PagePreview";
import { webPageTarget } from "./webPageUrl";

export type WebLinkCardProps = Omit<
  ComponentProps<"section">,
  "children" | "ref" | "dangerouslySetInnerHTML" | "title"
> &
  WebPagePreview & {
    /** The page to open. Anything `webPageTarget` refuses shows `Can't show this page`. */
    url: string;
    /** The Open link's text. Defaults to `Open in new tab`. */
    openLabel?: string;
    /** Called when a person opens the page; the link still opens the tab. */
    onOpen?: () => void;
  };

/**
 * An outside web page as a card: its icon, title, description and domain,
 * and an `Open in new tab` link. The link is a real anchor, so the person's
 * click or Enter opens the tab and no popup blocker applies. `title`,
 * `description` and `icon` come from the page's head, read by a server; the
 * card shows the domain alone without them.
 */
export function WebLinkCard({
  url,
  title,
  description,
  icon,
  openLabel = "Open in new tab",
  onOpen,
  className,
  ...props
}: WebLinkCardProps) {
  useInjectUiCss();
  const target = webPageTarget(url, hostOrigin());
  if (target === null) {
    return <EmptyState {...props} className={className} title="Can't show this page" data-slot="web-link-card" data-refused="true" />;
  }
  return (
    <Card {...props} className={cn("sui-web-link-card", className)} data-slot="web-link-card">
      <PagePreview target={target} preview={{ title, description, icon }} />
      <Button asChild size="sm">
        <a
          data-slot="web-link-open"
          href={target.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${openLabel}: ${title?.trim() || target.host}`}
          aria-keyshortcuts="Enter"
          onClick={() => onOpen?.()}
        >
          {openLabel}
          <Kbd aria-hidden="true">↵</Kbd>
        </a>
      </Button>
    </Card>
  );
}
