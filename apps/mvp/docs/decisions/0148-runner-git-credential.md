# 0148: A runner reads a private repository with the App's token

Status: accepted
Date: 2026-11-02

A runner (decision 0136) checks out a TODO's base from a local jj mirror it fetches from GitHub. For a private repository the fetch needs a credential, and the runner had none: every private repository whose TODOs ran on a runner failed `workspace`. The issue-tracking proof hit it on its private repository (docs/features/work-links.md#the-proof). The runner's pull request already goes through the host: the runner sends its change, and the App writes the branch and the pull request (docs/features/agent-runners.md), so only reading was missing.

## Status of the route

Off since 2026-11-02: `POST /api/runners/git-credential` answers `404 not_found` to every runner, and the runner fetches without a credential, until the security review's findings are fixed. The review found that registration didn't prove the registrant's access to the repository: where Smithers had recorded no App installation, the Admin route took the deployment-wide role. Registration now needs the recorded installation and the Admin role GitHub gives on that repository, and a claim needs the recorded installation.

## Decision

1. **The host mints, per job, a read-only token for one repository.** `POST /api/runners/git-credential { key, claim }` with the runner's own token answers `{ remote, username, password, expiresAt }` only while that runner holds that job (`claimed`, before its deadline), and only for the repository the runner is registered on, whatever the task names. The token is the App's installation token minted with `repositories: [<name>]` and `permissions: { contents: "read" }`: it can read that repository's contents and nothing else, and it can't write.
2. **It is short-lived.** GitHub ends an installation token an hour after minting; the answer's `expiresAt` is 50 minutes after, and the runner asks again for each job's checkout rather than keeping one.
3. **It is never on a command line, in a file or in a log.** The runner gives it to git through the command's own environment (`GIT_CONFIG_COUNT`, `http.<origin>/.extraheader`, as `actions/checkout` does), for that one command. The route's record names the job and the outcome, never the token; the answer is `Cache-Control: no-store`.
4. **A public repository is unchanged.** Without the App, or where it isn't installed, the route answers `404` and the runner fetches as before. A missing mirror is cloned only with a credential.

## Consequences

- A runner token now also yields read access to its repository's contents for the length of a job it holds. A runner already receives that repository's code through its jobs, and an Admin retires a runner at once (`DELETE .../runners/<name>`).
- A deploy key or a person's token on the runner machine stays possible, and is no longer needed.

Libraries: none new. The App's installation tokens (`worker/github/Tokens.ts`), git's own `GIT_CONFIG_*` environment.
