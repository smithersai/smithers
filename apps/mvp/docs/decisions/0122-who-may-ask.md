# 0122: Who may ask: a Member of the conversation's repository, with their own model

Date: 2026-10-27. Status: accepted. Ruling [AUTH-8](../rulings.md#16-auth-roles-and-spend): Will, Telegram 2026-10-27 13:02, "Use best
judgement", answering the lead's recommendation, option 2 of the queue item `decision:who-may-ask`. Amends
[0007](0007-roles-and-tags.md) §2 (`repo:ask`, `repo:branch-create` for clones) as it was built; builds on
[0079](0079-roles-per-repository.md)'s per-repository roles and [0103](0103-sandbox-budgets.md)'s sandbox budgets. Will
reviews it with the feature (HOST-3).

## Problem

Every act a conversation needs checked the Member role on the deployment's own repository (`GITHUB_REPOSITORY`), the
session's role: asking, the answer routes, views, run reports, saving one's own model, the model endpoint and cloning.
Installing the GitHub App on your own repository unlocked nothing, and a person reported on 2026-10-27 that they
couldn't start a conversation.

## Decision

1. **The role is the repository's.** Each act decides with the person's role on the repository it concerns, through the
   one role model there is: `RepoRoles` (decision 0079), as branch access already reads it (`worker/branch/Access.ts`
   `roleOn`, `BranchRoles`). Where Smithers recorded the App's installation, GitHub's permission there, kept 5 minutes;
   where it didn't, the session's, as 0079 says.

   | Act | Who |
   |---|---|
   | Asking (`POST /api/questions`), the answer routes, a view added or moved, a run's report or answer | a Member or above on the conversation's branch's repository who may edit the branch (`askingOf`, `askingOnAnswer`) |
   | Cloning, and its launch (`POST /api/repos`, `/api/repos/launch`) | a Member or above on the repository cloned (`BranchRoles.roleOn`) |
   | Saving and testing one's own model; one's own flows; a page preview; acks of one's own feed | anyone signed in: it is theirs, or adds nothing anywhere |
   | One's feed (`GET /api/shapes/notifications`) | a Member or above of `GITHUB_REPOSITORY`: every row of theirs; anyone else signed in: the rows of their own acts (`mine`: their runs, clones and writes), so a person whose role was taken keeps no feed of others' runs |
   | The model endpoint with the person's own model | anyone signed in: their key pays, and asking is decided above |
   | The deployment's own model (while `HOSTED_MODEL_ENABLED` or an Admin turns it on, ARCH-20) | a Member or above of `GITHUB_REPOSITORY` only: the session's role at the endpoint, at a server flow's call the latest-checked live session's (`SessionStore.deploymentMember`), so a demotion found on one session outranks an older one |
   | Following a conversation (`POST /api/watches`) | a Member or above of `GITHUB_REPOSITORY`, as before: the feed's fold checks each follower as a Member |
   | Secrets, custom domains, triage, merging | unchanged: `GITHUB_REPOSITORY` only (0079's later slices) |

2. **Role isolation holds.** A Member, Maintainer or Admin of `GITHUB_REPOSITORY` has no more power on a repository the
   App is installed on than GitHub gives them there: a reader there is a Guest, refused 403.
3. **A repository without the App** keeps 0079's rule: nobody's GitHub permission can be read there, nothing done in
   Smithers' copy reaches GitHub, and the session's role decides, so the deployment's own Members keep working on any
   public repository's copy (GH-4, GH-5), and nobody else holds a role there. A stranger installs the App on a public
   repository of theirs (Code Storage clones only public ones).
4. **There is no conversation without a repository.** Every conversation is a branch's (decision 0013 §1), and `/new`
   naming no repository makes its branch on `GITHUB_REPOSITORY`, where only its Members ask. So nothing clones or wakes
   a sandbox for a person without a role on a repository.
5. **Machines remain deployment Members only.** Starting a branch sandbox, opening a terminal, using sandbox tools
   and committing or retrying a TODO require Member or above on `GITHUB_REPOSITORY`, in addition to the repository's
   own permissions. A stranger who may ask on their repository is refused: "Members can run machines." Sandbox tool
   refusals are permanent under the existing durable retry policy. The deployment-wide sandbox budgets remain.
6. **The session says it.** `GET /api/auth/session` answers `hostedModel` per person (on, and a Member of
   `GITHUB_REPOSITORY`), so a stranger's first run and composer ask for their own model, and `install`, where Install
   goes (`https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`) when the deployment signs in with the App.
7. **The first run doesn't stop a stranger** ([0121](0121-first-run.md)): ✓ Sign in, Add your model, then Open your
   repository, a field for `owner/name` (or its GitHub URL), Open and Install. On a branch page whose repository's role
   is below Member, the conversation's place says "Members can ask Smithers."; a refused clone says "Members can clone."
   with Try again, for once the App is installed or a role given.

8. **Clone cap.** `CLONES_PER_PERSON` (Effect `Config`, default 3, positive integer) counts distinct existing
   repositories a person caused to be cloned, from their existing clone feed records joined to `repositories`, under
   the `repo_imports` lock. Failed clones count; another person's retry never erases the original person's act.
   Retrying the same repository consumes no additional place. Opening a ready or cloning copy changes nothing.
   At the cap, `POST /api/repos` returns `429 repository_limit` before persisting or launching anything; the browser
   says "Clone limit reached." The durable step refuses without retrying. There is no time reset; removing a
   repository removes it from the count. Deployment Members are exempt, through `SessionStore.deploymentMember`.
   Role observations are ordered independently of check scheduling, so a failed refresh or delayed callback cannot
   revive authority after a verified demotion, even after the session that learned it signs out.

## Amendment: narrow this landing (lead, 2026-10-28)

The lead narrows AUTH-8 to what a new person needs to start a conversation: sign in, add their model, open their
repository, ask, read and clone as a Member or above there. Hosted inference and all machines remain available only
to Members or above of `GITHUB_REPOSITORY`. Per-person sandbox hours and the concurrent TODO-machine cap are held
for a separate design. Their migration, configuration, accounting code, lifecycle extensions and tests are removed
from this landing; SDK-11 permits no second or unused implementation. The prior stack is retained on the
`held/sandbox-accounting` bookmark.

Reason: the accounting had P1 defects through nine Astra rounds. Round 8 found that legacy ownership bootstrap
could overwrite the original payer (`BranchSandboxes.ts:254`), and a blocked tool could prevent the hard daily
shutdown (`BranchSandboxes.ts:402`). The root rule says a feature with a known security hole ships switched off.
Restricting machines to the deployment's existing Members preserves the previous trust boundary without relying
on that accounting. This amendment supersedes the earlier daily-hours and per-person TODO-cap decisions.

The slash-issue command advances on its issue receipt without waiting for form navigation. Slash menus use the
active conversation repository's role, failing closed while it is being tracked or its role is unreadable. `/new`
and `/clone` remain available to signed-in people; the server checks the named repository.

## Consequences

- `chat.question`, `repo.clone.request` and `chat.view.add` record the repository role or refusal reason;
  `model.endpoint` records `hosted_members_only`. Machine routes record `members_only`, with no person id or content.
- Clone refusals carry `scope`, `used` and `limit`; `repo_capacity{reason=person_repositories}` counts them.
- Local development's `owner-<id>` and `reader-<id>` remain Admin and Guest of `octocat/Spoon-Knife` for the browser
  regressions. Neither is a deployment Member and neither may run machines.
- Library catalog: `@smthrs/flow` (durable steps and refusal policies), `@smthrs/ui` (Input, Button),
  `@smthrs/effect-tanstack-db` (first-run state), `@smthrs/effect-code-storage` (clones), Effect Config and SQL.

The machine boundary includes attaching existing terminals, branch Publish/Update/Resync, and steering a running TODO. Each requires deployment membership in addition to the repository permission; watching a TODO run still uses that repository's role.

A known deployment non-Member also receives the machine refusal before the browser selects or dials an existing shared terminal. A role lost after selection is checked again before dialing; the server independently checks every attachment.

An attached terminal observes the session for its whole lifetime. Confirmed nonmembership or sign-out closes the connection scope and its pending reconnects before showing the refusal.
