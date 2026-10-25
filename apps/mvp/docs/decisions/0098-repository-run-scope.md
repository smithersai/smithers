# 0098: Repository runs follow the repository being viewed

Date: 2026-10-24

Production CI recorded and executed the GitHub test repository's run, but its Runs page showed “No runs yet”. The actions shape filtered the deployment's `GITHUB_REPOSITORY`, while the view filtered those rows to the route repository. Inspection and live following also admitted only the deployment repository. The encoded execution link was correct; migration 0053 and dispatch's writer need no change.

The route passes owner and name to the runs store. Each repository has its own lower-case `repo-runs:<owner>/<name>` persisted Electric collection and `?repo=` shape. Revisiting a repository shares its subscription; opening another cannot reuse its handle or offset. The row schema stays version 1, registered as a collection family. Existing unscoped clients retain the deployment repository default; malformed explicit repositories are refused.

Shape authorization resolves the person's role on the requested repository. Inspection, live changes and Stop resolve the role on the repository recorded by `RepoRuns.admit`, including jobs' lineage, never a repository supplied by the caller. A Member role on the deployment gives no access to another private repository. Temporary role failures return 503, retaining Electric's existing resume state. TODO runs keep their existing admission policy.

Use the existing library catalog entries for `@smthrs/effect-electric` and `@smthrs/effect-tanstack-db`, and the existing `RepoRoles` service. This repairs the existing repository-run infrastructure; it adds no feature or plugin interface.

Regression: real Postgres rows from `RepoRuns.record`, Electric through the real handler, and a SQLite-backed device. The test first reproduced an empty second-repository list, then the incorrect Not found run page. It requires live visibility, the encoded href, inspection and cancellation, a device reload, live state changes and deletion. Access tests retain denial for null/Guest repository roles and injected faulty role services. The production CI e2e's visible/watchable assertion remains unchanged; the deployer reruns it under the vault wrapper.
