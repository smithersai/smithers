# Where `/new` creates its branch

Status: design pending; implementation blocked. Research date: 2026-10-23.

This is a proposal, not a ruling. No ref location, credential scope, runtime code,
or production configuration changed. Keep the denied-write fix in `1f4b94be`.

## Finding and decision needed

The deployer's authenticated finding supplied with this task is: the production
key gets past write authorization on a repository it created (branch creation on
an empty repository returns 404 `not_found`), while default-namespace branch
creation on GitHub-upstream mirrors returns 401, then 403. This does not prove a
successful branch write on a seeded standalone repository, nor identify the exact
provider denial. It rules out treating every `git:write` request as denied. No
new authenticated Code Storage request was made during this research.

The current path writes the public mirror's default namespace. The provider
documents alternatives, but choosing one changes what `/new` means outside
Smithers. The unresolved decision is whether each new conversation creates a
GitHub branch immediately or a Smithers-only ref until publication.

## What the rulings and decisions settle

| Source | Requirement and limit |
| --- | --- |
| [Rulings, GH-1, GH-6 and GH-9/10](../../../../../apps/mvp/docs/rulings.md#7-github) | Complete the GitHub issue/PR/branch loop. No GitHub Actions view or support; publishing and write-only Smithers commit statuses are explicit exceptions. These rules do not explicitly locate a fresh conversation's ref. |
| [BR-1/2/4, ARCH-13/15](../../../../../apps/mvp/docs/rulings.md) | One conversation and sandbox per branch, sharing by branch, Code Storage hosting. These determine identity and collaboration, not namespace or the moment a branch appears on GitHub. |
| [0012, decisions 7–8 and §4](../../../../../apps/mvp/docs/decisions/0012-git-end-to-end.md) | The strongest case for GitHub: branches change there, App-mode mirrors follow, public snapshots are read-only; `branch/Create` uses GitHub refs. Taken universally, this implies one GitHub branch per `/new`. The record still says **proposed**; its explicit answered question settles attribution. |
| [0013, introduction, decision 2, §1/§2 and appendix](../../../../../apps/mvp/docs/decisions/0013-branch-workspace.md) | A fresh conversation requires a new branch, never clearing another person's chat. Creation is delegated to 0012; the appendix specifically chooses 0012 over the alternative Code Storage creation design. This strongly favors the GitHub option, but does not discuss ephemeral conversation refs or `/new`'s external side effect. Its header also says **proposed**. |
| [0005, §2 and state durability](../../../../../apps/mvp/docs/decisions/0005-sandboxes-secrets-and-the-forge.md) | Earlier branch creation uses Code Storage; sandbox WIP uses `+ephemeral` refs. A machine's forge is read-only; writes are attributed, fenced flow steps. Ephemeral WIP is decided here, but is not permission to move the conversation's own branch there. |
| [0016, decisions 1/5, and 0044](../../../../../apps/mvp/docs/decisions/0016-todos-and-the-stack.md), [0044](../../../../../apps/mvp/docs/decisions/0044-todo-publish-agent-commits.md) | A TODO's branch and PR are on GitHub. Host publication creates one fenced commit; the machine never pushes. This settles TODO publication, not the location of every chat branch. |
| [0038, saved conversations](../../../../../apps/mvp/docs/decisions/0038-offline-branch-conversations.md) | Preserve verified branch/conversation identity offline; cached identity grants no access. No ref-location decision. |
| [0080](../../../../../apps/mvp/docs/decisions/0080-new-conversation-refusal.md), [0084](../../../../../apps/mvp/docs/decisions/0084-branch-forge-diagnostics.md), [0085](../../../../../apps/mvp/docs/decisions/0085-branch-write-authorization-refusal.md) | Later records explicitly describe `/new` using the deployment's Code Storage mirror rather than GitHub's writes route, and fix refusal visibility, diagnosis and retry classification. They do not choose a working replacement ref location. |

I checked the later decision records and the repository's decision-queue answers;
none explicitly resolves this mismatch for `/new`. In particular, the approval
to configure the GitHub App and the sharing reviews do not decide that starting
a conversation creates a public GitHub ref. The current
[Forge comment](../../../../../apps/mvp/worker/branch/Forge.ts) even describes a branch staying in
Smithers until a person pushes it to GitHub, contrary to a universal reading of
0012. [Conversation docs](../../../../../apps/mvp/docs/features/conversations.md#new) and 0080 describe the
same implementation. Those are evidence of conflicting intent, not evidence that
the mirror is writable.

Therefore I cannot present either a GitHub migration or an ephemeral migration
as an already settled repair. The latest task explicitly calls this an
architecture choice. The GitHub interpretation above must be accepted or narrowed
explicitly before implementation; existing wording must be reconciled then.

## Code Storage primary-source research

Read the package's [source](../../../../../packages/effect-code-storage/src/CodeStorage.ts),
[signer](../../../../../packages/effect-code-storage/src/internal/token.ts),
[docs](../../../../../packages/effect-code-storage/docs/README.md) and
[API reference](../../../../../packages/effect-code-storage/docs/api.md).

Provider documents were fetched read-only from its own Markdown endpoints with
HTTPS, following its [documentation index](https://code.storage/docs/llms.txt)
and [OpenAPI reference](https://code.storage/docs/openapi.json).
The browser fetcher could not retrieve them; direct HTTPS retrieval succeeded.
These are documentation claims, not a production compatibility test.

1. **The API host and request shape are correct.** The
   [overview](https://code.storage/docs/api/overview.md) and
   [OpenAPI](https://code.storage/openapi.json) specify
   `https://api.{org}.code.storage` with `/api` operation paths and the repository
   name URL-encoded as one path segment. The package defaults to that host.
   `createRepo` sends `upstream: { provider: "github", owner, name,
   access: "public" }`. `createBranch` sends `base_ref` and `target_branch` to
   `POST /api/repos/{repo_name}/branches/create` with `git:write`. It does not send
   namespace flags. The signer has repository/scopes/time claims, no `refs`
   policy. A path or token-scope redesign is not supported by this evidence.

2. **Ephemeral refs are documented on synced repositories.**
   [GitHub Sync](https://code.storage/docs/repos/github-sync.md) explicitly lists
   ephemeral branches among supported features of mirrors and limits upstream
   mirroring to default-namespace heads and tags.
   [Ephemeral Namespace](https://code.storage/docs/repos/ephemeral-branches.md)
   documents the `repo+ephemeral.git` remote, shared Git objects and access rules,
   isolation from ordinary clones and GitHub, and persistence until deletion or
   promotion. The namespace has no default branch. This is a documented candidate
   for writable refs on the same mirror, not proof that the deployed key/server
   accepts it.

3. **The branch API can cross namespaces without cloning.**
   [Create Branch](https://code.storage/docs/api/repos/branch-create.md), schema
   `ReposBranchesCreateRequest`, has `base_is_ephemeral` and
   `target_is_ephemeral`. An ordinary base with `target_is_ephemeral: true`
   creates an ephemeral target. Promotion sets an ephemeral base and an ordinary
   target; it keeps the source ref. Reads/listings that accept `ephemeral` and the
   ephemeral Git remote must be used consistently. The current Effect wrapper
   exposes neither flag nor an ephemeral remote. Merely adding a flag to create
   would leave subsequent `branchHead` and sandbox checkout on the wrong remote.

4. **A branch-name prefix is not namespace isolation.**
   [Ref Policies](https://code.storage/docs/repos/ref-policies.md) resolves
   `agents/*` to default-namespace `refs/heads/agents/*`; ephemeral policy paths
   include `refs/namespaces/ephemeral/refs/heads/…`. Policies restrict writes,
   not upstream forwarding. [Access](https://code.storage/docs/repos/access.md)
   says `git:write` permits all refs by default and does not imply `git:read`.
   Adding a prefix or broadening a scope cannot be assumed to fix mirror writes.

5. **A seeded, writable independent repository is documented.**
   [Forking](https://code.storage/docs/repos/forking.md) and
   [Create Repo](https://code.storage/docs/api/repos/repo-create.md) support
   `base_repo: { name: <mirror>, ref: <commit>, auth: { token: <source-read-token> } }`
   on the create request. The target uses `repo:write`; source access uses
   `git:read`. The copy contains one branch and its history, no other branches or
   tags, no ongoing source relationship or upstream; it is limited to the same
   organization. Source and target changes remain independent. `base_repo` and
   `upstream` are mutually exclusive. Source credentials stay host-side and never
   enter records or sandboxes. The Effect wrapper does not expose this copy form.

6. **Sync configuration distinguishes public import and App sync.**
   [GitHub Sync](https://code.storage/docs/repos/github-sync.md) describes public
   mode as a one-time import with no automatic GitHub writes; it retains its
   upstream link for explicit pulls. App mode forwards normal pushes to GitHub,
   requires a registered App/installation and Contents write for writes, and
   keeps ephemeral pushes local. Its LFS warning confirms API promotion can reach
   GitHub without uploading LFS bytes. The provider's App setup conditionally
   requests Workflows permission for workflow-file edits; that is no authorization
   to add GitHub Actions support or widen Smithers permissions.

7. **There is no documented selective-sync escape hatch.**
   [Pull Upstream](https://code.storage/docs/api/repos/upstream-pull.md) and
   `ReposUpstreamPullRequest` say deprecated `ref`/`after` have no effect: a pull
   syncs every upstream branch and tag. [Update Repo](https://code.storage/docs/api/repos/repo-update.md)
   only changes the default branch, not upstream access mode.
   [Delete Upstream](https://code.storage/docs/api/repos/repo-base-delete.md)
   detaches it idempotently. Re-creating an existing name with a different
   upstream returns conflict; create is not an App-mode conversion API. No
   documented option reserves ordinary scratch heads from upstream sync.

## Why T9 succeeded through a different path

Read-only GitHub API verification on 2026-10-23 confirms
[PR #22](https://github.com/roninjin10/smithers-github-tests/pull/22):

- Title: `T9: Publish an agent-made commit`; author `smitherspreviewrelease[bot]`.
- Head: `smithers/t9-publish-an-agent-made-commit-c3b37a2674b4`,
  `d01dfa0c87aca4ce92b9fea2da878f2901ba8c00`.
- Base: `smithers/t5-verify-a-20-minute-command-d97effbf7b36`,
  `2f2f26c85c4d89d796babc2770dfc2492499172f`. The PR is open, unmerged.
- The [published commit](https://github.com/roninjin10/smithers-github-tests/commit/d01dfa0c87aca4ce92b9fea2da878f2901ba8c00)
  adds `self-commit.txt`, is parented at that base and has the host's T9 message
  and `Smithers-Write` trailer, rather than the sandbox agent's commit message.

Code trace:

1. [Todo.ts, `begin`](../../../../../apps/mvp/worker/flows/Todo.ts) gets an installation token for
   `publish`, resolves the GitHub base, and calls
   `Action.once("branch", GitHub.Once.branch(...))`.
2. [Once.ts](../../../../../packages/smithers/agent/integrations/src/github/Once.ts)
   derives the branch name from the step key, looks it up before repeating an
   uncertain write, and calls [Refs.createBranch](../../../../../packages/smithers/agent/integrations/src/github/Refs.ts):
   GitHub `POST /repos/{owner}/{repo}/git/refs`. No Code Storage branch create.
3. [TodoMachine.ts](../../../../../apps/mvp/worker/flows/TodoMachine.ts) marks the attempt's branch
   `forge: "github"`; [Forge.forgeOf](../../../../../apps/mvp/worker/branch/Forge.ts) and the
   [sandbox proxy](../../../../../apps/mvp/worker/BranchSandboxes.ts) read GitHub even when the
   deployment otherwise uses Code Storage.
4. `collect` compares with the recorded base, including agent-made commits.
   `publish` uses `Action.once` with `GitHub.Once.commitOnBranch`, GraphQL
   `createCommitOnBranch` fenced by `expectedHeadOid`, then `GitHub.Once.pull`
   to open the PR, project it and report publication to Stack.

T9 proves TODO publication through GitHub. It does not exercise `/new`, the mirror
write, or an ephemeral ref.

## Has `/new` ever passed in production?

**No successful production receipt was found in this clone, for any repository.**
This is an evidence limit, not a claim about every run outside this clone.

- `cb7025c266dc` introduced the browser spec. Its
  [work note](../../../../../apps/mvp/docs/work/conversations-and-history.md) explicitly records history
  and archive GIFs, but says `/new` ran only in unit/device tests because the
  local server lacked Code Storage credentials.
- [conversations.spec.ts](../../../../../apps/mvp/e2e/conversations.spec.ts) still contains the
  real success test, gated on `member` and `codeStorage`. It submits `/new` from
  the device's initial page and waits for a fresh branch URL and another device's
  list. Its other tests track already-existing Spoon-Knife branches; their passes
  do not prove creation. [Fixtures](../../../../../apps/mvp/e2e/devices.ts) choose the initial page,
  so a run may start in the account's configured existing branch conversation.
- [Production e2e records](../../../../../apps/mvp/docs/work/prod-e2e.md) show successful existing-branch
  conversations and failures of `POST /api/branches {create:true}`; they contain
  no `/new` success receipt. No retained Playwright report/test-results directory
  is present in this clone.
- `609a3dbb4037`, [0080](../../../../../apps/mvp/docs/decisions/0080-new-conversation-refusal.md) and the
  [refusal work note](../../../../../apps/mvp/docs/work/prod-conversations-new.md) record production
  `not_found`, no successful production creation, and unit/device success only.
  Later 0085 and this task's deployer finding record denied mirror writes.

No production e2e was run, and no old failure was relabeled as success.

## Options and their effects on people using GitHub

| Option | Evidence and implementation consequence | What people see on GitHub |
| --- | --- | --- |
| A. Create directly on GitHub | Closest literal reading of 0012/0013; TODO's durable GitHub write path is proven by T9. Use public `@smthrs/integrations` and the existing durable authorization/attribution path; require the App and the person's repository rights. Track and check out the new GitHub branch immediately, without assuming the public mirror has caught up. | **One ordinary GitHub branch per new conversation**, visible to everyone who can read the repository; ordinary create/push automation may react. Starting chat does not itself open a PR or publish conversation text. A public branch name is public despite the private conversation. |
| B. Use App-mode Code Storage sync for ordinary branches | Provider GitHub Sync docs and 0012 decision 8 support the mode. Requires provider App registration, per-repository installation, a deliberate migration from the current public mode, attribution decisions and live validation of API create forwarding. No documented PATCH switches mode in place. | Also one ordinary GitHub branch per new conversation once the write forwards. Adds a provider configuration dependency; does not avoid branch proliferation. |
| C. Create an ephemeral ref on the same mirror | Provider GitHub Sync, Ephemeral Namespace and branch API explicitly support the combination. Add namespace-aware Effect APIs, persisted branch ref location and consistent reads/listings/proxy routing; validate deployed compatibility before claiming the fix. Must narrow/reconcile the universal reading of 0012, while preserving GitHub truth for published branches. | **No GitHub branch for `/new`**; ordinary clones and the upstream remain untouched. Publication is a separate explicit action. Existing TODO publication remains the proven GitHub path. |
| D. Fork the mirror into an independent Code Storage repository | Provider Forking and create API support a one-commit seed, independent access and ordinary writable refs. Add copy support in the SDK, durable copy identity, budget accounting, stored target repo identity, checkout routing and a decision about later upstream updates. Per-conversation copies cost more repository slots; a shared per-repository writable copy needs lifecycle and synchronization choices. | No GitHub branch for `/new`. The fork is a Code Storage copy, not a GitHub fork; its commits do not automatically become a GitHub PR branch. Any future publication must transfer the intended change explicitly. |
| E. Detach the canonical mirror's upstream | Provider Delete Upstream supports detaching. It sacrifices the canonical mirror's ability to refresh and violates the app's current clone/read assumptions. A detached copy would be option D in effect, but with a more disruptive migration. | No automatic GitHub writes, and existing readers lose the expected upstream refresh. Do not choose this as a production repair. |

A `smithers/…` prefix in the ordinary namespace is a naming variant of A/B, not
another isolation option. Repeatedly changing credentials, scopes or retries is
not a ref-location design.

## Recommendation, pending an explicit decision

Choose **C: ephemeral conversation branches on the existing mirror**, keeping
published TODO branches and PRs on GitHub. It preserves one conversation and
sandbox per branch without making a person's chat-start action create an ordinary
upstream branch. It shares existing Git objects and avoids independent-repository
sync and quota machinery. This is a recommendation based on the provider docs and
the separation between private live work and publication; it is **not settled by
the current rulings**, and it needs an explicit clarification of 0012/0013/0080.

If the intended product rule is instead that every conversation branch is a
GitHub branch immediately, choose **A**, which follows 0012 most directly and
reuses T9's proven host-side integration. Do not add App-sync migration just to
repair this route.

After the location is decided: record that decision, reconcile the contradictory
docs/comments, reproduce the chosen behavior with a failing test, and implement
one path. Use catalog entries `@smthrs/effect-code-storage`,
`@smthrs/integrations`, `@smthrs/flow`, and the existing sandbox host. Persist ref
location as core identity rather than infer it from a transient deployment setting;
existing branch/conversation IDs and shares must survive. Creation must recover
its own durable receipt after a lost response, reject unrelated existing refs,
keep secrets host-side, and preserve current refusal diagnostics. Namespace or
repository changes must reach file reads, refs, sandbox clone and reload recovery
together, with no old second implementation left behind. Verify injected faulty
services, 100% changed-line coverage and real local integration; do not claim
production success without a separately authorized production receipt.

**Delivery: BLOCKED — design written.** No runtime implementation, production
e2e, provider mutation, push or deployment in this round.
