# 0156: Deployment authority does not depend on public metadata

2026-11-03. Will's question-403 fix request.

The deployment repository (`GITHUB_REPOSITORY`) uses its fresh session role,
confirmed by sign-in's installation or collaborator checks, whether or not
`github_repositories` records an installation. Public visibility is not an
additional condition for that authority. The feed's final buffered-body check
uses the same deployment basis. Stale authority is retryable unavailable;
revocation and confirmed demotion still deny.

On another repository without an installation, only a successful metadata answer
confirming public visibility admits the deployment role. Metadata 404/410 cannot
confirm privacy: they remain unavailable (503 with Retry-After), cannot create a
private receipt, and use the existing bounded read cooldown. An explicit private
answer still denies. Existing visibility logs and counters record these missing
metadata responses as unavailable rather than private.

A branch write (Publish, Update branch, Resync) names a branch of the route's
repository. The route locates the branch before it asks anyone's role, so a
branch of another repository is `404 not_found` without reading that
repository's metadata.

Test fixtures stay consistent with production instead of loosening authority:

- The shared ChatApi fixture supplies one deployment repository to migrations,
  route configuration, the captured home conversation and scripted GitHub.
- The GitHub route harness records its actor's session as sign-in confirms it,
  because the deployment role is that session's confirmed receipt. Browser
  fixtures whose actor carries a session pass it as `confirmedSessions`.
- Browser tests that need the deployment's role work on `octo/hello`, the
  deployment repository, and expect its home `main` among its branches. A test
  on another repository without the App gets that repository's real answer.

No production seed or published migration changes.
