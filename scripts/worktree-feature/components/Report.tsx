
import { Task } from "../smithers";
import { z } from "zod";
import { claude } from "../agents";
import { useCtx, tables } from "../smithers";
import ReportPrompt from "./Report.mdx";
import type { Ticket } from "./Discover.schema";
import type { ImplementOutput } from "./Implement.schema";
import type { ValidateOutput } from "./Validate.schema";
import type { ReviewOutput } from "./Review.schema";

interface ReportProps {
  ticket: Ticket;
}

export function Report({ ticket }: ReportProps) {
  const ctx = useCtx();
  const ticketId = ticket.id;

  const latestImplement = ctx.latest(tables.implement, `${ticketId}:implement`) as ImplementOutput | undefined;
  const claudeReview = ctx.latest(tables.review, `${ticketId}:review-claude`) as ReviewOutput | undefined;
  const codexReview = ctx.latest(tables.review, `${ticketId}:review-codex`) as ReviewOutput | undefined;
  const latestValidate = ctx.latest(tables.validate, `${ticketId}:validate`) as ValidateOutput | undefined;

  const allApproved = !!claudeReview?.approved && !!codexReview?.approved;
  const hasReviews = claudeReview != null || codexReview != null;
  const loopExhausted = hasReviews && !allApproved;

  const filesCreated = latestImplement?.filesCreated ?? [];
  const filesModified = latestImplement?.filesModified ?? [];
  const filesChanged = filesCreated.length + filesModified.length;
  const testsAdded = latestImplement?.testsWritten?.length ?? 0;
  const reviewRounds = Math.max(
    ctx.iterationCount(tables.review, `${ticketId}:review-claude`),
    ctx.iterationCount(tables.implement, `${ticketId}:implement`),
    1,
  );

  return (
    <Task
      id={`${ticketId}:report`}
      output={outputs.report}
      agent={claude}
      skipIf={!allApproved && !loopExhausted}
    >
      <ReportPrompt
        ticketId={ticketId}
        ticketTitle={ticket.title}
        whatWasDone={latestImplement?.whatWasDone ?? "No implementation data available"}
        filesChanged={filesChanged}
        testsAdded={testsAdded}
        reviewRounds={reviewRounds}
      />
    </Task>
  );
}
