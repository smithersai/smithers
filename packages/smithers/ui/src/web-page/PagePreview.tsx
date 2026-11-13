/** @jsxImportSource react */
import { useState } from "react";
import { safeImageSrc } from "../internal/safeImageSrc";
import type { WebPageTarget } from "./webPageUrl";

/**
 * What a page says about itself, read from its head by a server (such as
 * `@smthrs/views`' `WebPage.check`): its title, a short description and an
 * `https:` icon. Each is optional; a card without them shows the domain.
 */
export type WebPagePreview = {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly icon?: string | undefined;
};

/** The domain a person reads: the host for an `https:` page, the whole origin for any other, so `http:` shows. */
export function domainOf(target: WebPageTarget): string {
  return target.href.startsWith("https:") ? target.host : target.origin;
}

/** A host-served image or inline image; remote icons never load in the viewer's browser. */
export function iconTarget(icon: string | undefined): string | null {
  return typeof icon === "string" ? safeImageSrc(icon) ?? null : null;
}

/** The page's icon, or the first letter of its host when it has none or it fails to load. */
function PageIcon({ icon, host }: { icon: string | null; host: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = icon !== null && failed !== icon;
  return (
    <span data-slot="web-page-icon" className="sui-web-page-icon" aria-hidden="true">
      {shown ? (
        <img src={icon} alt="" width={20} height={20} referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(icon)} />
      ) : (
        host.replace(/^www\./, "").charAt(0).toUpperCase()
      )}
    </span>
  );
}

/**
 * A page's icon, title, description and domain. The title is the domain when
 * the page names none, and the domain then isn't repeated under it.
 */
export function PagePreview({ target, preview }: { target: WebPageTarget; preview: WebPagePreview }) {
  const domain = domainOf(target);
  const title = preview.title?.trim() || undefined;
  const description = preview.description?.trim() || undefined;
  return (
    <span data-slot="web-page-preview" className="sui-web-page-preview">
      <PageIcon icon={iconTarget(preview.icon)} host={target.host} />
      <span className="sui-web-page-text">
        <span data-slot="web-page-title" className="sui-web-page-title">
          {title ?? domain}
        </span>
        {description === undefined ? null : (
          <span data-slot="web-page-description" className="sui-web-page-description">
            {description}
          </span>
        )}
        {title === undefined ? null : (
          <span data-slot="web-page-domain" className="sui-web-page-domain">
            {domain}
          </span>
        )}
      </span>
    </span>
  );
}
