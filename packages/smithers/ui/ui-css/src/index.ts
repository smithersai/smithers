/** Framework-free Smithers component styles and their shared vocabulary. */
export * from "./action-menu/actionMenuCss.ts";
export * from "./adapters/xtermCss.ts";
export * from "./agent-status/agentStatusCss.ts";
export * from "./agentic/plansTasksQueuesCss.ts";
export * from "./agentic/reasoningToolsCss.ts";
export * from "./agentic/sourcesCitationsCss.ts";
export * from "./agents/agentsCss.ts";
export * from "./approvals/approvalsCss.ts";
export * from "./artifacts/artifactsCss.ts";
export * from "./calendar/calendarCss.ts";
export * from "./canvas/canvasCss.ts";
export * from "./chat/chatTimelineCss.ts";
export * from "./chat/conversationFoundationCss.ts";
export * from "./cn.ts";
export * from "./collaboratorsCss.ts";
export * from "./commandCss.ts";
export * from "./data-attributes.ts";
export * from "./docs-page/docsPageCss.ts";
export * from "./flow-draft-view/flowDraftViewCss.ts";
export * from "./flow-form-view/flowFormViewCss.ts";
export * from "./flow-graph/flowGraphCss.ts";
export * from "./generated-view/generatedViewCss.ts";
export * from "./issues-view/issuesViewCss.ts";
export * from "./item-conversation/itemConversationCss.ts";
export * from "./json-value/jsonValueCss.ts";
export * from "./loading-delay.ts";
export * from "./prompt/promptAttachmentsCss.ts";
export * from "./repository-home/repositoryHomeCss.ts";
export * from "./repositoryCss.ts";
export * from "./run-page/runPageCss.ts";
export * from "./sandbox/sandboxCss.ts";
export * from "./sharingCss.ts";
export * from "./stack/todoDraftCardCss.ts";
export * from "./status.ts";
export * from "./style-constants.ts";
export * from "./tokens.ts";
export * from "./triage-control/triageControlCss.ts";
export * from "./uiCss.ts";
export * from "./vault/vaultCss.ts";
export * from "./web-page/webPageCss.ts";
export * from "./wordmark/wordmarkCss.ts";

import { uiCss } from "./uiCss.ts";

/** The exact default stylesheet rendered by @smthrs/ui's SmithersUiStyles. */
export function smithersUiCss(): string {
  return uiCss;
}
