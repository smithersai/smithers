# @smthrs/organization

## [Unreleased]

- `Workspace.session(key, { commit? })` refuses a machine that holds no seeded workspace (`unseeded`) or one seeded
  from another commit (`occupied`); `Authority.TaskWorkspace` carries the optional `commit` it checks.
- `Workspace.microsandbox` labels each workspace machine with its key (`workspaceLabel`), and
  `Actions.executionOfWorkspace` reads a key's execution, so a restarted host keeps the machines of runs that resume.
- New package: `Profile`, `Grants`, `Roster`, `Prompt`, `Skills`, `Hiring`, and `Meetings`.
- `Prompt.compose` refuses a skill the profile lists but the caller did not supply (`skill-missing`) and context whose
  retrieval time cannot be rendered (`invalid-context`), and escapes line breaks in fence attributes.
- The example organization references only case files it ships.
