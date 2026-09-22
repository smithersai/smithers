# Product database composition gaps

`migrate` installs the fresh product schema, but the copied Plue API composition still assumes its transitional cluster tables. Do not start that composition against the product baseline until these callsites use local adapters or cluster-only registration. The baseline deliberately excludes the tables in `../ownership.csv` marked `private` or `retired`.

| Current `internal/compose/main.go` callsite | Excluded state or dependency | Required local composition |
| --- | --- | --- |
| `ConfigureRepositoryProvisioningEnforcement` (line 136), `ConfigureLegacyMutationFences` (151) | `repository_provisioning_control`, `legacy_mutation_fence_control` | Use the shared repository service with local transaction admission; retain old fences only in Plue's adapter. |
| `NewRunnerPool` (173), stale sweeper (1313), workflow sandbox scheduler (1327) | `runner_pool`, `workflow_sandbox_claims` | Use the bounded local executor and product job admission. |
| Canary/admin metrics (176–179) and alert remediation worker (1331) | `canary_results`, `alert_incidents`, `alert_remediation_jobs` | Register only in Plue; keep product audit/admin operations available. |
| Repository storage and provisioning reconcilers (1339–1340) | `repo_storage_*`, `repository_provisioning_operations` | Inject the local repository adapter; Plue retains its placement reconcilers. |
| Repo gateway and sandbox orphan reapers (1342–1343), golden snapshots (1357) | `repo_gateways`, `sandbox_orphans`, `sandbox_golden_snapshots` | Use local workspace/executor lifecycle; Plue owns fleet cleanup. |
| Storage deletion and egress cleaners (1352–1354) | `storage_deletion_queue`, `sandbox_egress_audit` | Local filesystem cleanup and sandbox audit implementation must be injected. |

The canonical product queries and models now generate into `internal/db` and
exclude `repositories.storage_set_id`. Private cluster queries generate into
`internal/clusterdb`; shared model types alias `internal/db`. The copied
`db/cluster/sqlc_schema.sql` and Atlas migrations remain transitional Plue sources until
Plue's own placement migration lands. `CountPrivateReposByOwner` and the
storage byte queries count product allocations only; Plue must add pending
private provisioning/deletion allocations through its billing adapter before
switching to these queries.

The product `ListIdleWorkspaces` query excludes active browser sessions. Local
composition must keep the idle sweeper disabled until the local executor can
provide an active-runtime lease; otherwise a native run without a browser
could be suspended. Product `HasUnsettledRunnerOwnershipForWorkflowRun` guards
resume by treating a non-null `workflow_tasks.runner_id` as unsettled even
when the private runner pool is unavailable.
