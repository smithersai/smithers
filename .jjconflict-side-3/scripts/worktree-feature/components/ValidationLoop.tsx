import { Ralph, Sequence } from "smithers";
import { Implement } from "./Implement";
import { Validate } from "./Validate";
import { Review } from "./Review";
import { ReviewFix } from "./ReviewFix";
import { useCtx, tables } from "../smithers";
import { MAX_REVIEW_ROUNDS } from "../config";
import type { Ticket } from "./Discover.schema";
import type { ReviewOutput } from "./Review.schema";

interface ValidationLoopProps {
  ticket: Ticket;
}

export function ValidationLoop({ ticket }: ValidationLoopProps) {
  const ctx = useCtx();
  const ticketId = ticket.id;

  const claudeReview = ctx.latest(tables.review, `${ticketId}:review-claude`) as ReviewOutput | undefined;
  const codexReview = ctx.latest(tables.review, `${ticketId}:review-codex`) as ReviewOutput | undefined;

  const allApproved =
    !!claudeReview?.approved &&
    !!codexReview?.approved;

  return (
    <Ralph
      id={`${ticketId}:impl-review-loop`}
      until={allApproved}
      maxIterations={MAX_REVIEW_ROUNDS}
      onMaxReached="return-last"
    >
      <Sequence>
        <Implement ticket={ticket} />
        <Validate ticket={ticket} />
        <Review ticket={ticket} />
        <ReviewFix ticket={ticket} />
      </Sequence>
    </Ralph>
  );
}
