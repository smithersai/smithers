/** @jsxImportSource react */
import { Badge } from "../badge";
import { Button } from "../button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../card";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";

export type ProofVerdict = "proved" | "stale" | "unproved" | "failed";

export type StateTransitionItem = {
  readonly id: string;
  readonly from: string;
  readonly event: string;
  readonly to: string;
  readonly guard?: string;
  readonly verdict: ProofVerdict;
  readonly theoremName?: string;
};

export type StateMachineViewProps = {
  readonly name: string;
  readonly revision: string;
  readonly verdict: ProofVerdict;
  readonly transitions: ReadonlyArray<StateTransitionItem>;
  readonly selectedTransitionId?: string;
  readonly onSelectTransition?: (id: string) => void;
  readonly onVerifyProof?: () => void;
  readonly className?: string;
};

const VERDICT_LABEL: Record<ProofVerdict, string> = {
  proved: "Lean proved",
  stale: "Proof stale",
  unproved: "Unproved",
  failed: "Counterexample",
};

const VERDICT_VARIANT: Record<ProofVerdict, "success" | "warning" | "muted" | "destructive"> = {
  proved: "success",
  stale: "warning",
  unproved: "muted",
  failed: "destructive",
};

/**
 * Visual state machine transition table and Lean 4 proof obligation inspector.
 * Clearly distinguishes stale proofs from proofs checked against the current revision.
 */
export function StateMachineView({
  name,
  revision,
  verdict,
  transitions,
  selectedTransitionId,
  onSelectTransition,
  onVerifyProof,
  className,
}: StateMachineViewProps) {
  useInjectUiCss();

  return (
    <Card data-slot="state-machine-view" data-proof-verdict={verdict} className={cn(className)}>
      <CardHeader>
        <CardTitle>{name}</CardTitle>
        <CardAction style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Badge variant="outline">Rev {revision.slice(0, 8)}</Badge>
          <Badge variant={VERDICT_VARIANT[verdict]}>{VERDICT_LABEL[verdict]}</Badge>
          {onVerifyProof ? (
            <Button type="button" size="sm" variant="outline" onClick={onVerifyProof}>
              Verify in Lean
            </Button>
          ) : null}
        </CardAction>
      </CardHeader>

      <CardContent>
        <ul
          aria-label={`${name} transitions`}
          style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}
        >
          {transitions.map((t) => {
            const selected = t.id === selectedTransitionId;
            const rowStyle = {
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
              padding: "8px 10px",
              borderRadius: "6px",
              border: selected ? "1px solid var(--brand, #0f766e)" : "1px solid var(--border, #d8d0c2)",
              background: "var(--surface-2, #efeae0)",
              color: "inherit",
              font: "inherit",
              textAlign: "left" as const,
            };
            const content = (
              <>
                <span style={{ fontFamily: "monospace", fontSize: "12.5px" }}>
                  {t.from} --[{t.event}]--&gt; {t.to}
                  {t.guard ? ` when ${t.guard}` : ""}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                  {t.theoremName ? <Badge variant="secondary">{t.theoremName}</Badge> : null}
                  <Badge variant={VERDICT_VARIANT[t.verdict]}>{VERDICT_LABEL[t.verdict]}</Badge>
                </span>
              </>
            );

            return (
              <li key={t.id} data-transition-id={t.id} data-selected={selected ? "true" : "false"}>
                {onSelectTransition ? (
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelectTransition(t.id)}
                    style={{ ...rowStyle, cursor: "pointer" }}
                  >
                    {content}
                  </button>
                ) : (
                  <div style={rowStyle}>{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
