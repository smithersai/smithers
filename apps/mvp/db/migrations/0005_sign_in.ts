import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Sign-in's tables (docs/features/sign-in.md#postgres). Nothing here is synced to browsers. No column holds a
// credential in the clear: a session is found by its token's SHA-256, and GitHub's tokens and the PKCE verifier are
// sealed with AES-256-GCM under a key derived from SESSION_SECRET.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // A person, keyed by GitHub's numeric id, never their login, which they can change.
  yield* sql`
    CREATE TABLE people (
      id uuid PRIMARY KEY,
      github_id bigint NOT NULL UNIQUE,
      github_login text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
  // A sign-in in progress, from the button to GitHub's callback: single-use and short-lived. `state_digest` is the
  // SHA-256 of the `state` GitHub echoes back; `verifier` is the sealed PKCE verifier.
  yield* sql`
    CREATE TABLE sign_in_attempts (
      state_digest text PRIMARY KEY,
      verifier jsonb NOT NULL,
      redirect_uri text NOT NULL,
      return_to text NOT NULL,
      expires_at timestamptz NOT NULL
    )`
  yield* sql`CREATE INDEX sign_in_attempts_expires_at ON sign_in_attempts (expires_at)`
  // One browser's session. `token_digest` is the SHA-256 of the cookie's token. `role` is the person's role on the
  // repository, re-checked with GitHub every hour by `auth/RecheckRole`, and null when they have none. GitHub's
  // tokens are sealed, and set to null when the session ends. `github_refresh_digest` names the refresh token the
  // row holds, so a refresh replaces only the token it presented.
  yield* sql`
    CREATE TABLE sessions (
      id uuid PRIMARY KEY,
      token_digest text NOT NULL UNIQUE,
      person_id uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
      role text CHECK (role IN ('admin', 'maintainer', 'member', 'guest')),
      role_checked_at timestamptz NOT NULL,
      github_access jsonb,
      github_access_expires_at timestamptz,
      github_refresh jsonb,
      github_refresh_digest text,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      revoked_reason text CHECK (revoked_reason IN ('sign_out', 'github_refused', 'unreadable'))
    )`
  yield* sql`CREATE INDEX sessions_person_id ON sessions (person_id)`
})
