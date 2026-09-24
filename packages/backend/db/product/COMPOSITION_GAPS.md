# Product database composition gaps

`migrate` installs the product schema only. The baseline excludes the tables that `../ownership.csv` marks `private` or `retired`. `internal/compose/main.go` starts every service that needs those tables only when `options.Role.hosted()` or `options.Role.clusterWorkers()` is true. Keep that gate on any new caller.

| Hosted-only service in `internal/compose/main.go` | Excluded state |
| --- | --- |
| `runnerpool.NewRunnerPool` stale sweeper, `NewWorkflowSandboxSchedulerWorker` | `runner_pool`, `workflow_sandbox_claims` |
| `NewCanaryStatusCollector`, `NewAdminRuntimeMetricsCollector`, `NewAlertRemediationWorker` | `canary_results`, `alert_incidents`, `alert_remediation_jobs` |
| `NewRepositoryProvisioningReconciler` | `repository_provisioning_operations` |
| `repoGatewayService.StartReaper`, `NewSandboxOrphanReaper`, `goldenSnapshotService.Start` | `repo_gateways`, `sandbox_orphans`, `sandbox_golden_snapshots` |
| `NewStorageDeletionCleaner`, `NewSandboxEgressAuditCleaner` | `storage_deletion_queue`, `sandbox_egress_audit` |

Product queries and models generate into `internal/db` from `sqlc.yaml` in this directory. `internal/clusterdb` is generated code whose schema source, `db/cluster`, was removed in commit 1105bc94; it cannot be regenerated from this repository.

`CountPrivateReposByOwner` and the storage byte queries count product allocations only. A hosted billing adapter must add pending private provisioning and deletion allocations.

The product `ListIdleWorkspaces` query excludes active browser sessions. Keep the idle sweeper off in local composition until the local executor provides an active-runtime lease; otherwise a native run without a browser could be suspended. `HasUnsettledRunnerOwnershipForWorkflowRun` treats a non-null `workflow_tasks.runner_id` as unsettled even when the private runner pool is unavailable.
