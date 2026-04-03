import { basename, resolve } from "node:path";
import { FeedService } from "./FeedService.js";
import { PersistenceService } from "./PersistenceService.js";
import { SmithersService } from "./SmithersService.js";
import { appStore, resetAppStore } from "../client/state/store.js";
import {
  compactText,
  formatProviderTag,
  parseWorkflowMentions,
  summarizeNode,
} from "../shared/format.js";
import type {
  ApprovalSummary,
  FeedEntry,
  FocusRegion,
  OverlayState,
  PersistedAppSnapshot,
  RunId,
  RunNodeSummary,
  RunSummary,
  Workspace,
  WorkspaceId,
} from "../shared/types.js";

const FOCUS_ORDER: FocusRegion[] = [
  "workspaces",
  "feed",
  "inspector",
  "composer",
];

type BrokerOptions = {
  rootDir?: string;
  env?: Record<string, string | undefined>;
  pollIntervalMs?: number;
};

type PaletteCommand = {
  id: string;
  label: string;
  run: () => void | Promise<void>;
};

function nowMs() {
  return Date.now();
}

function workspaceIndex(workspaces: Workspace[], workspaceId: WorkspaceId | null) {
  return Math.max(
    0,
    workspaces.findIndex((workspace) => workspace.id === workspaceId),
  );
}

function cloneWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    pinnedContext: [...workspace.pinnedContext],
    linkedRuns: [...workspace.linkedRuns],
    queuedMessages: workspace.queuedMessages.map((message) => ({ ...message })),
    selection: { ...workspace.selection },
  };
}

function nextWorkspaceTitle(workspaces: Workspace[]) {
  return `workspace-${workspaces.length + 1}`;
}

function buildWorkspaceFromRun(rootDir: string, run: any): Workspace {
  const timestampMs = run.startedAtMs ?? run.createdAtMs ?? nowMs();
  return {
    id: `ws-${run.runId}`,
    title: run.workflowName ?? run.runId.slice(0, 8),
    cwd: rootDir,
    repoRoot: rootDir,
    mode: "operator",
    providerProfileId: "smithers",
    sessionId: `session-${run.runId}`,
    unreadCount: 0,
    attention: run.status === "failed" ? "failed" : run.status === "finished" ? "complete" : "running",
    pinnedContext: [],
    linkedRuns: [run.runId],
    queuedMessages: [],
    draft: "",
    latestNotification: `${run.workflowName ?? "workflow"} ${run.status}`,
    selection: {
      selectedFeedEntryId: null,
      follow: true,
    },
    createdAtMs: timestampMs,
    updatedAtMs: timestampMs,
  };
}

function mapRunSummary(run: any, nodes: any[], approvalPending: boolean): RunSummary {
  const completedSteps = nodes.filter((node) => node.state === "finished").length;
  const currentNode =
    nodes.find((node) => node.state === "in-progress") ??
    nodes.find((node) => node.state === "waiting-approval") ??
    nodes[nodes.length - 1];

  return {
    runId: run.runId,
    workflowId: run.workflowPath ?? run.workflowName ?? run.runId,
    workflowName: run.workflowName ?? basename(run.workflowPath ?? run.runId),
    workflowPath: run.workflowPath ?? null,
    status: run.status,
    startedAtMs: run.startedAtMs ?? run.createdAtMs ?? undefined,
    finishedAtMs: run.finishedAtMs ?? undefined,
    currentNodeId: currentNode?.nodeId ?? null,
    currentNodeLabel: currentNode?.label ?? null,
    completedSteps,
    totalSteps: nodes.length,
    approvalPending,
    providerProfileId: "smithers",
    errorMessage: run.errorJson
      ? (() => {
          try {
            const parsed = JSON.parse(run.errorJson);
            return parsed?.message ?? parsed?.error ?? String(parsed);
          } catch {
            return String(run.errorJson);
          }
        })()
      : null,
  };
}

function mapRunNodes(nodes: any[]): RunNodeSummary[] {
  return nodes
    .map((node) => ({
      nodeId: node.nodeId,
      label: node.label ?? null,
      iteration: node.iteration ?? 0,
      state: node.state,
      lastAttempt: node.lastAttempt ?? null,
      outputTable: node.outputTable ?? null,
      updatedAtMs: node.updatedAtMs ?? undefined,
    }))
    .sort((left, right) => {
      if (left.iteration !== right.iteration) return left.iteration - right.iteration;
      return left.nodeId.localeCompare(right.nodeId);
    });
}

function mapApproval(row: any): ApprovalSummary {
  return {
    runId: row.runId,
    nodeId: row.nodeId,
    iteration: row.iteration ?? 0,
    requestedAtMs: row.requestedAtMs ?? null,
    note: row.note ?? null,
    decidedBy: row.decidedBy ?? null,
  };
}

function attentionForWorkspace(
  workspace: Workspace,
  runSummaries: Record<RunId, RunSummary>,
  approvals: ApprovalSummary[],
): Workspace["attention"] {
  if (approvals.length > 0) return "approval";
  const runs = workspace.linkedRuns
    .map((runId) => runSummaries[runId])
    .filter((item): item is RunSummary => Boolean(item));
  if (runs.some((run) => run.status === "failed")) return "failed";
  if (runs.some((run) => run.status === "running" || run.status === "waiting-approval")) {
    return "running";
  }
  if (runs.some((run) => run.status === "finished")) return "complete";
  return "none";
}

function latestEntryForWorkspace(workspaceId: WorkspaceId, feed: FeedEntry[]) {
  const entries = feed.filter((entry) => entry.workspaceId === workspaceId);
  return entries[entries.length - 1] ?? null;
}

export class SmithersBroker {
  private readonly rootDir: string;
  private readonly feedService = new FeedService();
  private readonly persistence: PersistenceService;
  private readonly smithers: SmithersService;
  private readonly eventCursors = new Map<RunId, number>();
  private syncInterval: Timer | null = null;
  private persistTimer: Timer | null = null;
  private running = false;

  constructor(options: BrokerOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? process.cwd());
    this.persistence = new PersistenceService(this.rootDir);
    this.smithers = new SmithersService(this.rootDir, options.env);
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
  }

  private readonly pollIntervalMs: number;

  async start() {
    if (this.running) return;
    this.running = true;
    resetAppStore(this.rootDir);
    this.restoreSnapshot();
    this.updateStatus();
    await this.syncNow();
    this.syncInterval = setInterval(() => {
      void this.syncNow();
    }, this.pollIntervalMs);
  }

  stop() {
    this.running = false;
    if (this.syncInterval) clearInterval(this.syncInterval);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistSnapshot();
    this.smithers.close();
    this.persistence.close();
  }

  setTerminalDimensions(width: number, height: number) {
    appStore.setCompactMode(width < 100, width < 80 || height < 26);
  }

  cycleFocus(delta: number) {
    const state = appStore.getState();
    if (state.overlay.kind !== "none") return;
    const index = FOCUS_ORDER.indexOf(state.focusRegion);
    const nextIndex = (index + delta + FOCUS_ORDER.length) % FOCUS_ORDER.length;
    appStore.setFocusRegion(FOCUS_ORDER[nextIndex]!);
    this.updateStatus();
    this.schedulePersist();
  }

  focusRegion(region: FocusRegion) {
    appStore.setFocusRegion(region);
    this.updateStatus();
    this.schedulePersist();
  }

  moveWorkspace(delta: number) {
    const state = appStore.getState();
    if (state.overlay.kind !== "none" || state.workspaces.length === 0) return;
    const currentIndex = workspaceIndex(state.workspaces, state.activeWorkspaceId);
    const nextIndex = Math.max(0, Math.min(state.workspaces.length - 1, currentIndex + delta));
    const workspace = state.workspaces[nextIndex];
    if (!workspace) return;
    appStore.setActiveWorkspace(workspace.id);
    appStore.setState({
      selectedFeedEntryId: workspace.selection.selectedFeedEntryId,
      activeRunId: workspace.linkedRuns[0] ?? null,
    });
    this.updateStatus();
    this.schedulePersist();
  }

  moveFeedSelection(delta: number) {
    const state = appStore.getState();
    if (state.overlay.kind !== "none" || !state.activeWorkspaceId) return;
    const entries = state.feed.filter((entry) => entry.workspaceId === state.activeWorkspaceId);
    if (entries.length === 0) return;
    const currentIndex = Math.max(
      0,
      entries.findIndex((entry) => entry.id === state.selectedFeedEntryId),
    );
    const index = state.selectedFeedEntryId ? currentIndex : entries.length - 1;
    const nextIndex = Math.max(0, Math.min(entries.length - 1, index + delta));
    const nextEntry = entries[nextIndex]!;
    appStore.selectFeedEntry(nextEntry.id, nextIndex === entries.length - 1);
    appStore.setState({
      activeRunId: nextEntry.relatedRunId ?? state.activeRunId,
    });
    this.updateStatus();
    this.schedulePersist();
  }

  selectLatestEntry() {
    const state = appStore.getState();
    if (!state.activeWorkspaceId) return;
    const latest = latestEntryForWorkspace(state.activeWorkspaceId, state.feed);
    appStore.selectFeedEntry(latest?.id ?? null, true);
    appStore.setState({ activeRunId: latest?.relatedRunId ?? state.activeRunId });
    this.updateStatus();
    this.schedulePersist();
  }

  openPalette() {
    appStore.setOverlay({
      kind: "palette",
      selectedIndex: 0,
      query: "",
    });
    this.updateStatus();
  }

  openWorkflowPicker(query = "") {
    appStore.setOverlay({
      kind: "workflow-picker",
      selectedIndex: 0,
      query,
    });
    this.updateStatus();
  }

  openApprovalDialog() {
    const approval = this.activeApproval();
    if (!approval) return;
    appStore.setOverlay({
      kind: "approval-dialog",
      approval,
      selectedIndex: 0,
    });
    this.updateStatus();
  }

  closeOverlay() {
    appStore.setOverlay({ kind: "none" });
    this.updateStatus();
  }

  moveOverlaySelection(delta: number) {
    const state = appStore.getState();
    if (state.overlay.kind === "none") return;
    const items =
      state.overlay.kind === "workflow-picker"
        ? this.filteredWorkflows(state.overlay.query ?? "")
        : this.paletteCommands();
    const nextIndex = Math.max(
      0,
      Math.min(items.length - 1, (state.overlay.selectedIndex ?? 0) + delta),
    );
    appStore.setOverlay({
      ...state.overlay,
      selectedIndex: nextIndex,
    });
    this.updateStatus();
  }

  async activateOverlaySelection() {
    const state = appStore.getState();
    if (state.overlay.kind === "palette") {
      const command = this.paletteCommands()[state.overlay.selectedIndex ?? 0];
      this.closeOverlay();
      await command?.run();
      return;
    }
    if (state.overlay.kind === "workflow-picker") {
      const workflow = this.filteredWorkflows(state.overlay.query ?? "")[
        state.overlay.selectedIndex ?? 0
      ];
      if (workflow) {
        this.insertWorkflowMention(workflow.id);
      }
      return;
    }
    if (state.overlay.kind === "approval-dialog") {
      await this.approveActiveApproval(true);
    }
  }

  insertWorkflowMention(workflowId: string) {
    const state = appStore.getState();
    const workspace = this.activeWorkspace();
    if (!workspace) return;
    const draft = workspace.draft;
    const nextDraft = /(?:^|\s)#[a-z0-9-]*$/.test(draft)
      ? draft.replace(/#[a-z0-9-]*$/, `#${workflowId} `)
      : `${draft}${draft.endsWith(" ") || draft.length === 0 ? "" : " "}#${workflowId} `;
    appStore.patchWorkspace(workspace.id, { draft: nextDraft, updatedAtMs: nowMs() });
    this.closeOverlay();
    appStore.setFocusRegion("composer");
    this.updateStatus();
    this.schedulePersist();
  }

  createWorkspace() {
    const state = appStore.getState();
    const workspace: Workspace = {
      id: `ws-${nowMs()}`,
      title: nextWorkspaceTitle(state.workspaces),
      cwd: this.rootDir,
      repoRoot: this.rootDir,
      mode: "operator",
      providerProfileId: "smithers",
      sessionId: `session-${nowMs()}`,
      unreadCount: 0,
      attention: "none",
      pinnedContext: [],
      linkedRuns: [],
      queuedMessages: [],
      draft: "",
      latestNotification: "Fresh workspace",
      selection: {
        selectedFeedEntryId: null,
        follow: true,
      },
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
    };
    appStore.upsertWorkspaces([workspace]);
    appStore.setActiveWorkspace(workspace.id);
    appStore.setState({ selectedFeedEntryId: null, activeRunId: null });
    this.updateStatus();
    this.schedulePersist();
  }

  updateDraft(draft: string) {
    const workspace = this.activeWorkspace();
    if (!workspace) return;
    appStore.patchWorkspace(workspace.id, {
      draft,
      updatedAtMs: nowMs(),
    });

    const hashMatch = draft.match(/(?:^|\s)#([a-z0-9-]*)$/);
    if (hashMatch) {
      this.openWorkflowPicker(hashMatch[1] ?? "");
    } else if (appStore.getState().overlay.kind === "workflow-picker") {
      this.closeOverlay();
    }
    this.schedulePersist();
  }

  async queueComposer() {
    const workspace = this.activeWorkspace();
    if (!workspace || workspace.draft.trim().length === 0) return;
    appStore.patchWorkspace(workspace.id, {
      draft: "",
      queuedMessages: [
        ...workspace.queuedMessages,
        {
          id: `queued-${nowMs()}`,
          prompt: workspace.draft.trim(),
          queuedAtMs: nowMs(),
        },
      ],
      updatedAtMs: nowMs(),
    });
    this.updateStatus();
    this.schedulePersist();
  }

  async sendComposer() {
    const state = appStore.getState();
    if (state.overlay.kind !== "none") {
      await this.activateOverlaySelection();
      return;
    }

    const workspace = this.activeWorkspace();
    if (!workspace) return;
    const draft = workspace.draft.trim();

    if (!draft) {
      const approval = this.activeApproval();
      if (approval) {
        this.openApprovalDialog();
      }
      return;
    }

    const userEntry = this.feedService.createUserEntry(workspace.id, draft);
    appStore.appendFeedEntries([userEntry]);
    appStore.patchWorkspace(workspace.id, {
      draft: "",
      updatedAtMs: nowMs(),
      latestNotification: compactText(draft),
    });
    this.updateStatus();
    this.schedulePersist();

    const workflowMentions = parseWorkflowMentions(draft);
    const workflow = workflowMentions
      .map((id) => state.workflows.find((item) => item.id === id))
      .find((item): item is NonNullable<typeof item> => Boolean(item));

    if (workflow) {
      const prompt = compactText(
        draft.replace(new RegExp(`#${workflow.id}\\b`, "g"), "").trim(),
      );
      const assistantEntry = this.feedService.createAssistantEntry(
        workspace.id,
        `Launching #${workflow.id}...`,
      );
      appStore.appendFeedEntries([assistantEntry]);
      try {
        const result = await this.smithers.launchWorkflow(workflow, prompt || null);
        const currentWorkspace = this.workspaceById(workspace.id) ?? workspace;
        appStore.patchWorkspace(workspace.id, {
          linkedRuns: currentWorkspace.linkedRuns.includes(result.runId)
            ? currentWorkspace.linkedRuns
            : [...currentWorkspace.linkedRuns, result.runId],
          latestNotification: `Launched ${workflow.id} ${result.runId.slice(0, 8)}`,
          updatedAtMs: nowMs(),
        });
        appStore.updateFeedEntry(assistantEntry.id, {
          summary: `Launched #${workflow.id} as ${result.runId.slice(0, 8)}`,
          status: "done",
          relatedRunId: result.runId,
          relatedWorkflowId: workflow.id,
        });
      } catch (error) {
        appStore.updateFeedEntry(assistantEntry.id, {
          summary: error instanceof Error ? error.message : String(error),
          status: "failed",
          type: "error",
          source: "Error",
        });
      }
      this.schedulePersist();
      return;
    }

    const usableAgents = this.smithers.availableAgents();
    if (usableAgents.length === 0) {
      appStore.appendFeedEntries([
        {
          id: `warning-${workspace.id}-${nowMs()}`,
          workspaceId: workspace.id,
          type: "warning",
          timestampMs: nowMs(),
          source: "Smithers",
          summary: "No usable agent CLI detected. Use # to launch a Smithers workflow.",
          expanded: false,
          metadata: {},
        },
      ]);
      return;
    }

    const assistantEntry = this.feedService.createAssistantEntry(workspace.id, "");
    appStore.appendFeedEntries([assistantEntry]);
    const proc = await this.smithers.startAssistantTurn(draft);
    void this.streamAssistantOutput(workspace.id, assistantEntry.id, proc);
  }

  async approveActiveApproval(approved: boolean) {
    const approval =
      appStore.getState().overlay.approval ?? this.activeApproval();
    if (!approval) return;
    this.closeOverlay();
    try {
      if (approved) {
        await this.smithers.approve(approval);
      } else {
        await this.smithers.deny(approval);
      }
      await this.syncNow();
    } catch (error) {
      appStore.setLastError(error instanceof Error ? error.message : String(error));
    }
  }

  openSelectedEntry() {
    const state = appStore.getState();
    const entry = state.feed.find((item) => item.id === state.selectedFeedEntryId);
    if (!entry) return;
    if (entry.type === "approval") {
      this.openApprovalDialog();
      return;
    }
    appStore.setState({ activeRunId: entry.relatedRunId ?? state.activeRunId });
    this.focusRegion("inspector");
  }

  toggleSelectedEntryExpanded() {
    const entryId = appStore.getState().selectedFeedEntryId;
    if (!entryId) return;
    const entry = appStore.getState().feed.find((item) => item.id === entryId);
    if (!entry) return;
    appStore.updateFeedEntry(entryId, { expanded: !entry.expanded });
  }

  jumpToLatestApproval() {
    const state = appStore.getState();
    const workspace = state.workspaces.find(
      (candidate) => (state.approvals[candidate.id] ?? []).length > 0,
    );
    if (!workspace) return;
    appStore.setActiveWorkspace(workspace.id);
    const latestApproval = [...state.feed]
      .reverse()
      .find((entry) => entry.workspaceId === workspace.id && entry.type === "approval");
    appStore.selectFeedEntry(latestApproval?.id ?? workspace.selection.selectedFeedEntryId, false);
    appStore.setState({ activeRunId: latestApproval?.relatedRunId ?? workspace.linkedRuns[0] ?? null });
    this.updateStatus();
  }

  async syncNow() {
    try {
      const workflows = this.smithers.discoverWorkflows();
      appStore.setWorkflows(
        workflows.map((workflow) => ({
          id: workflow.id,
          displayName: workflow.displayName,
          entryFile: workflow.entryFile,
          sourceType: workflow.sourceType,
        })),
      );

      const runs = await this.smithers.listRuns(100);
      const state = appStore.getState();
      const workspaces = state.workspaces.map(cloneWorkspace);
      const workspaceMap = new Map<RunId, WorkspaceId>();
      for (const workspace of workspaces) {
        for (const runId of workspace.linkedRuns) {
          workspaceMap.set(runId, workspace.id);
        }
      }

      const newWorkspaces: Workspace[] = [];
      const runSummaries: Record<RunId, RunSummary> = {};
      const runNodes: Record<RunId, RunNodeSummary[]> = {};
      const approvalsByWorkspace: Record<WorkspaceId, ApprovalSummary[]> = {};
      const newEntries: FeedEntry[] = [];

      for (const run of runs as any[]) {
        let workspaceId = workspaceMap.get(run.runId);
        if (!workspaceId) {
          const workspace = buildWorkspaceFromRun(this.rootDir, run);
          newWorkspaces.push(workspace);
          workspaceId = workspace.id;
          workspaceMap.set(run.runId, workspaceId);
        }

        const nodes = await this.smithers.listNodes(run.runId);
        const approvals = await this.smithers.listPendingApprovals(run.runId);
        runNodes[run.runId] = mapRunNodes(nodes as any[]);
        runSummaries[run.runId] = mapRunSummary(run, nodes as any[], approvals.length > 0);
        approvalsByWorkspace[workspaceId] = [
          ...(approvalsByWorkspace[workspaceId] ?? []),
          ...(approvals as any[]).map(mapApproval),
        ];

        const cursor = this.eventCursors.get(run.runId) ?? -1;
        const events = await this.smithers.listEvents(run.runId, cursor, 200);
        if (events.length > 0) {
          const lastSeq = (events as any[])[events.length - 1]?.seq;
          if (typeof lastSeq === "number") {
            this.eventCursors.set(run.runId, lastSeq);
          }
          newEntries.push(
            ...this.feedService.eventRowsToEntries(
              workspaceId,
              runSummaries[run.runId],
              events as any[],
            ),
          );
        }

        const hasRunSummaryEntry = state.feed.some(
          (entry) => entry.id === `run-summary-${run.runId}`,
        );
        if (!hasRunSummaryEntry) {
          newEntries.push(
            this.feedService.summarizeRunEntry(workspaceId, runSummaries[run.runId]),
          );
        }
      }

      if (newWorkspaces.length > 0) {
        appStore.upsertWorkspaces(newWorkspaces);
      }

      const nextState = appStore.getState();
      const entriesByWorkspace = new Map<WorkspaceId, FeedEntry[]>();
      for (const entry of newEntries) {
        const list = entriesByWorkspace.get(entry.workspaceId) ?? [];
        list.push(entry);
        entriesByWorkspace.set(entry.workspaceId, list);
      }

      appStore.setRuns(runSummaries);
      appStore.setRunNodes(runNodes);
      appStore.setApprovals(approvalsByWorkspace);
      if (newEntries.length > 0) {
        appStore.appendFeedEntries(newEntries);
      }

      const refreshedState = appStore.getState();
      const activeWorkspaceId = refreshedState.activeWorkspaceId ?? refreshedState.workspaces[0]?.id ?? null;
      const activeWorkspace = activeWorkspaceId
        ? refreshedState.workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
        : null;
      const activeLatestEntry = activeWorkspaceId
        ? latestEntryForWorkspace(activeWorkspaceId, refreshedState.feed)
        : null;

      appStore.setState((currentState) => {
        const updatedWorkspaces = currentState.workspaces.map((workspace) => {
          const newCount = entriesByWorkspace.get(workspace.id)?.length ?? 0;
          const approvals = approvalsByWorkspace[workspace.id] ?? [];
          const attention = attentionForWorkspace(workspace, runSummaries, approvals);
          const latestEntry = latestEntryForWorkspace(workspace.id, currentState.feed);
          const isActive = workspace.id === activeWorkspaceId;
          return {
            ...workspace,
            unreadCount: isActive ? 0 : workspace.unreadCount + newCount,
            attention,
            latestNotification: latestEntry?.summary ?? workspace.latestNotification,
            selection:
              isActive && workspace.selection.follow && latestEntry
                ? {
                    selectedFeedEntryId: latestEntry.id,
                    follow: true,
                  }
                : workspace.selection,
            updatedAtMs: nowMs(),
          };
        });

        return {
          workspaces: updatedWorkspaces,
          selectedFeedEntryId:
            activeWorkspace?.selection.follow && activeLatestEntry
              ? activeLatestEntry.id
              : currentState.selectedFeedEntryId ??
                activeWorkspace?.selection.selectedFeedEntryId ??
                activeLatestEntry?.id ??
                null,
          activeRunId:
            activeLatestEntry?.relatedRunId ??
            activeWorkspace?.linkedRuns[0] ??
            currentState.activeRunId,
        };
      });
      this.updateStatus();
      this.schedulePersist();
    } catch (error) {
      appStore.setLastError(error instanceof Error ? error.message : String(error));
    }
  }

  private workspaceById(workspaceId: WorkspaceId) {
    return appStore.getState().workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  }

  private activeWorkspace() {
    const state = appStore.getState();
    return this.workspaceById(state.activeWorkspaceId ?? "ws-default");
  }

  private activeApproval() {
    const state = appStore.getState();
    if (!state.activeWorkspaceId) return null;
    return (state.approvals[state.activeWorkspaceId] ?? [])[0] ?? null;
  }

  private filteredWorkflows(query: string) {
    const normalized = query.toLowerCase();
    const workflows = appStore.getState().workflows;
    if (!normalized) return workflows;
    return workflows.filter((workflow) =>
      workflow.id.includes(normalized) ||
      workflow.displayName.toLowerCase().includes(normalized),
    );
  }

  private paletteCommands(): PaletteCommand[] {
    return [
      {
        id: "run-workflow",
        label: "Run workflow",
        run: () => this.openWorkflowPicker(""),
      },
      {
        id: "new-workspace",
        label: "New workspace",
        run: () => this.createWorkspace(),
      },
      {
        id: "jump-approval",
        label: "Jump to latest approval",
        run: () => this.jumpToLatestApproval(),
      },
      {
        id: "focus-feed",
        label: "Focus feed",
        run: () => this.focusRegion("feed"),
      },
      {
        id: "focus-composer",
        label: "Focus composer",
        run: () => this.focusRegion("composer"),
      },
    ];
  }

  private restoreSnapshot() {
    const snapshot = this.persistence.loadSnapshot();
    if (!snapshot?.workspaces?.length) return;
    appStore.replaceState({
      ...appStore.getState(),
      workspaces: snapshot.workspaces.map(cloneWorkspace),
      activeWorkspaceId: snapshot.activeWorkspaceId,
      activeRunId: snapshot.activeRunId,
      focusRegion: snapshot.focusRegion,
    });
  }

  private persistSnapshot() {
    const state = appStore.getState();
    const snapshot: PersistedAppSnapshot = {
      version: 1,
      activeWorkspaceId: state.activeWorkspaceId,
      activeRunId: state.activeRunId,
      focusRegion: state.focusRegion,
      workspaces: state.workspaces.map(cloneWorkspace),
    };
    this.persistence.saveSnapshot(snapshot);
  }

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistSnapshot();
      this.persistTimer = null;
    }, 120);
  }

  private updateStatus() {
    const state = appStore.getState();
    if (state.overlay.kind === "palette") {
      appStore.setStatus("Up/Down select  Enter run  Esc close", "Command palette");
      return;
    }
    if (state.overlay.kind === "workflow-picker") {
      appStore.setStatus("Up/Down select  Enter insert  Esc close", "Workflow picker");
      return;
    }
    if (state.overlay.kind === "approval-dialog") {
      appStore.setStatus("A approve  D deny  Esc cancel", "Approval required");
      return;
    }

    switch (state.focusRegion) {
      case "workspaces":
        appStore.setStatus("Up/Down switch  n new  Enter focus feed", "Workspace rail focused");
        break;
      case "feed":
        appStore.setStatus("Up/Down move  End live  Enter inspect  Space expand", "Feed focused");
        break;
      case "inspector":
        appStore.setStatus("Tab cycle focus  Enter inspect  Esc composer", "Inspector focused");
        break;
      case "composer":
      default:
        appStore.setStatus(
          "Enter send  Ctrl+J newline  # workflow  Ctrl+O actions",
          "Composer focused",
        );
        break;
    }
  }

  private async streamAssistantOutput(
    workspaceId: WorkspaceId,
    entryId: string,
    proc: Bun.Subprocess,
  ) {
    const appendChunk = (chunk: string) => {
      const entry = appStore.getState().feed.find((item) => item.id === entryId);
      if (!entry) return;
      appStore.updateFeedEntry(entryId, {
        summary: entry.summary + chunk,
      });
    };

    const consume = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        appendChunk(decoder.decode(value, { stream: true }));
      }
    };

    await Promise.allSettled([consume(proc.stdout), consume(proc.stderr)]);
    const entry = appStore.getState().feed.find((item) => item.id === entryId);
    appStore.updateFeedEntry(entryId, {
      summary: compactText(entry?.summary ?? ""),
      status: proc.exitCode === 0 ? "done" : "failed",
      type: proc.exitCode === 0 ? "assistant" : "error",
      source: proc.exitCode === 0 ? "Smithers" : "Error",
    });
    appStore.patchWorkspace(workspaceId, {
      latestNotification:
        proc.exitCode === 0
          ? "Assistant turn completed"
          : "Assistant turn failed",
      updatedAtMs: nowMs(),
    });
    this.schedulePersist();
  }
}
