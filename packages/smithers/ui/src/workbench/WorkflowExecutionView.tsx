/** @jsxImportSource react */
import { Badge } from "../badge";
import { Button } from "../button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../card";
import { cn } from "@smthrs/ui-css";
import { StatusPill } from "../status-pill";
import { useInjectUiCss } from "../styles";
import { CauseChip, type CauseReceiptData } from "./CauseChip";

export type WorkflowNodeItem = {
  readonly id: string;
  readonly label: string;
  readonly kind: "action" | "agent" | "jev" | "wait" | "sandbox";
  readonly status: string;
  readonly durationMs?: number;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly cause?: CauseReceiptData;
};

export type WorkflowExecutionViewProps = {
  readonly workflowTag: string;
  readonly sourcePath: string;
  readonly nodes: ReadonlyArray<WorkflowNodeItem>;
  readonly selectedNodeId?: string;
  readonly onSelectNode?: (nodeId: string) => void;
  readonly onReplayFromNode?: (nodeId: string) => void;
  readonly onRevealCause?: (receipt: CauseReceiptData) => void;
  readonly className?: string;
};

/**
 * Read-only n8n-grade execution projection over a .vibe workflow.
 * Accessible ordered node topology with per-node status, causal links, and explicit replay.
 */
export function WorkflowExecutionView({
  workflowTag,
  sourcePath,
  nodes,
  selectedNodeId,
  onSelectNode,
  onReplayFromNode,
  onRevealCause,
  className,
}: WorkflowExecutionViewProps) {
  useInjectUiCss();

  return (
    <Card data-slot="workflow-execution-view" data-workflow-tag={workflowTag} className={cn(className)}>
      <CardHeader>
        <CardTitle>{workflowTag}</CardTitle>
        <CardAction style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <Badge variant="outline">{sourcePath}</Badge>
          <Badge variant="secondary">{nodes.length} steps</Badge>
        </CardAction>
      </CardHeader>

      <CardContent>
        <ol
          aria-label={`${workflowTag} workflow steps`}
          style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" }}
        >
          {nodes.map((node) => {
            const selected = node.id === selectedNodeId;
            return (
              <li
                key={node.id}
                data-slot="workflow-execution-view-node"
                data-node-id={node.id}
                data-selected={selected ? "true" : "false"}
                style={{
                  borderRadius: "8px",
                  border: selected ? "2px solid var(--brand, #0f766e)" : "1px solid var(--border, #d8d0c2)",
                  padding: "10px 12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                  {onSelectNode ? (
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSelectNode(node.id)}
                      style={{
                        background: "none",
                        border: 0,
                        padding: 0,
                        font: "inherit",
                        fontWeight: 600,
                        color: "inherit",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      {node.label}
                    </button>
                  ) : (
                    <span style={{ fontWeight: 600 }}>{node.label}</span>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <Badge variant="outline">{node.kind}</Badge>
                    {node.durationMs !== undefined ? <Badge variant="muted">{node.durationMs}ms</Badge> : null}
                    <StatusPill status={node.status} />
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                    {(node.dependsOn ?? []).length > 0 ? (
                      <span style={{ fontSize: "11.5px", opacity: 0.72 }}>
                        After: {node.dependsOn!.join(", ")}
                      </span>
                    ) : null}
                    {node.cause ? <CauseChip receipt={node.cause} onReveal={onRevealCause} /> : null}
                  </div>
                  {onReplayFromNode ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Replay step ${node.label}`}
                      onClick={() => onReplayFromNode(node.id)}
                    >
                      Replay step
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
