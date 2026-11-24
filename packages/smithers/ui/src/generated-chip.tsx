/** @jsxImportSource react */
import { Badge } from "./badge";
import { isPlainNavigationClick } from "./internal/navigationClick";
import { safeHref } from "./internal/safeHref";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { useInjectUiCss } from "./styles";

/** One place a generated file's chip links to: its words, and where it goes when the host has the place. */
export interface GeneratedChipLink {
  readonly label: string;
  readonly href?: string | undefined;
}

export type GeneratedChipProps = {
  /** The flow that produced the file. */
  readonly flow?: GeneratedChipLink | undefined;
  /** The flow's last run that produced it. */
  readonly run?: GeneratedChipLink | undefined;
  /** What it was produced from. */
  readonly sources?: ReadonlyArray<GeneratedChipLink> | undefined;
  /** A plain click on a link: the host navigates in place. Without it, links are plain. */
  readonly onNavigate?: ((href: string) => void) | undefined;
};

function Row({ label, link, onNavigate }: {
  readonly label: string;
  readonly link: GeneratedChipLink;
  readonly onNavigate: GeneratedChipProps["onNavigate"];
}) {
  // A link whose scheme is not http(s) or mailto shows as its plain label.
  const href = link.href === undefined ? undefined : safeHref(link.href);
  return (
    <li className="sui-generated-row">
      <span className="sui-generated-label">{label}</span>
      {href === undefined ? <code>{link.label}</code> : (
        <a
          href={href}
          onClick={(event) => {
            if (onNavigate === undefined || !isPlainNavigationClick(event)) return;
            event.preventDefault();
            onNavigate(href);
          }}
        >
          <code>{link.label}</code>
        </a>
      )}
    </li>
  );
}

/**
 * A quiet Generated chip for a file a flow produced. Pressed, it opens the
 * flow, its last run and its sources, each a real link where the host has
 * one. With none to name (a file marked only by its own header), it is a
 * plain chip.
 */
export function GeneratedChip({ flow, run, sources = [], onNavigate }: GeneratedChipProps) {
  useInjectUiCss();
  if (flow === undefined && run === undefined && sources.length === 0) {
    return <Badge variant="muted" data-slot="generated-chip">Generated</Badge>;
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge asChild variant="muted">
          <button type="button" className="sui-generated-chip" data-slot="generated-chip">Generated</button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent align="start">
        <ul className="sui-generated-links" aria-label="Generated">
          {flow === undefined ? null : <Row label="Flow" link={flow} onNavigate={onNavigate} />}
          {run === undefined ? null : <Row label="Last run" link={run} onNavigate={onNavigate} />}
          {sources.map((source) => <Row key={source.label} label="Source" link={source} onNavigate={onNavigate} />)}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
