---
title: Not-found and visitor error pages
status: in-progress
area: navigation
owner: bb2-notfound
updated: 2026-10-27
links: []
---

W12 implementation is ready for landing; production verification waits for deployment. No deployment, push, GitHub write or Mac mini run was performed.

Library catalog: `@smthrs/ui` supplies shared `NotFound`, `EmptyState`, buttons and breadcrumbs; `@smthrs/repo-view` supplies repository rendering. Existing TanStack Router owns not-found/error components, redirects and canonical navigation. The SDK addition has changeset `quiet-routes-recover`; generated artifacts remain the lander's responsibility.

## Findings

- Unknown pages: recover in a themed shell with navigation, account controls and Back to chat. Error pages share that shell and retain Retry.
- Missing issue/PR: W11 already settles the public missing item; resource-specific shared recovery now says Issue not found or Pull request not found. An unsynced repository's item settles as unavailable here with its GitHub source; absence is never invented without an authoritative answer.
- Private repository: the production visitor probe reproduced an empty body, a credential POST returning 401, and an About 503. New runs cannot mint session credentials until the tab confirms sign-in. About shows the first refusal and Try again rather than hiding it for the two-minute durable retry window. Absent and unavailable repository views offer visitors sign-in. File/tree retry policies remain unchanged.
- Missing repository: W11 already maps GitHub 404 to absence; the production named-missing-repository probe returned 404 and Not found. Genuine upstream 503 remains unavailable. Shared recovery now names the repository and retains the existing header backlink.
- Aliases: settings and secrets redirect to their settings pages; repository Runs is canonical at `/runs`, with `/actions` redirecting there. Existing saved run-detail URLs remain valid and link to the canonical list.
- Canonical URLs: GitHub supplies repository casing; confirmed tree files redirect to blobs, preserving suffix, search and fragment. Unknown directories and revisions never become guessed files.
- Overlong blob paths: 404 replaces 400 beyond the supported path length; malformed/traversal paths retain 400. Breadcrumbs stay within their container.
- Visitor settings: personal settings, repository settings and secrets offer sign-in returning to the current page.
- Unread bell on an unknown page is acceptable once the shell is present.

## Validation

Latitude passed typecheck, import rules and lint. The final focused run passed 27 files / 330 tests. Changed `.ts` files (`boot`, action URLs, auth store, issue view, repository actions/flows/paths/service, RepoApi) each reached 100% statements, branches, functions and lines. TSX/CSS are outside the app's configured coverage gate; browser specs provide their deployment checks. The SDK typecheck and full 2,664-test suite passed. Every changed SDK source file (index, NotFound and breadcrumb CSS) reached 100% lines/functions; Bun does not report branch/statement metrics.

Read-only production probes reproduced route absence, alias failures, missing-item recovery, private-repository failure, visitor settings, tree-file aliases and overlong-path refusal. Their screenshots remain in the shared bug-bash shots directory. No changed-build production E2E or GIF is claimed.

## Lander checks

After deployment, run `not-found.spec.ts`, `route-aliases.spec.ts`, `visitor-settings.spec.ts`, `visitor-credentials.spec.ts`, `missing-items.spec.ts`, `missing-repository.spec.ts`, and `long-blob-path.spec.ts`. Check desktop, 320px and dark mode recovery; invalid numeric and malformed routes; browser back/forward after redirects; no visitor credential POST; source-specific missing items and list links; private repository reasons/sign-in; real GitHub absence versus upstream outage; long-path header bounds. Undeclared API, 5xx, console and page errors must fail these specs. Run the full app suite once for the batch and regenerate SDK artifacts.

The retained regressions were also run against pre-fix production sources on Latitude: all five selected files failed at behavioral assertions (visitor sign-in, repository settings sign-in, long-path 400 versus 404, canonical Runs URL and unsynced item loading versus unavailable). The same cases pass in the final 330-test run. Unknown-route, credential, casing and tree-file old behavior is separately recorded by production probes; no new-build browser execution is claimed.
