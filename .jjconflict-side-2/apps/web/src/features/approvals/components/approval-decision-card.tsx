import type { Approval } from "@burns/shared"

import { NavLink } from "react-router-dom"
import { CheckCircle2, XCircle } from "lucide-react"

import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useApprovalDecision } from "@/features/approvals/hooks/use-approval-decision"
import { getApprovalConfirmationState } from "@/features/approvals/lib/approval-ui"
import { formatRelativeMinutes, formatTimestamp } from "@/features/workspace/lib/format"

function getSlaBadgeVariant(waitMinutes: number) {
  if (waitMinutes >= 30) {
    return "destructive"
  }

  if (waitMinutes >= 10) {
    return "outline"
  }

  return "secondary"
}

type ApprovalDecisionCardProps = {
  approval: Approval
  runHref?: string
  workspaceName?: string
}

const DEFAULT_DECIDED_BY = "Burns UI"

export function ApprovalDecisionCard({
  approval,
  runHref,
  workspaceName,
}: ApprovalDecisionCardProps) {
  const approvalDecision = useApprovalDecision(approval.workspaceId)
  const confirmationState = getApprovalConfirmationState(approval.status)

  const handleDecision = (decision: "approved" | "denied") => {
    approvalDecision.mutate({
      runId: approval.runId,
      nodeId: approval.nodeId,
      decision,
      input: {
        decidedBy: DEFAULT_DECIDED_BY,
      },
    })
  }

  return (
    <div className="rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          {workspaceName ? <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{workspaceName}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{approval.label}</p>
            <Badge variant={approval.status === "approved" ? "secondary" : approval.status === "denied" ? "destructive" : "outline"}>
              {approval.status === "pending" ? "Awaiting approval" : approval.status}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            run {approval.runId} • node {approval.nodeId}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {approval.status === "pending" ? (
            <Badge variant={getSlaBadgeVariant(approval.waitMinutes)}>
              waiting {formatRelativeMinutes(approval.waitMinutes)}
            </Badge>
          ) : approval.decidedAt ? (
            <Badge variant="outline">updated {formatTimestamp(approval.decidedAt)}</Badge>
          ) : null}
          {runHref ? (
            <Button size="sm" variant="outline" render={<NavLink to={runHref} />}>
              Open run
            </Button>
          ) : null}
        </div>
      </div>

      <Confirmation
        approval={{
          id: approval.id,
          approved: approval.status === "pending" ? undefined : approval.status === "approved",
          reason: approval.note,
        }}
        state={confirmationState}
        className="mt-3"
      >
        <ConfirmationTitle>
          {approval.status === "pending"
            ? "Approve or deny"
            : approval.status === "approved"
              ? "Approved"
              : "Denied"}
        </ConfirmationTitle>

        <ConfirmationRequest>
          <div className="space-y-1 text-sm text-foreground">
            <p>{`Run ${approval.runId} is paused on ${approval.nodeId}.`}</p>
            {approval.note ? <p className="text-muted-foreground">{approval.note}</p> : null}
          </div>
        </ConfirmationRequest>

        <ConfirmationAccepted>
          <div className="flex items-start gap-2 text-sm text-foreground">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            <div className="space-y-1">
              <p>Approved</p>
              {approval.note ? <p className="text-muted-foreground">{approval.note}</p> : null}
            </div>
          </div>
        </ConfirmationAccepted>

        <ConfirmationRejected>
          <div className="flex items-start gap-2 text-sm text-foreground">
            <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p>Denied</p>
              {approval.note ? <p className="text-muted-foreground">{approval.note}</p> : null}
            </div>
          </div>
        </ConfirmationRejected>

        <ConfirmationActions>
          <ConfirmationAction
            variant="outline"
            disabled={approvalDecision.isPending}
            onClick={() => handleDecision("denied")}
          >
            Deny
          </ConfirmationAction>
          <ConfirmationAction disabled={approvalDecision.isPending} onClick={() => handleDecision("approved")}>
            Approve
          </ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>

      {approvalDecision.error ? <p className="mt-2 text-sm text-destructive">{approvalDecision.error.message}</p> : null}
    </div>
  )
}
