import React from "react";
import {
  entrySourceLabel,
  formatClockTime,
} from "../../shared/format.js";
import { useAppStore } from "../state/store.js";

type FeedProps = {
  focused: boolean;
  quietHarbor: boolean;
  visibleRows: number;
};

function sourceColor(label: string) {
  switch (label) {
    case "You":
      return "#cbd5e0";
    case "Smithers":
      return "#63b3ed";
    case "Run":
      return "#48bb78";
    case "Approval":
      return "#ecc94b";
    case "Error":
      return "#f56565";
    case "Warn":
      return "#ed8936";
    default:
      return "#a0aec0";
  }
}

export function Feed({ focused, quietHarbor, visibleRows }: FeedProps) {
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const feed = useAppStore((state) => state.feed);
  const selectedFeedEntryId = useAppStore((state) => state.selectedFeedEntryId);
  const activeWorkspace = useAppStore((state) =>
    state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId),
  );

  const entries = feed.filter((entry) => entry.workspaceId === activeWorkspaceId);
  const selectedIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.id === selectedFeedEntryId),
  );
  const windowSize = Math.max(8, visibleRows);
  const startIndex =
    entries.length <= windowSize
      ? 0
      : Math.max(
          0,
          Math.min(
            entries.length - windowSize,
            activeWorkspace?.selection.follow
              ? entries.length - windowSize
              : selectedIndex - Math.floor(windowSize / 2),
          ),
        );
  const visibleEntries = entries.slice(startIndex, startIndex + windowSize);

  return (
    <box
      style={{
        flexGrow: 1,
        width: "100%",
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {visibleEntries.length === 0 ? (
        <box style={{ width: "100%", flexDirection: "column", paddingTop: 1 }}>
          <text style={{ color: "#718096" }}>Welcome Bento Board</text>
          <text style={{ color: "#cbd5e0" }}>
            Pick a workflow with #, or ask Smithers to inspect the repo and suggest one.
          </text>
        </box>
      ) : (
        visibleEntries.map((entry) => {
          const selected = entry.id === selectedFeedEntryId;
          const label = entrySourceLabel(entry);
          return (
            <box
              key={entry.id}
              style={{
                width: "100%",
                minHeight: 1,
                flexDirection: "row",
                backgroundColor: selected ? "#111827" : undefined,
              }}
            >
              <text style={{ color: "#718096", width: quietHarbor ? 6 : 7 }}>
                {formatClockTime(entry.timestampMs)}
              </text>
              <text
                style={{
                  color: sourceColor(label),
                  width: quietHarbor ? 9 : 10,
                  bold: selected || focused,
                }}
              >
                {label.padEnd(quietHarbor ? 8 : 9, " ")}
              </text>
              <text style={{ color: selected ? "#f7fafc" : "#e2e8f0" }}>
                {entry.summary}
              </text>
            </box>
          );
        })
      )}
    </box>
  );
}
