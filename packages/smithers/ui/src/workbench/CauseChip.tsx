/** @jsxImportSource react */
import { Badge } from "../badge";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";

export type CauseOrigin =
  | { readonly kind: "plan"; readonly page: string; readonly blockId: string; readonly rev: string; readonly label?: string }
  | { readonly kind: "person"; readonly actor: string }
  | { readonly kind: "import"; readonly source: string }
  | { readonly kind: "private" }
  | { readonly kind: "missing" };

export type CauseReceiptData = {
  readonly outputRef: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly attempt?: number;
  readonly journalSeq?: number;
  readonly promptHash?: string;
  readonly origin: CauseOrigin;
};

export type CauseChipProps = {
  readonly receipt: CauseReceiptData;
  readonly onReveal?: (receipt: CauseReceiptData) => void;
  readonly className?: string;
};

/**
 * Clickable causal provenance chip stamped on every output, diff, artifact, or card.
 * Never hides missing provenance and never exposes private plan titles.
 */
export function CauseChip({ receipt, onReveal, className }: CauseChipProps) {
  useInjectUiCss();
  const { origin } = receipt;

  if (origin.kind === "missing") {
    return (
      <Badge
        data-slot="cause-chip"
        data-cause-kind="missing"
        variant="destructive"
        className={className}
      >
        Provenance missing
      </Badge>
    );
  }

  if (origin.kind === "private") {
    return (
      <Badge
        data-slot="cause-chip"
        data-cause-kind="private"
        variant="muted"
        className={className}
      >
        Private origin
      </Badge>
    );
  }

  const label =
    origin.kind === "plan"
      ? (origin.label ?? `${origin.page}#${origin.blockId}`)
      : origin.kind === "person"
      ? `Person: ${origin.actor}`
      : `Imported: ${origin.source}`;

  const interactive = origin.kind === "plan" && onReveal !== undefined;

  if (interactive) {
    return (
      <button
        type="button"
        data-slot="cause-chip"
        data-cause-kind="plan"
        onClick={() => onReveal(receipt)}
        aria-label={`Jump to causal plan node ${label}`}
        className={cn("sui-badge sui-badge-outline", className)}
        style={{ cursor: "pointer" }}
      >
        {label}
      </button>
    );
  }

  return (
    <Badge
      data-slot="cause-chip"
      data-cause-kind={origin.kind}
      variant="secondary"
      className={className}
    >
      {label}
    </Badge>
  );
}

export type CauseTrailProps = {
  readonly receipt: CauseReceiptData;
  readonly onRevealPlan?: (receipt: CauseReceiptData) => void;
  readonly onRevealRun?: (runId: string) => void;
  readonly className?: string;
};

/**
 * Full causal breadcrumb from output back through attempt, node, run, and exact plan block.
 */
export function CauseTrail({ receipt, onRevealPlan, onRevealRun, className }: CauseTrailProps) {
  useInjectUiCss();

  return (
    <nav
      data-slot="cause-trail"
      aria-label="Causal provenance"
      className={cn("sui-cause-trail", className)}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", fontSize: "12px" }}
    >
      <CauseChip receipt={receipt} onReveal={onRevealPlan} />
      {receipt.runId ? (
        onRevealRun ? (
          <button
            type="button"
            data-slot="cause-trail-run"
            className="sui-badge sui-badge-secondary"
            style={{ cursor: "pointer" }}
            onClick={() => onRevealRun(receipt.runId!)}
          >
            Run {receipt.runId}
          </button>
        ) : (
          <Badge variant="secondary">Run {receipt.runId}</Badge>
        )
      ) : null}
      {receipt.nodeId ? <Badge variant="muted">Step {receipt.nodeId}</Badge> : null}
      {receipt.attempt !== undefined ? <Badge variant="muted">Attempt {receipt.attempt}</Badge> : null}
      {receipt.journalSeq !== undefined ? <Badge variant="muted">Frame {receipt.journalSeq}</Badge> : null}
    </nav>
  );
}
