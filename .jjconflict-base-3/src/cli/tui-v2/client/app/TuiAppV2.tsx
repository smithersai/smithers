import React, { useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SmithersBroker } from "../../broker/Broker.js";
import { Composer } from "../components/Composer.js";
import { Feed } from "../components/Feed.js";
import { Inspector } from "../components/Inspector.js";
import { TopBar } from "../components/TopBar.js";
import { WorkspaceRail } from "../components/WorkspaceRail.js";
import { useAppStore } from "../state/store.js";

type TuiAppV2Props = {
  broker: SmithersBroker;
  onExit: () => void;
};

function ApprovalActionBar() {
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const approvals = useAppStore((state) =>
    activeWorkspaceId ? state.approvals[activeWorkspaceId] ?? [] : [],
  );
  const approval = approvals[0];
  if (!approval) return null;

  return (
    <box
      style={{
        width: "100%",
        height: 1,
        flexDirection: "row",
        paddingLeft: 1,
      }}
    >
      <text style={{ color: "#ecc94b", bold: true }}>
        [ Approval ]
      </text>
      <text style={{ color: "#f7fafc" }}>
        {" "}
        {approval.nodeId} on {approval.runId.slice(0, 8)}
      </text>
      <text style={{ color: "#a0aec0" }}>
        {"   "}
        A approve  D deny  Enter inspect
      </text>
    </box>
  );
}

function OverlayPanel({ broker }: { broker: SmithersBroker }) {
  const overlay = useAppStore((state) => state.overlay);
  const workflows = useAppStore((state) => state.workflows);

  if (overlay.kind === "none") return null;

  if (overlay.kind === "workflow-picker") {
    const query = (overlay.query ?? "").toLowerCase();
    const items = workflows.filter((workflow) =>
      workflow.id.includes(query) ||
      workflow.displayName.toLowerCase().includes(query),
    );
    return (
      <box
        style={{
          width: "100%",
          height: 10,
          flexDirection: "column",
          border: true,
          borderColor: "#63b3ed",
          paddingLeft: 1,
          paddingTop: 1,
        }}
      >
        <text style={{ color: "#718096" }}>Workflows</text>
        {items.length === 0 ? (
          <text style={{ color: "#f56565" }}>No workflows match "#{overlay.query ?? ""}"</text>
        ) : (
          items.slice(0, 6).map((workflow, index) => (
            <text
              key={workflow.id}
              style={{
                color: index === (overlay.selectedIndex ?? 0) ? "#63b3ed" : "#e2e8f0",
                bold: index === (overlay.selectedIndex ?? 0),
              }}
            >
              {index === (overlay.selectedIndex ?? 0) ? "> " : "  "}
              {workflow.id}  {workflow.displayName}
            </text>
          ))
        )}
      </box>
    );
  }

  if (overlay.kind === "palette") {
    return (
      <box
        style={{
          width: "100%",
          height: 8,
          flexDirection: "column",
          border: true,
          borderColor: "#63b3ed",
          paddingLeft: 1,
          paddingTop: 1,
        }}
      >
        <text style={{ color: "#718096" }}>Actions</text>
        {[
          "Run workflow",
          "New workspace",
          "Jump to latest approval",
          "Focus feed",
          "Focus composer",
        ].map((label, index) => (
          <text
            key={label}
            style={{
              color: index === (overlay.selectedIndex ?? 0) ? "#63b3ed" : "#e2e8f0",
              bold: index === (overlay.selectedIndex ?? 0),
            }}
          >
            {index === (overlay.selectedIndex ?? 0) ? "> " : "  "}
            {label}
          </text>
        ))}
      </box>
    );
  }

  if (overlay.kind === "approval-dialog" && overlay.approval) {
    return (
      <box
        style={{
          width: "100%",
          height: 7,
          flexDirection: "column",
          border: true,
          borderColor: "#ecc94b",
          paddingLeft: 1,
          paddingTop: 1,
        }}
      >
        <text style={{ color: "#ecc94b", bold: true }}>Approval required</text>
        <text style={{ color: "#e2e8f0" }}>
          Run: {overlay.approval.runId}
        </text>
        <text style={{ color: "#e2e8f0" }}>
          Node: {overlay.approval.nodeId}
        </text>
        <text style={{ color: "#a0aec0" }}>A approve  D deny  Esc cancel</text>
      </box>
    );
  }

  return null;
}

export function TuiAppV2({ broker, onExit }: TuiAppV2Props) {
  const focusRegion = useAppStore((state) => state.focusRegion);
  const commandHint = useAppStore((state) => state.commandHint);
  const statusLine = useAppStore((state) => state.statusLine);
  const overlay = useAppStore((state) => state.overlay);
  const quietHarbor = useAppStore((state) => state.quietHarbor);
  const compactMode = useAppStore((state) => state.compactMode);
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const feedCount = useAppStore(
    (state) => state.feed.filter((entry) => entry.workspaceId === activeWorkspaceId).length,
  );
  const { width, height } = useTerminalDimensions();

  useEffect(() => {
    void broker.start();
    return () => broker.stop();
  }, [broker]);

  useEffect(() => {
    broker.setTerminalDimensions(width, height);
  }, [broker, width, height]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      onExit();
      return;
    }

    if (key.ctrl && key.name === "o") {
      broker.openPalette();
      return;
    }

    if (overlay.kind === "approval-dialog") {
      if (key.name === "escape") broker.closeOverlay();
      if (key.name === "a") void broker.approveActiveApproval(true);
      if (key.name === "d") void broker.approveActiveApproval(false);
      if (key.name === "return" || key.name === "enter") void broker.approveActiveApproval(true);
      return;
    }

    if (overlay.kind === "palette" || overlay.kind === "workflow-picker") {
      if (key.name === "escape") {
        broker.closeOverlay();
        return;
      }
      if (key.name === "up" || key.name === "k") {
        broker.moveOverlaySelection(-1);
        return;
      }
      if (key.name === "down" || key.name === "j") {
        broker.moveOverlaySelection(1);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        void broker.activateOverlaySelection();
      }
      return;
    }

    if (key.name === "tab") {
      broker.cycleFocus(key.shift ? -1 : 1);
      return;
    }

    if (key.name === "escape") {
      if (focusRegion !== "composer") {
        broker.focusRegion("composer");
      }
      return;
    }

    if ((key.meta || key.alt) && (key.name === "return" || key.name === "enter")) {
      void broker.queueComposer();
      return;
    }

    if (focusRegion === "workspaces") {
      if (key.name === "up" || key.name === "k") broker.moveWorkspace(-1);
      if (key.name === "down" || key.name === "j") broker.moveWorkspace(1);
      if (key.name === "n") broker.createWorkspace();
      if (key.name === "return" || key.name === "enter") broker.focusRegion("feed");
      return;
    }

    if (focusRegion === "feed") {
      if (key.name === "up" || key.name === "k") broker.moveFeedSelection(-1);
      if (key.name === "down" || key.name === "j") broker.moveFeedSelection(1);
      if (key.name === "end" || (key.shift && key.name === "g")) broker.selectLatestEntry();
      if (key.name === "return" || key.name === "enter") broker.openSelectedEntry();
      if (key.name === "space") broker.toggleSelectedEntryExpanded();
      if (key.name === "a") void broker.approveActiveApproval(true);
      if (key.name === "d") void broker.approveActiveApproval(false);
      return;
    }

    if (focusRegion === "inspector") {
      if (key.name === "return" || key.name === "enter") broker.focusRegion("feed");
    }
  });

  const feedVisibleRows = Math.max(8, height - (compactMode ? 16 : 10));

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
      <TopBar />
      <box style={{ flexGrow: 1, width: "100%", flexDirection: "row" }}>
        <WorkspaceRail focused={focusRegion === "workspaces"} quietHarbor={quietHarbor} />
        <box style={{ flexGrow: 1, height: "100%", flexDirection: "column" }}>
          <ApprovalActionBar />
          <Feed
            focused={focusRegion === "feed"}
            quietHarbor={quietHarbor}
            visibleRows={feedVisibleRows}
          />
          {overlay.kind !== "none" && <OverlayPanel broker={broker} />}
          {compactMode && focusRegion === "inspector" && (
            <Inspector focused overlay quietHarbor={quietHarbor} />
          )}
          <Composer
            broker={broker}
            focused={focusRegion === "composer"}
            quietHarbor={quietHarbor}
          />
          <box
            style={{
              width: "100%",
              height: 1,
              flexDirection: "row",
              paddingLeft: 1,
            }}
          >
            <text style={{ color: "#718096" }}>{statusLine}</text>
            <text style={{ color: "#a0aec0" }}>  {commandHint}</text>
            <text style={{ color: "#718096" }}>  {feedCount} feed items</text>
          </box>
        </box>
        {!compactMode && (
          <Inspector focused={focusRegion === "inspector"} quietHarbor={quietHarbor} />
        )}
      </box>
    </box>
  );
}
