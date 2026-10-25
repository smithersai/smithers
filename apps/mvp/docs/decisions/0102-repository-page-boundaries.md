# 0102: Repository pages retain their frame and name their source

Status: accepted (2026-10-25).

Decision 0079 fences issue and pull-request sync, secrets, settings and session roles to the deployment repository. Repository feature routes open the repository and home stores alongside their feature store, so direct visits keep the header and navigation. The tree route opens the home too.

The public About response adds `deploymentRepository` from `GITHUB_REPOSITORY`, outside its immutable GitHub cache. Older answers omit it; controls fail closed until confirmed. This is deployment capability metadata, never a person's permission. Server authorization remains authoritative.

Other repositories' lists link to GitHub. Their new-issue page links to GitHub's new-issue form instead of queuing a write that the device cannot observe completing. Default-repository issue creation is unchanged. Stack refusals say that Members may make TODOs. Secrets and Settings links require both the configured repository and the session's minimum role. An empty accessible Secrets page says No secrets. The home offers asking only where the current session's role applies and permits asking.

Library catalog: `@smthrs/ui` renders the existing frame and empty states; `@smthrs/effect-tanstack-db` supplies the existing feature state and live queries. No new feature runtime, persistent schema or dependency.
