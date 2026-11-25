/** @jsxImportSource react */
import { Badge } from "../badge";
import { Button } from "../button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "../card";
import { cn } from "@smthrs/ui-css";
import { CopyButton } from "../copy-button";
import { useInjectUiCss } from "../styles";

export type AttachTransportMode = "local-stdio" | "remote-http";

export type AttachConnectionState = "unattached" | "consent_pending" | "connected" | "revoked";

export type AttachAgentCardProps = {
  readonly mode: AttachTransportMode;
  readonly state: AttachConnectionState;
  readonly promptText: string;
  readonly agentLabel?: string;
  readonly repoSlug?: string;
  readonly branch?: string;
  readonly onCopyPrompt?: (text: string) => void | Promise<void>;
  readonly onModeChange?: (mode: AttachTransportMode) => void;
  readonly onApproveConsent?: () => void;
  readonly onDetach?: () => void;
  readonly className?: string;
};

const STATE_LABEL: Record<AttachConnectionState, string> = {
  unattached: "Ready to attach",
  consent_pending: "Review access",
  connected: "Connected",
  revoked: "Disconnected",
};

/**
 * Pure BYOA MCP attach surface. Users copy one zero-secret prompt into Claude Code,
 * Codex, Antigravity, or Cursor and confirm scoped repository access on this origin.
 */
export function AttachAgentCard({
  mode,
  state,
  promptText,
  agentLabel,
  repoSlug,
  branch,
  onCopyPrompt,
  onModeChange,
  onApproveConsent,
  onDetach,
  className,
}: AttachAgentCardProps) {
  useInjectUiCss();

  const cleanRepo = repoSlug?.trim() ?? "";
  const cleanBranch = branch?.trim() ?? "";
  const cleanAgent = agentLabel?.trim() ?? "";
  const hasScopeContext = cleanRepo.length > 0 || cleanBranch.length > 0 || cleanAgent.length > 0;
  const hasCompleteConsentScope = cleanRepo.length > 0 && cleanAgent.length > 0;
  const canApprove = state === "consent_pending" && Boolean(onApproveConsent) && hasCompleteConsentScope;

  return (
    <Card data-slot="attach-agent-card" data-attach-state={state} className={cn(className)}>
      <CardHeader>
        <CardTitle>Attach your agent</CardTitle>
        <CardAction>
          <Badge variant={state === "connected" ? "success" : state === "consent_pending" ? "warning" : "secondary"}>
            {STATE_LABEL[state]}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {hasScopeContext ? (
          <div data-slot="attach-agent-scope" style={{ display: "flex", gap: "6px", flexWrap: "wrap", fontSize: "12px" }}>
            {cleanRepo ? <Badge variant="outline">{cleanRepo}</Badge> : null}
            {cleanBranch ? <Badge variant="muted">{cleanBranch}</Badge> : null}
            {cleanAgent ? <Badge variant="secondary">{cleanAgent}</Badge> : null}
          </div>
        ) : null}

        {state === "consent_pending" ? (
          <div
            data-slot="attach-consent-summary"
            role={hasCompleteConsentScope ? "status" : "alert"}
            style={{ fontSize: "12.5px", padding: "8px 10px", borderRadius: "6px", background: "var(--surface-2, #efeae0)" }}
          >
            {hasCompleteConsentScope
              ? `Allow ${cleanAgent} on ${cleanRepo}${cleanBranch ? ` (${cleanBranch})` : ""}`
              : "Missing agent or repository scope. Cannot approve access."}
          </div>
        ) : null}

        {onModeChange && state !== "connected" ? (
          <div role="group" aria-label="MCP transport" style={{ display: "flex", gap: "6px" }}>
            <Button
              type="button"
              aria-pressed={mode === "local-stdio"}
              size="sm"
              variant={mode === "local-stdio" ? "default" : "ghost"}
              onClick={() => onModeChange("local-stdio")}
            >
              Local CLI (MCP)
            </Button>
            <Button
              type="button"
              aria-pressed={mode === "remote-http"}
              size="sm"
              variant={mode === "remote-http" ? "default" : "ghost"}
              onClick={() => onModeChange("remote-http")}
            >
              Hosted MCP
            </Button>
          </div>
        ) : null}

        {state !== "connected" ? (
          <pre
            data-slot="attach-agent-prompt"
            style={{
              margin: 0,
              padding: "10px 12px",
              borderRadius: "6px",
              background: "var(--surface-2, #efeae0)",
              fontSize: "12px",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {promptText}
          </pre>
        ) : null}
      </CardContent>

      <CardFooter style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {state !== "connected" && onCopyPrompt ? (
          <CopyButton onCopy={() => onCopyPrompt(promptText)}>Copy prompt</CopyButton>
        ) : null}
        {state === "consent_pending" && onApproveConsent ? (
          <Button
            type="button"
            size="sm"
            disabled={!canApprove}
            onClick={() => {
              if (canApprove) onApproveConsent();
            }}
          >
            Approve access
          </Button>
        ) : null}
        {state === "connected" && onDetach ? (
          <Button type="button" size="sm" variant="outline" onClick={onDetach}>
            Detach
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
