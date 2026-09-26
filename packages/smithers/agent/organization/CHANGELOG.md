# @smthrs/organization

## [Unreleased]

- Repository environments (#1931): `Config.Organization.repositories` declares per repository a `prepare` command
  (with its key paths and network), a builder/check `network` (`none`, `all`, or a domain allowlist; default `none`),
  and `checks`; `vm.diskMib` sizes image-booted machines. `Workspace.layer({ environments })` seeds such a
  repository from a prepared base captured once per key and syncs later commits onto it, and `runChecks` runs the
  environment's checks in a fresh machine booted from the same base. `Workspace.Machines` gains `bases` and a `Boot`
  argument; `WorkspaceErrorCode` gains `prepare-failed`.
- `Workspace.session(key, { commit? })` refuses a machine that holds no seeded workspace (`unseeded`) or one seeded
  from another commit (`occupied`); `Authority.TaskWorkspace` carries the optional `commit` it checks.
- `Workspace.microsandbox` labels each workspace machine with its key (`workspaceLabel`), and
  `Actions.executionOfWorkspace` reads a key's execution, so a restarted host keeps the machines of runs that resume.
- New package: `Profile`, `Grants`, `Roster`, `Prompt`, `Skills`, `Hiring`, and `Meetings`.
- `Prompt.compose` refuses a skill the profile lists but the caller did not supply (`skill-missing`) and context whose
  retrieval time cannot be rendered (`invalid-context`), and escapes line breaks in fence attributes.
- The example organization references only case files it ships.
