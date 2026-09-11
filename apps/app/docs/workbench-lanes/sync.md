# Lane `sync` — Linear and GitHub sync as actions

Brief: `../decisions/0005-linear-github-sync.md`. Depends on lane `piper`
(cloud proxy, sign-in, repositories tree). Laws as every lane; a failed op
is never hidden and reads the server error verbatim with Retry.

Scope, in order:
1. Shared schemas: `connector-setup` card (kind linear|github, steps[] with
   state, error), `sync-ops` card (header run state and counts, ops[] rows
   with source, target, entity, id, action, status, error, retryable),
   `repo-import` payload gains stage, counts, error, repository,
   workspaceId; `issue` payload gains `linear { identifier, url }`.
2. `LinearSeam` and `GitHubSeam` over the routes in the ADR through
   `/api/cloud/*`; OAuth and install handoffs through the native
   `openExternal` door with the local origin receiving the callback.
3. Cards: `connector-setup` (both kinds, every state in the ADR),
   `sync-ops` (live header, verbatim error rows, Retry, `show more`,
   `load older`), the import job card, the rate-limit line on any card
   whose GitHub call was refused.
4. Flows per the ADR table with confirm where marked; rename `repos.app`
   to `github.app` with an alias; slash payloads; registry and parity tests.
5. Connectors surface rows replace the 3-card grid.
Exit: seam tests with doubles for every route including a 422 op error and
a 429 rate limit; card tests per state; T1 spec: connect flow through a
fake Linear upstream, one failed op retried, import job to done.
