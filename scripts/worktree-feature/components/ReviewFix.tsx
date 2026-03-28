
import { Task, outputs } from "../smithers";
import { z } from "zod";
import { codex } from "../agents";
import { useCtx, tables } from "../smithers";
import ReviewFixPrompt from "./ReviewFix.mdx";
import type { Ticket } from "./Discover.schema";
import type { ReviewOutput } from "./Review.schema";
import type { ValidateOutput } from "./Validate.schema";

interface ReviewFixProps {
  ticket: Ticket;
}

export function ReviewFix({ ticket }: ReviewFixProps) {
  const ctx = useCtx();
  const ticketId = ticket.id;

  const claudeReview = ctx.latest(tables.review, `${ticketId}:review-claude`) as ReviewOutput | undefined;
  const codexReview = ctx.latest(tables.review, `${ticketId}:review-codex`) as ReviewOutput | undefined;

  const allApproved = !!claudeReview?.approved && !!codexReview?.approved;

  const latestValidate = ctx.latest(tables.validate, `${ticketId}:validate`) as ValidateOutput | undefined;
  const validationPassed = !!latestValidate?.allPassed;

  const issueItem = z.object({
    severity: z.string(),
    file: z.string(),
    line: z.number().nullable(),
    description: z.string(),
    suggestion: z.string().nullable(),
  });
  const allReviewIssues = [
    ...ctx.latestArray(claudeReview?.issues, issueItem),
    ...ctx.latestArray(codexReview?.issues, issueItem),
  ];

  const allReviewFeedback = [
    claudeReview?.feedback,
    codexReview?.feedback,
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <Task
      id={`${ticketId}:review-fix`}
      output={outputs.reviewFix}
      agent={codex}
      skipIf={!validationPassed || allApproved || allReviewIssues.length === 0}
    >
      <ReviewFixPrompt
        ticketId={ticketId}
        ticketTitle={ticket.title}
        issues={allReviewIssues}
        feedback={allReviewFeedback}
      />
    </Task>
  );
}
