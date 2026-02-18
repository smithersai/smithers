
import { Parallel } from "smithers";
import { Task } from "../smithers";
import { claude, codex } from "../agents";
import ReviewPrompt from "./Review.mdx";
import type { Ticket } from "./Discover.schema";
import type { ImplementOutput } from "./Implement.schema";
import type { ValidateOutput } from "./Validate.schema";
import { useCtx, tables } from "../smithers";

interface ReviewProps {
  ticket: Ticket;
}

export function Review({ ticket }: ReviewProps) {
  const ctx = useCtx();
  const ticketId = ticket.id;

  const latestImplement = ctx.latest(tables.implement, `${ticketId}:implement`) as ImplementOutput | undefined;
  const latestValidate = ctx.latest(tables.validate, `${ticketId}:validate`) as ValidateOutput | undefined;

  const validationPassed = !!latestValidate?.allPassed;

  if (!validationPassed) {
    return null;
  }

  const reviewProps = {
    ticketId,
    ticketTitle: ticket.title,
    ticketDescription: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria?.join("\n- ") ?? "",
    filesCreated: latestImplement?.filesCreated ?? [],
    filesModified: latestImplement?.filesModified ?? [],
    validationPassed: latestValidate?.allPassed ? "PASS" : "FAIL",
    failingSummary: latestValidate?.failingSummary ?? null,
  };

  return (
    <Parallel>
      <Task
        id={`${ticketId}:review-claude`}
        output={outputs.review}
        agent={claude}
        timeoutMs={15 * 60 * 1000}
        continueOnFail
      >
        <ReviewPrompt {...reviewProps} reviewer="claude" />
      </Task>

      <Task
        id={`${ticketId}:review-codex`}
        output={outputs.review}
        agent={codex}
        timeoutMs={15 * 60 * 1000}
        continueOnFail
      >
        <ReviewPrompt {...reviewProps} reviewer="codex" />
      </Task>
    </Parallel>
  );
}
