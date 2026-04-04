# Repo Connect with Public + License Validation

**Repo:** plue (JJHub Go backend)
**Feature:** Repository Connection
**Priority:** P0 — blocks repo onboarding

## Description

Implement `smithers repo connect <owner/repo>` that validates the GitHub repo is public and has a known permissive license before allowing connection.

## Acceptance Criteria

- [ ] CLI command `smithers repo connect <owner/repo>` exists
- [ ] Validates current directory is a jj repo (`.jj/` exists)
- [ ] Calls GitHub API `GET /repos/{owner}/{repo}` to check `private` field
- [ ] If private → error `REPO_NOT_PUBLIC`
- [ ] Reads `license.spdx_id` from GitHub API response
- [ ] Fallback: reads LICENSE file from repo root if GitHub returns null
- [ ] Accepted licenses: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0
- [ ] If no license or non-permissive → error `LICENSE_NOT_PERMITTED`
- [ ] On success: stores mapping in `.smithers/config.json` locally and in backend DB
- [ ] `smithers repo disconnect` removes the mapping
- [ ] `smithers repo status` shows connection state

## E2E Test

```
1. smithers repo connect private/repo → REPO_NOT_PUBLIC
2. smithers repo connect gpl-licensed/repo → LICENSE_NOT_PERMITTED
3. smithers repo connect mit-licensed/public-repo → success
4. smithers repo status → connected: true
5. smithers repo disconnect → success
6. smithers repo status → connected: false
```
