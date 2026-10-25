import { ChatPin, ChatUnpin } from "../features/pins/flows"
import { Context, Layer } from "effect"
import { Remember } from "../features/agent/memoryFlows"
import { Summarize } from "../features/timeline/flow"
import type { BrowserEngine } from "@smthrs/platform-browser"
import { BranchCreate, BranchTrack } from "../features/branch/flows"
import { ConversationArchive, ConversationNew } from "../features/conversations/flows"
import { BranchShare } from "../features/sharing/flows"
import { TerminalOpenRequest } from "../features/terminal/flows"
import {
  SandboxDiff,
  SandboxList,
  SandboxRead,
  SandboxRun,
  SandboxStatus,
  SandboxWrite,
} from "../features/sandbox/flows"
import { Close } from "../features/agent/close"
import { AuthRefresh } from "../features/auth/flows"
import { ChatCopy, ChatEdit } from "../features/chat/flows"
import { AnswerReference } from "../features/agent/reference"
import { CloseFile, OpenFile } from "../features/files/flows"
import { Navigate } from "../features/navigation/flows"
import { RepoAbout, RepoCloneRequest, RepoCopy, RepoRead, RepoRefs, RepoTree } from "../features/repo/flows"
import type { Role } from "../features/auth/contract"
import {
  FlowAnswerReference,
  FlowDeleteReference,
  FlowDraftDeleteReference,
  FlowDraftsReference,
  FlowListReference,
  FlowNewReference,
  FlowPromptReference,
  FlowReadReference,
  FlowRunReference,
  FlowSaveReference,
  FlowWriteReference,
} from "../features/flows-ui/reference"
import { IssueCommitment, IssueComment, IssueCreate, IssueTriage, TriageEnable, TriagePause, TriageRunAgain } from "../features/issues/flows"
import { Classify, Evaluate } from "../features/jev/flows"
import { Cancel, Inspect, List, Resume, Retry, Steer } from "../features/runs/flows"
import { AnswerRun, Ask, Deliver } from "../features/status/flows"
import { Ack, WatchSet } from "../features/attention/flows"
import { AlertChannelSet, SandboxLimitsSet } from "../features/spend/flows"
import { DomainAdd, DomainRemove } from "../features/domains/flows"
import { ModelRemove, ModelTest } from "../features/personal-model/flows"
import { SetTheme } from "../features/theme/flows"
import { TodoCommit, TodoDraft, TodoDrop, TodoInspect, TodoIssue, TodoRetry } from "../features/todos/flows"
import { AskWithForm, RenderView, SetViewState, ShowIssues, ShowRepo } from "../features/views/flows"
import { OpenWebPage } from "../features/web/flows"
import { SearchDocs } from "../features/docs/flows"

// The app's flows (docs/features/flows.md#the-registry): every action a person or the agent takes is one `Flow.make`
// declaration, listed here once. The UI dispatches only a name from this list (`FlowDispatch`), and the agent's catalog
// is this list's model-invocable flows. Anything a person can do, the agent can do: an entry the agent may not run says
// why (`userOnlyReason`), and src/flows/registry.test.ts enforces both. Every flow here runs on this device's engine. A
// flow that needs something the device lacks runs remotely, and the route that admits it starts it
// (docs/features/remote-flows.md); no route starts one by its name alone.
//
// The tab loads this list, so it holds each flow's reference (its tag and schemas), never what its steps run on. The
// declarations themselves, the agent's included, are src/flows/declarations.ts, which only an engine's host imports.

/** The least a person must be to run a flow from the composer: anyone, signed out included, or a role (decision 0007). */
export type Minimum = "anyone" | Role

/**
 * A flow's slash command (docs/features/slash-commands.md): `/<command>` in the composer runs it, for a person who is at
 * least `minimum`. Its row shows the first sentence of the flow's description, and its arguments are the flow's payload.
 */
export interface SlashDoor {
  readonly command: string
  readonly minimum: Minimum
  /**
   * How its arguments read, as `@smthrs/ui`'s `FormHints`: `hidden` keeps an optional field a person never types out of
   * the command's arguments.
   */
  readonly hints?: { readonly fields?: Readonly<Record<string, { readonly hidden?: boolean }>> }
  /**
   * The payload fields a line fills, in order, when not all of them: the rest keep their defaults. The last one takes
   * the rest of the line.
   */
  readonly fields?: ReadonlyArray<string>
}

/** One registered flow: its reference, why only a person runs it, and its slash command. */
export interface Entry {
  /**
   * The flow's tag and schemas: the declaration itself, or a reference to one only an engine's host imports. A
   * declaration carries its description too.
   */
  readonly flow: BrowserEngine.FlowReference & { readonly description?: string }
  /** Why the agent may not run it; absent when it may. */
  readonly userOnlyReason?: string
  /**
   * Who its run acts as when nobody pressed it (decision 0017, slice 0): `agent` for a run that is an agent, such as
   * `chat/Answer`; `flow` for a run only a device or another flow starts. Absent, it is the person's: a person's own
   * press runs it with their session, and any other run of it, a nested one included, gets a server-minted run
   * credential (docs/features/sign-in.md#run-credentials). The server reads the agents among them from here
   * (worker/Actor.ts `AGENT_FLOWS`), never from a request.
   */
  readonly acts?: "agent" | "flow"
  /**
   * What running it changes, in the person's words, for a flow the agent may run that changes something; absent for
   * a read. The agent's catalog shows it beside the flow, and the agent runs such a flow only when the person asked for
   * that effect (src/flows/catalog.ts). src/flows/registry.test.ts holds every model-invocable flow to one or the other.
   */
  readonly changes?: string
  /**
   * The approval the agent's call waits for before it runs, for a flow whose side effect only the person decides on:
   * the question they Approve or Deny. A person's own button or slash command doesn't ask (src/flows/catalog.ts).
   */
  readonly confirm?: string
  /** Its slash command; absent when the composer doesn't offer it. */
  readonly slash?: SlashDoor
  /**
   * The least a person must be for the server to run it, when it isn't its slash door's: a plugin's view or command
   * that dispatches it must ask at least as much (decision 0017, `minimum_below_flow`), so nobody sees an action the
   * server refuses them. Absent, it is its slash door's minimum, else anyone.
   */
  readonly minimum?: Minimum
}

/** Every flow the app declares, by name. */
export const registry = {
  "timeline/summarize": { flow: Summarize, acts: "flow", userOnlyReason: "The conversation projection requests summaries; the agent does not summarize itself." },
  // A tab's failed session check, asked again until ChatApi answers (docs/features/sign-in.md#when-chatapi-cant-say).
  "auth/refresh": {
    flow: AuthRefresh,
    acts: "flow",
    userOnlyReason: "A tab whose session check failed starts it; it asks that tab again and grants nothing.",
  },
  "app/theme/set": { flow: SetTheme, changes: "sets this device's theme", slash: { command: "theme", minimum: "anyone" } },
  "app/navigate": { flow: Navigate, changes: "moves the person's tab", slash: { command: "navigate", minimum: "anyone" } },
  // File tabs (docs/features/files.md): the strip's clicks and keys dispatch these, and the agent calls them to show code.
  "file/open": { flow: OpenFile, changes: "opens a file as a tab in the person's tab" },
  "file/close": { flow: CloseFile, changes: "closes a file's tab in the person's tab" },
  // Adding a view writes the shared conversation, which only a Member or above may (decision 0007).
  // The tab pins the conversation it shows into the payload (src/features/web/actions.ts); a person never types it.
  "app/web/open": {
    flow: OpenWebPage,
    changes: "adds a page to the chat",
    slash: { command: "web", minimum: "member", hints: { fields: { conversationId: { hidden: true } } } },
  },
  // A repository's docs (docs/features/docs.md): adding its pages writes the shared conversation, Member or above too.
  "app/docs/search": {
    flow: SearchDocs,
    changes: "adds docs pages to the chat",
    slash: {
      command: "docs",
      minimum: "member",
      fields: ["repository", "query"],
      hints: { fields: { conversationId: { hidden: true }, pages: { hidden: true } } },
    },
  },
  // The agent talks through UI (docs/features/views.md): a form, a generated view, and a move in one. A person's click
  // in a view runs `view/set-state` too; the form and the view are the agent's to add.
  "ui/form": { flow: AskWithForm, changes: "adds a form to the chat" },
  "ui/render": { flow: RenderView, changes: "adds a view to the chat" },
  "view/set-state": { flow: SetViewState, changes: "makes a move in a view in the chat" },
  // A repository's view and its issues view (decision 0004 §3): `/repo` and `/issues` add them as the agent does; the
  // tab pins the conversation it shows, as `/docs` does. Adding a view writes the conversation: a Member or above.
  "ui/repo": {
    flow: ShowRepo,
    changes: "adds a repository's view to the chat",
    slash: { command: "repo", minimum: "member", fields: ["repo"], hints: { fields: { conversationId: { hidden: true } } } },
  },
  "ui/issues": {
    flow: ShowIssues,
    changes: "adds a repository's issues to the chat",
    slash: { command: "issues", minimum: "member", fields: ["repo"], hints: { fields: { conversationId: { hidden: true } } } },
  },
  "chat/Answer": {
    flow: AnswerReference,
    acts: "agent",
    userOnlyReason: "Asking starts it, and the agent is the one answering; it never asks itself.",
  },
  "chat/Close": {
    flow: Close,
    userOnlyReason: "The tab that asked settles an answer whose run can no longer finish; the agent never settles one.",
  },
  // Message controls (docs/features/chat.md#message-controls): Copy on a message and `/copy`, which the agent runs to
  // copy its last answer; Edit on a question Smithers doesn't have yet and `/edit`, the person's only.
  "chat/pin": { flow: ChatPin, minimum: "guest", changes: "pins a message for the person across their devices" },
  "chat/unpin": { flow: ChatUnpin, minimum: "guest", changes: "unpins the person's message across their devices" },
  "chat/copy": { flow: ChatCopy, changes: "writes the person's clipboard", slash: { command: "copy", minimum: "anyone", hints: { fields: { messageId: { hidden: true } } } } },
  "chat/edit": {
    flow: ChatEdit,
    userOnlyReason: "Only the person changes what they asked; the agent never edits a question.",
    slash: { command: "edit", minimum: "member", hints: { fields: { questionId: { hidden: true } } } },
  },
  "app/memory/remember": { flow: Remember, changes: "stores a fact for future conversations on this device" },
  "repo/tree": { flow: RepoTree },
  "repo/read": { flow: RepoRead },
  "repo/refs": { flow: RepoRefs },
  "repo/about": {
    flow: RepoAbout,
    userOnlyReason: "A repository's page loads what GitHub says of it; the agent reads a repository with repo/refs, repo/tree and repo/read.",
  },
  // Cloning spends the deployment's Code Storage budget, which only a Member or above may (decision 0007).
  "repo/clone": {
    flow: RepoCloneRequest,
    changes: "clones the repository, which spends the deployment's storage",
    slash: { command: "clone", minimum: "member" },
  },
  "repo/copy": { flow: RepoCopy, changes: "writes the person's clipboard" },
  // No slash command: a person's run would have nowhere to show its verdicts. A person asks Smithers instead.
  "app/jev/classify": { flow: Classify },
  "app/jev/evaluate": { flow: Evaluate },
  // Agent status (decision 0015): the agent asks the person; the person answers; the device delivers the answer.
  "app/agent/ask": { flow: Ask },
  // Answering writes the run's row, which a Guest may not (worker/Runs.ts).
  "run/answer": { flow: AnswerRun, minimum: "member", userOnlyReason: "Only the person answers what the agent asks them." },
  "run/deliver": {
    flow: Deliver,
    acts: "flow",
    userOnlyReason: "The device that holds a run delivers an answer already recorded; nobody runs it by hand.",
  },
  // Your own flows (decision 0014 §2): drafting one costs model calls, so only a Member or above drafts or runs one.
  "flow/new": {
    flow: FlowNewReference,
    acts: "agent",
    changes: "drafts a flow for the person to review, which spends model calls",
    slash: { command: "flow.new", minimum: "member" },
  },
  "flow/answer": { flow: FlowAnswerReference, userOnlyReason: "Only the person answers what the drafting agent asked." },
  // Saving and deleting your flow are yours to decide: the agent's call asks first (the agent evals saw it save a draft
  // it was only asked to create, 2026-10-20).
  "flow/save": {
    flow: FlowSaveReference,
    changes: "saves a draft as the person's flow",
    confirm: "Save this draft as your flow?",
  },
  // A flow's code (decision 0014 §1): Code on the Flows page reads it and Save writes it, and the agent can too.
  "flow/read": { flow: FlowReadReference },
  "flow/write": { flow: FlowWriteReference, changes: "saves new code for the person's flow" },
  "flow/run": {
    flow: FlowRunReference,
    changes: "runs the person's flow, and whatever it does",
    // `/flow.run <name> <input>`: the revision a person never types; the latest runs.
    slash: { command: "flow.run", minimum: "member", fields: ["name", "input"] },
  },
  "flow/run/prompt": {
    flow: FlowPromptReference,
    acts: "agent",
    userOnlyReason: "flow/run starts it with the revision it pinned; nobody starts it by hand.",
  },
  "flow/delete": { flow: FlowDeleteReference, changes: "deletes the person's flow", confirm: "Delete this flow?" },
  "flow/draft/delete": {
    flow: FlowDraftDeleteReference,
    changes: "deletes a draft of the person's",
    confirm: "Delete this draft?",
  },
  "flow/drafts": { flow: FlowDraftsReference },
  "flow/list": { flow: FlowListReference },
  // Runs (decision 0014 §2): the acts on a run this device holds, and the reads. Their results show on the run page.
  "run/cancel": { flow: Cancel, changes: "cancels a run" },
  "run/retry": { flow: Retry, changes: "runs a failed run again" },
  "run/resume": { flow: Resume, changes: "resumes a run" },
  "run/list": { flow: List },
  "run/inspect": { flow: Inspect },
  // Steering a TODO's agent (ruling TODO-3, docs/features/runs.md#steering): the run page's composer, and the agent, which
  // may do what a person does (ruling FLOW-3).
  "run/steer": { flow: Steer, changes: "sends a message to the agent working on a TODO" },
  // The branch workspace (decision 0013): a page opening a branch runs branch/track, and the agent can too.
  "branch/track": { flow: BranchTrack, changes: "tracks the branch for the person" },
  // A home's New branch (docs/features/branch-workspace.md#new-branch): makes a branch and tracks it; `/branch.new`
  // and the agent can too.
  "branch/create": {
    flow: BranchCreate,
    changes: "makes a new branch of the repository and tracks it for the person",
    slash: { command: "branch.new", minimum: "member", fields: ["repo", "branch"] },
  },
  // Your conversations (docs/features/conversations.md): one per branch, so `/new` makes a branch and opens it; the
  // list's Archive and Restore change only the person's own list. The agent can do both.
  "conversation/new": {
    flow: ConversationNew,
    changes: "makes a new branch of the repository, with its conversation, and opens it in the person's tab",
    slash: { command: "new", minimum: "member", fields: ["branch"], hints: { fields: { repo: { hidden: true } } } },
  },
  "conversation/archive": { flow: ConversationArchive, changes: "archives one of the person's conversations, or brings it back" },
  "branch/share": {
    flow: BranchShare,
    userOnlyReason: "Sharing a branch is its owner's own act; the agent never grants access (decision 0008).",
  },
  "terminal/open": {
    flow: TerminalOpenRequest,
    userOnlyReason: "A terminal is the person's own shell; the agent runs commands as jobs instead (decision 0013).",
  },
  // Git writes (decision 0012 §3): opening an issue and commenting are Guest acts. `/issue owner/repo <title>` fills
  // the title with the rest of the line; the body is the form's.
  "issue/create": { flow: IssueCreate, changes: "opens an issue on GitHub", slash: { command: "issue", minimum: "guest", fields: ["repo", "title"] } },
  "issue/comment": { flow: IssueComment, changes: "comments on a GitHub issue", slash: { command: "comment", minimum: "guest" } },
  // Triage (decision 0012 §5 and decision 11): a person's acts only. Accept and Not accepted, and Run triage again, are
  // a Member's (`repo:triage`); Enable and Pause a Maintainer's (`repo:triage-flow`).
  "issue/triage": {
    flow: IssueTriage,
    userOnlyReason: "Overriding triage is a person's call; the agent never accepts or rejects an issue.",
    // `/triage owner/repo <n> accept|reject <reason>`: the reason, the last text field, takes the rest of the line.
    slash: { command: "triage", minimum: "member" },
  },
  "issue/commitment": { flow: IssueCommitment, userOnlyReason: "A Maintainer sets the implementation commitment.", slash: { command: "issue.commitment", minimum: "maintainer" } },
  "triage/run": {
    flow: TriageRunAgain,
    userOnlyReason: "Handing an issue back to the triage flow is a person's call, never the agent's.",
    slash: { command: "triage.run", minimum: "member" },
  },
  "triage/enable": {
    flow: TriageEnable,
    userOnlyReason: "A Maintainer turns the triage flow on under their own role; the agent never does.",
    slash: { command: "triage.enable", minimum: "maintainer" },
  },
  "triage/pause": {
    flow: TriagePause,
    userOnlyReason: "A Maintainer pauses the triage flow; the agent never does.",
    slash: { command: "triage.pause", minimum: "maintainer" },
  },
  // TODOs and the stack (decision 0016 §3): the agent drafts a TODO, privately, on the person's device; only the person
  // commits it and drops it. `/todo.new owner/repo <prompt>` drafts one; the prompt takes the rest of the line.
  "todo/draft": { flow: TodoDraft, changes: "drafts a TODO for the person", slash: { command: "todo.new", minimum: "member", fields: ["repo", "prompt"] } },
  // Make TODO on an issue (docs/features/todos.md#from-an-issue): `/todo.issue owner/repo <n>` drafts a TODO linked to
  // issue n, its title and prompt the issue's; the agent may pass better ones.
  "todo/issue": {
    flow: TodoIssue,
    changes: "drafts a TODO from an issue for the person",
    slash: { command: "todo.issue", minimum: "member", fields: ["repo", "issue"] },
  },
  "todo/inspect": { flow: TodoInspect },
  "todo/commit": {
    flow: TodoCommit,
    userOnlyReason: "A person commits a TODO from its draft card; the agent drafts and never commits one.",
  },
  "todo/Retry": { flow: TodoRetry, changes: "retries a failed TODO in place" },
  "todo/drop": {
    flow: TodoDrop,
    userOnlyReason: "Dropping a TODO is a person's press; the agent never drops one.",
    slash: { command: "todo.drop", minimum: "member" },
  },
  // Notifications (decision 0009): a tab showing a conversation follows its branch and repository, and the agent can
  // too; Read, Dismiss and Hide are the person's acts on their own feed.
  "watch/set": { flow: WatchSet, changes: "changes what the person follows" },
  "notification/ack": {
    flow: Ack,
    userOnlyReason: "Read, Dismiss and Hide record what the person saw and chose; the agent never acts for them.",
  },
  // Spend alerts' channels (docs/features/spend-alerts.md#channels): where an Admin's alerts go outside the app.
  "alert/channel": {
    flow: AlertChannelSet,
    userOnlyReason: "Where spend alerts go is an Admin's own choice; the agent never redirects them.",
  },
  // The sandbox limits (docs/features/sandbox-budgets.md#the-limits): how many machines may be awake, and the monthly
  // sandbox spend that alerts the Admins.
  "sandbox/limits": {
    flow: SandboxLimitsSet,
    userOnlyReason: "What sandboxes may cost is an Admin's own choice; the agent never changes the limits.",
  },
  // Custom domains (decision 0039, docs/features/domains.md): what a repository's app answers on a Maintainer's own
  // domain. Only a person points a domain at the app.
  "domain/add": {
    flow: DomainAdd,
    userOnlyReason: "Pointing a domain at the app is a Maintainer's own act; the agent never adds or checks one.",
  },
  "domain/remove": {
    flow: DomainRemove,
    userOnlyReason: "Removing a domain takes the app off it; only a Maintainer does, never the agent.",
  },
  // A person's own model (decision 0096, docs/features/personal-model.md#the-flows): Test and Remove in Settings, and
  // the agent alike (ruling FLOW-3). Saving is no flow: its key never enters a model's context, a journal or the device.
  "model/test": {
    flow: ModelTest,
    minimum: "member",
    changes: "makes one tiny call with the person's own model, which spends a few of their tokens",
  },
  // Anyone signed in removes their own model, a person who lost their role included (decision 0096).
  "model/remove": {
    flow: ModelRemove,
    changes: "removes the person's own model, so the deployment's model answers them",
    confirm: "Remove your model?",
  },
  // The sandbox tools (decision 0005 §5, docs/features/sandbox-tools.md): what the agent's hands are on a branch's
  // machine, and a person's slash commands alike. Each runs as the person who asked, who must be able to edit the
  // branch; the tab pins the conversation it shows, which a person never types.
  "sandbox/run": {
    flow: SandboxRun,
    changes: "runs a command on the branch's machine",
    slash: { command: "run", minimum: "member", fields: ["command"], hints: { fields: { conversationId: { hidden: true } } } },
  },
  "sandbox/read": {
    flow: SandboxRead,
    slash: { command: "read", minimum: "member", hints: { fields: { conversationId: { hidden: true } } } },
  },
  "sandbox/write": {
    flow: SandboxWrite,
    changes: "writes a file on the branch's machine",
    slash: { command: "write", minimum: "member", fields: ["path", "content"], hints: { fields: { conversationId: { hidden: true } } } },
  },
  "sandbox/list": {
    flow: SandboxList,
    slash: { command: "ls", minimum: "member", hints: { fields: { conversationId: { hidden: true } } } },
  },
  "sandbox/status": {
    flow: SandboxStatus,
    slash: { command: "status", minimum: "member", hints: { fields: { conversationId: { hidden: true } } } },
  },
  "sandbox/diff": {
    flow: SandboxDiff,
    slash: { command: "diff", minimum: "member", hints: { fields: { conversationId: { hidden: true }, paths: { hidden: true } } } },
  },
} as const satisfies Record<string, Entry>

/** A registered flow's name: the only thing the UI dispatches. */
export type FlowName = keyof typeof registry

/** The reference registered under `N`. */
export type FlowOf<N extends FlowName> = (typeof registry)[N]["flow"]

/** The names in the registry, in order. */
export const names = Object.keys(registry) as ReadonlyArray<FlowName>

/** The entry registered under `name`. */
export const entryOf = (name: FlowName): Entry => registry[name]


/** The registry read by dispatch, credentials and the agent on this host. Effect 4's service tag is Context.Service. */
export class FlowRegistry extends Context.Service<FlowRegistry, {
  readonly entries: Readonly<Record<string, Entry>>
  readonly names: ReadonlyArray<FlowName>
  readonly entryOf: (name: FlowName) => Entry
}>()("@smthrs/mvp/flows/FlowRegistry") {
  /** The app's declared references, without loading any flow implementation into the tab. */
  static readonly layer = Layer.succeed(FlowRegistry, FlowRegistry.of({ entries: registry, names, entryOf }))
}
