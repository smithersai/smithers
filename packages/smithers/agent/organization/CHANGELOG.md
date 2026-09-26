# @smthrs/organization

## [Unreleased]

- `retrieval` binds research (#1956): `RoleHost.webFetch` (`web-fetch`) reads one public page as text on the host —
  domain scope from the new `grants.retrieval` (`allow`/`deny`, each covering subdomains), public addresses only with
  the connection pinned to the vetted address, every redirect re-checked, a 20 s deadline, a 2 MiB read and 60,000
  characters returned, scripts and embedded content dropped, and the text inside an untrusted-data boundary. Every
  page a task retrieved is added to its result's evidence as `url` with its retrieval time. A host that sets
  `retrieval.providerSearch` also gives the role's model calls the provider's web search (`RoleHost.serverTools`),
  restricted to `allow` and withheld when `deny` is set; it is off by default because a real frame with it spent
  93,000–134,000 input tokens and up to 569 s. `Grants.widenings` keeps a hire's scope inside its parent's. Roles without `retrieval` get neither.

- `Budgets` (#1935): each profile's budget is enforced on every role task — `tokensPerTask` through the run's
  `Agent` budget (`taskBudget`), `tasksPerDay` through a daily ledger charged up the hiring chain (a hire's work counts
  against its parent), `concurrency` per principal, and a per-host cap. A limit answers a `blocked` result that names
  it.
- `Hiring.HireSpec` and `Hiring.fromSpec`: the structured `hire` field a role returns becomes a hire request with
  narrow defaults, which `Hiring.propose` validates. Its `retrieval` scope may narrow the parent's web scope; left out,
  the hire takes the parent's `allow`, and the parent's `deny` is always kept.
- Repository environments (#1931): `Config.Organization.repositories` declares per repository a `prepare` command
  (with its key paths and network), a builder/check `network` (`none`, `all`, or a domain allowlist; default `none`),
  and `checks`; `vm.diskMib` sizes image-booted machines. `Workspace.layer({ environments })` seeds such a
  repository from a prepared base captured once per key and syncs later commits onto it, and `runChecks` runs the
  environment's checks in a fresh machine booted from the same base. `Workspace.Machines` gains `bases` and a `Boot`
  argument; `WorkspaceErrorCode` gains `prepare-failed`.
- A prepared base is flushed (`sync`) before its capture, checked once per host by booting it before use, and
  removed and prepared again (once more) when it lacks its prepared tree; each preparation runs in a machine of its
  own; pruning keeps a base a task is about to boot from. `Machines.bases` gains `remove`, and `capture` takes the
  bases to retain.
- `Workspace.session(key, { commit? })` refuses a machine that holds no seeded workspace (`unseeded`) or one seeded
  from another commit (`occupied`); `Authority.TaskWorkspace` carries the optional `commit` it checks.
- `Workspace.microsandbox` labels each workspace machine with its key (`workspaceLabel`), and
  `Actions.executionOfWorkspace` reads a key's execution, so a restarted host keeps the machines of runs that resume.
- New package: `Profile`, `Grants`, `Roster`, `Prompt`, `Skills`, `Hiring`, and `Meetings`.
- `Prompt.compose` refuses a skill the profile lists but the caller did not supply (`skill-missing`) and context whose
  retrieval time cannot be rendered (`invalid-context`), and escapes line breaks in fence attributes.
- The example organization references only case files it ships.
