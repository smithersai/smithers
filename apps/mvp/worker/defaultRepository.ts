// Its own module, so both sign-in (SignIn.ts) and the branch conversations (branch/Conversations.ts), which sign-in
// reads the home conversation from, import it without a cycle.

/** The repository roles are read on when `GITHUB_REPOSITORY` is unset. */
export const DEFAULT_REPOSITORY = "smithersai/smithers"
