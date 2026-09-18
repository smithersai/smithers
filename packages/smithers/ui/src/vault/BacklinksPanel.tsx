/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { cn } from "../cn";
import { Badge } from "../badge";
import { Eyebrow } from "../section-header";
import { RowButton } from "../row-button";
import { useVaultCss } from "./useVaultCss";
import type { VaultRowProps } from "./types";
import { noteLabel } from "./wikilinks";

export type BacklinksPanelProps = {
  /** Notes that link to the current note. */
  backlinks: string[];
  /** Notes the current note links out to. */
  linksOut?: string[];
  onOpenNote?: (path: string) => void;
  /**
   * Extra attributes for each link row, by note path — the host's own binding
   * (`data-flow`, a test id, a title). Anything it sets wins over this
   * component's attribute of the same name, so a host can also correct one.
   */
  linkProps?: (path: string) => VaultRowProps;
  className?: string;
  style?: CSSProperties;
};

function LinkSection({
  title,
  paths,
  empty,
  onOpenNote,
  linkProps,
}: {
  title: string;
  paths: string[];
  empty: string;
  onOpenNote?: (path: string) => void;
  linkProps?: (path: string) => VaultRowProps;
}) {
  return (
    <section className="sui-vault-links-section">
      <div className="sui-vault-links-head">
        <Eyebrow>{title}</Eyebrow>
        <Badge variant="secondary">{paths.length}</Badge>
      </div>
      {paths.length === 0 ? (
        <p className="sui-vault-links-empty">{empty}</p>
      ) : (
        paths.map((path) => (
          <RowButton key={path} onClick={() => onOpenNote?.(path)} {...linkProps?.(path)}>
            <span className="sui-vault-link-label">{noteLabel(path)}</span>
            <span className="sui-vault-link-path">{path}</span>
          </RowButton>
        ))
      )}
    </section>
  );
}

/**
 * The Obsidian backlinks footer: who links here, and where this note links
 * out to, as clickable note chips with count badges.
 */
export function BacklinksPanel({ backlinks, linksOut = [], onOpenNote, linkProps, className, style }: BacklinksPanelProps) {
  useVaultCss();
  return (
    <div data-slot="vault-backlinks" className={cn("sui-vault-links", className)} style={style}>
      <LinkSection title="Backlinks" paths={backlinks} empty="No backlinks yet" onOpenNote={onOpenNote} linkProps={linkProps} />
      <LinkSection title="Linked mentions" paths={linksOut} empty="No outgoing links yet" onOpenNote={onOpenNote} linkProps={linkProps} />
    </div>
  );
}
