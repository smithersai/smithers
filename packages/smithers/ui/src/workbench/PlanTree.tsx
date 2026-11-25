/** @jsxImportSource react */
import { Badge } from "../badge";
import { cn } from "@smthrs/ui-css";
import { StatusPill } from "../status-pill";
import { useInjectUiCss } from "../styles";
import { CauseChip, type CauseReceiptData } from "./CauseChip";

export type PlanTreeNodeStatus = "pending" | "in_progress" | "blocked_on_will" | "done" | "failed";

export type PlanAssumption = {
  readonly id: string;
  readonly text: string;
  readonly verified: boolean;
};

export type PlanTreeNodeItem = {
  readonly id: string;
  readonly title: string;
  readonly milestone: string;
  readonly status: PlanTreeNodeStatus;
  readonly depth: number;
  readonly sources?: ReadonlyArray<string>;
  readonly assumptions?: ReadonlyArray<PlanAssumption>;
  readonly cause?: CauseReceiptData;
};

export type PlanTreeProps = {
  readonly nodes: ReadonlyArray<PlanTreeNodeItem>;
  readonly selectedId?: string;
  readonly onSelect?: (nodeId: string) => void;
  readonly onToggleAssumption?: (nodeId: string, assumptionId: string) => void;
  readonly onRevealCause?: (receipt: CauseReceiptData) => void;
  readonly emptyLabel?: string;
  readonly className?: string;
};

const STATUS_MAP: Record<PlanTreeNodeStatus, string> = {
  pending: "pending",
  in_progress: "running",
  blocked_on_will: "waiting",
  done: "completed",
  failed: "failed",
};

type HierarchyItem = {
  readonly node: PlanTreeNodeItem;
  readonly children: Array<HierarchyItem>;
};

function buildHierarchy(nodes: ReadonlyArray<PlanTreeNodeItem>): ReadonlyArray<HierarchyItem> {
  const roots: Array<HierarchyItem> = [];
  const stack: Array<HierarchyItem> = [];

  for (const node of nodes) {
    const item: HierarchyItem = { node, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.node.depth >= node.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(item);
    } else {
      roots.push(item);
    }
    stack.push(item);
  }
  return roots;
}

/**
 * Obsidian-compatible Plan Tree navigator with checkmarked assumptions,
 * source pointers, and linked causal trace chips. Controlled purely by props.
 */
export function PlanTree({
  nodes,
  selectedId,
  onSelect,
  onToggleAssumption,
  onRevealCause,
  emptyLabel = "No plan nodes yet.",
  className,
}: PlanTreeProps) {
  useInjectUiCss();

  if (nodes.length === 0) {
    return (
      <div data-slot="plan-tree" data-empty="true" className={cn("sui-empty-state", className)}>
        {emptyLabel}
      </div>
    );
  }

  const renderBranch = (items: ReadonlyArray<HierarchyItem>, nested: boolean) => (
    <ul
      data-slot={nested ? "plan-tree-branch" : "plan-tree"}
      aria-label={nested ? undefined : "Plan Tree"}
      className={nested ? undefined : cn("sui-plan-tree", className)}
      style={{
        listStyle: "none",
        margin: 0,
        marginTop: nested ? "8px" : 0,
        padding: 0,
        paddingLeft: nested ? "16px" : 0,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      {items.map(({ node, children }) => {
        const selected = node.id === selectedId;
        const verifiedCount = (node.assumptions ?? []).filter((a) => a.verified).length;
        const totalAssumptions = (node.assumptions ?? []).length;
        const sources = node.sources ?? [];

        return (
          <li
            key={node.id}
            data-slot="plan-tree-node"
            data-node-id={node.id}
            data-depth={node.depth}
            data-selected={selected ? "true" : "false"}
          >
            <div
              className="sui-card"
              style={{
                padding: "10px 12px",
                outline: selected ? "2px solid var(--brand, #0f766e)" : undefined,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                {onSelect ? (
                  <button
                    type="button"
                    data-slot="plan-tree-select"
                    aria-pressed={selected}
                    onClick={() => onSelect(node.id)}
                    style={{
                      background: "none",
                      border: 0,
                      padding: 0,
                      color: "inherit",
                      font: "inherit",
                      fontWeight: 600,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    {node.title}
                  </button>
                ) : (
                  <span data-slot="plan-tree-title" style={{ fontWeight: 600 }}>
                    {node.title}
                  </span>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                  <Badge variant="outline">{node.milestone}</Badge>
                  <StatusPill status={STATUS_MAP[node.status]} />
                </div>
              </div>

              {sources.length > 0 ? (
                <div
                  data-slot="plan-tree-sources"
                  style={{ marginTop: "6px", display: "flex", flexWrap: "wrap", gap: "6px" }}
                >
                  {sources.map((src) => (
                    <code
                      key={src}
                      style={{
                        fontSize: "11px",
                        padding: "1px 6px",
                        borderRadius: "4px",
                        background: "var(--surface-2, #efeae0)",
                      }}
                    >
                      {src}
                    </code>
                  ))}
                </div>
              ) : null}

              {totalAssumptions > 0 ? (
                <div
                  data-slot="plan-tree-assumptions"
                  style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "4px" }}
                >
                  <span style={{ fontSize: "11px", opacity: 0.72 }}>
                    Assumptions {verifiedCount}/{totalAssumptions}
                  </span>
                  {node.assumptions!.map((assumption) => (
                    <label
                      key={assumption.id}
                      style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12.5px" }}
                    >
                      <input
                        type="checkbox"
                        checked={assumption.verified}
                        onChange={() => onToggleAssumption?.(node.id, assumption.id)}
                        disabled={!onToggleAssumption}
                      />
                      <span>{assumption.text}</span>
                    </label>
                  ))}
                </div>
              ) : null}

              {node.cause ? (
                <div style={{ marginTop: "8px" }}>
                  <CauseChip receipt={node.cause} onReveal={onRevealCause} />
                </div>
              ) : null}
            </div>
            {children.length > 0 ? renderBranch(children, true) : null}
          </li>
        );
      })}
    </ul>
  );

  return renderBranch(buildHierarchy(nodes), false);
}
