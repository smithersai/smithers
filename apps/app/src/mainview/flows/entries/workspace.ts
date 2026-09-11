/*
 * The `workspace` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { fileArgs } from "../FileArgs"
import { flag, line, text } from "../FlowForms"
import { flow, NoPayload, RepoTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `workspace` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "workspace", label: "Boxes", summary: "Open and drive the box for a branch: stream, snapshot, and inspect it (ADR 0002)" }

/** The `workspace.*` flows: the boxes (the design session says box, never computer). */
export const workspaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * Lane citc (ADR 0002): the persistent cloud computers. `workspace.open`
   * creates-or-reuses one on a bookmark and renders its card (the transcript
   * is the review surface); the acts ride the one seam; a bare act resolves
   * the active workspace copy, else the single loaded one. Destructive acts
   * are id-scoped and hidden — the card's buttons invoke them.
   */
  flow({
    name: "workspace.list",
    summary: "List your cloud workspaces",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listWorkspaces(repo)
  }),
  flow({
    /* Launching a cloud computer is an outbound act: the capability always asks. */
    name: "workspace.open",
    form: {
      fields: { bookmark: { optionsFrom: "bookmarks", kind: "text" }, repo: { optionsFrom: "cloud-repos", kind: "text" } },
      args: (payload) => line(text(payload, "bookmark"), text(payload, "repo"), flag(payload, "kind"))
    },
    summary: "Open (create or reuse) a Linux workspace in Smithers Cloud on a bookmark: a real machine with a terminal, files, and services the user can use",
    runtime: ["cloud"],
    capabilities: ["outbound:launch"],
    /* ADR 0002: three sandbox kinds share one option surface, and the kind is the choice. */
    args: "[bookmark] [owner/repo] [--kind container|vm|desktop]",
    requires: ["signed-in"],
    input: Schema.Struct({
      bookmark: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.Literals(["container", "vm", "desktop"]))
    }),
    handler: ({ bookmark, repo, kind }) => actions.openWorkspace(bookmark, repo, kind)
  }),
  flow({
    name: "workspace.view",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Open one cloud workspace's card",
    runtime: ["cloud"],
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String }),
    handler: ({ workspaceId }) => actions.viewWorkspace(workspaceId)
  }),
  flow({
    name: "workspace.terminal",
    summary: "Open a terminal on a cloud workspace",
    /* The terminal rides this origin's `/api/cloud-ws/` tunnel: an origin without one registers no terminal. */
    runtime: ["cloud", "cloud.terminal"],
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.openWorkspaceTerminal(workspaceId)
  }),
  flow({
    name: "workspace.suspend",
    summary: "Suspend a cloud workspace",
    runtime: ["cloud"],
    confirm: "suspend the workspace",
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.suspendWorkspace(workspaceId)
  }),
  flow({
    name: "workspace.resume",
    summary: "Resume a cloud workspace",
    runtime: ["cloud"],
    confirm: "resume the workspace",
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.resumeWorkspace(workspaceId)
  }),
  flow({
    name: "workspace.fork",
    summary: "Fork a cloud workspace",
    runtime: ["cloud"],
    confirm: "fork the workspace",
    args: "[workspaceId] [name]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, name }) => actions.forkWorkspace(workspaceId, name)
  }),
  flow({
    name: "workspace.snapshot",
    summary: "Snapshot a cloud workspace",
    runtime: ["cloud"],
    confirm: "snapshot the workspace",
    args: "[workspaceId] [name]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, name }) => actions.snapshotWorkspace(workspaceId, name)
  }),
  flow({
    name: "workspace.snapshot.delete",
    summary: "Delete a workspace snapshot",
    runtime: ["cloud"],
    hidden: true,
    confirm: "delete the snapshot",
    args: "<snapshotId> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ snapshotId: Schema.String, workspaceId: Schema.optional(Schema.String) }),
    handler: ({ snapshotId, workspaceId }) => actions.deleteWorkspaceSnapshot(snapshotId, workspaceId)
  }),
  flow({
    /* The snapshot row's "Fork from": a new workspace whose image is the snapshot. */
    name: "workspace.snapshot.fork",
    summary: "Create a workspace from a snapshot",
    runtime: ["cloud"],
    hidden: true,
    capabilities: ["outbound:launch"],
    confirm: "create a workspace from the snapshot",
    args: "<snapshotId> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ snapshotId: Schema.String, workspaceId: Schema.optional(Schema.String) }),
    handler: ({ snapshotId, workspaceId }) => actions.forkWorkspaceFromSnapshot(snapshotId, workspaceId)
  }),
  flow({
    name: "workspace.template",
    form: {
      fields: { workspaceId: { optionsFrom: "workspaces" } },
      args: (payload) => line(text(payload, "snapshotId"), text(payload, "workspaceId"), flag(payload, "name"))
    },
    summary: "Create a workspace template from a snapshot",
    runtime: ["cloud"],
    args: "<snapshotId> <name> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({
      snapshotId: Schema.String,
      name: Schema.String,
      workspaceId: Schema.optional(Schema.String)
    }),
    handler: ({ snapshotId, name, workspaceId }) => actions.templateWorkspaceSnapshot(snapshotId, name, workspaceId)
  }),
  flow({
    name: "workspace.sessions",
    summary: "List a cloud workspace's sessions",
    runtime: ["cloud"],
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.listWorkspaceSessions(workspaceId)
  }),
  flow({
    name: "workspace.session.destroy",
    summary: "Destroy a workspace session",
    runtime: ["cloud"],
    hidden: true,
    confirm: "destroy the session",
    args: "<sessionId> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ sessionId: Schema.String, workspaceId: Schema.optional(Schema.String) }),
    handler: ({ sessionId, workspaceId }) => actions.destroyWorkspaceSession(sessionId, workspaceId)
  }),
  flow({
    name: "workspace.delete",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" }, confirmName: { label: "Name, typed back" } } },
    summary: "Delete a cloud workspace",
    runtime: ["cloud"],
    hidden: true,
    confirm: "delete the workspace",
    /* The workspace's name typed back is the flow's own input: the seam deletes only when it matches, whoever invoked. */
    args: "<workspaceId> <name>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String, confirmName: Schema.String }),
    handler: ({ workspaceId, confirmName }) => actions.deleteWorkspace(workspaceId, confirmName)
  }),
  flow({
    /* The card's body tab: showing a facet is how the agent answers "show me the files" too (agent-parity.md). */
    name: "workspace.facet",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Switch a workspace card's facet",
    runtime: ["cloud"],
    args: "<workspaceId> <facet>",
    requires: ["signed-in"],
    input: Schema.Struct({
      workspaceId: Schema.String,
      facet: Schema.Literals(["terminal", "files", "services", "snapshots", "egress", "desktop"])
    }),
    handler: ({ workspaceId, facet }) => actions.setWorkspaceFacet(workspaceId, facet)
  }),
  /*
   * Lane L3: the facets plue#449 and the egress audit answer. Files and the
   * file read are ordinary reads — the model asks about a computer's working
   * copy the same way a human clicks the facet. The egress audit is cursor
   * paginated: a bare call reads the newest page, a cursor reads the page
   * behind it and the card appends.
   */
  flow({
    name: "workspace.files",
    form: { args: (payload) => fileArgs(text(payload, "path") ?? "/", text(payload, "workspaceId")) },
    summary: "List a cloud workspace's files under a directory",
    runtime: ["cloud"],
    args: "[path] [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ path: Schema.optional(Schema.String), workspaceId: Schema.optional(Schema.String) }),
    handler: ({ path, workspaceId }) => actions.listWorkspaceFiles(path, workspaceId)
  }),
  flow({
    name: "workspace.file",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } }, args: (payload) => fileArgs(text(payload, "path"), text(payload, "workspaceId")) },
    summary: "Read one file out of a cloud workspace",
    runtime: ["cloud"],
    args: "<path> [workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ path: Schema.String, workspaceId: Schema.optional(Schema.String) }),
    handler: ({ path, workspaceId }) => actions.readWorkspaceFile(path, workspaceId)
  }),
  flow({
    name: "workspace.services",
    summary: "List a cloud workspace's services",
    runtime: ["cloud"],
    args: "[workspaceId]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String) }),
    handler: ({ workspaceId }) => actions.listWorkspaceServices(workspaceId)
  }),
  flow({
    name: "workspace.egress",
    summary: "List what a cloud workspace called out to, and which secret names were swapped in",
    runtime: ["cloud"],
    args: "[workspaceId] [cursor]",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.optional(Schema.String), cursor: Schema.optional(Schema.String) }),
    handler: ({ workspaceId, cursor }) => actions.listWorkspaceEgress(workspaceId, cursor)
  }),
  /*
   * Lane L3b: the desktop. `workspace.desktop` MINTS a session — an absolute,
   * already-credentialed stream URL carrying a live machine's VNC password —
   * so it carries `confirm`: the model may ask for it, the human performs it.
   * The credential never enters the store; the facet reads it out of module
   * memory (state/seams/DesktopStream.ts).
   */
  flow({
    name: "workspace.desktop",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Open the desktop of a cloud workspace and stream it into the card",
    runtime: ["cloud"],
    confirm: "open the workspace's desktop",
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String }),
    handler: ({ workspaceId }) => actions.openWorkspaceDesktop(workspaceId)
  }),
  flow({
    /* Rotating changes the VNC password in the guest: the old iframe disconnects. */
    name: "workspace.desktop.rotate",
    form: { fields: { workspaceId: { optionsFrom: "workspaces" } } },
    summary: "Rotate a workspace desktop session",
    runtime: ["cloud"],
    hidden: true,
    confirm: "rotate the desktop session",
    args: "<workspaceId>",
    requires: ["signed-in"],
    input: Schema.Struct({ workspaceId: Schema.String }),
    handler: ({ workspaceId }) => actions.rotateWorkspaceDesktop(workspaceId)
  }),
  flow({
    name: "workspace.images",
    summary: "List the environment images a repository has built for its workspaces",
    runtime: ["cloud"],
    args: "[owner/repo]",
    requires: ["signed-in"],
    input: RepoTarget,
    handler: ({ repo }) => actions.listEnvironmentImages(repo)
  })
]

/** The workspace rename, registered with the sidebar flows after `repo.tree`. */
export const workspaceRenameFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /* The workspace heading: its name, and the pencil that edits it inline. */
  flow({
    name: "workspace.rename",
    summary: "Name this workspace",
    args: "<name>",
    input: Schema.Struct({ name: Schema.String }),
    handler: ({ name }) => actions.renameWorkspace(name)
  }),
  flow({
    name: "workspace.rename.edit",
    summary: "Edit the workspace name in the sidebar",
    hidden: true,
    userOnly: true,
    userOnlyReason: "opening the inline editor is the human's gesture; the agent names the workspace with workspace.rename",
    input: NoPayload,
    handler: () => actions.toggleWorkspaceRename()
  })
]
