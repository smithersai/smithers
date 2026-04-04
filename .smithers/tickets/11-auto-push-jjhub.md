# Auto-Push to JJHub on Every jj Operation

**Repo:** plue (JJHub Go backend)
**Feature:** Auto-Push
**Priority:** P0 — core data flow

## Description

When `smithers repo connect` succeeds, install a jj post-operation hook that pushes all refs to JJHub after every jj operation. The push runs in the background and does not block the user.

## Acceptance Criteria

- [ ] `smithers repo connect` installs hook in `.jj/config.toml` under `[hooks]`
- [ ] Hook calls `smithers _internal push-to-jjhub` (internal, not user-facing)
- [ ] Push sends all bookmarks + working copy parent to JJHub via `POST /api/repos/{owner}/{repo}/sync`
- [ ] Push runs as detached background process (does not block terminal)
- [ ] Debounces: waits 500ms before pushing, coalesces rapid operations
- [ ] Failures logged to `~/.config/smithers/push.log` — no user-visible errors
- [ ] `smithers repo disconnect` removes the hook
- [ ] JJHub stores the repo as a git bare repo with jj metadata

## E2E Test

```
1. smithers repo connect → hook installed in .jj/config.toml
2. jj new -m "test" → hook fires, push to JJHub succeeds
3. Backend shows latest ref state matches local
4. smithers repo disconnect → hook removed from .jj/config.toml
5. jj new -m "test2" → no push (hook gone)
```
