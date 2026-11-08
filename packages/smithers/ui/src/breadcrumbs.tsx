/** @jsxImportSource react */
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { isPlainNavigationClick } from "./internal/navigationClick";
import { safeHref } from "./internal/safeHref";
import { useInjectUiCss } from "./styles";

/** One step of a {@link Breadcrumbs} trail. */
export type BreadcrumbItem = {
  /** Stable identity within the trail (a path works). */
  key: string;
  label: ReactNode;
  /** Where the step links. The last step is the current page and never links. */
  href?: string;
};

export type BreadcrumbsProps = Omit<ComponentProps<"nav">, "children"> & {
  /** The trail, outermost first. The last item is the current page. */
  items: ReadonlyArray<BreadcrumbItem>;
  /**
   * In-app navigation for a plain click on a linked step. The browser's default
   * is prevented first; a modified click (⌘, Ctrl, Shift, Alt, middle button)
   * keeps the browser's behavior, so opening a step in a new tab still works.
   */
  onNavigate?: (item: BreadcrumbItem) => void;
};

/**
 * A path trail such as `repo / src / index.ts`: every step but the last links,
 * and the last is marked `aria-current="page"`. Separators are decorative.
 */
export function Breadcrumbs({ items, onNavigate, className, "aria-label": label, ...props }: BreadcrumbsProps) {
  useInjectUiCss();
  const follow = (item: BreadcrumbItem) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (onNavigate === undefined || !isPlainNavigationClick(event)) return;
    event.preventDefault();
    onNavigate(item);
  };
  return (
    <nav data-slot="breadcrumbs" className={cn("sui-breadcrumbs", className)} aria-label={label ?? "Breadcrumb"} {...props}>
      <ol className="sui-breadcrumbs-list">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          const href = item.href === undefined ? undefined : safeHref(item.href);
          return (
            <li key={item.key} className="sui-breadcrumbs-item">
              {index === 0 ? null : <span className="sui-breadcrumbs-separator" aria-hidden="true">/</span>}
              {current || href === undefined ?
                <span className="sui-breadcrumbs-current" aria-current={current ? "page" : undefined}>{item.label}</span> :
                <a className="sui-breadcrumbs-link" href={href} onClick={follow(item)}>{item.label}</a>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
