/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

// `title` omitted for the same reason as SectionHeader: the intrinsic HTML
// `title?: string` would collapse the ReactNode slot to `string & ReactNode`.
export type EmptyStateProps = Omit<ComponentProps<"div">, "title"> & {
  /** Optional leading visual (an svg, emoji span, ...). */
  icon?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** Optional call to action (usually a Button). */
  action?: ReactNode;
};

/**
 * Centered empty/zero-data block replacing bare `<p>No runs yet.</p>`
 * fallbacks. All slots optional; children render after the description.
 */
export function EmptyState({ icon, title, description, action, className, children, ...props }: EmptyStateProps) {
  useInjectUiCss();
  return (
    <div data-slot="empty-state" className={cn("sui-empty", className)} {...props}>
      {icon ? (
        <div className="sui-empty-icon" aria-hidden>
          {icon}
        </div>
      ) : null}
      {title ? <div className="sui-empty-title">{title}</div> : null}
      {description ? <div className="sui-empty-description">{description}</div> : null}
      {children}
      {action ? <div className="sui-empty-action">{action}</div> : null}
    </div>
  );
}
