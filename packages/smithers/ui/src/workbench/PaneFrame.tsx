/** @jsxImportSource react */
import type { ReactNode } from "react";
import { Badge } from "../badge";
import { Button } from "../button";
import { cn } from "@smthrs/ui-css";
import { Kbd } from "../kbd";
import { useInjectUiCss } from "../styles";

export type PaneSize = "inline" | "side" | "full";

export type PaneOrigin = "core" | "built-in" | "repository" | "framed-app";

export type PaneFrameProps = {
  readonly paneId: string;
  readonly title: string;
  readonly size: PaneSize;
  readonly origin?: PaneOrigin;
  readonly originLabel?: string;
  readonly subtitle?: string;
  readonly headerAction?: ReactNode;
  readonly actionStrip?: ReactNode;
  readonly onInspect?: () => void;
  readonly onMaximize?: () => void;
  readonly onRestore?: () => void;
  readonly onClose?: () => void;
  readonly className?: string;
  readonly children: ReactNode;
};

const ORIGIN_COPY: Record<PaneOrigin, string> = {
  core: "Core",
  "built-in": "Built-in",
  repository: "Repo plugin",
  "framed-app": "Sandboxed app",
};

/**
 * Host-owned pane chrome across all three progressive-disclosure tiers:
 * inline card (Tier 0), side inspector drawer (Tier 1), and maximized workbench (Tier 2).
 * Plugins render inside children and never draw their own frame header or action strip.
 */
export function PaneFrame({
  paneId,
  title,
  size,
  origin = "core",
  originLabel,
  subtitle,
  headerAction,
  actionStrip,
  onInspect,
  onMaximize,
  onRestore,
  onClose,
  className,
  children,
}: PaneFrameProps) {
  useInjectUiCss();
  const resolvedOrigin = originLabel ?? ORIGIN_COPY[origin];

  return (
    <section
      data-slot="pane-frame"
      data-pane-id={paneId}
      data-pane-size={size}
      data-pane-origin={origin}
      aria-label={title}
      className={cn("sui-card", "sui-pane-frame", `sui-pane-frame-${size}`, className)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.shiftKey && size !== "full" && onMaximize) {
          event.preventDefault();
          onMaximize();
        } else if (event.key === "Escape" && size === "full" && onRestore) {
          event.preventDefault();
          onRestore();
        }
      }}
    >
      <header
        data-slot="pane-frame-header"
        className="sui-card-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
          <h2 data-slot="pane-frame-title" className="sui-card-title" style={{ margin: 0 }}>
            {title}
          </h2>
          <Badge variant={origin === "framed-app" || origin === "repository" ? "outline" : "secondary"}>
            {resolvedOrigin}
          </Badge>
          {subtitle ? (
            <span data-slot="pane-frame-subtitle" style={{ fontSize: "12px", opacity: 0.72 }}>
              {subtitle}
            </span>
          ) : null}
        </div>
        <div
          data-slot="pane-frame-controls"
          style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}
        >
          {headerAction}
          {size === "inline" && onInspect ? (
            <Button type="button" size="sm" variant="ghost" onClick={onInspect} aria-label={`Inspect ${title}`}>
              Inspect
            </Button>
          ) : null}
          {size !== "full" && onMaximize ? (
            <Button type="button" size="sm" variant="ghost" onClick={onMaximize} aria-label={`Maximize ${title}`}>
              Maximize <Kbd>Shift+Enter</Kbd>
            </Button>
          ) : null}
          {size === "full" && onRestore ? (
            <Button type="button" size="sm" variant="ghost" onClick={onRestore} aria-label={`Restore ${title}`}>
              Restore <Kbd>Esc</Kbd>
            </Button>
          ) : null}
          {size !== "inline" && onClose ? (
            <Button type="button" size="sm" variant="ghost" onClick={onClose} aria-label={`Close ${title}`}>
              Close
            </Button>
          ) : null}
        </div>
      </header>

      <div data-slot="pane-frame-body" className="sui-card-content">
        {children}
      </div>

      {actionStrip ? (
        <footer
          data-slot="pane-frame-action-strip"
          aria-label="Host actions"
          className="sui-card-footer"
        >
          {actionStrip}
        </footer>
      ) : null}
    </section>
  );
}
