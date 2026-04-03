
import { Task } from "../smithers";
import { z } from "zod";
import { codex } from "../agents";
import ImplementPrompt from "./Implement.mdx";
import { useCtx, tables } from "../smithers";
import type { Ticket } from "./Discover.schema";
import type { ImplementOutput } from "./Implement.schema";
import type { ValidateOutput } from "./Validate.schema";
import type { ReviewOutput } from "./Review.schema";

interface ImplementProps {
  ticket: Ticket;
}

export function Implement({ ticket }: ImplementProps) {
  const ctx = useCtx();
  const ticketId = ticket.id;

  const latestImplement = ctx.latest(tables.implement, `${ticketId}:implement`) as ImplementOutput | undefined;
  const latestValidate = ctx.latest(tables.validate, `${ticketId}:validate`) as ValidateOutput | undefined;

  const claudeReview = ctx.latest(tables.review, `${ticketId}:review-claude`) as ReviewOutput | undefined;
  const codexReview = ctx.latest(tables.review, `${ticketId}:review-codex`) as ReviewOutput | undefined;

  const issueItem = z.object({
    severity: z.string(),
    file: z.string(),
    line: z.number().nullable(),
    description: z.string(),
    suggestion: z.string().nullable(),
  });
  const reviewIssues = [
    ...ctx.latestArray(claudeReview?.issues, issueItem),
    ...ctx.latestArray(codexReview?.issues, issueItem),
  ];

  const reviewFeedback = [
    claudeReview?.feedback,
    codexReview?.feedback,
  ]
    .filter(Boolean)
    .join("\n\n");

  const reviewFixesSummary =
    reviewIssues.length > 0
      ? `Issues from review:\n${JSON.stringify(reviewIssues, null, 2)}\n\nFeedback:\n${reviewFeedback}`
      : null;

  return (
    <Task
      id={`${ticketId}:implement`}
      output={outputs.implement}
      agent={codex}
      timeoutMs={45 * 60 * 1000}
    >
      <ImplementPrompt
        ticketId={ticketId}
        ticketTitle={ticket.title}
        ticketDescription={ticket.description}
        acceptanceCriteria={ticket.acceptanceCriteria?.join("\n- ") ?? ""}
        filesToModify={ticket.filesToModify}
        filesToCreate={ticket.filesToCreate}
        previousImplementation={
          latestImplement
            ? {
                whatWasDone: latestImplement.whatWasDone ?? null,
                testOutput: latestImplement.testOutput ?? null,
              }
            : null
        }
        reviewFixes={reviewFixesSummary}
        validationFeedback={
          latestValidate
            ? {
                allPassed: latestValidate.allPassed ?? null,
                failingSummary: latestValidate.failingSummary ?? null,
              }
            : null
        }
      />
    </Task>
  );
}
