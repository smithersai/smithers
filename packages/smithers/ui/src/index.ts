/**
 * @smthrs/ui
 *
 * Shared component library for Smithers UIs: shadcn component anatomy (slots,
 * CVA variant APIs, asChild, data-slot attributes) and Radix behavior, styled
 * entirely through the ui-styleguide theme tokens so every component is
 * correct in light AND dark (OS `prefers-color-scheme`, with an explicit
 * `data-theme` override that always wins).
 *
 * Styling ships as a CSS-in-TS string (`smithersUiCss`) because the gateway
 * UI bundler drops `.css` imports: render `<SmithersUiStyles/>` once at the
 * root, and components also self-inject the sheet in the browser as a
 * fallback. All classes are namespaced `sui-*` so nothing collides with the
 * styleguide page vocabulary or consumer CSS.
 *
 * @example
 * ```tsx
 * import { Button, Card, CardHeader, CardTitle, SmithersUiStyles, StatusPill } from "@smthrs/ui";
 *
 * function App() {
 *   return (
 *     <main>
 *       <SmithersUiStyles />
 *       <Card>
 *         <CardHeader>
 *           <CardTitle>Runs</CardTitle>
 *           <StatusPill status="running" />
 *         </CardHeader>
 *         <Button onClick={() => {}}>Launch</Button>
 *       </Card>
 *     </main>
 *   );
 * }
 * ```
 */

export { cn } from "./cn";
export { tokens, type SmithersUiTokens } from "./tokens";
export { resolveTheme, subscribeTheme, type ResolvedTheme } from "./internal/resolveTheme";
export { resolvePalette, subscribePalette, type ResolvedPalette } from "./internal/resolvePalette";
export { useResolvedPalette } from "./internal/useResolvedPalette";
export { useResolvedTheme } from "./internal/useResolvedTheme";
export { isPlainNavigationClick } from "./internal/navigationClick";
export { newNonce, useNearScreen } from "./internal/frameMount";
export { xtermBaseCss } from "./adapters/xtermCss";
export {
  normalizeStatus,
  statusClass,
  statusColor,
  statusColors,
  hasStatusTone,
  formatStatus,
  isTerminalRunStatus,
  type StatusClass,
} from "./status";
export {
  SmithersUiStyles,
  composeSmithersUiStyles,
  smithersUiCss,
  standaloneThemeCss,
  DEFAULT_THEME_KEY,
  themeRegistry,
  SMITHERS_UI_STYLE_ATTR,
  REDUCED_MOTION_MEDIA_QUERY,
  prefersReducedMotion,
  observeReducedMotion,
  type SmithersUiStylesProps,
} from "./styles";

export { Button, buttonVariants, type ButtonProps } from "./button";
export { Wordmark, WORDMARK, type WordmarkProps } from "./wordmark/Wordmark";
export { Badge, badgeVariants, type BadgeProps } from "./badge";
export { StatusPill, type StatusPillProps } from "./status-pill";
export {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningSummary,
  type ReasoningProps,
  type ReasoningTriggerProps,
  type ReasoningContentProps,
  type ReasoningSummaryProps,
} from "./agentic/Reasoning";
export {
  ChainOfThought,
  ChainOfThoughtStep,
  chainOfThoughtStepStatus,
  type ChainOfThoughtProps,
  type ChainOfThoughtStepProps,
  type ChainOfThoughtStepStatus,
} from "./agentic/ChainOfThought";
export {
  ToolCall,
  ToolCallHeader,
  ToolCallContent,
  ToolCallInput,
  ToolCallOutput,
  ToolCallError,
  ToolCallApproval,
  toolCallStatus,
  TOOL_CALL_STATE_LABELS,
  type ToolCallProps,
  type ToolCallState,
  type ToolResultPart,
  type ToolCallHeaderProps,
  type ToolCallContentProps,
  type ToolCallInputProps,
  type ToolCallOutputProps,
  type ToolCallErrorProps,
  type ToolCallApprovalProps,
} from "./agentic/ToolCall";
export { formatJsonSafe } from "./agentic/formatJsonSafe";
export { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter } from "./card";
export { Input, Textarea } from "./input";
export { Label, Field } from "./label";
export { ChatMessage, type ChatMessageProps, type ChatMessageRole } from "./chat/ChatMessage";
export { ChatTranscript, type ChatTranscriptProps } from "./chat/ChatTranscript";
export { ChatComposer, type ChatComposerError, type ChatComposerProps, type ChatComposerStatus } from "./chat/ChatComposer";
export {
  type ChatComposerCompletions,
  CompletionList,
  type CompletionListProps,
  type ComposerCompletion,
} from "./chat/CompletionList";
export {
  type SlashCommand,
  type SlashCompletion,
  type SlashMenu,
  slashMenu,
  type SlashSubmit,
  slashSubmit,
} from "./slash-commands";
export {
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageVisibility,
  useMessageBand,
  useMessageScrollerState,
  type MessageScrollerCommands,
  type MessageScrollerProviderProps,
  type MessageScrollerViewportProps,
  type MessageScrollerContentProps,
  type MessageScrollerItemProps,
  type MessageScrollerButtonProps,
} from "./chat/MessageScroller";
export {
  Bubble,
  BubbleContent,
  BubbleActions,
  BubbleReactions,
  bubbleVariants,
  type BubbleProps,
  type BubbleReaction,
  type BubbleReactionsProps,
} from "./chat/Bubble";
export {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
  AttachmentTrigger,
  AttachmentGroup,
  AttachmentPreview,
  AttachmentRemove,
  type AttachmentProps,
  type AttachmentState,
  type AttachmentActionProps,
  type AttachmentPreviewProps,
} from "./chat/Attachment";
export { Marker, type MarkerProps } from "./chat/Marker";
export { Shimmer, type ShimmerProps } from "./chat/Shimmer";
export { Alert, AlertTitle, AlertDescription, alertVariants, type AlertProps } from "./alert";
export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption } from "./table";
export { Tabs, TabsList, TabsTrigger, TabsContent, type TabsTriggerProps } from "./tabs";
export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  type DialogContentProps,
} from "./dialog";
export { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "./tooltip";
export {
  Plan,
  PlanHeader,
  PlanTitle,
  PlanDescription,
  PlanTrigger,
  PlanContent,
  PlanStep,
  PlanAction,
  PlanFooter,
  planStepStatus,
  type PlanProps,
  type PlanStepStatus,
  type PlanStepProps,
} from "./agentic/Plan";
export { TaskItem, TaskItemFile, type TaskItemProps, type TaskItemFileProps } from "./agentic/TaskItem";
export {
  Sources,
  SourcesTrigger,
  SourcesContent,
  Source,
  type SourcesProps,
  type SourceItem,
  type SourcesTriggerProps,
  type SourcesContentProps,
  type SourceProps,
} from "./agentic/Sources";
export {
  InlineCitation,
  CitationCard,
  CitationCarousel,
  CitationQuote,
  type InlineCitationProps,
  type CitationSource,
  type CitationCardProps,
  type CitationCarouselProps,
  type CitationQuoteProps,
} from "./agentic/InlineCitation";
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from "./select";
export { Progress, type ProgressProps } from "./progress";
export { Separator } from "./separator";
export { Skeleton } from "./skeleton";
export { LOADING_DELAY_MS, LoadingBar, type LoadingBarProps } from "./loading";
export { intentPath, LinkIntent, type LinkIntentProps } from "./link-intent";
export { formatRelativeTime } from "./time/formatRelativeTime";
export { RelativeTime, useRelativeTime, type RelativeTimeProps } from "./time/RelativeTime";
export { useDialogFocusTrap, type UseDialogFocusTrapOptions } from "./internal/useDialogFocusTrap";
export { EmptyState, type EmptyStateProps } from "./empty-state";
export { Breadcrumbs, type BreadcrumbItem, type BreadcrumbsProps } from "./breadcrumbs";
export { Popover, PopoverTrigger, PopoverContent } from "./popover";
export { RefPicker, type RefPickerProps, type RefPickerRef, type RefPickerRefs } from "./ref-picker";
export { GeneratedChip, type GeneratedChipLink, type GeneratedChipProps } from "./generated-chip";
export {
  formatCount,
  languageShares,
  RepoAbout,
  type RepoAboutContributor,
  type RepoAboutLanguage,
  type RepoAboutProps,
  type RepoAboutRelease,
} from "./repo-about";
export { CopyButton, type CopyButtonProps } from "./copy-button";
export { Kbd, type KbdProps } from "./kbd";
export { SegmentedControl, type SegmentedControlOption, type SegmentedControlProps } from "./segmented-control";
export { CommandPalette, type CommandPaletteItem, type CommandPaletteProps } from "./command-palette";
export { commandPaletteCss, kbdCss, segmentedControlCss } from "./commandCss";
// Branch sharing: presence avatars and the share dialog.
export { AvatarStack, type AvatarStackPerson, type AvatarStackProps } from "./avatar-stack";
export {
  type Collaborator,
  CollaboratorCarets,
  type CollaboratorCaretsProps,
  type FieldSelection,
  selectionOf,
  useSharedSelection,
} from "./collaborators";
export { collaboratorsCss } from "./collaboratorsCss";
export { PERSON_LANES, personLane } from "./internal/person";
export {
  ShareDialog,
  type ShareAccess,
  type ShareDialogProps,
  type ShareGeneral,
  type SharePerson,
} from "./share-dialog";
export { avatarStackCss, shareDialogCss } from "./sharingCss";
export {
  DirectoryListing,
  type DirectoryEntry,
  type DirectoryListingProps,
  type DirectoryTarget,
} from "./directory-listing";
export { SectionHeader, Eyebrow, type SectionHeaderProps } from "./section-header";
export { RowButton, type RowButtonProps } from "./row-button";
export { KpiStat, type KpiStatProps } from "./kpi-stat";
export { StageStrip, stageTone, type StageStripProps, type StageStripItem, type StageTone } from "./stage-strip";
export { CollapsiblePanel, type CollapsiblePanelProps } from "./collapsible-panel";
export { DiffHunks, type DiffHunksProps } from "./diff-hunks";
export type { Diff, DiffFile, DiffFileStatus, DiffLine, DiffLineKind, Hunk } from "./diff";
export {
  binaryBodyLabel,
  byteCountString,
  decodeGitPath,
  detectBinary,
  diffTotals,
  fileLineCount,
  fileStatus,
  groupHunks,
  initialExpanded,
  isLargeDiff,
  paginateHunks,
  parseHunks,
  parseUnifiedFile,
  statusLetter,
  totalBytes,
  LARGE_BYTE_LIMIT,
  LARGE_FILE_COUNT,
  PAGINATE_THRESHOLD,
  PAGINATE_VISIBLE,
  type ParseUnifiedFileOverrides,
} from "./diff-paginate";
export type { DataAttributes } from "./data-attributes";
export {
  FileTree,
  type FileTreeDirectoryProps,
  type FileTreeItem,
  type FileTreeNode,
  type FileTreeNodeProps,
  type FileTreeProps,
} from "./file-tree";
export { Markdown, type MarkdownProps, type MarkdownLinkClick, type MarkdownVariant, type MarkdownImageResolver } from "./primitives/markdown";
export { MessageResponse, type MessageResponseProps } from "./agentic/MessageResponse";
export {
  AgentOutput,
  type AgentOutputProps,
  type AgentOutputModel,
  type AgentOutputToolCall,
} from "./agentic/AgentOutput";
export { parseAgentOutput } from "./agentic/parseAgentOutput";
export {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockFilename,
  CodeBlockGroup,
  CodeBlockTabs,
  type CodeBlockProps,
  type CodeBlockHighlighter,
  type CodeBlockHeaderProps,
  type CodeBlockFilenameProps,
  type CodeBlockGroupProps,
  type CodeBlockGroupItem,
  type CodeBlockTabsProps,
  type HighlightLine,
  type HighlightedToken,
} from "./agentic/CodeBlock";

// lane:conversation-foundation
export {
  Message,
  MessageAvatar,
  MessageHeader,
  MessageContent,
  MessageFooter,
  MessageActions,
  MessageGroup,
  type MessageProps,
  type MessageRole,
  type MessageAvatarProps,
  type MessageActionsProps,
} from "./chat/Message";
export {
  MessageBranch,
  MessageBranchContent,
  MessageBranchSelector,
  MessageBranchPrevious,
  MessageBranchNext,
  MessageBranchPage,
  type MessageBranchProps,
} from "./chat/MessageBranch";
export { CompactGroup, type CompactGroupProps } from "./chat/CompactGroup";
export { ConversationCheckpoint, type ConversationCheckpointProps } from "./chat/ConversationCheckpoint";

// lane:prompt-attachments
export {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  PromptInputStop,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  usePromptInputAttachments,
  type PromptInputProps,
  type PromptInputAttachmentItem,
  type PromptInputMessage,
  type PromptInputStatus,
  type PromptInputError,
  type PromptInputTextareaProps,
  type PromptInputActionMenuProps,
} from "./prompt/PromptInput";

// lane:reasoning-tools
export { formatPartialJson } from "./agentic/formatPartialJson";

// lane:plans-tasks-queues
export {
  AgentTask,
  AgentTaskTrigger,
  AgentTaskContent,
  AgentTaskGroup,
  type AgentTaskContentProps,
  type AgentTaskProps,
} from "./agentic/AgentTask";
export {
  Queue,
  QueueSection,
  QueueSectionTrigger,
  QueueSectionLabel,
  QueueSectionContent,
  QueueList,
  QueueItem,
  QueueItemIndicator,
  QueueItemContent,
  QueueItemDescription,
  type QueueSectionProps,
  type QueueSectionLabelProps,
  type QueueItemProps,
  type QueueItemIndicatorProps,
} from "./agentic/Queue";
export {
  ActivityTimeline,
  ActivityItem,
  ActivityGroup,
  type ActivityTimelineProps,
  type ActivityItemProps,
  type ActivityGroupProps,
  type ActivityKind,
  type ActivityItemModel,
} from "./agentic/ActivityTimeline";

// lane:approvals-checkpoints exports (integration: keep)
export {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationActions,
  ConfirmationAction,
  approvalStateToStatus,
  approvalStateLabel,
  type ConfirmationProps,
  type ConfirmationActionProps,
  type ApprovalState,
} from "./approvals/Confirmation";
export {
  ApprovalCard,
  ApprovalRisk,
  ApprovalResources,
  ApprovalNote,
  type ApprovalCardProps,
  type ApprovalRiskProps,
  type ApprovalResourcesProps,
  type ApprovalNoteProps,
  type ApprovalRiskLevel,
  type ApprovalResource,
} from "./approvals/ApprovalCard";
export {
  Checkpoint,
  CheckpointIcon,
  CheckpointMetadata,
  CheckpointTrigger,
  CheckpointActions,
  useCheckpoint,
  CHECKPOINT_ACTION_KINDS,
  type CheckpointProps,
  type CheckpointModel,
  type CheckpointActionKind,
  type CheckpointTriggerProps,
  type CheckpointActionsProps,
} from "./approvals/Checkpoint";

// lane:sources-citations
export { Suggestion, SuggestionGroup, type SuggestionProps, type SuggestionGroupProps } from "./agentic/Suggestion";
export {
  OpenInChat,
  type OpenInChatProps,
  type OpenInChatSubject,
  type OpenInChatSubjectKind,
} from "./agentic/OpenInChat";

// lane:agent-identity-context
export {
  AgentDefinition,
  AgentHeader,
  AgentContent,
  AgentInstructions,
  AgentTools,
  AgentTool,
  AgentOutputSchema,
  AgentAvailabilityBadge,
  availabilityLabel,
  type AgentDefinitionProps,
  type AgentAvailability,
  type AgentToolDescriptorModel,
  type AgentAvailabilityBadgeProps,
  type AgentInstructionsProps,
  type AgentToolProps,
  type AgentOutputSchemaProps,
} from "./agents/AgentDefinition";
export { AgentCard, type AgentCardProps } from "./agents/AgentCard";
export {
  ModelSelector,
  ModelSelectorTrigger,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorItem,
  type ModelSelectorProps,
  type ModelOption,
  type ModelSelectorItemProps,
} from "./agents/ModelSelector";
export { ModelBadge, ProviderBadge, type ModelBadgeProps, type ProviderBadgeProps } from "./agents/badges";
export {
  ContextUsage,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
  ContextContentFooter,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextCacheUsage,
  contextUsagePercent,
  type ContextUsageProps,
  type TokenUsageModel,
} from "./agents/ContextUsage";

// lane:coding-artifacts
export {
  Artifact,
  ArtifactHeader,
  ArtifactTitle,
  ArtifactDescription,
  ArtifactActions,
  ArtifactAction,
  ArtifactClose,
  ArtifactContent,
  type ArtifactActionProps,
  type ArtifactCloseProps,
} from "./artifacts/Artifact";
export { Snippet, type SnippetProps } from "./artifacts/Snippet";
export { PackageInfo, type PackageInfoProps } from "./artifacts/PackageInfo";
export { SchemaDisplay, type SchemaDisplayProps } from "./artifacts/SchemaDisplay";
export {
  StackTrace,
  StackFrame,
  parseStackTrace,
  type StackTraceProps,
  type StackFrameProps,
  type StackFrameData,
} from "./artifacts/StackTrace";
export {
  TestResults,
  TestResultsHeader,
  TestResultsSummary,
  TestResultsDuration,
  TestResultsProgress,
  TestResultsContent,
  TestSuite,
  TestSuiteName,
  TestSuiteStats,
  TestSuiteContent,
  TestRow,
  TestStatus,
  TestName,
  testCaseStatusToStatus,
  formatTestDuration,
  type TestResultsProps,
  type TestResultsDurationProps,
  type TestSuiteProps,
  type TestRowProps,
  type TestStatusProps,
  type TestCaseStatus,
  type TestCaseModel,
  type TestSuiteModel,
} from "./artifacts/TestResults";
export {
  Commit,
  CommitHeader,
  CommitAuthor,
  CommitInfo,
  CommitMessage,
  CommitMetadata,
  CommitHash,
  CommitTimestamp,
  CommitActions,
  CommitFiles,
  CommitFile,
  CommitFileStatus,
  CommitFilePath,
  useCommitModel,
  type CommitProps,
  type CommitModel,
  type CommitFileModel,
  type CommitFileStatusKind,
  type CommitHashProps,
  type CommitTimestampProps,
  type CommitFileProps,
  type CommitFileStatusProps,
  type CommitFilePathProps,
} from "./artifacts/Commit";
export { ChangeSummary, type ChangeSummaryProps } from "./artifacts/ChangeSummary";
export {
  EnvironmentVariables,
  EnvironmentVariable,
  type EnvironmentVariablesProps,
  type EnvironmentVariableProps,
  type EnvironmentVariableModel,
} from "./artifacts/EnvironmentVariables";
export { SecretField, type SecretFieldProps } from "./artifacts/SecretField";

// lane:sandbox-previews
export {
  Sandbox,
  SandboxHeader,
  SandboxStatus,
  SandboxActions,
  SandboxContent,
  sandboxStateToStatus,
  type SandboxProps,
  type SandboxStatusProps,
  type SandboxActionsProps,
  type SandboxState,
} from "./sandbox/AgentSandbox";
export {
  WebPreview,
  WebPreviewToolbar,
  WebPreviewAddress,
  WebPreviewContent,
  type WebPreviewProps,
  type WebPreviewToolbarProps,
  type WebPreviewAddressProps,
  type WebPreviewContentProps,
  type WebPreviewSandboxToken,
} from "./sandbox/WebPreview";
export { JSXPreview, type JSXPreviewProps } from "./sandbox/JSXPreview";

// lane:workflow-canvas exports (integration: keep)
export {
  WorkflowCanvas,
  WorkflowNode,
  WorkflowNodeHeader,
  WorkflowNodeContent,
  WorkflowNodeStatus,
  WorkflowEdge,
  WorkflowConnection,
  WorkflowControls,
  WorkflowPanel,
  WorkflowToolbar,
  WorkflowMinimap,
  type WorkflowCanvasProps,
  type WorkflowNodeProps,
  type WorkflowNodeStatusProps,
  type WorkflowEdgeProps,
  type WorkflowConnectionProps,
  type WorkflowControlsProps,
  type WorkflowPanelProps,
} from "./canvas/WorkflowCanvas";

// lane:calendar exports (integration: keep)
//
// Named rather than `export *`: a wildcard cannot tell a pure helper from a
// heavy renderer, so a future addition to the lane barrel would ride into this
// bundle silently. That is exactly how d3-force reached it through the vault
// lane. `tests/barrel-weight.test.ts` measures the result.
export { Calendar, type CalendarProps } from "./calendar/Calendar";
export type { CalendarEvent, CalendarView } from "./calendar/types";
export { CALENDAR_CSS_ID, calendarCss } from "./calendar/calendarCss";
export {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  addDays,
  addMonths,
  agendaGroups,
  atMinutesIntoDay,
  dayKey,
  daysInMonth,
  eventsOnDay,
  fullDayLabel,
  hashSource,
  hourLabel,
  isSameDay,
  minutesIntoDay,
  monthGridDays,
  monthLabel,
  snapDown30,
  snapUp30,
  startOfDay,
  timeLabel,
  weekDays,
  weekLabel,
  weekdayLabel,
  type AgendaDayGroup,
} from "./calendar/dateUtils";

// lane:vault exports (integration: keep)
//
// `KnowledgeGraph` is not here and must not be added: it renders over d3-force
// and ships from `@smthrs/ui/adapters/knowledge-graph`.
export {
  NOTE_HREF,
  joinFrontmatter,
  noteHref,
  noteLabel,
  parseWikilinks,
  pathFromHref,
  restoreWikilinks,
  splitFrontmatter,
  wikilinksToMarkdown,
  type Wikilink,
} from "./vault/wikilinks";
export type { VaultAdapter, VaultLink, VaultNoteMeta } from "./vault/types";
export {
  GRAPH_FOLDER_TINTS,
  HUB_LABEL_MIN_DEGREE,
  computeGraphModel,
  folderHue,
  folderTint,
  folderTintIndex,
  neighbourSet,
  nodeRadius,
  noteFolder,
  shouldShowLabel,
  type GraphFolderTint,
  type VaultGraphEdge,
  type VaultGraphNode,
} from "./vault/graphModel";
export { VAULT_CSS_ID, vaultCss } from "./vault/vaultCss";
export { useVaultCss } from "./vault/useVaultCss";
export { BacklinksPanel, type BacklinksPanelProps } from "./vault/BacklinksPanel";
export { OutlineView, parseOutline, type OutlineHeading, type OutlineViewProps } from "./vault/OutlineView";
export {
  AUTOSAVE_STATUS_TEXT,
  autosaveStatusText,
  createAutosaveDoc,
  type AutosaveDoc,
  type AutosaveDocOptions,
  type AutosaveFailure,
  type AutosaveFailureCode,
  type AutosaveRevision,
  type AutosaveSaveResult,
  type AutosaveSnapshot,
  type AutosaveState,
} from "./vault/autosaveMachine";
export { useAutosaveDoc, type UseAutosaveDocOptions, type UseAutosaveDocResult } from "./vault/useAutosaveDoc";

export { copyText, canCopyText, reserveCopyText, type CopyResult, type CopyFailureCode } from "./internal/copyToClipboard";

// Agent UI (decision 0004): generated views in a sandboxed frame, the
// presentation subset a view may import, and the form and issues templates.
export {
  GeneratedView,
  generatedViewCss,
  sanitizeViewHtml,
  type GeneratedViewInteraction,
  type GeneratedViewProps,
} from "./generated-view";
export { frameRuntime } from "./generated-view/runtime.generated";
export { loadPresentationBundle, presentationComponentNames, presentationComponents } from "./presentation";
export { FlowFormView, flowFormViewCss, type FlowFormSubmission, type FlowFormViewProps } from "./flow-form-view";
export {
  ITEM_STATE_VARIANTS,
  ItemStateIcon,
  IssuesView,
  issuesViewCss,
  TRIAGE_WORDS,
  type IssuesViewFilter,
  type IssuesViewIssue,
  type IssuesViewLink,
  type IssuesViewProps,
  type IssuesViewState,
  type IssuesViewTriage,
  type ItemStateIconProps,
  type ItemStateKind,
  type ItemStatus,
} from "./issues-view";
// A quiet `⋯` menu of actions, and a button that confirms before it acts.
export {
  ActionMenu,
  actionMenuCss,
  ConfirmButton,
  type ActionConfirm,
  type ActionMenuItem,
  type ActionMenuProps,
  type ConfirmButtonProps,
} from "./action-menu";
export {
  IssueForm,
  ItemAsideSection,
  ItemConversation,
  itemConversationCss,
  type IssueFormProps,
  type ItemAsideSectionProps,
  type ItemConversationComment,
  type ItemConversationComposer,
  type ItemConversationEvent,
  type ItemConversationProps,
} from "./item-conversation";
export { TriageControl, triageControlCss, type TriageControlProps } from "./triage-control";
// The agent's status (apps/mvp decision 0015): the pill, the needs-you card, the toast stack and the tab title; and
// notices (decision 0009 §4): their words, glyphs and keys, when a notice's toast shows, and the notifications panel.
export {
  AGENT_STATES,
  AGENT_STATUS_GLYPHS,
  AGENT_STATUS_WORDS,
  agentStatusCss,
  AgentStatusPill,
  agentStatusTitle,
  answerText,
  isAgentState,
  isNoticeHotkey,
  isTypingTarget,
  NeedsYouCard,
  NOTICE_GLYPHS,
  NOTICE_KEYS,
  NOTICE_WORDS,
  noticeDismissDelay,
  noticeKeyAction,
  NotificationBell,
  NotificationEntry,
  NotificationPanel,
  Toast,
  ToastStack,
  workNoticeVisible,
  type AgentState,
  type AgentStatusPillProps,
  type NeedsYouAnswer,
  type NeedsYouCardProps,
  type NeedsYouKind,
  type NoticeKeyAction,
  type NoticeKeyEvent,
  type NoticeState,
  type NotificationBellProps,
  type NotificationEntryProps,
  type NotificationPanelProps,
  type NotificationStep,
  type ToastProps,
  type ToastStackProps,
} from "./agent-status";
// Runs and flows (apps/mvp decision 0014): a redacted, clipped value as text; the run page's list, header, steps,
// timeline and journal; and the card a flow is drafted in.
export { formatBytes, JsonValue, jsonValueCss, jsonValueText, type JsonValueData, type JsonValueProps } from "./json-value";
export {
  type AttemptRow,
  attemptWords,
  clockDuration,
  isSettled,
  type JournalRow,
  offsetWords,
  RUN_WORD_GLYPHS,
  RUN_WORD_TONES,
  RUN_WORDS,
  RunDetails,
  type RunDetailsJob,
  type RunDetailsProps,
  type RunDetailsStep,
  RunHeader,
  type RunHeaderProps,
  RunJournal,
  type RunJournalProps,
  RunList,
  type RunListProps,
  runPageCss,
  type RunRow,
  type RunState,
  RunStatusPill,
  type RunStatusPillProps,
  type RunTone,
  RunWaterfall,
  type RunWaterfallProps,
  type RunWord,
  runWord,
  SpanDetail,
  type SpanDetailProps,
  SpanTree,
  type SpanTreeProps,
  STEP_GLYPHS,
  STEP_WORDS,
  stepDuration,
  stepElapsed,
  type StepRow,
  type StepState,
  untilWords,
  type WaitData,
  waitWords,
  waterfallAxis,
  type WaterfallBar,
  waterfallBars,
} from "./run-page";
export {
  answersToSend,
  changedAnswers,
  type DraftCheck,
  type DraftFile,
  type DraftQuestion,
  type DraftStatus,
  draftStatusLine,
  FlowDraftView,
  type FlowDraftViewProps,
  flowDraftViewCss,
  isAssumed,
  questionValue,
} from "./flow-draft-view";
// An editor's strip of open files.
export { type FileTab, FileTabs, type FileTabsProps, type FileTabsFocusEvent } from "./file-tabs";
// A repository's home: the blocks its `.smithers/home.json` declares (`Home` in `@smthrs/views`).
export { LinkTabs, type LinkTabsProps } from "./link-tabs";
export {
  RepositoryHome,
  repositoryHomeCss,
  type RepositoryHomeEntry,
  type RepositoryHomeFile,
  type RepositoryHomeFlow,
  type RepositoryHomeIssues,
  type RepositoryHomeList,
  type RepositoryHomeLive,
  type RepositoryHomeNotice,
  type RepositoryHomeProps,
  type RepositoryHomeRuns,
} from "./repository-home";
// A TODO's private draft (apps/mvp decision 0016 §3); the stack itself is an `IssuesView`, and one TODO an `ItemConversation`.
export { TodoDraftCard, todoDraftCardCss, type TodoDraftCardProps } from "./stack";
// An outside web page: in a sandboxed frame, or as a card that opens a tab.
export {
  framedPageTarget,
  WEB_PAGE_SANDBOX,
  WebLinkCard,
  WebPageView,
  webPageCss,
  webPageTarget,
  type WebLinkCardProps,
  type WebPagePreview,
  type WebPageTarget,
  type WebPageViewProps,
} from "./web-page";
export { DocsPageView, docsPageCss, docsPageTarget, type DocsPageViewProps } from "./docs-page";
export {
  declaredInput,
  formFieldsFor,
  type FieldKind,
  type FieldValue,
  type FormDraft,
  type FormField,
  type FormHints,
} from "./flow-form";
export * from "./flow-graph";

export { ChatTimeline, timelineKey, timelineLabel, timelineCapacity, timelineLevelCount, timelineLevels, type TimelineBlock, type TimelineLevel, type ChatTimelineEntry, type ChatTimelineProps } from "./chat/ChatTimeline";
