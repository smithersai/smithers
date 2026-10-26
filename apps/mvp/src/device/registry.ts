import { Pin, Pending as PinPending } from "../features/pins/schema"
import { Migrations } from "@smthrs/effect-tanstack-db"
import { Notice, Pending } from "../features/attention/schema"
import { ConversationRoute } from "../features/branch/schema"
import { Mine, Pending as ConversationPending } from "../features/conversations/schema"
import { Confirmed } from "../features/auth/schema"
import { Asking, Message, Unsent } from "../features/chat/schema"
import { Sending as TextSending, TextUpdate } from "../features/coedit/schema"
import { AnswerRow as FlowAnswerRow, Code as FlowCode, Draft as FlowDraft, FlowRow, Form as FlowForm } from "../features/flows-ui/schema"
import { FileTabRow } from "../features/files/schema"
import { CuratedRow, HomeRow } from "../features/home/rows"
import {
  Comment,
  Draft as IssueDraft,
  Item,
  ItemSummary,
  Requested as IssueRequested,
  Sending as IssueSending,
  SyncRow,
  TriageSettings,
  WriteRow,
} from "../features/issues/schema"
import { CheckRow, PullCommitRow, PullRow, ReviewRow } from "../features/pulls/schema"
import { Hidden as PersonalModelHidden, PersonalModelRow } from "../features/personal-model/schema"
import { Repository } from "../features/repo/schema"
import { SecretRow } from "../features/secrets/schema"
import { AlertChannel, AlertDelivery, SandboxLimitsRow, Seen, SpendAlert } from "../features/spend/schema"
import { BugReport } from "../features/bugs/schema"
import { RepoRunRow, SteerSending, SteerSent } from "../features/runs/schema"
import { Run } from "../features/status/schema"
import { Preference } from "../features/theme/schema"
import { TodoSendingV1, TodoRequestedV2 } from "./history"
import { Draft as TodoDraft, Requested as TodoRequested, Sending as TodoSending, Todo, TodoRequest } from "../features/todos/schema"
import { View } from "../features/views/schema"
import { CuratedRowV1, HomeRowV2 } from "./home-history"
import { Draft as PluginDraft } from "../plugins/schema"
import { AskingV1, AuthConfirmedV1, ChatDraftV1, IssueSendingV1, IssueSendingV2, RequestedV1, TodoRequestedV1, UnsentV1 } from "./history"

// Every store this device keeps, and its history (decision 0021): each persisted collection, synced or local, and
// each payload the outbox carries. A store's collection opens only at the version declared here (the app's
// `Persistence` refuses any other), the engine worker brings the device store to these versions before any tab reads
// it (`device/prepare`), and the outbox upgrades the writes an older build stored. src/device/schemas.test.ts checks
// this file against schemas.lock.json: a schema that changes needs a new version, and a local store or payload a
// migration to it. Synced rows are never migrated: a new version drops them and they sync again.

// --- Local: rows only this device has ---

/** Verified branch routes, so an offline reload can select the saved conversation without restoring grants. */
export const BranchConversationsStore = Migrations.local({ id: "branch-conversations", versions: [ConversationRoute], getKey: (row) => row.id })

/** Questions the server refused or the outbox couldn't take (src/features/chat/store.ts). */
export const ChatUnsentStore = Migrations.local({
  id: "chat-unsent",
  versions: [UnsentV1, Unsent],
  // Version 2 adds a question's view and values; a question kept before has neither.
  migrations: [Migrations.step(UnsentV1, Unsent, (row) => row)],
  getKey: (row) => row.id,
})

/**
 * The composer's draft in each conversation whose prompt isn't shared (src/features/chat/store.ts); on a branch its
 * owner shared, the branch's prompt adopts it (src/device/history.ts).
 */
export const ChatDraftsStore = Migrations.local({ id: "chat-drafts", versions: [ChatDraftV1], getKey: (row) => row.id })

/**
 * Issue writes the server took or refused. Version 2 (after `7b96f878`): who acts is the server's to read from the
 * request, so a row no longer says (`via`).
 */
export const IssueRequestedStore = Migrations.local({
  id: "issue-requested",
  versions: [RequestedV1, IssueRequested],
  migrations: [Migrations.step(RequestedV1, IssueRequested, ({ via: _via, ...row }) => row)],
  getKey: (row) => row.id,
})

/** The new-issue form's and comments' drafts. */
export const IssueDraftsStore = Migrations.local({ id: "issue-drafts", versions: [IssueDraft], getKey: (row) => row.id })

/** Who this device last knew was signed in, and as what (src/features/auth/store.ts). */
export const AuthConfirmedStore = Migrations.local({ id: "auth-confirmed", versions: [AuthConfirmedV1, Confirmed], migrations: [Migrations.step(AuthConfirmedV1, Confirmed, (row) => row)], getKey: (row) => row.id })

/** The plugin host's strip notes, one per view and item (src/plugins/schema.ts `Draft`). */
export const PluginDraftsStore = Migrations.local({ id: "plugin-drafts", versions: [PluginDraft], getKey: (row) => row.id })

/** This device's theme. */
export const PreferencesStore = Migrations.local({ id: "preferences", versions: [Preference], getKey: (row) => row.id })

/** This device's open files and the lines each last highlighted (src/features/files/store.ts). */
export const FileTabsStore = Migrations.local({ id: "file-tabs", versions: [FileTabRow], getKey: (row) => row.key })

/** Repository homes as last read: a cache RepoApi fills again. Version 1 (a flat list of blocks) was never declared. */
export const HomesStore = Migrations.local({
  id: "homes",
  versions: [HomeRowV2, HomeRow],
  migrations: [Migrations.step(HomeRowV2, HomeRow, (row) => row)],
  first: 2,
  getKey: (row) => row.key,
  discard: true,
})

/** Curated homes as last read: a cache RepoApi fills again. */
export const CuratedHomesStore = Migrations.local({
  id: "curated-homes",
  versions: [CuratedRowV1, CuratedRow],
  migrations: [Migrations.step(CuratedRowV1, CuratedRow, (row) => row)],
  getKey: (row) => row.key,
  discard: true,
})

/** The feed's acknowledgments not yet sent (src/features/attention/store.ts). */
export const AttentionPendingStore = Migrations.local({
  id: "attention-pending",
  versions: [Pending],
  getKey: (row) => row.id,
})

/** Archives and restores of your conversations not yet synced back (src/features/conversations/store.ts). */
export const ConversationPendingStore = Migrations.local({
  id: "conversation-pending",
  versions: [ConversationPending],
  getKey: (row) => row.conversationId,
})

/** The spend alerts this device has seen, by kind. */
export const SpendSeenStore = Migrations.local({ id: "spend-seen", versions: [Seen], getKey: (row) => row.kind })

/** The failure of the person's own model whose toast this device hid (src/features/personal-model/store.ts). */
export const PersonalModelHiddenStore = Migrations.local({
  id: "personal-model-hidden",
  versions: [PersonalModelHidden],
  getKey: (row) => row.id,
})

/** TODO drafts. */
export const TodoDraftsStore = Migrations.local({ id: "todo-drafts", versions: [TodoDraft], getKey: (row) => row.id })

/** The new-flow form and unsent answers survive a page reload or PWA update. */
export const FlowFormStore = Migrations.local({ id: "flow-form", versions: [FlowForm], getKey: (row) => row.id })
export const FlowAnswersStore = Migrations.local({ id: "flow-answers", versions: [FlowAnswerRow], getKey: (row) => row.id })
export const FlowCodeStore = Migrations.local({ id: "flow-code", versions: [FlowCode], getKey: (row) => row.id })

/**
 * Changes to a stack the server took or refused. Version 3 (after TODO retry version 2): a change to a repository the App
 * isn't installed on stays Not sent as App not installed (decision 0079); every version 2 row is a version 3 row.
 */
export const TodoRequestedStore = Migrations.local({
  id: "todo-requested",
  versions: [TodoRequestedV1, TodoRequestedV2, TodoRequested],
  migrations: [Migrations.step(TodoRequestedV1, TodoRequestedV2, (row) => row), Migrations.step(TodoRequestedV2, TodoRequested, (row) => row)],
  getKey: (row) => row.id,
})

/** Steers of a TODO's agent the server took or refused (src/features/runs/writes.ts). */
export const SteerSentStore = Migrations.local({ id: "steer-sent", versions: [SteerSent], getKey: (row) => row.id })

export const PinPendingStore = Migrations.local({ id: "message-pin-pending", versions: [PinPending], getKey: r => r.conversationId })

// --- Synced: the server's rows, kept on the device ---

/**
 * The conversation's messages, one collection per conversation. Version 4: terminal model quota refusals. Version 5: an
 * answer's summary, made once for every device.
 */
export const MessagesStore = Migrations.synced({ id: "chat-messages", version: 5, schema: Message, family: true })

/**
 * The conversation's views. Version 2: a page's title, description and icon. Version 3: docs pages. Version 4: forms and
 * generated views. Version 5: a repository's view and its issues view.
 */
export const ViewsStore = Migrations.synced({ id: "views", version: 5, schema: View, family: true })

const synced = [
  MessagesStore,
  Migrations.synced({ id: "message-pins", version: 1, schema: Pin }),
  ViewsStore,
  // Version 2: an approval's answer may carry a note (`Decision`).
  Migrations.synced({ id: "runs", version: 2, schema: Run }),
  Migrations.synced({ id: "repo-repositories", version: 4, schema: Repository }),
  Migrations.synced({ id: "issue-summaries", version: 1, schema: ItemSummary, family: true }),
  Migrations.synced({ id: "issue-items", version: 3, schema: Item, family: true }),
  Migrations.synced({ id: "issue-comments", version: 1, schema: Comment, family: true }),
  Migrations.synced({ id: "issue-sync", version: 1, schema: SyncRow, family: true }),
  Migrations.synced({ id: "issue-writes", version: 2, schema: WriteRow }),
  Migrations.synced({ id: "issue-triage-settings", version: 1, schema: TriageSettings, family: true }),
  Migrations.synced({ id: "flows", version: 2, schema: FlowRow }),
  Migrations.synced({ id: "flow-drafts", version: 1, schema: FlowDraft }),
  // Version 2: the kind `spend`, a sandbox spend alert in an Admin's bell (docs/features/sandbox-budgets.md); version 3:
  // the kind `bug`, a bug report in an Admin's bell (docs/features/bugs.md).
  Migrations.synced({ id: "notifications", version: 3, schema: Notice }),
  Migrations.synced({ id: "my-conversations", version: 1, schema: Mine }),
  Migrations.synced({ id: "spend-alerts", version: 1, schema: SpendAlert }),
  Migrations.synced({ id: "alert-channels", version: 1, schema: AlertChannel }),
  Migrations.synced({ id: "alert-deliveries", version: 1, schema: AlertDelivery }),
  Migrations.synced({ id: "sandbox-limits", version: 1, schema: SandboxLimitsRow }),
  // Version 2: each report's error records (docs/features/bugs.md#what-a-report-carries).
  Migrations.synced({ id: "bug-reports", version: 2, schema: BugReport }),
  Migrations.synced({ id: "todos", version: 4, schema: Todo, family: true }),
  Migrations.synced({ id: "todo-requests", version: 1, schema: TodoRequest, family: true }),
  Migrations.synced({ id: "text-updates", version: 1, schema: TextUpdate, family: true }),
  Migrations.synced({ id: "pull-rows", version: 1, schema: PullRow, family: true }),
  Migrations.synced({ id: "pull-commits", version: 1, schema: PullCommitRow, family: true }),
  Migrations.synced({ id: "pull-reviews", version: 1, schema: ReviewRow, family: true }),
  Migrations.synced({ id: "pull-checks", version: 1, schema: CheckRow, family: true }),
  // A repository's secret names and bindings, one collection per repository; never a value.
  Migrations.synced({ id: "secrets", version: 1, schema: SecretRow, family: true }),
  // The person's own keys, one row per protocol: where each answers, its tiers' models and its last characters; never a key.
  Migrations.synced({ id: "personal-model", version: 2, schema: PersonalModelRow }),
  Migrations.synced({ id: "repo-runs", version: 1, schema: RepoRunRow, family: true }),
]

// --- The outbox's payloads, by the collection key each write names ---

/** Chat's questions (src/features/chat/store.ts, mutation `ask`). */
export const AskingPayload = Migrations.payload({
  key: "asking",
  versions: [AskingV1, Asking],
  // Version 2 adds a question's view and values; a question queued before has neither.
  migrations: [Migrations.step(AskingV1, Asking, (row) => ({ ...row, v: 2 as const }))],
})

/**
 * Issue writes (src/features/issues/writes.ts, mutation `issue-write`). Version 2 (after `7b96f878`): the request
 * names nobody, so a write the agent queued as itself can't be sent as it meant; it is parked, and shows Not sent.
 */
export const IssueSendingPayload = Migrations.payload({
  key: "issue-sending",
  versions: [IssueSendingV1, IssueSendingV2, IssueSending],
  migrations: [
    Migrations.step(IssueSendingV1, IssueSendingV2, ({ via, ...row }) =>
      via === "agent" ? new Migrations.Unmigratable({ reason: "agent_write" }) : { ...row, v: 2 as const }),
    Migrations.step(IssueSendingV2, IssueSending, (row) => ({ ...row, v: 3 as const })),
  ],
})

/** Co-edited texts' updates (src/features/coedit/writes.ts, mutation `text-update`). */
export const TextSendingPayload = Migrations.payload({ key: "text-sending", versions: [TextSending] })

/** Changes to a stack (src/features/todos/writes.ts, mutation `todo-op`). */
export const TodoSendingPayload = Migrations.payload({ key: "todo-sending", versions: [TodoSendingV1, TodoSending], migrations: [Migrations.step(TodoSendingV1, TodoSending, (row) => ({ ...row, v: 2 as const }))] })

/** Steers of a TODO's agent (src/features/runs/writes.ts, mutation `run-steer`). */
export const SteerSendingPayload = Migrations.payload({ key: "steer-sending", versions: [SteerSending] })

/** Every store this build keeps, and its outbox's writes. */
export const deviceRegistry = Migrations.registry({
  stores: [
    PinPendingStore,
    BranchConversationsStore,
    ChatUnsentStore,
    ChatDraftsStore,
    IssueRequestedStore,
    IssueDraftsStore,
    AuthConfirmedStore,
    PreferencesStore,
    PluginDraftsStore,
    FileTabsStore,
    HomesStore,
    CuratedHomesStore,
    AttentionPendingStore,
    ConversationPendingStore,
    SpendSeenStore,
    PersonalModelHiddenStore,
    TodoDraftsStore,
    FlowFormStore,
    FlowAnswersStore,
    FlowCodeStore,
    TodoRequestedStore,
    SteerSentStore,
    ...synced,
  ],
  // The timeline's summaries live on the messages now, made once for every device (docs/features/timeline.md#cost).
  retired: [Migrations.retired({ id: "timeline-summaries", kind: "local", version: 1 })],
  outbox: {
    payloads: [AskingPayload, IssueSendingPayload, TextSendingPayload, TodoSendingPayload, SteerSendingPayload],
    mutations: ["ask", "issue-write", "text-update", "todo-op", "run-steer"],
    // Builds before stamping (`7b96f878` and earlier) wrote every payload at its version 1.
    unstamped: { asking: 1, "issue-sending": 1, "text-sending": 1, "todo-sending": 1 },
  },
})

/** The outbox's upgrade of the writes an older build stored, and the versions it stamps on each new write. */
export const outboxUpgrade = Migrations.outbox(deviceRegistry)
