import { ChatPin, ChatUnpin } from "../features/pins/flows"
import { Remember } from "../features/agent/memoryFlows"
import { Summarize } from "../features/timeline/flow"
import { Flow } from "@smthrs/flow"
import { Context } from "effect"
import { BranchCreate, BranchTrack } from "../features/branch/flows"
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
import { Answer } from "../features/agent/flows"
import {
  FlowAnswer,
  FlowDelete,
  FlowDraftDelete,
  FlowDrafts,
  FlowList,
  FlowNew,
  FlowPrompt,
  FlowRead,
  FlowRun,
  FlowSave,
  FlowWrite,
} from "../features/flows-ui/flows"
import { IssueCommitment, IssueComment, IssueCreate, IssueTriage, TriageEnable, TriagePause, TriageRunAgain } from "../features/issues/flows"
import { Classify, Evaluate } from "../features/jev/flows"
import { Cancel, Inspect, List, Resume, Retry, Steer } from "../features/runs/flows"
import { CloseFile, OpenFile } from "../features/files/flows"
import { Navigate } from "../features/navigation/flows"
import { RepoAbout, RepoCloneRequest, RepoCopy, RepoRead, RepoRefs, RepoTree } from "../features/repo/flows"
import { AnswerRun, Ask, Deliver } from "../features/status/flows"
import { Ack, WatchSet } from "../features/attention/flows"
import { ConversationArchive, ConversationNew } from "../features/conversations/flows"
import { AlertChannelSet, SandboxLimitsSet } from "../features/spend/flows"
import { DomainAdd, DomainRemove } from "../features/domains/flows"
import { ModelRemove, ModelTest } from "../features/personal-model/flows"
import { SetTheme } from "../features/theme/flows"
import { TodoCommit, TodoDraft, TodoDrop, TodoInspect, TodoIssue, TodoRetry } from "../features/todos/flows"
import { AskWithForm, RenderView, SetViewState } from "../features/views/flows"
import { OpenWebPage } from "../features/web/flows"
import { SearchDocs } from "../features/docs/flows"
import { type FlowName, type FlowOf, names } from "./registry"

// Every registered flow's declaration, its body and steps included (docs/features/flows.md#the-registry): what an engine
// runs and the agent's catalog binds. Only what runs flows imports this module (the engine worker and the Node host),
// because the agent's declaration imports @smthrs/agent. The tab dispatches by the registry's references
// (src/flows/registry.ts) and never loads it. src/flows/registry.test.ts proves the two lists match one to one: the
// same names, and the very same schema objects.

/** Each registered flow's declaration, by name: one per registry entry, with that entry's tag and schemas. */
export const declarations = {
  "timeline/summarize": Summarize,
  "auth/refresh": AuthRefresh,
  "app/theme/set": SetTheme,
  "app/navigate": Navigate,
  "file/open": OpenFile,
  "file/close": CloseFile,
  "app/web/open": OpenWebPage,
  "app/docs/search": SearchDocs,
  "ui/form": AskWithForm,
  "ui/render": RenderView,
  "view/set-state": SetViewState,
  "chat/Answer": Answer,
  "chat/Close": Close,
  "chat/pin": ChatPin,
  "chat/unpin": ChatUnpin,
  "chat/copy": ChatCopy,
  "chat/edit": ChatEdit,
  "app/memory/remember": Remember,
  "repo/tree": RepoTree,
  "repo/read": RepoRead,
  "repo/refs": RepoRefs,
  "repo/about": RepoAbout,
  "repo/clone": RepoCloneRequest,
  "repo/copy": RepoCopy,
  "app/jev/classify": Classify,
  "app/jev/evaluate": Evaluate,
  "app/agent/ask": Ask,
  "run/answer": AnswerRun,
  "run/deliver": Deliver,
  "flow/new": FlowNew,
  "flow/answer": FlowAnswer,
  "flow/save": FlowSave,
  "flow/read": FlowRead,
  "flow/write": FlowWrite,
  "flow/run": FlowRun,
  "flow/run/prompt": FlowPrompt,
  "flow/delete": FlowDelete,
  "flow/draft/delete": FlowDraftDelete,
  "flow/drafts": FlowDrafts,
  "flow/list": FlowList,
  "run/cancel": Cancel,
  "run/retry": Retry,
  "run/resume": Resume,
  "run/list": List,
  "run/inspect": Inspect,
  "run/steer": Steer,
  "branch/track": BranchTrack,
  "branch/create": BranchCreate,
  "conversation/new": ConversationNew,
  "conversation/archive": ConversationArchive,
  "branch/share": BranchShare,
  "terminal/open": TerminalOpenRequest,
  "issue/create": IssueCreate,
  "issue/comment": IssueComment,
  "issue/triage": IssueTriage,
  "issue/commitment": IssueCommitment,
  "triage/run": TriageRunAgain,
  "triage/enable": TriageEnable,
  "triage/pause": TriagePause,
  "todo/draft": TodoDraft,
  "todo/issue": TodoIssue,
  "todo/inspect": TodoInspect,
  "todo/commit": TodoCommit,
  "todo/Retry": TodoRetry,
  "todo/drop": TodoDrop,
  "watch/set": WatchSet,
  "notification/ack": Ack,
  "alert/channel": AlertChannelSet,
  "sandbox/limits": SandboxLimitsSet,
  "domain/add": DomainAdd,
  "domain/remove": DomainRemove,
  "model/test": ModelTest,
  "model/remove": ModelRemove,
  "sandbox/run": SandboxRun,
  "sandbox/read": SandboxRead,
  "sandbox/write": SandboxWrite,
  "sandbox/list": SandboxList,
  "sandbox/status": SandboxStatus,
  "sandbox/diff": SandboxDiff,
} as const satisfies { readonly [N in FlowName]: Flow.Any & FlowOf<N> }

/** The declaration registered under `name`. */
export const declarationOf = (name: FlowName): Flow.Any => declarations[name]

/**
 * Whether a model may call the flow registered under `name`: its own `modelInvocable`, which defaults to yes. An entry
 * with a `userOnlyReason` declares `modelInvocable: false`; the registry test holds the two together.
 */
export const modelInvocable = (name: FlowName): boolean =>
  Context.get(declarationOf(name).annotations, Flow.ModelInvocable)

/** The flows this device's engine runs: every registered flow, in the registry's order. */
export const clientFlows: ReadonlyArray<Flow.Any> = names.map(declarationOf)
