
Brief: `../decisions/0005-linear-github-sync.md`. Depends on lane `piper`
(cloud proxy, sign-in, repositories tree). Laws as every lane; a failed op
is never hidden and reads the server error verbatim with Retry.
