// Shared workflow configuration.

/** Maximum review→fix rounds before the validation loop gives up. */
export const MAX_REVIEW_ROUNDS = 3;

/** Steps per review round (implement + validate + review + reviewfix). */
export const STEPS_PER_ROUND = 4;
