/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { useInjectUiCss } from "./styles";

export type PageHeaderProps = Omit<ComponentProps<"header">, "title"> & {
  /** The page's name, rendered as its `h1`. Leave it out when the page's content carries its own `h1`. */
  title?: ReactNode;
  /** A quiet way back, such as the router's link to the chat. Sits before the title. */
  back?: ReactNode;
  /** The page's own sections, such as a repository's Issues and Pull requests links. `aria-current="page"` marks the active one. */
  nav?: ReactNode;
  /** Label for the nav landmark. Default: `Sections`. */
  navLabel?: string;
  /** Right-aligned controls, such as a bell or the person's menu. */
  actions?: ReactNode;
  /** The column the bar's content lines up with: the same value as the page's {@link PageBody} `width`. */
  width?: "narrow" | "default" | "wide";
  /**
   * Rendered last in the bar's row, which is positioned: a `ToastStack` with `placement="anchored"` hangs under the
   * row at its end, under the bell in `actions`, and takes no layout space (apps/mvp decision 0137).
   */
  children?: ReactNode;
};

/**
 * The top bar every full page shares: a quiet back link, the title, the page's
 * sections and its actions, on one hairline-ruled row that wraps on a phone and
 * scrolls its sections sideways instead of breaking them. Its children, such as
 * an anchored `ToastStack`, hang under that row.
 */
export function PageHeader({ title, back, nav, navLabel = "Sections", actions, width = "default", className, children, ...props }: PageHeaderProps) {
  useInjectUiCss();
  return (
    <header data-slot="page-header" data-width={width} className={cn("sui-page-header", className)} {...props}>
      <div className="sui-page-header-inner">
        {back === undefined ? null : <div className="sui-page-header-back">{back}</div>}
        {title === undefined ? null : <h1 className="sui-page-header-title">{title}</h1>}
        {nav === undefined ? null : (
          <nav className="sui-page-header-nav" aria-label={navLabel}>{nav}</nav>
        )}
        {actions === undefined ? null : <div className="sui-page-header-actions">{actions}</div>}
        {children}
      </div>
    </header>
  );
}

export type PageBodyProps = ComponentProps<"div"> & {
  /** Column width: `narrow` for forms and settings, `default` for lists and cards, `wide` for code and tables. */
  width?: "narrow" | "default" | "wide";
};

/** The page's content column under a {@link PageHeader}: centered, padded, its cards spaced evenly. */
export function PageBody({ width = "default", className, ...props }: PageBodyProps) {
  useInjectUiCss();
  return <div data-slot="page-body" data-width={width} className={cn("sui-page-body", className)} {...props} />;
}
