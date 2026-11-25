/** @jsxImportSource react */
import { useId } from "react";
import { Badge } from "../badge";
import { Button } from "../button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "../card";
import { cn } from "@smthrs/ui-css";
import { Input } from "../input";
import { Label } from "../label";
import { useInjectUiCss } from "../styles";

export type WaitlistStatus = "idle" | "submitting" | "submitted" | "error";

export type WaitlistCardProps = {
  readonly repoUrl: string;
  readonly workflowNote?: string;
  readonly status: WaitlistStatus;
  readonly position?: number;
  readonly errorMessage?: string;
  readonly onRepoUrlChange: (value: string) => void;
  readonly onWorkflowNoteChange?: (value: string) => void;
  readonly onSubmit: () => void;
  readonly className?: string;
};

function isValidRepositoryUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * High-desire repository waitlist card triggered when a non-maintainer
 * requests hosting or maintainer access for their own repository.
 */
export function WaitlistCard({
  repoUrl,
  workflowNote = "",
  status,
  position,
  errorMessage,
  onRepoUrlChange,
  onWorkflowNoteChange,
  onSubmit,
  className,
}: WaitlistCardProps) {
  useInjectUiCss();
  const baseId = useId();
  const repoInputId = `${baseId}-repo`;
  const workflowInputId = `${baseId}-workflow`;
  const validUrl = isValidRepositoryUrl(repoUrl);
  const canSubmit = status !== "submitting" && validUrl;

  const content = (
    <>
      <CardHeader>
        <CardTitle>Host your repository on smithers.sh</CardTitle>
        <CardAction>
          <Badge variant={status === "submitted" ? "success" : "default"}>
            {status === "submitted" ? "Waitlist confirmed" : "Maintainer access"}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {status === "submitted" ? (
          <div data-slot="waitlist-receipt" style={{ fontSize: "13px" }}>
            Queued for {repoUrl}
            {position !== undefined ? ` (position ${position})` : ""}.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <Label htmlFor={repoInputId}>Repository URL</Label>
              <Input
                id={repoInputId}
                type="url"
                required
                placeholder="https://github.com/org/repo"
                value={repoUrl}
                aria-invalid={repoUrl.trim().length > 0 && !validUrl}
                onChange={(event) => onRepoUrlChange(event.currentTarget.value)}
                disabled={status === "submitting"}
              />
            </div>

            {onWorkflowNoteChange ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <Label htmlFor={workflowInputId}>First workflow to run</Label>
                <Input
                  id={workflowInputId}
                  type="text"
                  placeholder=".smithers/workflows/ci.vibe"
                  value={workflowNote}
                  onChange={(event) => onWorkflowNoteChange(event.currentTarget.value)}
                  disabled={status === "submitting"}
                />
              </div>
            ) : null}

            {status === "error" && errorMessage ? (
              <div role="alert" data-slot="waitlist-error" style={{ fontSize: "12.5px", color: "var(--danger, #a4442a)" }}>
                {errorMessage}
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      {status !== "submitted" ? (
        <CardFooter>
          <Button type="submit" disabled={!canSubmit}>
            {status === "submitting" ? "Requesting access" : "Request maintainer access"}
          </Button>
        </CardFooter>
      ) : null}
    </>
  );

  return (
    <Card data-slot="waitlist-card" data-waitlist-status={status} className={cn(className)}>
      {status === "submitted" ? (
        content
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSubmit();
          }}
        >
          {content}
        </form>
      )}
    </Card>
  );
}
