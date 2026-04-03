import { useSyncExternalStore } from "react";
import type {
  AppState,
  ApprovalSummary,
  FeedEntry,
  FeedEntryId,
  FocusRegion,
  OverlayState,
  RunId,
  RunNodeSummary,
  RunSummary,
  Workspace,
  WorkspaceId,
} from "../../shared/types.js";

const listeners = new Set<() => void>();

function nowMs() {
  return Date.now();
}

function createDefaultWorkspace(cwd = process.cwd()): Workspace {
  return {
    id: "ws-default",
    title: "control-plane",
    cwd,
    repoRoot: cwd,
    mode: "operator",
    providerProfileId: "smithers",
    sessionId: "session-default",
    unreadCount: 0,
    attention: "none",
    pinnedContext: [],
    linkedRuns: [],
    queuedMessages: [],
    draft: "",
    latestNotification: "Pick a workflow with # or ask Smithers what to run.",
    selection: {
      selectedFeedEntryId: null,
      follow: true,
    },
    createdAtMs: nowMs(),
    updatedAtMs: nowMs(),
  };
}

let state: AppState = {
  workspaces: [createDefaultWorkspace()],
  activeWorkspaceId: "ws-default",
  activeRunId: null,
  feed: [],
  runSummaries: {},
  runNodes: {},
  approvals: {},
  workflows: [],
  selectedFeedEntryId: null,
  focusRegion: "composer",
  overlay: { kind: "none" },
  commandHint: "Enter send  Ctrl+J newline  Ctrl+O actions",
  statusLine: "Composer focused",
  compactMode: false,
  quietHarbor: false,
  lastError: null,
};

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function cloneWorkspaces(workspaces: Workspace[]) {
  return workspaces.map((workspace) => ({
    ...workspace,
    pinnedContext: [...workspace.pinnedContext],
    linkedRuns: [...workspace.linkedRuns],
    queuedMessages: workspace.queuedMessages.map((message) => ({ ...message })),
    selection: { ...workspace.selection },
  }));
}

export const appStore = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  replaceState(nextState: AppState) {
    state = nextState;
    emitChange();
  },
  setState(
    updater:
      | Partial<AppState>
      | ((currentState: AppState) => Partial<AppState> | AppState),
  ) {
    const nextValue =
      typeof updater === "function" ? updater(state) : updater;
    state =
      "workspaces" in nextValue &&
      "feed" in nextValue &&
      "runSummaries" in nextValue &&
      "runNodes" in nextValue &&
      "approvals" in nextValue &&
      "workflows" in nextValue &&
      "focusRegion" in nextValue &&
      "overlay" in nextValue
        ? (nextValue as AppState)
        : { ...state, ...nextValue };
    emitChange();
  },
  upsertWorkspaces(workspaces: Workspace[]) {
    const existing = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]));
    const merged = cloneWorkspaces(state.workspaces);
    for (const workspace of workspaces) {
      const match = existing.get(workspace.id);
      if (!match) {
        merged.push(workspace);
        continue;
      }
      const index = merged.findIndex((item) => item.id === workspace.id);
      if (index >= 0) {
        merged[index] = workspace;
      }
    }
    state = { ...state, workspaces: merged };
    emitChange();
  },
  setActiveWorkspace(workspaceId: WorkspaceId) {
    state = {
      ...state,
      activeWorkspaceId: workspaceId,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              unreadCount: 0,
              selection: {
                ...workspace.selection,
                follow:
                  workspace.selection.selectedFeedEntryId === null
                    ? true
                    : workspace.selection.follow,
              },
            }
          : workspace,
      ),
    };
    emitChange();
  },
  patchWorkspace(workspaceId: WorkspaceId, patch: Partial<Workspace>) {
    state = {
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              ...patch,
              selection: patch.selection
                ? { ...workspace.selection, ...patch.selection }
                : workspace.selection,
            }
          : workspace,
      ),
    };
    emitChange();
  },
  setFeed(feed: FeedEntry[]) {
    state = { ...state, feed };
    emitChange();
  },
  appendFeedEntries(entries: FeedEntry[]) {
    const seen = new Set(state.feed.map((entry) => entry.id));
    const merged = [...state.feed];
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      merged.push(entry);
      seen.add(entry.id);
    }
    merged.sort((left, right) => {
      if (left.timestampMs !== right.timestampMs) {
        return left.timestampMs - right.timestampMs;
      }
      return left.id.localeCompare(right.id);
    });
    state = { ...state, feed: merged };
    emitChange();
  },
  updateFeedEntry(entryId: FeedEntryId, patch: Partial<FeedEntry>) {
    state = {
      ...state,
      feed: state.feed.map((entry) =>
        entry.id === entryId ? { ...entry, ...patch } : entry,
      ),
    };
    emitChange();
  },
  selectFeedEntry(entryId: FeedEntryId | null, follow = false) {
    const workspaceId = state.activeWorkspaceId;
    state = {
      ...state,
      selectedFeedEntryId: entryId,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              selection: {
                selectedFeedEntryId: entryId,
                follow,
              },
            }
          : workspace,
      ),
    };
    emitChange();
  },
  setFocusRegion(focusRegion: FocusRegion) {
    state = { ...state, focusRegion };
    emitChange();
  },
  setOverlay(overlay: OverlayState) {
    state = { ...state, overlay };
    emitChange();
  },
  setRuns(runSummaries: Record<RunId, RunSummary>) {
    state = { ...state, runSummaries };
    emitChange();
  },
  setRunNodes(runNodes: Record<RunId, RunNodeSummary[]>) {
    state = { ...state, runNodes };
    emitChange();
  },
  setApprovals(approvals: Record<WorkspaceId, ApprovalSummary[]>) {
    state = { ...state, approvals };
    emitChange();
  },
  setWorkflows(
    workflows: AppState["workflows"],
  ) {
    state = { ...state, workflows };
    emitChange();
  },
  setCompactMode(compactMode: boolean, quietHarbor: boolean) {
    state = { ...state, compactMode, quietHarbor };
    emitChange();
  },
  setStatus(commandHint: string, statusLine: string) {
    state = { ...state, commandHint, statusLine };
    emitChange();
  },
  setLastError(lastError: string | null) {
    state = { ...state, lastError };
    emitChange();
  },
};

export function resetAppStore(cwd = process.cwd()) {
  state = {
    workspaces: [createDefaultWorkspace(cwd)],
    activeWorkspaceId: "ws-default",
    activeRunId: null,
    feed: [],
    runSummaries: {},
    runNodes: {},
    approvals: {},
    workflows: [],
    selectedFeedEntryId: null,
    focusRegion: "composer",
    overlay: { kind: "none" },
    commandHint: "Enter send  Ctrl+J newline  Ctrl+O actions",
    statusLine: "Composer focused",
    compactMode: false,
    quietHarbor: false,
    lastError: null,
  };
  emitChange();
}

export function useAppStore<T>(selector: (currentState: AppState) => T): T {
  return useSyncExternalStore(appStore.subscribe, () => selector(appStore.getState()));
}
