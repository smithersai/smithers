# 0079: Roles per repository: the App's installations decide where a deployment writes

Status: accepted (multi-repo builder, 2026-10-22; designed twice, Claude Opus and Codex Sol, merged). It builds the per-repository role that [0007](0007-roles-and-tags.md) phase 2 calls for, for issue writes and the TODO stack first. Will reviews it with the feature (HOST-3).

## Problem

A deployment wrote to one repository. The writes route (`POST /api/repos/<owner>/<name>/writes`) answered `404 not_found` for any repository but `GITHUB_REPOSITORY`, and a session's `role` is the person's GitHub permission on that one repository ([sign-in](../features/sign-in.md#roles-and-role-checks)). So smithers.sh, whose `GITHUB_REPOSITORY` is `smithersai/smithers`, couldn't open an issue on `smithersai/vibelang` or `roninjin10/smithers-github-tests`. Worse, the stack's route and its TODO shapes applied that one role to whichever repository the path named: a Member of `smithersai/smithers` could commit a TODO to any repository, a permission widened silently (GH-4).

## Decision

1. **A role belongs to a person on one repository.** On the deployment's own repository (`GITHUB_REPOSITORY`, the default repository) it is still the session's role, read at sign-in and rechecked hourly, so a single-repository deployment behaves exactly as before. On any other repository it is the person's GitHub permission on that repository, mapped as 0007 §9 says (admin to Admin, maintain to Maintainer, write to Member, triage and read to Guest, none to no role).
2. **`RepoRoles` resolves it, and every route asks it** (`worker/github/RepoRoles.ts`): `resolve(actor, repository)` answers the role or a refusal. No route reads `actor.role` for a repository it didn't resolve.
3. **The App reads the permission.** `GET /repos/<owner>/<name>/collaborators/<login>/permission` with an installation token minted for that one repository with `metadata: read`. The login and the account id come from the `people` row sign-in wrote, never a request, and GitHub's answer must name that account id (`userId`, which `@smthrs/integrations` gained for this): a login can change hands after a rename. The person's own token isn't used: it may be about to expire, and only `auth/RecheckRole` may redeem its refresh token.
4. **Allowed repositories are where the App is installed.** An installation lets the deployment act on a repository; it grants nobody a role. `GITHUB_ALLOWED_REPOSITORIES`, a comma-separated list of `owner/name`, narrows them; unset, every repository the App is installed on is allowed. The default repository is always allowed.
5. **The role is cached for 5 minutes** in `github_repo_roles (repo_id, person_id, role, checked_at)`, no role included. A stale row is read from GitHub again before it decides anything. When GitHub can't answer, the route says so: it never decides from a stale row. `checked_at` is when the read began, and a row is replaced only by a read that began later, so a slow read that saw a role never overwrites a quicker one that saw it removed.
6. **The check sits in the write's transaction, and again where the agent writes.** The route resolves the role (a GitHub read, outside any transaction), then the write's transaction locks the person's `github_repo_roles` row `FOR SHARE` and admits the write only if the row still holds that role and is fresh. A refresh that changes the role updates the row, so it serializes against the write: the write commits before the change or is refused. A write id belongs to its repository and its person: resent to another repository, or by another person, it is `409 conflict`. A person's own write goes to GitHub with their own token, which GitHub checks; the agent's goes as the App, so `github/Write` reads the person's permission again on every attempt, on every repository, and settles the write refused (`not_allowed`) unless they are still a Member or above with the same account.
7. **Refusals say what is true** (GH-4), in this order:

| Case | Status | Code |
|---|---|---|
| signed out | 401 | `authentication` |
| the App isn't configured on this deployment | 503 | `not_configured` |
| `GITHUB_ALLOWED_REPOSITORIES` leaves the repository out | 404 | `not_found` |
| the App isn't installed on the repository (GitHub can't tell that from an absent one) | 404 | `app_not_installed` |
| GitHub rate limited the read | 429 | `rate_limited`, with `Retry-After` |
| GitHub didn't answer, or answered 5xx | 503 | `github_unavailable` |
| no role, or one below the action's minimum | 403 | `forbidden` |
| Postgres or sessions down | 503 | `unavailable` |

The device's outbox sends 429 and 5xx again and keeps a 4xx as Not sent with its reason.

## Slice 1

- **Issue writes:** opening an issue (`issue/create`) and commenting (`issue/comment`) on any allowed repository, each at its 0007 minimum (Guest), with the role on that repository. The `github/Write` flow already takes its repository from the write's row.
- **The stack:** committing and dropping a TODO (Member, in person) and reading a repository's TODOs and their prompts (Member) use the role on the repository the path or `?repo=` names. This closes the widening above.
- **The repository's home** (2026-10-25, slice 1a): `GET /api/repos/<owner>/<name>/home` decides the audience from the role `RepoRoles` gives on the routed repository, so a repository's maintainers and contributors get their views on any repository the deployment may act on, `smithersai/vibelang` on smithers.sh included. Where it can't act (the App not installed or configured, or left out by `GITHUB_ALLOWED_REPOSITORIES`) nobody has a role and everyone sees the visitor's view; a role GitHub or Postgres can't say now is `429`/`503`, never a guess ([home](../features/home.md#who-sees-what)).
- **The issues' shapes, the webhook and Reconcile** (2026-10-25, slice 1b, server): every repository the deployment acts on, its own and with the App any other `GITHUB_ALLOWED_REPOSITORIES` doesn't leave out. A shape names its repository with `?repo=<owner>/<name>`; reading it is the same check as before, by the role `RepoRoles` gives there or GitHub saying the repository is public, and where the App can't act a signed-in person falls to that public check rather than a refusal. Whether the App is installed is Reconcile's to find out, at most once per repository and 5 minutes: it records `app_not_installed` on the repository's sync row, which the page reads to send people to GitHub. The webhook applies issue and pull request events of those repositories; pushes stay the mirror's and CI's. Where an About read found the App absent lately (`repo_about.app_absent_until`) and Smithers knows no installation there, the shapes answer `404 app_not_installed` from Postgres alone, so even a visitor's page learns the repository isn't synced without a GitHub call.
- **The browser's lists per repository** (2026-10-25, slice 1b, browser): the issues' and pull requests' stores open one set of shapes per repository the page shows (`forRepo`, collection families keyed by repository), so smithersai/vibelang's Issues and Pull requests sync and show on smithers.sh like the deployment's own. A repository the deployment doesn't sync (its shape's `404`, or its sync's `app_not_installed`) keeps decision 0102's frame: GitHub's list, and GitHub's new-issue form.
- **Deferred, fenced to the default repository:** triage, commitments and merging still answer `404 not_found` on any other repository, and secrets serve the default repository only. Each moves when its own slice resolves roles through `RepoRoles`.

- **Branches, TODO runs and the page's buttons** (2026-10-25, slice 1c): a branch's workspace (its conversation, terminals, room and shares), tracking or making a branch, and watching, following and steering a TODO's run decide with the person's role on that repository; `GET /api/repos/<owner>/<name>/role` answers it to the browser as `{ role, own }`, and the header's Secrets and Settings, New issue and the comment box, New TODO, Make TODO, Drop, Retry, triage and Merge show by it, the features still fenced to the default repository only where `own`. A branch decides through `RepoRoles` only on a repository Smithers recorded the App's installation on (`github_repositories`): on any other, nothing done in Smithers' copy reaches GitHub, and the session's role keeps deciding there, as it did, so a public repository without the App is still cloned and worked on (GH-4) and no GitHub call joins every branch check. A recorded installation is the one a role read, a write or a mint found; one the App gains later counts once anything has looked it up. Never wider than before: on a repository with the App the role can only narrow.

### Audience on a public repository (micro decision, 2026-10-25; Will may overrule)

SCOPE-14 says "user they wouldn't even how contributor if not authed to do it". GitHub answers `read` for every signed-in account on a public repository, and §1 maps `read` to Guest. We read "authed" as signed in:

| Who, on the routed repository | Role | Opens on | May switch to |
|---|---|---|---|
| signed out | none | User | nothing |
| signed in, no permission GitHub reports (a private repository they can't see, or the App not installed) | none | User | nothing |
| signed in, `read` (anyone on a public repository) or `triage` | Guest | Contributor | User |
| `write` | Member | Contributor | User |
| `maintain` | Maintainer | Maintainer | Contributor, User |
| `admin` | Admin | Maintainer | Contributor, User |

The audience follows the role; the role mapping of §1 is unchanged. The lead's brief read `triage` as Member; we keep it Guest, because Member is also what commits TODOs and edits a branch (0007), and raising it would widen a permission GitHub's triage role doesn't give (GH-4). It changes no audience: Guest and Member both open on Contributor. The alternative, Contributor only from `triage` up, would hide VibeLang's Contribute section from the outside contributors it is written for.

### Unsynced lists (2026-10-23 production regression)

The issue and pull-request lists render the device's rows without a lasting loading state (ARCH-5), using the existing library catalog's
`@smthrs/ui` `IssuesView.unknown` contract until a complete sync or GitHub row arrives. Unknown counts and an empty
list stay blank rather than claiming "No issues" or "No pull requests". This also applies to the default repository before its first sync.
Other repositories keep their Requested rows visible; this does not broaden the shapes or claim they synced.
Production on 9696f4c4 confirmed that an issue reached the second repository on GitHub while its list spun forever.
The e2e verification now shares dogfood's authenticated GitHub reader and fails immediately on HTTP refusals,
including 403 and 429, instead of letting polling swallow them for two minutes.

## Why

- **Installation as permission, not as role** (Sol): installing the App says the owner lets Smithers act there, which is the deployment-level allowlist GH-4 asks for; it says nothing about the person.
- **The App's token, not the person's:** the person's 8-hour token has one redeemer of its refresh token (`auth/RecheckRole`); a second reader would race it. The App's read costs one call against the installation's 5,000-an-hour limit, once per person per repository per 5 minutes.
- **No stale role during an outage** (Sol): a cached Member who was removed must not keep writing because GitHub is down. The default repository keeps its hourly session role, unchanged, because its behavior is not this change's to alter.
- **Rejected:** a `repository_access_epochs` table and per-activation refreshes (Sol). 0007 phase 2's `access_epoch` belongs with the Members card, where Smithers itself changes roles; for a role GitHub owns, the role row is the lock. Rejected also: reading the permission with the person's token; one `sessions.role` per repository in a JSON column (it would put GitHub reads on sign-in for repositories the person never opens).

## Consequences

- A person removed from a repository on GitHub keeps their role there for up to 5 minutes; on the default repository, up to the hour it always had.
- `TokenUnavailable` says when GitHub rate limited a token's mint, so a route can answer 429, and a rate-limited 403 is no longer `not_allowed`.
- On the deployment's own repository too, an agent's write now checks the person on GitHub when it runs: a person removed there since their last hourly role check no longer has their agent write.
- The device's `todo-requested` store is at version 3, preserving retry version 2 and its migration: App not installed is a reason a change stays Not sent.
- 0007 phase 2's `repository_roles` (roles Smithers sets) will sit beside `github_repo_roles` (roles GitHub sets); when both exist, the Members card's row wins, as 0007 §9 says.
- Every later route that acts on a repository takes it explicitly and asks `RepoRoles`; `actor.role` stays the default repository's role.

## Sources

- GitHub, "Get repository permissions for a user": `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, readable with `metadata: read`; `role_name` names `maintain` and `triage` (docs.github.com/rest/collaborators/collaborators).
- GitHub, "Get a repository installation for the authenticated app": `GET /repos/{owner}/{repo}/installation`, 404 when the App isn't installed (docs.github.com/rest/apps/apps).
- Codex Sol's independent design, 2026-10-22, merged above: installation is not membership, no stale positive role on failure, fence the TODO shapes' `?repo=`.
- Codex Astra's security review, 2026-10-22: a login reused after a rename, a write id replayed across repositories, a slow read overwriting a revocation, and the agent's durable write not checked when it runs. Each is fixed above, with its test.
- GitHub, "Changing your username": a previous username can be claimed by someone else (docs.github.com/account-and-profile).

## Rebase onto GitHub write hardening (2026-10-23)

Migration 0051 follows 0048–0050. Decision 0078 is reserved for timeline. The library catalog entries used are `@smthrs/integrations` for GitHub and `@smthrs/flow` for durable writes. `Action.once` retains decision 0077’s keyed recovery; the account and role check wraps only `perform`, so recovery can find an already-created issue or comment after revocation without authorizing a new write. TODO retry keeps its ownership check and stopped-attempt recovery, using the role resolved for its target repository for both admission and Maintainer overrides.
