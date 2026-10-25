# 0102: Repository pages retain their frame and name their source

Status: accepted (2026-10-25).

Decision 0079 fences issue and pull-request sync, secrets, settings and session roles to the deployment repository. Repository feature routes open the repository and home stores alongside their feature store, so direct visits keep the header and navigation. The tree route opens the home too.

Whether a repository is the deployment's own comes from the role route's `own` (`GET /api/repos/<owner>/<name>/role`, decision 0079), which every repository route asks, signed out included; controls fail closed until it answers. (A first draft added `deploymentRepository` to the public About answer; it was folded into `own` the same day, so one answer says it, SDK-11.) Server authorization remains authoritative.

Lists of a repository this deployment doesn't sync link to GitHub: one `GITHUB_ALLOWED_REPOSITORIES` leaves out, or where the App was found absent (decision 0079 slice 1b; App-installed repositories such as smithersai/vibelang sync like the deployment's own). Their new-issue page links to GitHub's new-issue form instead of queuing a write that the device cannot observe completing. Issue creation where the deployment syncs is unchanged. Stack refusals say that Members may make TODOs. Secrets and Settings links require both the deployment's own repository and the minimum role there. An empty accessible Secrets page says No secrets. The home offers asking only on the deployment's own repository, where the session's role applies and permits asking.

Library catalog: `@smthrs/ui` renders the existing frame and empty states; `@smthrs/effect-tanstack-db` supplies the existing feature state and live queries. No new feature runtime, persistent schema or dependency.
