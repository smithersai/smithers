/*
 * The identity every browser-tier spec runs as.
 *
 * Will's ruling (Factory spec 2026-09-08, review/RULINGS.md 35): open sign-in
 * is on and the permission tiers behind it stay deliberately narrow, so the
 * e2e and canary suites run as a SCOPED-DOWN signed-in user and prove the
 * product works under the permissions a real visitor has. A spec whose double
 * answers with the factory admin's login is green while the product refuses
 * everyone else, which is the permission bug the suite exists to catch.
 *
 * `SCOPED_TEST_USER` is a plain signed-in GitHub account: no `admin` claim, no
 * maintainer claim on any repository, and no entry on the hand-seeded
 * closed-alpha roster. `allowlisted` is `true` because open sign-in makes
 * identity answer `true` for every login (Factory spec 01 §3); the privilege
 * is the `admin` claim and the seeded roster, never that flag.
 *
 * The login matches the deployed test account the sign-in probe uses
 * (`probes/signin-roundtrip.mjs`, `$SMITHERS_E2E_USER`), so one account name
 * reads the same across the doubles, the live browser probe, and the server
 * canary's `$CANARY_SESSION_LOGIN`.
 *
 * A spec that needs a maintainer or an admin states that in the spec itself,
 * with the reason, rather than raising the privileges here for everyone.
 */
export const SCOPED_TEST_USER = {
  login: "codeplanesmithers",
  allowlisted: true,
  admin: false
} as const

/** The Smithers Cloud half of the same account (`GET /api/cloud-auth/session`). */
export const SCOPED_TEST_USER_CLOUD_SESSION = {
  state: "signed-in",
  username: SCOPED_TEST_USER.login,
  expiresAt: "2027-01-01T00:00:00.000Z"
} as const
