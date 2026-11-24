import { z } from "zod";

/** One required line of the form: trimmed, non-blank, bounded. */
const line = (max: number) => z.string().trim().min(1).max(max);

/**
 * The demo request the site's `/demo` form posts: the four required fields
 * of `apps/site/src/pages/demo/index.astro`, trimmed. Unknown keys are
 * dropped, so a stored request holds only what the form asks for.
 */
export const demoRequestSchema = z.object({
  firstName: line(200),
  lastName: line(200),
  workEmail: z.email().max(320),
  message: line(5000),
});

/**
 * The form's body: the request plus `submissionId`, the idempotency key the
 * page draws once per submission and resends on every retry, so a retry
 * after a lost response answers the stored request's ID instead of storing
 * a second one.
 */
export const demoSubmissionSchema = demoRequestSchema.extend({
  submissionId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});
