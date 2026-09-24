# factory/queue/

Legacy prompts, not the authoritative backlog. Every still-actionable item must
link to a GitHub issue. Audit old items against current code before scheduling;
their status fields are historical claims, not completion evidence.

New work starts in GitHub and runs through the Smithers Cloud factory. Reuse an
existing issue before creating one. A retained queue file needs an `issue:` URL
and may carry `status: queued | in-progress | landed | blocked` and
`priority: p0 | p1 | p2`. Only the active owner updates its status.

The old `anchor`, `retold`, `vibe`, and main-history rewrite instructions are
retired. Work lands and is pushed on `main`; any temporary worktree is removed
after landing. A queue file alone does not register a Cloud job. Local manual
execution is transitional bootstrap/repair and needs an issue for its blocker.

Required evidence: issue -> run -> checks/review -> landed revision -> GitHub
sync -> wiki refresh. A launch acknowledgment is not completion.

Reconcile this inventory in [#1708](https://github.com/smithersai/smithers/issues/1708);
Cloud intake and execution belong to [#1695](https://github.com/smithersai/smithers/issues/1695).
