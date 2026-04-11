// @ts-nocheck
import React, { useEffect, useState, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import type { SmithersDb } from "../../../db/adapter.js";
import { formatAge } from "../../format.js";

type AttentionItem = {
  kind: "alert" | "approval";
  id: string;
  severity: string;
  status: string;
  runId: string | null;
  nodeId: string | null;
  message: string;
  firedAtMs: number | null;
};

export function AttentionPane({
  adapter,
  focused,
  onSelectRun,
}: {
  adapter: SmithersDb;
  focused: boolean;
  onSelectRun?: (runId: string) => void;
}) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      if (!mounted) return;
      try {
        const result: AttentionItem[] = [];

        // Active alerts
        const alerts = await adapter.listAlerts(100, ["firing", "acknowledged"]);
        for (const alert of alerts as any[]) {
          result.push({
            kind: "alert",
            id: alert.alertId,
            severity: alert.severity,
            status: alert.status,
            runId: alert.runId ?? null,
            nodeId: alert.nodeId ?? null,
            message: alert.message,
            firedAtMs: alert.firedAtMs ?? null,
          });
        }

        // Pending approvals
        const runs = await adapter.listRuns(100);
        for (const run of runs as any[]) {
          const pending = await adapter.listPendingApprovals(run.runId);
          for (const ap of pending as any[]) {
            result.push({
              kind: "approval",
              id: `${ap.runId}:${ap.nodeId}:${ap.iteration ?? 0}`,
              severity: "info",
              status: "pending",
              runId: ap.runId,
              nodeId: ap.nodeId,
              message: ap.note ?? `Approval for ${ap.nodeId}`,
              firedAtMs: ap.requestedAtMs ?? null,
            });
          }
        }

        // Sort: critical first, then warning, then info
        const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
        result.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

        if (mounted) setItems(result);
      } catch {}
      if (mounted) setTimeout(poll, 2000);
    }

    poll();
    return () => { mounted = false; };
  }, [adapter]);

  const selected = items[selectedIndex];

  useKeyboard(
    focused,
    useCallback(
      (key: string) => {
        if (key === "up" || key === "k") {
          setSelectedIndex((i) => Math.max(0, i - 1));
        } else if (key === "down" || key === "j") {
          setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
        } else if (key === "a" && selected?.kind === "alert" && selected.status === "firing") {
          // Ack
          void adapter.acknowledgeAlert(selected.id, Date.now());
        } else if (key === "r" && selected?.kind === "alert") {
          // Resolve
          void adapter.resolveAlert(selected.id, Date.now());
        } else if (key === "s" && selected?.kind === "alert") {
          // Silence for 1h
          void adapter.silenceAlert(selected.id, Date.now() + 3_600_000);
        } else if (key === "enter" && selected?.runId && onSelectRun) {
          onSelectRun(selected.runId);
        }
      },
      [items, selectedIndex, selected, adapter, onSelectRun],
    ),
  );

  const severityCounts = {
    critical: items.filter((i) => i.severity === "critical").length,
    warning: items.filter((i) => i.severity === "warning").length,
    info: items.filter((i) => i.severity === "info").length,
  };

  const header = [
    `Attention (${items.length})`,
    severityCounts.critical > 0 ? ` 🔴${severityCounts.critical}` : "",
    severityCounts.warning > 0 ? ` 🟡${severityCounts.warning}` : "",
    severityCounts.info > 0 ? ` 🔵${severityCounts.info}` : "",
  ].join("");

  return (
    <box flexDirection="column">
      <text bold>{header}</text>
      <text dimColor>  [a]ck  [r]esolve  [s]ilence  [Enter] open run</text>
      {items.length === 0 ? (
        <text dimColor>  All clear — no attention items.</text>
      ) : (
        items.map((item, i) => {
          const isSelected = i === selectedIndex && focused;
          const sev =
            item.severity === "critical" ? "🔴" : item.severity === "warning" ? "🟡" : "🔵";
          const age = item.firedAtMs ? formatAge(item.firedAtMs) : "";
          const prefix = isSelected ? "▸ " : "  ";
          return (
            <text key={item.id} inverse={isSelected}>
              {prefix}{sev} [{item.kind}] {item.message} ({item.status}) {age}
            </text>
          );
        })
      )}
    </box>
  );
}
