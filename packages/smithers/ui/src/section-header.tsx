/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";

/** Uppercase overline label — the pattern consumer UIs previously each hand-rolled. */
export function Eyebrow({ className, ...props }: ComponentProps<"span">) {
  useInjectUiCss();
  return <span data-slot="eyebrow" className={cn("sui-eyebrow", className)} {...props} />;
}

// `title` is omitted from the div props: the intrinsic HTML `title?: string`
// would intersect with the slot below and collapse it to `string & ReactNode`,
// making element titles unassignable (same reason CollapsiblePanel omits it).
export type SectionHeaderProps = Omit<ComponentProps<"div">, "title"> & {
  title: ReactNode;
  /** Uppercase overline above the title. */
  eyebrow?: ReactNode;
  /** Right-aligned actions slot (buttons, badges). */
  actions?: ReactNode;
};

/** Section heading row: eyebrow + title on the left, actions on the right. */
export function SectionHeader({ title, eyebrow, actions, className, children, ...props }: SectionHeaderProps) {
  useInjectUiCss();
  return (
    <div data-slot="section-header" className={cn("sui-section-header", className)} {...props}>
      <div className="sui-section-header-main">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <div className="sui-section-header-title">{title}</div>
        {children}
      </div>
      {actions ? <div className="sui-section-header-actions">{actions}</div> : null}
    </div>
  );
}
