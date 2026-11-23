# Owner profiles

Visiting `/<owner>` (such as `smithers.sh/roninjin10` or `smithers.sh/smithersai`) opens a GitHub-style profile page for any GitHub user or organization.

## Routes

- **Page:** `/$owner` (`src/routePaths.ts`, `src/router.tsx`, `src/screens/profile/ProfileScreen.tsx`)
  - `?tab=repositories`: switches from `Overview` (default) to `Repositories`.
  - `?q=…`, `?sort=updated|stars|name`, `?type=all|sources|forks|cloned`: filters and sorts the owner's public repositories in the URL.
  - Case differences against GitHub's canonical login redirect in place (for example `/RONINJIN10` → `/roninjin10`).
  - Reserved app and docs first segments (`app`, `api`, `assets`, `bug`, `flows`, `settings`, `docs`, …) and invalid GitHub logins never match `/$owner`.
- **API:** `GET /api/profiles/<owner>` (`worker/profile/Api.ts`)
  - Public read (open to signed-out visitors and signed-in members alike).
  - Returns `200` with `cache-control: public, max-age=…, must-revalidate`, `404 { code: "not_found" }`, `405` for non-GET, or `503 { code: "rate_limited" | "github_unavailable" | "unavailable" }` with `Retry-After`.

## Data and caching

- **GitHub reads (`worker/profile/GitHubRead.ts`):**
  - With the deployment's read token (`worker/github/ReadToken.ts`), one GraphQL query (`repositoryOwner(login: $login)`) returns user or organization details, organizations, pinned repositories, up to 100 public owned repositories, the profile README (`<login>/<login>/README.md` or `<org>/.github/profile/README.md`), and for users the last-year contribution calendar.
  - Without a token, anonymous REST (`GET /users/<owner>`, repos, orgs, profile README) serves the profile, falling back to popular non-fork repositories on Overview when pinned repositories are unavailable.
- **Postgres cache (`db/migrations/0127_owner_profile.ts`, `worker/profile/Store.ts`, `worker/profile/Source.ts`):**
  - One row per lowercased `owner` in `owner_profile`, shared across Cloudflare data centers, with `claim_generation` fencing so concurrent requests trigger one GitHub read.
  - Configurable freshness via `PROFILE_FRESH_MINUTES` (default 10) and `PROFILE_ANONYMOUS_FRESH_MINUTES` (default 60), read at program build.

## Browser state and UI

- **State machine (`src/features/profile/`):** framework-free Effect state machine (`ProfileClient`, `ProfileStore`, `actions.ts`, `view.ts`, `Profile`) backed by local TanStack DB collections (`profile-entries`, `profile-view`) and joined with `RepoStore.repositories` so repositories already cloned on Smithers display a `Cloned` badge and filter.
- **UI component (`@smthrs/ui` `OwnerProfile`, `@smthrs/ui-css` `profileCss`):** two-column GitHub profile layout styled strictly through house theme tokens for light and dark mode. Clicking any repository opens `/<owner>/<repo>` in Smithers; clicking any organization opens `/<org>` in Smithers; clicking your signed-in username in the top bar opens your own profile.

## Observability

- **Server:** span `profile.get` / `profile.answer` / `profile.read.{graphql,rest}`, structured logs `profile.get` and `profile.read`, counters `smithers_profile_reads` and `smithers_profile_answers`.
- **Browser:** spans `profile.open`, `profile.load`, `profile.get`, counter `smithers_web_profile_opens`, histogram `smithers_web_profile_load_ms`.
- All telemetry is content-free: `/api/profiles/<owner>` normalizes to `/api/profiles/:owner` in `src/apiRoutes.ts`, and no login, name, bio, or repository title is logged.
