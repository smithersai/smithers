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
