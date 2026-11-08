---
title: GitHub User-Agent on every Worker request
status: review
area: github
owner: codex
updated: 2026-11-03
links:
  - ../features/machine-tokens.md
---

Production machine issue writes are refused because Workers add no User-Agent.
Audit direct GitHub HTTP calls and use the existing @smthrs/integrations client's
identity through one shared constant and transport seam. Library catalog entry:
@smthrs/integrations (GitHub API and OAuth); @smthrs/effect-code-storage (git HTTP).

All GitHub-specific Worker transports now send `smithers-integrations` from
`GitHub.GitHubClient.USER_AGENT`, through `worker/github/Http.ts`:

- `github/MachineWrite.call`: marker search, issue/comment POST, issue PATCH,
  sub-issue POST and parent reads; previously absent.
- `runners/GitCredential.revoke`: installation token DELETE; previously absent.
- `GitHubAuth.exchange/refresh`: OAuth POST; previously absent.
- `RepoAbout.absentOnWeb`: repository HEAD; previously absent.
- `RepoUpstream.head`, `branch/Forge.defaultBranch`, `branchHead`, `proxy`:
  git discovery and upload-pack GET/POST; previously absent.
- `branch/RegistryEgress.forward`, `secrets/SandboxEgress.forwardSubscription`,
  `forwardOverflow`, `forward`: allowed GitHub egress; previously guest-supplied
  or absent. Other hosts keep their headers and the existing egress policy.
- `GitHubClient.perform` and `AppAuth` installation lookup/mint already sent
  this value; the literal is now the shared constant.

No dedicated uploads.github.com client exists; the egress seam covers that host.
Generic docs and page readers previously sent `Mozilla/5.0 (compatible; docs-fetch)`
and `Mozilla/5.0 (compatible; web-page-check)` respectively. They now use the same
GitHub-only seam, preserving their browser headers for other hosts. Code Storage's API
calls its own service; its upstream fetch runs outside this Worker. The SDK's
GitHub Proxy is not used by this Worker.

Regression assertions inspect every dispatcher request, runner mint/revoke,
OAuth, repository HEAD, git HTTP and the shared seam (including uploads and
preserving non-GitHub headers). Test captures add only User-Agent, no credentials.
