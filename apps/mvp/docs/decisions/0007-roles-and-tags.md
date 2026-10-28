# 0007: Roles and labels: four roles, one per-action policy, labels as flows

Status: accepted (Will, 2026-10-19). Amended 2026-10-27 by [0122](0122-who-may-ask.md) (ruling AUTH-8): `repo:ask` and a clone (`repo:branch-create`) are decided by the role on the repository the act concerns; saving one's own model needs only sign-in. Will asked: "We need ability to assign roles like maintainer, contributor etc. (just like GitHub). We also will want ability to add tags to issues and PRs like GitHub too. These will be important later but we need it architected." His answers are under [Questions for Will](#questions-for-will). This record covers authorization: what an actor may do. Identity, meaning who the actor is, is [0008](0008-auth.md); §9 is the seam between the two. Branch and sandbox permissions follow [0005](0005-sandboxes-secrets-and-the-forge.md).

## Decision

1. **Four roles: Admin, Maintainer, Member and Guest** (Q1). Each role adds to the one below it. A role is one plain field per person per repository, so a later flow can change it, for example to promote a Guest. That flow is out of scope. The account that owns a repository is its Admin.
2. **Merging runs the repository's merge flow** (Q2). By default, Maintainers and Admins merge. A repository may customize the flow, but a person always merges: never an agent, never a Guest.
3. **A Guest's risky acts wait for approval.** Anything a Guest starts that would run code, use a sandbox or touch a secret waits until a Member or above approves it in person.
4. **Every action names its minimum,** in one catalog (§2). Will, 2026-10-17: "really really granular about permissions whether it should be maintainer only". Forge actions join `@smthrs/capability` as `repo:*` actions. A new pure package, `@smthrs/access`, turns an actor's facts (role, branch mode, agent mark) into capability rules, and `Permission.evaluate` answers `allow`, `deny` or `ask`, as it already does for files, processes and the network. Flows, shapes, the agent's tools and the UI all read the one catalog.
5. **An agent acts as the person who started it, never above them.** Its rules are its person's, with every human-only act denied: approving, merging, roles, secrets, modes and protection. Asking an agent to merge opens the person's own Review & merge confirmation ([root AGENTS.md](../../../../AGENTS.md), mvp.md M-05).
6. **The server decides, in the write's own transaction.** Every flow step that writes reads the actor's current role while holding its repository's `access_epoch` row `FOR SHARE`, then writes in the same transaction. Every role change updates that row. A durable run is checked again at each write, so it never outlives its person's role.
7. **Shapes are per repository, and the proxy authorizes every request.** The server sets `where repo_id = $1` and checks `repo:read` on each shape request, live ones included. A revoked person's connected device loses access within one live request, which Electric holds for up to 20 s ([8]), and drops its copy.
8. **The UI only hints.** The device runs the same evaluation over its synced roles and hides what a person can't do. A queued action is authorized when the server runs it, never when it was queued.
9. **Every branch has a mode** (0005): `locked` (main: no direct writes, only merges), `open` (every Member) or `restricted` (the creator plus the writers they name). Writing includes terminals, SSH, jobs and steering the branch's agent.
10. **Labels work as GitHub's do** ([2]): each belongs to one repository and has a name, a color and a description, and a repository starts with GitHub's default labels or its account's. Members, and their agents, apply them through flows. The product word is label, as on GitHub, because "tag" already means a git tag.

## Why

- **Will chose four roles over GitHub's five** (Q1): "Keep it simple." Trust will later be decided by flows, so the role stays one field, not a policy language.
- **The old backend showed what to keep and what to drop** ([5]). It had no maintain level; GitHub's maintain became admin there, so Maintainer is new. Its one authorizer read a generated per-command catalog that gave each agent `never`, `run` or `confirm`; that worked, so those answers become `deny`, `allow` and `ask` here. It stored `protected_bookmarks.restrict_push_teams`, and a search finds nothing that enforces it, so here a rule exists only with the test that enforces it. A label applied with a run token named no person, and `automerge` counted only when an admin applied it, so here a flow that reads a label as a decision checks who applied it.
- **Electric documents this pattern:** a proxy that sets the shape and authorizes every request ([3]). A shape's definition is immutable ([4]), so a per-person `where` would create one shape per person per table, while a per-repository shape is one log that every reader shares.
- **Checking inside the write's transaction closes the race** between a revoke and a write: the write either commits before the revoke or is refused.
- **Rejected:** Postgres row-level security, a second copy of the policy in SQL that Electric's `where`-filtered shapes would not use; SpiceDB, OpenFGA and Cedar, each a second store beside Postgres or a second policy language. Revisit them if one role field stops being enough.

## Consequences

- **M-05 changes.** Owner becomes Admin. Managing people and secrets moves from Maintainer to Admin; Maintainers keep merging and approving. Member stays, and Guest is new. M-05 and §6.15 of [mvp.md](../../../../.specs/product/mvp.md), and `MemberRoleSchema` in `@smthrs/rpc`, change to match.
- **SDK work, each piece with its consumer:** the `repo:*` actions and their tiers in `@smthrs/capability` (merge is `irreversible`); the new `@smthrs/access`; a shape per request in `ShapeProxy.make`, `(request) => Effect<Shape, ShapeForbidden>`, where today it fixes one shape when built; and the outbox mapping a 403 to `Refused`.
- **Roles do nothing until 0008 ships identity.** Until then every request is signed out: public reads stay open, asking needs sign-in ([todo.md](../todo.md)), and any act that needs a role is refused.
- **A revoked device that stays offline keeps what it already synced** until it reconnects. No local-first design can reach it sooner, and it receives nothing new.
- **Role changes serialize against writes** on one row per repository, for one transaction. Writes take a shared lock on it, so writes never wait for each other.

## 1. Roles

```
anyone < Guest < Member < Maintainer < Admin
```

| Role | Who | GitHub ([1]) | Adds to the role below |
|---|---|---|---|
| anyone | any actor, signed out included; holds no role | none | reads public repositories |
| Guest | an untrusted contributor. On a public repository, every signed-in person without a role counts as one | read or triage; no access to a public repository | opens issues, comments and pull requests from forks; reads a private repository that added them |
| Member | a trusted contributor | write | branches, sandboxes, running flows, asking Smithers, pull requests from branches, labels and triage, approving a Guest's run |
| Maintainer | runs the project | maintain | merges (by default), approves pull requests, pre-approves TODOs (M-39) |
| Admin | full access | admin | people and roles, secrets, admin settings such as models and budgets, branch protection, deletion |

- **A Guest's run waits.** Anything a Guest starts that would run code, use a sandbox or touch a secret, such as the checks on their pull request, parks on a `HumanTask` until a Member or above approves it. An approval covers one revision; a new push waits again.
- **The role is one field** in `repository_roles` (§7). An Admin changes it on the Members card (mvp.md §6.15).

## 2. The action catalog

Each row is a `repo:` action in `@smthrs/capability`. A flow declares the actions it performs in `Flow.make`'s `capabilities`, which is the ceiling `@smthrs/flow` already narrows through composition. Resources name repositories by id, so a rename never moves a role: `repo/<id>`, `repo/<id>/branch/<name>` and `repo/<id>/label/<id>`. Two rows are stricter than GitHub on purpose: approving and merging, which GitHub gives to write.

| Action | What it allows | Minimum | Agent |
|---|---|---|---|
| `repo:read` | code, branches, issues, PRs, labels and runs; watching a branch live | anyone if public, else Guest | run |
| `repo:issue-open`, `repo:comment` | opening an issue; commenting on an issue or PR | Guest | run |
| `repo:pr-open` | opening a PR from a fork or a branch | Guest | run |
| `repo:ask` | asking Smithers about the repository: by the person's role on that repository, never another's (ruling AUTH-8, [0122](0122-who-may-ask.md)) | Member | run |
| `repo:triage` | assigning, closing, reopening, marking duplicate | Member; an author may close their own issue | run |
| `repo:label` | creating, editing, deleting, applying and removing labels | Member | run |
| `repo:branch-create` | creating a branch and its sandbox | Member | run |
| `repo:branch-write` | editing files, terminals, SSH, jobs, steering the coding agent, pushing | Member, within the branch's mode | run |
| `repo:branch-mode` | changing a branch's mode and writers | the branch's creator, or Maintainer | never |
| `repo:flow-run` | running a repository flow | Member, or the flow's declared minimum | run |
| `repo:guest-approve` | approving a Guest's run | Member | never |
| `repo:approve` | approving a PR | Maintainer | never |
| `repo:merge` | merging a PR through the merge flow | the merge flow's minimum: Maintainer by default, never below Member | confirm |
| `repo:preapprove` | pre-approving a TODO (M-39) | Maintainer | never |
| `repo:secret-write` | adding, replacing or deleting a secret (0005) | Admin | never |
| `repo:domain-write` | adding, refreshing or removing a custom domain, and seeing them (0039) | Maintainer | never |
| `repo:members` | adding a person, changing their role, removing them | Admin | never |
| `repo:protect` | branch protection rules | Admin | never |
| `repo:settings`, `repo:delete` | admin settings such as models and budgets; deleting the repository | Admin | never |

- **The agent column:** `run` means `allow` and `never` means `deny`. `confirm` means `ask`: the agent opens the person's own Review & merge confirmation, bound to the revision they reviewed, and the person merges. An agent's own review is recorded as agent findings, never as an approval.
- **`ask` parks the run on a `HumanTask`.** The person answers their agent's `confirm`; a Member or above answers a Guest's run. Either answer comes only through the app shell's own channel, never an agent's.
- **The merge flow** is a repository flow (M-47), so a repository can add rules to it, for example requiring a Maintainer for changes under `.smithers/**`, `AGENTS.md` or lockfiles. `@smthrs/access` vetoes every agent and Guest whatever the flow says.
- **Compiling rules:** `Access.rules` returns `[vetoes, grants]`. Vetoes hold protection rules and an agent's `never` acts, and `evaluate` treats a deny there as final. Grants open with a deny of `repo:*`, because `evaluate` answers `ask` for any capability no rule matches. An agent's `confirm` turns into `ask` only an act its person may already do.

## 3. Where it is enforced

```
 DEVICE                                   WORKER: flows                            WORKER: shape proxy
 synced roles + modes ─▶ decide            CurrentActor ─▶ facts (FOR SHARE)        CurrentActor ─▶ repo:read?
   hides what it can't do                    ─▶ decide ─┬ allow: write, same tx       ├ yes: where repo_id = $1 ─▶ Electric
 outbox ─── POST ─────────────────────────▶             ├ deny: 403                   └ no: 403 ─▶ the device drops the repo's rows
                                                        └ ask: HumanTask
```

```ts
// @smthrs/access: pure; runs in a browser, a Worker, Node and Bun
type Role = "guest" | "member" | "maintainer" | "admin"
interface Facts {
  role: Role | null              // the worker sets "guest" for a signed-in person with no row on a public repository
  visibility: "public" | "private"
  branch?: { mode: "locked" | "open" | "restricted"; creator: string; writers: ReadonlyArray<string> }
}
Access.rules(actor: Actor, facts: Facts): ReadonlyArray<ReadonlyArray<Permission.Rule>>   // Actor is 0008's
Access.decide(actor, facts, capability): Permission.RuleEffect                             // evaluate(rules(actor, facts), capability)
// apps/mvp/worker: the layer for 0008's Authorize service; PermissionRequired is how `ask` parks
Authorize.check(actor, capability): Effect<void, PermissionDenied | PermissionRequired, SqlClient>
```

- **On the server, in flows:** `Authorize.check` runs inside the step's transaction. It locks `repositories.access_epoch` `FOR SHARE`, reads the role and the branch rule, and decides before the write. `deny` becomes a 403 that names the action, and `ask` parks the run on a `HumanTask`. Every write records `actor_id` and `via`. Shapes are in §8.
- **In the agent's tools and the UI, as hints:** the flow registry leaves out flows the person can't run, and a control whose action decides `deny` is hidden, not disabled with an explanation (minimal text). The server still decides.

## 4. Agents and Guests

- **The agent mark comes from the host, never from agent code.** Codemode runs isolated, holds no session credential, and reaches flows only through the host's bridge, which stamps `via`. External agents (Claude Code, Codex, the CLI) use 0008's delegated tokens, which carry `via` and no role. Every write stores the person and `via`, and shows as "Smithers for Maya" (M-34).
- **A Guest's text never starts credentialed work** (mvp.md §14). A run it starts gets no secrets, no sandbox and no writes until a Member or above approves it (§1), and the approval is attributed.
- **Deferred (Q3):** flows that an event starts with no person, such as labeling a new issue. Decide their identity and limits when the first one is built.

## 5. Branches and sandboxes (0005)

| Mode | Who writes | Who reads | Default for |
|---|---|---|---|
| `locked` | nobody; changes arrive only through the merge flow | everyone with `repo:read` | main, and any branch a protection rule matches |
| `open` | every Member | everyone with `repo:read` | new branches |
| `restricted` | the creator, plus `branch_writers` | everyone with `repo:read` | the creator's choice |

- **Protection rules** are branch patterns an Admin sets; a matching branch is `locked`. Each repository's default branch gets one when the repository is created. A branch's creator or a Maintainer may change its mode, and every change is attributed; nobody bypasses a mode silently.
- **Write authority** is everything that can change the working copy: CRDT updates, terminals, SSH, jobs, steering the coding agent, and pushes. A shell is write authority even when the editor is read-only. Readers can watch files, logs, presence, cursors and previews.
- **The sandbox's own forge credential is read-only,** so every forge write is an attributed, fenced flow step that authorizes `repo:branch-write` for the actor (0005). Main's sandbox runs jobs such as tests, with no write authority.
- **On a role or mode change,** the next durable step of the flow that made it closes the affected people's terminals, SSH sessions and live-document sockets on those branches. There is no sweep.
- **Offline:** multiplayer branches work only online, so a revoked writer's next update is refused. On a single-player branch edited offline, refused edits stay on the device, with `Move to new branch` (when the person may create one) and `Discard`.

## 6. Labels

- **Fields:** a name of 1 to 50 characters, trimmed and unique per repository ignoring case (a bound we chose); a color of six lowercase hex digits, stored without `#` as GitHub's API takes it ([6]); and a description of at most 100 characters ([6]).
- **Defaults:** a new repository gets its account's default labels, or else GitHub's ten: `accessibility`, `bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question` and `wontfix` ([2]). The create-repository flow copies them, so later edits belong to the repository, as on GitHub.
- **Flows:** `label.create`, `label.update`, `label.delete` and `label.apply { itemId, add, remove }`, each needing `repo:label` and each an outbox mutation as in [0002](0002-local-first.md), made idempotent by an id the device chooses. Deleting a label removes it from every issue and PR, as on GitHub ([2]). `label.apply` covers issues and PRs alike and is `modelInvocable`, so the agent applies labels through the same flow, with its person's role.
- **Offline:** applying labels sends adds and removes, never a whole set, so when two devices change different labels both changes land. For the same label, the order the changes reach Postgres decides. Applications refer to a label by id, so a rename never breaks one. When a create is refused, the queued applications that name its label are refused with it; the view shows the server's state, and one toast says what wasn't saved.
- **Events:** the apply flow's last step emits `labeled` and `unlabeled`, with the person who applied the label and `via`, for repository flows to wait on. M-47's issue transitions use these events.
- **A label as a decision:** a flow that reads a label as a decision, such as `todo` (M-16), checks the role of the person who applied it, which `item_labels` records with `via`.
- **Filtering** uses GitHub's grammar ([7]): `label:bug label:ui` matches both, `label:bug,ui` either, `-label:wontfix` excludes, `no:label` matches unlabeled items, a name with spaces is quoted, and case doesn't matter. A framework-free parser turns the text into a TanStack DB query over the device's `labels` and `item_labels`. The text lives in the URL's search params, and filtering works offline.

## 7. Postgres

```sql
repositories     (id uuid PRIMARY KEY, account_id uuid, name text, visibility text CHECK (visibility IN ('public','private')),
                  access_epoch bigint NOT NULL DEFAULT 0)                     -- every role change bumps it
repository_roles (repo_id uuid, person_id uuid, role text CHECK (role IN ('guest','member','maintainer','admin')),
                  set_by uuid, set_at timestamptz, PRIMARY KEY (repo_id, person_id))
role_events      (id uuid PRIMARY KEY, repo_id uuid, person_id uuid, from_role text, to_role text, by uuid, via text, at timestamptz)
protection_rules (repo_id uuid, pattern text, PRIMARY KEY (repo_id, pattern))
branch_rules     (repo_id uuid, branch text, mode text CHECK (mode IN ('open','restricted')), creator uuid,
                  updated_by uuid, updated_at timestamptz, PRIMARY KEY (repo_id, branch))
branch_writers   (repo_id uuid, branch text, person_id uuid, added_by uuid, PRIMARY KEY (repo_id, branch, person_id))
labels           (id uuid PRIMARY KEY, repo_id uuid, name text, color text CHECK (color ~ '^[0-9a-f]{6}$'),
                  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 100),
                  created_by uuid, created_at timestamptz, updated_at timestamptz)   -- UNIQUE INDEX (repo_id, lower(name))
item_labels      (item_id uuid, label_id uuid REFERENCES labels ON DELETE CASCADE, repo_id uuid,
                  applied_by uuid, via text, applied_at timestamptz, PRIMARY KEY (item_id, label_id))
account_default_labels (account_id uuid, name text, color text, description text)  -- UNIQUE INDEX (account_id, lower(name))
```

- **`locked` is derived:** a branch that any `protection_rules` pattern matches is locked, so only `open` and `restricted` are stored. `role_events` is an append-only audit of every role change.
- **`item_labels.repo_id`** copies the item's repository so that one shape can filter by it, and a composite foreign key to the item keeps the two equal. Items (issues and PRs) belong to their own design.
- **Synced tables** are `REPLICA IDENTITY FULL`, as `messages` is ([0001](0001-electric-postgres-tanstack-db.md)). Persons and accounts are 0008's tables.

## 8. Sync and offline

| Shape | `where` (set by the server) | Who may sync it |
|---|---|---|
| `labels`, `item_labels`, `branch_rules`, `branch_writers`, `protection_rules` | `repo_id = $1` | anyone with `repo:read` on that repository |
| a repository's `repository_roles` | `repo_id = $1` | anyone with a role on that repository |
| a person's own `repository_roles` | `person_id = $1` | that person |

- **Every request is checked.** The proxy checks `repo:read` on every request, and a live request lasts up to 20 s ([8]). On a 403 the device deletes that repository's rows from its OPFS store and stops its shapes. The device keeps one database per account and wipes it on sign-out (0002, risks).
- **Caching:** shape responses for private repositories are `Cache-Control: private` and vary on the credential ([3]). Only public ones may be cached at the edge.

| While offline, the person… | On reconnect |
|---|---|
| lost read access | what they had stays readable while offline; the first shape request gets a 403, the device deletes those rows, and queued writes for that repository are refused |
| lost the role a queued write needed | the server refuses the write when it runs it; the view returns to the server's state, with `Not sent` where 0002 shows it |
| gained a role | the new controls appear once their own-role shape syncs |
| applied a label another person deleted | the application is refused; its chips disappear when Postgres' rows arrive |
| edited a single-player branch that became `restricted` or `locked` | the edits stay on the device, with `Move to new branch` and `Discard` |
| had an agent working for them in a long run | the run's next write is checked against their current role, and it fails or parks |

## 9. Identity versus authorization (0008)

- **0008 answers who.** It owns sign-in, sessions, visitor ids, person ids, the link to a GitHub identity, and delegated agent tokens. It provides `CurrentActor`, an Effect service, for each request and each run. A run records its actor when it starts, and its child flows inherit it.
- **0007 answers what.** It owns roles, the catalog and `decide`, and provides the layer for 0008's `Authorize`. It never reads a credential, and 0008 never reads a role. A token carries `via` but never a role, because roles change. The actor never comes from a request body or a flow's payload.
- **Guest here is a role** that a signed-in person holds. 0008's anonymous guest principal is a different thing, and Will's answer to 0008's Q2 removes it.
- **A GitHub import** sets each person's role once from their GitHub permission, by §1's GitHub column; after that, the Members card is authoritative (mvp.md §6.15). Import never widens access (M-46), so each permission maps to a role with no more power over the repository: write can merge on GitHub but maps to Member, and triage, which cannot push, maps to Guest. An Admin can raise either. For repositories whose `main` GitHub keeps, 0008 decides whether GitHub permission is still re-checked (M-05's hourly check).

## 10. Tests

- **The policy (`@smthrs/access`, unit)** is tested as properties over every action, role, agent mark, branch mode and visibility: a higher role never loses an action; an agent is never allowed more than its person; no human-only act is ever `allow` for an agent; a Guest act that runs code, uses a sandbox or touches a secret is never `allow`; and every catalog action has a flow that enforces it. Spot cases come from Will's role descriptions (Q1), never restated from our catalog.
- **The server (real Postgres):** each flow is refused one role below its minimum and allowed at it; when a revoke races 100 writes, no write commits after the revoke; a durable run whose person is downgraded midway fails or parks at its next write; `ask` parks on a `HumanTask` that an agent channel can't resolve; and a Guest's approved run waits again after a new push.
- **The shape proxy (real Electric):** a Guest syncs a private repository that added them; after a revoke, the next request gets a 403 and the device holds no rows; a signed-out visitor syncs only public repositories; no subset parameter widens a shape past `repo_id`; and private responses are never cached.
- **End to end (real browsers, offline, with video):** every row of §8's offline table; two devices labeling offline; the agent applying a label that then shows "Smithers for Maya"; the agent asked to merge, which opens the person's confirmation; and a Guest's pull request whose checks wait for a Member's approval.
- **Filtering:** the grammar is fuzzed, and parsed queries are checked against GitHub's documented examples ([7]).
- **A telemetry sentinel:** a label name, a description and a person's name set to a sentinel never appear in any exported log, span or metric. Decisions carry only the action, the decision, the role and `via`. Coverage is 100% for every package touched.

## 11. Phases, once prioritized

| Phase | Builds | Needs |
|---|---|---|
| 1 | the `repo:*` actions, `@smthrs/access` and its property tests | nothing; build it first, because every later phase calls it |
| 2 | `repositories`, `repository_roles`, `role_events`, the `Authorize` layer, the per-request `ShapeProxy`, the Members card (add, change and remove), the owning account as Admin | 0008's `CurrentActor` |
| 3 | labels: the tables, the defaults, the four flows, filtering, the agent applying labels | phase 2; the issue and PR tables |
| 4 | branch modes with sandboxes: `locked` main, `restricted` branches, closing sessions on revocation | phase 2; 0005 |
| 5 | Guests: pull requests from forks and approval of their runs | the maintainer release (mvp.md §14) |

Deferred, with no phase: flows that decide trust, such as promoting a Guest (Q1); flows that act with no person (Q3); teams and custom roles.

## Questions for Will

1. **Should five roles replace M-05's three?** Recommended: yes, GitHub's five with GitHub's powers. This also moves managing people from maintainer to admin, as on GitHub.
   - **Will, 2026-10-19: four roles, not five.** "Let's do admin, maintainer, trusted contributor, untrusted contributor but maybe name them better than that. Keep it simple in future this will get more advanced including workflows to decide if someone is trusted or untrusted stuff like that." He then accepted the names "role names are good":
     - **Admin** does everything, including people, secrets and admin settings such as models and budgets.
     - **Maintainer** merges and approves, plus everything a Member can do.
     - **Member** is a trusted contributor: branches, sandboxes, running flows, asking Smithers and opening pull requests, but no merging.
     - **Guest** is an untrusted contributor: issues, comments and pull requests from forks. Anything that would run code, use a sandbox or touch secrets waits for a Member's or Maintainer's approval.
     - A person's role is a plain field, so a later flow can decide trust, such as promoting a Guest to Member. That flow is out of scope now.
2. **Who merges into main by default?** Recommended: a maintainer, as M-05 says, through main's default protection rule. An admin can lower it to contributor, which is GitHub's default.
   - **Will, 2026-10-19: Maintainers and up, and merging is a flow.** "Merging into main is actually triggering a workflow and that workflow is configurable. By default maintainers and up obviously."
     - Merging runs the repository's merge flow. A repository can customize it, the way M-47 lets flows customize pull requests and issue transitions.
     - The default flow lets Maintainers and Admins merge.
     - Every customization still runs under the boundary the root `AGENTS.md` keeps: a person merges, never an agent, and a Guest never does.
3. **May an event-started flow, such as triage on a new issue, apply labels with no person?** Recommended: yes, as Smithers, with the ceiling an admin set when enabling the flow (triager by default). It never applies a guarded label or does any other human-only act.
   - **Will, 2026-10-19: deferred, too far ahead.** "question 11 I think is thinking too far ahead whatever asked the question is doing too much we haven't gottent hat far yet." No event-started labeling flow exists yet. Decide this when the first one is built.

## Sources

[1] https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization · [2] https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels · [3] https://electric.ax/docs/guides/auth · [4] https://electric.ax/docs/guides/shapes · [5] the old backend in `packages/backend`: `internal/middleware/repo_context.go` (its levels), `internal/services/repo_permissions.go` and `catalog_policy_generated.go` (the per-command catalog), `db/product/migrations/0001_product_baseline.sql` (`labels`, `protected_bookmarks`), `internal/services/github_issue_trust.go` and `mythical_automerge_label.go` · [6] https://docs.github.com/en/rest/issues/labels#create-a-label · [7] https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests · [8] https://electric.ax/docs/api/config (`ELECTRIC_MAX_CONCURRENT_REQUESTS`)
