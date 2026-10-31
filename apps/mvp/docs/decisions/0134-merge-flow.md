# 0134: The merge flow: a repository chooses how Merge lands a pull request

Date: 2026-10-31. Status: accepted. Ruling BR-7. Builds on [0012](0012-git-end-to-end.md) decision 6 (a person merges
with their own token) and [0079](0079-roles-per-repository.md) slice 2 (merging resolves the role per repository). Will
reviews it with the feature (HOST-3).

## Problem

Ruling BR-7: "Merging into main is actually triggering a workflow and that workflow is configurable. By default
maintainers and up obviously." Today `pr/Merge` always merges on GitHub. `smithersai/vibelang` lands every change
through its own merge queue on nyc-01, whose runner gates a batch and whose Mac pusher moves GitHub's `main` to the
result. A direct GitHub merge from smithers.sh would skip that gate and race the pusher, so a Maintainer can't merge a
VibeLang pull request from Smithers today.

## Decision

1. **The repository says, in a file at the base.** `.smithers/merge.json`, `{ "flow": "github" | "queue" }`, read by
   `pr/Merge` at the base commit the person's page showed, with the App's `Contents: read` token. No file is `github`,
   today's merge. A file that is not exactly that object (bad JSON, an unknown flow, any other field, a directory) is
   refused `invalid`; a file GitHub can't serve now is tried again. Neither ever falls back to a direct merge, so a
   repository that asked for its queue never gets one by mistake. Because it is read at the base, a pull request can't
   choose its own merge flow.
2. **`github`**: unchanged. The person's squash merge at the head and base they saw ([pulls](../features/pulls.md#merge)).
3. **`queue`**: the step rechecks the head as a merge does (open, not a draft, not merged, the head the page showed;
   the base isn't checked, because the queue lands the head on whatever `main` is then, through its gate), then posts
   one comment with the person's own token: "Queued for this repository's merge queue at `<sha>`", with two hidden
   markers, `<!-- smithers:merge-queue head=<40-hex SHA> -->` and the write's key. `Action.once` finds a lost answer by
   that key, as it finds a lost merge by its trailer. The write settles `done` with `github_writes.merge_flow = 'queue'`,
   and the merge box says Queued while the pull request is open.
4. **The queue's side is the queue's.** A poller beside the queue reads the marker, refuses a request comment edited after
   it was posted (GitHub lets a Write collaborator edit anyone's comment and keeps the author), rechecks the author's
   GitHub role and the head when it enqueues, enqueues exactly the marked head, reports on the pull request, and closes it once the
   base carries the landed commit. For VibeLang that is `~/.vibe-orch/bin/mq-prs.py` on the Mac
   ([how VibeLang's queue takes it](../features/pulls.md#merging-through-a-repositorys-merge-queue)). Smithers names no queue,
   host or credential.
5. **Who may press it: unchanged.** The writes route admits `pr/merge` only from a person's own session, Maintainer or
   Admin of the repository (`repo:merge`, `PROTECTED_ACTS`); never the agent. The file chooses the flow, not the role.
   A role override is not built; nobody has asked for one.

## Alternatives

**How a repository declares the flow.** (a) A file in the repository, read at the base: versioned, reviewed like code,
visible to anyone reading the repository, and the way `.smithers/checks/*.sh` already declares checks. (b) A setting in
the app (a `repo_settings` column and a Maintainer-only page): a schema, a route, a page and an audit trail to build,
and invisible from the repository. Chose (a). A third option, a flow file the repository supplies and Smithers runs
(`.smithers/flows/merge.ts` on a sandbox), is the general form of "configurable", but it would run repository code
holding the person's merge token; it waits for the plugin interface (PLUGIN-2) and a sandboxed token design.

**How a queue merge reaches a queue a Worker can't reach.** (a) A comment as the person, with a marker, that a poller
next to the queue reads: GitHub attributes the request to the person, the poller rechecks their role with GitHub, and no
endpoint or credential moves. (b) A label or a pushed ref (`mq/pr-<n>`): a label doesn't bind a head, and either needs
the poller to find out who asked from the timeline. (c) GitHub's webhook to an endpoint on the queue's host: a new
public endpoint on nyc-01 and a webhook secret to keep there. (d) SSH from the Worker: a deploy key leaving the Mac.
Chose (a), the smallest with nothing new exposed.

## Consequences

- Migration `0076_merge_flow` adds `github_writes.merge_flow` (`github`, `queue` or null); `WRITE_COLUMNS` syncs it and
  the device's `issue-writes` store is version 3. It must apply after `0074` (the unlanded host-sessions change): land
  this after that one, or renumber.
- `pr/Merge/send` is implementation `pr-merge/send/v3`: a run parked on v2 stops `plan_changed`.
- The merge counter `smithers_pr_merges` and the `github.merge` log gain `flow`.
- Merging a queue repository now needs the App's `Contents: read`; without it the merge is refused `not_allowed`.
- Not built: the Merge button names the repository's flow before the press ("Squash and merge" shows on a queue
  repository too); the app reading the queue's progress other than through the pull request's conversation.
