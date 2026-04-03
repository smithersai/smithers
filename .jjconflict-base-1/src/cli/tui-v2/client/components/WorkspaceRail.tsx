import React from "react";
import { formatProviderTag, formatWorkspaceMarker } from "../../shared/format.js";
import { useAppStore } from "../state/store.js";

type WorkspaceRailProps = {
  focused: boolean;
  quietHarbor: boolean;
};

export function WorkspaceRail({ focused, quietHarbor }: WorkspaceRailProps) {
  const workspaces = useAppStore((state) => state.workspaces);
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);

  return (
    <box
      style={{
        width: quietHarbor ? 20 : 24,
        height: "100%",
        flexDirection: "column",
        borderRight: !quietHarbor,
        borderColor: focused ? "#63b3ed" : "#4a5568",
        paddingTop: 1,
      }}
    >
      {workspaces.map((workspace) => {
        const isActive = workspace.id === activeWorkspaceId;
        return (
          <box
            key={workspace.id}
            style={{
              width: "100%",
              height: 2,
              flexDirection: "column",
              backgroundColor: isActive ? "#1f2937" : undefined,
            }}
          >
            <text style={{ color: isActive ? "#63b3ed" : "#cbd5e0" }}>
              {isActive ? "▌ " : "  "}
              {workspace.title.slice(0, quietHarbor ? 14 : 16).padEnd(
                quietHarbor ? 14 : 16,
                " ",
              )}
              {" "}
              {formatProviderTag(workspace.providerProfileId)}
              {" "}
              {formatWorkspaceMarker(workspace)}
              {workspace.unreadCount > 0 ? String(workspace.unreadCount) : " "}
            </text>
            {!quietHarbor && (
              <text style={{ color: "#718096" }}>
                {workspace.latestNotification?.slice(0, 22) ?? workspace.cwd.slice(0, 22)}
              </text>
            )}
          </box>
        );
      })}
    </box>
  );
}
